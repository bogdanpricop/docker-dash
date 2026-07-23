'use strict';

// v8.17.0 (Onboarding — Phase 3) — bounded synthetic metric series.
//
// ── The volume-critical module (the docker_events lesson, encoded) ──────────
// Stats dominate the row count of any realistic dataset, so this module is
// deliberately DOWNSAMPLED and BUDGET-GUARDED:
//   * running containers ONLY (exited/created/paused produce no series);
//   * the 1m tier is a 10-MINUTE cadence over 24h (144 buckets, not 1440) and is
//     SKIPPED ENTIRELY on `large`;
//   * the raw tier is a 15-minute tail only (the live sparkline) and is skipped
//     on `large`;
//   * every insert decrements `ctx.budget.stats`; when it would go negative the
//     module STOPS rather than exceeding the cap. The orchestrator additionally
//     asserts the caps before COMMIT, so a future profile edit can never silently
//     reintroduce bloat.
//
// Bucket strings must match src/services/stats.js exactly, otherwise the charts
// read nothing:
//   1m = '%Y-%m-%d %H:%M:00' · 1h = '%Y-%m-%d %H:00:00' · 1d = '%Y-%m-%d 00:00:00'

const ROLLUP_COLS = `
  (host_id, container_id, container_name, cpu_avg, cpu_max, mem_avg, mem_max, mem_limit,
   net_rx_total, net_tx_total, blk_read_total, blk_write_total, pids_avg, sample_count, bucket, seed_run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const MEM_LIMITS = [256, 512, 1024, 2048, 4096].map((mb) => mb * 1024 * 1024);

/** Per-container baseline so a container's series looks like ITSELF over time. */
function _baselines(rng, roster) {
  const map = new Map();
  for (const c of roster) {
    map.set(c.containerId, {
      cpu: rng.range(1.5, 45),
      cpuSd: rng.range(0.4, 6),
      memLimit: rng.pick(MEM_LIMITS),
      memFrac: rng.range(0.18, 0.72),
      netRate: rng.int(2_000, 900_000),      // bytes per bucket-ish
      blkRate: rng.int(1_000, 400_000),
      pids: rng.int(3, 90),
    });
  }
  return map;
}

function _bucket1m(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ':00'; }
function _bucket1h(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 13) + ':00:00'; }
function _bucket1d(ms) { return new Date(ms).toISOString().slice(0, 10) + ' 00:00:00'; }

function generate(ctx) {
  const { db, rng, datasetId, profile, refs, budget } = ctx;
  const running = refs.running || [];
  if (!running.length) return { count: 0 };

  const base = _baselines(rng, running);
  const ins1m = db.prepare(`INSERT OR IGNORE INTO container_stats_1m ${ROLLUP_COLS}`);
  const ins1h = db.prepare(`INSERT OR IGNORE INTO container_stats_1h ${ROLLUP_COLS}`);
  const ins1d = db.prepare(`INSERT OR IGNORE INTO container_stats_1d ${ROLLUP_COLS}`);
  const insRaw = db.prepare(`
    INSERT INTO container_stats
      (host_id, container_id, container_name, cpu_percent, mem_usage, mem_limit, mem_percent,
       net_rx, net_tx, blk_read, blk_write, pids, recorded_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Monotonic cumulative counters per container (net/blk totals only ever grow).
  const acc = new Map(running.map((c) => [c.containerId, { rx: 0, tx: 0, rd: 0, wr: 0 }]));
  const counts = { container_stats: 0, container_stats_1m: 0, container_stats_1h: 0, container_stats_1d: 0 };

  const emitRollup = (stmt, table, c, bucket, spanFactor) => {
    if (budget.stats <= 0) return false;
    const b = base.get(c.containerId);
    const a = acc.get(c.containerId);
    const cpuAvg = Math.round(rng.gaussian(b.cpu, b.cpuSd, 0.05, 400) * 100) / 100;
    const cpuMax = Math.round(Math.min(400, cpuAvg * rng.range(1.05, 1.8)) * 100) / 100;
    const memAvg = Math.round(b.memLimit * Math.min(0.97, Math.max(0.02, rng.gaussian(b.memFrac, 0.06))));
    const memMax = Math.min(b.memLimit, Math.round(memAvg * rng.range(1.02, 1.25)));
    a.rx += Math.round(b.netRate * spanFactor * rng.range(0.6, 1.5));
    a.tx += Math.round(b.netRate * spanFactor * rng.range(0.4, 1.2));
    a.rd += Math.round(b.blkRate * spanFactor * rng.range(0.3, 1.4));
    a.wr += Math.round(b.blkRate * spanFactor * rng.range(0.2, 1.1));
    const r = stmt.run(
      c.hostId, c.containerId, c.name, cpuAvg, cpuMax, memAvg, memMax, b.memLimit,
      a.rx, a.tx, a.rd, a.wr, Math.round(rng.gaussian(b.pids, 3, 1) * 10) / 10,
      Math.max(1, Math.round(spanFactor * 6)), bucket, datasetId,
    );
    if (r.changes) { counts[table] += 1; budget.stats -= 1; }
    return true;
  };

  // ── 1m tier: 10-minute cadence over the last 24h (skipped when step === 0) ──
  if (profile.stats1mStepMinutes > 0 && profile.stats1mHours > 0) {
    const stepMs = profile.stats1mStepMinutes * 60000;
    const buckets = Math.floor((profile.stats1mHours * 60) / profile.stats1mStepMinutes);
    const start = Math.floor((ctx.nowMs - buckets * stepMs) / stepMs) * stepMs;
    for (let i = 0; i < buckets; i++) {
      const bucket = _bucket1m(start + i * stepMs);
      for (const c of running) if (!emitRollup(ins1m, 'container_stats_1m', c, bucket, 1)) break;
    }
  }

  // ── 1h tier: hourly over the last 7 days ───────────────────────────────────
  {
    const hours = profile.stats1hDays * 24;
    const start = Math.floor((ctx.nowMs - hours * 36e5) / 36e5) * 36e5;
    for (let i = 0; i < hours; i++) {
      const bucket = _bucket1h(start + i * 36e5);
      for (const c of running) if (!emitRollup(ins1h, 'container_stats_1h', c, bucket, 6)) break;
    }
  }

  // ── 1d tier: daily over 30 (s/m) or 90 (l) days ────────────────────────────
  {
    const days = profile.stats1dDays;
    const start = Math.floor((ctx.nowMs - days * 864e5) / 864e5) * 864e5;
    for (let i = 0; i < days; i++) {
      const bucket = _bucket1d(start + i * 864e5);
      for (const c of running) if (!emitRollup(ins1d, 'container_stats_1d', c, bucket, 144)) break;
    }
  }

  // ── raw tail: 1/min for the last N minutes (live sparkline only) ───────────
  if (profile.statsRawMinutes > 0) {
    for (let i = profile.statsRawMinutes; i > 0; i--) {
      const at = ctx.toSqlTime(ctx.nowMs - i * 60000);
      for (const c of running) {
        if (budget.stats <= 0) break;
        const b = base.get(c.containerId);
        const a = acc.get(c.containerId);
        const cpu = Math.round(rng.gaussian(b.cpu, b.cpuSd, 0.05, 400) * 100) / 100;
        const mem = Math.round(b.memLimit * Math.min(0.97, Math.max(0.02, rng.gaussian(b.memFrac, 0.05))));
        a.rx += rng.int(500, 40000); a.tx += rng.int(400, 30000);
        a.rd += rng.int(200, 20000); a.wr += rng.int(100, 15000);
        insRaw.run(
          c.hostId, c.containerId, c.name, cpu, mem, b.memLimit,
          Math.round((mem / b.memLimit) * 10000) / 100,
          a.rx, a.tx, a.rd, a.wr, Math.round(rng.gaussian(b.pids, 2, 1)), at, datasetId,
        );
        counts.container_stats += 1; budget.stats -= 1;
      }
    }
  }

  for (const [table, n] of Object.entries(counts)) ctx.count(table, n);
  return { count: Object.values(counts).reduce((s, n) => s + n, 0) };
}

module.exports = { generate };
