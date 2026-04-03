'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stack_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stack_name TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('none','view','operate','admin')),
      granted_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(stack_name, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_stack_perms_user ON stack_permissions(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stack_perms_stack ON stack_permissions(stack_name)`);
};
