'use strict';

// v8.17.0 (Onboarding — Phase 3) — the synthetic container ROSTER + enrichment.
//
// docker-dash has no container-inventory table: container identity normally lives
// in the live Docker API, with only name-keyed `container_meta` and id-keyed
// `container_stats`/`container_groups` alongside it. Demo mode has NO daemon, so
// `seed_containers` is the single source of truth that
//   (i)  anchors every downstream container FK (stats/events/meta/groups), and
//   (ii) is what the mock docker adapter serves for GET /containers.
// Without it the generator and the adapter would independently re-derive identity
// and drift apart.
//
// Container ids are 64-hex PRNG strings — the same shape Docker emits, but drawn
// from the seeded stream so they replay byte-identically.

const { SERVICE_STACKS, SERVICE_NAMES, IMAGES, CONTAINER_GROUP_NAMES } = require('./words');

const CATEGORIES = ['Core', 'Data', 'Edge', 'Observability', 'Integration', 'Internal'];
const META_COLORS = ['#0ea5e9', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#6366f1'];
const META_ICONS = ['fas fa-cube', 'fas fa-database', 'fas fa-gauge', 'fas fa-plug', 'fas fa-server'];

function _uptimeLabel(rng, state, ageDays) {
  if (state === 'running') return `Up ${Math.max(1, Math.round(ageDays))} day${ageDays >= 2 ? 's' : ''}`;
  if (state === 'exited') return `Exited (${rng.pick([0, 1, 137, 143])}) ${rng.int(1, 20)} hours ago`;
  if (state === 'paused') return `Up ${Math.max(1, Math.round(ageDays))} days (Paused)`;
  return `Created ${rng.int(1, 48)} minutes ago`;
}

function generate(ctx) {
  const { db, rng, datasetId, tenantId, profile, scenario, org, refs } = ctx;
  if (!refs.hosts.length) return { count: 0 };

  const ins = db.prepare(`
    INSERT INTO seed_containers (
      seed_run_id, tenant_id, host_id, container_id, name, image, state, status,
      compose_project, ports_json, labels_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stacks = rng.shuffle(SERVICE_STACKS);
  const roster = [];
  // Pick exactly `running` running containers so the stats budget is exact.
  const runningTarget = Math.min(profile.running, profile.containers);
  const runningSlots = new Set(rng.sample([...Array(profile.containers).keys()], runningTarget));

  for (let i = 0; i < profile.containers; i++) {
    const stack = stacks[i % stacks.length];
    const svc = SERVICE_NAMES[(i * 7 + 3) % SERVICE_NAMES.length];
    const ordinal = String(Math.floor(i / SERVICE_NAMES.length) + 1);
    const project = `${org.slug}-${stack}`;
    const name = `${project}-${svc}-${ordinal}`;
    const host = refs.hosts[i % refs.hosts.length];
    const state = runningSlots.has(i)
      ? 'running'
      : rng.weighted(scenario.containerStates.filter(([v]) => v !== 'running'));
    const ageDays = rng.range(1, 90);
    const createdAt = ctx.toSqlTime(ctx.nowMs - ageDays * 864e5);
    const image = IMAGES[(i * 5 + 1) % IMAGES.length];
    const ports = state === 'running' && rng.bool(0.55)
      ? [{ private: rng.pick([80, 8080, 5432, 6379, 3000, 9090]), public: rng.int(30000, 32767), type: 'tcp', ip: '0.0.0.0' }]
      : [];

    const id = Number(ins.run(
      datasetId, tenantId, host.id, rng.hex(64), name, image, state,
      _uptimeLabel(rng, state, ageDays), project,
      JSON.stringify(ports),
      JSON.stringify({
        'com.docker.compose.project': project,
        'com.docker.compose.service': svc,
        'dd.demo': 'true',
      }),
      createdAt,
    ).lastInsertRowid);

    const row = db.prepare('SELECT container_id FROM seed_containers WHERE id = ?').get(id);
    roster.push({
      rowId: id, containerId: row.container_id, name, image, state, hostId: host.id,
      project, createdAt, ageDays,
    });
  }

  ctx.count('seed_containers', roster.length);
  ctx.refs.containers = roster;
  ctx.refs.running = roster.filter((c) => c.state === 'running');
  return { count: roster.length };
}

/** container_meta (name-keyed enrichment) + container_groups (+ members). */
function generateEnrichment(ctx) {
  const { db, rng, datasetId, profile, refs } = ctx;
  if (!refs.containers.length) return { count: 0 };

  // Explicit timestamps everywhere — never the datetime('now') DEFAULT, which
  // would make the dataset depend on wall-clock and stop being reproducible.
  const insMeta = db.prepare(`
    INSERT OR IGNORE INTO container_meta
      (container_name, app_name, description, category, owner, icon, color, custom_fields, created_at, updated_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let metaCount = 0;
  const metaTargets = rng.sample(refs.containers, Math.min(profile.containerMeta, refs.containers.length));
  for (const c of metaTargets) {
    const ownerUser = refs.users.length ? rng.pick(refs.users) : null;
    const at = rng.dateBetween(ctx.nowMs - 200 * 864e5, ctx.nowMs - 864e5);
    const r = insMeta.run(
      c.name,
      c.name.split('-').slice(-2).join(' '),
      `Synthetic demo service (${c.project}).`,
      rng.pick(CATEGORIES),
      ownerUser ? ownerUser.displayName : 'Platform',
      rng.pick(META_ICONS),
      rng.pick(META_COLORS),
      JSON.stringify({ synthetic: true, tier: rng.pick(['bronze', 'silver', 'gold']) }),
      at, at,
      datasetId,
    );
    if (r.changes) metaCount += 1;
  }

  const createdBy = refs.users.length ? rng.pick(refs.users).id : null;
  let groupCount = 0;
  let memberCount = 0;
  if (createdBy) {
    const insGroup = db.prepare(`
      INSERT INTO container_groups (name, color, icon, sort_order, scope, created_by, created_at, updated_at, seed_run_id)
      VALUES (?, ?, ?, ?, 'global', ?, ?, ?, ?)
    `);
    const insMember = db.prepare(
      'INSERT OR IGNORE INTO container_group_members (group_id, container_id, added_at, seed_run_id) VALUES (?, ?, ?, ?)',
    );
    const names = rng.shuffle(CONTAINER_GROUP_NAMES);
    const groups = [];
    for (let i = 0; i < profile.containerGroups; i++) {
      const at = rng.dateBetween(ctx.nowMs - 200 * 864e5, ctx.nowMs - 864e5);
      const id = Number(insGroup.run(
        names[i % names.length], META_COLORS[i % META_COLORS.length], META_ICONS[i % META_ICONS.length],
        i, createdBy, at, at, datasetId,
      ).lastInsertRowid);
      groups.push({ id, at });
      groupCount += 1;
    }
    refs.containers.forEach((c, i) => {
      const g = groups[i % groups.length];
      const r = insMember.run(g.id, c.containerId, g.at, datasetId);
      if (r.changes) memberCount += 1;
    });
  }

  ctx.count('container_meta', metaCount);
  ctx.count('container_groups', groupCount);
  ctx.count('container_group_members', memberCount);
  return { count: metaCount + groupCount + memberCount };
}

module.exports = { generate, generateEnrichment };
