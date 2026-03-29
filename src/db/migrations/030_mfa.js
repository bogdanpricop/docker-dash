'use strict';

exports.up = function (db) {
  // Add TOTP/MFA columns to users
  try {
    db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`);       // AES-256-GCM encrypted
  } catch { /* column may exist */ }

  try {
    db.exec(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column may exist */ }

  try {
    db.exec(`ALTER TABLE users ADD COLUMN recovery_codes TEXT`);     // AES-256-GCM encrypted JSON array
  } catch { /* column may exist */ }

  try {
    db.exec(`ALTER TABLE users ADD COLUMN mfa_enrolled_at TEXT`);
  } catch { /* column may exist */ }

  // Temporary MFA tokens table (for the two-step login flow)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mfa_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);

  try {
    db.exec(`CREATE INDEX idx_mfa_token ON mfa_tokens(token_hash)`);
  } catch { /* index may exist */ }
};
