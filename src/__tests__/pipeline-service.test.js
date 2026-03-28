'use strict';

// Integration tests for the pipeline service.
// Tests DB-facing methods (_getResult, getHistory, getStatus) with in-memory DB.
// The start() method requires Docker, so it is not tested here.

process.env.APP_SECRET = 'test-secret-for-pipeline';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'PipelineTest123!';

const { getDb } = require('../db');
const db = getDb();

const authService = require('../services/auth');
authService.seedAdmin();

// The pipeline service is a singleton; we need its DB-facing methods
const pipelineService = require('../services/pipeline');

describe('Pipeline Service — DB operations', () => {
  let pipelineId;

  const sampleStages = [
    { name: 'pull', label: 'Pull Image', status: 'success', icon: 'fa-download' },
    { name: 'scan', label: 'Security Scan', status: 'skipped', icon: 'fa-shield-alt' },
    { name: 'swap', label: 'Container Swap', status: 'success', icon: 'fa-exchange-alt' },
    { name: 'verify', label: 'Health Check', status: 'success', icon: 'fa-heartbeat' },
    { name: 'notify', label: 'Notify', status: 'success', icon: 'fa-bell' },
  ];

  beforeAll(() => {
    // Insert a pipeline record directly into DB
    const result = db.prepare(`
      INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by, image_before, image_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('abc123', 'my-app', 0, 'success', JSON.stringify(sampleStages), 'admin', 'node:16', 'node:18');
    pipelineId = Number(result.lastInsertRowid);
  });

  // ── _getResult ─────────────────────────────────────────────
  describe('_getResult()', () => {
    it('should return pipeline record with parsed stages', () => {
      const result = pipelineService._getResult(pipelineId);
      expect(result).toBeTruthy();
      expect(result.container_name).toBe('my-app');
      expect(result.status).toBe('success');
      expect(result.image_before).toBe('node:16');
      expect(result.image_after).toBe('node:18');
      expect(Array.isArray(result.stages)).toBe(true);
      expect(result.stages.length).toBe(5);
    });

    it('should parse stages_json into stages array', () => {
      const result = pipelineService._getResult(pipelineId);
      const pullStage = result.stages.find(s => s.name === 'pull');
      expect(pullStage).toBeTruthy();
      expect(pullStage.status).toBe('success');
      expect(pullStage.label).toBe('Pull Image');
    });

    it('should return null for non-existent pipeline', () => {
      const result = pipelineService._getResult(99999);
      expect(result).toBeNull();
    });
  });

  // ── getStatus ──────────────────────────────────────────────
  describe('getStatus()', () => {
    it('should delegate to _getResult', () => {
      const result = pipelineService.getStatus(pipelineId);
      expect(result).toBeTruthy();
      expect(result.container_name).toBe('my-app');
      expect(Array.isArray(result.stages)).toBe(true);
    });

    it('should return null for non-existent pipeline', () => {
      const result = pipelineService.getStatus(99999);
      expect(result).toBeNull();
    });
  });

  // ── getHistory ─────────────────────────────────────────────
  describe('getHistory()', () => {
    it('should return history for a container', () => {
      const history = pipelineService.getHistory('my-app', 0);
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].container_name).toBe('my-app');
      expect(Array.isArray(history[0].stages)).toBe(true);
    });

    it('should return empty array for unknown container', () => {
      const history = pipelineService.getHistory('non-existent', 0);
      expect(history).toEqual([]);
    });

    it('should respect limit parameter', () => {
      // Insert multiple pipelines
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('abc123', 'my-app', 0, 'success', '[]', 'admin');
      }

      const history = pipelineService.getHistory('my-app', 0, 3);
      expect(history.length).toBe(3);
    });

    it('should order by started_at DESC (newest first)', () => {
      const history = pipelineService.getHistory('my-app', 0);
      for (let i = 1; i < history.length; i++) {
        expect(history[i - 1].started_at >= history[i].started_at).toBe(true);
      }
    });

    it('should filter by host_id', () => {
      // Insert a pipeline for a different host
      db.prepare(`
        INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('xyz789', 'my-app', 5, 'success', '[]', 'admin');

      const host0 = pipelineService.getHistory('my-app', 0);
      const host5 = pipelineService.getHistory('my-app', 5);
      // host5 should only have the one we just inserted
      expect(host5.length).toBe(1);
      // host0 should not include the host5 pipeline
      const hasHost5 = host0.some(p => p.host_id === 5);
      expect(hasHost5).toBe(false);
    });
  });

  // ── Stage transitions ─────────────────────────────────────
  describe('Stage transitions', () => {
    it('should handle pipeline with failed stage', () => {
      const failedStages = [
        { name: 'pull', label: 'Pull Image', status: 'success' },
        { name: 'scan', label: 'Security Scan', status: 'failed', detail: '3 critical vulnerabilities' },
      ];
      const result = db.prepare(`
        INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('fail123', 'broken-app', 0, 'failed', JSON.stringify(failedStages), 'admin', 'Scan found critical vulnerabilities');
      const failedId = Number(result.lastInsertRowid);

      const pipeline = pipelineService.getStatus(failedId);
      expect(pipeline.status).toBe('failed');
      expect(pipeline.error).toContain('critical vulnerabilities');
      const scanStage = pipeline.stages.find(s => s.name === 'scan');
      expect(scanStage.status).toBe('failed');
      expect(scanStage.detail).toContain('critical');
    });

    it('should handle pipeline with running status', () => {
      const runningStages = [
        { name: 'pull', label: 'Pull Image', status: 'success' },
        { name: 'scan', label: 'Security Scan', status: 'running' },
      ];
      const result = db.prepare(`
        INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('run123', 'running-app', 0, 'running', JSON.stringify(runningStages), 'admin');
      const runningId = Number(result.lastInsertRowid);

      const pipeline = pipelineService.getStatus(runningId);
      expect(pipeline.status).toBe('running');
      const scanStage = pipeline.stages.find(s => s.name === 'scan');
      expect(scanStage.status).toBe('running');
    });

    it('should handle malformed stages_json gracefully', () => {
      const result = db.prepare(`
        INSERT INTO deployment_pipelines (container_id, container_name, host_id, status, stages_json, started_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('bad123', 'bad-json-app', 0, 'failed', '{not valid json', 'admin');
      const badId = Number(result.lastInsertRowid);

      const pipeline = pipelineService._getResult(badId);
      expect(pipeline).toBeTruthy();
      expect(pipeline.stages).toEqual([]);
    });
  });
});
