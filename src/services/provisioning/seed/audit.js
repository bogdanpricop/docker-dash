'use strict';

// v8.17.0 (Onboarding — Phase 3) — the ONE hash-chained table (special handling).
//
// `audit_log` is append-only and hash-chained: entry_hash = sha256(prev_hash |
// user_id | username | action | target_type | target_id | details | ip |
// created_at), ordered by `id` (src/services/audit.js). Two consequences:
//
// 1. INSERTION. Synthetic rows are written DIRECTLY (not via auditService.log,
//    which stamps `new Date()` and therefore cannot backdate) but CHAINED WITH
//    THE EXACT SAME PAYLOAD FORMULA: we read the current chain tip, then advance
//    the cursor row by row. `seed_run_id` is NOT part of the payload, so tagging
//    is completely transparent to the chain — `auditService.verify()` stays
//    `valid:true` after seeding. This module therefore runs LAST, so the
//    synthetic block is a contiguous chain TAIL.
//
// 2. USER REFERENCE. `audit_log.user_id REFERENCES users(id)` has no ON DELETE
//    clause, and purge deletes the synthetic users. If the tail-guard below ever
//    skips the audit purge, surviving synthetic audit rows would dangle against
//    deleted users and break `PRAGMA foreign_key_check`. So synthetic rows carry
//    `user_id = NULL` and identify the actor by `username` only — the trail reads
//    identically in the UI and can never leave a dangling reference.
//
// 3. PURGE (see seed/index.js) is TAIL-GUARDED: the batch's audit rows are only
//    deleted while they are still the chain tail. If a real row was appended
//    after seeding, the audit purge is SKIPPED and recorded in the manifest —
//    never break the chain, never touch a real row.

const crypto = require('crypto');

// Realistic demo trail actions. Every name below is a REAL call-site action in
// this codebase (routes/containers.js `container_${action}`, routes/firewall.js
// `firewall_add_rule`/`firewall_delete_rule`, routes/blueprints.js
// `blueprint_apply`/`blueprint_capture`, routes/posture.js `posture_mute`), so
// the Timeline/Audit pages render synthetic activity exactly as they would real
// activity — including action-name filters.
const TRAIL = [
  ['login', 'user', 5],
  ['container_start', 'container', 6],
  ['container_stop', 'container', 4],
  ['container_restart', 'container', 3],
  ['host_create', 'host', 1],
  ['firewall_add_rule', 'firewall', 3],
  ['firewall_delete_rule', 'firewall', 1],
  ['blueprint_apply', 'blueprint', 2],
  ['blueprint_capture', 'blueprint', 2],
  ['posture_mute', 'posture', 1],
  ['image_pull', 'image', 3],
  ['settings_update', 'settings', 1],
];

/** The current chain tip hash (or the genesis hash for an empty log). */
function chainTip(db) {
  const row = db.prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return (row && row.entry_hash) || '0'.repeat(64);
}

/** The EXACT payload formula from src/services/audit.js (do not diverge). */
function entryHash({ prevHash, userId, username, action, targetType, targetId, details, ip, createdAt }) {
  const payload = [
    prevHash, userId || '', username || '', action, targetType || '', targetId || '',
    details || '', ip || '', createdAt,
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function generate(ctx) {
  const { db, rng, datasetId, profile, refs } = ctx;
  if (!profile.auditRows) return { count: 0 };

  const ins = db.prepare(`
    INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip, user_agent, created_at, entry_hash, prev_hash, seed_run_id)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Backdated but strictly increasing timestamps over the last 30 days, so the
  // synthetic block reads as a chronological tail.
  const windowMs = 30 * 864e5;
  const offsets = [];
  for (let i = 0; i < profile.auditRows; i++) offsets.push(rng.int(0, windowMs));
  offsets.sort((a, b) => a - b);

  let prevHash = chainTip(db);
  let count = 0;
  for (const off of offsets) {
    const [action, targetType] = rng.weighted(TRAIL.map(([a, t, w]) => [[a, t], w]));
    const actor = refs.users.length ? rng.pick(refs.users) : { username: 'demo-ops' };
    let targetId = null;
    let details = { synthetic: true };
    if (targetType === 'container' && refs.containers.length) {
      const c = rng.pick(refs.containers);
      targetId = c.containerId.slice(0, 12);
      details = { synthetic: true, name: c.name, hostId: c.hostId };
    } else if ((targetType === 'host' || targetType === 'firewall' || targetType === 'posture') && refs.hosts.length) {
      const h = rng.pick(refs.hosts);
      targetId = String(h.id);
      details = { synthetic: true, host: h.name };
    } else if (targetType === 'image' && refs.containers.length) {
      const c = rng.pick(refs.containers);
      targetId = c.image;
      details = { synthetic: true, image: c.image };
    }

    const createdAt = new Date(ctx.nowMs - windowMs + off).toISOString();
    const ip = rng.rfc1918();                    // RFC 1918 chokepoint
    const detailsStr = JSON.stringify(details);
    const hash = entryHash({
      prevHash, userId: null, username: actor.username, action, targetType,
      targetId, details: detailsStr, ip, createdAt,
    });
    ins.run(actor.username, action, targetType, targetId, detailsStr, ip,
      'DockerDash-Demo/1.0', createdAt, hash, prevHash, datasetId);
    prevHash = hash;
    count += 1;
  }

  ctx.count('audit_log', count);
  return { count };
}

/**
 * Is the batch's audit block still the chain TAIL? (i.e. no non-synthetic row
 * was appended after it). Only then may audit rows be purged.
 */
function isChainTail(db, datasetId) {
  const maxRow = db.prepare('SELECT MAX(id) AS m FROM audit_log WHERE seed_run_id = ?').get(datasetId);
  if (!maxRow || maxRow.m == null) return true;   // nothing seeded → trivially safe
  const after = db.prepare(
    'SELECT COUNT(*) AS c FROM audit_log WHERE id > ? AND (seed_run_id IS NULL OR seed_run_id <> ?)',
  ).get(maxRow.m, datasetId);
  return after.c === 0;
}

module.exports = { generate, isChainTail, chainTip, entryHash, TRAIL };
