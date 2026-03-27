'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_preferences (
      user_id INTEGER PRIMARY KEY,
      widget_order TEXT NOT NULL DEFAULT '["containers","cpu","memory","events"]',
      hidden_widgets TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
};
