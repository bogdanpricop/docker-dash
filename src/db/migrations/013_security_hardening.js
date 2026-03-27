'use strict';

exports.up = function (db) {
  // Add must_change_password flag to users
  try {
    db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column may exist */ }

  // Mark the default admin user as requiring password change
  // (if password has never been changed — still using the seed password)
  try {
    db.exec(`UPDATE users SET must_change_password = 1 WHERE username = 'admin' AND updated_at = created_at`);
  } catch {}

  // Insert setup_completed setting if not exists
  try {
    db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('setup_completed', 'false')`);
  } catch {}
};
