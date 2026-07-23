'use strict';

// v8.17.0 (Onboarding — Phase 3) — volume profiles + the HARD row budget.
//
// ── Why the budget exists (the docker_events bloat lesson, encoded) ─────────
// v8.12.0 shipped a fix for a 31 GB database: 19.4 M docker_events rows in four
// days, >95 % of them healthcheck `exec_*` noise. The generator inherits three
// non-negotiable rules from that incident:
//   1. A HARD global row cap (MAX_TOTAL_ROWS) asserted before COMMIT — a future
//      profile edit can never silently reintroduce bloat; violating it ROLLBACKs.
//   2. `exec_*` docker_events are NEVER emitted (and `exec_sessions` is never seeded).
//   3. Stats are DOWNSAMPLED: running containers only, 10-minute 1m cadence, and
//      the 1m tier is dropped entirely on `large`.
// Even `large` lands at ~62 k rows / < 25 MB — roughly 300x under a single bad day.

const PROFILES = Object.freeze({
  small: Object.freeze({
    key: 'small',
    users: 3,
    hosts: 3,
    hostGroups: 1,
    teams: 1,
    permissions: 3,
    registries: 1,
    containers: 12,
    running: 10,
    containerMeta: 8,
    containerGroups: 2,
    stats1mStepMinutes: 10,   // 24h / 10min = 144 buckets
    stats1mHours: 24,
    stats1hDays: 7,
    stats1dDays: 30,
    statsRawMinutes: 15,      // live-sparkline tail, 1/min
    events: 40,
    healthEvents: 10,
    firewallSnapshots: 3,
    firewallRules: 6,
    postureSnapshots: 14,
    postureMutes: 0,
    blueprints: 1,
    blueprintRuns: 3,
    nomenclatures: 25,
    auditRows: 60,
  }),
  medium: Object.freeze({
    key: 'medium',
    users: 8,
    hosts: 8,
    hostGroups: 2,
    teams: 3,
    permissions: 8,
    registries: 2,
    containers: 45,
    running: 35,
    containerMeta: 25,
    containerGroups: 4,
    stats1mStepMinutes: 10,
    stats1mHours: 24,
    stats1hDays: 7,
    stats1dDays: 30,
    statsRawMinutes: 15,
    events: 120,
    healthEvents: 30,
    firewallSnapshots: 8,
    firewallRules: 20,
    postureSnapshots: 30,
    postureMutes: 2,
    blueprints: 1,
    blueprintRuns: 3,
    nomenclatures: 40,
    auditRows: 150,
  }),
  large: Object.freeze({
    key: 'large',
    users: 15,
    hosts: 20,
    hostGroups: 4,
    teams: 5,
    permissions: 15,
    registries: 3,
    containers: 150,
    running: 120,
    stats1mStepMinutes: 0,    // 0 = tier SKIPPED entirely (volume guard)
    stats1mHours: 0,
    containerMeta: 60,
    containerGroups: 6,
    stats1hDays: 7,
    stats1dDays: 90,
    statsRawMinutes: 0,       // raw tail skipped on large
    events: 300,
    healthEvents: 60,
    firewallSnapshots: 20,
    firewallRules: 40,
    postureSnapshots: 60,
    postureMutes: 4,
    blueprints: 2,
    blueprintRuns: 6,
    nomenclatures: 60,
    auditRows: 300,
  }),
});

const PROFILE_KEYS = Object.freeze(Object.keys(PROFILES));

// Defensive tripwires asserted by the orchestrator before COMMIT.
const MAX_TOTAL_ROWS = 100000;
const MAX_STATS_ROWS = 80000;

/** Resolve a profile key to its frozen count matrix; throws on an unknown key. */
function getProfile(key) {
  const p = PROFILES[key];
  if (!p) throw new Error(`unknown seed profile ${JSON.stringify(key)} (expected ${PROFILE_KEYS.join('|')})`);
  return p;
}

/**
 * Pure row-count estimate for a (profile, scenario) pair — NO database access,
 * no writes. Drives the wizard's step-7 volume preview and the preview/summary
 * "will create N rows across M tables" line.
 * @returns {{profile:string, scenario:string, total:number, tables:{name:string,count:number}[]}}
 */
function estimate({ profile = 'medium', scenario = 'healthy-shop' } = {}) {
  const p = getProfile(profile);
  const running = Math.min(p.running, p.containers);

  const stats1m = p.stats1mStepMinutes > 0
    ? Math.floor((p.stats1mHours * 60) / p.stats1mStepMinutes) * running : 0;
  const stats1h = p.stats1hDays * 24 * running;
  const stats1d = p.stats1dDays * running;
  const statsRaw = p.statsRawMinutes * running;

  const tables = [
    { name: 'nomenclatures', count: p.nomenclatures },
    { name: 'users', count: p.users },
    { name: 'user_tenants', count: p.users },
    { name: 'docker_hosts', count: p.hosts },
    { name: 'host_groups', count: p.hostGroups },
    { name: 'host_group_members', count: p.hosts },
    { name: 'teams', count: p.teams },
    { name: 'team_members', count: p.users },
    { name: 'host_permissions', count: p.permissions },
    { name: 'registries', count: p.registries },
    { name: 'seed_containers', count: p.containers },
    { name: 'container_meta', count: Math.min(p.containerMeta, p.containers) },
    { name: 'container_groups', count: p.containerGroups },
    { name: 'container_group_members', count: p.containers },
    { name: 'container_stats', count: statsRaw },
    { name: 'container_stats_1m', count: stats1m },
    { name: 'container_stats_1h', count: stats1h },
    { name: 'container_stats_1d', count: stats1d },
    { name: 'docker_events', count: p.events },
    { name: 'health_events', count: p.healthEvents },
    { name: 'firewall_snapshots', count: Math.min(p.firewallSnapshots, p.hosts) },
    { name: 'firewall_rules', count: p.firewallRules },
    { name: 'posture_snapshots', count: p.postureSnapshots },
    { name: 'posture_mutes', count: p.postureMutes },
    { name: 'blueprints', count: p.blueprints },
    { name: 'blueprint_runs', count: p.blueprintRuns },
    { name: 'audit_log', count: p.auditRows },
  ].filter((t) => t.count > 0);

  const total = tables.reduce((s, t) => s + t.count, 0);
  const stats = stats1m + stats1h + stats1d + statsRaw;
  return { profile: p.key, scenario, total, stats, tables };
}

module.exports = { PROFILES, PROFILE_KEYS, MAX_TOTAL_ROWS, MAX_STATS_ROWS, getProfile, estimate };
