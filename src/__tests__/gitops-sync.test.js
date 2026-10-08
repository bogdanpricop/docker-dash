'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-gitops-'));
process.env.APP_SECRET = 'gitops-test-secret';
process.env.ENCRYPTION_KEY = 'gitops-test-key-32-characters';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const sync = require('../services/gitops-sync');
const git = require('../services/git');
const procedures = require('../services/procedures');

let adminId;

beforeAll(() => {
  adminId = Number(getDb().prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('gitops-admin', 'hash', 'admin')"
  ).run().lastInsertRowid);
});

afterAll(() => {
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('declarative fleet GitOps', () => {
  it('exports symbolic references without credential, channel, host, or webhook secrets', () => {
    const db = getDb();
    const credentialId = Number(db.prepare(`
      INSERT INTO git_credentials (name, auth_type, password_encrypted, created_by)
      VALUES ('gitops-credential', 'token', 'enc:credential-supersecret', ?)
    `).run(adminId).lastInsertRowid);
    db.prepare(`
      INSERT INTO notification_channels (name, provider, config_encrypted, created_by)
      VALUES ('gitops-alerts', 'webhook', 'enc:channel-supersecret', ?)
    `).run(adminId);
    const hostId = Number(db.prepare(`
      INSERT INTO docker_hosts
        (name, connection_type, host, port, tls_config, is_active, environment, daemon_type)
      VALUES ('GitOps TLS Host', 'tcp', '10.10.10.10', 2376, '{"ca":"host-supersecret"}', 1, 'production', 'docker')
    `).run().lastInsertRowid);
    git.createStack({
      stack_name: 'gitops-secret-stack', repo_url: 'https://example.test/secret.git',
      credential_id: credentialId, target_host_ids: [hostId], created_by: adminId,
      deploy_immediately: false,
    });
    procedures.create({
      name: 'gitops-webhook-procedure', created_by: adminId,
      steps: [{
        id: 'secret-hook', stage: 1, action_type: 'webhook', on_error: 'stop',
        action_config: { url: 'https://hooks.example.test/hook-token-supersecret', payload: { token: 'payload-supersecret' } },
      }],
    });

    const document = sync.capture();
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('credential-supersecret');
    expect(serialized).not.toContain('channel-supersecret');
    expect(serialized).not.toContain('host-supersecret');
    expect(serialized).not.toContain('hook-token-supersecret');
    expect(serialized).not.toContain('payload-supersecret');
    expect(document.spec.gitStacks.find(item => item.name === 'gitops-secret-stack').credentialRef)
      .toBe('gitops-credential');
    expect(document.spec.hosts.find(item => item.name === 'GitOps TLS Host').secretRef)
      .toBe('existing-host/GitOps TLS Host');
    expect(document.spec.procedures.find(item => item.name === 'gitops-webhook-procedure').steps[0].actionConfig.secretRef)
      .toBe('existing-procedure/gitops-webhook-procedure/secret-hook');
  });

  it('plans and applies hosts, groups, pending Git stacks, and staged procedures', async () => {
    const document = sync.capture();
    document.spec.hosts.push({
      name: 'GitOps Public Host', daemonType: 'docker', connectionType: 'tcp',
      address: '192.0.2.50', port: 2375, environment: 'staging', active: true, default: false,
    });
    document.spec.hostGroups.push({
      name: 'gitops-created-group', description: 'managed', members: ['GitOps Public Host'],
    });
    document.spec.gitStacks.push({
      name: 'gitops-pending-stack', repository: 'https://example.test/pending.git',
      branch: 'main', composePath: 'compose.yml', targets: ['GitOps Public Host'],
    });
    document.spec.procedures.push({
      name: 'gitops-parallel-procedure', maxParallel: 2,
      steps: [
        { id: 'wait-a', stage: 1, action: 'wait_seconds', actionConfig: { seconds: 0 } },
        { id: 'wait-b', stage: 1, action: 'wait_seconds', actionConfig: { seconds: 0 } },
      ],
    });

    const plan = sync.plan(document);
    expect(plan.blocked).toEqual([]);
    expect(plan.summary.create).toBe(4);
    const result = await sync.apply(document, { planHash: plan.planHash, userId: adminId });
    expect(result.ok).toBe(true);
    expect(getDb().prepare("SELECT id FROM docker_hosts WHERE name = 'GitOps Public Host'").get()).toBeTruthy();
    expect(getDb().prepare("SELECT id FROM host_groups WHERE name = 'gitops-created-group'").get()).toBeTruthy();
    expect(getDb().prepare("SELECT status FROM git_stacks WHERE stack_name = 'gitops-pending-stack'").get().status)
      .toBe('pending');
    expect(procedures.list().find(item => item.name === 'gitops-parallel-procedure')).toMatchObject({ max_parallel: 2 });

    await expect(sync.apply(document, { planHash: plan.planHash, userId: adminId }))
      .rejects.toMatchObject({ code: 'STALE_PLAN' });
  });

  it('rejects a stale reviewed plan when live state changes', async () => {
    const document = sync.capture();
    document.spec.hostGroups.push({ name: 'gitops-stale-group', members: [] });
    const plan = sync.plan(document);
    getDb().prepare("UPDATE docker_hosts SET environment = 'custom' WHERE name = 'Local'").run();
    await expect(sync.apply(document, { planHash: plan.planHash, userId: adminId }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_PLAN' });
    getDb().prepare("UPDATE docker_hosts SET environment = 'development' WHERE name = 'Local'").run();
  });

  it('requires authoritative mode and explicit runtime approval for deletes', async () => {
    const document = sync.capture();
    document.metadata.authoritative = true;
    document.spec.hostGroups = document.spec.hostGroups
      .filter(group => group.name !== 'gitops-created-group');
    const plan = sync.plan(document);
    expect(plan.summary.delete).toBe(1);
    await expect(sync.apply(document, { planHash: plan.planHash, userId: adminId }))
      .rejects.toMatchObject({ code: 'DELETE_APPROVAL_REQUIRED' });
    const applied = await sync.apply(document, {
      planHash: plan.planHash, allowDelete: true, userId: adminId,
    });
    expect(applied.summary.delete).toBe(1);
    expect(getDb().prepare("SELECT id FROM host_groups WHERE name = 'gitops-created-group'").get())
      .toBeUndefined();
  });

  it('blocks unresolved names and secret-backed creates before mutation', () => {
    const document = sync.capture();
    document.spec.gitStacks.push({
      name: 'gitops-broken-stack', repository: 'https://example.test/broken.git',
      targets: ['missing-host'], credentialRef: 'missing-credential',
    });
    document.spec.hosts.push({
      name: 'GitOps SSH Host', daemonType: 'docker', connectionType: 'ssh',
      secretRef: 'vault/ssh/production', active: true,
    });
    const plan = sync.plan(document);
    expect(plan.blocked.some(item => item.resource === 'gitStack' && item.operation === 'resolve')).toBe(true);
    expect(plan.blocked.some(item => item.resource === 'host' && item.operation === 'create')).toBe(true);
  });
});
