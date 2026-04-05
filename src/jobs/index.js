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

  // Audit log (blocked in strict security mode)
  try {
    const r = auditService.cleanup(auditDays);
    if (r > 0) deleted.audit_log = r;
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

  // Security alert events (keep 90 days)
  try {
    const r = db.prepare(`DELETE FROM security_alert_events WHERE fired_at < datetime('now', '-90 days')`).run();
    if (r.changes) deleted.security_alert_events = r.changes;
  } catch { /* table may not exist */ }

  // Expired MFA tokens
  try {
    const r = db.prepare(`DELETE FROM mfa_tokens WHERE expires_at < datetime('now') OR used = 1`).run();
    if (r.changes) deleted.mfa_tokens = r.changes;
  } catch { /* table may not exist */ }

  // Expired password reset tokens
  try {
    const r = db.prepare(`DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')`).run();
    if (r.changes) deleted.password_reset_tokens = r.changes;
  } catch (e) { log.error('password_reset_tokens cleanup failed', e.message); }

  // Git deployments (keep 90 days)
  try {
    const r = db.prepare(`DELETE FROM git_deployments WHERE started_at < datetime('now', '-90 days')`).run();
    if (r.changes) deleted.git_deployments = r.changes;
  } catch (e) { /* table may not exist */ }

  // Schedule history (keep 30 days)
  try {
    const r = db.prepare(`DELETE FROM schedule_history WHERE executed_at < datetime('now', '-30 days')`).run();
    if (r.changes) deleted.schedule_history = r.changes;
  } catch { /* table may not exist */ }

  // Container image history (keep 90 days, minimum 3 per container)
  try {
    const r = db.prepare(`
      DELETE FROM container_image_history
      WHERE deployed_at < datetime('now', '-90 days')
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY container_name, host_id ORDER BY deployed_at DESC) as rn
          FROM container_image_history
        ) WHERE rn <= 3
      )
    `).run();
    if (r.changes) deleted.container_image_history = r.changes;
  } catch { /* table may not exist */ }

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

  // Clean expired sessions and MFA tokens every 15 minutes
  jobs.push(cron.schedule('*/15 * * * *', () => {
    try { authService.cleanSessions(); }
    catch (e) { log.error('Session cleanup failed', e.message); }
    try { authService.cleanMfaTokens(); }
    catch (e) { log.error('MFA token cleanup failed', e.message); }
  }));

  // Security alert windowed evaluation every 60 seconds
  const securityAlertInterval = setInterval(() => {
    try {
      const securityAlerts = require('../services/securityAlerts');
      securityAlerts.evaluateWindowed();
    } catch (e) { log.error('Security alert windowed eval failed', e.message); }
  }, 60000);

  // Purge ALL old data from every table — every hour
  jobs.push(cron.schedule('5 * * * *', purgeAllOldData));

  // VACUUM database to reclaim disk space — daily at 03:30
  jobs.push(cron.schedule('30 3 * * *', vacuumDatabase));

  // Daily database backup at 02:00
  jobs.push(cron.schedule('0 2 * * *', () => {
    try {
      const db = getDb();
      const path = require('path');
      const fs = require('fs');
      const backupDir = process.env.DATA_DIR || '/data';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 10);
      const backupPath = path.join(backupDir, `backup-daily-${ts}.db`);

      db.backup(backupPath).then(() => {
        const stat = fs.statSync(backupPath);
        log.info('Daily backup completed', { path: backupPath, size: stat.size });

        // Keep only last 7 daily backups
        const backups = fs.readdirSync(backupDir)
          .filter(f => f.startsWith('backup-daily-') && f.endsWith('.db'))
          .sort()
          .reverse();
        for (const old of backups.slice(7)) {
          fs.unlinkSync(path.join(backupDir, old));
          log.debug('Old backup removed', { file: old });
        }
      }).catch(e => log.error('Daily backup failed', e.message));
    } catch (e) { log.error('Daily backup error', e.message); }
  }));

  // Container schedule execution every minute (DB-backed with JSON fallback)
  jobs.push(cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      let schedules = [];

      // Try DB first
      try {
        const db = getDb();
        schedules = db.prepare('SELECT * FROM scheduled_actions WHERE enabled = 1').all();
      } catch {
        // Fallback to JSON
        const schedulesFile = '/data/schedules.json';
        if (!fs.existsSync(schedulesFile)) return;
        const jsonSchedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
        schedules = jsonSchedules.filter(s => s.enabled).map(s => ({
          id: s.id, container_id: s.containerId, container_name: s.containerName,
          action: s.action, cron: s.cron, host_id: 0,
        }));
      }

      for (const s of schedules) {
        if (!s.cron || !s.container_id) continue;
        try {
          if (cron.validate(s.cron) && cronMatchesNow(s.cron, now)) {
            const start = Date.now();
            log.info(`Schedule executing: ${s.action} on ${s.container_name || s.container_id}`);
            try {
              await dockerService.containerAction(s.container_id, s.action, s.host_id || 0);
              const duration = Date.now() - start;
              log.info(`Schedule done: ${s.action} on ${s.container_name || s.container_id} (${duration}ms)`);
              // Record success in DB
              try {
                const db = getDb();
                db.prepare(`INSERT INTO schedule_history (schedule_id, container_id, action, status, duration_ms) VALUES (?, ?, ?, 'success', ?)`).run(s.id, s.container_id, s.action, duration);
                db.prepare(`UPDATE scheduled_actions SET last_run_at = datetime('now'), last_run_status = 'success', run_count = run_count + 1 WHERE id = ?`).run(s.id);
              } catch { /* ignore DB errors */ }
            } catch (e) {
              const duration = Date.now() - start;
              log.error(`Schedule failed: ${s.action} on ${s.container_name}: ${e.message}`);
              try {
                const db = getDb();
                db.prepare(`INSERT INTO schedule_history (schedule_id, container_id, action, status, error_message, duration_ms) VALUES (?, ?, ?, 'error', ?, ?)`).run(s.id, s.container_id, s.action, e.message, duration);
                db.prepare(`UPDATE scheduled_actions SET last_run_at = datetime('now'), last_run_status = 'error', last_run_error = ? WHERE id = ?`).run(e.message, s.id);
              } catch { /* ignore DB errors */ }
            }
          }
        } catch (e) {
          log.error(`Schedule check error: ${e.message}`);
        }
      }
    } catch (e) { log.error('Schedule check failed', e.message); }
  }));

  // S3 backup (if configured)
  if (config.s3 && config.s3.enabled) {
    const s3Schedule = config.s3.backupSchedule || '0 3 * * *';
    jobs.push(cron.schedule(s3Schedule, async () => {
      try {
        const s3Backup = require('../services/s3-backup');
        await s3Backup.uploadBackup();
      } catch (e) { log.error('S3 backup failed', e.message); }
    }));
    log.info('S3 backup scheduled', { cron: s3Schedule });
  }

  // Git deployment history cleanup
  try {
    const gitPolling = require('../services/gitPolling');
    gitPolling.startAll();
  } catch (e) { log.error('Git polling startup failed', e.message); }

  // Run initial purge on startup (in case the app was down for a while)
  setTimeout(purgeAllOldData, 30000);

  // Sandbox TTL cleanup — check every 30 seconds for expired sandbox containers
  _sandboxInterval = setInterval(async () => {
    try {
      const docker = require('../services/docker').getDocker(0);
      const containers = await docker.listContainers({ all: true, filters: { label: ['docker-dash.sandbox=true'] } });
      const now = Date.now();
      for (const c of containers) {
        let expires = c.Labels?.['docker-dash.sandbox.expires'] || '';
        // Also check DB for extended TTL
        if (expires) {
          try {
            const name = (c.Names?.[0] || '').replace(/^\//, '');
            const row = require('../db').getDb().prepare('SELECT custom_fields FROM container_meta WHERE container_name = ?').get(name);
            if (row?.custom_fields) {
              const cf = JSON.parse(row.custom_fields);
              if (cf.sandbox?.expiresAt) expires = cf.sandbox.expiresAt;
            }
          } catch { }
        }
        if (expires && new Date(expires).getTime() < now && c.State === 'running') {
          const container = docker.getContainer(c.Id);
          const name = (c.Names?.[0] || '').replace(/^\//, '');
          try { await container.stop({ t: 3 }); } catch { }
          try { await container.remove({ force: true }); } catch { }
          try { require('../db').getDb().prepare('DELETE FROM container_meta WHERE container_name = ?').run(name); } catch { }
          log.info(`Sandbox expired: ${name}`);
          try {
            require('../services/audit').log({
              action: 'sandbox_expired', targetType: 'container', targetId: c.Id.substring(0, 12),
              details: { name, image: c.Image },
            });
          } catch { }
          // Notify via WebSocket
          try { require('../ws').broadcast('sandbox:expired', { name, image: c.Image }); } catch { }
        }
      }
    } catch { /* Docker may be unreachable */ }
  }, 30000);

  log.info('Background jobs started');

  _alertInterval = alertInterval;
  _securityAlertInterval = securityAlertInterval;
  return { jobs, alertInterval, securityAlertInterval };
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

let _alertInterval = null;
let _securityAlertInterval = null;
let _sandboxInterval = null;

function stopAll() {
  jobs.forEach(j => j.stop());
  jobs.length = 0;
  if (_alertInterval) { clearInterval(_alertInterval); _alertInterval = null; }
  if (_securityAlertInterval) { clearInterval(_securityAlertInterval); _securityAlertInterval = null; }
  if (_sandboxInterval) { clearInterval(_sandboxInterval); _sandboxInterval = null; }
  try { require('../services/gitPolling').stopAll(); } catch { /* git polling may not be initialized */ }
}

module.exports = { startAll, stopAll };
