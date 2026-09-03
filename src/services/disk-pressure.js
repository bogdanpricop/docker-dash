'use strict';

const { getDb } = require('../db');
const { now } = require('../utils/helpers');
const docker = require('./docker');
const audit = require('./audit');
const log = require('../utils/logger')('disk-pressure');
const MAX_CANDIDATES_PER_TYPE = 500;

function _error(message, status = 400) { return Object.assign(new Error(message), { status }); }

function _host(hostId) {
  const row = getDb().prepare(`SELECT id, name, is_active, is_default, daemon_type
    FROM docker_hosts WHERE id=?`).get(Number(hostId));
  if (!row) throw _error('Host not found', 404);
  if (!row.is_active || !['docker', 'podman'].includes(row.daemon_type || 'docker')) {
    throw _error(`Host "${row.name}" is not an active Docker/Podman host`, 409);
  }
  return row;
}

function _decorate(row) {
  if (!row) return null;
  for (const key of ['enabled', 'dry_run_only', 'prune_containers', 'prune_images', 'prune_networks', 'prune_build_cache']) {
    row[key] = !!row[key];
  }
  return row;
}

function listPolicies() {
  return getDb().prepare(`
    SELECT p.*, h.name AS host_name FROM disk_pressure_policies p
    JOIN docker_hosts h ON h.id=p.host_id ORDER BY h.name
  `).all().map(_decorate);
}

function getPolicy(hostId) {
  return _decorate(getDb().prepare(`SELECT p.*, h.name AS host_name
    FROM disk_pressure_policies p JOIN docker_hosts h ON h.id=p.host_id
    WHERE p.host_id=?`).get(Number(hostId)));
}

function updatePolicy(hostId, input = {}) {
  const host = _host(hostId);
  const current = getPolicy(host.id) || {};
  const integer = (key, fallback, min, max) => {
    const value = Number(input[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw _error(`${key} must be between ${min} and ${max}`);
    return value;
  };
  const threshold = integer('threshold_percent', current.threshold_percent ?? 85, 50, 99);
  const minAge = integer('min_age_hours', current.min_age_hours ?? 168, 1, 8760);
  const cooldown = integer('cooldown_minutes', current.cooldown_minutes ?? 360, 15, 10080);
  const maxBytesRaw = input.max_docker_bytes ?? current.max_docker_bytes ?? null;
  const maxBytes = maxBytesRaw === null || maxBytesRaw === '' ? null : Number(maxBytesRaw);
  if (maxBytes !== null && (!Number.isInteger(maxBytes) || maxBytes < 1024 * 1024 * 1024)) {
    throw _error('max_docker_bytes must be null or at least 1 GiB');
  }
  const protectedLabel = String(input.protected_label ?? current.protected_label ?? 'docker-dash.protect').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(protectedLabel)) throw _error('Invalid protected label');
  const bool = (key, fallback) => input[key] === undefined ? !!fallback : input[key] === true;
  getDb().prepare(`
    INSERT INTO disk_pressure_policies
      (host_id, enabled, dry_run_only, threshold_percent, max_docker_bytes,
       min_age_hours, prune_containers, prune_images, prune_networks,
       prune_build_cache, protected_label, cooldown_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(host_id) DO UPDATE SET
      enabled=excluded.enabled, dry_run_only=excluded.dry_run_only,
      threshold_percent=excluded.threshold_percent, max_docker_bytes=excluded.max_docker_bytes,
      min_age_hours=excluded.min_age_hours, prune_containers=excluded.prune_containers,
      prune_images=excluded.prune_images, prune_networks=excluded.prune_networks,
      prune_build_cache=excluded.prune_build_cache, protected_label=excluded.protected_label,
      cooldown_minutes=excluded.cooldown_minutes, updated_at=excluded.updated_at
  `).run(
    host.id, bool('enabled', current.enabled) ? 1 : 0,
    bool('dry_run_only', current.dry_run_only ?? true) ? 1 : 0,
    threshold, maxBytes, minAge,
    bool('prune_containers', current.prune_containers ?? true) ? 1 : 0,
    bool('prune_images', current.prune_images ?? true) ? 1 : 0,
    bool('prune_networks', current.prune_networks) ? 1 : 0,
    bool('prune_build_cache', current.prune_build_cache) ? 1 : 0,
    protectedLabel, cooldown, now()
  );
  return getPolicy(host.id);
}

function _dockerBytes(df) {
  const sum = (items, pick) => (items || []).reduce((total, item) => total + Math.max(0, Number(pick(item)) || 0), 0);
  return {
    images: sum(df.Images, item => item.Size),
    containers: sum(df.Containers, item => item.SizeRw),
    volumes: sum(df.Volumes, item => item.UsageData?.Size),
    buildCache: sum(df.BuildCache, item => item.Size),
  };
}

function _isOld(created, cutoffMs) {
  if (typeof created === 'number') return created * 1000 <= cutoffMs;
  const time = Date.parse(created);
  return Number.isFinite(time) && time <= cutoffMs;
}

function _protected(labels, key) {
  const value = labels?.[key];
  return value !== undefined && !['false', '0', 'no', 'off', ''].includes(String(value).toLowerCase());
}

async function evaluate(hostId, overridePolicy = null) {
  const host = _host(hostId);
  const policy = overridePolicy || getPolicy(host.id);
  if (!policy) throw _error('Disk-pressure policy is not configured', 404);
  const [df, containers, images, networks, info] = await Promise.all([
    docker.getDiskUsage(host.id), docker.listContainers(host.id), docker.listImages(host.id),
    policy.prune_networks ? docker.listNetworks(host.id) : Promise.resolve([]),
    docker.getInfo(host.is_default ? 0 : host.id).catch(() => null),
  ]);
  const components = _dockerBytes(df);
  const dockerBytes = Object.values(components).reduce((sum, value) => sum + value, 0);
  const diskPercent = info?.diskTotal > 0 ? Math.round((info.diskUsed / info.diskTotal) * 1000) / 10 : null;
  const thresholdMet = (diskPercent !== null && diskPercent >= policy.threshold_percent)
    || (policy.max_docker_bytes !== null && dockerBytes >= Number(policy.max_docker_bytes));
  const cutoffMs = Date.now() - policy.min_age_hours * 3600000;
  const protectedLabel = policy.protected_label;

  const containerCandidates = policy.prune_containers ? containers.filter(container =>
    container.state !== 'running' && container.state !== 'paused' && !container.isSelf
    && _isOld(container.created, cutoffMs) && !_protected(container.labels, protectedLabel)
  ) : [];
  const usedImageRefs = new Set();
  for (const container of containers) {
    usedImageRefs.add(container.image);
    if (container.imageId) usedImageRefs.add(container.imageId);
  }
  const imageCandidates = policy.prune_images ? images.filter(image =>
    _isOld(image.created, cutoffMs) && !_protected(image.labels, protectedLabel)
    && !usedImageRefs.has(image.shortId)
    && !(image.repoTags || []).some(tag => usedImageRefs.has(tag))
  ) : [];
  const protectedNetworks = new Set(['bridge', 'host', 'none']);
  const networkCandidates = policy.prune_networks ? networks.filter(network =>
    !protectedNetworks.has(network.name) && Object.keys(network.containers || {}).length === 0
    && _isOld(network.created, cutoffMs) && !_protected(network.labels, protectedLabel)
  ) : [];
  const cacheCandidates = policy.prune_build_cache ? (df.BuildCache || []).filter(item =>
    !item.InUse && _isOld(item.CreatedAt || item.Created, cutoffMs)
  ) : [];
  return {
    host_id: host.id, host_name: host.name, threshold_met: thresholdMet,
    disk_percent: diskPercent, threshold_percent: policy.threshold_percent,
    docker_bytes: dockerBytes, max_docker_bytes: policy.max_docker_bytes,
    components,
    candidates: {
      containers: containerCandidates.slice(0, MAX_CANDIDATES_PER_TYPE).map(item => ({ id: item.id, name: item.name, created: item.created })),
      images: imageCandidates.slice(0, MAX_CANDIDATES_PER_TYPE).map(item => ({ id: item.id, tags: item.repoTags, size: item.size, created: item.created })),
      networks: networkCandidates.slice(0, MAX_CANDIDATES_PER_TYPE).map(item => ({ id: item.id, name: item.name, created: item.created })),
      buildCache: cacheCandidates.slice(0, MAX_CANDIDATES_PER_TYPE).map(item => ({ id: item.ID || item.Id, size: item.Size, created: item.CreatedAt || item.Created })),
      volumes: [],
    },
    candidates_truncated: [containerCandidates, imageCandidates, networkCandidates, cacheCandidates]
      .some(items => items.length > MAX_CANDIDATES_PER_TYPE),
    candidate_counts: {
      containers: containerCandidates.length, images: imageCandidates.length,
      networks: networkCandidates.length, buildCache: cacheCandidates.length, volumes: 0,
    },
    candidate_bytes: imageCandidates.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
      + cacheCandidates.reduce((sum, item) => sum + (Number(item.Size) || 0), 0),
    policy,
  };
}

function _recordRun(evaluation, { triggerType, dryRun, status, reclaimedBytes = 0, error = null, userId = null }) {
  const result = getDb().prepare(`INSERT INTO disk_pressure_runs
    (host_id, trigger_type, dry_run, threshold_met, docker_bytes, candidates_json,
     reclaimed_bytes, status, error, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(evaluation.host_id, triggerType, dryRun ? 1 : 0, evaluation.threshold_met ? 1 : 0,
      evaluation.docker_bytes, JSON.stringify(evaluation.candidates), reclaimedBytes,
      status, error ? String(error).substring(0, 500) : null, userId);
  getDb().prepare(`UPDATE disk_pressure_policies
    SET last_run_at=?, last_status=?, updated_at=? WHERE host_id=?`)
    .run(now(), status, now(), evaluation.host_id);
  return Number(result.lastInsertRowid);
}

async function run(hostId, { force = false, triggerType = 'manual', userId = null } = {}) {
  const policy = getPolicy(hostId);
  if (!policy) throw _error('Disk-pressure policy is not configured', 404);
  if (triggerType === 'automatic' && !policy.enabled) return { status: 'disabled', host_id: Number(hostId) };
  if (triggerType === 'automatic' && policy.last_run_at) {
    const elapsed = Date.now() - Date.parse(policy.last_run_at.replace(' ', 'T') + 'Z');
    if (elapsed < policy.cooldown_minutes * 60000) return { status: 'cooldown', host_id: Number(hostId) };
  }
  const evaluation = await evaluate(hostId, policy);
  if (!evaluation.threshold_met && !force) return { status: 'below_threshold', evaluation };
  const dryRun = policy.dry_run_only || triggerType === 'preview';
  if (dryRun) {
    const runId = _recordRun(evaluation, { triggerType, dryRun: true, status: 'planned', userId });
    return { status: 'planned', dry_run: true, run_id: runId, evaluation };
  }
  if (evaluation.candidate_counts.buildCache > MAX_CANDIDATES_PER_TYPE) {
    throw _error(`Build-cache cleanup has more than ${MAX_CANDIDATES_PER_TYPE} candidates; increase the minimum age and review again`, 409);
  }

  const results = { containers: [], images: [], networks: [], buildCache: null, volumes: [] };
  let reclaimedBytes = 0;
  try {
    for (const item of evaluation.candidates.containers) {
      try {
        await docker.removeContainer(item.id, { force: false, v: false }, evaluation.host_id);
        results.containers.push({ ...item, status: 'deleted' });
      } catch (err) { results.containers.push({ ...item, status: 'failed', error: err.message }); }
    }
    for (const item of evaluation.candidates.images) {
      try {
        await docker.removeImage(item.id, { force: false }, evaluation.host_id);
        reclaimedBytes += Number(item.size) || 0;
        results.images.push({ ...item, status: 'deleted' });
      } catch (err) { results.images.push({ ...item, status: 'failed', error: err.message }); }
    }
    for (const item of evaluation.candidates.networks) {
      try {
        await docker.removeNetwork(item.id, evaluation.host_id);
        results.networks.push({ ...item, status: 'deleted' });
      } catch (err) { results.networks.push({ ...item, status: 'failed', error: err.message }); }
    }
    if (evaluation.candidates.buildCache.length) {
      const cutoff = Math.floor((Date.now() - policy.min_age_hours * 3600000) / 1000);
      results.buildCache = await docker.pruneBuildCacheBefore(cutoff, evaluation.host_id);
      reclaimedBytes += Number(results.buildCache?.SpaceReclaimed) || 0;
    }
    const failures = [...results.containers, ...results.images, ...results.networks]
      .filter(item => item.status === 'failed');
    const status = failures.length ? 'partial' : 'success';
    const runId = _recordRun(evaluation, { triggerType, dryRun: false, status, reclaimedBytes, userId });
    return { status, dry_run: false, run_id: runId, reclaimed_bytes: reclaimedBytes, evaluation, results };
  } catch (err) {
    _recordRun(evaluation, { triggerType, dryRun: false, status: 'failed', reclaimedBytes, error: err.message, userId });
    throw err;
  }
}

async function runAllPolicies() {
  const policies = listPolicies().filter(policy => policy.enabled);
  const results = [];
  for (const policy of policies) {
    try {
      const result = await run(policy.host_id, { triggerType: 'automatic' });
      results.push(result);
      if (['planned', 'success', 'partial'].includes(result.status)) {
        audit.log({
          username: 'system', action: 'disk_pressure_automatic', targetType: 'docker_host',
          targetId: String(policy.host_id), details: {
            status: result.status, dry_run: result.dry_run,
            reclaimed_bytes: result.reclaimed_bytes || 0,
          },
        });
      }
    } catch (err) {
      log.error('Automatic disk-pressure policy failed', { hostId: policy.host_id, error: err.message });
      results.push({ status: 'failed', host_id: policy.host_id, error: err.message });
    }
  }
  return results;
}

function history(hostId, limit = 50) {
  return getDb().prepare(`SELECT * FROM disk_pressure_runs WHERE host_id=?
    ORDER BY id DESC LIMIT ?`).all(Number(hostId), Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map(row => ({ ...row, dry_run: !!row.dry_run, threshold_met: !!row.threshold_met,
      candidates: JSON.parse(row.candidates_json || '{}'), candidates_json: undefined }));
}

module.exports = {
  listPolicies, getPolicy, updatePolicy, evaluate, run, runAllPolicies, history,
  _internals: { _dockerBytes, _protected, _isOld },
};
