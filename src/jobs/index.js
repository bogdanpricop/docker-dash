'use strict';

const cron = require('node-cron');
const fs = require('fs');
const statsService = require('../services/stats');
const alertService = require('../services/alerts');
const auditService = require('../services/audit');
const authService = require('../services/auth');
const dockerService = require('../services/docker');
const { dockerEvents } = require('../services/misc');
const { getDb } = require('../db');
const config = require('../config');
const log = require('../utils/logger')('jobs');

const jobs = [];

/**
 * Purge all data older than retention limits from every table.
 * Runs hourly and logs a summary of what was deleted.
 */
function purgeAllOldData() {
  const db = getDb();
  const retDays = config.retention.eventDays;
  const auditDays = config.retention.auditDays;
  const deleted = {};

  // Stats (handled by statsService but we call it here too for consistency)
  try { statsService.purge(); } catch (e) { log.error('Stats purge failed', e.message); }

  // Docker events
  try {
    const r = db.prepare(`DELETE FROM docker_events WHERE event_time < datetime('now', '-' || ? || ' days')`).run(retDays);
    if (r.changes) deleted.docker_events = r.changes;
  } catch (e) { log.error('docker_events cleanup failed', e.message); }

  // Audit log
  try {
    const r = db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')`).run(auditDays);
    if (r.changes) deleted.audit_log = r.changes;
  } catch (e) { log.error('audit_log cleanup failed', e.message); }

  // Health events
  try {
    const r = db.prepare(`DELETE FROM health_events WHERE recorded_at < datetime('now', '-' || ? || ' days')`).run(retDays);
    if (r.changes) deleted.health_events = r.changes;
  } catch (e) { log.error('health_events cleanup failed', e.message); }

  // Alert events
  try {
    const r = db.prepare(`DELETE FROM alert_events WHERE triggered_at < datetime('now', '-' || ? || ' days')`).run(retDays);
    if (r.changes) deleted.alert_events = r.changes;
  } catch (e) { log.error('alert_events cleanup failed', e.message); }

  // Webhook deliveries
  try {
    const r = db.prepare(`DELETE FROM webhook_deliveries WHERE delivered_at < datetime('now', '-' || ? || ' days')`).run(retDays);
    if (r.changes) deleted.webhook_deliveries = r.changes;
  } catch (e) { log.error('webhook_deliveries cleanup failed', e.message); }

  // Login attempts
  try {
    const r = db.prepare(`DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-' || ? || ' days')`).run(retDays);
    if (r.changes) deleted.login_attempts = r.changes;
  } catch (e) { log.error('login_attempts cleanup failed', e.message); }

  // Expired password reset tokens
  try {
    const r = db.prepare(`DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')`).run();
    if (r.changes) deleted.password_reset_tokens = r.changes;
  } catch (e) { log.error('password_reset_tokens cleanup failed', e.message); }

  // Expired sessions
  try { authService.cleanSessions(); } catch (e) { log.error('Session cleanup failed', e.message); }

  if (Object.keys(deleted).length > 0) {
    log.info('Purge completed', deleted);
  }
}

/**
 * Run SQLite VACUUM to reclaim disk space.
 * This briefly locks the DB, so we run it during low-traffic hours.
 */
function vacuumDatabase() {
  try {
    const db = getDb();
    const before = db.pragma('page_count')[0].page_count * db.pragma('page_size')[0].page_size;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    const after = db.pragma('page_count')[0].page_count * db.pragma('page_size')[0].page_size;
    const freedMB = ((before - after) / 1024 / 1024).toFixed(1);
    if (freedMB > 0) {
      log.info('VACUUM completed', { freedMB: `${freedMB} MB`, sizeMB: `${(after / 1024 / 1024).toFixed(1)} MB` });
    }
  } catch (e) {
    log.error('VACUUM failed', e.message);
  }
}

function startAll() {
  // Stats collection already handled by statsService.start() (setInterval)
  // We handle aggregation and cleanup via cron

  // Aggregate raw → 1m every 2 minutes
  jobs.push(cron.schedule('*/2 * * * *', () => {
    try { statsService.aggregate1m(); }
    catch (e) { log.error('1m aggregation failed', e.message); }
  }));

  // Aggregate 1m → 1h every 10 minutes
  jobs.push(cron.schedule('*/10 * * * *', () => {
    try { statsService.aggregate1h(); }
    catch (e) { log.error('1h aggregation failed', e.message); }
  }));

  // Alert evaluation every 10 seconds (via setInterval for precision)
  const alertInterval = setInterval(() => {
    try { alertService.evaluate(); }
    catch (e) { log.error('Alert evaluation failed', e.message); }
  }, 10000);

  // Clean expired sessions every 15 minutes
  jobs.push(cron.schedule('*/15 * * * *', () => {
    try { authService.cleanSessions(); }
    catch (e) { log.error('Session cleanup failed', e.message); }
  }));

  // Purge ALL old data from every table — every hour
  jobs.push(cron.schedule('5 * * * *', purgeAllOldData));

  // VACUUM database to reclaim disk space — daily at 03:30
  jobs.push(cron.schedule('30 3 * * *', vacuumDatabase));

  // Container schedule execution every minute
  jobs.push(cron.schedule('* * * * *', async () => {
    try {
      const schedulesFile = '/data/schedules.json';
      if (!fs.existsSync(schedulesFile)) return;
      const schedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
      const now = new Date();

      for (const s of schedules) {
        if (!s.enabled || !s.cron || !s.containerId) continue;
        try {
          if (cron.validate(s.cron) && cronMatchesNow(s.cron, now)) {
            log.info(`Schedule executing: ${s.action} on ${s.containerName || s.containerId}`);
            await dockerService.containerAction(s.containerId, s.action);
            log.info(`Schedule done: ${s.action} on ${s.containerName || s.containerId}`);
          }
        } catch (e) {
          log.error(`Schedule failed: ${s.action} on ${s.containerName}: ${e.message}`);
        }
      }
    } catch (e) { log.error('Schedule check failed', e.message); }
  }));

  // Run initial purge on startup (in case the app was down for a while)
  setTimeout(purgeAllOldData, 30000);

  log.info('Background jobs started');

  return { jobs, alertInterval };
}

function cronMatchesNow(cronExpr, now) {
  // Simple cron match: minute hour day month weekday
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const checks = [
    { val: now.getMinutes(), part: parts[0] },
    { val: now.getHours(), part: parts[1] },
    { val: now.getDate(), part: parts[2] },
    { val: now.getMonth() + 1, part: parts[3] },
    { val: now.getDay(), part: parts[4] },
  ];
  return checks.every(({ val, part }) => {
    if (part === '*') return true;
    if (part.includes('/')) {
      const step = parseInt(part.split('/')[1]);
      return val % step === 0;
    }
    if (part.includes(',')) return part.split(',').map(Number).includes(val);
    if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      return val >= min && val <= max;
    }
    return parseInt(part) === val;
  });
}

function stopAll() {
  jobs.forEach(j => j.stop());
  jobs.length = 0;
}

module.exports = { startAll, stopAll };
