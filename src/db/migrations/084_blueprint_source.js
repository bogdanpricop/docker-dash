'use strict';

// v8.9.44-alpha.1 — Reconciler remote sync (GitOps pull). A blueprint can name a
// remote HTTPS(S) URL as its desired-state source of truth. docker-dash pulls the
// JSON, validates it through the existing validateDoc, and updates the blueprint's
// doc — on demand or on a best-effort schedule folded into the drift monitor.
//
// Additive columns on `blueprints` (source config is 1:1 with a blueprint; sync
// outcomes are already history in blueprint_runs as kind='sync'). The optional
// Bearer token is encrypted at rest (source_token_enc) and never returned. Guard
// each ADD COLUMN with PRAGMA table_info so the migration survives re-runs in dev
// (mirrors 069_docker_hosts_daemon_type).

exports.up = function (db) {
  const cols = db.prepare('PRAGMA table_info(blueprints)').all();
  const has = (name) => cols.some(c => c.name === name);

  if (!has('source_url')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN source_url TEXT;');
  }
  if (!has('source_token_enc')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN source_token_enc TEXT;');
  }
  if (!has('source_auto_sync')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN source_auto_sync INTEGER NOT NULL DEFAULT 0;');
  }
  if (!has('source_interval_min')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN source_interval_min INTEGER NOT NULL DEFAULT 60;');
  }
  if (!has('last_synced_at')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN last_synced_at TEXT;');
  }
  if (!has('last_sync_status')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN last_sync_status TEXT;');
  }
  if (!has('last_sync_error')) {
    db.exec('ALTER TABLE blueprints ADD COLUMN last_sync_error TEXT;');
  }
};
