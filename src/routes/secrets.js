'use strict';

const { Router } = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { encrypt, decrypt } = require('../utils/crypto');
const auditService = require('../services/audit');
const { getDb } = require('../db');

const router = Router();

// ─── List secrets (names + descriptions only, no values) ────
router.get('/', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    const db = getDb();
    const secrets = db.prepare(`
      SELECT id, name, description, created_by, created_at, updated_at
      FROM secrets_vault ORDER BY name ASC
    `).all();
    res.json(secrets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single secret with decrypted value (admin only) ────
router.get('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const secret = db.prepare('SELECT * FROM secrets_vault WHERE id = ?').get(parseInt(req.params.id));
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    let value;
    try {
      value = decrypt(secret.value_encrypted);
    } catch {
      return res.status(500).json({ error: 'Failed to decrypt secret — encryption key may have changed' });
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_read', targetType: 'secret', targetId: String(secret.id),
      ip: getClientIp(req), details: JSON.stringify({ name: secret.name }),
    });

    res.json({
      id: secret.id,
      name: secret.name,
      value,
      description: secret.description,
      created_at: secret.created_at,
      updated_at: secret.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create secret ──────────────────────────────────────────
router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { name, value, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!value) return res.status(400).json({ error: 'Value is required' });

    // Validate name format (alphanumeric, dashes, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
      return res.status(400).json({ error: 'Name must contain only letters, numbers, dashes, and underscores' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM secrets_vault WHERE name = ?').get(name.trim());
    if (existing) return res.status(409).json({ error: 'A secret with this name already exists' });

    const encrypted = encrypt(value);
    const result = db.prepare(`
      INSERT INTO secrets_vault (name, value_encrypted, description, created_by)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), encrypted, description || '', req.user.id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_create', targetType: 'secret', targetId: String(result.lastInsertRowid),
      ip: getClientIp(req), details: JSON.stringify({ name: name.trim() }),
    });

    res.status(201).json({ id: result.lastInsertRowid, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update secret ──────────────────────────────────────────
router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const existing = db.prepare('SELECT id FROM secrets_vault WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Secret not found' });

    const { name, value, description } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
        return res.status(400).json({ error: 'Name must contain only letters, numbers, dashes, and underscores' });
      }
      const dup = db.prepare('SELECT id FROM secrets_vault WHERE name = ? AND id != ?').get(name.trim(), id);
      if (dup) return res.status(409).json({ error: 'A secret with this name already exists' });
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (value !== undefined) {
      updates.push('value_encrypted = ?');
      params.push(encrypt(value));
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE secrets_vault SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_update', targetType: 'secret', targetId: String(id),
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete secret ──────────────────────────────────────────
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const secret = db.prepare('SELECT name FROM secrets_vault WHERE id = ?').get(id);
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    db.prepare('DELETE FROM secrets_vault WHERE id = ?').run(id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_delete', targetType: 'secret', targetId: String(id),
      ip: getClientIp(req), details: JSON.stringify({ name: secret.name }),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
