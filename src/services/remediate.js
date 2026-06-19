'use strict';

// Remediation Orchestrator — v6.6
// See docs/planning/v6.6/remediation-wizard/01-feature-spec.md §4 + 02-deep-spec.md §1-4

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const log = require('../utils/logger')('remediate');
const { getDb } = require('../db');
const dockerService = require('../services/docker');
const catalog = require('./remediation-catalog');
const composeDiff = require('./compose-diff');
const dockerRunner = require('./docker-runner');
const remoteFs = require('./remote-fs');

// WS publisher — injected at server boot via setWsBroadcaster().
let _wsBroadcaster = null;
function setWsBroadcaster(fn) { _wsBroadcaster = fn; }

// v6.9.0: Snapshot cleanup. Remediation snapshots (gzipped inspect + compose
// content) can grow to ~50-200KB each × thousands over time. Cleanup job
// deletes pre_apply_snapshot + output from completed jobs older than the
// retention window — row stays (for audit) but the heavy blob is freed.
function pruneOldSnapshots({ retentionDays = null } = {}) {
  const days = Math.max(1, Number(retentionDays ?? process.env.DD_REMEDIATION_SNAPSHOT_RETENTION_DAYS) || 7);
  const result = getDb().prepare(`
    UPDATE remediation_jobs
    SET pre_apply_snapshot = NULL
    WHERE pre_apply_snapshot IS NOT NULL
      AND status IN ('success', 'failed', 'rolled_back')
      AND (completed_at IS NOT NULL AND completed_at < datetime('now', '-' || ? || ' days'))
  `).run(days);
  if (result.changes > 0) {
    log.info('Pruned remediation snapshots', { deletedBlobs: result.changes, retentionDays: days });
  }
  return { deletedBlobs: result.changes, retentionDays: days };
}

function getRollbackConfig() {
  return {
    rollbackSeconds: Math.min(3600, Math.max(30, Number(process.env.DD_REMEDIATION_ROLLBACK_SECONDS) || 60)),
    snapshotRetentionDays: Math.max(1, Number(process.env.DD_REMEDIATION_SNAPSHOT_RETENTION_DAYS) || 7),
  };
}

// v6.9.0: Notifications on apply success / failure / rollback. Fire-and-forget
// — a broken Slack webhook should NEVER block a remediation. We require()
// lazily so tests that don't exercise remediation don't load the full channel
// provider list.
function _notify(jobId, eventType, extra = {}) {
  try {
    const row = getDb().prepare(
      'SELECT id, scope_type, scope_id, host_id, mode, error_class FROM remediation_jobs WHERE id = ?'
    ).get(jobId);
    if (!row) return;
    const titles = {
      remediate_success: 'Remediation succeeded',
      remediate_failed: 'Remediation FAILED',
      remediate_rolled_back: 'Remediation rolled back',
      remediate_scheduled: 'Remediation scheduled',
    };
    const severity = eventType === 'remediate_failed' ? 'critical'
      : eventType === 'remediate_rolled_back' ? 'warning'
      : 'info';
    const scope = `${row.scope_type}:${row.scope_id}${row.host_id ? ` @host${row.host_id}` : ''}`;
    const parts = [
      `Scope: ${scope}`,
      `Mode: ${row.mode}`,
      row.error_class ? `Error: ${row.error_class}` : null,
      extra.scheduledAt ? `Scheduled for: ${extra.scheduledAt}` : null,
    ].filter(Boolean);

    // Require lazily — breaks a circular-require risk and keeps tests fast.
    const channels = require('./notificationChannels');
    channels.sendToAll({
      title: `${titles[eventType] || eventType} (job #${jobId})`,
      text: parts.join(' · '),
      severity,
      event: eventType,
      embed: true,
    }).catch((err) => log.debug('notification dispatch failed (non-fatal)', { jobId, eventType, error: err.message }));
  } catch (err) {
    log.debug('notification wiring failed (non-fatal)', { jobId, eventType, error: err.message });
  }
}
function _publishJobUpdate(jobId) {
  if (!_wsBroadcaster) return;
  try {
    const row = getDb().prepare(
      'SELECT id, status, error_class, output, current_step, started_at, completed_at, git_branch, git_pr_url FROM remediation_jobs WHERE id = ?'
    ).get(jobId);
    if (row) _wsBroadcaster(`remediate:job:${jobId}`, row);
  } catch (e) {
    log.warn('WS publish failed (non-fatal)', { jobId, error: e.message });
  }
}

// ─── Planning ──────────────────────────────────────────

/**
 * Build a remediation plan for one or more containers.
 * @param {object} args
 * @param {Array<{id: string, hostId: number}>} args.containers
 * @param {string[]} args.findings - catalog codes to apply
 * @returns {Promise<object>} plan
 */
async function plan({ containers, findings }) {
  if (!Array.isArray(containers) || containers.length === 0) {
    throw new Error('containers array required');
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error('findings array required');
  }

  const steps = [];
  const warnings = [];
  let totalDowntimeMs = 0;
  let gitBacked = false;

  for (const ref of containers) {
    const docker = dockerService.getDocker(ref.hostId || 0);
    let inspect;
    try {
      inspect = await docker.getContainer(ref.id).inspect();
    } catch (e) {
      warnings.push(`Cannot inspect ${ref.id}: ${e.message}`);
      continue;
    }

    // Augment with live stats for memory heuristics
    try {
      const statsStream = await docker.getContainer(ref.id).stats({ stream: false });
      inspect._stats = statsStream;
    } catch { /* stats optional */ }

    const labels = inspect.Config?.Labels || {};
    const composeFile = labels['com.docker.compose.project.config_files']?.split(',')[0] || null;
    const serviceName = labels['com.docker.compose.service'] || null;
    const stackName = labels['com.docker.compose.project'] || null;

    // If multiple compose files, warn
    if (labels['com.docker.compose.project.config_files']?.includes(',')) {
      warnings.push(`Container ${inspect.Name} is part of a multi-file compose project; only the first file is supported in v6.6.`);
    }

    const composeFileExists = composeFile ? await remoteFs.fileExists(ref.hostId || 0, composeFile) : false;
    let composeServiceBlock = null;
    let parsedComposeBefore = null;
    if (composeFileExists && serviceName) {
      try {
        const YAML = require('yaml');
        parsedComposeBefore = await remoteFs.readFile(ref.hostId || 0, composeFile);
        const doc = YAML.parseDocument(parsedComposeBefore);
        composeServiceBlock = doc.getIn(['services', serviceName])?.toJSON?.() || null;
      } catch (e) {
        warnings.push(`Cannot parse compose file ${composeFile}: ${e.message}`);
      }
    }

    // Collect patches + CLI commands for this container
    const compiledPatch = {};
    const cliCommands = [];
    let liveUpdateCmd = null;
    const appliedFindings = [];
    let requiresRecreation = false;
    let estimatedDowntimeMs = 0;

    for (const code of findings) {
      const entry = catalog.get(code);
      if (!entry) continue;
      if (!entry.applies(inspect)) continue;  // not applicable to this container

      const result = entry.plan(inspect, composeServiceBlock);
      appliedFindings.push({
        code,
        title: entry.title,
        severity: entry.severity,
        liveUpdatable: entry.liveUpdatable,
        requiresRecreation: entry.requiresRecreation,
        riskLevel: entry.riskLevel,
        riskNotes: entry.riskNotes,
        notes: result.notes,
      });

      // Merge compose patches
      Object.assign(compiledPatch, mergePatch(compiledPatch, result.composePatch));

      // CLI commands (live updates collated separately)
      if (result.cliCommands) cliCommands.push(...result.cliCommands);
      if (result.liveUpdate) {
        if (liveUpdateCmd) {
          // Merge multiple docker update flags into one command
          liveUpdateCmd = mergeDockerUpdateFlags(liveUpdateCmd, result.liveUpdate);
        } else {
          liveUpdateCmd = result.liveUpdate;
        }
      }

      if (entry.requiresRecreation) {
        requiresRecreation = true;
        estimatedDowntimeMs = Math.max(estimatedDowntimeMs, 3000);
      }
    }

    totalDowntimeMs += estimatedDowntimeMs;

    // Generate diff if we have a compose file + non-empty patch
    // Uses `diffYamlStrings` so the same code path works for local + remote:
    // we already have `parsedComposeBefore` in memory from the read above.
    let diff = null;
    if (composeFileExists && serviceName && Object.keys(compiledPatch).length > 0 && parsedComposeBefore) {
      try {
        const diffResult = composeDiff.diffYamlStrings(parsedComposeBefore, { [serviceName]: compiledPatch }, composeFile);
        diff = diffResult.unified;
      } catch (e) {
        warnings.push(`Cannot diff compose for ${inspect.Name}: ${e.message}`);
      }
    }

    // Git-backed detection (labels may include git info; fallback via stacks table)
    const db = getDb();
    if (stackName) {
      try {
        const stackRow = db.prepare('SELECT git_repo_id FROM git_stacks WHERE stack_name = ? LIMIT 1').get(stackName);
        if (stackRow?.git_repo_id) gitBacked = true;
      } catch { /* table may not exist pre-v6 */ }
    }

    steps.push({
      containerId: inspect.Id,
      containerName: inspect.Name?.replace(/^\//, ''),
      hostId: ref.hostId || 0,
      stackName,
      serviceName,
      composeFile,
      composeFileExists,
      findings: appliedFindings,
      composePatch: compiledPatch,
      cliCommands,
      liveUpdate: liveUpdateCmd,
      diff,
      requiresRecreation,
      estimatedDowntimeMs,
    });
  }

  const planObj = {
    planId: null,  // set by caller if persisting
    steps,
    totalDowntimeMs,
    gitBacked,
    warnings,
    generatedAt: new Date().toISOString(),
  };

  // Assign a stable SHA-256 as planId
  planObj.planId = crypto.createHash('sha256')
    .update(JSON.stringify({ steps: planObj.steps, totalDowntimeMs }))
    .digest('hex').substring(0, 16);

  return planObj;
}

// ─── Apply ─────────────────────────────────────────────

/**
 * Create a remediation_jobs row + kick off async apply.
 *
 * If `scheduledAt` is provided (ISO 8601 datetime), the job is persisted with
 * status='scheduled' and remediation-scheduler picks it up when the time
 * arrives. If omitted, status='pending' and the caller should invoke runJob.
 *
 * @param {object} args { plan, mode, userId, hostId, scope, scheduledAt? }
 * @returns {{jobId: number, scheduled: boolean}}
 */
function createJob({ plan, mode, userId, hostId, scope, scheduledAt }) {
  const db = getDb();

  // Concurrency: refuse if another job is running / scheduled for the same scope.
  // 'scheduled' counts as in-progress for this check — we don't want two
  // overlapping future jobs on one container.
  const existing = db.prepare(`
    SELECT id FROM remediation_jobs
    WHERE status IN ('pending', 'running', 'scheduled')
      AND scope_type = ?
      AND scope_id = ?
      AND host_id = ?
    LIMIT 1
  `).get(scope.type, scope.id, hostId || 0);
  if (existing) {
    const err = new Error(`A remediation is already in progress or scheduled for ${scope.type}:${scope.id} (job ${existing.id})`);
    err.code = 'CONCURRENT_JOB';
    err.existingJobId = existing.id;
    throw err;
  }

  // Validate scheduledAt if provided
  let scheduledIso = null;
  if (scheduledAt) {
    const ts = new Date(scheduledAt);
    if (Number.isNaN(ts.getTime())) throw new Error('scheduledAt must be a valid ISO datetime');
    const nowMs = Date.now();
    if (ts.getTime() < nowMs + 60_000) throw new Error('scheduledAt must be at least 60 seconds in the future');
    if (ts.getTime() > nowMs + 30 * 24 * 3600_000) throw new Error('scheduledAt must be within 30 days');
    // Normalize to SQLite-friendly UTC string
    scheduledIso = ts.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }

  const initialStatus = scheduledIso ? 'scheduled' : 'pending';

  const result = db.prepare(`
    INSERT INTO remediation_jobs
      (mode, scope_type, scope_id, host_id, plan_json, status, created_by, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mode, scope.type, String(scope.id), hostId || 0, JSON.stringify(plan), initialStatus, userId || null, scheduledIso);

  const jobId = result.lastInsertRowid;
  if (scheduledIso) _notify(jobId, 'remediate_scheduled', { scheduledAt: scheduledIso });

  return { jobId, scheduled: Boolean(scheduledIso), scheduledAt: scheduledIso };
}

/**
 * Execute a remediation job asynchronously. Returns immediately with a runner promise.
 * Caller should not await — the runner updates the DB as it progresses.
 *
 * NOTE: Session 1 scope — this is the SKELETON. Full recreate logic + health checks +
 * rollback land in Session 2 alongside docker-runner.js.
 */
async function runJob(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM remediation_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== 'pending' && job.status !== 'scheduled') {
    throw new Error(`Job ${jobId} is ${job.status}, not pending or scheduled`);
  }

  const plan = JSON.parse(job.plan_json);

  db.prepare(`UPDATE remediation_jobs SET status='running', started_at=datetime('now') WHERE id=?`).run(jobId);
  log.info('Remediation job started', { jobId, mode: job.mode });
  _publishJobUpdate(jobId);

  try {
    if (job.mode === 'apply-local') {
      await _applyLocal(jobId, plan);
    } else if (job.mode === 'pr') {
      await _openPr(jobId, plan);
    } else if (job.mode === 'artifact') {
      // Artifact mode doesn't actually apply — just marks success so UI can download
      db.prepare(`UPDATE remediation_jobs SET status='success', completed_at=datetime('now'), output='Artifact ready for download' WHERE id=?`).run(jobId);
      _publishJobUpdate(jobId);
    } else {
      throw new Error(`Unknown mode: ${job.mode}`);
    }
  } catch (e) {
    log.error('Remediation job failed', { jobId, error: e.message });
    db.prepare(`
      UPDATE remediation_jobs
      SET status='failed', error_class=?, output=?, completed_at=datetime('now')
      WHERE id=?
    `).run(_classifyError(e), (db.prepare('SELECT output FROM remediation_jobs WHERE id=?').get(jobId).output || '') + '\n[ERROR] ' + e.message, jobId);
    _publishJobUpdate(jobId);
    _notify(jobId, 'remediate_failed');
  }
}

async function _applyLocal(jobId, plan) {
  const db = getDb();
  const output = [];
  const appendLog = (line) => {
    output.push(line);
    db.prepare(`UPDATE remediation_jobs SET output=?, current_step=? WHERE id=?`).run(output.join('\n'), line, jobId);
    _publishJobUpdate(jobId);
  };

  // Snapshot pre-apply state for rollback
  const snapshots = {};
  for (const step of plan.steps) {
    try {
      const docker = dockerService.getDocker(step.hostId || 0);
      const inspect = await docker.getContainer(step.containerId).inspect();
      let composeFileContent = null;
      if (step.composeFileExists && step.composeFile) {
        composeFileContent = await remoteFs.readFile(step.hostId || 0, step.composeFile);
      }
      snapshots[step.containerId] = { inspect, composeFileContent, hostId: step.hostId || 0 };
    } catch (e) {
      appendLog(`[warn] Cannot snapshot ${step.containerId}: ${e.message}`);
    }
  }
  const snapshotBlob = zlib.gzipSync(JSON.stringify(snapshots)).toString('base64');
  db.prepare(`UPDATE remediation_jobs SET pre_apply_snapshot=? WHERE id=?`).run(snapshotBlob, jobId);
  appendLog(`✓ Snapshotted ${Object.keys(snapshots).length} container(s) for rollback`);

  // Phase 1: live updates (zero downtime). Local → child_process;
  // remote → SSH exec on the target host.
  for (const step of plan.steps) {
    if (!step.liveUpdate) continue;
    appendLog(`⏳ Live update: ${step.containerName} → ${step.liveUpdate}`);
    try {
      if (step.hostId && step.hostId > 0) {
        const sshTunnel = require('./ssh-tunnel');
        const result = await sshTunnel.exec(step.hostId, step.liveUpdate, { timeoutMs: 30000 });
        if (result.exitCode !== 0) {
          throw new Error(`SSH exec exit=${result.exitCode}: ${result.stderr || result.stdout}`);
        }
      } else {
        const { execFileSync } = require('child_process');
        const [cmd, ...args] = step.liveUpdate.split(' ');
        // v8.7.15 — explicit 30s timeout matching the SSH sibling path
        // above. Without this, a hung child process during a remediation
        // plan blocks the entire plan execution thread and the user's HTTP
        // request hangs indefinitely.
        execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
      }
      appendLog(`✓ ${step.containerName} updated`);
    } catch (e) {
      throw new Error(`Live update failed for ${step.containerName}: ${e.message}`);
    }
  }

  // Phase 2: group compose rewrites by file, then recreate in topo order
  const stepsByFile = {};
  for (const step of plan.steps) {
    if (!step.requiresRecreation || !step.composeFileExists) continue;
    if (!stepsByFile[step.composeFile]) stepsByFile[step.composeFile] = [];
    stepsByFile[step.composeFile].push(step);
  }

  for (const [composeFile, steps] of Object.entries(stepsByFile)) {
    try {
      // Build patches object per service
      const patchesByService = {};
      for (const step of steps) {
        patchesByService[step.serviceName] = step.composePatch;
      }

      const hostId = steps[0].hostId || 0;
      appendLog(`⏳ Writing updated compose file: ${composeFile}${hostId ? ` (host ${hostId})` : ''}`);
      // Read → patch via diffYamlStrings → atomic write (local fs OR SSH sftp)
      const before = await remoteFs.readFile(hostId, composeFile);
      const diffResult = composeDiff.diffYamlStrings(before, patchesByService, composeFile);
      if (hostId > 0) {
        // SFTP doesn't have an atomic rename on all platforms; for remote we
        // write the file directly. Concurrent writers are not expected (we
        // hold the remediate job lock per scope).
        await remoteFs.writeFile(hostId, composeFile, diffResult.after);
      } else {
        fs.writeFileSync(composeFile + '.tmp', diffResult.after, 'utf8');
        fs.renameSync(composeFile + '.tmp', composeFile);
      }
      appendLog(`✓ Compose file updated (${steps.length} service(s))`);

      // Recreate in topo order with health check
      const YAML = require('yaml');
      const composeDoc = YAML.parse(diffResult.after);
      const services = steps.map(s => s.serviceName);
      const docker = dockerService.getDocker(hostId);

      await dockerRunner.recreateInOrder({
        composeFile, composeDoc, services, docker, hostId, onLog: appendLog,
      });

    } catch (e) {
      appendLog(`✗ Recreate failed: ${e.message}`);
      // Auto-rollback
      appendLog(`⏳ Auto-rolling back...`);
      try {
        await dockerRunner.rollback({
          snapshots,
          onLog: appendLog,
          hostId: plan.steps[0]?.hostId || 0,
        });
        db.prepare(`UPDATE remediation_jobs SET status='rolled_back', error_class=?, completed_at=datetime('now') WHERE id=?`)
          .run(_classifyError(e), jobId);
        appendLog(`✓ Rollback complete`);
        _publishJobUpdate(jobId);
        _notify(jobId, 'remediate_rolled_back');
      } catch (rollbackErr) {
        db.prepare(`UPDATE remediation_jobs SET status='failed', error_class='rollback', output=?, completed_at=datetime('now') WHERE id=?`)
          .run(output.join('\n') + '\n[ROLLBACK FAILED] ' + rollbackErr.message, jobId);
        appendLog(`✗ ROLLBACK FAILED — manual intervention required`);
        _publishJobUpdate(jobId);
        _notify(jobId, 'remediate_failed');
      }
      throw e;
    }
  }

  // v6.9.0: rollback window configurable via env (default 60s). Range [30, 3600].
  const rollbackSeconds = Math.min(3600, Math.max(30, Number(process.env.DD_REMEDIATION_ROLLBACK_SECONDS) || 60));
  db.prepare(`
    UPDATE remediation_jobs
    SET status='success', completed_at=datetime('now'),
        rollback_deadline=datetime('now', '+' || ? || ' seconds')
    WHERE id=?
  `).run(rollbackSeconds, jobId);
  appendLog(`✓ Job complete. Rollback available for ${rollbackSeconds} seconds.`);
  _publishJobUpdate(jobId);
  _notify(jobId, 'remediate_success');
  log.info('Remediation job succeeded', { jobId, rollbackSeconds });
}

// ─── Manual rollback (called from route) ───────────────

async function executeRollback(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM remediation_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== 'success') throw new Error(`Cannot rollback job in status '${job.status}'`);
  if (!job.rollback_deadline || new Date(job.rollback_deadline) < new Date()) {
    throw new Error('Rollback window expired');
  }
  if (!job.pre_apply_snapshot) throw new Error('No snapshot available for rollback');

  const snapshots = JSON.parse(zlib.gunzipSync(Buffer.from(job.pre_apply_snapshot, 'base64')).toString('utf8'));
  const output = [job.output || ''];
  const appendLog = (line) => {
    output.push(line);
    db.prepare(`UPDATE remediation_jobs SET output=?, current_step=? WHERE id=?`).run(output.join('\n'), line, jobId);
    _publishJobUpdate(jobId);
  };

  appendLog(`⏳ Manual rollback initiated for job ${jobId}`);

  try {
    await dockerRunner.rollback({
      snapshots,
      onLog: appendLog,
      hostId: job.host_id || 0,
    });
    db.prepare(`UPDATE remediation_jobs SET status='rolled_back', completed_at=datetime('now') WHERE id=?`).run(jobId);
    appendLog(`✓ Rollback complete`);
    _publishJobUpdate(jobId);
    _notify(jobId, 'remediate_rolled_back');
    log.info('Manual rollback succeeded', { jobId });
    return { ok: true };
  } catch (e) {
    db.prepare(`UPDATE remediation_jobs SET status='failed', error_class='rollback' WHERE id=?`).run(jobId);
    appendLog(`✗ Rollback failed: ${e.message}`);
    _publishJobUpdate(jobId);
    _notify(jobId, 'remediate_failed');
    throw e;
  }
}

async function _openPr(jobId, plan) {
  const db = getDb();
  const path = require('path');
  const os = require('os');
  const simpleGit = require('simple-git');

  const output = [];
  const appendLog = (line) => {
    output.push(line);
    db.prepare(`UPDATE remediation_jobs SET output=?, current_step=? WHERE id=?`).run(output.join('\n'), line, jobId);
    _publishJobUpdate(jobId);
  };

  // Group steps by stack; for v1 we only support single-stack PRs
  const stackNames = new Set(plan.steps.map(s => s.stackName).filter(Boolean));
  if (stackNames.size !== 1) {
    throw new Error(`Git-PR mode requires exactly one stack; got ${stackNames.size}`);
  }
  const stackName = [...stackNames][0];

  // Resolve repo info from git_stacks table
  const stackRow = db.prepare('SELECT repo_url, branch, compose_path, credential_id FROM git_stacks WHERE stack_name = ?').get(stackName);
  if (!stackRow) throw new Error(`Stack '${stackName}' is not git-managed`);

  appendLog(`⏳ Git-PR mode: stack=${stackName}, repo=${stackRow.repo_url}, base-branch=${stackRow.branch}`);

  // Workspace for the PR branch
  const workspace = path.join(os.tmpdir(), `dd-remediate-pr-${jobId}-${Date.now()}`);
  const git = simpleGit();

  try {
    // Clone with credentials if needed (delegate to existing git service for url-with-auth)
    // Simple approach: use simpleGit.clone — for credential support, the git service has _buildAuthUrl
    let cloneUrl = stackRow.repo_url;
    if (stackRow.credential_id) {
      const gitService = require('./git');
      try {
        cloneUrl = gitService._buildAuthUrl
          ? gitService._buildAuthUrl(stackRow.repo_url, stackRow.credential_id)
          : stackRow.repo_url;
      } catch { /* fall back to no auth */ }
    }

    appendLog(`⏳ Cloning ${stackRow.repo_url} (branch ${stackRow.branch})...`);
    await git.clone(cloneUrl, workspace, ['--depth', '50', '--branch', stackRow.branch]);
    appendLog(`✓ Cloned to ${workspace}`);

    // Create a new branch
    const branchName = `docker-dash/remediate-${plan.planId}`;
    const repoGit = simpleGit(workspace);
    await repoGit.checkoutLocalBranch(branchName);
    appendLog(`✓ Created branch ${branchName}`);

    // Apply compose patches — one patch per service, merged into the single compose file
    const patchesByService = {};
    for (const step of plan.steps) {
      if (step.serviceName && step.composePatch && Object.keys(step.composePatch).length > 0) {
        patchesByService[step.serviceName] = step.composePatch;
      }
    }
    if (Object.keys(patchesByService).length === 0) {
      throw new Error('No compose patches to apply');
    }

    const composeFilePath = path.join(workspace, stackRow.compose_path || 'docker-compose.yml');
    if (!fs.existsSync(composeFilePath)) {
      throw new Error(`Compose file not found in repo at ${stackRow.compose_path}`);
    }
    appendLog(`⏳ Applying patches to ${stackRow.compose_path}...`);
    const diffResult = composeDiff.diffComposeFile(composeFilePath, patchesByService);
    fs.writeFileSync(composeFilePath, diffResult.after, 'utf8');
    appendLog(`✓ Patches applied`);

    // Commit
    const findingCodes = [...new Set(plan.steps.flatMap(s => s.findings.map(f => f.code)))];
    const commitMsg = `remediate: fix ${findingCodes.join(', ')} on stack ${stackName}\n\nGenerated by Docker Dash Remediation Wizard.\nPlan ID: ${plan.planId}\nAffected services: ${Object.keys(patchesByService).join(', ')}`;
    await repoGit.add([stackRow.compose_path]);
    await repoGit.addConfig('user.email', 'bot@docker-dash.local');
    await repoGit.addConfig('user.name', 'Docker Dash');
    await repoGit.commit(commitMsg);
    appendLog(`✓ Committed`);

    // Push
    appendLog(`⏳ Pushing branch...`);
    await repoGit.push('origin', branchName, ['--set-upstream']);
    appendLog(`✓ Pushed branch ${branchName}`);

    // Construct PR URL (best-effort: GitHub/GitLab/Gitea conventions)
    let prUrl = null;
    const repo = stackRow.repo_url.replace(/\.git$/, '');
    if (repo.includes('github.com')) {
      prUrl = `${repo}/compare/${stackRow.branch}...${encodeURIComponent(branchName)}?expand=1`;
    } else if (repo.includes('gitlab')) {
      prUrl = `${repo}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branchName)}`;
    } else {
      prUrl = `${repo} (branch ${branchName}) — open PR manually`;
    }

    appendLog(`✓ PR URL: ${prUrl}`);

    db.prepare(`
      UPDATE remediation_jobs
      SET status='success', git_branch=?, git_pr_url=?, completed_at=datetime('now')
      WHERE id=?
    `).run(branchName, prUrl, jobId);
    _publishJobUpdate(jobId);
    _notify(jobId, 'remediate_success');

    log.info('Git-PR remediation pushed', { jobId, branchName, prUrl });
  } finally {
    // Cleanup workspace
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

function _classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('docker') && msg.includes('not found')) return 'docker';
  if (msg.includes('compose')) return 'compose';
  if (msg.includes('git')) return 'git';
  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('health')) return 'health';
  return 'other';
}

// ─── Helpers ───────────────────────────────────────────

/**
 * Merge two patch objects. Used when multiple findings on the same container
 * produce overlapping patches (e.g., both no-new-privileges and dangerous-caps
 * touch `security_opt` / `cap_add`).
 */
function mergePatch(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) {
      out[k] = null;
    } else if (v && typeof v === 'object' && v.$add && out[k]?.$add) {
      out[k] = { $add: [...new Set([...out[k].$add, ...v.$add])] };
    } else if (v && typeof v === 'object' && v.$remove && out[k]?.$remove) {
      out[k] = { $remove: [...new Set([...out[k].$remove, ...v.$remove])] };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Merge two `docker update ...` commands into one.
 * Example: "docker update --memory 512m abc" + "docker update --cpus 1 abc"
 *       → "docker update --memory 512m --cpus 1 abc"
 */
function mergeDockerUpdateFlags(cmdA, cmdB) {
  const parseFlags = (cmd) => {
    const parts = cmd.split(/\s+/);
    const containerId = parts[parts.length - 1];
    const flags = parts.slice(2, -1);  // skip "docker", "update", last (container ID)
    return { flags, containerId };
  };
  const a = parseFlags(cmdA);
  const b = parseFlags(cmdB);
  if (a.containerId !== b.containerId) return cmdA;  // different containers, can't merge
  return `docker update ${a.flags.join(' ')} ${b.flags.join(' ')} ${a.containerId}`;
}

module.exports = {
  plan,
  createJob,
  runJob,
  executeRollback,
  pruneOldSnapshots,
  getRollbackConfig,
  setWsBroadcaster,
  _classifyError,
  mergePatch,
  mergeDockerUpdateFlags,
};
