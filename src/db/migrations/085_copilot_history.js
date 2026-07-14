'use strict';

// v8.9.45-alpha.1 — Ops Copilot conversation history. Persists ONLY the question
// text and the answer text for each ask() turn — never the assembled context
// bundle (host inventory, findings, posture detail) that was sent to the model.
// This keeps the privacy posture of the copilot itself (advise-only, secret-free
// context) intact for what gets stored at rest, not just what's sent over the wire.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_copilot_history_created
      ON copilot_history(created_at);
  `);
};
