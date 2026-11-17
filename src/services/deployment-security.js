'use strict';

const { getDb } = require('../db');
const dgx = require('./ai/dgx');
const triage = require('./ai/features/dgx-triage');
const scanResults = require('./image-scan-results');
const log = require('../utils/logger')('deployment-security');
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SCANNERS = ['trivy', 'grype'];
let running = false;
let timer = null;

function compare(before, after) {
  const parse = row => {
    const findings = JSON.parse(row.results_json);
    if (!Array.isArray(findings)) throw new Error('Stored scan evidence is invalid.');
    return new Map(findings.map(f => {
      // Scanner archive paths contain a fresh temporary directory on every scan.
      // OS package identity remains stable across archive paths and OS upgrades.
      const target = f._class === 'os-package' ? 'os-packages'
        : (f.target || '').replace(/^.*[/\\]dd-image-admission-[^/\\]+[/\\]image\.tar(?= |$)/, 'image.tar');
      return [JSON.stringify([f.id, f.package, target]), f];
    }));
  };
  const old = parse(before), current = parse(after);
  const removed = [...old].filter(([key]) => !current.has(key)).map(([, value]) => value);
  const added = [...current].filter(([key]) => !old.has(key)).map(([, value]) => value);
  const fixable = [...current.values()].filter(scanResults.hasFix);
  const blockers = [...current.values()].filter(f => !['medium', 'low', 'negligible'].includes(String(f.severity || '').toLowerCase()));
  return {
    scanner: after.scanner, previousScanId: before.id, currentScanId: after.id,
    previousCount: old.size, currentCount: current.size,
    removedCount: removed.length, addedCount: added.length,
    fixableCount: fixable.length, blockerCount: blockers.length,
    removed: removed.slice(0, 250), added: added.slice(0, 250),
    remainingFixable: fixable.slice(0, 250), truncated: Math.max(removed.length, added.length, fixable.length) > 250,
  };
}

function enqueue({ operationId, hostId, containerName, previousImageId, currentImageId }) {
  // Scheduling is separate from the deployment transaction. Failure cannot roll back a healthy deployment.
  try {
    if (!dgx.settings().enabled || previousImageId === currentImageId) return null;
    if (![previousImageId, currentImageId].every(id => IMAGE_ID.test(id || ''))) return null;
    const db = getDb();
    if (!hostId) hostId = require('../utils/host-id').defaultHost(db)?.id ?? 0;
    const result = db.prepare(`INSERT OR IGNORE INTO deployment_security_reviews
      (operation_id,host_id,container_name,previous_image_id,current_image_id) VALUES (?,?,?,?,?)`)
      .run(String(operationId), hostId, containerName, previousImageId, currentImageId);
    if (result.changes) setImmediate(() => { void drain().catch(() => log.warn('Post-deployment security queue unavailable')); });
    return result.changes ? Number(result.lastInsertRowid) : null;
  } catch {
    log.warn('Post-deployment security review could not be scheduled');
    return null;
  }
}

async function scan(docker, imageId, scanner, hostId) {
  // Reuse a recent report only when its immutable image and host identity match.
  let row = getDb().prepare(`SELECT * FROM scan_results WHERE host_id=? AND verified_image_id=?
    AND scanner=? AND scanned_at >= datetime('now','-1 day') AND scanned_at <= datetime('now','+5 minutes') ORDER BY id DESC LIMIT 1`)
    .get(hostId, imageId, scanner);
  if (!row) {
    const result = await scanResults.scanAndSave(docker, imageId, imageId, scanner, hostId);
    row = getDb().prepare('SELECT * FROM scan_results WHERE id=?').get(result.scanId);
  }
  return row;
}

async function analyze(row) {
  const config = dgx.settings();
  if (!config.enabled) throw new Error('DGX analysis is disabled. Enable it in AI settings, then retry.');
  const docker = require('./docker').getDocker(row.host_id);
  const comparisons = [], scans = [], errors = [];
  for (const scanner of SCANNERS) {
    try {
      const before = await scan(docker, row.previous_image_id, scanner, row.host_id);
      const after = await scan(docker, row.current_image_id, scanner, row.host_id);
      comparisons.push(compare(before, after));
      scans.push(after);
    } catch {
      errors.push({ scanner, error: 'Comparison unavailable. Verify scanner availability and that both images remain on this Docker host.' });
    }
  }
  if (!comparisons.length) throw new Error('Both image comparisons are unavailable. Check scanner availability and retained images, then retry.');
  let advice = null, aiError = null;
  try { advice = await triage.analyze({ scans, runningContainers: 1 }, config); }
  catch { aiError = 'DGX analysis is unavailable. The verified scanner comparison is retained; retry when the model is available.'; }
  return {
    previousImageId: row.previous_image_id, currentImageId: row.current_image_id,
    comparisons, errors, advice, aiError,
    reviewRequired: true,
    promotionEligible: comparisons.length === SCANNERS.length && comparisons.every(c => c.blockerCount === 0),
    generatedAt: new Date().toISOString(),
  };
}

async function drain() {
  if (running) return;
  running = true;
  try {
    const db = getDb();
    let row;
    while ((row = db.prepare("SELECT * FROM deployment_security_reviews WHERE status='queued' ORDER BY id LIMIT 1").get())) {
      // A conditional update claims each job if another application replica races us.
      if (!db.prepare("UPDATE deployment_security_reviews SET status='running',updated_at=datetime('now') WHERE id=? AND status='queued'").run(row.id).changes) continue;
      const heartbeat = setInterval(() => {
        try { db.prepare("UPDATE deployment_security_reviews SET updated_at=datetime('now') WHERE id=? AND status='running'").run(row.id); }
        catch { /* Shutdown may close the database before the scanner exits. */ }
      }, 30000);
      heartbeat.unref();
      try {
        const report = await analyze(row);
        db.prepare("UPDATE deployment_security_reviews SET status='complete',report_json=?,error=NULL,completed_at=datetime('now') WHERE id=?")
          .run(JSON.stringify(report), row.id);
      } catch (error) {
        db.prepare("UPDATE deployment_security_reviews SET status='failed',error=?,completed_at=datetime('now') WHERE id=?")
          .run(error.message.startsWith('DGX analysis is disabled') || error.message.startsWith('Both image comparisons')
            ? error.message : 'Security analysis failed. Check the DGX connection and scanners, then retry.', row.id);
      } finally { clearInterval(heartbeat); }
    }
  } finally { running = false; }
}

async function snapshot(hostId, stack) {
  try {
    if (!dgx.settings().enabled) return [];
    const containers = await require('./docker').getDocker(hostId).listContainers({ all: true,
      filters: JSON.stringify({ label: ['com.docker.compose.project=' + stack] }) });
    return containers.map(c => ({ name: c.Names[0].replace(/^\//, ''), service: c.Labels['com.docker.compose.service'], imageId: c.ImageID }));
  } catch { return []; }
}

async function afterStack({ hostId, stack, before, operationId }) {
  if (!before.length) return;
  const after = await snapshot(hostId, stack);
  for (const current of after) {
    const previous = before.find(c => c.name === current.name) || before.find(c => c.service && c.service === current.service);
    if (previous) enqueue({ operationId, hostId, containerName: current.name,
      previousImageId: previous.imageId, currentImageId: current.imageId });
  }
}

function list(hostId, containerName) {
  return getDb().prepare('SELECT * FROM deployment_security_reviews WHERE host_id=? AND container_name=? ORDER BY id DESC LIMIT 20')
    .all(hostId, containerName).map(({ report_json, ...row }) => ({ ...row, report: report_json ? JSON.parse(report_json) : null }));
}

function retry(id, hostId, containerName) {
  const result = getDb().prepare(`UPDATE deployment_security_reviews SET status='queued',error=NULL,report_json=NULL,
    reviewed_by=NULL,reviewed_at=NULL,completed_at=NULL WHERE id=? AND host_id=? AND container_name=? AND status IN ('failed','complete')`)
    .run(id, hostId, containerName);
  if (result.changes) setImmediate(() => { void drain().catch(() => log.warn('Post-deployment security queue unavailable')); });
  return Boolean(result.changes);
}

function acknowledge(id, hostId, containerName, username) {
  return Boolean(getDb().prepare(`UPDATE deployment_security_reviews SET reviewed_by=?,reviewed_at=datetime('now')
    WHERE id=? AND host_id=? AND container_name=? AND status='complete' AND reviewed_at IS NULL`)
    .run(username, id, hostId, containerName).changes);
}

function start() {
  if (timer) return;
  const tick = () => {
    // Heartbeats let another replica recover an interrupted job without stealing a live scan.
    getDb().prepare("UPDATE deployment_security_reviews SET status='queued' WHERE status='running' AND updated_at < datetime('now','-2 minutes')").run();
    void drain().catch(() => log.warn('Post-deployment security queue unavailable'));
  };
  timer = setInterval(tick, 60000);
  timer.unref();
  tick();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { enqueue, compare, snapshot, afterStack, list, retry, acknowledge, start, stop };
