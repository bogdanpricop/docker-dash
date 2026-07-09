'use strict';

// v8.9.31-alpha.1 — proactive firewall drift monitor. Periodically checks every
// host that has app-managed rules and, if any have drifted off the host (removed
// manually or lost on a daemon/container restart), raises an in-app notification
// + audit entry. De-duplicated: it only alerts when the drift set CHANGES, so a
// persistent drift doesn't spam. Unreachable hosts are skipped silently.

function _db() { return require('../../db').getDb(); }

// hostId -> serialized drift set last alerted on ('' = no drift).
const _lastDriftKey = new Map();

async function checkAllHosts() {
  const svc = require('./index');
  const { notifications } = require('../misc');
  const auditService = require('../audit');
  let hostIds = [];
  try {
    hostIds = _db().prepare('SELECT DISTINCT host_id FROM firewall_rules WHERE is_active = 1').all().map((r) => r.host_id);
  } catch { return { checked: 0, alerted: 0 }; }

  let alerted = 0;
  for (const hostId of hostIds) {
    let info;
    try { info = await svc.listRules(hostId); } catch { continue; } // host down → retry next cycle
    const drift = (info.drift || []).slice().sort();
    const key = drift.join(',');
    const prev = _lastDriftKey.get(hostId) || '';
    if (drift.length && key !== prev) {
      let name = `host ${hostId}`;
      try { const row = _db().prepare('SELECT name FROM docker_hosts WHERE id = ?').get(hostId); if (row) name = row.name; } catch { /* ignore */ }
      notifications.create({
        userId: null, type: 'warning',
        title: `Firewall drift on ${name}`,
        message: `${drift.length} app-managed firewall rule(s) are missing on the host (removed manually or lost on a restart). Open Firewall to re-apply.`,
        link: '#/firewall',
      });
      auditService.log({ action: 'firewall_drift_detected', targetType: 'firewall', targetId: String(hostId), details: { count: drift.length, uuids: drift }, username: 'system' });
      alerted++;
    }
    _lastDriftKey.set(hostId, key);
  }
  return { checked: hostIds.length, alerted };
}

function start(intervalMs = 10 * 60 * 1000) {
  const t = setInterval(() => { checkAllHosts().catch(() => {}); }, intervalMs);
  t.unref();
  return t;
}

module.exports = { checkAllHosts, start, _internals: { _lastDriftKey } };
