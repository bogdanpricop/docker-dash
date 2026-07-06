'use strict';

// v8.9.10-alpha.1 — Portainer G01 + G02 closure: Teams + per-host access.
//
// Teams: user groups that share permissions. Grant a permission to a
// team → every member has it. Add/remove a user from the team →
// permission cascades automatically.
//
// Per-host access control: today every authenticated user sees every
// host. This adds host_permissions with user_id OR team_id OR
// host_group_id (mutually exclusive) and a permission level
// (view | operate | admin). Middleware `requireHostAccess(minLevel)`
// resolves effective permission via admin-global → direct grant → team
// grant → group grant, fails closed on non-admins for un-granted hosts.
//
// BACKWARD COMPATIBILITY: on upgrade, seed a "legacy_default_access"
// grant so existing non-admin users don't lose access silently. Admin
// toggles it off after configuring real permissions.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_leader INTEGER NOT NULL DEFAULT 0,
      added_by INTEGER REFERENCES users(id),
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS host_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER REFERENCES docker_hosts(id) ON DELETE CASCADE,
      host_group_id INTEGER REFERENCES host_groups(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('view', 'operate', 'admin')),
      granted_by INTEGER REFERENCES users(id),
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),

      -- Exactly one target (host XOR group) and exactly one subject
      -- (user XOR team). Enforced via a CHECK.
      CHECK((host_id IS NOT NULL) + (host_group_id IS NOT NULL) = 1),
      CHECK((user_id IS NOT NULL) + (team_id IS NOT NULL) = 1)
    );

    CREATE INDEX IF NOT EXISTS idx_host_perms_user ON host_permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_host_perms_team ON host_permissions(team_id);
    CREATE INDEX IF NOT EXISTS idx_host_perms_host ON host_permissions(host_id);
    CREATE INDEX IF NOT EXISTS idx_host_perms_group ON host_permissions(host_group_id);
  `);

  // Backward-compat: seed a settings flag that turns on "legacy default
  // access" — every non-admin user is treated as having 'operate' access
  // on every host, matching pre-upgrade behavior. Admin turns this off
  // after configuring real host_permissions rows.
  db.prepare(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('legacy_host_access_default', 'true')
  `).run();
};
