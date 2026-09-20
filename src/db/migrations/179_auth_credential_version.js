'use strict';

exports.up = db => db.exec(`
  ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_mfa_tokens_user ON mfa_tokens(user_id);
  CREATE TRIGGER users_auth_challenge_revocation
  AFTER UPDATE OF password_hash, auth_source, is_active, totp_secret, totp_enabled ON users
  WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.auth_source IS NOT NEW.auth_source
    OR OLD.is_active IS NOT NEW.is_active OR OLD.totp_secret IS NOT NEW.totp_secret
    OR OLD.totp_enabled IS NOT NEW.totp_enabled
  BEGIN
    UPDATE users SET auth_version = auth_version + 1 WHERE id = NEW.id;
    DELETE FROM mfa_tokens WHERE user_id = NEW.id;
  END;
  CREATE TRIGGER users_auth_session_revocation
  AFTER UPDATE OF password_hash, auth_source, is_active ON users
  WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.auth_source IS NOT NEW.auth_source
    OR OLD.is_active IS NOT NEW.is_active
  BEGIN
    UPDATE sessions SET is_valid = 0 WHERE user_id = NEW.id;
    UPDATE password_reset_tokens SET used_at = datetime('now')
      WHERE user_id = NEW.id AND used_at IS NULL;
  END;
  DELETE FROM mfa_tokens;
`);

exports.down = db => db.exec(`
  DROP TRIGGER IF EXISTS users_auth_challenge_revocation;
  DROP TRIGGER IF EXISTS users_auth_session_revocation;
  DROP INDEX IF EXISTS idx_mfa_tokens_user;
  ALTER TABLE users DROP COLUMN auth_version;
`);
