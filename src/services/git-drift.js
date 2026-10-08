'use strict';

// v8.3.0 — GitOps drift detection (read-only).
//
// "Has the actually-running container state drifted from what the git-checked-out
// compose file declares?" Complementary to git.checkForUpdates() (which answers
// "are there new commits to deploy"). This answers "did someone touch prod by
// hand". DETECTION ONLY — nothing here starts/stops/removes/deploys anything.
//
// The core compare (detectDrift) is a PURE function: caller injects the desired
// service map + the actual container list, so it's trivially unit-testable with
// no Docker / filesystem / network. parseCompose + scanStack wrap it with I/O.

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const log = require('../utils/logger')('git-drift');

const REPOS_BASE = path.join(process.env.DATA_DIR || '/data', 'repos');

/**
 * Normalize a Docker image reference for comparison:
 *   nginx                       → docker.io/library/nginx:latest
 *   nginx:1.25                  → docker.io/library/nginx:1.25
 *   ghcr.io/foo/bar             → ghcr.io/foo/bar:latest
 *   docker.io/library/nginx     → docker.io/library/nginx:latest
 * So `nginx` and `docker.io/library/nginx:latest` compare equal.
 */
function normalizeImage(ref) {
  if (!ref || typeof ref !== 'string') return '';
  let s = ref.trim();
  // Strip a digest if present (compare by tag, not digest, for drift purposes)
  const atIdx = s.indexOf('@');
  if (atIdx !== -1) s = s.substring(0, atIdx);

  // Split registry/host from the rest. A leading segment is a registry only if
  // it contains a '.' or ':' (host[:port]) or equals 'localhost'.
  const firstSlash = s.indexOf('/');
  let host = '';
  let remainder = s;
  if (firstSlash !== -1) {
    const maybeHost = s.substring(0, firstSlash);
    if (maybeHost === 'localhost' || maybeHost.includes('.') || maybeHost.includes(':')) {
      host = maybeHost;
      remainder = s.substring(firstSlash + 1);
    }
  }

  // Default registry + library namespace for bare names (Docker Hub semantics)
  if (!host) {
    host = 'docker.io';
    if (!remainder.includes('/')) remainder = 'library/' + remainder;
  }

  // Add implicit :latest tag if no tag on the final path component
  const lastSlash = remainder.lastIndexOf('/');
  const lastComponent = lastSlash === -1 ? remainder : remainder.substring(lastSlash + 1);
  if (!lastComponent.includes(':')) remainder += ':latest';

  return `${host}/${remainder}`;
}

/**
 * Parse a compose file's services into { serviceName: { image, container_name, hasBuild } }.
 * @param {string} composeYaml - raw YAML text
 * @returns {object} service map
 */
function parseComposeServices(composeYaml) {
  const doc = yaml.parse(composeYaml);
  const services = (doc && doc.services) || {};
  const out = {};
  for (const [name, def] of Object.entries(services)) {
    if (!def || typeof def !== 'object') { out[name] = { image: null, hasBuild: false }; continue; }
    out[name] = {
      image: typeof def.image === 'string' ? def.image : null,
      container_name: typeof def.container_name === 'string' ? def.container_name : null,
      hasBuild: def.build !== undefined,
    };
  }
  return out;
}

/**
 * PURE drift compare. No I/O.
 * @param {object} desired - service map from parseComposeServices
 * @param {Array}  actual  - [{ name, service, image, state }] running/stopped containers
 *                           for this stack (service = com.docker.compose.service label)
 * @returns {{ inSync: boolean, drifts: Array, checkedAt: string }}
 */
function detectDrift(desired, actual) {
  const drifts = [];
  const actualByService = {};
  for (const c of actual) {
    if (c.service) actualByService[c.service] = c;
  }

  // 1. Services declared in compose but with no container at all → missing
  for (const [svc, def] of Object.entries(desired)) {
    if (!actualByService[svc]) {
      drifts.push({ type: 'missing', service: svc, expected: def.image || `(build) ${svc}` });
    }
  }

  // 2. Containers running under this stack project but not declared → extra
  for (const c of actual) {
    if (c.service && !desired[c.service]) {
      drifts.push({ type: 'extra', service: c.service, container: c.name });
    }
  }

  // 3. Matched services → check state + image
  for (const [svc, def] of Object.entries(desired)) {
    const c = actualByService[svc];
    if (!c) continue; // already reported as missing

    if (c.state && c.state !== 'running') {
      drifts.push({ type: 'stopped', service: svc, container: c.name, state: c.state });
    }

    // Image mismatch only when compose declares an explicit image. Build-only
    // services get a compose-generated image name we don't try to match.
    if (def.image && !def.hasBuild) {
      const want = normalizeImage(def.image);
      const have = normalizeImage(c.image);
      if (want !== have) {
        drifts.push({ type: 'image_mismatch', service: svc, expected: def.image, actual: c.image });
      }
    }
  }

  return { inSync: drifts.length === 0, drifts, checkedAt: new Date().toISOString() };
}

/**
 * I/O wrapper: read the git stack's checked-out compose + the actual containers,
 * run detectDrift. Returns the same shape, or { error } if the repo isn't cloned
 * / compose is unreadable. Never throws.
 * @param {object} stack - git_stacks row ({ id, stack_name, host_id, compose_path })
 * @param {object} dockerService - injected (so this stays testable)
 */
async function scanStack(stack, dockerService, hostId = stack.host_id || 0) {
  try {
    const repoDir = path.join(REPOS_BASE, String(stack.id));
    const composeFull = path.join(repoDir, stack.compose_path || 'docker-compose.yml');
    if (!fs.existsSync(composeFull)) {
      return { error: 'Repository not cloned or compose file missing', inSync: true, drifts: [], checkedAt: new Date().toISOString() };
    }
    const composeYaml = fs.readFileSync(composeFull, 'utf8');
    const desired = parseComposeServices(composeYaml);

    // listContainers already returns all containers (running + stopped).
    const all = await dockerService.listContainers(hostId);
    const actual = all
      .filter(c => c.stack === stack.stack_name)
      .map(c => ({
        name: c.name,
        service: (c.labels && c.labels['com.docker.compose.service']) || null,
        image: c.image,
        state: c.state,
      }));

    return detectDrift(desired, actual);
  } catch (err) {
    log.warn('Drift scan failed', { stack: stack.stack_name, err: err.message });
    return { error: err.message, inSync: true, drifts: [], checkedAt: new Date().toISOString() };
  }
}

/** Scan every configured deployment target and retain host identity on drift rows. */
async function scanStackTargets(stack, dockerService) {
  let targets = Array.isArray(stack.targets) ? stack.targets : [];
  if (!targets.length) {
    try { targets = require('./git-multi-host').listTargets(stack.id); } catch { /* legacy schema */ }
  }
  if (!targets.length) {
    targets = [{ host_id: stack.host_id || 0, host_name: `Host ${stack.host_id || 0}` }];
  }

  const drifts = [];
  const targetResults = [];
  for (const target of targets) {
    const result = await scanStack(stack, dockerService, target.host_id);
    if (result.error) {
      drifts.push({
        type: 'scan_error', hostId: target.host_id,
        hostName: target.host_name, error: result.error,
      });
    } else {
      drifts.push(...result.drifts.map(drift => ({
        ...drift, hostId: target.host_id, hostName: target.host_name,
      })));
    }
    targetResults.push({
      hostId: target.host_id, hostName: target.host_name,
      inSync: !result.error && result.inSync,
      driftCount: result.drifts.length, error: result.error || null,
    });
  }
  return {
    inSync: drifts.length === 0, drifts, targetResults,
    checkedAt: new Date().toISOString(), error: null,
  };
}

// ─── Persistence + orchestration (DB-backed) ──────────────────────────

const { getDb } = require('../db');

/** Read the latest stored drift result for one stack (or a default in-sync shape). */
function getStoredDrift(stackId) {
  const row = getDb().prepare('SELECT * FROM git_stack_drift WHERE stack_id = ?').get(stackId);
  if (!row) return { stackId, inSync: true, driftCount: 0, drifts: [], checkedAt: null, error: null };
  return {
    stackId,
    inSync: !!row.in_sync,
    driftCount: row.drift_count,
    drifts: JSON.parse(row.drift_json || '[]'),
    checkedAt: row.checked_at,
    error: row.error || null,
  };
}

/** Drift summary for ALL git stacks (for badges). */
function getAllStoredDrift() {
  const rows = getDb().prepare('SELECT * FROM git_stack_drift').all();
  const out = {};
  for (const r of rows) {
    out[r.stack_id] = {
      inSync: !!r.in_sync,
      driftCount: r.drift_count,
      checkedAt: r.checked_at,
      error: r.error || null,
    };
  }
  return out;
}

function _saveDrift(stackId, result) {
  const db = getDb();
  db.prepare(`
    INSERT INTO git_stack_drift (stack_id, in_sync, drift_count, drift_json, checked_at, error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(stack_id) DO UPDATE SET
      in_sync = excluded.in_sync,
      drift_count = excluded.drift_count,
      drift_json = excluded.drift_json,
      checked_at = excluded.checked_at,
      error = excluded.error
  `).run(
    stackId,
    result.inSync ? 1 : 0,
    (result.drifts || []).length,
    JSON.stringify(result.drifts || []),
    result.checkedAt,
    result.error || null,
  );
}

/**
 * Build the notification-channel message for a newly-drifted stack. Pure (no I/O)
 * so the wording/severity is unit-testable. Mirrors the eventNotifier message
 * shape: { title, text, severity, event }.
 */
function buildDriftMessage(stack, result) {
  const types = [...new Set((result.drifts || []).map(d => d.type))];
  const count = (result.drifts || []).length;
  const lines = (result.drifts || []).slice(0, 8).map(d => {
    switch (d.type) {
      case 'missing': return `• missing: \`${d.service}\` (expected ${d.expected})`;
      case 'extra': return `• extra: \`${d.container}\` (service ${d.service})`;
      case 'stopped': return `• stopped: \`${d.service}\` is ${d.state}`;
      case 'image_mismatch': return `• image: \`${d.service}\` runs ${d.actual}, git wants ${d.expected}`;
      case 'scan_error': return `• scan failed on \`${d.hostName || d.hostId}\`: ${d.error}`;
      default: return `• ${d.type}: ${d.service || ''}`;
    }
  });
  if (count > 8) lines.push(`• …and ${count - 8} more`);
  return {
    title: '⚠️ Stack drift detected',
    text: `**${stack.stack_name}** has drifted from git (${count} ${count === 1 ? 'difference' : 'differences'}: ${types.join(', ')}).\n${lines.join('\n')}\n\nRe-deploy from git to reconcile.`,
    severity: 'warning',
    event: 'git_drift_detected',
  };
}

/**
 * Scan one stack, persist the result, and on a newly-drifted transition (was
 * in-sync, now not) emit an audit entry AND push a notification to all active
 * channels. Both are best-effort and only fire on the transition, so a stack
 * that stays drifted across scans won't re-notify. Returns the fresh result.
 */
async function scanAndStore(stack, dockerService) {
  const previous = getStoredDrift(stack.id);
  const result = await scanStackTargets(stack, dockerService);
  _saveDrift(stack.id, result);

  if (!result.error && previous.inSync && !result.inSync) {
    try {
      require('./audit').log({
        userId: 0, username: 'system',
        action: 'git_drift_detected', targetType: 'git_stack', targetId: String(stack.id),
        details: JSON.stringify({ stack: stack.stack_name, driftCount: result.drifts.length, types: [...new Set(result.drifts.map(d => d.type))] }),
      });
    } catch (err) { log.debug('drift audit log failed', err.message); }

    try {
      require('./notificationChannels').sendToAll(buildDriftMessage(stack, result))
        .catch(err => log.debug('drift notification failed', err.message));
    } catch (err) { log.debug('drift notification dispatch failed', err.message); }
  }
  return result;
}

/**
 * Scan ALL running git stacks. Used by the leader-gated cron. Skips stacks
 * whose repo isn't cloned. Never throws.
 */
async function scanAll(dockerService) {
  let stacks;
  try {
    stacks = getDb().prepare("SELECT id, stack_name, host_id, compose_path FROM git_stacks WHERE status = 'running'").all();
  } catch (err) {
    log.warn('drift scanAll: cannot list stacks', err.message);
    return { scanned: 0, drifted: 0 };
  }
  let drifted = 0;
  for (const stack of stacks) {
    const r = await scanAndStore(stack, dockerService);
    if (!r.inSync) drifted++;
  }
  if (stacks.length > 0) log.debug('drift scan complete', { scanned: stacks.length, drifted });
  return { scanned: stacks.length, drifted };
}

module.exports = {
  normalizeImage, parseComposeServices, detectDrift, scanStack, scanStackTargets,
  getStoredDrift, getAllStoredDrift, scanAndStore, scanAll, buildDriftMessage,
};
