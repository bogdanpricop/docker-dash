'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE container_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name TEXT NOT NULL UNIQUE,
      app_name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      lan_link TEXT DEFAULT '',
      web_link TEXT DEFAULT '',
      docs_url TEXT DEFAULT '',
      category TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      color TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      custom_fields TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_container_meta_name ON container_meta(container_name);
  `);
};
