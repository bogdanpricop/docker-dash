'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const tar = require('tar-stream');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

let inFlight = 0;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
const COUNTS = ['critical', 'high', 'medium', 'low', 'unknown', 'negligible'];

function unavailable(scanner, imageId) {
  return { scanner, imageId, passed: false, status: 'unavailable',
    reason: `Required ${scanner} scan could not be completed and verified` };
}

function verdict(summary) {
  summary.passed = summary.critical + summary.high + summary.unknown === 0;
  summary.status = summary.passed ? 'passed' : 'blocked';
  return summary;
}

function assessReport(text, imageId, configId = imageId) {
  const report = JSON.parse(text);
  if (report?.SchemaVersion !== 2 || report.ArtifactType !== 'container_image'
    || report.Metadata?.ImageID !== configId || !Array.isArray(report.Results) || !report.Results.length) {
    throw new Error('Incomplete scan or image identity mismatch');
  }
  const summary = { scanner: 'trivy', imageId, critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const result of report.Results) {
    if (!result || !['os-pkgs', 'lang-pkgs'].includes(result.Class) || typeof result.Type !== 'string'
      || !result.Type || (result.Vulnerabilities !== undefined && !Array.isArray(result.Vulnerabilities))) {
      throw new Error('Unsupported or incomplete scan inventory');
    }
    for (const vulnerability of result.Vulnerabilities || []) {
      if (!vulnerability || typeof vulnerability.VulnerabilityID !== 'string' || !vulnerability.VulnerabilityID
        || !SEVERITIES.has(vulnerability.Severity)) throw new Error('Malformed vulnerability record');
      summary[vulnerability.Severity.toLowerCase()]++;
    }
  }
  return verdict(summary);
}

function assessGrypeReport(text, imageId, configId = imageId) {
  const report = JSON.parse(text);
  const configuration = report?.descriptor?.configuration;
  const database = report?.descriptor?.db?.status;
  const built = Date.parse(database?.built);
  if (report?.descriptor?.name !== 'grype' || report.source?.type !== 'image'
    || report.source.target?.imageID !== configId || !Array.isArray(report.matches)
    || database?.valid !== true || !/^v6\./.test(database?.schemaVersion || '')
    || !Number.isFinite(built) || Date.now() - built > 120 * 3600000 || built - Date.now() > 300000
    || !configuration || configuration['only-fixed'] !== false || configuration['only-notfixed'] !== false
    || configuration['ignore-wontfix'] !== ''
    || ['ignore', 'exclude', 'vex-documents'].some(key => !Array.isArray(configuration[key]) || configuration[key].length)
    || (report.ignoredMatches !== undefined && (!Array.isArray(report.ignoredMatches) || report.ignoredMatches.length))) {
    throw new Error('Incomplete, filtered or mismatched Grype evidence');
  }
  const summary = { scanner: 'grype', imageId, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, negligible: 0 };
  for (const match of report.matches) {
    const vulnerability = match?.vulnerability;
    const severity = typeof vulnerability?.severity === 'string' ? vulnerability.severity.toUpperCase() : '';
    if (typeof vulnerability?.id !== 'string' || !vulnerability.id
      || typeof match?.artifact?.name !== 'string' || !match.artifact.name
      || (!SEVERITIES.has(severity) && severity !== 'NEGLIGIBLE')) throw new Error('Malformed Grype vulnerability record');
    summary[severity.toLowerCase()]++;
  }
  return verdict(summary);
}

// Read only bounded metadata into memory; never extract archive paths to disk.
async function archiveIdentity(file, imageId, selected, signal) {
  const metadata = new Map();
  const seen = new Set();
  const extract = tar.extract();
  let entries = 0, retained = 0;
  extract.on('entry', (header, stream, next) => {
    if (++entries > 10000) { extract.destroy(new Error('Too many archive entries')); return; }
    const match = /^(?:blobs\/sha256\/([a-f0-9]{64})|([a-f0-9]{64})\.json)$/.exec(header.name);
    const digest = match && `sha256:${match[1] || match[2]}`;
    const chunks = [];
    let size = 0;
    stream.on('error', error => extract.destroy(error));
    stream.on('data', chunk => {
      size += chunk.length;
      if (digest && header.type === 'file' && header.size <= 2 * 1024 ** 2 && size <= 2 * 1024 ** 2) chunks.push(chunk);
    });
    stream.on('end', () => {
      try {
        if (digest) {
          if (seen.has(digest)) throw new Error('Duplicate archive blob');
          seen.add(digest);
          if (header.type !== 'file') throw new Error('Non-regular archive blob');
          if (size <= 2 * 1024 ** 2 && size === header.size) {
            const data = Buffer.concat(chunks);
            let parsed;
            try { parsed = JSON.parse(data.toString('utf8')); } catch { /* Binary layer, not metadata. */ }
            if (parsed && (parsed.rootfs || parsed.config || parsed.manifests)) {
              if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== digest) throw new Error('Archive blob digest mismatch');
              retained += size;
              if (retained > 16 * 1024 ** 2) throw new Error('Too much archive metadata');
              metadata.set(digest, parsed);
            }
          }
        }
        next();
      } catch (error) { extract.destroy(error); }
    });
  });
  await pipeline(fs.createReadStream(file), extract, { signal });
  let digest = imageId;
  for (let depth = 0; depth < 4; depth++) {
    const item = metadata.get(digest);
    if (!item) throw new Error('Missing image identity metadata');
    if (item.rootfs) {
      if (item.os !== selected.Os || item.architecture !== selected.Architecture
        || (selected.Variant && item.variant !== selected.Variant)) throw new Error('Image platform mismatch');
      const platform = [item.os, item.architecture, selected.Variant].filter(Boolean).join('/');
      if (!/^[a-z0-9_-]+\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)?$/.test(platform)) throw new Error('Invalid image platform');
      return { configId: digest, platform };
    }
    if (item.schemaVersion !== 2) throw new Error('Unsupported image metadata');
    if (item.config && IMAGE_ID.test(item.config.digest)) { digest = item.config.digest; continue; }
    const candidates = Array.isArray(item.manifests) ? item.manifests.filter(entry => entry.platform?.os === selected.Os
      && entry.platform?.architecture === selected.Architecture && (entry.platform?.variant || '') === (selected.Variant || '')) : [];
    if (candidates.length !== 1 || !IMAGE_ID.test(candidates[0].digest)) throw new Error('Ambiguous image platform');
    digest = candidates[0].digest;
  }
  throw new Error('Image metadata nesting too deep');
}

async function runTrivy(file, directory, signal, platform) {
  const config = path.join(directory, 'config.yaml');
  const ignores = path.join(directory, 'ignore');
  await fs.promises.writeFile(config, '{}\n', { mode: 0o600 });
  await fs.promises.writeFile(ignores, '', { mode: 0o600 });
  // Admission must not inherit a UI scanner's filters or ignore configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('TRIVY_')));
  const { stdout } = await execFile('trivy', ['image', '--input', file, '--config', config,
    '--ignorefile', ignores, '--platform', platform, '--scanners', 'vuln', '--format', 'json', '--quiet', '--timeout', '3m'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, signal, env,
  });
  return stdout;
}

async function runGrype(file, directory, signal, platform) {
  const config = path.join(directory, 'grype.json');
  await fs.promises.writeFile(config, JSON.stringify({
    'check-for-app-update': false, 'only-fixed': false, 'only-notfixed': false,
    ignore: [], exclude: [], 'vex-documents': [], 'vex-add': [],
    'match-upstream-kernel-headers': true,
    db: { 'auto-update': true, 'validate-age': true, 'max-allowed-built-age': '120h' },
  }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRYPE|SYFT)_/i.test(key)));
  const { stdout } = await execFile('grype', [file, '--config', config, '--from', 'docker-archive',
    '--from', 'oci-archive', '--platform', platform, '--output', 'json', '--quiet'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, signal, env, cwd: directory,
  });
  return stdout;
}

async function scanImage(docker, imageId, { maxImageBytes = 5 * 1024 ** 3, timeoutMs = 480000,
  scanners = { trivy: runTrivy, grype: runGrype }, temporaryRoot = os.tmpdir() } = {}) {
  const denied = unavailable('trivy+grype', imageId);
  if (!IMAGE_ID.test(imageId || '') || inFlight >= 2
    || typeof scanners?.trivy !== 'function' || typeof scanners?.grype !== 'function') return denied;
  inFlight++;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let directory;
  const pending = [];
  const waitForDaemon = promise => {
    pending.push(promise);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('Docker request deadline exceeded'));
      if (abort.signal.aborted) onAbort();
      else abort.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(value => {
        abort.signal.removeEventListener('abort', onAbort);
        if (abort.signal.aborted) { value?.destroy?.(); return; }
        resolve(value);
      }, error => { abort.signal.removeEventListener('abort', onAbort); reject(error); });
    });
  };
  try {
    directory = await fs.promises.mkdtemp(path.join(temporaryRoot, 'dd-image-admission-'));
    await fs.promises.chmod(directory, 0o700);
    const archive = path.join(directory, 'image.tar');
    const image = docker.getImage(imageId);
    const selected = await waitForDaemon(image.inspect());
    if (selected.Id !== imageId) throw new Error('Docker image identity mismatch');
    const stream = await waitForDaemon(image.get());
    let bytes = 0;
    const bound = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxImageBytes ? new Error('Image export too large') : null, chunk);
    } });
    await pipeline(stream, bound, fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
    if (!bytes) throw new Error('Empty image export');
    const identity = await archiveIdentity(archive, imageId, selected, abort.signal);
    const checks = [];
    for (const [name, assess] of [['trivy', assessReport], ['grype', assessGrypeReport]]) {
      try {
        if (abort.signal.aborted) throw new Error('Admission deadline exceeded');
        const output = await scanners[name](archive, directory, abort.signal, identity.platform);
        if (abort.signal.aborted) throw new Error('Admission deadline exceeded');
        checks.push(assess(output, imageId, identity.configId));
      } catch {
        checks.push(unavailable(name, imageId));
      }
    }
    const summary = { scanner: 'trivy+grype', imageId, counting: 'scanner-findings', checks };
    for (const key of COUNTS) summary[key] = checks.reduce((total, check) => total + (check[key] || 0), 0);
    if (checks.some(check => check.status === 'unavailable')) return { ...summary, ...denied };
    return verdict(summary);
  } catch {
    return denied;
  } finally {
    clearTimeout(timer);
    // A daemon that never sends response headers keeps its admission slot until
    // that call settles; repeated requests cannot accumulate unbounded exports.
    Promise.allSettled(pending).then(() => { inFlight--; });
    if (directory) {
      if (path.dirname(path.resolve(directory)) !== path.resolve(temporaryRoot)
        || !path.basename(directory).startsWith('dd-image-admission-')) throw new Error('Invalid temporary directory');
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
}

module.exports = { scanImage, assessReport, assessGrypeReport };
