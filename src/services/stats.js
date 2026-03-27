'use strict';

const { EventEmitter } = require('events');
const { getDb } = require('../db');
const dockerService = require('./docker');
const config = require('../config');
const log = require('../utils/logger')('stats');
const { now } = require('../utils/helpers');

class StatsService extends EventEmitter {
  constructor() {
    super();
    this._intervals = new Map(); // hostId → intervalId
  }

  /** Start periodic stats collection for all active hosts */
  start() {
    if (this._intervals.size > 0) return;
    this._startCollectors();
    log.info('Stats collector started', { intervalMs: config.stats.collectIntervalMs });
  }

  /** Start/refresh collectors for all active hosts */
  _startCollectors() {
    const hosts = dockerService.getActiveHosts();
    const activeIds = new Set(hosts.map(h => h.id));

    // Stop collectors for removed/disabled hosts
    for (const [hostId, intervalId] of this._intervals) {
      if (!activeIds.has(hostId)) {
        clearInterval(intervalId);
        this._intervals.delete(hostId);
        log.debug(`Stats collector stopped for host ${hostId}`);
      }
    }

    // Start collectors for new/missing hosts
    if (!this._errorCooldown) this._errorCooldown = new Map(); // hostId → lastErrorTime
    for (const host of hosts) {
      if (!this._intervals.has(host.id)) {
        const id = setInterval(() => {
          this.collect(host.id).catch(e => {
            // Rate-limit error logging: max once per 5 minutes per host
            const lastErr = this._errorCooldown.get(host.id) || 0;
            if (Date.now() - lastErr > 300000) {
              log.warn(`Stats collection skipped for host ${host.id} (${host.name}): ${e.message}`);
              this._errorCooldown.set(host.id, Date.now());
            }
          });
        }, config.stats.collectIntervalMs);
        this._intervals.set(host.id, id);
        log.debug(`Stats collector started for host ${host.id} (${host.name})`);
      }
    }
  }

  /** Refresh collectors (call when hosts are added/removed) */
  refreshHosts() {
    this._startCollectors();
  }

  stop() {
    for (const [, intervalId] of this._intervals) {
      clearInterval(intervalId);
    }
    this._intervals.clear();
  }

  /** Collect stats for all running containers on a specific host */
  async collect(hostId = 0) {
    const db = getDb();
    const containers = await dockerService.listContainers(hostId);
    const running = containers.filter(c => c.state === 'running');

    const insert = db.prepare(`
      INSERT INTO container_stats (host_id, container_id, container_name, cpu_percent,
        mem_usage, mem_limit, mem_percent, net_rx, net_tx, blk_read, blk_write, pids, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const timestamp = now();
    const insertMany = db.transaction((rows) => {
      for (const r of rows) insert.run(...r);
    });

    const rows = [];
    await Promise.allSettled(running.map(async (c) => {
      try {
        const s = await dockerService.getContainerStats(c.id, hostId);
        rows.push([hostId, c.id, c.name, s.cpuPercent, s.memUsage, s.memLimit,
          s.memPercent, s.netRx, s.netTx, s.blkRead, s.blkWrite, s.pids, timestamp]);
      } catch { /* container may have stopped */ }
    }));

    if (rows.length > 0) insertMany(rows);

    const liveData = rows.map(r => ({
      containerId: r[1], name: r[2], cpu: r[3],
      memUsage: r[4], memLimit: r[5], memPercent: r[6],
      netRx: r[7], netTx: r[8], pids: r[11],
      hostId,
    }));
    this.emit('collected', liveData, hostId);

    return rows.length;
  }

  /** Aggregate raw stats into 1-minute buckets */
  aggregate1m() {
    const db = getDb();
    const cutoff = new Date(Date.now() - 120000).toISOString().replace('T', ' ').substring(0, 16) + ':00';

    db.exec(`
      INSERT OR IGNORE INTO container_stats_1m (host_id, container_id, container_name,
        cpu_avg, cpu_max, mem_avg, mem_max, mem_limit,
        net_rx_total, net_tx_total, blk_read_total, blk_write_total,
        pids_avg, sample_count, bucket)
      SELECT host_id, container_id, container_name,
        AVG(cpu_percent), MAX(cpu_percent),
        AVG(mem_usage), MAX(mem_usage), MAX(mem_limit),
        MAX(net_rx), MAX(net_tx),
        MAX(blk_read), MAX(blk_write),
        AVG(pids), COUNT(*),
        strftime('%Y-%m-%d %H:%M:00', recorded_at)
      FROM container_stats
      WHERE recorded_at < '${cutoff}'
      GROUP BY host_id, container_id, strftime('%Y-%m-%d %H:%M', recorded_at)
    `);
  }

  /** Aggregate 1m stats into 1-hour buckets */
  aggregate1h() {
    const db = getDb();
    db.exec(`
      INSERT OR IGNORE INTO container_stats_1h (host_id, container_id, container_name,
        cpu_avg, cpu_max, mem_avg, mem_max, mem_limit,
        net_rx_total, net_tx_total, blk_read_total, blk_write_total,
        pids_avg, sample_count, bucket)
      SELECT host_id, container_id, container_name,
        AVG(cpu_avg), MAX(cpu_max),
        AVG(mem_avg), MAX(mem_max), MAX(mem_limit),
        SUM(net_rx_total), SUM(net_tx_total),
        SUM(blk_read_total), SUM(blk_write_total),
        AVG(pids_avg), SUM(sample_count),
        strftime('%Y-%m-%d %H:00:00', bucket)
      FROM container_stats_1m
      WHERE bucket < datetime('now', '-65 minutes')
      GROUP BY host_id, container_id, strftime('%Y-%m-%d %H', bucket)
    `);
  }

  /** Purge old data based on retention settings */
  purge() {
    const db = getDb();
    const r1 = db.prepare(`DELETE FROM container_stats WHERE recorded_at < datetime('now', '-' || ? || ' hours')`).run(config.stats.retentionRawHours);
    const r2 = db.prepare(`DELETE FROM container_stats_1m WHERE bucket < datetime('now', '-' || ? || ' days')`).run(config.stats.retention1mDays);
    const r3 = db.prepare(`DELETE FROM container_stats_1h WHERE bucket < datetime('now', '-' || ? || ' days')`).run(config.stats.retention1hDays);
    if (r1.changes + r2.changes + r3.changes > 0) {
      log.debug('Stats purged', { raw: r1.changes, '1m': r2.changes, '1h': r3.changes });
    }
  }

  /** Query stats for a container with auto-granularity */
  query(containerId, { range = '1h', hostId = 0 } = {}) {
    const db = getDb();
    const ranges = {
      '1h': { table: 'container_stats', since: "datetime('now', '-1 hour')", cols: 'cpu_percent as cpu, mem_usage as mem, mem_limit, net_rx, net_tx, blk_read, blk_write, pids, recorded_at as time' },
      '6h': { table: 'container_stats', since: "datetime('now', '-6 hours')", cols: 'cpu_percent as cpu, mem_usage as mem, mem_limit, net_rx, net_tx, blk_read, blk_write, pids, recorded_at as time' },
      '24h': { table: 'container_stats_1m', since: "datetime('now', '-24 hours')", cols: 'cpu_avg as cpu, mem_avg as mem, mem_limit, net_rx_total as net_rx, net_tx_total as net_tx, blk_read_total as blk_read, blk_write_total as blk_write, pids_avg as pids, bucket as time' },
      '7d': { table: 'container_stats_1h', since: "datetime('now', '-7 days')", cols: 'cpu_avg as cpu, mem_avg as mem, mem_limit, net_rx_total as net_rx, net_tx_total as net_tx, blk_read_total as blk_read, blk_write_total as blk_write, pids_avg as pids, bucket as time' },
      '30d': { table: 'container_stats_1h', since: "datetime('now', '-30 days')", cols: 'cpu_avg as cpu, mem_avg as mem, mem_limit, net_rx_total as net_rx, net_tx_total as net_tx, blk_read_total as blk_read, blk_write_total as blk_write, pids_avg as pids, bucket as time' },
    };
    const r = ranges[range] || ranges['1h'];
    return db.prepare(`SELECT ${r.cols} FROM ${r.table} WHERE container_id = ? AND host_id = ? AND time >= ${r.since} ORDER BY time ASC`).all(containerId, hostId);
  }

  /** Get overview stats - top CPU, memory consumers */
  getOverview(hostId = 0) {
    const db = getDb();
    const latest = db.prepare(`
      SELECT container_id, container_name, cpu_percent, mem_usage, mem_limit, mem_percent,
             net_rx, net_tx, pids, recorded_at
      FROM container_stats
      WHERE recorded_at = (SELECT MAX(recorded_at) FROM container_stats WHERE host_id = ?)
        AND host_id = ?
      ORDER BY cpu_percent DESC
    `).all(hostId, hostId);

    return {
      containers: latest,
      topCpu: latest.slice(0, 5),
      topMemory: [...latest].sort((a, b) => b.mem_usage - a.mem_usage).slice(0, 5),
      totals: {
        cpu: latest.reduce((s, c) => s + c.cpu_percent, 0),
        memory: latest.reduce((s, c) => s + c.mem_usage, 0),
        memoryLimit: latest.reduce((s, c) => s + (c.mem_limit || 0), 0),
      },
    };
  }
}

module.exports = new StatsService();
