'use strict';

// v8.7.24 — multi-host correctness for stats rollup UNIQUE constraints.
//
// Migration 009 added UNIQUE INDEX (container_id, bucket) on container_stats_1m
// and container_stats_1h. Migration 067 added the same shape on container_stats_1d.
// The aggregation queries in src/services/stats.js GROUP BY (host_id, container_id,
// strftime(bucket)) and INSERT host_id into the rollup tables — so the SELECT
// can produce multiple rows for the same (container_id, bucket) when two hosts
// happen to have a container with the same ID. The INSERT OR IGNORE in the
// aggregation queries would then silently drop all but one host's bucket,
// because the existing UNIQUE constraint did not include host_id.
//
// Docker generates random 64-char container IDs, so collision under normal
// operation is cryptographically negligible. The real failure mode is
// administrative: a container snapshot restored across hosts, or backup-
// imported state. Probability is low but the fix is mechanical.

exports.up = function (db) {
  // Defensive dedupe before reshaping the constraint. We keep the row with
  // the highest id for each (host_id, container_id, bucket). On systems where
  // the bug never triggered (overwhelming majority), this is a no-op.
  db.exec(`
    DELETE FROM container_stats_1m
    WHERE id NOT IN (
      SELECT MAX(id) FROM container_stats_1m
      GROUP BY host_id, container_id, bucket
    );

    DELETE FROM container_stats_1h
    WHERE id NOT IN (
      SELECT MAX(id) FROM container_stats_1h
      GROUP BY host_id, container_id, bucket
    );

    DELETE FROM container_stats_1d
    WHERE id NOT IN (
      SELECT MAX(id) FROM container_stats_1d
      GROUP BY host_id, container_id, bucket
    );
  `);

  // Drop the old single-host-implicit indexes.
  db.exec(`
    DROP INDEX IF EXISTS idx_stats1m_container_bucket;
    DROP INDEX IF EXISTS idx_stats1h_container_bucket;
    DROP INDEX IF EXISTS idx_stats1d_container_bucket;
  `);

  // Recreate as multi-host-aware UNIQUE indexes. Names use the same prefix
  // pattern so future humans can grep for them next to the originals.
  db.exec(`
    CREATE UNIQUE INDEX idx_stats1m_host_container_bucket
      ON container_stats_1m(host_id, container_id, bucket);
    CREATE UNIQUE INDEX idx_stats1h_host_container_bucket
      ON container_stats_1h(host_id, container_id, bucket);
    CREATE UNIQUE INDEX idx_stats1d_host_container_bucket
      ON container_stats_1d(host_id, container_id, bucket);
  `);
};
