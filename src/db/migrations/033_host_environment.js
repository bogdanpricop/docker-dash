'use strict';

exports.up = function (db) {
  // Add environment column to docker_hosts
  const cols = db.pragma('table_info(docker_hosts)').map(c => c.name);
  if (!cols.includes('environment')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN environment TEXT NOT NULL DEFAULT 'development'`);
  }
};
