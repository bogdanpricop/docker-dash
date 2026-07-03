'use strict';

// v8.9.0-alpha — Sprint 3 foundation: extend docker_hosts to describe
// non-Docker daemons (Incus, Proxmox, k8s in future sprints).
//
// The existing table implicitly assumes every entry is a Docker daemon.
// Adding `daemon_type` unlocks routing to alternate service layers
// (src/services/incus.js in this release; src/services/proxmox.js and
// src/services/kubernetes.js in future sprints) while keeping the
// backward-compatible default so existing rows keep working.
//
// `daemon_config` is a per-type JSON blob for extra connection details
// (Incus socket path or client cert, Proxmox cluster URL + token, k8s
// kubeconfig). Kept opaque here — the per-daemon service layer parses
// its own shape.
//
// Rationale for coupling to the existing docker_hosts table vs a new
// `hosts` table: this is additive, low-risk, and preserves every FK
// reference across the codebase (docker_events.host_id, exec_sessions.
// host_id, container_stats.host_id, etc.). A rename would ripple.

exports.up = function (db) {
  // ALTER TABLE ... ADD COLUMN is idempotent enough for SQLite as long
  // as we don't try to add a column that already exists. Guard with
  // PRAGMA table_info() to survive re-running the migration during dev.
  const cols = db.prepare('PRAGMA table_info(docker_hosts)').all();
  const has = (name) => cols.some(c => c.name === name);

  if (!has('daemon_type')) {
    db.exec(`
      ALTER TABLE docker_hosts ADD COLUMN daemon_type TEXT NOT NULL DEFAULT 'docker'
        CHECK(daemon_type IN ('docker', 'podman', 'incus', 'proxmox', 'kubernetes'));
    `);
  }

  if (!has('daemon_config')) {
    db.exec(`
      ALTER TABLE docker_hosts ADD COLUMN daemon_config TEXT;
    `);
  }

  // No backfill needed — the default of 'docker' matches every existing
  // row's implicit meaning. Podman detection is done dynamically per
  // request via version.Components inspection (v8.7.44); Podman rows can
  // keep daemon_type='docker' and still show the badge — the two systems
  // are orthogonal by design.
};
