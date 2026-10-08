'use strict';
exports.up = db => db.exec(`
  CREATE TRIGGER users_api_key_credential_revocation
  AFTER UPDATE OF password_hash,auth_source,is_active,external_source,external_issuer,external_subject ON users
  WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.auth_source IS NOT NEW.auth_source
    OR OLD.is_active IS NOT NEW.is_active OR OLD.external_source IS NOT NEW.external_source
    OR OLD.external_issuer IS NOT NEW.external_issuer OR OLD.external_subject IS NOT NEW.external_subject
  BEGIN
    UPDATE api_keys SET is_active=0 WHERE user_id=NEW.id;
  END;
  UPDATE api_keys SET is_active=0 WHERE user_id IN
    (SELECT id FROM users WHERE is_active=0 OR auth_source='sso_legacy');
`);
exports.down = db => db.exec('DROP TRIGGER IF EXISTS users_api_key_credential_revocation');
