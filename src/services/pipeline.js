'use strict';

const { getDb } = require('../db');
const dockerService = require('./docker');
const auditService = require('./audit');
const { formatBytes } = require('../utils/helpers');
const imageAdmission = require('./image-admission');
const containerReplacement = require('./container-replacement');
const { imageReference } = require('../utils/container-config');

/**
 * Deployment Pipeline Service
 * Orchestrates multi-stage container deployments: pull -> scan -> swap -> verify -> notify
 */
class PipelineService {
  /**
   * Start a deployment pipeline
   * @param {Object} opts - Pipeline options
   * @param {string} opts.containerId - Docker container ID
   * @param {number} opts.hostId - Host ID
   * @param {Object} opts.user - User object
   * @param {boolean} opts.skipScan - Skip vulnerability scan
   * @param {boolean} opts.skipVerify - Skip health check verification
   * @param {string} opts.clientIp - Client IP for audit
   * @returns {Object} Pipeline result
   */
  async start(opts) {
    const { containerId, hostId = 0, user, skipScan = false, skipVerify = false, clientIp } = opts;
    if (typeof skipScan !== 'boolean' || typeof skipVerify !== 'boolean') throw new Error('Pipeline skip options must be boolean');
    const docker = dockerService.getDocker(hostId);
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');
    const image = imageReference(inspect);

    if (dockerService.isSelf(inspect.Id)) {
      throw new Error('Cannot run pipeline on Docker Dash itself');
    }

    // Create pipeline record
    const stages = [
      { name: 'pull', label: 'Pull Image', status: 'pending', icon: 'fa-download' },
      { name: 'scan', label: 'Security Scan', status: skipScan ? 'skipped' : 'pending', icon: 'fa-shield-alt' },
      { name: 'swap', label: 'Container Swap', status: 'pending', icon: 'fa-exchange-alt' },
      { name: 'verify', label: 'Health Check', status: skipVerify ? 'skipped' : 'pending', icon: 'fa-heartbeat' },
      { name: 'notify', label: 'Notify', status: 'pending', icon: 'fa-bell' },
    ];

    const db = getDb();
    const pipelineId = db.prepare(`
      INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by, image_before)
      VALUES (?, ?, ?, 'running', ?, ?, ?)
    `).run(inspect.Id, name, hostId, JSON.stringify(stages), user?.username || 'system', image).lastInsertRowid;

    const updateStage = (stageName, status, detail) => {
      const stage = stages.find(s => s.name === stageName);
      if (stage) {
        stage.status = status;
        if (detail) stage.detail = detail;
        stage.completedAt = new Date().toISOString();
        if (status === 'running') stage.startedAt = new Date().toISOString();
      }
      db.prepare('UPDATE deployment_pipelines SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), pipelineId);
    };

    const failPipeline = (error) => {
      db.prepare("UPDATE deployment_pipelines SET status = ?, error = ?, completed_at = datetime('now') WHERE id = ?")
        .run('failed', error, pipelineId);
    };

    try {
      // ── Stage 1: Pull ─────────────────────────
      updateStage('pull', 'running');
      let candidateId;
      try {
        // v8.7.28 — uses shared docker-pull helper with 10-min timeout.
        await require('../utils/docker-pull').pullImage(docker, image);
        const newImg = await docker.getImage(image).inspect();
        if (!/^sha256:[a-f0-9]{64}$/.test(newImg.Id || '')) throw new Error('Invalid pulled image identity');
        candidateId = newImg.Id;
        updateStage('pull', 'success', `Pulled ${image} (${formatBytes(newImg.Size || 0)})`);
      } catch (err) {
        updateStage('pull', 'failed', err.message);
        failPipeline('Pull failed: ' + err.message);
        return this._getResult(pipelineId);
      }

      // ── Stage 2: Scan ─────────────────────────
      let scanPassed = true;
      let scanSummary = null;
      if (!skipScan) {
        updateStage('scan', 'running');
        scanSummary = await imageAdmission.scanImage(docker, candidateId);
        scanPassed = scanSummary.passed === true;
        updateStage('scan', scanPassed ? 'success' : 'failed', scanSummary.reason
          || `${scanSummary.critical} critical, ${scanSummary.high} high, ${scanSummary.unknown} unknown scanner findings`);

        if (!scanPassed) {
          auditService.log({ userId: user?.id, username: user?.username || 'system',
            action: 'pipeline_scan_blocked', targetType: 'container', targetId: name,
            details: { pipelineId, image, scan: scanSummary }, ip: clientIp });
          failPipeline('Required image scan denied deployment');
          return this._getResult(pipelineId);
        }
      }

      // Swap, verification and audit form one recoverable operation.
      updateStage('swap', 'running');
      let failingStage = 'swap';
      try {
        const result = await containerReplacement.replace({ docker, inspect, imageId: candidateId,
          hostId, action: 'pipeline', username: user?.username || 'system', skipHealth: skipVerify,
          onPhase: phase => {
            if (phase === 'verifying') {
              updateStage('swap', 'success', 'Candidate created; original retained for recovery');
              failingStage = 'verify';
              updateStage('verify', skipVerify || !inspect.State.Running ? 'skipped' : 'running',
                !inspect.State.Running ? 'Original container was stopped; replacement remains stopped' : undefined);
            }
          },
          commit: (newId, operationId) => {
            if (!skipVerify && inspect.State.Running) updateStage('verify', 'success', 'Container passed verification');
            failingStage = 'notify';
            updateStage('notify', 'running');
            auditService.log({ userId: user?.id, username: user?.username || 'system',
              action: 'pipeline_deploy', targetType: 'container', targetId: name,
              details: { pipelineId, image, scan: scanSummary, newId, operationId }, ip: clientIp });
            updateStage('notify', 'success', 'Audit logged');
            db.prepare("UPDATE deployment_pipelines SET image_after=?, status='success', completed_at=datetime('now') WHERE id=?")
              .run(candidateId, pipelineId);
          },
        });
        if (result.cleanupRequired) {
          try { updateStage('swap', 'success', `Replacement active; retained recovery requires cleanup (operation ${result.operationId})`); }
          catch { /* The deployment and operation commit are already durable. */ }
        }
      } catch (err) {
        updateStage(failingStage, 'failed', err.message);
        failPipeline(err.message);
      }

      return this._getResult(pipelineId);
    } catch (err) {
      failPipeline(err.message);
      return this._getResult(pipelineId);
    }
  }

  _getResult(pipelineId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM deployment_pipelines WHERE id = ?').get(pipelineId);
    if (!row) return null;
    try { row.stages = JSON.parse(row.stages_json); } catch { row.stages = []; }
    return row;
  }

  getHistory(containerName, hostId = 0, limit = 10) {
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT * FROM deployment_pipelines
        WHERE container_name = ? AND host_id = ?
        ORDER BY started_at DESC LIMIT ?
      `).all(containerName, hostId, limit);

      return rows.map(r => {
        try { r.stages = JSON.parse(r.stages_json); } catch { r.stages = []; }
        return r;
      });
    } catch {
      return [];
    }
  }

  getStatus(pipelineId) {
    return this._getResult(pipelineId);
  }
}

module.exports = new PipelineService();
