'use strict';

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_vm_nic_safety_declarations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL,
      nic_id TEXT NOT NULL,
      nic_fingerprint TEXT NOT NULL,
      management_role TEXT NOT NULL CHECK(management_role IN ('management','non_management')),
      boot_dependency TEXT NOT NULL CHECK(boot_dependency IN ('required','not_required')),
      guest_dependency TEXT NOT NULL CHECK(guest_dependency IN ('required','not_required')),
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      declared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, vm_id, nic_id),
      CHECK(length(vm_id) BETWEEN 33 AND 40),
      CHECK(length(nic_id) BETWEEN 34 AND 41),
      CHECK(length(nic_fingerprint) = 64),
      CHECK(length(reason) BETWEEN 8 AND 500),
      CHECK(expires_at > updated_at)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_vm_nic_safety_expiry
      ON provider_vm_nic_safety_declarations(host_id, expires_at, vm_id);
  `);
};

exports.down = function down(db) {
  db.exec('DROP TABLE IF EXISTS provider_vm_nic_safety_declarations;');
};
