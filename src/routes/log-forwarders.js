'use strict';

const { Router } = require('express');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { encrypt, decrypt } = require('../utils/crypto');
const auditService = require('../services/audit');
const logForwarder = require('../services/log-forwarder');
const logSource = require('../services/log-forwarder-source');
const { getDb } = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { isIP } = require('node:net');
const { validateHeaderName, validateHeaderValue } = require('node:http');
const httpUrl = require('../utils/http-url');
const { networkDiagnostic } = require('../utils/notification-diagnostics');

const router = Router();
const types = ['loki', 'elasticsearch', 'http', 'syslog'];
const validName = name => typeof name === 'string' && Boolean(name.trim());

function configError(type, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'Config must be an object';
  if (type === 'syslog') {
    if (typeof config.host !== 'string' || (!isIP(config.host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(config.host))) return 'Enter a valid Syslog host';
    const port = config.port === undefined ? 514 : Number(config.port);
    if (!['string', 'number', 'undefined'].includes(typeof config.port) || !Number.isInteger(port) || port < 1 || port > 65535) return 'Syslog port must be between 1 and 65535';
    if (config.protocol !== undefined && (typeof config.protocol !== 'string' || !['tcp', 'udp'].includes(config.protocol.toLowerCase()))) return 'Syslog protocol must be TCP or UDP';
    return null;
  }
  if (!httpUrl(config.url)) return 'Enter an HTTP or HTTPS destination URL without embedded credentials or a fragment';
  const { headers } = config;
  if (headers !== undefined) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return 'Custom headers must be a JSON object';
    try {
      for (const [name, value] of Object.entries(headers)) {
        if (/^(content-length|transfer-encoding)$/i.test(name) || typeof value !== 'string') return 'Custom headers must contain string values and cannot override message framing';
        validateHeaderName(name);
        validateHeaderValue(name, value);
      }
    } catch { return 'Custom headers contain an invalid name or value'; }
  }
  if (type === 'elasticsearch' && config.index !== undefined && (typeof config.index !== 'string' || !config.index.trim())) return 'Enter an Elasticsearch index name';
  return null;
}

// ─── List forwarders (config values hidden) ─────────────────
router.get('/', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, name, type, enabled, created_by, created_at FROM log_forwarders ORDER BY name ASC').all();
  res.json(rows);
}));

// ─── Get single forwarder (with decrypted config) ───────────
router.get('/:id', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = getDb();
  const row = db.prepare('SELECT * FROM log_forwarders WHERE id = ?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Forwarder not found' });

  let config;
  try { config = JSON.parse(decrypt(row.config_json_encrypted)); }
  catch { return res.status(500).json({ error: 'Forwarder settings could not be decrypted' }); }

  res.json({
    id: row.id,
    name: row.name,
    type: row.type,
    config,
    enabled: row.enabled,
    created_at: row.created_at,
  });
}));

// ─── Create forwarder ───────────────────────────────────────
router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const { name, type, config: fwConfig, enabled } = req.body || {};
  if (!validName(name)) return res.status(400).json({ error: 'Name is required' });
  if (!types.includes(type)) {
    return res.status(400).json({ error: 'Type must be one of: loki, elasticsearch, http, syslog' });
  }
  const error = configError(type, fwConfig);
  if (error) return res.status(400).json({ error });

  const db = getDb();
  const encrypted = encrypt(JSON.stringify(fwConfig));
  const result = db.prepare(`
    INSERT INTO log_forwarders (name, type, config_json_encrypted, enabled, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), type, encrypted, enabled !== false ? 1 : 0, req.user.id);
  logSource.refresh();

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'log_forwarder_create', targetType: 'log_forwarder', targetId: String(result.lastInsertRowid),
    ip: getClientIp(req), details: JSON.stringify({ name: name.trim(), type }),
  });

  res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), type });
}));

// ─── Update forwarder ───────────────────────────────────────
router.put('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT type FROM log_forwarders WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Forwarder not found' });

  const { name, type, config: fwConfig, enabled } = req.body || {};
  const updates = [];
  const params = [];

  if (name !== undefined) {
    if (!validName(name)) return res.status(400).json({ error: 'Name is required' });
    updates.push('name = ?'); params.push(name.trim());
  }
  if (type !== undefined) {
    if (!types.includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    updates.push('type = ?'); params.push(type);
  }
  if (fwConfig !== undefined || (type !== undefined && type !== existing.type)) {
    const error = configError(type ?? existing.type, fwConfig);
    if (error) return res.status(400).json({ error });
  }
  if (fwConfig !== undefined) {
    updates.push('config_json_encrypted = ?');
    params.push(encrypt(JSON.stringify(fwConfig)));
  }
  if (enabled !== undefined) {
    updates.push('enabled = ?'); params.push(enabled ? 1 : 0);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(id);
  db.prepare(`UPDATE log_forwarders SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (enabled !== undefined || type !== undefined || fwConfig !== undefined) logForwarder.discardBuffer(id);
  logSource.refresh();

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'log_forwarder_update', targetType: 'log_forwarder', targetId: String(id),
    ip: getClientIp(req),
  });

  res.json({ ok: true });
}));

// ─── Delete forwarder ───────────────────────────────────────
router.delete('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT name FROM log_forwarders WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Forwarder not found' });

  db.prepare('DELETE FROM log_forwarders WHERE id = ?').run(id);
  logForwarder.discardBuffer(id);
  logSource.refresh();

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'log_forwarder_delete', targetType: 'log_forwarder', targetId: String(id),
    ip: getClientIp(req), details: JSON.stringify({ name: row.name }),
  });

  res.json({ ok: true });
}));

// ─── Test forwarder ─────────────────────────────────────────
router.post('/:id/test', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const db = getDb();
  const row = db.prepare('SELECT * FROM log_forwarders WHERE id = ?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Forwarder not found' });

  try { res.json(await logForwarder.testForwarder(row)); }
  catch (err) {
    const details = err.details || networkDiagnostic(err);
    res.status(502).json({ error: details.reason || 'Forwarder test failed', details });
  }
}));

module.exports = router;
