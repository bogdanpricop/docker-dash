'use strict';

// v8.9.13-alpha.1 — vSphere metric history poller + reader.
//
// Every DD_VSPHERE_POLL_SEC (default 300s = 5 min) this records one snapshot
// per registered vSphere host: aggregate CPU%/mem% across ESXi hosts, VM
// counts, datastore totals, uptime. Best-effort — an unreachable host just
// skips that cycle. Retention: DD_VSPHERE_HISTORY_DAYS (default 14) days.
//
// The Trends tab reads getHistory() and draws an SVG sparkline — no chart
// library (docker-dash ships no chart dep; inline SVG is the house style).

const { getDb } = require('../db');
const { fromHostRow } = require('./vsphere');
const log = require('../utils/logger')('vsphere-history');

const POLL_MS = Math.max(60, parseInt(process.env.DD_VSPHERE_POLL_SEC || '300', 10)) * 1000;
const RETENTION_DAYS = Math.max(1, parseInt(process.env.DD_VSPHERE_HISTORY_DAYS || '14', 10));

let _timer = null;

function _vsphereHosts() {
  return getDb().prepare(
    `SELECT * FROM docker_hosts WHERE daemon_type = 'vsphere' AND is_active = 1`
  ).all();
}

/** Record one snapshot for a single vSphere host row. Best-effort. */
async function recordSnapshot(row) {
  const client = fromHostRow(row);
  try {
    await client.login();
    const [hosts, vms, datastores] = await Promise.all([
      client.listHosts().catch(() => []),
      client.listVMs().catch(() => []),
      client.listDatastores().catch(() => []),
    ]);
    // Aggregate across ESXi hosts (standalone = 1; vCenter = many).
    const cpuPcts = hosts.map(h => h.cpuPercent).filter(v => typeof v === 'number');
    const memPcts = hosts.map(h => h.memoryPercent).filter(v => typeof v === 'number');
    const avg = (a) => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null;
    const memUsedMB = hosts.reduce((s, h) => s + (h.memoryUsageMB || 0), 0);
    const memTotalMB = hosts.reduce((s, h) => s + (h.memoryTotalMB || 0), 0);
    const vmRunning = vms.filter(v => v.powerState === 'poweredOn').length;
    const dsTotalGB = datastores.reduce((s, d) => s + ((d.capacityBytes || 0) / (1024 ** 3)), 0);
    const dsUsedGB = datastores.reduce((s, d) => s + (((d.capacityBytes || 0) - (d.freeSpaceBytes || 0)) / (1024 ** 3)), 0);
    const uptime = hosts.length ? Math.max(...hosts.map(h => h.uptimeSeconds || 0)) : null;

    getDb().prepare(`
      INSERT INTO vsphere_snapshots
        (host_id, esxi_host, cpu_pct, mem_pct, mem_used_mb, mem_total_mb,
         vm_total, vm_running, ds_total_gb, ds_used_gb, uptime_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, (hosts[0] && hosts[0].name) || row.name,
      avg(cpuPcts), avg(memPcts), memUsedMB, memTotalMB,
      vms.length, vmRunning, Math.round(dsTotalGB), Math.round(dsUsedGB), uptime);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function _pollAll() {
  let rows;
  try { rows = _vsphereHosts(); } catch { return; }
  for (const row of rows) {
    try { await recordSnapshot(row); }
    catch (err) { log.debug('snapshot skipped', { host: row.name, error: err.message }); }
  }
  // Retention purge.
  try {
    getDb().prepare(
      `DELETE FROM vsphere_snapshots WHERE captured_at < datetime('now', ?)`
    ).run(`-${RETENTION_DAYS} days`);
  } catch { /* ignore */ }
}

function getHistory(hostId, limit = 500) {
  return getDb().prepare(`
    SELECT cpu_pct, mem_pct, mem_used_mb, mem_total_mb, vm_total, vm_running,
           ds_total_gb, ds_used_gb, uptime_sec, captured_at
    FROM vsphere_snapshots
    WHERE host_id = ?
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(hostId, Math.min(limit, 2000)).reverse();
}

function start() {
  if (_timer) return;
  // Kick a first poll shortly after boot, then on the interval.
  const first = setTimeout(() => { _pollAll().catch(() => {}); }, 15_000);
  first.unref && first.unref();
  _timer = setInterval(() => { _pollAll().catch(() => {}); }, POLL_MS);
  _timer.unref && _timer.unref();
  log.info('vSphere history poller started', { pollMs: POLL_MS, retentionDays: RETENTION_DAYS });
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, recordSnapshot, getHistory, _internals: { POLL_MS, RETENTION_DAYS } };
