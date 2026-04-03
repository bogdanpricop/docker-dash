'use strict';

const { Router } = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { encrypt, decrypt } = require('../utils/crypto');
const auditService = require('../services/audit');
const logForwarder = require('../services/log-forwarder');
const { getDb } = require('../db');

const router = Router();

// ─── List forwarders (config values hidden) ─────────────────
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, name, type, enabled, created_by, created_at FROM log_forwarders ORDER BY name ASC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single forwarder (with decrypted config) ───────────
router.get('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM log_forwarders WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Forwarder not found' });

    let config;
    try { config = JSON.parse(decrypt(row.config_json_encrypted)); }
    catch { config = {}; }

    res.json({
      id: row.id,
      name: row.name,
      type: row.type,
      config,
      enabled: row.enabled,
      created_at: row.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create forwarder ───────────────────────────────────────
router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { name, type, config: fwConfig, enabled } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!['loki', 'elasticsearch', 'http', 'syslog'].includes(type)) {
      return res.status(400).json({ error: 'Type must be one of: loki, elasticsearch, http, syslog' });
    }
    if (!fwConfig || typeof fwConfig !== 'object') {
      return res.status(400).json({ error: 'Config object is required' });
    }

    // Validate type-specific required fields
    if ((type === 'loki' || type === 'elasticsearch' || type === 'http') && !fwConfig.url) {
      return res.status(400).json({ error: 'URL is required for this forwarder type' });
    }
    if (type === 'syslog' && !fwConfig.host) {
      return res.status(400).json({ error: 'Host is required for syslog forwarder' });
    }

    const db = getDb();
    const encrypted = encrypt(JSON.stringify(fwConfig));
    const result = db.prepare(`
      INSERT INTO log_forwarders (name, type, config_json_encrypted, enabled, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), type, encrypted, enabled !== false ? 1 : 0, req.user.id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'log_forwarder_create', targetType: 'log_forwarder', targetId: String(result.lastInsertRowid),
      ip: getClientIp(req), details: JSON.stringify({ name: name.trim(), type }),
    });

    res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update forwarder ───────────────────────────────────────
router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const existing = db.prepare('SELECT id FROM log_forwarders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Forwarder not found' });

    const { name, type, config: fwConfig, enabled } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (type !== undefined) {
      if (!['loki', 'elasticsearch', 'http', 'syslog'].includes(type)) {
        return res.status(400).json({ error: 'Invalid type' });
      }
      updates.push('type = ?'); params.push(type);
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

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'log_forwarder_update', targetType: 'log_forwarder', targetId: String(id),
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete forwarder ───────────────────────────────────────
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const row = db.prepare('SELECT name FROM log_forwarders WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Forwarder not found' });

    db.prepare('DELETE FROM log_forwarders WHERE id = ?').run(id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'log_forwarder_delete', targetType: 'log_forwarder', targetId: String(id),
      ip: getClientIp(req), details: JSON.stringify({ name: row.name }),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test forwarder ─────────────────────────────────────────
router.post('/:id/test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM log_forwarders WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Forwarder not found' });

    const result = await logForwarder.testForwarder(row);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
