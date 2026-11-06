'use strict';

// v8.96.0 — Diagnostic Sessions (retrospective mode).
//
// A session stores only its DEFINITION: which subjects, over which window. No
// metric rows are copied. Every series a session draws already exists in
// container_stats*, vm_metric_samples, docker_events, health_events and
// audit_log, and is re-read on each open.
//
// That is deliberate. Materialising samples is what LIVE capture needs, because
// a live session must survive the metric tiers ageing out from under it. Adding
// that store now would be storage for a feature that has not yet earned it —
// see plans/deep-spec-unified-live-diagnostics.md, which gates live capture
// behind evidence this mode is meant to produce.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE diagnostic_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      -- Denormalised: a session outlives the account that made it, and an
      -- investigation artifact that cannot say who ran it is worth less.
      created_by_username TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_diag_sessions_created ON diagnostic_sessions(created_at);

    CREATE TABLE diagnostic_session_subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
      -- 'container' resolves against container_stats*, 'vm' against
      -- vm_metric_samples. Kept as text rather than an enum so a third source
      -- does not need a migration to be represented.
      subject_type TEXT NOT NULL,
      subject_ref TEXT NOT NULL,
      host_id INTEGER,
      provider_host_id INTEGER,
      display_name TEXT
    );
    CREATE INDEX idx_diag_subjects_session ON diagnostic_session_subjects(session_id);
  `);
};
