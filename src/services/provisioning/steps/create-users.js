'use strict';

// Step 5 — create_users (kind: EXTERNAL).
//
// Reuses authService.createUser (async — bcrypt + optional HIBP — which is WHY
// this must be an external step: better-sqlite3 forbids awaiting inside a
// db.transaction). Roles are forced from the validated allow-list
// ({viewer,operator,admin}); the declaration validator already rejects `admin`
// in demo/trial and any second is_owner. Users are a SHARED POOL: dedupe by
// username (skip-if-exists) and — critically — compensation DEACTIVATES
// (is_active=0), NEVER hard-deletes, so audit_log FK references stay valid.

const { now } = require('../../../utils/helpers');

module.exports = {
  key: 'create_users',
  kind: 'external',

  async run(ctx) {
    const { db, decl, tenantId } = ctx;
    const authService = require('../../auth');
    const created = [];

    for (const u of decl.users) {
      const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(u.username);
      let userId;
      let wasCreated;
      if (existing) {
        userId = existing.id;
        wasCreated = false; // skip-if-exists (shared pool) — never mutate an existing account's password/role
      } else {
        const password = ctx.reveal(u.password);
        if (!password) throw new Error(`user ${u.username}: a password is required to create the account`);
        const res = await authService.createUser({
          username: u.username,
          displayName: u.displayName,
          email: u.email,
          password,
          role: u.role, // forced from the validated allow-list
        });
        if (res.error) throw new Error(`user ${u.username}: ${res.error}`);
        userId = Number(res.id);
        wasCreated = true;
        // Provisioned accounts must rotate on first login (mirror seedAdmin).
        db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(userId);
      }

      // Associate with the tenant (idempotent upsert). is_owner is atomic — the
      // validator guarantees at most one is_owner per run.
      db.prepare(`
        INSERT INTO user_tenants (user_id, tenant_id, role, is_owner)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role, is_owner = excluded.is_owner
      `).run(userId, tenantId, u.role, u.isOwner ? 1 : 0);

      created.push({ id: userId, username: u.username, created: wasCreated });
      // Reuse the existing create_user audit action — NO password in details.
      ctx.audit('create_user', 'user', String(userId), {
        username: u.username, role: u.role, isOwner: !!u.isOwner, created: wasCreated,
      });
    }

    return { users: created };
  },

  async compensate(ctx, cp) {
    const { db } = ctx;
    for (const u of (cp && cp.users) || []) {
      if (u.created) {
        // Shared pool: DEACTIVATE, never delete — preserves audit_log FK integrity.
        try {
          db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), u.id);
          db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(u.id);
        } catch (err) {
          ctx.log.warn('create_users compensate: failed to deactivate user', { id: u.id, error: err.message });
        }
      }
      // Remove the tenant association this run created (for both created + adopted users).
      try {
        db.prepare('DELETE FROM user_tenants WHERE user_id = ? AND tenant_id = ?').run(u.id, ctx.tenantId);
      } catch { /* tenant may already be gone via cascade — fine */ }
    }
  },

  estimate(ctx) {
    return { users: (ctx.decl && ctx.decl.users ? ctx.decl.users.length : 0) };
  },
};
