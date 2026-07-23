'use strict';

// Step 6 — grant_permissions (kind: db).
//
// Creates least-privilege host_permissions starter grants from the declaration's
// permissions[]. Resolves username→userId and hostName→hostId from the prior
// steps' checkpoints first (this run's freshly-created ids), falling back to the
// live tables for pre-existing subjects. Unresolvable grants are recorded as
// warnings and skipped (non-fatal). Explicit compensation deletes the grant rows
// THIS run inserted (adopted duplicates are left in place).

module.exports = {
  key: 'grant_permissions',
  kind: 'db',

  run(ctx) {
    const { db, decl, tenantId } = ctx;
    const userCp = ctx.checkpoint('create_users') || {};
    const hostCp = ctx.checkpoint('create_hosts') || {};
    const userByName = new Map((userCp.users || []).map((u) => [u.username.toLowerCase(), u.id]));
    const hostByName = new Map((hostCp.hosts || []).map((h) => [h.name, h.id]));
    const grantedBy = (ctx.user && ctx.user.id) || null;

    const created = [];  // ids inserted by this run (compensation target)
    const adopted = [];  // ids of pre-existing identical grants
    const warnings = [];

    for (const p of decl.permissions) {
      let userId = userByName.get(p.username.toLowerCase());
      if (!userId) {
        const r = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(p.username);
        userId = r && r.id;
      }
      let hostId = hostByName.get(p.hostName);
      if (!hostId) {
        const r = db.prepare('SELECT id FROM docker_hosts WHERE name = ?').get(p.hostName);
        hostId = r && r.id;
      }
      if (!userId || !hostId) {
        warnings.push(`unresolved grant: ${p.username} -> ${p.hostName}`);
        continue;
      }

      const dup = db.prepare(`
        SELECT id FROM host_permissions
        WHERE host_id = ? AND user_id = ? AND permission = ? AND host_group_id IS NULL AND team_id IS NULL
      `).get(hostId, userId, p.permission);
      if (dup) { adopted.push(dup.id); continue; }

      const r = db.prepare(`
        INSERT INTO host_permissions (host_id, user_id, permission, granted_by)
        VALUES (?, ?, ?, ?)
      `).run(hostId, userId, p.permission, grantedBy);
      created.push(Number(r.lastInsertRowid));
    }

    ctx.audit('tenant_update', 'tenant', String(tenantId), {
      grantsCreated: created.length, grantsAdopted: adopted.length, warnings: warnings.length,
    });
    return { created, adopted, warnings };
  },

  compensate(ctx, cp) {
    const { db } = ctx;
    const del = db.prepare('DELETE FROM host_permissions WHERE id = ?');
    for (const id of (cp && cp.created) || []) {
      try { del.run(id); } catch (err) {
        ctx.log.warn('grant_permissions compensate: failed to delete grant', { id, error: err.message });
      }
    }
  },

  estimate(ctx) {
    return { grants: (ctx.decl && ctx.decl.permissions ? ctx.decl.permissions.length : 0) };
  },
};
