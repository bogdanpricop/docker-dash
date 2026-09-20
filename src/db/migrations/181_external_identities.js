'use strict';

exports.up = db => db.exec(`
  ALTER TABLE users ADD COLUMN external_source TEXT CHECK(external_source IN ('oidc','proxy'));
  ALTER TABLE users ADD COLUMN external_issuer TEXT COLLATE BINARY;
  ALTER TABLE users ADD COLUMN external_subject TEXT COLLATE BINARY;
  CREATE UNIQUE INDEX idx_users_external_identity ON users(external_source,external_issuer,external_subject);
  CREATE TRIGGER users_external_identity_revocation
  AFTER UPDATE OF external_source,external_issuer,external_subject ON users
  WHEN OLD.external_source IS NOT NEW.external_source OR OLD.external_issuer IS NOT NEW.external_issuer
    OR OLD.external_subject IS NOT NEW.external_subject
  BEGIN
    UPDATE users SET auth_version=auth_version+1 WHERE id=NEW.id;
    DELETE FROM mfa_tokens WHERE user_id=NEW.id;
    UPDATE sessions SET is_valid=0 WHERE user_id=NEW.id;
    UPDATE password_reset_tokens SET used_at=datetime('now') WHERE user_id=NEW.id AND used_at IS NULL;
  END;
  -- Historical records have no trustworthy issuer/subject to backfill. Keep
  -- their data and permissions, but revoke old credentials instead of guessing.
  UPDATE users SET auth_source='sso_legacy' WHERE password_hash='SSO_NO_PASSWORD' AND auth_source='local';
`);

exports.down = db => db.exec(`
  DROP TRIGGER IF EXISTS users_external_identity_revocation;
  DROP INDEX IF EXISTS idx_users_external_identity;
  ALTER TABLE users DROP COLUMN external_subject;
  ALTER TABLE users DROP COLUMN external_issuer;
  ALTER TABLE users DROP COLUMN external_source;
`);
