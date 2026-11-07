'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireHostAccess } = require('../middleware/hostAccess');
const { getEffectiveRole, hasPermission } = require('../services/permissions');
const { tryParseJson } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
const stackLabel = 'com.docker.compose.project';
const sqliteTime = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const utc = value => value?.includes('T') ? value : value?.replace(' ', 'T') + 'Z';

router.get('/', requireAuth, requireHostAccess(), asyncHandler((req, res) => {
  const { source, stack, container, kind, since } = req.query;
  if ([source, stack, container, kind, since].some(value => value !== undefined && (typeof value !== 'string' || value.length > 200))) {
    return res.status(400).json({ error: 'Invalid activity filters' });
  }
  const admin = req.user.role === 'admin';
  if (source === 'audit' && !admin) return res.status(403).json({ error: 'Audit access requires an administrator' });
  const start = since ? Date.parse(since) : Date.now() - 24 * 3600000;
  if (!Number.isFinite(start)) return res.status(400).json({ error: 'Invalid activity start time' });
  const hostId = req.resolvedHostId ?? req.hostId;
  const db = getDb();
  const limit = 250;
  const items = [];
  if (source !== 'audit') {
    const attrs = "CASE WHEN json_valid(attributes) THEN attributes ELSE '{}' END";
    const project = `COALESCE(json_extract(${attrs}, '$."${stackLabel}"'), '_standalone')`;
    const conditions = ['host_id = ?', 'event_time >= ?', 'julianday(event_time) >= julianday(?)'];
    const args = [hostId, sqliteTime(start).slice(0, 10), sqliteTime(start)];
    if (stack) { conditions.push(project + ' = ?'); args.push(stack); }
    if (container) { conditions.push('(actor_id LIKE ? OR actor_name = ?)'); args.push(container.replace(/[\%_]/g, '') + '%', container); }
    if (kind) { conditions.push('(event_type = ? OR action = ?)'); args.push(kind, kind); }
    const rows = db.prepare(`SELECT id, event_type, action, actor_id, actor_name, event_time, ${project} AS stack
      FROM docker_events WHERE ${conditions.join(' AND ')} ORDER BY event_time DESC, id DESC LIMIT ?`).all(...args, limit);
    const grants = new Map();
    for (const row of rows) {
      if (!admin) {
        if (!grants.has(row.stack)) grants.set(row.stack, hasPermission(getEffectiveRole(req.user.id, row.stack, req.user.role), 'view'));
        if (!grants.get(row.stack)) continue;
      }
      items.push({
        id: 'docker-' + row.id, source: 'docker', kind: row.event_type, action: row.action,
        stack: row.stack, resource: row.actor_name, containerId: row.event_type === 'container' ? row.actor_id : null, time: utc(row.event_time),
      });
    }
  }
  if (admin && source !== 'docker') {
    const json = "CASE WHEN json_valid(details) THEN details ELSE '{}' END";
    const conditions = ["CAST(json_extract(" + json + ", '$.hostId') AS INTEGER) = ?", 'created_at >= ?', 'julianday(created_at) >= julianday(?)'];
    const args = [hostId, sqliteTime(start).slice(0, 10), sqliteTime(start)];
    if (stack) { conditions.push(`(json_extract(${json}, '$.stack') = ? OR (target_type = 'stack' AND target_id = ?))`); args.push(stack, stack); }
    if (container) { conditions.push("target_type = 'container' AND target_id LIKE ?"); args.push(container.replace(/[\%_]/g, '') + '%'); }
    if (kind) { conditions.push('(target_type = ? OR action = ?)'); args.push(kind, kind); }
    const rows = db.prepare(`SELECT id, username, action, target_type, target_id, created_at, details
      FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit);
    for (const row of rows) {
      const details = tryParseJson(row.details);
      items.push({
        id: 'audit-' + row.id, source: 'audit', kind: row.target_type, action: row.action,
        stack: row.target_type === 'stack' ? row.target_id : details?.stack,
        resource: row.target_id, actor: row.username, containerId: row.target_type === 'container' ? row.target_id : null, time: utc(row.created_at),
      });
    }
  }
  items.sort((a, b) => b.time.localeCompare(a.time));
  res.json({ host: { id: hostId, name: req.hostName }, items: items.slice(0, limit), limit });
}));

module.exports = router;
