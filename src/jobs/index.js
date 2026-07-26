'use strict';

const cron = require('node-cron');
const fs = require('fs');
const statsService = require('../services/stats');
const alertService = require('../services/alerts');
const auditService = require('../services/audit');
const authService = require('../services/auth');
const dockerService = require('../services/docker');
const { getDb } = require('../db');
const config = require('../config');
const log = require('../utils/logger')('jobs');
const metricsService = require('../services/metrics');

const jobs = [];

const cluster = require('../services/cluster');

/**
 * Wrap a cron callback with:
 *   1. Prometheus metrics (docker_dash_background_job_runs_total{job},
 *      _errors_total{job}).
 *   2. **Leader-only gating (v6.17.2)** — in HA mode, the job only runs on
 *      the replica that currently holds the Redis `leader` lock. Standalone
 *      always runs (isLeader() returns true). Non-leader replicas skip the
 *      tick silently (no metric increment — runs metric only tracks actual
 *      executions, not skips).
 *   3. Outer try/catch — inner try/catch blocks (per-record SQL handling
 *      inside certificate scan, etc.) stay intact.
 *
 * Opt-out: pass `{ everywhere: true }` for idempotent jobs that are safe
 *          (and possibly desirable) to run on every replica. None of our
 *          current 13 jobs qualify — all either write to SQLite or hit
 *          external services. Kept as escape hatch for future jobs.
 */
// v8.7.14 — Overlap guard: if a previous tick for the same job name is
// still running, skip this tick. Without this, fast-cadence setInterval
// jobs (alert-evaluate every 10s, sandbox-ttl-sweep every 30s, security-
// alert-windowed every 60s) could pile up overlapping invocations when a
// single tick ran longer than the interval — causing duplicate alert
// fires, concurrent docker calls, and audit-log doubling. node-cron
// itself also doesn't dedupe overlap, so this protects cron schedules
// too. Watchdog log fires when a tick runs longer than the threshold.
const _inFlight = new Map();
const SLOW_TICK_WATCHDOG_MS = 5 * 60 * 1000; // 5 min — flag runaway jobs

function _m(name, fn, opts = {}) {
  return async () => {
    if (_inFlight.get(name)) {
      // Previous tick still running — skip this one silently. We don't log
      // at info because for tight-cadence jobs this would flood; the
      // SLOW_TICK_WATCHDOG_MS below surfaces real stalls. We also do NOT
      // bump the runs metric — skips aren't runs; if the prior run finishes
      // ok, it records itself in its own finally.
      return;
    }
    // Leader gate (skipped in standalone via cluster.isLeader() === true)
    if (!opts.everywhere) {
      const leader = await cluster.isLeader();
      if (!leader) return;  // silent skip on readers
    }
    _inFlight.set(name, true);
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      log.warn(`${name}: tick still running after ${SLOW_TICK_WATCHDOG_MS / 1000}s — possible stall`,
        { startedAt: new Date(startedAt).toISOString() });
    }, SLOW_TICK_WATCHDOG_MS);
    try {
      await fn();
      metricsService.recordJobRun(name);
    } catch (e) {
      metricsService.recordJobRun(name, true);
      log.error(`${name} failed`, { message: e.message || String(e) });
    } finally {
      clearTimeout(watchdog);
      _inFlight.set(name, false);
    }
  };
}

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

  // v6.9.0: Remediation snapshot cleanup (free large gzipped inspect blobs
  // from long-completed jobs). Retention via DD_REMEDIATION_SNAPSHOT_RETENTION_DAYS.
  try {
    const r = require('../services/remediate').pruneOldSnapshots();
    if (r.deletedBlobs > 0) deleted.remediation_snapshots = r.deletedBlobs;
  } catch (e) { log.error('Remediation snapshot cleanup failed', e.message); }

  // v6.9.0: Egress Filter block log retention (already implemented in service).
  try {
    require('../services/egress-filter').pruneOldBlockLog();
  } catch { /* service may not be loaded in some test configs */ }

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
  jobs.push(cron.schedule('*/2 * * * *', _m('stats-aggregate-1m', () => statsService.aggregate1m())));

  // Aggregate 1m → 1h every 10 minutes
  jobs.push(cron.schedule('*/10 * * * *', _m('stats-aggregate-1h', () => statsService.aggregate1h())));

  // Aggregate 1h → 1d daily at 00:20 (v8.4.0 — feeds the 30d/90d metric ranges,
  // retained 90 days so long-range charts no longer fall off the 7-day 1h cliff)
  jobs.push(cron.schedule('20 0 * * *', _m('stats-aggregate-1d', () => statsService.aggregate1d())));

  // Alert evaluation every 10 seconds (via setInterval for precision)
  const alertInterval = setInterval(_m('alert-evaluate', () => alertService.evaluate()), 10000);

  // Clean expired sessions and MFA tokens every 15 minutes
  jobs.push(cron.schedule('*/15 * * * *', _m('session-mfa-cleanup', () => {
    authService.cleanSessions();
    authService.cleanMfaTokens();
  })));

  // Security alert windowed evaluation every 60 seconds
  const securityAlertInterval = setInterval(_m('security-alert-windowed', () => {
    const securityAlerts = require('../services/securityAlerts');
    securityAlerts.evaluateWindowed();
  }), 60000);

  // Purge ALL old data from every table — every hour
  jobs.push(cron.schedule('5 * * * *', _m('purge-old-data', purgeAllOldData)));

  // VACUUM database to reclaim disk space — daily at 03:30
  jobs.push(cron.schedule('30 3 * * *', _m('vacuum-db', vacuumDatabase)));

  // Tracked certificates — re-parse + status check daily at 07:30
  jobs.push(cron.schedule('30 7 * * *', _m('certificate-scan', () => {
      const db = getDb();
      const certService = require('../services/certificates');
      const fs2 = require('fs');
      const rows = db.prepare(`SELECT * FROM tracked_certificates`).all();
      let critical = 0, warning = 0, expired = 0;
      const updateOk = db.prepare(`UPDATE tracked_certificates
        SET pem_content = ?, subject = ?, issuer = ?, sans = ?, not_before = ?, not_after = ?,
            fingerprint_sha256 = ?, self_signed = ?, last_checked_at = datetime('now'),
            last_error = '', updated_at = datetime('now') WHERE id = ?`);
      const updateErr = db.prepare(`UPDATE tracked_certificates
        SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?`);
      for (const r of rows) {
        let pem = r.pem_content;
        try {
          if (r.source_type === 'file' && r.source_path && fs2.existsSync(r.source_path)) {
            pem = fs2.readFileSync(r.source_path, 'utf8');
          }
          const info = certService.parsePem(pem);
          const notBeforeIso = info.notBefore ? new Date(info.notBefore).toISOString() : null;
          const notAfterIso = info.notAfter ? new Date(info.notAfter).toISOString() : null;
          updateOk.run(pem, info.subject, info.issuer, info.sans || '', notBeforeIso, notAfterIso,
            info.fingerprintSha256, info.selfSigned ? 1 : 0, r.id);
          const days = certService.daysUntil(notAfterIso);
          const status = certService.statusForDays(days);
          if (status === 'expired') expired++;
          else if (status === 'critical') critical++;
          else if (status === 'warning') warning++;
        } catch (e) {
          updateErr.run(e.message, r.id);
        }
      }
      if (rows.length > 0 && (expired + critical + warning > 0)) {
        try {
          auditService.log({
            action: 'certificate_scan', targetType: 'certificate', targetId: 'daily',
            details: { total: rows.length, expired, critical, warning },
          });
        } catch { /* ignore */ }
        log.info('Certificate scan', { total: rows.length, expired, critical, warning });
      }
  })));

  // Secret rotations — evaluate statuses + emit security alerts daily at 07:00
  jobs.push(cron.schedule('0 7 * * *', _m('secret-rotation-scan', () => {
      const db = getDb();
      const rows = db.prepare(`SELECT id, app_name, env_key, next_due_at, status FROM secret_rotations`).all();
      const now = Date.now();
      const update = db.prepare(`UPDATE secret_rotations SET status = ?, updated_at = datetime('now') WHERE id = ?`);
      let overdue = 0, dueSoon = 0;
      for (const r of rows) {
        const days = Math.floor((new Date(r.next_due_at).getTime() - now) / 86400000);
        const next = days < 0 ? 'overdue' : (days <= 14 ? 'due_soon' : 'ok');
        if (next !== r.status) update.run(next, r.id);
        if (next === 'overdue') overdue++;
        else if (next === 'due_soon') dueSoon++;
      }
      if (overdue > 0 || dueSoon > 0) {
        try {
          auditService.log({
            action: 'secret_rotation_scan', targetType: 'secret_rotation', targetId: 'daily',
            details: { overdue, dueSoon, total: rows.length },
          });
        } catch { /* audit may be disabled */ }
        log.info('Secret rotations scanned', { overdue, dueSoon, total: rows.length });
      }
  })));

  // Daily database backup at 02:00
  jobs.push(cron.schedule('0 2 * * *', _m('daily-backup', () => {
      const db = getDb();
      const path = require('path');
      const fss = require('fs');
      const crypto = require('crypto');

      // FIX #29: Write to /data/backups/ subdir
      const backupDir = path.join(process.env.DATA_DIR || '/data', 'backups');
      if (!fss.existsSync(backupDir)) {
        fss.mkdirSync(backupDir, { recursive: true });
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 10);
      const encKey = process.env.BACKUP_ENCRYPTION_KEY;
      const useEnc = encKey && encKey.length >= 32;
      const baseName = `backup-daily-${ts}.db${useEnc ? '.enc' : ''}`;
      const backupPath = path.join(backupDir, baseName);

      // FIX #29: Disk-space check before backup
      const dbPath = process.env.DB_PATH || '/data/docker-dash.db';
      let dbSize = 0;
      try { dbSize = fss.statSync(dbPath).size; } catch { /* DB may be :memory: */ }

      if (dbSize > 0) {
        let freeBytes = Infinity;
        try {
          const stats = fss.statfsSync(backupDir);
          freeBytes = stats.bfree * stats.bsize;
        } catch {
          // statfsSync not available (Node < 18.15) — skip check
        }
        if (freeBytes < dbSize * 2) {
          log.warn('Daily backup skipped: insufficient disk space', {
            required: dbSize * 2,
            available: freeBytes,
          });
          return;
        }
      }

      // Write backup to temp path first, then finalize
      const tempPath = backupPath + '.tmp';

      db.backup(tempPath).then(() => {
        try {
          if (useEnc) {
            // AES-256-GCM encryption: 16-byte salt + 12-byte nonce + 16-byte tag + ciphertext
            const salt = crypto.randomBytes(16);
            const nonce = crypto.randomBytes(12);
            const keyBytes = crypto.createHash('sha256').update(encKey).digest();
            const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, nonce);
            const plain = fss.readFileSync(tempPath);
            const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
            const tag = cipher.getAuthTag();
            // Header: salt(16) + nonce(12) + tag(16) = 44 bytes
            const out = Buffer.concat([salt, nonce, tag, ciphertext]);
            fss.writeFileSync(backupPath, out);
            fss.unlinkSync(tempPath);
          } else {
            fss.renameSync(tempPath, backupPath);
          }

          // FIX #29: chmod 600
          try { fss.chmodSync(backupPath, 0o600); } catch { /* Windows — ignore */ }

          const stat = fss.statSync(backupPath);
          log.info('Daily backup completed', { path: backupPath, size: stat.size, encrypted: !!useEnc });

          // Keep only last 7 daily backups
          const ext = useEnc ? '.db.enc' : '.db';
          const backups = fss.readdirSync(backupDir)
            .filter(f => f.startsWith('backup-daily-') && f.endsWith(ext))
            .sort()
            .reverse();
          for (const old of backups.slice(7)) {
            fss.unlinkSync(path.join(backupDir, old));
            log.debug('Old backup removed', { file: old });
          }

          // v8.2.0 — push to pCloud target if configured (best-effort, async)
          if (config.pcloud && config.pcloud.enabled) {
            require('../services/pcloud-backup').uploadDbBackup({ trigger: 'cron' })
              .catch(err => log.error('pCloud DB upload failed', err.message));
          }
        } catch (e) {
          log.error('Daily backup post-processing failed', e.message);
          try { fss.unlinkSync(tempPath); } catch { /* cleanup */ }
        }
      }).catch(e => log.error('Daily backup failed', e.message));
  })));

  // Container schedule execution every minute (DB-backed with JSON fallback)
  jobs.push(cron.schedule('* * * * *', _m('schedule-executor', async () => {
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
  })));

  // S3 backup (if configured)
  if (config.s3 && config.s3.enabled) {
    const s3Schedule = config.s3.backupSchedule || '0 3 * * *';
    jobs.push(cron.schedule(s3Schedule, _m('s3-backup', async () => {
      const s3Backup = require('../services/s3-backup');
      await s3Backup.uploadBackup();
    })));
    log.info('S3 backup scheduled', { cron: s3Schedule });
  }

  // v8.2.0 — Stack bundle weekly archive + audit monthly dump.
  // Both pCloud-driven; the schedules live in pcloud_config and are read
  // through the cached config getter (5s TTL), so changing them in the UI
  // requires a process restart to re-register cron — documented in the UI.
  const pcloudCfg = config.pcloud || { enabled: false, schedules: {} };
  if (pcloudCfg.enabled) {
    const stackSchedule = pcloudCfg.schedules?.stack || '0 4 * * 0';
    jobs.push(cron.schedule(stackSchedule, _m('stack-archive', async () => {
      const stackArchive = require('./stack-archive');
      await stackArchive.run({ trigger: 'cron' }).catch(err => log.error('stack-archive failed', err.message));
    })));
    log.info('Stack archive scheduled', { cron: stackSchedule });

    const auditSchedule = pcloudCfg.schedules?.audit || '5 4 1 * *';
    jobs.push(cron.schedule(auditSchedule, _m('audit-dump', async () => {
      const auditDump = require('./audit-dump');
      await auditDump.run({ trigger: 'cron' }).catch(err => log.error('audit-dump failed', err.message));
    })));
    log.info('Audit dump scheduled', { cron: auditSchedule });
  }

  // Git polling — v6.17.2 leader-only. Each poll makes a git fetch against
  // the remote; running it on every replica would N× the GitHub/GitLab rate
  // limit hit for no benefit (the results are DB-written, readers see them).
  // Standalone fires onBecomeLeader synchronously, so startAll() happens now.
  const gitPolling = require('../services/gitPolling');
  cluster.onBecomeLeader(() => {
    try { gitPolling.startAll(); }
    catch (e) { log.error('Git polling startup failed', e.message); }
  });
  cluster.onBecomeReader(() => {
    try { gitPolling.stopAll(); }
    catch (e) { log.error('Git polling stop failed', e.message); }
  });

  // v8.1.0 — Retention sweep (registry hygiene). Daily at 03:17 (off-:00).
  // Leader-only via _m() default. Iterates all enabled retention policies,
  // evaluates each rule against current registry state, executes deletes
  // via existing v7.6.0 deleteTag() path. Each per-tag delete writes its
  // own audit_log entry; an umbrella retention_executed entry summarizes.
  jobs.push(cron.schedule('17 3 * * *', _m('retention-sweep', () => {
    return require('../services/retention-cron').runAllPolicies();
  })));

  // Common VM snapshot policies use cron only as a leader-gated wake-up.
  // Due-slot dedupe and create/retention orchestration are persisted in
  // SQLite, while every provider mutation remains a durable vm.snapshot job.
  jobs.push(cron.schedule('* * * * *', _m('provider-snapshot-policy', () => {
    return require('../services/provider-operations/snapshot-policies').runDue();
  })));

  // v8.3.0 — GitOps drift detection (read-only). Every 5 min, compare each
  // running git-managed stack's actual container state against the git-checked-
  // out compose. Detection only — never starts/stops/deploys. Leader-gated.
  jobs.push(cron.schedule('*/5 * * * *', _m('git-drift-scan', () => {
    const gitDrift = require('../services/git-drift');
    return gitDrift.scanAll(dockerService);
  })));

  // Fleet health history for the dashboard sparkline. Sampling runs in the
  // background so the 24-hour chart remains useful even when no admin keeps
  // the dashboard open. The service upserts the current five-minute bucket.
  jobs.push(cron.schedule('*/5 * * * *', _m('fleet-health-snapshot', () => {
    return require('../services/fleet-operations').recordHealthSnapshot();
  })));

  // Guarded disk-pressure automation. Policies are disabled and dry-run-only
  // by default; the service also enforces per-host cooldowns and never deletes
  // volumes. Leader-only so HA replicas cannot race cleanup operations.
  jobs.push(cron.schedule('*/5 * * * *', _m('disk-pressure-sweep', () => {
    return require('../services/disk-pressure').runAllPolicies();
  })));

  // Pull-request preview TTL reaper. Closing webhooks perform immediate
  // cleanup; this sweep covers missed deliveries and abandoned previews.
  jobs.push(cron.schedule('*/5 * * * *', _m('preview-ttl-reaper', () => {
    return require('../services/preview-environments').reapExpired();
  })));

  // v7.4.0 — Sample feature cron tick (CONTRIBUTOR DEMO). Auto-increments
  // the demo counter every minute so contributors see the cron pattern fire
  // without external triggers. Leader-only via _m() default; skipped entirely
  // when the sample is hidden via env.
  if (process.env.DD_SHOW_SAMPLE_PLUGIN !== 'false') {
    jobs.push(cron.schedule('* * * * *', _m('sample-feature-tick', () => {
      require('../services/sample-feature').tick();
    })));
  }

  // Update-check (v7.3.0) — every 12h on the leader. Default ON, opt-out via
  // System Settings. Service short-circuits when disabled, so the cron tick
  // is a cheap settings.get when the user has turned this off.
  jobs.push(cron.schedule('17 */12 * * *', _m('update-check', () => {
    return require('../services/update-check').refresh();
  })));

  // v8.7.25 — kickstart leader election immediately at boot. Without
  // this, the cluster module's lazy-init pattern (election loop starts
  // on the first isLeader() call) means HA mode waits up to ~10s for
  // the first fast setInterval tick (alert-evaluate every 10s) before
  // even attempting to determine its role. During that window:
  //   - gitPolling stays unstarted (waiting for onBecomeLeader)
  //   - the WS Docker event stream stays unstarted (same)
  //   - any cron job that ticks faster than 10s doesn't exist, but if
  //     it did, it would no-op the wait
  // Standalone: cluster.isLeader() returns true immediately (no Redis,
  // no async), so this line is a synchronous no-op there.
  // HA: triggers the election + role transition within milliseconds of
  // boot, so the leader replica picks up its work without the 10s gap.
  cluster.isLeader().catch((e) => log.warn('initial election kickstart failed', { message: e.message }));

  // Initial update-check 60s after boot so the sidebar badge can light up
  // on first load without waiting 12h. Throttled inside the service.
  // Leader-only in HA mode (per-process throttle wouldn't dedupe across replicas).
  setTimeout(async () => {
    try {
      if (!(await cluster.isLeader())) return;
      await require('../services/update-check').refresh();
    } catch { /* logged inside the service */ }
  }, 60000);

  // Run initial purge on startup (in case the app was down for a while).
  // v8.7.14: wrapped with _m so it's leader-gated in HA mode + dedupes
  // against the hourly cron tick if startup happens to overlap '5 * * * *'.
  setTimeout(_m('purge-old-data', purgeAllOldData), 30000);

  // v8.7.12 — Sandbox TTL cleanup. Iterates EVERY active host, not just
  // host 0. Previously hardcoded to hostId=0, which silently leaked sandbox
  // containers created on remote (SSH/TCP) hosts — they never expired, used
  // resources forever, and admins had no audit trail of the failed cleanup.
  // Also: errors are now logged at warn level instead of swallowed, so a
  // sandbox stuck in "stop refused" state is visible in ops.
  _sandboxInterval = setInterval(_m('sandbox-ttl-sweep', async () => {
    const dockerService = require('../services/docker');
    const hosts = dockerService.getActiveHosts();
    const now = Date.now();

    for (const host of hosts) {
      let docker, containers;
      try {
        docker = dockerService.getDocker(host.id);
        containers = await docker.listContainers({
          all: true,
          filters: { label: ['docker-dash.sandbox=true'] },
        });
      } catch (err) {
        // One unreachable host must not stall the sweep for the rest.
        log.warn(`sandbox-ttl-sweep: host ${host.id} (${host.name}) unreachable, skipping`, { error: err.message });
        continue;
      }

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
          } catch { /* DB row missing or malformed — fall back to label */ }
        }
        if (expires && new Date(expires).getTime() < now && c.State === 'running') {
          const container = docker.getContainer(c.Id);
          const name = (c.Names?.[0] || '').replace(/^\//, '');
          try { await container.stop({ t: 3 }); }
          catch (err) { log.warn(`sandbox-ttl-sweep: stop failed for ${name} on host ${host.id}`, { error: err.message }); }
          try { await container.remove({ force: true }); }
          catch (err) { log.warn(`sandbox-ttl-sweep: remove failed for ${name} on host ${host.id}`, { error: err.message }); continue; }
          try { require('../db').getDb().prepare('DELETE FROM container_meta WHERE container_name = ?').run(name); } catch { /* row may not exist */ }
          log.info(`Sandbox expired: ${name} (host ${host.id})`);
          try {
            require('../services/audit').log({
              action: 'sandbox_expired', targetType: 'container', targetId: c.Id.substring(0, 12),
              details: { name, image: c.Image, hostId: host.id },
            });
          } catch { /* audit best-effort */ }
          try { require('../ws').broadcast('sandbox:expired', { name, image: c.Image, hostId: host.id }); } catch { }
        }
      }
    }
  }), 30000);

  log.info('Background jobs started');

  _alertInterval = alertInterval;
  _securityAlertInterval = securityAlertInterval;
  return { jobs, alertInterval, securityAlertInterval };
}

function cronMatchesNow(cronExpr, now) {
  // Simple cron match: minute hour day month weekday
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  // FIX #31: Sunday normalization — weekday position treats 7 as Sunday (same as 0)
  const rawWeekday = parts[4];
  const normalizedWeekday = rawWeekday === '7' ? '0'
    : rawWeekday.replace(/\b7\b/g, '0'); // also covers lists like "0,7"

  const checks = [
    { val: now.getMinutes(), part: parts[0] },
    { val: now.getHours(), part: parts[1] },
    { val: now.getDate(), part: parts[2] },
    { val: now.getMonth() + 1, part: parts[3] },
    { val: now.getDay(), part: normalizedWeekday },
  ];

  return checks.every(({ val, part }) => {
    if (part === '*') return true;

    // FIX #31: support range/step combos like "0-30/5" and bare "*/N"
    if (part.includes('/')) {
      const [rangePart, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) return false;

      if (rangePart === '*') {
        // bare */N — every Nth value from 0
        return val % step === 0;
      }
      if (rangePart.includes('-')) {
        // range/step — e.g. "0-30/5"
        const [min, max] = rangePart.split('-').map(Number);
        if (val < min || val > max) return false;
        return (val - min) % step === 0;
      }
      // numeric/step — treat base as starting point
      const base = parseInt(rangePart, 10);
      return (val - base) % step === 0 && val >= base;
    }

    if (part.includes(',')) return part.split(',').map(Number).includes(val);

    if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      return val >= min && val <= max;
    }

    return parseInt(part, 10) === val;
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
