'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic teams, memberships and host grants.
//
// Grants are least-privilege and mostly TEAM → HOST_GROUP (the shape a real
// estate uses), exercising the 077 `host_permissions` CHECK: exactly one target
// (host XOR host_group) and exactly one subject (user XOR team).
//
// `permission` is weighted view > operate > admin. Synthetic users are viewers at
// the account level regardless, so an 'admin' host grant here is scoped access on
// a synthetic host — never global privilege.

const { TEAM_NAMES } = require('./words');

function _uniqueName(db, table, column, base) {
  const stmt = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE ${column} = ? COLLATE NOCASE`);
  let name = base;
  let n = 1;
  while (stmt.get(name)) { n += 1; name = `${base} ${n}`; }
  return name;
}

function generate(ctx) {
  const { db, rng, datasetId, profile, refs } = ctx;
  if (!refs.users.length) return { count: 0 };

  // Explicit timestamps everywhere — never the datetime('now') DEFAULT, which
  // would make the dataset depend on wall-clock and stop being reproducible.
  const insTeam = db.prepare(
    'INSERT INTO teams (name, description, created_by, created_at, updated_at, seed_run_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insMember = db.prepare(
    'INSERT OR IGNORE INTO team_members (team_id, user_id, is_leader, added_by, added_at, seed_run_id) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const owner = rng.pick(refs.users).id;
  const teams = [];
  const names = rng.shuffle(TEAM_NAMES);
  for (let i = 0; i < profile.teams; i++) {
    const name = _uniqueName(db, 'teams', 'name', names[i % names.length]);
    const at = rng.dateBetween(ctx.nowMs - 300 * 864e5, ctx.nowMs - 20 * 864e5);
    const id = Number(insTeam.run(name, `Synthetic demo team (${name})`, owner, at, at, datasetId).lastInsertRowid);
    teams.push({ id, name, at, members: [] });
  }

  // Every synthetic user joins exactly one team; the first member leads it.
  let memberRows = 0;
  refs.users.forEach((u, i) => {
    const t = teams[i % teams.length];
    const isLeader = t.members.length === 0 ? 1 : 0;
    const r = insMember.run(t.id, u.id, isLeader, owner, t.at, datasetId);
    if (r.changes) { memberRows += 1; t.members.push(u.id); }
  });

  ctx.count('teams', teams.length);
  ctx.count('team_members', memberRows);
  ctx.refs.teams = teams;
  return { count: teams.length + memberRows };
}

/** host_permissions — runs after teams + host_groups. */
function generatePermissions(ctx) {
  const { db, rng, datasetId, profile, refs } = ctx;
  const teams = refs.teams || [];
  const groups = refs.hostGroups || [];
  if (!teams.length && !refs.users.length) return { count: 0 };

  const ins = db.prepare(`
    INSERT INTO host_permissions (host_id, host_group_id, user_id, team_id, permission, granted_by, granted_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const grantedBy = refs.users.length ? rng.pick(refs.users).id : null;
  const dup = db.prepare(`
    SELECT 1 AS ok FROM host_permissions
    WHERE COALESCE(host_id,-1) = COALESCE(?,-1) AND COALESCE(host_group_id,-1) = COALESCE(?,-1)
      AND COALESCE(user_id,-1) = COALESCE(?,-1) AND COALESCE(team_id,-1) = COALESCE(?,-1)
  `);

  let count = 0;
  for (let i = 0; i < profile.permissions; i++) {
    const permission = rng.weighted([['view', 6], ['operate', 3], ['admin', 1]]);
    // Prefer team→group (least privilege at scale); fall back as inventory allows.
    const useTeam = teams.length > 0 && rng.bool(0.75);
    const useGroup = groups.length > 0 && rng.bool(0.7);
    const subjectTeam = useTeam ? rng.pick(teams).id : null;
    const subjectUser = useTeam ? null : (refs.users.length ? rng.pick(refs.users).id : null);
    const targetGroup = useGroup ? rng.pick(groups).id : null;
    const targetHost = useGroup ? null : (refs.hosts.length ? rng.pick(refs.hosts).id : null);
    if ((!subjectTeam && !subjectUser) || (!targetGroup && !targetHost)) continue;
    if (dup.get(targetHost, targetGroup, subjectUser, subjectTeam)) continue;
    ins.run(targetHost, targetGroup, subjectUser, subjectTeam, permission, grantedBy,
      rng.dateBetween(ctx.nowMs - 200 * 864e5, ctx.nowMs - 864e5), datasetId);
    count += 1;
  }
  ctx.count('host_permissions', count);
  return { count };
}

module.exports = { generate, generatePermissions };
