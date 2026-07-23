'use strict';

// v8.17.0 (Onboarding — Phase 3) — bounded lifecycle events + health transitions.
//
// ── HARD RULE: no `exec_*`, ever ────────────────────────────────────────────
// The v8.12.0 incident was a 31 GB database with 19.4 M `docker_events` rows in
// four days, >95 % of them healthcheck `exec_create`/`exec_start` noise. The
// generator emits LIFECYCLE ACTIONS ONLY, from the closed list below, and
// `exec_sessions` is never seeded at all. The acceptance test asserts
// `COUNT(*) WHERE action LIKE 'exec_%'` is zero.

// Closed allow-list. Adding `exec_*` here would be caught by the test — that is
// the point of writing it as a constant.
const CONTAINER_ACTIONS = [
  ['start', 6], ['stop', 3], ['die', 2], ['create', 3], ['destroy', 1], ['health_status: healthy', 2],
];
const IMAGE_ACTIONS = [['pull', 4], ['tag', 1]];

function generate(ctx) {
  const { db, rng, datasetId, profile, refs } = ctx;
  if (!refs.containers.length) return { count: 0 };

  const ins = db.prepare(`
    INSERT INTO docker_events (host_id, event_type, action, actor_id, actor_name, attributes, event_time, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const windowMs = 7 * 864e5;
  const times = [];
  for (let i = 0; i < profile.events; i++) times.push(rng.int(0, windowMs));
  times.sort((a, b) => a - b);   // chronological, like a real event stream

  let count = 0;
  for (const offset of times) {
    const at = ctx.toSqlTime(ctx.nowMs - windowMs + offset);
    const isImage = rng.bool(0.18);
    const c = rng.pick(refs.containers);
    if (isImage) {
      ins.run(
        c.hostId, 'image', rng.weighted(IMAGE_ACTIONS), c.image, c.image,
        JSON.stringify({ name: c.image }), at, datasetId,
      );
    } else {
      const action = rng.weighted(CONTAINER_ACTIONS);
      ins.run(
        c.hostId, 'container', action, c.containerId, c.name,
        JSON.stringify({ image: c.image, name: c.name, 'com.docker.compose.project': c.project }),
        at, datasetId,
      );
    }
    count += 1;
  }
  ctx.count('docker_events', count);

  // ── health transitions (a small, story-shaped set) ────────────────────────
  const insHealth = db.prepare(`
    INSERT INTO health_events (host_id, container_id, container_name, status, output, exit_code, recorded_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const unhealthyPool = rng.sample(refs.running || [], Math.max(1, ctx.scenario.unhealthyContainers || 1));
  let health = 0;
  for (let i = 0; i < profile.healthEvents; i++) {
    const c = unhealthyPool.length && rng.bool(0.6) ? rng.pick(unhealthyPool) : rng.pick(refs.containers);
    const unhealthy = rng.bool(0.35);
    insHealth.run(
      c.hostId, c.containerId, c.name,
      unhealthy ? 'unhealthy' : 'healthy',
      unhealthy ? 'probe failed: connection refused' : 'OK',
      unhealthy ? 1 : 0,
      ctx.toSqlTime(ctx.nowMs - rng.int(0, windowMs)),
      datasetId,
    );
    health += 1;
  }
  ctx.count('health_events', health);
  return { count: count + health };
}

module.exports = { generate, CONTAINER_ACTIONS, IMAGE_ACTIONS };
