'use strict';

const { getDb } = require('../db');
const dockerService = require('./docker');
const auditService = require('./audit');
const { formatBytes } = require('../utils/helpers');
const imageAdmission = require('./image-admission');
const containerHistory = require('./container-history');

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
    const image = inspect.Config.Image;

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

      // ── Stage 3: Swap ─────────────────────────
      updateStage('swap', 'running');
      let newContainerId;
      try {
        // Encryption/storage failure must not destroy the current container.
        containerHistory.record({ inspect, hostId, action: 'pipeline', username: user?.username || 'system' });

        const wasRunning = inspect.State.Running;
        if (wasRunning) await container.stop();
        await container.remove();

        const createOpts = {
          name,
          Image: candidateId,
          Cmd: inspect.Config.Cmd,
          Env: inspect.Config.Env,
          ExposedPorts: inspect.Config.ExposedPorts,
          Labels: inspect.Config.Labels,
          WorkingDir: inspect.Config.WorkingDir,
          Entrypoint: inspect.Config.Entrypoint,
          Volumes: inspect.Config.Volumes,
          Hostname: inspect.Config.Hostname,
          User: inspect.Config.User,
          HostConfig: inspect.HostConfig,
          NetworkingConfig: { EndpointsConfig: inspect.NetworkSettings?.Networks || {} },
        };

        const newContainer = await docker.createContainer(createOpts);
        if (wasRunning) await newContainer.start();
        newContainerId = newContainer.id;

        db.prepare('UPDATE deployment_pipelines SET image_after = ? WHERE id = ?').run(candidateId, pipelineId);
        updateStage('swap', 'success', `Container recreated (${newContainerId.substring(0, 12)})`);
      } catch (err) {
        updateStage('swap', 'failed', err.message);
        failPipeline('Swap failed: ' + err.message);
        return this._getResult(pipelineId);
      }

      // ── Stage 4: Verify ───────────────────────
      if (!skipVerify && newContainerId && !inspect.State.Running) {
        updateStage('verify', 'skipped', 'Original container was stopped; replacement remains stopped');
      } else if (!skipVerify && newContainerId) {
        updateStage('verify', 'running');
        try {
          // Wait up to 30 seconds for healthy status
          let healthy = false;
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
              const newInspect = await docker.getContainer(newContainerId).inspect();
              if (!newInspect.State?.Running) break;
              const healthStatus = newInspect.State?.Health?.Status;
              if (!newInspect.State?.Health) { healthy = true; break; } // No health check defined
              if (healthStatus === 'healthy') { healthy = true; break; }
              if (healthStatus === 'unhealthy') break;
            } catch { break; }
          }
          updateStage('verify', healthy ? 'success' : 'failed', healthy ? 'Container is healthy' : 'Health check failed');
          if (!healthy) {
            failPipeline('Replacement container failed verification');
            return this._getResult(pipelineId);
          }
        } catch (err) {
          updateStage('verify', 'failed', err.message);
          failPipeline('Replacement container verification could not be completed');
          return this._getResult(pipelineId);
        }
      }

      // ── Stage 5: Notify ───────────────────────
      updateStage('notify', 'running');
      try {
        auditService.log({
          userId: user?.id, username: user?.username || 'system',
          action: 'pipeline_deploy', targetType: 'container', targetId: name,
          details: JSON.stringify({ pipelineId, image, scan: scanSummary, newId: newContainerId }),
          ip: clientIp,
        });
        updateStage('notify', 'success', 'Audit logged');
      } catch (err) {
        updateStage('notify', 'failed', err.message);
        failPipeline('Deployment audit could not be recorded');
        return this._getResult(pipelineId);
      }

      // Mark pipeline complete
      db.prepare("UPDATE deployment_pipelines SET status = ?, completed_at = datetime('now') WHERE id = ?")
        .run('success', pipelineId);

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
