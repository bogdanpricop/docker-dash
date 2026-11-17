'use strict';

const fs = require('node:fs/promises');
const path = require('node:path').posix;
const YAML = require('yaml');
const { createTwoFilesPatch } = require('diff');
const { sha256 } = require('../../../utils/crypto');

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const BLOCKED = new Set(['critical', 'high', 'unknown']);
const ENGINES = ['trivy', 'grype'];
const MAX_AGE_MS = 7 * 86400000;
const MAX_SOURCE_BYTES = 256 * 1024;

function imageReference(value) {
  if (typeof value !== 'string') return null;
  const [name, digest = '', ...extra] = value.split('@');
  const separator = name.lastIndexOf(':');
  const tagged = separator > name.lastIndexOf('/');
  const repo = tagged ? name.slice(0, separator) : name;
  const tag = tagged ? name.slice(separator + 1) : 'latest';
  if (extra.length || (value.includes('@') && !IMAGE_ID.test(digest))
    || !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?$/.test(repo)
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return null;
  const repository = repo.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '');
  return { repository, tag, digest };
}

function channel(tag) {
  const version = /^([0-9]+)(?:\.[0-9]+)*(-[a-z0-9.-]+)?$/.exec(tag);
  return version ? version[1] + (version[2] || '') : '';
}

function freshScans(scans, now) {
  return ENGINES.map(engine => (scans || []).find(row => row.scanner === engine)).filter(row => {
    const timestamp = row && Date.parse(row.scanned_at.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(row.scanned_at) ? '' : 'Z'));
    return Number.isFinite(timestamp) && now - timestamp >= -300000 && now - timestamp <= MAX_AGE_MS;
  });
}

function evidence(row) {
  const findings = JSON.parse(row.results_json);
  if (!Array.isArray(findings) || findings.some(item => !item || typeof item.id !== 'string' || typeof item.package !== 'string')) {
    throw new Error('Incomplete scanner evidence.');
  }
  return findings;
}

function findingKey(finding) {
  return JSON.stringify([finding.id, finding.package]);
}

function blocked(finding) {
  return BLOCKED.has(finding.severity) || !['medium', 'low', 'negligible'].includes(finding.severity);
}

function compareCandidates(previous, next) {
  const acrossEngines = next.map((row, index) => {
    const before = evidence(previous[index]);
    const after = evidence(row);
    const priorBlockers = new Set(before.filter(blocked).map(findingKey));
    const allAfter = new Set(after.map(findingKey));
    return {
      scanner: row.scanner, previousScan: previous[index].id, candidateScan: row.id,
      removed: before.filter(item => /\d/.test(item.fixedIn || '') && !allAfter.has(findingKey(item))),
      newBlockers: after.filter(item => blocked(item) && !priorBlockers.has(findingKey(item))).length,
      blockers: after.filter(blocked).length,
    };
  });
  if (acrossEngines.some(check => check.newBlockers > 0)) return null;
  const [first, second] = acrossEngines;
  const removeBoth = new Set(second.removed.map(findingKey));
  const fixed = [...new Map(first.removed.filter(item => removeBoth.has(findingKey(item))).map(item => [
    findingKey(item), { id: item.id, package: item.package },
  ])).values()];
  if (!fixed.length) return null;
  return {
    fixed,
    admissionPassed: acrossEngines.every(check => check.blockers === 0),
    checks: acrossEngines.map(({ removed: _removed, ...check }) => check),
  };
}

async function selectCandidate(declared, baseline, images, getScans, inspect, now) {
  const reference = imageReference(declared);
  if (!reference || !IMAGE_ID.test(baseline.Id)) return null;
  const currentTags = (baseline.RepoTags || []).map(imageReference).filter(tag => tag && tag.repository === reference.repository);
  const track = reference.tag === 'latest' && reference.digest ? new Set(currentTags.map(tag => channel(tag.tag)).filter(Boolean)) : new Set([channel(reference.tag)]);
  if (track.size !== 1 || track.has('')) return null;
  const previous = freshScans(getScans(baseline.Id), now);
  if (previous.length !== ENGINES.length) return null;
  const currentBuild = Math.floor(Date.parse(baseline.Created) / 1000);
  let winner = null;
  for (const image of images) {
    if (!IMAGE_ID.test(image.id) || image.id === baseline.Id) continue;
    if (Number.isFinite(currentBuild) && image.created < currentBuild) continue;
    if (!(image.repoTags || []).some(tag => {
      const parsed = imageReference(tag);
      return parsed && parsed.repository === reference.repository && track.has(channel(parsed.tag));
    })) continue;
    const pinned = (image.repoDigests || []).find(digest => {
      const parsed = imageReference(digest);
      return parsed?.repository === reference.repository && parsed.digest && /^[-a-z0-9._/:]+@sha256:[a-f0-9]{64}$/.test(digest);
    });
    if (!pinned) continue;
    const next = freshScans(getScans(image.id), now);
    if (next.length !== ENGINES.length) continue;
    let findings;
    try { findings = compareCandidates(previous, next); } catch { continue; }
    if (!findings) continue;
    const meta = await inspect(pinned);
    if (!meta || meta.Id !== image.id || meta.Os !== baseline.Os || meta.Architecture !== baseline.Architecture
      || (meta.Variant || '') !== (baseline.Variant || '')) continue;
    const candidate = { ...findings, pinned, imageId: meta.Id, created: image.created || 0 };
    if (!winner || (Number(candidate.admissionPassed) > Number(winner.admissionPassed))
      || (candidate.admissionPassed === winner.admissionPassed && candidate.fixed.length > winner.fixed.length)
      || (candidate.admissionPassed === winner.admissionPassed && candidate.fixed.length === winner.fixed.length && candidate.created > winner.created)) {
      winner = candidate;
    }
  }
  return winner;
}

function inside(root, filename) {
  return filename.startsWith(root + '/');
}

function safePath(filename) {
  return typeof filename === 'string' && /^\/[A-Za-z0-9_.\-/]+$/.test(filename) && path.normalize(filename) === filename
    && !filename.split('/').some(part => ['.', '..'].includes(part));
}

async function readSource(root, filename, roots) {
  if (!safePath(root) || !safePath(filename) || !inside(root, filename)
    || !roots.some(allowed => allowed === root || inside(allowed, root))) throw new Error('File outside the configured stack roots.');
  const resolved = await fs.realpath(filename);
  if (resolved !== filename) throw new Error('Linked source is unsupported.');
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Unsupported source file.');
  const contents = await fs.readFile(filename, 'utf8');
  if (Buffer.byteLength(contents) > MAX_SOURCE_BYTES || contents.includes('\ufffd')) throw new Error('Unsupported source encoding.');
  return contents;
}

function composeFileFor(containers) {
  const refs = new Set(containers.map(c => c.labels?.['com.docker.compose.project.config_files']));
  const dirs = new Set(containers.map(c => c.labels?.['com.docker.compose.project.working_dir']));
  const [filename] = refs;
  const [root] = dirs;
  if (refs.size !== 1 || dirs.size !== 1 || !safePath(filename) || !safePath(root) || path.dirname(filename) !== root
    || !/\.ya?ml$/.test(filename) || containers.some(c => c.labels?.['com.docker.compose.project.environment_file'])) return null;
  return { filename, root };
}

function composeImage(contents, service) {
  const doc = YAML.parseDocument(contents);
  const node = doc.getIn(['services', service], true);
  if (doc.errors.length || !YAML.isMap(node) || node.has('<<') || node.has('extends') || doc.has('include')) return null;
  return node;
}

function replaceComposeImage(contents, node, pinned) {
  const scalar = node.get('image', true);
  if (!YAML.isScalar(scalar) || scalar.anchor || scalar.tag || !imageReference(scalar.value) || node.has('build')) return null;
  const [start, end] = scalar.range;
  const old = contents.slice(start, end);
  if (/[\r\n]/.test(old)) return null;
  const lineStart = contents.lastIndexOf('\n', start - 1) + 1;
  const next = contents.indexOf('\n', end);
  // The single modified line must contain only the image reference and whitespace.
  if (!/^[ \t]*image[ \t]*:[ \t]*$/.test(contents.slice(lineStart, start))
    || !/^[ \t\r]*$/.test(contents.slice(end, next === -1 ? undefined : next))) return null;
  const value = /^['"]/.test(old) ? old[0] + pinned + old[0] : pinned;
  return contents.slice(0, start) + value + contents.slice(end);
}

function dockerfileBase(contents) {
  const matches = [...contents.matchAll(/^[ \t]*FROM[ \t]+(\S+)(?:[ \t]+AS[ \t]+[A-Za-z0-9_-]+)?[ \t]*\r?$/gim)];
  if (matches.length !== 1 || (contents.match(/^[ \t]*FROM\b/gim) || []).length !== 1) return null;
  const [line, value] = matches[0];
  if (!imageReference(value)?.digest) return null;
  const start = matches[0].index + line.indexOf(value);
  return { value, start, end: start + value.length };
}

function hasBase(image, base) {
  const layers = image.RootFS?.Layers || [];
  const parent = base.RootFS?.Layers || [];
  return parent.length > 0 && layers.length >= parent.length && parent.every((id, index) => layers[index] === id);
}

const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function change({ contents, after, filename, root, composeFile, stack, service, baseline, candidate, gitBacked, buildContext }) {
  const relative = path.relative(root, filename);
  const config = path.basename(composeFile);
  // Zero context avoids returning nearby environment values or secrets.
  const diff = createTwoFilesPatch(relative, relative, contents, after, '', '', { context: 0 });
  const compose = 'docker compose --project-directory ' + quote(root) + ' -p ' + quote(stack) + ' -f ' + quote(config);
  const assertSource = 'test "$(sha256sum -- ' + quote(relative) + " | cut -d ' ' -f1)\" = " + quote(sha256(contents));
  const common = [
    '(', 'set -eu', 'umask 077', 'cd -- ' + quote(root),
    assertSource,
    'work=$(mktemp -d)', 'trap \'rm -f -- "$work/patch" "$work/preview" "$work/preview.dockerignore" "$work/image-id"; rmdir -- "$work"\' EXIT',
    'printf %s ' + quote(Buffer.from(diff, 'utf8').toString('base64')) + ' | base64 -d > "$work/patch"',
    'cp -- ' + quote(relative) + ' "$work/preview"',
    'patch --binary --batch --forward --fuzz=0 "$work/preview" < "$work/patch"',
  ];
  const prepare = buildContext
    ? [...common, 'if test -f ' + quote(relative + '.dockerignore') + '; then cp -- ' + quote(relative + '.dockerignore') + ' "$work/preview.dockerignore"; fi',
      'docker build --pull --iidfile "$work/image-id" --file "$work/preview" ' + quote(buildContext),
      'cat "$work/image-id"']
    : [...common, 'docker compose --project-directory ' + quote(root) + ' -p ' + quote(stack) + ' -f "$work/preview" config --quiet',
      'docker pull ' + quote(candidate.pinned),
      'test "$(docker image inspect --format \'{{.Id}}\' ' + quote(candidate.pinned) + ')" = ' + quote(candidate.imageId)];
  let deployCommands = '';
  if (candidate.admissionPassed && !buildContext && !gitBacked) {
    deployCommands = [...prepare,
      'ids=$(' + compose + ' ps -aq -- ' + quote(service) + ')',
      'test -n "$ids"',
      'for id in $ids; do test "$(docker inspect --format \'{{.Image}}\' "$id")" = ' + quote(baseline) + '; done',
      assertSource,
      'patch --binary --batch --forward --fuzz=0 --backup --suffix=.dgx-before -- ' + quote(relative) + ' < "$work/patch"',
      compose + ' up -d --no-deps --no-build --pull never -- ' + quote(service),
      compose + ' ps -- ' + quote(service),
      ')',
    ].join('\n');
  }
  return { file: filename, diff, candidate, gitBacked, kind: buildContext ? 'dockerfile' : 'compose',
    prepareCommands: [...prepare, ')'].join('\n'), deployCommands };
}

async function buildPlan({ containers, stack, images, getScans, inspectImage, gitBacked, sourceRoots, now = Date.now(), read = readSource }) {
  const services = new Map();
  for (const container of containers) {
    const name = container.labels?.['com.docker.compose.service'];
    if (SERVICE_NAME.test(name || '')) {
      if (!services.has(name)) services.set(name, []);
      services.get(name).push(container);
    }
  }
  const composeSource = composeFileFor(containers);
  let composeText = null;
  if (composeSource) {
    try { composeText = await read(composeSource.root, composeSource.filename, sourceRoots); } catch { /* file not mounted or unsafe */ }
  }
  const plan = [];
  const memo = new Map();
  const inspect = key => {
    if (!memo.has(key)) memo.set(key, Promise.resolve().then(() => inspectImage(key)).catch(() => null));
    return memo.get(key);
  };
  for (const [service, replicas] of services) {
    const ids = [...new Set(replicas.map(container => container.imageIdFull))];
    const entry = { service, imageIds: ids, replicas: replicas.length };
    plan.push(entry);
    if (ids.length !== 1 || !IMAGE_ID.test(ids[0])) { entry.reason = 'mixed_images'; continue; }
    const [id] = ids;
    if (!getScans(id).length) { entry.reason = 'no_scan'; continue; }
    if (!composeText) { entry.reason = 'compose_unavailable'; continue; }
    const node = composeImage(composeText, service);
    const baseline = await inspect(id);
    if (!node || !baseline) { entry.reason = 'unsupported_source'; continue; }
    const opts = { root: composeSource.root, composeFile: composeSource.filename, stack, service, baseline: id, gitBacked };
    const declared = node.get('image');
    if (!node.has('build')) {
      const resolved = imageReference(declared) && await inspect(declared);
      if (!resolved || resolved.Id !== id) { entry.reason = 'source_drift'; continue; }
      const candidate = await selectCandidate(declared, baseline, images, getScans, inspect, now);
      if (!candidate) { entry.reason = 'no_verified_candidate'; continue; }
      const after = replaceComposeImage(composeText, node, candidate.pinned);
      if (!after) { entry.reason = 'unsupported_source'; continue; }
      entry.change = change({ ...opts, contents: composeText, after, filename: composeSource.filename, candidate });
      continue;
    }
    const build = node.get('build', true);
    const context = YAML.isScalar(build) ? build.value : build?.get?.('context');
    const dockerfile = YAML.isMap(build) ? (build.get('dockerfile') || 'Dockerfile') : 'Dockerfile';
    const supported = YAML.isScalar(build) || (YAML.isMap(build) && build.items.every(item => ['context', 'dockerfile'].includes(item.key?.value)));
    if (!supported || typeof context !== 'string' || typeof dockerfile !== 'string'
      || !/^[A-Za-z0-9_./-]+$/.test(context) || !/^[A-Za-z0-9_./-]+$/.test(dockerfile)
      || path.isAbsolute(context) || path.isAbsolute(dockerfile)) { entry.reason = 'unsupported_source'; continue; }
    const buildContext = path.resolve(composeSource.root, context);
    const filename = path.resolve(buildContext, dockerfile);
    if ((buildContext !== composeSource.root && !inside(composeSource.root, buildContext)) || !inside(buildContext, filename)) {
      entry.reason = 'unsupported_source'; continue;
    }
    let contents;
    try { contents = await read(composeSource.root, filename, sourceRoots); } catch { entry.reason = 'dockerfile_unavailable'; continue; }
    const from = dockerfileBase(contents);
    const base = from && await inspect(from.value);
    if (!base || !hasBase(baseline, base)) { entry.reason = 'unverified_base'; continue; }
    const candidate = await selectCandidate(from.value, base, images, getScans, inspect, now);
    if (!candidate) { entry.reason = 'no_verified_candidate'; continue; }
    const serviceFindings = new Set(getScans(id).flatMap(row => evidence(row).map(findingKey)));
    candidate.fixed = candidate.fixed.filter(item => serviceFindings.has(findingKey(item)));
    if (!candidate.fixed.length) { entry.reason = 'no_verified_candidate'; continue; }
    const after = contents.slice(0, from.start) + candidate.pinned + contents.slice(from.end);
    entry.change = change({ ...opts, contents, after, filename, candidate, buildContext });
  }
  return plan;
}

module.exports = { buildPlan, STACK_NAME, IMAGE_ID };
