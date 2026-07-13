'use strict';

// v8.9.43-alpha.1 — Ops Copilot config (single row, id=1). OFF by default and no
// default endpoint: the copilot sends nothing anywhere until an admin configures
// a bring-your-own OpenAI-compatible endpoint. The API key is encrypted at rest
// (api_key_enc) and never returned by the API.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      base_url TEXT,
      model TEXT,
      api_key_enc TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO copilot_config (id, enabled) VALUES (1, 0);
  `);
};
