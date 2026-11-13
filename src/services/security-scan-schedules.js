'use strict';

const { getDb } = require('../db');
const dockerService = require('./docker');
const imageScans = require('./image-scan-results');
const cis = require('./cis-benchmark');
const notifications = require('./notificationChannels');
const policy = require('./provider-operations/policy');
const config = require('../config');
const httpUrl = require('../utils/http-url');
const { nextScheduleRuns, cronMatchesNow } = require('../utils/schedule-cron');
const { isDockerCompatible } = require('../utils/host-id');

const MAX_SCHEDULES = 50;
const MAX_IMAGES = 256;
const MAX_RUNTIME_MS = 30 * 60_000;
const STALE_RUN_MS = 45 * 60_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const scheduleRows = "SELECT s.*, h.name AS host_name, n.name AS channel_name FROM security_scan_schedules s " +
  "LEFT JOIN docker_hosts h ON h.id=s.host_id LEFT JOIN notification_channels n ON n.id=s.channel_id";

function hostFor(db, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw fail('Select a Docker host');
  const host = db.prepare('SELECT id, name, is_active, daemon_type FROM docker_hosts WHERE id=?').get(id);
  if (!host?.is_active || !isDockerCompatible(host.daemon_type)) throw fail('Select an active Docker or Podman host');
  return host;
}

function ownerAllowed(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND is_active=1").get(id));
}

function checkPolicy(host) {
  const decision = policy.evaluate({ providerType: host.daemon_type || 'docker', hostId: host.id });
  if (!decision.allowed) throw fail('Security scan is blocked by the current operation policy', 423);
}

function projectSchedule(row, now = new Date()) {
  return {
    id: row.id, name: row.name, hostId: row.host_id, hostName: row.host_name,
    kind: row.kind, imageScope: row.image_scope, scanner: row.scanner,
    cron: row.cron, enabled: Boolean(row.enabled), channelId: row.channel_id, channelName: row.channel_name,
    nextRunAt: row.enabled && row.host_id ? nextScheduleRuns(row.cron, now)[0] ?? null : null,
  };
}

function projectRun(row, includeReport = false) {
  const report = includeReport && row.report_json ? JSON.parse(row.report_json) : null;
  const summary = report?.summary ?? (row.summary_json ? JSON.parse(row.summary_json) : null);
  return {
    id: row.id, scheduleId: row.schedule_id, hostId: row.host_id, hostName: row.host_name,
    kind: row.kind, trigger: row.trigger, status: row.status, queuedAt: row.queued_at,
    startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
    deliveryStatus: row.delivery_status, deliveryError: row.delivery_error,
    summary, ...(includeReport ? { report } : {}),
  };
}

function list() {
  const db = getDb();
  const latest = db.prepare("SELECT *, json_extract(report_json, '$.summary') AS summary_json FROM security_scan_runs WHERE schedule_id=? ORDER BY id DESC LIMIT 1");
  return { timeZone, schedules: db.prepare(scheduleRows + ' ORDER BY s.id DESC').all().map(row => {
    const run = latest.get(row.id);
    return { ...projectSchedule(row), lastRun: run ? projectRun(run) : null };
  }) };
}

function save(id, body, ownerId) {
  const db = getDb();
  const { name, hostId, kind, cron, enabled = true, channelId = null } = body || {};
  const imageScope = kind === 'images' ? body.imageScope ?? 'running' : 'running';
  const scanner = kind === 'images' ? body.scanner ?? 'auto' : 'auto';
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)
    || !['images', 'cis'].includes(kind) || !['running', 'all'].includes(imageScope)
    || !['auto', 'trivy', 'grype'].includes(scanner) || typeof enabled !== 'boolean') throw fail('Invalid security scan settings');
  if (typeof cron !== 'string' || !nextScheduleRuns(cron).length) throw fail('Enter a five-field cron expression with an upcoming run');
  hostFor(db, hostId);
  if (!ownerAllowed(db, ownerId)) throw fail('An active administrator account must own the schedule', 403);
  if (channelId !== null && (!Number.isSafeInteger(channelId) || channelId < 1
    || !db.prepare('SELECT 1 FROM notification_channels WHERE id=? AND is_active=1').get(channelId))) {
    throw fail('Choose an active notification channel');
  }
  const fields = [name.trim(), hostId, kind, imageScope, scanner, cron.trim(), Number(enabled), channelId, ownerId];
  return db.transaction(() => {
    if (id === null) {
      if (db.prepare('SELECT COUNT(*) AS count FROM security_scan_schedules').get().count >= MAX_SCHEDULES) {
        throw fail('The security scan schedule limit has been reached', 409);
      }
      id = Number(db.prepare("INSERT INTO security_scan_schedules (name,host_id,kind,image_scope,scanner,cron,enabled,channel_id,owner_id,created_at)" +
        ' VALUES (?,?,?,?,?,?,?,?,?,?)').run(...fields, new Date().toISOString()).lastInsertRowid);
    } else {
      const changed = db.prepare('UPDATE security_scan_schedules SET name=?,host_id=?,kind=?,image_scope=?,scanner=?,cron=?,enabled=?,channel_id=?,owner_id=? WHERE id=?')
        .run(...fields, id).changes;
      if (!changed) throw fail('Security scan schedule not found', 404);
      // Queued runs represent the previous settings, including their delivery target.
      db.prepare("UPDATE security_scan_runs SET status='error',finished_at=?,error='Schedule settings changed before execution',delivery_status='none'" +
        " WHERE schedule_id=? AND status='queued'").run(new Date().toISOString(), id);
    }
    return projectSchedule(db.prepare(scheduleRows + ' WHERE s.id=?').get(id));
  }).immediate();
}

function remove(id) {
  const db = getDb();
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM security_scan_runs WHERE schedule_id=? AND status='running'").get(id)) {
      throw fail('Wait for the scan to finish before deleting this schedule', 409);
    }
    if (!db.prepare('DELETE FROM security_scan_schedules WHERE id=?').run(id).changes) {
      throw fail('Security scan schedule not found', 404);
    }
  }).immediate();
}

function history(id) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM security_scan_schedules WHERE id=?').get(id)) throw fail('Security scan schedule not found', 404);
  return db.prepare("SELECT *, json_extract(report_json, '$.summary') AS summary_json FROM security_scan_runs WHERE schedule_id=? ORDER BY id DESC LIMIT 30").all(id).map(row => projectRun(row));
}

function getRun(id) {
  const row = getDb().prepare('SELECT * FROM security_scan_runs WHERE id=?').get(id);
  if (!row) throw fail('Security scan run not found', 404);
  return projectRun(row, true);
}

function enqueue(db, schedule, host, trigger, now) {
  if (db.prepare("SELECT 1 FROM security_scan_runs WHERE schedule_id=? AND status IN ('queued', 'running')").get(schedule.id)) {
    return null;
  }
  return Number(db.prepare("INSERT INTO security_scan_runs" +
    " (schedule_id,host_id,host_name,kind,image_scope,scanner,channel_id,delivery_status,trigger,status,queued_at)" +
    " VALUES (?,?,?,?,?,?,?,?,?,'queued',?)").run(schedule.id, host.id, host.name, schedule.kind,
    schedule.image_scope, schedule.scanner, schedule.channel_id, schedule.channel_id ? 'pending' : 'none', trigger, now.toISOString()).lastInsertRowid);
}

function enqueueManual(id, now = new Date()) {
  const db = getDb();
  return db.transaction(() => {
    const schedule = db.prepare('SELECT * FROM security_scan_schedules WHERE id=?').get(id);
    if (!schedule) throw fail('Security scan schedule not found', 404);
    if (!ownerAllowed(db, schedule.owner_id)) throw fail('Save the schedule with an active administrator before running it', 409);
    const host = hostFor(db, schedule.host_id);
    checkPolicy(host);
    const runId = enqueue(db, schedule, host, 'manual', now);
    if (!runId) throw fail('A scan is already queued or running for this schedule', 409);
    return getRun(runId);
  }).immediate();
}

function enqueueDue(now = new Date()) {
  if (config.features.readOnly) return;
  const db = getDb();
  const slot = Math.floor(now.getTime() / 60_000);
  const due = db.prepare("SELECT * FROM security_scan_schedules WHERE enabled=1 AND (last_slot IS NULL OR last_slot < ?)").all(slot);
  for (const row of due) {
    if (!cronMatchesNow(row.cron, now)) continue;
    db.transaction(() => {
      const schedule = db.prepare('SELECT * FROM security_scan_schedules WHERE id=? AND enabled=1 AND (last_slot IS NULL OR last_slot < ?)').get(row.id, slot);
      if (!schedule || !cronMatchesNow(schedule.cron, now)) return;
      const host = db.prepare('SELECT id,name,is_active,daemon_type FROM docker_hosts WHERE id=?').get(schedule.host_id);
      if (!ownerAllowed(db, schedule.owner_id) || !host || !isDockerCompatible(host.daemon_type)) {
        db.prepare('UPDATE security_scan_schedules SET enabled=0 WHERE id=?').run(schedule.id);
        return;
      }
      if (!host.is_active || !policy.evaluate({ providerType: host.daemon_type, hostId: host.id, at: now }).allowed) return;
      db.prepare('UPDATE security_scan_schedules SET last_slot=? WHERE id=?').run(slot, schedule.id);
      enqueue(db, schedule, host, 'automatic', now);
    }).immediate();
  }
}

function claimRun(db, now) {
  return db.transaction(() => {
    const stamp = now.toISOString();
    const stale = new Date(now.getTime() - STALE_RUN_MS).toISOString();
    db.prepare("UPDATE security_scan_runs SET status='error', finished_at=?, error='The scan worker was interrupted', " +
      "delivery_status=CASE WHEN delivery_status='pending' THEN 'unknown' ELSE delivery_status END" +
      " WHERE status='running' AND started_at < ?").run(stamp, stale);
    db.prepare("UPDATE security_scan_runs SET delivery_status='unknown', delivery_error='Delivery outcome could not be confirmed'" +
      " WHERE status IN ('success','partial','error') AND delivery_status='sending' AND finished_at < ?").run(stale);
    if (db.prepare("SELECT 1 FROM security_scan_runs WHERE status='running'").get()) return null;
    const run = db.prepare("SELECT * FROM security_scan_runs WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (!run) return null;
    db.prepare("UPDATE security_scan_runs SET status='running',started_at=? WHERE id=?").run(stamp, run.id);
    return { ...run, started_at: stamp };
  }).immediate();
}

function selectedImages(rows) {
  const images = new Map();
  for (const row of rows) {
    const id = row.ImageID || row.Id;
    const tag = row.ImageID ? row.Image : row.RepoTags?.find(name => !name.startsWith('<none>'));
    // Keep unresolved inventory entries visible as failures in the report.
    const key = id || row.Id || tag || '?';
    const name = String(tag || id || 'Unknown image').slice(0, 300);
    if (!images.has(key)) images.set(key, { id: id || null, name });
  }
  return [...images.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

async function imageReport(docker, run, host, deadline) {
  const running = run.image_scope === 'running';
  const inventory = running ? await docker.listContainers({ all: false }) : await docker.listImages({ all: false });
  const targets = selectedImages(running ? inventory.filter(container => container.State === 'running') : inventory);
  const summary = { selected: targets.length, scanned: 0, failed: 0, skipped: 0,
    total: 0, fixable: 0, critical: 0, high: 0, medium: 0, low: 0 };
  const images = [];
  for (const image of targets.slice(0, MAX_IMAGES)) {
    if (Date.now() >= deadline || !policy.evaluate({ providerType: host.daemon_type, hostId: host.id }).allowed) break;
    try {
      if (!IMAGE_ID.test(image.id || '')) throw new Error('Docker did not provide an immutable image ID');
      const scan = await imageScans.scanAndSave(docker, image.id, image.name, run.scanner, host.id, { runId: run.id });
      summary.scanned++;
      summary.fixable += scan.fixableCount;
      for (const key of ['total', 'critical', 'high', 'medium', 'low']) summary[key] += scan.summary[key];
      images.push({ ...image, scanId: scan.scanId, scanner: scan.scanner, summary: scan.summary, fixable: scan.fixableCount });
    } catch (error) {
      summary.failed++;
      const reason = /^(?:Docker did not provide an immutable image ID|Image scan slots unavailable|Image export too large|No scanner could verify a complete report for this image)$/.test(error.message)
        ? error.message : 'Verified scan failed for this image';
      images.push({ ...image, error: reason });
    }
  }
  summary.skipped = summary.selected - summary.scanned - summary.failed;
  const status = summary.failed || summary.skipped ? (summary.scanned ? 'partial' : 'error') : 'success';
  return { status, report: { summary, images } };
}

async function cisReport(docker, deadline) {
  const { summary, score, checks, coverage } = await cis.runBenchmark(docker, { deadline });
  const status = coverage.error ? 'error' : coverage.checked < coverage.selected ? 'partial' : 'success';
  return { status, report: { summary: { ...summary, score, ...coverage }, checks } };
}

function notificationMessage(run, result) {
  const summary = result.report?.summary;
  const kind = run.kind === 'images' ? 'Image vulnerability scan' : 'CIS Docker Benchmark';
  const host = run.host_name.replace(/[^a-zA-Z0-9 .:-]/g, ' ').slice(0, 80);
  const lines = [kind + ' — ' + result.status, 'Docker host: ' + host];
  if (summary && run.kind === 'images') {
    lines.push('Images scanned: ' + summary.scanned + '/' + summary.selected + ' (' + summary.failed + ' failed, ' + summary.skipped + ' skipped)');
    lines.push('Vulnerability findings: ' + summary.total + ' (' + summary.fixable + ' with fixes available)');
    lines.push('Critical: ' + summary.critical + ' | High: ' + summary.high + ' | Medium: ' + summary.medium + ' | Low: ' + summary.low);
  } else if (summary) {
    lines.push('Score: ' + summary.score + '% | Passed: ' + summary.pass + ' | Warnings: ' + summary.warn + ' | Failed checks: ' + summary.fail);
    lines.push('Containers checked: ' + summary.checked + '/' + summary.selected);
  }
  const publicUrl = httpUrl(config.app.publicUrl);
  if (publicUrl) lines.push(new URL('/#/security/schedules/' + run.id, publicUrl).href);
  return { title: 'Docker Dash security report', text: lines.join('\n'),
    severity: result.status !== 'success' || summary?.critical || summary?.fail ? 'warning' : 'info' };
}

async function deliver(db, run, result) {
  if (run.delivery_status !== 'pending') return;
  const current = db.prepare('SELECT channel_id,delivery_status FROM security_scan_runs WHERE id=?').get(run.id);
  if (!current || current.delivery_status !== 'sending') return;
  let status = 'sent', error = null;
  try {
    if (!current.channel_id) throw fail('The selected notification channel was deleted');
    await notifications.send(current.channel_id, notificationMessage(run, result), { diagnostics: true });
  } catch (cause) {
    status = 'error';
    error = cause.details?.reason || (cause.status === 400 || cause.status === 404
      ? 'The selected channel is unavailable or incomplete' : 'Notification delivery failed');
  }
  db.prepare("UPDATE security_scan_runs SET delivery_status=?,delivery_error=? WHERE id=? AND delivery_status='sending'").run(status, error, run.id);
}

async function processNext(now = new Date()) {
  if (config.features.readOnly) return;
  const db = getDb();
  const run = claimRun(db, now);
  if (!run) return;
  let result, error = null;
  try {
    const schedule = db.prepare('SELECT owner_id FROM security_scan_schedules WHERE id=?').get(run.schedule_id);
    if (!schedule || !ownerAllowed(db, schedule.owner_id)) throw fail('An active administrator must own the schedule', 403);
    const host = hostFor(db, run.host_id);
    checkPolicy(host);
    const docker = dockerService.getDocker(host.id);
    const deadline = Date.now() + MAX_RUNTIME_MS;
    result = run.kind === 'cis' ? await cisReport(docker, deadline) : await imageReport(docker, run, host, deadline);
    if (result.status === 'error') error = 'No complete scan could be verified. Review the report for details.';
  } catch (cause) {
    result = { status: 'error', report: null };
    error = cause.status >= 400 && cause.status < 500 ? cause.message : 'Could not scan the selected Docker host';
  }
  const saved = db.prepare("UPDATE security_scan_runs SET status=?,finished_at=?,report_json=?,error=?," +
    " delivery_status=CASE WHEN delivery_status='pending' THEN 'sending' ELSE delivery_status END" +
    " WHERE id=? AND status='running' AND started_at=?")
    .run(result.status, new Date().toISOString(), result.report ? JSON.stringify(result.report) : null, error, run.id, run.started_at);
  if (saved.changes) await deliver(db, run, result);
  db.prepare("DELETE FROM security_scan_runs WHERE schedule_id=? AND id NOT IN" +
    " (SELECT id FROM security_scan_runs WHERE schedule_id=? ORDER BY id DESC LIMIT 30)" +
    " AND status NOT IN ('queued','running') AND delivery_status!='sending'").run(run.schedule_id, run.schedule_id);
}

module.exports = { list, save, remove, history, getRun, enqueueManual, enqueueDue, processNext };
