'use strict';

exports.up = function (db) {
  // ── Deployment History ───────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      git_stack_id INTEGER NOT NULL,
      commit_hash TEXT NOT NULL,
      commit_message TEXT,
      commit_author TEXT,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'webhook', 'polling')),
      status TEXT NOT NULL DEFAULT 'deploying' CHECK(status IN ('deploying', 'success', 'failed', 'rolled_back')),
      error_message TEXT,
      duration_ms INTEGER,
      deployed_by INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      FOREIGN KEY (git_stack_id) REFERENCES git_stacks(id) ON DELETE CASCADE,
      FOREIGN KEY (deployed_by) REFERENCES users(id)
    )
  `);

  try { db.exec(`CREATE INDEX idx_git_deployments_stack ON git_deployments(git_stack_id, started_at DESC)`); } catch {}
  try { db.exec(`CREATE INDEX idx_git_deployments_status ON git_deployments(status)`); } catch {}

  // ── Additional columns on git_stacks for auto-deploy ────
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN webhook_token TEXT`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN webhook_secret TEXT`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN webhook_provider TEXT DEFAULT 'github'`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN polling_enabled INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN polling_interval_seconds INTEGER NOT NULL DEFAULT 300`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN deploy_on_push INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN deployment_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN last_deployment_id INTEGER`); } catch {}

  try { db.exec(`CREATE UNIQUE INDEX idx_git_stacks_webhook_token ON git_stacks(webhook_token) WHERE webhook_token IS NOT NULL`); } catch {}
};
