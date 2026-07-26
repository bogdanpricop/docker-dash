'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { execFileSync } = require('child_process');
const { getDb } = require('../db');
const { now } = require('../utils/helpers');
const registry = require('./registry');
const provenanceParser = require('./registry-provenance');
const git = require('./git');

const MAX_OVERRIDE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 200 * 1024;

function _error(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

function _hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function _validateName(value, label = 'Name') {
  const name = String(value || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(name)) {
    throw _error(`${label} must be lowercase alphanumeric with hyphens or underscores`);
  }
  return name;
}

function _validateRepository(value) {
  const repository = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(repository)
      || repository.includes('..') || repository.startsWith('/') || repository.endsWith('/')) {
    throw _error('Invalid OCI repository path');
  }
  return repository;
}

function _validateReference(value) {
  const ref = String(value || 'latest');
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[a-f0-9]{64})$/.test(ref)) {
    throw _error('OCI reference must be a valid tag or sha256 digest');
  }
  return ref;
}

function _validateOverride(value) {
  const yaml = String(value || '');
  if (!yaml) return null;
  if (Buffer.byteLength(yaml) > MAX_OVERRIDE_BYTES) throw _error('OCI override exceeds 512 KiB', 413);
  let parsed;
  try { parsed = YAML.parse(yaml); } catch (err) { throw _error(`Invalid OCI override YAML: ${err.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw _error('OCI override must be a Compose object');
  if (parsed.include) throw _error('Local OCI overrides cannot add remote includes');
  for (const [kind, entries] of [['config', parsed.configs], ['secret', parsed.secrets]]) {
    for (const [name, entry] of Object.entries(entries || {})) {
      if (entry?.file) throw _error(`OCI override ${kind} ${name} cannot reference a local file`);
    }
  }
  for (const [name, service] of Object.entries(parsed.services || {})) {
    if (!service || typeof service !== 'object') throw _error(`Invalid override service: ${name}`);
    if (service.build) throw _error(`OCI override service ${name} cannot add a local build`);
    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    if (volumes.some(volume => (typeof volume === 'string' && /^(?:\.|~[\\/]|\/|[A-Za-z]:[\\/])/.test(volume))
      || (volume && typeof volume === 'object' && volume.type === 'bind'))) {
      throw _error(`OCI override service ${name} cannot add a bind mount`);
    }
  }
  return yaml;
}

function _host(hostId) {
  const row = getDb().prepare('SELECT id, name, is_active, daemon_type FROM docker_hosts WHERE id = ?').get(Number(hostId));
  if (!row) throw _error('OCI deployment host not found', 404);
  if (!row.is_active || !['docker', 'podman'].includes(row.daemon_type || 'docker')) {
    throw _error(`Host "${row.name}" is not an active Compose target`, 409);
  }
  return row;
}

function _decorate(row) {
  if (!row) return null;
  return {
    ...row,
    provenance: row.provenance_json ? JSON.parse(row.provenance_json) : null,
    override_yaml: row.override_yaml || '',
  };
}

function list() {
  return getDb().prepare(`
    SELECT a.*, r.name AS registry_name, r.url AS registry_url, h.name AS host_name
    FROM oci_compose_artifacts a
    JOIN registries r ON r.id = a.registry_id
    JOIN docker_hosts h ON h.id = a.host_id
    ORDER BY a.name
  `).all().map(_decorate);
}

function get(id) {
  return _decorate(getDb().prepare(`
    SELECT a.*, r.name AS registry_name, r.url AS registry_url, h.name AS host_name
    FROM oci_compose_artifacts a
    JOIN registries r ON r.id = a.registry_id
    JOIN docker_hosts h ON h.id = a.host_id WHERE a.id = ?
  `).get(Number(id)));
}

async function _resolve(registryId, repository, reference) {
  const reg = registry.get(Number(registryId));
  if (!reg) throw _error('Registry not found', 404);
  const manifest = await registry.manifest(Number(registryId), repository, reference);
  const digest = manifest.digest || (reference.startsWith('sha256:') ? reference : null);
  if (!digest || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw _error('Registry did not return a sha256 digest; refusing an unpinned artifact', 409, 'DIGEST_REQUIRED');
  }
  if (!manifest.manifest || Number(manifest.manifest.schemaVersion) !== 2) {
    throw _error('Reference is not a supported OCI manifest', 409, 'INVALID_OCI_MANIFEST');
  }
  return { reg, manifest, digest: digest.toLowerCase(), provenance: provenanceParser.parse(manifest) };
}

function _registryHost(reg) {
  const parsed = new URL(reg.url);
  return `${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
}

function _artifactUri(artifact) {
  const reg = registry.get(Number(artifact.registry_id));
  if (!reg) throw _error('Registry not found', 404);
  return `oci://${_registryHost(reg)}/${artifact.repository}@${artifact.digest}`;
}

function _registryEnvironment(reg, baseEnv) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-oci-auth-'));
  const auth = registry._authConfigForRegistry(reg);
  const host = new URL(reg.url).host;
  const config = { auths: { [host]: { auth: Buffer.from(`${auth.username}:${auth.password}`).toString('base64') } } };
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return {
    env: { ...baseEnv, DOCKER_CONFIG: directory },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function _composeCliEnvironment(source) {
  const allowed = new Set([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'COMPOSE_ANSI',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source || {})) if (allowed.has(key)) env[key] = value;
  env.COMPOSE_DISABLE_ENV_FILE = '1';
  return env;
}

function _verifyAnnotation(policy, signerPattern, provenance) {
  if (policy === 'none') return { policy, passed: true, cryptographicallyVerified: false };
  if (!provenance.known?.signed) {
    throw _error('OCI artifact has no recognized signature annotation', 409, 'SIGNATURE_REQUIRED');
  }
  if (signerPattern) {
    if (String(signerPattern).length > 256) throw _error('Signer pattern is too long');
    let matcher;
    try { matcher = new RegExp(signerPattern); } catch { throw _error('Invalid signer pattern'); }
    if (!matcher.test(provenance.known.signer || '')) {
      throw _error('OCI artifact signer does not match the required pattern', 409, 'SIGNER_MISMATCH');
    }
  }
  return { policy, passed: true, signer: provenance.known.signer || null, cryptographicallyVerified: false };
}

function _verifyCosign(artifact, reg, signerPattern) {
  if (signerPattern && String(signerPattern).length > 256) throw _error('Signer pattern is too long');
  try { execFileSync('cosign', ['version'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }); }
  catch { throw _error('Cosign verification is required but the cosign binary is unavailable', 501, 'COSIGN_UNAVAILABLE'); }
  const auth = _registryEnvironment(reg, process.env);
  try {
    const args = ['verify', '--output', 'json'];
    if (signerPattern) {
      args.push('--certificate-identity-regexp', signerPattern, '--certificate-oidc-issuer-regexp', '.*');
    }
    args.push(`${_registryHost(reg)}/${artifact.repository}@${artifact.digest}`);
    const output = execFileSync('cosign', args, {
      encoding: 'utf8', timeout: 120000, stdio: 'pipe', env: auth.env,
    });
    return { policy: 'cosign', passed: true, cryptographicallyVerified: true, outputHash: _hash(output) };
  } catch (err) {
    throw _error(`Cosign verification failed: ${String(err.stderr || err.message).substring(0, 300)}`, 409, 'COSIGN_VERIFY_FAILED');
  } finally { auth.cleanup(); }
}

async function create(input, userId) {
  const name = _validateName(input.name, 'Artifact name');
  const projectName = _validateName(input.project_name || input.projectName || name, 'Project name');
  const repository = _validateRepository(input.repository);
  const sourceRef = _validateReference(input.source_ref || input.sourceRef || 'latest');
  const signaturePolicy = String(input.signature_policy || input.signaturePolicy || 'none');
  if (!['none', 'annotation', 'cosign'].includes(signaturePolicy)) throw _error('Invalid signature policy');
  _host(input.host_id ?? input.hostId);
  const overrideYaml = _validateOverride(input.override_yaml ?? input.overrideYaml);
  const resolved = await _resolve(input.registry_id ?? input.registryId, repository, sourceRef);
  const trust = signaturePolicy === 'cosign'
    ? _verifyCosign({ repository, digest: resolved.digest }, resolved.reg, input.signer_pattern || input.signerPattern)
    : _verifyAnnotation(signaturePolicy, input.signer_pattern || input.signerPattern, resolved.provenance);
  const provenance = { ...resolved.provenance, trust };
  let result;
  try {
    result = getDb().prepare(`INSERT INTO oci_compose_artifacts
      (name, registry_id, repository, source_ref, digest, host_id, project_name,
       override_yaml, signature_policy, signer_pattern, provenance_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, Number(input.registry_id ?? input.registryId), repository, sourceRef, resolved.digest,
        Number(input.host_id ?? input.hostId), projectName, overrideYaml, signaturePolicy,
        input.signer_pattern || input.signerPattern || null, JSON.stringify(provenance), userId || null);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw _error(`OCI artifact name "${name}" already exists`, 409);
    throw err;
  }
  return get(Number(result.lastInsertRowid));
}

async function refresh(id) {
  const artifact = get(id);
  if (!artifact) throw _error('OCI artifact not found', 404);
  if (artifact.status === 'deploying') throw _error('OCI artifact is deploying', 409);
  const resolved = await _resolve(artifact.registry_id, artifact.repository, artifact.source_ref);
  const trust = artifact.signature_policy === 'cosign'
    ? _verifyCosign({ repository: artifact.repository, digest: resolved.digest }, resolved.reg, artifact.signer_pattern)
    : _verifyAnnotation(artifact.signature_policy, artifact.signer_pattern, resolved.provenance);
  const provenance = { ...resolved.provenance, trust };
  getDb().prepare(`UPDATE oci_compose_artifacts
    SET digest=?, provenance_json=?, status='ready', last_error=NULL, updated_at=? WHERE id=?`)
    .run(resolved.digest, JSON.stringify(provenance), now(), artifact.id);
  return get(artifact.id);
}

function _composeContext(artifact) {
  const dockerEnv = git.getDockerCliEnvironment(artifact.host_id);
  const reg = registry.get(artifact.registry_id);
  const registryEnv = _registryEnvironment(reg, dockerEnv.env);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-oci-compose-'));
  const args = ['compose', '-f', _artifactUri(artifact)];
  if (artifact.override_yaml) {
    const overridePath = path.join(directory, 'compose.override.yaml');
    fs.writeFileSync(overridePath, artifact.override_yaml, { mode: 0o600 });
    args.push('-f', overridePath);
  }
  args.push('-p', artifact.project_name);
  return {
    args, directory, env: _composeCliEnvironment(registryEnv.env),
    cleanup: () => {
      registryEnv.cleanup(); dockerEnv.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function _checkComposeVersion(context) {
  let output;
  try {
    output = execFileSync('docker', ['compose', 'version', '--short'], {
      encoding: 'utf8', timeout: 15000, stdio: 'pipe', env: context.env,
    });
  } catch { throw _error('Docker Compose is unavailable on this Docker Dash node', 501, 'COMPOSE_UNAVAILABLE'); }
  const match = String(output).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 34)) {
    throw _error('OCI Compose artifacts require Docker Compose 2.34.0 or later', 501, 'OCI_COMPOSE_UNSUPPORTED');
  }
}

function _run(artifact, action, userId, { dryRun = false } = {}) {
  const context = _composeContext(artifact);
  try {
    _checkComposeVersion(context);
    const args = [...context.args];
    if (dryRun) args.splice(1, 0, '--dry-run', '--progress', 'json');
    args.push(action);
    if (action === 'up') args.push('-d', '--remove-orphans');
    else if (action === 'down') args.push('--remove-orphans');
    let output = '';
    try {
      output = execFileSync('docker', args, {
        cwd: context.directory, env: context.env, encoding: 'utf8', timeout: 300000,
        maxBuffer: MAX_OUTPUT_BYTES, input: 'y\ny\ny\n', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = String(err.stderr || err.stdout || err.message).substring(0, MAX_OUTPUT_BYTES);
      getDb().prepare(`INSERT INTO oci_compose_deployments
        (artifact_id, digest, action, status, error, created_by) VALUES (?, ?, ?, 'failed', ?, ?)`)
        .run(artifact.id, artifact.digest, dryRun ? 'plan' : action === 'up' ? 'deploy' : 'down', message, userId || null);
      throw _error(message || 'OCI Compose command failed', 502, 'OCI_COMPOSE_FAILED');
    }
    const bounded = String(output).substring(0, MAX_OUTPUT_BYTES);
    getDb().prepare(`INSERT INTO oci_compose_deployments
      (artifact_id, digest, action, status, output, created_by) VALUES (?, ?, ?, 'success', ?, ?)`)
      .run(artifact.id, artifact.digest, dryRun ? 'plan' : action === 'up' ? 'deploy' : 'down', bounded, userId || null);
    return bounded;
  } finally { context.cleanup(); }
}

function plan(id, userId) {
  const artifact = get(id);
  if (!artifact) throw _error('OCI artifact not found', 404);
  const output = _run(artifact, 'up', userId, { dryRun: true });
  const planHash = _hash({ id: artifact.id, digest: artifact.digest, host: artifact.host_id,
    project: artifact.project_name, override: _hash(artifact.override_yaml || ''),
    signaturePolicy: artifact.signature_policy, signerPattern: artifact.signer_pattern || null });
  return { artifactId: artifact.id, digest: artifact.digest, uri: _artifactUri(artifact), planHash, output };
}

function deploy(id, planHash, userId) {
  if (!planHash) throw _error('A reviewed OCI deployment planHash is required');
  const reviewed = plan(id, userId);
  if (reviewed.planHash !== planHash) throw _error('OCI deployment plan is stale', 409, 'STALE_PLAN');
  const artifact = get(id);
  getDb().prepare("UPDATE oci_compose_artifacts SET status='deploying', last_error=NULL, updated_at=? WHERE id=?")
    .run(now(), artifact.id);
  try {
    const output = _run(artifact, 'up', userId);
    getDb().prepare(`UPDATE oci_compose_artifacts
      SET status='running', last_deployed_at=?, last_error=NULL, updated_at=? WHERE id=?`)
      .run(now(), now(), artifact.id);
    return { ok: true, artifact: get(artifact.id), output };
  } catch (err) {
    getDb().prepare("UPDATE oci_compose_artifacts SET status='error', last_error=?, updated_at=? WHERE id=?")
      .run(err.message.substring(0, 500), now(), artifact.id);
    throw err;
  }
}

function down(id, userId) {
  const artifact = get(id);
  if (!artifact) throw _error('OCI artifact not found', 404);
  const output = _run(artifact, 'down', userId);
  getDb().prepare("UPDATE oci_compose_artifacts SET status='ready', last_error=NULL, updated_at=? WHERE id=?")
    .run(now(), artifact.id);
  return { ok: true, artifact: get(artifact.id), output };
}

function remove(id) {
  const artifact = get(id);
  if (!artifact) throw _error('OCI artifact not found', 404);
  if (['running', 'deploying'].includes(artifact.status)) throw _error('Stop the OCI application before deleting its definition', 409);
  getDb().prepare('DELETE FROM oci_compose_artifacts WHERE id = ?').run(artifact.id);
  return { ok: true };
}

function history(id, limit = 25) {
  return getDb().prepare(`SELECT * FROM oci_compose_deployments
    WHERE artifact_id=? ORDER BY id DESC LIMIT ?`).all(Number(id), Math.min(Math.max(Number(limit) || 25, 1), 100));
}

module.exports = {
  list, get, create, refresh, plan, deploy, down, remove, history,
  _internals: { _validateOverride, _artifactUri, _hash, _verifyAnnotation, _composeCliEnvironment },
};
