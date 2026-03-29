'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const dockerService = require('../services/docker');
const settingsService = require('../services/settings');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');

const router = Router();

// ─── Public Status Page (no auth) ──────────────────────

router.get('/public', async (req, res) => {
  try {
    const db = getDb();
    const enabled = settingsService.get('status_page_enabled') === 'true';
    if (!enabled) return res.status(404).json({ error: 'Status page is not enabled' });

    const title = settingsService.get('status_page_title') || 'Service Status';
    const items = db.prepare('SELECT * FROM status_page_items ORDER BY sort_order ASC').all();

    if (items.length === 0) return res.json({ title, services: [], overall: 'unknown' });

    // Get running containers
    let containers = [];
    try { containers = await dockerService.listContainers(0); } catch { /* Docker may be unreachable; show services as unknown */ }

    const services = items.map(item => {
      const container = containers.find(c => {
        const name = (c.Names || c.names || [])[0]?.replace(/^\//, '') || '';
        return name === item.container_name;
      });

      const state = container?.State || container?.state || 'not_found';
      let status = 'unknown';
      if (state === 'running') status = 'operational';
      else if (state === 'exited' || state === 'stopped') status = 'down';
      else if (state === 'restarting') status = 'degraded';
      else if (state === 'paused') status = 'maintenance';

      return {
        name: item.display_name || item.container_name,
        status,
        show_uptime: !!item.show_uptime,
      };
    });

    const downCount = services.filter(s => s.status === 'down').length;
    const degradedCount = services.filter(s => s.status === 'degraded').length;
    const overall = downCount > 0 ? 'major_outage' : degradedCount > 0 ? 'degraded' : 'operational';

    res.json({ title, services, overall, checked_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Status page error' });
  }
});

// ─── Status Page Admin (authenticated) ─────────────────

router.get('/config', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDb();
  const items = db.prepare('SELECT * FROM status_page_items ORDER BY sort_order ASC').all();
  const enabled = settingsService.get('status_page_enabled') === 'true';
  const title = settingsService.get('status_page_title') || 'Service Status';
  res.json({ enabled, title, items });
});

router.put('/config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  const { enabled, title } = req.body;
  if (enabled !== undefined) settingsService.set('status_page_enabled', String(enabled));
  if (title !== undefined) settingsService.set('status_page_title', title);
  res.json({ ok: true });
});

router.post('/items', requireAuth, requireRole('admin'), writeable, (req, res) => {
  const db = getDb();
  const { container_name, display_name, sort_order } = req.body;
  if (!container_name) return res.status(400).json({ error: 'container_name required' });
  const r = db.prepare(
    'INSERT INTO status_page_items (container_name, display_name, sort_order) VALUES (?, ?, ?)'
  ).run(container_name, display_name || container_name, sort_order || 0);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.delete('/items/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  getDb().prepare('DELETE FROM status_page_items WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
