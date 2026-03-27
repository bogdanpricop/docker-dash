'use strict';

exports.up = function (db) {
  // Remove duplicate bucket entries before adding UNIQUE constraint.
  // Keep only the row with the highest id (most recent) for each duplicate.
  db.exec(`
    DELETE FROM container_stats_1m
    WHERE id NOT IN (
      SELECT MAX(id) FROM container_stats_1m GROUP BY container_id, bucket
    );

    DELETE FROM container_stats_1h
    WHERE id NOT IN (
      SELECT MAX(id) FROM container_stats_1h GROUP BY container_id, bucket
    );
  `);

  // Add UNIQUE indexes to prevent duplicate bucket entries per container.
  // This enables INSERT OR IGNORE in aggregation queries, replacing
  // expensive correlated subqueries that caused high CPU usage.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stats1m_container_bucket
      ON container_stats_1m(container_id, bucket);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stats1h_container_bucket
      ON container_stats_1h(container_id, bucket);
  `);
};
