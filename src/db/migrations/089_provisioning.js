'use strict';

// v8.15.0 (Onboarding & Provisioning Wizard — Phase 1 backend) — Saga engine store.
//
// The provisioning engine is an idempotent, checkpointed, resumable, rollback-able
// saga over these two tables (see plans/onboarding-architecture.md §2):
//   provisioning_runs   — one row per apply(); the resume cursor + encrypted input
//   provisioning_steps   — one row per (run, step); the checkpoint + compensation data
//
// Idempotency is THREE-layered:
//   1. provisioning_runs.idempotency_key UNIQUE     — concurrent same-key apply
//      attaches to the existing run instead of duplicating.
//   2. UNIQUE(run_id, step_key)                      — a step is provisioned once.
//   3. natural-key UPSERTs inside the steps          — a torn re-run converges.
//
// FK note: provisioning_runs.tenant_id is ON DELETE SET NULL (NOT cascade). The
// rollback pivot deletes the tenant; the run + step history MUST survive that
// delete for the forensic/audit trail. provisioning_steps.run_id IS cascade
// (steps are owned by the run).

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provisioning_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE SET NULL,  -- set by create_tenant; survives rollback
      mode            TEXT    NOT NULL DEFAULT 'production'
                              CHECK(mode IN ('demo','trial','production')),
      template_key    TEXT,
      status          TEXT    NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','running','completed','failed','rolled_back')),
      idempotency_key TEXT    NOT NULL UNIQUE,
      plan_json       TEXT,     -- ordered step plan + impact estimate + declaration fingerprint
      input_json      TEXT,     -- normalized declaration; secrets AES-GCM-encrypted inline ({_enc})
      result_json     TEXT,     -- per-step report + warnings (the Summary payload)
      current_step    INTEGER NOT NULL DEFAULT 0,   -- resume cursor: highest completed ordinal
      total_steps     INTEGER NOT NULL DEFAULT 0,
      started_by      TEXT,
      started_at      TEXT,
      finished_at     TEXT,
      error           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provisioning_runs_status ON provisioning_runs(status);
    CREATE INDEX IF NOT EXISTS idx_provisioning_runs_tenant ON provisioning_runs(tenant_id);

    CREATE TABLE IF NOT EXISTS provisioning_steps (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER NOT NULL REFERENCES provisioning_runs(id) ON DELETE CASCADE,
      step_key          TEXT    NOT NULL,
      ordinal           INTEGER NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending','running','completed','failed','compensated')),
      checkpoint_json   TEXT,     -- opaque result the step needs for resume/idempotency probe
      compensation_json TEXT,     -- data needed to undo (e.g. created ids)
      error             TEXT,
      started_at        TEXT,
      finished_at       TEXT,
      UNIQUE(run_id, step_key)    -- provision-once guard; idempotency key == (run_id, step_key)
    );
    CREATE INDEX IF NOT EXISTS idx_provisioning_steps_run ON provisioning_steps(run_id, ordinal);
  `);
};
