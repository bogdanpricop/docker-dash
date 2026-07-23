'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic demo users + tenant membership.
//
// SECURITY (plans/onboarding-security.md C2 / TC-08): synthetic users are
// ALWAYS `role='viewer'` and `is_owner=0`. The role is hard-coded here — this
// module accepts NO role parameter, so no declaration, template or API payload
// can ever seed an admin.
//
// The password hash is a fixed, valid-format bcrypt digest of a long random
// string that was discarded at authoring time. It is syntactically valid (so
// `bcrypt.compare` returns a clean `false` instead of throwing) and no password
// on earth verifies against it — demo accounts exist to populate lists, teams
// and grants, never to log in.

const { slugify } = require('./words');

// $2b$12$ hash of a 96-hex-char random string that was never recorded.
const DISABLED_PASSWORD_HASH = '$2b$12$NFNLnTrgfscQnaLYUPAkqukMJqLrLltCHrMrNYV7vpgAQtJXigPwW';

function generate(ctx) {
  const { db, rng, datasetId, tenantId, profile, pool, org } = ctx;

  // created_at/updated_at are written EXPLICITLY (never left to the
  // datetime('now') DEFAULT) so the dataset never depends on wall-clock.
  const insUser = db.prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, is_active, created_at, updated_at, seed_run_id)
    VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?, ?)
  `);
  const insMembership = db.prepare(`
    INSERT INTO user_tenants (user_id, tenant_id, role, is_owner, created_at, seed_run_id)
    VALUES (?, ?, 'viewer', 0, ?, ?)
  `);

  const users = [];
  const seenNames = new Set();
  for (let i = 0; i < profile.users; i++) {
    const first = rng.pick(pool.firstNames);
    const last = rng.pick(pool.lastNames);
    let base = `${slugify(first)}.${slugify(last)}`;
    let username = base;
    let n = 1;
    // Deterministic uniquification against BOTH this batch and any pre-existing
    // row (users.username is UNIQUE COLLATE NOCASE).
    while (seenNames.has(username) || db.prepare('SELECT 1 AS ok FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
      n += 1;
      username = `${base}${n}`;
    }
    seenNames.add(username);

    const email = `${username}@${org.slug}.example`;   // RFC 2606 reserved TLD
    const createdAt = rng.dateBetween(ctx.nowMs - 400 * 864e5, ctx.nowMs - 30 * 864e5);
    const isActive = rng.bool(0.9) ? 1 : 0;
    const id = Number(insUser.run(
      username, `${first} ${last}`, email, DISABLED_PASSWORD_HASH, isActive, createdAt, createdAt, datasetId,
    ).lastInsertRowid);
    insMembership.run(id, tenantId, createdAt, datasetId);
    users.push({ id, username, displayName: `${first} ${last}`, email });
  }

  ctx.count('users', users.length);
  ctx.count('user_tenants', users.length);
  ctx.refs.users = users;
  return { count: users.length };
}

module.exports = { generate, DISABLED_PASSWORD_HASH };
