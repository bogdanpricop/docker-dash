'use strict';

exports.up = db => db.exec(`
  CREATE TABLE storage_backups (
    id TEXT PRIMARY KEY,
    host_id INTEGER NOT NULL,
    host_name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('volume', 'bind')),
    source_name TEXT NOT NULL,
    archive_bytes INTEGER NOT NULL,
    wrapped_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
