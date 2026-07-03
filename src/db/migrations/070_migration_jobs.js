'use strict';

// v8.9.2-alpha.1 — Sprint 7 (VM migration to Proxmox) foundation.
//
// Each `migration_jobs` row tracks one long-running migration:
// download the source disk image (VMDK / OVA / QCOW2 from URL), convert
// via `qemu-img`, attach to a stopped Proxmox VM via `qm importdisk`.
// Jobs run out-of-band from the request that creates them so the UI
// can poll for status and progress without holding an HTTP connection
// for GB-sized transfers.
//
// STATUS COLUMN VALUES:
//   pending    — queued, worker hasn't picked it up yet
//   running    — worker is executing one of the phases
//   completed  — VM was created successfully
//   failed     — one of the phases errored; error column has the message
//   cancelled  — user asked to abort (v2 — not implemented in alpha.1)
//
// PROGRESS: 0-100 integer. Milestones the worker sets:
//   5   download starting
//   40  download complete (this is usually the slowest step)
//   50  qemu-img convert starting
//   85  qemu-img convert complete
//   90  qm importdisk starting
//   100 VM created + disk attached
//
// PHASE_LOG is a text column that accumulates the stdout/stderr from
// each shell command run over SSH. Bounded at 256 KB (any single ssh
// stream that exceeds that is truncated with a marker).

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK(source_type IN ('url','upload')) DEFAULT 'url',
      source_url TEXT,                        -- for source_type='url'
      source_upload_path TEXT,                -- for source_type='upload' (v2)
      source_format TEXT CHECK(source_format IN ('vmdk','ova','qcow2','raw','auto')) DEFAULT 'auto',

      destination_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      destination_node TEXT NOT NULL,         -- Proxmox node name
      destination_storage TEXT NOT NULL,      -- Proxmox storage id (e.g. 'local-lvm')
      destination_vmid INTEGER NOT NULL,      -- Proxmox VMID to create
      destination_vm_name TEXT NOT NULL,      -- Human-readable VM name

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','completed','failed','cancelled')),
      progress INTEGER NOT NULL DEFAULT 0,
      current_phase TEXT,
      error TEXT,
      phase_log TEXT,

      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_migration_jobs_status ON migration_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_migration_jobs_dest ON migration_jobs(destination_host_id, destination_vmid);
    CREATE INDEX IF NOT EXISTS idx_migration_jobs_created ON migration_jobs(created_at DESC);
  `);
};
