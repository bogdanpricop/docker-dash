'use strict';
exports.up = db => db.exec(`
  CREATE TABLE governance_workload_replay_keys (
    replay_key TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_workload_replay_expiry ON governance_workload_replay_keys(julianday(expires_at));
  CREATE TABLE governance_workload_replay_policy (
    id INTEGER PRIMARY KEY CHECK(id=1),
    minimum_iat INTEGER NOT NULL
  );
  -- Old digests cannot reveal the signed content or JWT id. Reject pre-upgrade
  -- assertions when unexpired replay history exists, including allowed clock skew.
  INSERT INTO governance_workload_replay_policy(id,minimum_iat)
    SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM governance_workload_assertions
      WHERE julianday(expires_at)>julianday('now'))
      THEN CAST(strftime('%s','now') AS INTEGER)+60 ELSE 0 END;
  WITH RECURSIVE derived(id) AS (
    SELECT id FROM governance_service_tokens WHERE issued_via='workload_exchange'
    UNION SELECT token.id FROM governance_service_tokens token JOIN derived ON token.rotated_from=derived.id
  )
  UPDATE governance_service_tokens SET revoked_at=COALESCE(revoked_at,datetime('now'))
    WHERE id IN (SELECT id FROM derived);
`);
exports.down = db => db.exec(`
  DROP TABLE IF EXISTS governance_workload_replay_keys;
  DROP TABLE IF EXISTS governance_workload_replay_policy;
`);
