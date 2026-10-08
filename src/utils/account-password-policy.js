'use strict';
const config = require('../config');
// SQLite julianday treats historical unqualified timestamps as UTC.
function mustChangePassword(user) {
  if (user.must_change_password) return true;
  const days = config.security.passwordMaxAgeDays;
  if (!(days > 0) || user.auth_source !== 'local') return false;
  const instant = user.passwordChangedAtMs;
  if (!Number.isFinite(instant)) return true;
  const age = Date.now() - instant;
  return age < -60000 || age >= days * 86400000;
}
module.exports = { mustChangePassword };
