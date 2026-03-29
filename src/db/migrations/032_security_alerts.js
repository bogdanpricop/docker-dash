'use strict';

exports.up = function (db) {
  // Security alert rules table
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      threshold INTEGER NOT NULL DEFAULT 1,
      window_seconds INTEGER NOT NULL DEFAULT 600,
      severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
      is_active INTEGER NOT NULL DEFAULT 1,
      notify_channels TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Security alert history (fired alerts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER REFERENCES security_alert_rules(id),
      rule_name TEXT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT,
      details TEXT,
      fired_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  try {
    db.exec(`CREATE INDEX idx_security_alert_events_time ON security_alert_events(fired_at)`);
  } catch { /* index may exist */ }

  // Seed default rules
  const defaults = [
    { name: 'Brute Force Detection', event_type: 'failed_login', threshold: 5, window_seconds: 600, severity: 'critical' },
    { name: 'New Admin Created', event_type: 'create_admin_user', threshold: 1, window_seconds: 0, severity: 'warning' },
    { name: 'MFA Disabled', event_type: 'mfa_disabled', threshold: 1, window_seconds: 0, severity: 'warning' },
    { name: 'Password Reset by Admin', event_type: 'admin_password_reset', threshold: 1, window_seconds: 0, severity: 'warning' },
    { name: 'Privilege Escalation', event_type: 'role_changed_to_admin', threshold: 1, window_seconds: 0, severity: 'critical' },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO security_alert_rules (name, event_type, threshold, window_seconds, severity)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const rule of defaults) {
    insert.run(rule.name, rule.event_type, rule.threshold, rule.window_seconds, rule.severity);
  }
};
