'use strict';

const { getDb } = require('../db');

function prefix(hostId) {
  return `stack-secondary:${hostId}:`;
}

function listSecondaryStacks(userId, hostId) {
  const start = prefix(hostId);
  return getDb().prepare(`
    SELECT pref_key FROM user_preferences
    WHERE user_id = ? AND pref_key LIKE ? AND pref_value = '1'
    ORDER BY pref_key
  `).all(userId, start + '%').map(row => row.pref_key.slice(start.length));
}

function setSecondaryStack(userId, hostId, name, secondary) {
  const db = getDb();
  const key = prefix(hostId) + name;
  if (secondary) {
    db.prepare(`
      INSERT INTO user_preferences (user_id, pref_key, pref_value)
      VALUES (?, ?, '1')
      ON CONFLICT(user_id, pref_key) DO UPDATE SET pref_value = '1', updated_at = datetime('now')
    `).run(userId, key);
  } else {
    db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND pref_key = ?').run(userId, key);
  }
}

module.exports = { listSecondaryStacks, setSecondaryStack };
