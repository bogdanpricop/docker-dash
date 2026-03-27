'use strict';

const { getDb } = require('../db');
const { now } = require('../utils/helpers');

class SettingsService {
  get(key, fallback = null) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  getAll() {
    return getDb().prepare('SELECT * FROM settings ORDER BY key').all()
      .reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  }

  set(key, value, userId = null) {
    getDb().prepare(`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?, updated_by = ?
    `).run(key, value, now(), userId, value, now(), userId);
  }

  setBulk(entries, userId = null) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?, updated_by = ?
    `);
    db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        const ts = now();
        stmt.run(key, String(value), ts, userId, String(value), ts, userId);
      }
    })();
  }

  delete(key) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

module.exports = new SettingsService();
