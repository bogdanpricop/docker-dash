'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      target TEXT NOT NULL DEFAULT '*',
      metric TEXT NOT NULL CHECK(metric IN ('cpu','memory','status','health')),
      operator TEXT NOT NULL DEFAULT '>' CHECK(operator IN ('>','>=','<','<=','==','!=')),
      threshold REAL NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('info','warning','critical')),
      channels TEXT NOT NULL DEFAULT '["toast"]',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES alert_rules(id),
      host_id INTEGER DEFAULT 0,
      container_id TEXT,
      container_name TEXT,
      metric_value REAL,
      message TEXT,
      severity TEXT NOT NULL DEFAULT 'warning',
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      acknowledged_by INTEGER REFERENCES users(id),
      acknowledged_at TEXT
    );
    CREATE INDEX idx_alert_events_rule ON alert_events(rule_id, triggered_at);
    CREATE INDEX idx_alert_events_active ON alert_events(resolved_at);

    CREATE TABLE alert_breaches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES alert_rules(id),
      container_id TEXT NOT NULL,
      first_breach_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_value REAL,
      UNIQUE(rule_id, container_id)
    );
  `);
};
