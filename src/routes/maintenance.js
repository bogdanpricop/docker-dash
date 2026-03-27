'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { now } = require('../utils/helpers');

const router = Router();

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM maintenance_windows ORDER BY name').all().map(r => ({
    ...r,
    target_names: JSON.parse(r.target_names || '[]'),
    actions: JSON.parse(r.actions || '[]'),
    notify_channels: JSON.parse(r.notify_channels || '[]'),
  })));
});

router.post('/', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, cron_expression, target_type, target_names, actions, block_on_critical, notify_channels } = req.body;
    if (!name || !cron_expression) return res.status(400).json({ error: 'name and cron_expression required' });

    const db = getDb();
    const r = db.prepare(`
      INSERT INTO maintenance_windows (name, cron_expression, target_type, target_names, actions,
        block_on_critical, notify_channels, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, cron_expression, target_type || 'all',
      JSON.stringify(target_names || []),
      JSON.stringify(actions || ['pull', 'scan', 'update']),
      block_on_critical !== false ? 1 : 0,
      JSON.stringify(notify_channels || []),
      req.user.id
    );
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    const sets = [];
    const params = [];
    const allowed = ['name', 'cron_expression', 'target_type', 'is_active', 'block_on_critical'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(['is_active', 'block_on_critical'].includes(key) ? (req.body[key] ? 1 : 0) : req.body[key]);
      }
    }
    if (req.body.target_names !== undefined) { sets.push('target_names = ?'); params.push(JSON.stringify(req.body.target_names)); }
    if (req.body.actions !== undefined) { sets.push('actions = ?'); params.push(JSON.stringify(req.body.actions)); }
    if (req.body.notify_channels !== undefined) { sets.push('notify_channels = ?'); params.push(JSON.stringify(req.body.notify_channels)); }

    if (sets.length === 0) return res.json({ ok: true });
    sets.push('updated_at = ?');
    params.push(now());
    params.push(parseInt(req.params.id));
    db.prepare(`UPDATE maintenance_windows SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  getDb().prepare('DELETE FROM maintenance_windows WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
