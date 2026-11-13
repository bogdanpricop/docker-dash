'use strict';

exports.up = function (db) {
  db.exec(
    "CREATE TABLE security_scan_schedules (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL," +
    " host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL," +
    " kind TEXT NOT NULL CHECK(kind IN ('images', 'cis'))," +
    " image_scope TEXT NOT NULL CHECK(image_scope IN ('running', 'all'))," +
    " scanner TEXT NOT NULL CHECK(scanner IN ('auto', 'trivy', 'grype'))," +
    " cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1," +
    " channel_id INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL," +
    " owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL," +
    " created_at TEXT NOT NULL, last_slot INTEGER" +
    ");" +
    "CREATE TABLE security_scan_runs (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " schedule_id INTEGER NOT NULL REFERENCES security_scan_schedules(id) ON DELETE CASCADE," +
    " host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL, host_name TEXT NOT NULL," +
    " kind TEXT NOT NULL, image_scope TEXT NOT NULL, scanner TEXT NOT NULL," +
    " channel_id INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL," +
    " delivery_status TEXT NOT NULL, delivery_error TEXT," +
    " trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'automatic'))," +
    " status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'partial', 'error'))," +
    " queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, report_json TEXT, error TEXT" +
    ");" +
    "CREATE UNIQUE INDEX idx_security_scan_pending ON security_scan_runs(schedule_id) WHERE status IN ('queued', 'running');" +
    "CREATE UNIQUE INDEX idx_security_scan_worker ON security_scan_runs(status) WHERE status = 'running';" +
    "CREATE INDEX idx_security_scan_history ON security_scan_runs(schedule_id, id DESC);" +
    "ALTER TABLE scan_results ADD COLUMN security_run_id INTEGER REFERENCES security_scan_runs(id) ON DELETE CASCADE;" +
    "CREATE INDEX idx_scan_security_run ON scan_results(security_run_id) WHERE security_run_id IS NOT NULL;"
  );
};
