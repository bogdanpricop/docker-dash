'use strict';

const { Router } = require('express');
const statsService = require('../services/stats');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

router.get('/overview', requireAuth, (req, res) => {
  try { res.json(statsService.getOverview(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/container/:id', requireAuth, (req, res) => {
  try {
    const { range } = req.query;
    res.json(statsService.query(req.params.id, { range, hostId: req.hostId }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Uptime Report ────────────────────────────────────

router.get('/uptime', requireAuth, (req, res) => {
  try {
    const db = require('../db').getDb();
    const hostId = req.hostId || 0;

    // Get all containers with their event history
    const containers = db.prepare(`
      SELECT DISTINCT container_name, container_id
      FROM container_stats WHERE host_id = ?
      ORDER BY container_name
    `).all(hostId);

    const results = containers.map(c => {
      // Count restarts from docker events
      const restarts = db.prepare(`
        SELECT COUNT(*) AS cnt FROM docker_events
        WHERE actor_name = ? AND action = 'start' AND host_id = ?
      `).get(c.container_name, hostId)?.cnt || 0;

      // Get first and last seen
      const first = db.prepare(
        'SELECT MIN(recorded_at) AS t FROM container_stats WHERE container_id = ? AND host_id = ?'
      ).get(c.container_id, hostId)?.t;
      const last = db.prepare(
        'SELECT MAX(recorded_at) AS t FROM container_stats WHERE container_id = ? AND host_id = ?'
      ).get(c.container_id, hostId)?.t;

      // Count total data points vs expected (rough uptime calc)
      const totalPoints = db.prepare(
        'SELECT COUNT(*) AS cnt FROM container_stats WHERE container_id = ? AND host_id = ?'
      ).get(c.container_id, hostId)?.cnt || 0;

      const hoursTracked = first && last ? (new Date(last) - new Date(first)) / 3600000 : 0;
      const expectedPoints = hoursTracked * (3600000 / (require('../config').stats.collectIntervalMs || 10000));
      const uptimePct = expectedPoints > 0 ? Math.min(100, (totalPoints / expectedPoints) * 100) : 0;

      return {
        container_name: c.container_name,
        container_id: c.container_id,
        restarts: Math.max(0, restarts - 1), // First start isn't a restart
        uptime_pct: Math.round(uptimePct * 10) / 10,
        first_seen: first,
        last_seen: last,
        hours_tracked: Math.round(hoursTracked * 10) / 10,
      };
    });

    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Resource Trends ──────────────────────────────────

router.get('/trends/:id', requireAuth, (req, res) => {
  try {
    const db = require('../db').getDb();
    const hostId = req.hostId || 0;
    const containerId = req.params.id;

    // Get hourly averages for the last 7 days
    const hourly = db.prepare(`
      SELECT cpu_avg AS cpu, mem_avg AS mem, mem_limit, bucket AS time
      FROM container_stats_1h
      WHERE container_id = ? AND host_id = ?
      AND bucket >= datetime('now', '-7 days')
      ORDER BY bucket ASC
    `).all(containerId, hostId);

    if (hourly.length < 2) {
      return res.json({ trend: 'insufficient_data', data: hourly, forecast: null });
    }

    // Simple linear regression on CPU and memory
    const cpuTrend = _linearRegression(hourly.map((h, i) => [i, h.cpu]));
    const memTrend = _linearRegression(hourly.map((h, i) => [i, h.mem]));

    // Forecast: project 24h ahead
    const nextIdx = hourly.length + 24;
    const memLimit = hourly[hourly.length - 1]?.mem_limit || 0;
    const forecastCpu = Math.max(0, cpuTrend.slope * nextIdx + cpuTrend.intercept);
    const forecastMem = Math.max(0, memTrend.slope * nextIdx + memTrend.intercept);

    // Estimate when memory limit will be hit
    let memExhaustedHours = null;
    if (memLimit > 0 && memTrend.slope > 0) {
      const currentMem = hourly[hourly.length - 1].mem;
      memExhaustedHours = Math.round((memLimit - currentMem) / memTrend.slope);
      if (memExhaustedHours < 0 || memExhaustedHours > 8760) memExhaustedHours = null; // cap at 1 year
    }

    res.json({
      data: hourly,
      trend: cpuTrend.slope > 0.1 ? 'increasing' : cpuTrend.slope < -0.1 ? 'decreasing' : 'stable',
      cpu: { slope: cpuTrend.slope, current: hourly[hourly.length - 1]?.cpu || 0, forecast24h: Math.round(forecastCpu * 10) / 10 },
      memory: { slope: memTrend.slope, current: hourly[hourly.length - 1]?.mem || 0, forecast24h: Math.round(forecastMem), limit: memLimit, exhaustedInHours: memExhaustedHours },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Cost Estimation ──────────────────────────────────

router.get('/cost', requireAuth, (req, res) => {
  try {
    const db = require('../db').getDb();
    const hostId = req.hostId || 0;
    const monthlyCost = parseFloat(req.query.monthly_cost || '0');

    if (monthlyCost <= 0) {
      return res.json({ error: 'Set monthly_cost query param (your VPS/server monthly cost in USD)' });
    }

    const overview = statsService.getOverview(hostId);
    const totalCpu = Math.max(overview.totals.cpu, 1);
    const totalMem = Math.max(overview.totals.memory, 1);

    const containers = overview.containers.map(c => {
      const cpuShare = c.cpu_percent / totalCpu;
      const memShare = c.mem_usage / totalMem;
      const weightedShare = (cpuShare + memShare) / 2;
      const estimatedCost = monthlyCost * weightedShare;

      return {
        container_name: c.container_name,
        cpu_percent: c.cpu_percent,
        mem_usage: c.mem_usage,
        cpu_share: Math.round(cpuShare * 1000) / 10,
        mem_share: Math.round(memShare * 1000) / 10,
        estimated_monthly_cost: Math.round(estimatedCost * 100) / 100,
      };
    });

    containers.sort((a, b) => b.estimated_monthly_cost - a.estimated_monthly_cost);

    res.json({
      monthly_total: monthlyCost,
      containers,
      unallocated: Math.round((monthlyCost - containers.reduce((s, c) => s + c.estimated_monthly_cost, 0)) * 100) / 100,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Resource Recommendations ─────────────────────────

router.get('/recommendations', requireAuth, (req, res) => {
  try {
    const db = require('../db').getDb();
    const hostId = req.hostId || 0;

    // Get 24h average stats per container
    const stats = db.prepare(`
      SELECT container_id, container_name,
        AVG(cpu_percent) AS avg_cpu, MAX(cpu_percent) AS max_cpu,
        AVG(mem_usage) AS avg_mem, MAX(mem_usage) AS max_mem,
        AVG(mem_limit) AS mem_limit, COUNT(*) AS samples
      FROM container_stats
      WHERE host_id = ? AND recorded_at >= datetime('now', '-24 hours')
      GROUP BY container_id
      HAVING samples >= 10
    `).all(hostId);

    const recommendations = [];

    for (const s of stats) {
      const recs = [];
      const avgMemPct = s.mem_limit > 0 ? (s.avg_mem / s.mem_limit) * 100 : 0;
      const maxMemPct = s.mem_limit > 0 ? (s.max_mem / s.mem_limit) * 100 : 0;

      // Over-provisioned memory (using <20% of limit consistently)
      if (s.mem_limit > 0 && avgMemPct < 20 && s.mem_limit > 128 * 1024 * 1024) {
        const suggested = Math.max(128 * 1024 * 1024, Math.ceil(s.max_mem * 1.5));
        recs.push({
          type: 'memory_over_provisioned',
          severity: 'info',
          message: `Using only ${avgMemPct.toFixed(0)}% of memory limit. Consider reducing from ${(s.mem_limit / 1024 / 1024).toFixed(0)}MB to ${(suggested / 1024 / 1024).toFixed(0)}MB.`,
          current: s.mem_limit,
          suggested,
        });
      }

      // Memory pressure (consistently >85% of limit)
      if (s.mem_limit > 0 && avgMemPct > 85) {
        const suggested = Math.ceil(s.max_mem * 1.3);
        recs.push({
          type: 'memory_pressure',
          severity: 'warning',
          message: `Using ${avgMemPct.toFixed(0)}% of memory limit (peak: ${maxMemPct.toFixed(0)}%). Risk of OOM kill. Consider increasing to ${(suggested / 1024 / 1024).toFixed(0)}MB.`,
          current: s.mem_limit,
          suggested,
        });
      }

      // No memory limit set (risky for production)
      if (s.mem_limit === 0 && s.avg_mem > 100 * 1024 * 1024) {
        const suggested = Math.ceil(s.max_mem * 1.5);
        recs.push({
          type: 'no_memory_limit',
          severity: 'warning',
          message: `No memory limit set. Average usage: ${(s.avg_mem / 1024 / 1024).toFixed(0)}MB. Set a limit of ${(suggested / 1024 / 1024).toFixed(0)}MB to prevent host OOM.`,
          suggested,
        });
      }

      // High CPU (consistently >80%)
      if (s.avg_cpu > 80) {
        recs.push({
          type: 'high_cpu',
          severity: 'warning',
          message: `Average CPU: ${s.avg_cpu.toFixed(1)}% (peak: ${s.max_cpu.toFixed(1)}%). May need more CPU or optimization.`,
        });
      }

      // Idle container (< 1% CPU and < 50MB memory consistently)
      if (s.avg_cpu < 1 && s.avg_mem < 50 * 1024 * 1024) {
        recs.push({
          type: 'idle',
          severity: 'info',
          message: `Container appears idle (CPU: ${s.avg_cpu.toFixed(1)}%, Memory: ${(s.avg_mem / 1024 / 1024).toFixed(0)}MB). Consider stopping if not needed.`,
        });
      }

      if (recs.length > 0) {
        recommendations.push({
          container_id: s.container_id,
          container_name: s.container_name,
          avg_cpu: Math.round(s.avg_cpu * 10) / 10,
          avg_mem: s.avg_mem,
          mem_limit: s.mem_limit,
          recommendations: recs,
        });
      }
    }

    // Sort: warnings first, then info
    recommendations.sort((a, b) => {
      const aMax = Math.max(...a.recommendations.map(r => r.severity === 'warning' ? 1 : 0));
      const bMax = Math.max(...b.recommendations.map(r => r.severity === 'warning' ? 1 : 0));
      return bMax - aMax;
    });

    res.json({ recommendations, analyzed: stats.length, period: '24h' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function _linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const [x, y] of points) {
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// ─── Cost Analysis (enhanced) ────────────────────────

router.get('/cost-analysis', requireAuth, (req, res) => {
  try {
    const db = require('../db').getDb();
    const hostId = req.hostId || 0;

    // Get monthly cost from settings or query param
    let monthlyCost = parseFloat(req.query.monthly_cost || '0');
    if (monthlyCost <= 0) {
      try {
        const setting = db.prepare("SELECT value FROM settings WHERE key = 'monthly_server_cost'").get();
        monthlyCost = parseFloat(setting?.value || '0');
      } catch { /* settings table may not exist */ }
    }
    if (monthlyCost <= 0) monthlyCost = 50; // default fallback

    const overview = statsService.getOverview(hostId);
    const totalCpu = Math.max(overview.totals.cpu, 1);
    const totalMem = Math.max(overview.totals.memory, 1);

    // Cost per container
    const containers = overview.containers.map(c => {
      const cpuShare = c.cpu_percent / totalCpu;
      const memShare = c.mem_usage / totalMem;
      const weightedShare = (cpuShare + memShare) / 2;
      const estimatedCost = monthlyCost * weightedShare;

      return {
        container_name: c.container_name,
        container_id: c.container_id,
        cpu_percent: Math.round(c.cpu_percent * 10) / 10,
        mem_usage: c.mem_usage,
        mem_limit: c.mem_limit || 0,
        cpu_share: Math.round(cpuShare * 1000) / 10,
        mem_share: Math.round(memShare * 1000) / 10,
        estimated_monthly_cost: Math.round(estimatedCost * 100) / 100,
      };
    });
    containers.sort((a, b) => b.estimated_monthly_cost - a.estimated_monthly_cost);

    // Get 24h recommendations
    let recommendations = [];
    try {
      const stats = db.prepare(`
        SELECT container_id, container_name,
          AVG(cpu_percent) AS avg_cpu, MAX(cpu_percent) AS max_cpu,
          AVG(mem_usage) AS avg_mem, MAX(mem_usage) AS max_mem,
          AVG(mem_limit) AS mem_limit, COUNT(*) AS samples
        FROM container_stats
        WHERE host_id = ? AND recorded_at >= datetime('now', '-24 hours')
        GROUP BY container_id HAVING samples >= 10
      `).all(hostId);

      for (const s of stats) {
        const avgMemPct = s.mem_limit > 0 ? (s.avg_mem / s.mem_limit) * 100 : 0;

        // Over-provisioned
        if (s.mem_limit > 0 && avgMemPct < 20 && s.mem_limit > 128 * 1024 * 1024) {
          const suggested = Math.max(128 * 1024 * 1024, Math.ceil(s.max_mem * 1.5));
          const costSaving = (1 - suggested / s.mem_limit) * (monthlyCost * ((s.avg_mem / totalMem + s.avg_cpu / totalCpu) / 2));
          recommendations.push({
            container_name: s.container_name,
            container_id: s.container_id,
            type: 'over_provisioned',
            severity: 'info',
            message: `Using ${avgMemPct.toFixed(0)}% of ${Math.round(s.mem_limit / 1024 / 1024)}MB limit. Reduce to ${Math.round(suggested / 1024 / 1024)}MB.`,
            current: s.mem_limit,
            suggested,
            monthly_savings: Math.round(Math.abs(costSaving) * 100) / 100,
          });
        }

        // Idle
        if (s.avg_cpu < 1 && s.avg_mem < 50 * 1024 * 1024) {
          const containerCost = containers.find(c => c.container_id === s.container_id);
          recommendations.push({
            container_name: s.container_name,
            container_id: s.container_id,
            type: 'idle',
            severity: 'warning',
            message: `Idle for 24h (CPU: ${s.avg_cpu.toFixed(1)}%, Mem: ${Math.round(s.avg_mem / 1024 / 1024)}MB). Consider stopping.`,
            monthly_savings: containerCost?.estimated_monthly_cost || 0,
          });
        }

        // Memory pressure
        if (s.mem_limit > 0 && avgMemPct > 85) {
          const suggested = Math.ceil(s.max_mem * 1.3);
          recommendations.push({
            container_name: s.container_name,
            container_id: s.container_id,
            type: 'memory_pressure',
            severity: 'warning',
            message: `Using ${avgMemPct.toFixed(0)}% of memory limit. Risk of OOM. Increase to ${Math.round(suggested / 1024 / 1024)}MB.`,
            current: s.mem_limit,
            suggested,
            monthly_savings: 0,
          });
        }
      }
    } catch { /* stats table may not have data */ }

    const totalSavings = recommendations.reduce((s, r) => s + (r.monthly_savings || 0), 0);
    const idleContainers = recommendations.filter(r => r.type === 'idle');
    const idleCost = idleContainers.reduce((s, r) => s + (r.monthly_savings || 0), 0);

    res.json({
      monthly_total: monthlyCost,
      containers,
      recommendations,
      savings_potential: Math.round(totalSavings * 100) / 100,
      idle_count: idleContainers.length,
      idle_cost: Math.round(idleCost * 100) / 100,
      unallocated: Math.round((monthlyCost - containers.reduce((s, c) => s + c.estimated_monthly_cost, 0)) * 100) / 100,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Cost Settings ───────────────────────────────────

router.post('/cost-settings', requireAuth, (req, res) => {
  try {
    const db = require('../db').getDb();
    const { monthly_cost } = req.body;
    if (monthly_cost === undefined || isNaN(parseFloat(monthly_cost))) {
      return res.status(400).json({ error: 'monthly_cost required (number)' });
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('monthly_server_cost', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(monthly_cost));
    res.json({ ok: true, monthly_cost: parseFloat(monthly_cost) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
