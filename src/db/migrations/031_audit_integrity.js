'use strict';

exports.up = function (db) {
  // Add hash chain columns to audit_log
  try {
    db.exec(`ALTER TABLE audit_log ADD COLUMN entry_hash TEXT`);
  } catch { /* column may exist */ }

  try {
    db.exec(`ALTER TABLE audit_log ADD COLUMN prev_hash TEXT`);
  } catch { /* column may exist */ }

  try {
    db.exec(`CREATE INDEX idx_audit_hash ON audit_log(entry_hash)`);
  } catch { /* index may exist */ }
};
