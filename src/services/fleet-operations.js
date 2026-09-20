'use strict';

const { getDb } = require('../db');
const dockerService = require('./docker');

const ACTIONS = new Set(['restart', 'prune']);
const SYSTEM_CONTAINERS = new Set(['docker-dash', 'docker-dash-caddy']);
const MAX_HOSTS = 50;

function _validateAction(action) {
  const value = String(action || '').toLowerCase();
  if (!ACTIONS.has(value)) throw Object.assign(new Error('Action must be restart or prune'), { status: 400 });
  return value;
}

function _resolveHosts(hostIds) {
  if (!Array.isArray(hostIds) || !hostIds.length) {
    throw Object.assign(new Error('Select at least one host'), { status: 400 });
  }
  const parsedIds = hostIds.map(value => Number(value));
  if (parsedIds.some(value => !Number.isInteger(value) || value <= 0)) {
    throw Object.assign(new Error('Every host ID must be a positive integer'), { status: 400 });
  }
  const ids = [...new Set(parsedIds)];
  if (ids.length > MAX_HOSTS) throw Object.assign(new Error(`At most ${MAX_HOSTS} hosts may be targeted`), { status: 400 });
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT id, name, daemon_type, is_active
    FROM docker_hosts WHERE id IN (${placeholders})
  `).all(...ids);
  if (rows.length !== ids.length) throw Object.assign(new Error('One or more hosts do not exist'), { status: 404 });
  const invalid = rows.find(row => !row.is_active || !['docker', 'podman'].includes(row.daemon_type || 'docker'));
  if (invalid) throw Object.assign(new Error(`Host "${invalid.name}" is not an active Docker/Podman target`), { status: 409 });
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => byId.get(id));
}

function _restartCandidates(containers) {
  return containers.filter(container => container.state === 'running'
    && !container.isSelf && !SYSTEM_CONTAINERS.has(container.name));
}

async function preview(action, hostIds) {
  action = _validateAction(action);
  const hosts = _resolveHosts(hostIds);
  const results = await Promise.all(hosts.map(async host => {
    try {
      const containers = await dockerService.listContainers(host.id);
      if (action === 'restart') {
        const candidates = _restartCandidates(containers);
        return {
          host_id: host.id, host_name: host.name, status: 'ready',
          affected: candidates.length, detail: `${candidates.length} running container(s) will restart`,
          containers: candidates.slice(0, 25).map(container => container.name),
        };
      }
      const stopped = containers.filter(container => container.state !== 'running').length;
      const usage = await dockerService.getDiskUsage(host.id).catch(() => null);
      return {
        host_id: host.id, host_name: host.name, status: 'ready', affected: stopped,
        detail: `Prune unused containers, images, networks, and build cache; volumes are preserved`,
        reclaimable_bytes: Number(usage?.BuildCache?.reduce?.((sum, item) => sum + (item.Size || 0), 0) || 0),
      };
    } catch (err) {
      return { host_id: host.id, host_name: host.name, status: 'unreachable', affected: 0, error: err.message };
    }
  }));
  return { action, hosts: results, ready: results.filter(result => result.status === 'ready').length };
}

async function run(action, hostIds) {
  action = _validateAction(action);
  const hosts = _resolveHosts(hostIds);
  const results = await Promise.all(hosts.map(async host => {
    try {
      if (action === 'restart') {
        const candidates = _restartCandidates(await dockerService.listContainers(host.id));
        const containers = [];
        for (const candidate of candidates) {
          try {
            await dockerService.containerAction(candidate.id, 'restart', host.id);
            containers.push({ name: candidate.name, status: 'success' });
          } catch (err) {
            containers.push({ name: candidate.name, status: 'failed', error: err.message });
          }
        }
        const failures = containers.filter(container => container.status === 'failed').length;
        return {
          host_id: host.id, host_name: host.name,
          status: failures ? (failures === containers.length ? 'failed' : 'partial') : 'success',
          affected: containers.length - failures, failures, containers,
        };
      }
      const prune = await dockerService.prune({
        containers: true, images: true, networks: true, buildCache: true, volumes: false,
      }, host.id);
      return {
        host_id: host.id, host_name: host.name, status: 'success',
        reclaimed_bytes: Number(prune.SpaceReclaimed || 0),
      };
    } catch (err) {
      return { host_id: host.id, host_name: host.name, status: 'failed', error: err.message };
    }
  }));
  const failed = results.filter(result => result.status === 'failed').length;
  const partial = results.filter(result => result.status === 'partial').length;
  return {
    action,
    status: failed === results.length ? 'failed' : (failed || partial ? 'partial' : 'success'),
    hosts: results,
  };
}

function _healthCounts() {
  const rows = getDb().prepare(`
    SELECT id, conn_state, conn_paused
    FROM docker_hosts
    WHERE is_active = 1 AND COALESCE(daemon_type, 'docker') IN ('docker', 'podman')
  `).all();
  const counts = { total_hosts: rows.length, connected: 0, degraded: 0, disconnected: 0 };
  for (const row of rows) {
    const live = dockerService.getHostStatus(row.id).healthy;
    if (live === true || (live === null && row.conn_state === 'ok')) counts.connected++;
    else if (live === false || row.conn_paused || ['auth_failed', 'unreachable'].includes(row.conn_state)) counts.disconnected++;
    else counts.degraded++;
  }
  return counts;
}

function recordHealthSnapshot() {
  const db = getDb();
  const counts = _healthCounts();
  const date = new Date();
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 5) * 5, 0, 0);
  const bucket = date.toISOString();
  db.prepare(`
    INSERT INTO fleet_health_snapshots
      (bucket, total_hosts, connected, degraded, disconnected)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      total_hosts = excluded.total_hosts,
      connected = excluded.connected,
      degraded = excluded.degraded,
      disconnected = excluded.disconnected,
      created_at = datetime('now')
  `).run(bucket, counts.total_hosts, counts.connected, counts.degraded, counts.disconnected);
  db.prepare("DELETE FROM fleet_health_snapshots WHERE created_at < datetime('now', '-8 days')").run();
  return counts;
}

function fleetHealth(hours = 24) {
  const db = getDb();
  const counts = recordHealthSnapshot();
  const safeHours = Math.min(Math.max(Number.parseInt(hours, 10) || 24, 1), 168);
  const history = db.prepare(`
    SELECT bucket, total_hosts, connected, degraded, disconnected
    FROM fleet_health_snapshots
    WHERE created_at >= datetime('now', ?)
    ORDER BY bucket
  `).all(`-${safeHours} hours`);
  return { current: counts, history, interval_minutes: 5 };
}

module.exports = { preview, run, recordHealthSnapshot, fleetHealth, _resolveHosts, _restartCandidates };
