'use strict';

// Keep the settings shape readable; only the service-account secret is encrypted.
exports.up = function (db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ldap_config'").get();
  if (!row) return;
  let cfg;
  try { cfg = JSON.parse(row.value); } catch { return; } // Invalid config was already ignored by the LDAP service.
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'bindPassword')) return;
  if (cfg.bindPassword && !cfg.bindPasswordEncrypted) {
    cfg.bindPasswordEncrypted = require('../../utils/crypto').encrypt(cfg.bindPassword);
  }
  delete cfg.bindPassword;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'ldap_config'").run(JSON.stringify(cfg));
};

exports.down = function () {
  throw new Error('LDAP credential encryption cannot be rolled back to plaintext');
};
