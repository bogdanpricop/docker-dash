'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE docker_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      connection_type TEXT NOT NULL DEFAULT 'socket' CHECK(connection_type IN ('socket','tcp','ssh')),
      socket_path TEXT DEFAULT '/var/run/docker.sock',
      host TEXT,
      port INTEGER,
      tls_config TEXT,
      ssh_config TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO docker_hosts (name, connection_type, socket_path, is_default) 
    VALUES ('Local', 'socket', '/var/run/docker.sock', 1);

    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      permissions TEXT NOT NULL DEFAULT '["read"]',
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_apikeys_hash ON api_keys(key_hash);

    CREATE TABLE docker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER DEFAULT 0,
      event_type TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      attributes TEXT,
      event_time TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_events_time ON docker_events(event_time);
    CREATE INDEX idx_events_type ON docker_events(event_type, action);

    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT,
      link TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at);

    CREATE TABLE exec_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      host_id INTEGER DEFAULT 0,
      container_id TEXT NOT NULL,
      container_name TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
  `);
};
