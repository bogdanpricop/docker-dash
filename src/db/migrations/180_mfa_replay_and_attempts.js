'use strict';
exports.up = db => db.exec(`
  ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;
  ALTER TABLE users ADD COLUMN mfa_failed_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN mfa_locked_until TEXT;
  ALTER TABLE mfa_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  -- Pre-upgrade successes were not recorded. Exclude the entire old acceptance
  -- window; existing enrollments may need to wait up to 60 seconds after upgrade.
  UPDATE users SET totp_last_counter = CAST(strftime('%s','now') AS INTEGER) / 30 + 1
    WHERE totp_enabled = 1;
  CREATE TRIGGER users_totp_reenrollment
  AFTER UPDATE OF totp_secret ON users WHEN OLD.totp_secret IS NOT NEW.totp_secret
  BEGIN
    UPDATE users SET totp_last_counter=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=NEW.id;
  END;
`);
exports.down = db => db.exec(`
  DROP TRIGGER IF EXISTS users_totp_reenrollment;
  ALTER TABLE users DROP COLUMN totp_last_counter;
  ALTER TABLE users DROP COLUMN mfa_failed_attempts;
  ALTER TABLE users DROP COLUMN mfa_locked_until;
  ALTER TABLE mfa_tokens DROP COLUMN attempts;
`);
