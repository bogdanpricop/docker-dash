'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oci_compose_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      registry_id INTEGER NOT NULL REFERENCES registries(id),
      repository TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      digest TEXT NOT NULL,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id),
      project_name TEXT NOT NULL,
      override_yaml TEXT,
      signature_policy TEXT NOT NULL DEFAULT 'none'
        CHECK(signature_policy IN ('none','annotation','cosign')),
      signer_pattern TEXT,
      provenance_json TEXT,
      status TEXT NOT NULL DEFAULT 'ready'
        CHECK(status IN ('ready','deploying','running','error')),
      last_error TEXT,
      last_deployed_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oci_compose_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id INTEGER NOT NULL REFERENCES oci_compose_artifacts(id) ON DELETE CASCADE,
      digest TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('plan','deploy','down')),
      status TEXT NOT NULL CHECK(status IN ('success','failed')),
      output TEXT,
      error TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_oci_compose_deployments_artifact
      ON oci_compose_deployments(artifact_id, created_at DESC);
  `);
};

