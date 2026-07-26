'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getDb } = require('../db');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('procedures');
const dockerService = require('./docker');
const hostPermissions = require('./host-permissions');

const ACTION_TYPES = [
  'pull_image', 'restart_container', 'stop_container', 'start_container',
  'deploy_stack', 'notify_channel', 'webhook', 'wait_seconds', 'run_git_stack',
];
const HOST_ACTIONS = new Set([
  'pull_image', 'restart_container', 'stop_container', 'start_container', 'deploy_stack',
]);
const MAX_STEPS = 50;
const MAX_PARALLEL = 10;
const MAX_WAIT_SECONDS = 3600;
const MAX_LOG_ENTRIES = 500;

class ProcedureService {
  constructor() {
    this._runPromises = new Map();
  }

  list() {
    return getDb().prepare(`
      SELECT p.*,
        (SELECT status FROM procedure_runs pr WHERE pr.procedure_id = p.id
         ORDER BY pr.started_at DESC, pr.id DESC LIMIT 1) AS last_run_status,
        (SELECT started_at FROM procedure_runs pr WHERE pr.procedure_id = p.id
         ORDER BY pr.started_at DESC, pr.id DESC LIMIT 1) AS last_run_at
      FROM procedures p ORDER BY p.name
    `).all().map(row => this._decorateProcedure(row));
  }

  get(id) {
    return this._decorateProcedure(getDb().prepare('SELECT * FROM procedures WHERE id = ?').get(id));
  }

  create(data) {
    const name = this._validateName(data.name);
    const steps = this.validateSteps(data.steps);
    const maxParallel = this._validateMaxParallel(data.max_parallel ?? data.maxParallel);
    const result = getDb().prepare(`
      INSERT INTO procedures (name, description, steps_json, max_parallel, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name, String(data.description || '').trim().substring(0, 1000),
      JSON.stringify(steps), maxParallel, data.is_active === false ? 0 : 1, data.created_by
    );
    return this.get(Number(result.lastInsertRowid));
  }

  update(id, data) {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error('Procedure not found'), { status: 404 });
    const sets = [];
    const params = [];
    if (data.name !== undefined) { sets.push('name = ?'); params.push(this._validateName(data.name)); }
    if (data.description !== undefined) {
      sets.push('description = ?'); params.push(String(data.description || '').trim().substring(0, 1000));
    }
    if (data.steps !== undefined) {
      sets.push('steps_json = ?'); params.push(JSON.stringify(this.validateSteps(data.steps)));
    }
    if (data.max_parallel !== undefined || data.maxParallel !== undefined) {
      sets.push('max_parallel = ?');
      params.push(this._validateMaxParallel(data.max_parallel ?? data.maxParallel));
    }
    if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }
    if (!sets.length) return existing;
    sets.push('updated_at = ?'); params.push(now(), id);
    getDb().prepare(`UPDATE procedures SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  delete(id) {
    const active = getDb().prepare(
      "SELECT id FROM procedure_runs WHERE procedure_id = ? AND status = 'running' LIMIT 1"
    ).get(id);
    if (active) throw Object.assign(new Error('Cannot delete a procedure while it is running'), { status: 409 });
    const result = getDb().prepare('DELETE FROM procedures WHERE id = ?').run(id);
    if (!result.changes) throw Object.assign(new Error('Procedure not found'), { status: 404 });
  }

  validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('At least one procedure step is required');
    if (steps.length > MAX_STEPS) throw new Error(`A procedure may contain at most ${MAX_STEPS} steps`);
    const normalized = steps.map((raw, index) => {
      const actionType = String(raw.action_type || '').trim();
      if (!ACTION_TYPES.includes(actionType)) throw new Error(`Step ${index + 1}: unsupported action type`);
      const onError = raw.on_error || 'stop';
      if (!['stop', 'continue'].includes(onError)) throw new Error(`Step ${index + 1}: invalid on_error policy`);
      const id = String(raw.id || `step-${index + 1}`).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
        throw new Error(`Step ${index + 1}: ID must be 1-64 letters, numbers, hyphens, or underscores`);
      }
      const stage = raw.stage === undefined ? index + 1 : Number(raw.stage);
      if (!Number.isInteger(stage) || stage < 1 || stage > MAX_STEPS) {
        throw new Error(`Step ${index + 1}: stage must be an integer between 1 and ${MAX_STEPS}`);
      }
      const rawNeeds = Array.isArray(raw.needs)
        ? raw.needs : String(raw.needs || '').split(',').map(value => value.trim()).filter(Boolean);
      const needs = [...new Set(rawNeeds.map(value => String(value).trim()).filter(Boolean))];
      const config = raw.action_config && typeof raw.action_config === 'object'
        && !Array.isArray(raw.action_config) ? { ...raw.action_config } : {};
      const step = {
        id, stage, needs, enabled: raw.enabled !== false,
        action_type: actionType, action_config: config, on_error: onError,
      };

      if (HOST_ACTIONS.has(actionType)) {
        const hostId = hostPermissions.normalizeHostId(raw.target_host_id);
        if (!Number.isInteger(hostId) || hostId <= 0) throw new Error(`Step ${index + 1}: target host is required`);
        dockerService._getHostConfig(hostId);
        step.target_host_id = hostId;
      }
      if (['restart_container', 'stop_container', 'start_container'].includes(actionType)) {
        const containerId = String(config.container_id || raw.target_container || '').trim();
        if (!containerId || containerId.length > 128) throw new Error(`Step ${index + 1}: container ID/name is required`);
        config.container_id = containerId;
      } else if (actionType === 'pull_image') {
        if (!config.image || String(config.image).length > 500) throw new Error(`Step ${index + 1}: image is required`);
        config.image = String(config.image).trim();
      } else if (actionType === 'deploy_stack') {
        if (!config.stack_name || String(config.stack_name).length > 100) throw new Error(`Step ${index + 1}: stack name is required`);
        config.stack_name = String(config.stack_name).trim();
      } else if (actionType === 'run_git_stack') {
        const gitStackId = Number.parseInt(config.git_stack_id, 10);
        if (!Number.isInteger(gitStackId) || gitStackId <= 0) throw new Error(`Step ${index + 1}: Git stack is required`);
        if (!require('./git').getStack(gitStackId)) throw new Error(`Step ${index + 1}: Git stack not found`);
        config.git_stack_id = gitStackId;
        config.force = !!config.force;
      } else if (actionType === 'notify_channel') {
        if (config.channel_id !== undefined && config.channel_id !== null && config.channel_id !== '') {
          const channelId = Number.parseInt(config.channel_id, 10);
          if (!Number.isInteger(channelId) || channelId <= 0) throw new Error(`Step ${index + 1}: invalid notification channel`);
          config.channel_id = channelId;
        } else {
          delete config.channel_id;
        }
        config.message = String(config.message || 'Procedure step completed').substring(0, 4000);
      } else if (actionType === 'webhook') {
        let url;
        try { url = new URL(String(config.url || '')); } catch { throw new Error(`Step ${index + 1}: valid webhook URL is required`); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Step ${index + 1}: webhook must use HTTP or HTTPS`);
        config.url = url.toString();
        if (config.payload !== undefined && (typeof config.payload !== 'object' || Array.isArray(config.payload))) {
          throw new Error(`Step ${index + 1}: webhook payload must be an object`);
        }
      } else if (actionType === 'wait_seconds') {
        const seconds = Number(config.seconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) {
          throw new Error(`Step ${index + 1}: wait must be between 0 and ${MAX_WAIT_SECONDS} seconds`);
        }
        config.seconds = seconds;
      }
      return step;
    });

    const byId = new Map();
    for (const [index, step] of normalized.entries()) {
      if (byId.has(step.id)) throw new Error(`Step ${index + 1}: duplicate step ID "${step.id}"`);
      byId.set(step.id, step);
    }
    for (const [index, step] of normalized.entries()) {
      for (const dependencyId of step.needs) {
        const dependency = byId.get(dependencyId);
        if (!dependency) throw new Error(`Step ${index + 1}: dependency "${dependencyId}" does not exist`);
        if (dependency.stage > step.stage) {
          throw new Error(`Step ${index + 1}: dependency "${dependencyId}" is in a later stage`);
        }
      }
    }
    this._assertAcyclic(normalized);
    return normalized;
  }

  run(procedureId, actor = {}) {
    const procedure = this.get(procedureId);
    if (!procedure) throw Object.assign(new Error('Procedure not found'), { status: 404 });
    if (!procedure.is_active) throw Object.assign(new Error('Procedure is disabled'), { status: 409 });
    const alreadyRunning = getDb().prepare(
      "SELECT id FROM procedure_runs WHERE procedure_id = ? AND status = 'running' LIMIT 1"
    ).get(procedureId);
    if (alreadyRunning) throw Object.assign(new Error('Procedure is already running'), { status: 409 });
    this._assertActorAccess(actor, procedure.steps);

    let result;
    try {
      result = getDb().prepare(`
        INSERT INTO procedure_runs
          (procedure_id, procedure_name, status, total_steps, step_results_json, started_by)
        VALUES (?, ?, 'running', ?, ?, ?)
      `).run(
        procedureId, procedure.name, procedure.steps.length,
        JSON.stringify(procedure.steps.map(step => ({
          id: step.id, stage: step.stage, status: step.enabled ? 'pending' : 'disabled',
        }))),
        actor.userId || null
      );
    } catch (err) {
      if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')
          && String(err.message || '').includes('procedure_runs.procedure_id')) {
        throw Object.assign(new Error('Procedure is already running'), { status: 409 });
      }
      throw err;
    }
    const runId = Number(result.lastInsertRowid);
    this._audit('procedure_run_start', procedure, runId, actor, {
      total_steps: procedure.steps.length, stages: new Set(procedure.steps.map(step => step.stage)).size,
      max_parallel: procedure.max_parallel,
    });
    this._broadcast(runId);

    const promise = Promise.resolve()
      .then(() => this._executeRun(runId, procedure, actor))
      .catch(err => {
        log.error('Procedure runner crashed', { runId, error: err.message });
        this._finishRun(runId, 'failed', err.message);
        this._audit('procedure_run_failed', procedure, runId, actor, {
          error: String(err.message || err).substring(0, 1000), unexpected: true,
        });
      })
      .finally(() => this._runPromises.delete(runId));
    this._runPromises.set(runId, promise);
    return this.getRun(runId);
  }

  async _executeRun(runId, procedure, actor) {
    let continuedFailures = 0;
    const states = new Map();
    const indexedSteps = procedure.steps.map((step, index) => ({ step, index }));
    const stages = [...new Set(procedure.steps.map(step => step.stage))].sort((a, b) => a - b);

    for (const stage of stages) {
      if (this._isCancelRequested(runId)) {
        this._appendLog(runId, 0, 'cancelled', 'Cancellation requested; remaining stages skipped');
        this._finishRun(runId, 'cancelled');
        this._audit('procedure_run_cancelled', procedure, runId, actor, { stage });
        return;
      }
      getDb().prepare('UPDATE procedure_runs SET current_stage = ? WHERE id = ?').run(stage, runId);
      let pending = indexedSteps.filter(item => item.step.stage === stage);

      while (pending.length) {
        for (const item of [...pending]) {
          if (!item.step.enabled) {
            this._skipStep(runId, item, states, 'Step is disabled');
            pending = pending.filter(candidate => candidate !== item);
            continue;
          }
          const dependencyStates = item.step.needs.map(id => states.get(id));
          if (dependencyStates.some(status => status && status !== 'success')) {
            this._skipStep(runId, item, states, 'A required dependency did not succeed');
            pending = pending.filter(candidate => candidate !== item);
          }
        }
        if (!pending.length) break;

        const ready = pending.filter(item => item.step.needs.every(id => states.get(id) === 'success'));
        if (!ready.length) throw new Error(`Procedure stage ${stage} has unresolved dependencies`);
        const batch = ready.slice(0, procedure.max_parallel);
        const results = await Promise.all(batch.map(item => this._executeProcedureStep(
          runId, procedure, item, actor, states
        )));
        pending = pending.filter(item => !batch.includes(item));

        const cancelled = results.find(result => result.cancelled);
        if (cancelled || this._isCancelRequested(runId)) {
          this._finishRun(runId, 'cancelled');
          this._audit('procedure_run_cancelled', procedure, runId, actor, {
            stage, step: cancelled ? cancelled.index + 1 : null,
          });
          return;
        }
        const failures = results.filter(result => result.status === 'failed');
        continuedFailures += failures.filter(result => result.onError === 'continue').length;
        const stopFailure = failures.find(result => result.onError === 'stop');
        if (stopFailure) {
          this._finishRun(runId, 'failed', stopFailure.error);
          this._audit('procedure_run_failed', procedure, runId, actor, {
            stage, step: stopFailure.index + 1, error: stopFailure.error,
          });
          return;
        }
      }
    }

    const status = continuedFailures ? 'partial' : 'success';
    this._finishRun(runId, status);
    this._audit('procedure_run_complete', procedure, runId, actor, { continued_failures: continuedFailures });
  }

  async _executeProcedureStep(runId, procedure, item, actor, states) {
    const { step, index } = item;
    const started = Date.now();
    this._setStepResult(runId, index, { status: 'running', started_at: new Date().toISOString() });
    this._appendLog(runId, index, 'running', `[stage ${step.stage}] ${this._stepLabel(step)}`);
    try {
      const detail = await this._executeStep(runId, procedure, step, actor);
      const duration = Date.now() - started;
      states.set(step.id, 'success');
      this._setStepResult(runId, index, {
        status: 'success', message: detail || 'Step completed', duration_ms: duration,
        finished_at: new Date().toISOString(),
      });
      this._appendLog(runId, index, 'success', detail || 'Step completed', duration);
      this._incrementRunProgress(runId);
      return { index, status: 'success', onError: step.on_error };
    } catch (err) {
      const error = String(err.message || err).substring(0, 1000);
      const cancelled = !!(err.cancelled || this._isCancelRequested(runId));
      const status = cancelled ? 'cancelled' : 'failed';
      const duration = Date.now() - started;
      states.set(step.id, status);
      this._setStepResult(runId, index, {
        status, error, duration_ms: duration, finished_at: new Date().toISOString(),
      });
      this._appendLog(runId, index, status, error, duration);
      this._incrementRunProgress(runId);
      return { index, status, error, cancelled, onError: step.on_error };
    }
  }

  _skipStep(runId, item, states, reason) {
    states.set(item.step.id, 'skipped');
    this._setStepResult(runId, item.index, {
      status: 'skipped', message: reason, finished_at: new Date().toISOString(),
    });
    this._appendLog(runId, item.index, 'skipped', reason);
    this._incrementRunProgress(runId);
  }

  async _executeStep(runId, procedure, step, actor) {
    const config = step.action_config;
    const hostId = step.target_host_id;
    switch (step.action_type) {
      case 'pull_image':
        await dockerService.pullImage(config.image, hostId);
        return `Pulled ${config.image}`;
      case 'restart_container':
        await dockerService.getDocker(hostId).getContainer(config.container_id).restart({ t: 10 });
        return `Restarted ${config.container_id}`;
      case 'stop_container':
        await dockerService.getDocker(hostId).getContainer(config.container_id).stop({ t: 10 });
        return `Stopped ${config.container_id}`;
      case 'start_container':
        await dockerService.getDocker(hostId).getContainer(config.container_id).start();
        return `Started ${config.container_id}`;
      case 'deploy_stack':
        return this._deployComposeStack(hostId, config.stack_name);
      case 'notify_channel': {
        const message = {
          title: `Procedure: ${procedure.name}`, text: config.message,
          severity: 'info', event: 'procedure',
        };
        const service = require('./notificationChannels');
        if (config.channel_id) await service.send(config.channel_id, message);
        else await service.sendToAll(message);
        return config.channel_id ? `Notification sent to channel ${config.channel_id}` : 'Notification sent';
      }
      case 'webhook': {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await fetch(config.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              procedure: procedure.name, run_id: runId,
              ...(config.payload || {}), timestamp: new Date().toISOString(),
            }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
        } finally {
          clearTimeout(timeout);
        }
        return `Webhook delivered to ${config.url}`;
      }
      case 'wait_seconds':
        await this._waitCancellable(runId, config.seconds);
        return `Waited ${config.seconds} seconds`;
      case 'run_git_stack': {
        const gitService = require('./git');
        const deploymentId = await gitService.deployStack(config.git_stack_id, {
          force: config.force,
          actor: { userId: actor.userId, username: actor.username, ip: actor.ip },
        });
        await this._waitForGitDeployment(runId, deploymentId);
        return `Git deployment ${deploymentId} completed`;
      }
      default:
        throw new Error(`Unsupported action: ${step.action_type}`);
    }
  }

  async _deployComposeStack(hostId, stackName) {
    const containers = (await dockerService.listContainers(hostId)).filter(c => c.stack === stackName);
    if (!containers.length) throw new Error(`Stack "${stackName}" not found on target host`);
    const inspect = await dockerService.getDocker(hostId).getContainer(containers[0].id).inspect();
    const labels = inspect.Config?.Labels || {};
    const workingDir = labels['com.docker.compose.project.working_dir'];
    if (!workingDir || !path.isAbsolute(workingDir)) throw new Error('Cannot determine the stack working directory');
    const host = dockerService._getHostConfig(hostId);
    if (host.connectionType === 'ssh') {
      const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
      const result = await require('./ssh-tunnel').exec(
        hostId, `cd ${quote(workingDir)} && docker compose -p ${quote(stackName)} up -d`,
        { timeoutMs: 120000 }
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || `Compose exited ${result.exitCode}`);
    } else {
      if (!fs.existsSync(workingDir)) {
        throw new Error('Stack working directory is not available to Docker Dash; use a Git Stack step for remote TCP hosts');
      }
      const dockerEnv = require('./git')._dockerCliEnvForHost(hostId);
      try {
        execFileSync('docker', ['compose', '-p', stackName, 'up', '-d'], {
          cwd: workingDir, env: dockerEnv.env, timeout: 120000, encoding: 'utf8', stdio: 'pipe',
        });
      } finally {
        dockerEnv.cleanup();
      }
    }
    return `Deployed stack ${stackName}`;
  }

  async _waitCancellable(runId, seconds) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (this._isCancelRequested(runId)) throw Object.assign(new Error('Cancellation requested'), { cancelled: true });
      await new Promise(resolve => setTimeout(resolve, Math.min(500, end - Date.now())));
    }
  }

  async _waitForGitDeployment(runId, deploymentId) {
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      if (this._isCancelRequested(runId)) throw Object.assign(new Error('Cancellation requested after Git deploy was queued'), { cancelled: true });
      const row = getDb().prepare('SELECT status, error_message FROM git_deployments WHERE id = ?').get(deploymentId);
      if (!row) throw new Error('Git deployment history disappeared');
      if (row.status === 'success') return;
      if (row.status === 'failed') throw new Error(row.error_message || 'Git deployment failed');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Timed out waiting for Git deployment');
  }

  cancel(runId, actor = {}) {
    const run = this.getRun(runId);
    if (!run) throw Object.assign(new Error('Procedure run not found'), { status: 404 });
    if (run.status !== 'running') throw Object.assign(new Error('Procedure run is no longer active'), { status: 409 });
    getDb().prepare('UPDATE procedure_runs SET cancel_requested = 1 WHERE id = ?').run(runId);
    this._appendLog(runId, Math.max(run.current_step - 1, 0), 'info', `Cancellation requested by ${actor.username || 'user'}`);
    return this.getRun(runId);
  }

  getRun(runId) {
    return this._decorateRun(getDb().prepare('SELECT * FROM procedure_runs WHERE id = ?').get(runId));
  }

  listRuns(procedureId, { limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const rows = procedureId
      ? getDb().prepare('SELECT * FROM procedure_runs WHERE procedure_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(procedureId, safeLimit)
      : getDb().prepare('SELECT * FROM procedure_runs ORDER BY started_at DESC, id DESC LIMIT ?').all(safeLimit);
    return rows.map(row => this._decorateRun(row));
  }

  async waitForRun(runId) {
    const promise = this._runPromises.get(runId);
    if (promise) await promise;
    return this.getRun(runId);
  }

  getTemplates() {
    return [
      {
        name: 'Blue/green deploy', description: 'Pull an image, deploy a Git stack, then notify the team.',
        max_parallel: 2,
        steps: [
          { id: 'pull-image', stage: 1, needs: [], action_type: 'pull_image', target_host_id: null, action_config: { image: 'registry.example/app:next' }, on_error: 'stop' },
          { id: 'deploy', stage: 2, needs: ['pull-image'], action_type: 'run_git_stack', action_config: { git_stack_id: null, force: true }, on_error: 'stop' },
          { id: 'notify', stage: 3, needs: ['deploy'], action_type: 'notify_channel', action_config: { message: 'Blue/green deployment completed' }, on_error: 'continue' },
        ],
      },
      {
        name: 'Roll all containers', description: 'Restart independent containers in parallel and continue if one fails.',
        max_parallel: 4,
        steps: [
          { id: 'restart-one', stage: 1, needs: [], action_type: 'restart_container', target_host_id: null, action_config: { container_id: 'container-one' }, on_error: 'continue' },
          { id: 'restart-two', stage: 1, needs: [], action_type: 'restart_container', target_host_id: null, action_config: { container_id: 'container-two' }, on_error: 'continue' },
        ],
      },
      {
        name: 'Emergency stop stack', description: 'Stop critical stack containers in a controlled order.',
        max_parallel: 2,
        steps: [
          { id: 'stop-frontend', stage: 1, needs: [], action_type: 'stop_container', target_host_id: null, action_config: { container_id: 'frontend' }, on_error: 'continue' },
          { id: 'stop-backend', stage: 2, needs: ['stop-frontend'], action_type: 'stop_container', target_host_id: null, action_config: { container_id: 'backend' }, on_error: 'stop' },
        ],
      },
    ];
  }

  assertActorAccess(actor, procedureOrId, required = 'view') {
    const procedure = typeof procedureOrId === 'object' ? procedureOrId : this.get(procedureOrId);
    if (!procedure) throw Object.assign(new Error('Procedure not found'), { status: 404 });
    this._assertActorAccess(actor, procedure.steps, required);
    return procedure;
  }

  _assertActorAccess(actor, steps, required = 'operate') {
    if (actor.isAdmin) return;
    const hostIds = new Set(steps.filter(step => step.target_host_id).map(step => step.target_host_id));
    for (const step of steps.filter(item => item.action_type === 'run_git_stack')) {
      const stack = require('./git').getStack(step.action_config.git_stack_id);
      for (const hostId of stack?.target_host_ids || []) hostIds.add(hostId);
    }
    for (const hostId of hostIds) {
      const permission = hostPermissions.resolveEffectivePermission(actor.userId, hostId, false);
      const levels = { view: 1, operate: 2, admin: 3 };
      if ((levels[permission] || 0) < levels[required]) {
        throw Object.assign(new Error(`Insufficient ${required} access on one or more procedure targets`), { status: 403 });
      }
    }
  }

  _isCancelRequested(runId) {
    return !!getDb().prepare('SELECT cancel_requested FROM procedure_runs WHERE id = ?').get(runId)?.cancel_requested;
  }

  _setStepResult(runId, stepIndex, patch) {
    const row = getDb().prepare('SELECT step_results_json FROM procedure_runs WHERE id = ?').get(runId);
    const results = JSON.parse(row?.step_results_json || '[]');
    results[stepIndex] = { ...(results[stepIndex] || {}), ...patch };
    getDb().prepare('UPDATE procedure_runs SET step_results_json = ? WHERE id = ?')
      .run(JSON.stringify(results), runId);
    this._broadcast(runId);
  }

  _incrementRunProgress(runId) {
    getDb().prepare(`
      UPDATE procedure_runs SET current_step = MIN(current_step + 1, total_steps) WHERE id = ?
    `).run(runId);
    this._broadcast(runId);
  }

  _appendLog(runId, stepIndex, status, message, durationMs = null) {
    const row = getDb().prepare('SELECT log_json FROM procedure_runs WHERE id = ?').get(runId);
    const entries = JSON.parse(row?.log_json || '[]');
    entries.push({ step_index: stepIndex, status, message: String(message).substring(0, 2000), duration_ms: durationMs, at: new Date().toISOString() });
    if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
    getDb().prepare('UPDATE procedure_runs SET log_json = ? WHERE id = ?').run(JSON.stringify(entries), runId);
    this._broadcast(runId);
  }

  _finishRun(runId, status, error = null) {
    getDb().prepare(`
      UPDATE procedure_runs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?
    `).run(status, error ? String(error).substring(0, 1000) : null, runId);
    this._broadcast(runId);
  }

  _broadcast(runId) {
    try {
      require('../ws').broadcast('procedure:run:update', this.getRun(runId), `procedure:run:${runId}`);
    } catch { /* WS is unavailable during startup/tests */ }
  }

  _audit(action, procedure, runId, actor, details = {}) {
    try {
      require('./audit').log({
        userId: actor.userId || null, username: actor.username || null,
        action, targetType: 'procedure_run', targetId: String(runId),
        details: { procedure_id: procedure.id, procedure_name: procedure.name, ...details },
        ip: actor.ip || null,
      });
    } catch { /* audit remains best-effort inside background completion */ }
  }

  _stepLabel(step) {
    const labels = {
      pull_image: `Pull image ${step.action_config.image}`,
      restart_container: `Restart container ${step.action_config.container_id}`,
      stop_container: `Stop container ${step.action_config.container_id}`,
      start_container: `Start container ${step.action_config.container_id}`,
      deploy_stack: `Deploy stack ${step.action_config.stack_name}`,
      notify_channel: 'Send notification', webhook: 'Call webhook',
      wait_seconds: `Wait ${step.action_config.seconds} seconds`,
      run_git_stack: `Run Git stack ${step.action_config.git_stack_id}`,
    };
    return labels[step.action_type] || step.action_type;
  }

  _decorateProcedure(row) {
    if (!row) return null;
    const steps = JSON.parse(row.steps_json || '[]').map((step, index) => ({
      ...step,
      id: step.id || `step-${index + 1}`,
      stage: Number.isInteger(Number(step.stage)) ? Number(step.stage) : index + 1,
      needs: Array.isArray(step.needs) ? step.needs : [],
      enabled: step.enabled !== false,
    }));
    return {
      ...row, is_active: !!row.is_active,
      max_parallel: this._validateMaxParallel(row.max_parallel),
      steps,
    };
  }

  _decorateRun(row) {
    if (!row) return null;
    return {
      ...row, cancel_requested: !!row.cancel_requested,
      logs: JSON.parse(row.log_json || '[]'),
      step_results: JSON.parse(row.step_results_json || '[]'),
    };
  }

  _assertAcyclic(steps) {
    const byId = new Map(steps.map(step => [step.id, step]));
    const visiting = new Set();
    const visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Procedure dependency cycle detected at "${id}"`);
      visiting.add(id);
      for (const dependencyId of byId.get(id)?.needs || []) visit(dependencyId);
      visiting.delete(id);
      visited.add(id);
    };
    for (const step of steps) visit(step.id);
  }

  _validateMaxParallel(value) {
    const normalized = value === undefined || value === null ? 4 : Number(value);
    if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_PARALLEL) {
      throw new Error(`Procedure max_parallel must be an integer between 1 and ${MAX_PARALLEL}`);
    }
    return normalized;
  }

  _validateName(name) {
    const value = String(name || '').trim();
    if (!value) throw new Error('Procedure name is required');
    if (value.length > 100) throw new Error('Procedure name is too long');
    return value;
  }
}

module.exports = new ProcedureService();
module.exports.ACTION_TYPES = ACTION_TYPES;
