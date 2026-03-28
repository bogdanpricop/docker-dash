'use strict';

const { getDb } = require('../db');
const { generateToken, sha256 } = require('../utils/crypto');
const { now } = require('../utils/helpers');

// ─── Favorites ──────────────────────────────────────────────

const favorites = {
  list(userId) {
    return getDb().prepare('SELECT container_id FROM user_favorites WHERE user_id = ?').all(userId)
      .map(r => r.container_id);
  },
  add(userId, containerId) {
    getDb().prepare('INSERT OR IGNORE INTO user_favorites (user_id, container_id) VALUES (?, ?)')
      .run(userId, containerId);
  },
  remove(userId, containerId) {
    getDb().prepare('DELETE FROM user_favorites WHERE user_id = ? AND container_id = ?')
      .run(userId, containerId);
  },
};

// ─── Notifications ──────────────────────────────────────────

const notifications = {
  list(userId, { unreadOnly = false, limit = 50, page = 1, type } = {}) {
    const conditions = ['(user_id = ? OR user_id IS NULL)'];
    const params = [userId];
    if (unreadOnly) conditions.push('is_read = 0');
    if (type) { conditions.push('type = ?'); params.push(type); }
    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;
    const countRow = getDb().prepare(`SELECT COUNT(*) as total FROM notifications WHERE ${where}`).get(...params);
    params.push(limit, offset);
    const items = getDb().prepare(`
      SELECT * FROM notifications WHERE ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params);
    return { items, total: countRow.total, page, limit };
  },
  create({ userId, type, title, message, link }) {
    getDb().prepare('INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)')
      .run(userId || null, type || 'info', title, message || null, link || null);
  },
  markRead(id, userId) {
    getDb().prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND (user_id = ? OR user_id IS NULL)')
      .run(id, userId);
  },
  markAllRead(userId) {
    getDb().prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? OR user_id IS NULL').run(userId);
  },
  unreadCount(userId) {
    return getDb().prepare('SELECT COUNT(*) as c FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND is_read = 0')
      .get(userId).c;
  },
  delete(id, userId) {
    getDb().prepare('DELETE FROM notifications WHERE id = ? AND (user_id = ? OR user_id IS NULL)')
      .run(id, userId);
  },
  bulkAction(ids, userId, action) {
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    if (action === 'read') {
      db.prepare(`UPDATE notifications SET is_read = 1 WHERE id IN (${placeholders}) AND (user_id = ? OR user_id IS NULL)`)
        .run(...ids, userId);
    } else if (action === 'delete') {
      db.prepare(`DELETE FROM notifications WHERE id IN (${placeholders}) AND (user_id = ? OR user_id IS NULL)`)
        .run(...ids, userId);
    }
  },
};

// ─── API Keys ───────────────────────────────────────────────

const apiKeys = {
  list(userId) {
    return getDb().prepare(`
      SELECT id, user_id, name, key_prefix, permissions, is_active, expires_at, last_used_at, created_at
      FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId);
  },
  create(userId, { name, permissions, expiresAt }) {
    const token = 'dd_' + generateToken(24);
    const prefix = token.substring(0, 10);
    const hash = sha256(token);
    getDb().prepare(`
      INSERT INTO api_keys (user_id, name, key_prefix, key_hash, permissions, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, name, prefix, hash, JSON.stringify(permissions || ['read']), expiresAt || null);
    return { key: token, prefix };
  },
  validate(token) {
    if (!token) return null;
    const hash = sha256(token);
    const key = getDb().prepare(`
      SELECT ak.*, u.username, u.role, u.is_active as user_active
      FROM api_keys ak JOIN users u ON ak.user_id = u.id
      WHERE ak.key_hash = ? AND ak.is_active = 1
    `).get(hash);
    if (!key || !key.user_active) return null;
    if (key.expires_at && new Date(key.expires_at) < new Date()) return null;
    getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), key.id);
    return { id: key.user_id, username: key.username, role: key.role, apiKey: true, permissions: JSON.parse(key.permissions || '["read"]') };
  },
  revoke(id, userId) {
    getDb().prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?').run(id, userId);
  },
};

// ─── Docker Events ──────────────────────────────────────────

const dockerEvents = {
  store({ hostId = 0, eventType, action, actorId, actorName, attributes, eventTime }) {
    getDb().prepare(`
      INSERT INTO docker_events (host_id, event_type, action, actor_id, actor_name, attributes, event_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hostId, eventType, action, actorId, actorName, 
      typeof attributes === 'object' ? JSON.stringify(attributes) : attributes, eventTime || now());
  },
  query({ type, action, since, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (type) { where.push('event_type = ?'); params.push(type); }
    if (action) { where.push('action = ?'); params.push(action); }
    if (since) { where.push('event_time >= ?'); params.push(since); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return getDb().prepare(`SELECT * FROM docker_events ${w} ORDER BY event_time DESC LIMIT ?`).all(...params, limit);
  },
  cleanup(days = 7) {
    getDb().prepare(`DELETE FROM docker_events WHERE event_time < datetime('now', '-' || ? || ' days')`).run(days);
  },
};

module.exports = { favorites, notifications, apiKeys, dockerEvents };
