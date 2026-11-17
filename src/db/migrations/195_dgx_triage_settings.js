'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE dgx_triage_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      endpoint TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'qwen3-4b',
      ca_pem TEXT NOT NULL DEFAULT '',
      key_encrypted TEXT
    );
    INSERT INTO dgx_triage_settings (id) VALUES (1);
  `);
};
