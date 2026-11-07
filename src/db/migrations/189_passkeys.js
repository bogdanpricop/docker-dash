'use strict';

exports.up = db => db.exec(`
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    user_handle TEXT NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
  );
  CREATE INDEX idx_passkeys_user ON passkeys(user_id);
  CREATE TRIGGER users_passkey_revocation
  AFTER UPDATE OF password_hash, auth_source, is_active, external_source, external_issuer, external_subject ON users
  WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.auth_source IS NOT NEW.auth_source
    OR OLD.is_active IS NOT NEW.is_active OR OLD.external_source IS NOT NEW.external_source
    OR OLD.external_issuer IS NOT NEW.external_issuer OR OLD.external_subject IS NOT NEW.external_subject
  BEGIN
    DELETE FROM passkeys WHERE user_id = NEW.id;
  END;
  CREATE TABLE passkey_challenges (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('login', 'register')),
    binding TEXT NOT NULL,
    challenge TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    auth_version INTEGER,
    name TEXT,
    user_handle TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_passkey_challenges_expiry ON passkey_challenges(expires_at);
`);
