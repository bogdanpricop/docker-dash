'use strict';

exports.up = function (db) {
  // Add password_changed_at to users for password rotation policy
  try {
    db.exec(`ALTER TABLE users ADD COLUMN password_changed_at TEXT`);
  } catch { /* column may exist */ }

  // Backfill: set password_changed_at to updated_at for existing users
  try {
    db.exec(`UPDATE users SET password_changed_at = updated_at WHERE password_changed_at IS NULL`);
  } catch {}
};
