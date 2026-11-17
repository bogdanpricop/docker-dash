'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE deployment_security_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL,
      host_id INTEGER NOT NULL,
      container_name TEXT NOT NULL,
      previous_image_id TEXT NOT NULL,
      current_image_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed')),
      report_json TEXT,
      error TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(operation_id,host_id,container_name,previous_image_id,current_image_id)
    );
    CREATE INDEX idx_deployment_security_container ON deployment_security_reviews(host_id,container_name,id DESC);
  `);
};
