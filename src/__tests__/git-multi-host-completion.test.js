'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-git-multi-'));
process.env.APP_SECRET = 'git-multi-host-test-secret';
process.env.ENCRYPTION_KEY = 'git-multi-host-test-key-32-chars';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const gitService = require('../services/git');
const gitTargets = require('../services/git-multi-host');
const dockerService = require('../services/docker');
const gitDrift = require('../services/git-drift');
const Database = require('better-sqlite3');

const HOST_A = 6101;
const HOST_B = 6102;
const HOST_C = 6103;
const HOST_D = 6104;
let userId;
let stackSequence = 0;

function insertStack(status = 'running') {
  const db = getDb();
  stackSequence += 1;
  const result = db.prepare(`
    INSERT INTO git_stacks
      (stack_name, host_id, repo_url, branch, compose_path, status, created_by)
    VALUES (?, ?, 'https://example.test/repo.git', 'main', 'docker-compose.yml', ?, ?)
  `).run(`multi-stack-${stackSequence}`, HOST_A, status, userId);
  const id = Number(result.lastInsertRowid);
  gitTargets.setTargets(id, [HOST_A, HOST_B]);
  return id;
}

beforeAll(() => {
  const db = getDb();
  userId = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('git-multi-admin', 'hash', 'admin')"
  ).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO docker_hosts
      (id, name, connection_type, host, port, is_active, daemon_type, environment)
    VALUES (?, ?, 'tcp', '127.0.0.1', ?, 1, 'docker', 'test')
  `).run(HOST_A, 'Target A', 26101);
  db.prepare(`
    INSERT INTO docker_hosts
      (id, name, connection_type, host, port, is_active, daemon_type, environment)
    VALUES (?, ?, 'tcp', '127.0.0.1', ?, 1, 'podman', 'test')
  `).run(HOST_B, 'Target B', 26102);
  db.prepare(`
    INSERT INTO docker_hosts
      (id, name, connection_type, host, port, is_active, daemon_type, environment)
    VALUES (?, ?, 'tcp', '127.0.0.1', ?, 1, 'docker', 'test')
  `).run(HOST_C, 'Target C', 26103);
  db.prepare(`
    INSERT INTO docker_hosts
      (id, name, connection_type, host, port, is_active, daemon_type, environment)
    VALUES (?, ?, 'tcp', '127.0.0.1', ?, 1, 'docker', 'test')
  `).run(HOST_D, 'Target D', 26104);
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('git target persistence', () => {
  it('backfills the legacy local host alias without violating target foreign keys', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.pragma('foreign_keys = ON');
    require('../db/migrations/001_initial').up(legacyDb);
    require('../db/migrations/006_multihost').up(legacyDb);
    require('../db/migrations/014_git_credentials').up(legacyDb);
    require('../db/migrations/015_git_stacks').up(legacyDb);
    const legacyUser = Number(legacyDb.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES ('legacy', 'hash', 'admin')"
    ).run().lastInsertRowid);
    const legacyStack = Number(legacyDb.prepare(`
      INSERT INTO git_stacks (stack_name, host_id, repo_url, created_by)
      VALUES ('legacy-local', 0, 'https://example.test/legacy.git', ?)
    `).run(legacyUser).lastInsertRowid);

    expect(() => require('../db/migrations/074_git_stack_targets').up(legacyDb)).not.toThrow();
    expect(legacyDb.prepare('SELECT host_id FROM git_stack_targets WHERE stack_id = ?').get(legacyStack).host_id)
      .toBe(1);
    legacyDb.close();
  });

  it('creates a stack with multiple targets and exposes them in detail', () => {
    jest.spyOn(gitService, '_cloneAndDeploy').mockResolvedValue();
    stackSequence += 1;
    const created = gitService.createStack({
      stack_name: `created-multi-${stackSequence}`,
      repo_url: 'https://example.test/repo.git',
      branch: 'main', compose_path: 'docker-compose.yml',
      target_host_ids: [HOST_A, HOST_B], created_by: userId,
    });

    expect(gitService._cloneAndDeploy).toHaveBeenCalledWith(created.id);
    expect(gitService.getStack(created.id).target_host_ids).toEqual([HOST_A, HOST_B]);
  });

  it('normalizes aliases, removes duplicates, and rejects incompatible hosts', () => {
    expect(gitTargets.normalizeTargetHostIds([HOST_A, HOST_A, HOST_B])).toEqual([HOST_A, HOST_B]);
    expect(gitTargets.normalizeTargetHostIds([0])).toEqual([1]);

    const result = getDb().prepare(`
      INSERT INTO docker_hosts (name, connection_type, is_active, daemon_type)
      VALUES ('Inactive', 'socket', 0, 'docker')
    `).run();
    expect(() => gitTargets.normalizeTargetHostIds([Number(result.lastInsertRowid)]))
      .toThrow('is not active');
  });

  it('preserves unchanged target state while replacing the target set', () => {
    const stackId = insertStack();
    gitTargets.updateTargetStatus(stackId, HOST_A, {
      commit: 'abc1234', status: 'success', error: null,
    });

    gitTargets.setTargets(stackId, [HOST_A]);
    const targets = gitTargets.listTargets(stackId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ host_id: HOST_A, last_deployed_commit: 'abc1234', last_deploy_status: 'success' });
    expect(getDb().prepare('SELECT host_id FROM git_stacks WHERE id = ?').get(stackId).host_id).toBe(HOST_A);
  });

  it('exposes and filters stacks through the target join table', () => {
    const stackId = insertStack();
    const detail = gitService.getStack(stackId);
    expect(detail.target_host_ids).toEqual([HOST_A, HOST_B]);
    expect(gitService.listStacks(HOST_B).map(stack => stack.id)).toContain(stackId);
  });

  it('supports target-only updates and blocks them during deploy', () => {
    const stackId = insertStack();
    gitService.updateStack(stackId, { target_host_ids: [HOST_B] });
    expect(gitService.getStack(stackId).target_host_ids).toEqual([HOST_B]);

    getDb().prepare("UPDATE git_stacks SET status = 'deploying' WHERE id = ?").run(stackId);
    expect(() => gitService.updateStack(stackId, { target_host_ids: [HOST_A] }))
      .toThrow('cannot be changed');
  });
});

describe('sequential compose fan-out', () => {
  it('records one parent deployment before queuing a manual fan-out', async () => {
    const stackId = insertStack();
    jest.spyOn(gitService, '_pullAndDeploy').mockResolvedValue();
    const deploymentId = await gitService.deployStack(stackId, {
      force: true, actor: { userId, username: 'git-multi-admin' },
    });

    expect(deploymentId).toEqual(expect.any(Number));
    expect(gitService._pullAndDeploy).toHaveBeenCalledWith(stackId, expect.objectContaining({
      force: true, deploymentId, triggerType: 'manual',
    }));
    expect(getDb().prepare('SELECT status FROM git_deployments WHERE id = ?').get(deploymentId).status)
      .toBe('deploying');
  });

  it('deploys every target in order and stores independent success state', async () => {
    const stackId = insertStack();
    const order = [];
    jest.spyOn(gitService, '_composeUp').mockImplementation(async (_id, _stack, hostId) => {
      order.push(hostId);
    });

    const results = await gitService._deployComposeToTargets(stackId, gitService.getStack(stackId), {
      commit: 'feed123', triggerType: 'manual', actor: { userId, username: 'git-multi-admin' },
    });

    expect(order).toEqual([HOST_A, HOST_B]);
    expect(results.map(result => result.status)).toEqual(['success', 'success']);
    expect(gitTargets.listTargets(stackId).map(target => target.last_deploy_status))
      .toEqual(['success', 'success']);
  });

  it('continues after one target fails and persists the partial result', async () => {
    const stackId = insertStack();
    const order = [];
    jest.spyOn(gitService, '_composeUp').mockImplementation(async (_id, _stack, hostId) => {
      order.push(hostId);
      if (hostId === HOST_A) throw new Error('daemon unavailable');
    });

    await expect(gitService._deployComposeToTargets(stackId, gitService.getStack(stackId), {
      commit: 'bad1234', triggerType: 'polling',
    })).rejects.toMatchObject({
      message: 'Deployment failed on 1 of 2 target hosts',
      targetResults: [
        expect.objectContaining({ hostId: HOST_A, status: 'failed' }),
        expect.objectContaining({ hostId: HOST_B, status: 'success' }),
      ],
    });
    expect(order).toEqual([HOST_A, HOST_B]);
    const targetStates = gitTargets.listTargets(stackId);
    expect(targetStates.map(target => target.last_deploy_status)).toEqual(['failed', 'success']);
    expect(targetStates[0].last_deployed_commit).toBeNull();
    expect(targetStates[1].last_deployed_commit).toBe('bad1234');
  });

  it('builds isolated Docker CLI environments for TCP and TLS targets', () => {
    jest.spyOn(dockerService, '_getHostConfig').mockReturnValueOnce({
      id: HOST_A, name: 'Plain TCP', connectionType: 'tcp', host: '10.0.0.5', port: 2375,
    });
    const plain = gitService._dockerCliEnvForHost(HOST_A);
    expect(plain.env.DOCKER_HOST).toBe('tcp://10.0.0.5:2375');
    expect(plain.env.DOCKER_TLS_VERIFY).toBeUndefined();
    plain.cleanup();

    dockerService._getHostConfig.mockReturnValueOnce({
      id: HOST_B, name: 'TLS TCP', connectionType: 'tcp', host: '10.0.0.6', port: 2376,
      tlsConfig: { ca: 'ca', cert: 'cert', key: 'key' },
    });
    const tls = gitService._dockerCliEnvForHost(HOST_B);
    expect(tls.env.DOCKER_TLS_VERIFY).toBe('1');
    expect(fs.readFileSync(path.join(tls.env.DOCKER_CERT_PATH, 'key.pem'), 'utf8')).toBe('key');
    const certPath = tls.env.DOCKER_CERT_PATH;
    tls.cleanup();
    expect(fs.existsSync(certPath)).toBe(false);
  });
});

describe('progressive rollout policy', () => {
  it('validates and persists an opt-in rollout policy', () => {
    const stackId = insertStack();
    gitService.updateStack(stackId, {
      rollout_policy: {
        enabled: true, strategy: 'exponential', initialWave: 1, multiplier: 2,
        maxParallel: 4, delaySeconds: 3, healthTimeoutSeconds: 45,
        healthGate: true, onFailure: 'rollback',
      },
    });
    expect(gitService.getStack(stackId).rollout_policy).toMatchObject({
      enabled: true, strategy: 'exponential', maxParallel: 4,
      healthTimeoutSeconds: 45, onFailure: 'rollback',
    });
    expect(() => gitService.updateStack(stackId, {
      rollout_policy: { enabled: true, strategy: 'all-at-once' },
    })).toThrow('fixed or exponential');
  });

  it('runs fixed waves concurrently while respecting maxParallel', async () => {
    const stackId = insertStack();
    gitTargets.setTargets(stackId, [HOST_A, HOST_B, HOST_C, HOST_D]);
    let active = 0;
    let maxActive = 0;
    jest.spyOn(gitService, '_composeUp').mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
    });
    jest.spyOn(gitService, '_waitForTargetHealth').mockResolvedValue({ status: 'healthy', containers: 1 });

    const results = await gitService._deployComposeToTargets(stackId, gitService.getStack(stackId), {
      commit: 'wave123', rolloutPolicy: {
        enabled: true, strategy: 'fixed', initialWave: 2, maxParallel: 2,
        multiplier: 2, delaySeconds: 0, healthTimeoutSeconds: 5,
        healthGate: true, onFailure: 'pause',
      },
    });

    expect(maxActive).toBe(2);
    expect(results.map(result => result.wave)).toEqual([1, 1, 2, 2]);
    expect(results.every(result => result.status === 'success')).toBe(true);
  });

  it('pauses after a failed health gate and leaves later targets untouched', async () => {
    const stackId = insertStack();
    jest.spyOn(gitService, '_composeUp').mockResolvedValue();
    jest.spyOn(gitService, '_waitForTargetHealth').mockRejectedValue(new Error('web is unhealthy'));

    await expect(gitService._deployComposeToTargets(stackId, gitService.getStack(stackId), {
      commit: 'badwave', rolloutPolicy: {
        enabled: true, strategy: 'fixed', initialWave: 1, maxParallel: 1,
        multiplier: 2, delaySeconds: 0, healthTimeoutSeconds: 5,
        healthGate: true, onFailure: 'pause',
      },
    })).rejects.toMatchObject({
      rolloutPaused: true,
      targetResults: [
        expect.objectContaining({ hostId: HOST_A, status: 'failed' }),
        expect.objectContaining({ hostId: HOST_B, status: 'untouched' }),
      ],
    });
    expect(gitService._composeUp).toHaveBeenCalledTimes(1);
  });

  it('invokes target-scoped rollback after a failed wave', async () => {
    const stackId = insertStack();
    jest.spyOn(gitService, '_composeUp').mockResolvedValue();
    jest.spyOn(gitService, '_waitForTargetHealth')
      .mockResolvedValueOnce({ status: 'healthy', containers: 1 })
      .mockRejectedValueOnce(new Error('worker unhealthy'));
    const rollback = jest.spyOn(gitService, '_rollbackRolloutTargets')
      .mockImplementation(async (_id, _stack, _commit, results) => {
        for (const result of results.filter(item => item.changed)) result.status = 'rolled_back';
        return results;
      });

    await expect(gitService._deployComposeToTargets(stackId, gitService.getStack(stackId), {
      commit: 'rollback1', rolloutPolicy: {
        enabled: true, strategy: 'fixed', initialWave: 1, maxParallel: 1,
        multiplier: 2, delaySeconds: 0, healthTimeoutSeconds: 5,
        healthGate: true, onFailure: 'rollback',
      },
    })).rejects.toMatchObject({
      targetResults: expect.arrayContaining([
        expect.objectContaining({ hostId: HOST_A, status: 'rolled_back' }),
        expect.objectContaining({ hostId: HOST_B, status: 'rolled_back' }),
      ]),
    });
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});

describe('multi-target drift', () => {
  it('annotates drift with the target host and reports scan failures separately', async () => {
    const stackId = 99001;
    const repoDir = path.join(testDataDir, 'repos', String(stackId));
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:1.25\n');
    const docker = {
      listContainers: jest.fn(async (hostId) => {
        if (hostId === HOST_B) throw new Error('host offline');
        return [{
          stack: 'drift-stack', name: 'web-1', image: 'nginx:1.24', state: 'running',
          labels: { 'com.docker.compose.service': 'web' },
        }];
      }),
    };
    const result = await gitDrift.scanStackTargets({
      id: stackId, stack_name: 'drift-stack', compose_path: 'docker-compose.yml',
      targets: [
        { host_id: HOST_A, host_name: 'Target A' },
        { host_id: HOST_B, host_name: 'Target B' },
      ],
    }, docker);

    expect(result.inSync).toBe(false);
    expect(result.drifts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_mismatch', hostId: HOST_A, hostName: 'Target A' }),
      expect.objectContaining({ type: 'scan_error', hostId: HOST_B, hostName: 'Target B', error: 'host offline' }),
    ]));
  });
});
