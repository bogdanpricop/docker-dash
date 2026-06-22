'use strict';

// v8.2.x further-split: extracted from src/routes/misc.js.
// 6 routes for /notifications/* — list, count, mark-read, read-all, delete, bulk.
// Mounted at /notifications.

const { Router } = require('express');
const { notifications } = require('../services/misc');
const { requireAuth } = require('../middleware/auth');
const log = require('../utils/logger')('misc');

const router = Router();

router.get('/', requireAuth, (req, res) => {
  // v8.7.33 — cap user-supplied limit at 200. Notifications are user-scoped
  // but still SQL-bounded; UI typically shows 20-50. 200 is generous.
  const { unreadOnly, page, limit, type } = req.query;
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  res.json(notifications.list(req.user.id, {
    unreadOnly: unreadOnly === 'true',
    page: parseInt(page) || 1,
    limit: safeLimit,
    type: type || undefined,
  }));
});

router.get('/count', requireAuth, (req, res) => {
  res.json({ count: notifications.unreadCount(req.user.id) });
});

router.post('/:id/read', requireAuth, (req, res) => {
  try { notifications.markRead(parseInt(req.params.id), req.user.id); res.json({ ok: true }); }
  catch (err) { log.error('notifications markRead', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/read-all', requireAuth, (req, res) => {
  try { notifications.markAllRead(req.user.id); res.json({ ok: true }); }
  catch (err) { log.error('notifications markAllRead', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/:id', requireAuth, (req, res) => {
  try { notifications.delete(parseInt(req.params.id), req.user.id); res.json({ ok: true }); }
  catch (err) { log.error('notifications delete', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/bulk', requireAuth, (req, res) => {
  try {
    const { ids, action } = req.body;
    if (!ids || !Array.isArray(ids) || !['read', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'ids (array) and action (read|delete) required' });
    }
    // v8.7.39 — cap bulk array. SQLite IN (...) builds a placeholder list
    // of length N; pre-fix a caller could submit 100k ids and pin the
    // writer. 1000 is generous for any realistic notification batch UI.
    if (ids.length > 1000) {
      return res.status(413).json({ error: 'ids array exceeds max of 1000; split into multiple calls' });
    }
    notifications.bulkAction(ids.map(id => parseInt(id)), req.user.id, action);
    res.json({ ok: true });
  } catch (err) { log.error('notifications bulkAction', err); res.status(500).json({ error: 'Internal server error' }); }
});


module.exports = router;
