'use strict';

// v8.4.0 — daily stats rollup (4th tier). Verifies aggregate1d() rolls 1h
// buckets into UTC-day buckets and that the '30d'/'90d' query ranges read
// from container_stats_1d.

process.env.APP_SECRET = 'test-secret-for-stats1d';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';

const { getDb } = require('../db');
const db = getDb();
const statsService = require('../services/stats');

const CID = 'aabbccddeeff';

function insert1h(bucket, { cpuAvg, cpuMax, memAvg, memMax, netRx, netTx, samples }) {
  db.prepare(`
    INSERT INTO container_stats_1h (host_id, container_id, container_name,
      cpu_avg, cpu_max, mem_avg, mem_max, mem_limit,
      net_rx_total, net_tx_total, blk_read_total, blk_write_total,
      pids_avg, sample_count, bucket)
    VALUES (0, ?, 'web', ?, ?, ?, ?, 1000000, ?, ?, 0, 0, 5, ?, ?)
  `).run(CID, cpuAvg, cpuMax, memAvg, memMax, netRx, netTx, samples, bucket);
}

describe('stats aggregate1d', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM container_stats_1h').run();
    db.prepare('DELETE FROM container_stats_1d').run();
  });

  it('rolls multiple 1h buckets within a day into one 1d bucket', () => {
    // Two hourly buckets on the same UTC day, well past the 25h guard.
    insert1h('2026-04-01 10:00:00', { cpuAvg: 20, cpuMax: 40, memAvg: 100, memMax: 150, netRx: 1000, netTx: 500, samples: 6 });
    insert1h('2026-04-01 11:00:00', { cpuAvg: 40, cpuMax: 80, memAvg: 200, memMax: 250, netRx: 2000, netTx: 800, samples: 6 });

    statsService.aggregate1d();

    const rows = db.prepare('SELECT * FROM container_stats_1d WHERE container_id = ?').all(CID);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.bucket).toBe('2026-04-01 00:00:00');
    expect(r.cpu_avg).toBe(30);   // AVG(20, 40)
    expect(r.cpu_max).toBe(80);   // MAX(40, 80)
    expect(r.net_rx_total).toBe(3000); // SUM(1000, 2000)
    expect(r.net_tx_total).toBe(1300); // SUM(500, 800)
    expect(r.sample_count).toBe(12);   // SUM(6, 6)
  });

  it('keeps separate days in separate buckets', () => {
    insert1h('2026-04-01 10:00:00', { cpuAvg: 10, cpuMax: 10, memAvg: 100, memMax: 100, netRx: 100, netTx: 100, samples: 6 });
    insert1h('2026-04-02 10:00:00', { cpuAvg: 50, cpuMax: 50, memAvg: 200, memMax: 200, netRx: 200, netTx: 200, samples: 6 });

    statsService.aggregate1d();

    const rows = db.prepare('SELECT bucket FROM container_stats_1d WHERE container_id = ? ORDER BY bucket').all(CID);
    expect(rows.map(r => r.bucket)).toEqual(['2026-04-01 00:00:00', '2026-04-02 00:00:00']);
  });

  it('is idempotent — re-running does not duplicate buckets', () => {
    insert1h('2026-04-01 10:00:00', { cpuAvg: 20, cpuMax: 40, memAvg: 100, memMax: 150, netRx: 1000, netTx: 500, samples: 6 });
    statsService.aggregate1d();
    statsService.aggregate1d();
    const rows = db.prepare('SELECT * FROM container_stats_1d WHERE container_id = ?').all(CID);
    expect(rows).toHaveLength(1);
  });

  it('does not aggregate 1h buckets newer than the 25h guard', () => {
    const recent = new Date(Date.now() - 2 * 3600000).toISOString().replace('T', ' ').substring(0, 13) + ':00:00';
    insert1h(recent, { cpuAvg: 20, cpuMax: 40, memAvg: 100, memMax: 150, netRx: 1000, netTx: 500, samples: 6 });
    statsService.aggregate1d();
    const rows = db.prepare('SELECT * FROM container_stats_1d WHERE container_id = ?').all(CID);
    expect(rows).toHaveLength(0);
  });

  it('30d query range reads from container_stats_1d', () => {
    db.prepare('DELETE FROM container_stats_1d').run();
    db.prepare(`
      INSERT INTO container_stats_1d (host_id, container_id, container_name,
        cpu_avg, cpu_max, mem_avg, mem_max, mem_limit, net_rx_total, net_tx_total,
        blk_read_total, blk_write_total, pids_avg, sample_count, bucket)
      VALUES (0, ?, 'web', 33, 66, 128, 256, 1000000, 5000, 2000, 0, 0, 4, 144,
        strftime('%Y-%m-%d 00:00:00', datetime('now', '-3 days')))
    `).run(CID);

    const out = statsService.query(CID, { range: '30d', hostId: 0 });
    expect(out).toHaveLength(1);
    expect(out[0].cpu).toBe(33);
    expect(out[0].mem).toBe(128);
  });
});
