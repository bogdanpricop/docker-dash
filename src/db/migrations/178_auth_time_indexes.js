'use strict';

// Numeric time predicates cannot use the old textual timestamp ranges. Keep
// lockout and security-alert windows indexed as authentication histories grow.
exports.up = db => db.exec(`
  CREATE INDEX idx_login_failed_ip_instant ON login_attempts(ip,julianday(attempted_at)) WHERE success=0;
  CREATE INDEX idx_login_failed_instant ON login_attempts(julianday(attempted_at)) WHERE success=0;
  CREATE INDEX idx_audit_action_instant ON audit_log(action,julianday(created_at));
`);
exports.down = db => db.exec(`
  DROP INDEX IF EXISTS idx_login_failed_ip_instant;
  DROP INDEX IF EXISTS idx_login_failed_instant;
  DROP INDEX IF EXISTS idx_audit_action_instant;
`);
