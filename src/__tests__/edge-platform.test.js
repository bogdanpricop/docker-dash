'use strict';

process.env.APP_SECRET = 'edge-platform-test-signing-secret-32-chars';
process.env.ENCRYPTION_KEY = 'edge-platform-test-encryption-key';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration131 = require('../db/migrations/131_automation_operations_lifecycle_updates');
const migration139 = require('../db/migrations/139_edge_disconnected_foundation');
const migration140 = require('../db/migrations/140_edge_sovereignty_resilience');
const migration141 = require('../db/migrations/141_edge_continuity_experience');
const { EdgePlatformService } = require('../services/edge-platform');
const { InfrastructureOperationsService } = require('../services/infrastructure-operations');

const admin = { id: 1, username: 'edge-admin', role: 'admin' };
const future = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const past = milliseconds => new Date(Date.now() - milliseconds).toISOString();
const digest = character => `sha256:${character.repeat(64)}`;

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users (id,username,role,is_active) VALUES (1,'edge-admin','admin',1),(2,'edge-approver','admin',1);
    INSERT INTO docker_hosts (id,name,daemon_type,daemon_config,is_active) VALUES
      (7,'edge-k8s','kubernetes','{}',1),(8,'edge-docker','docker','{}',1);
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration131.up(db); migration139.up(db); migration140.up(db); migration141.up(db); return db;
}
function siteInput(overrides = {}) {
  return { slug: 'bucharest-edge', name: 'Bucharest edge', timezone: 'Europe/Bucharest', region: 'ro-bucharest',
    jurisdiction: 'EU/RO', localOwner: 'platform-team', trustRoots: ['signer/platform-release'],
    hosts: [{ hostId: 7, role: 'standalone' }], status: 'active', ...overrides };
}
function serviceAndSite() {
  const db = database(); const approvalService = new InfrastructureOperationsService(() => db);
  const service = new EdgePlatformService(() => db, { signingSecret: 'unit-test-edge-signing-secret-32', approvalService });
  const site = service.saveSite(siteInput(), admin); return { db, service, site };
}
function registerAgent(service, site, overrides = {}) {
  return service.registerAgent(site.id, { agentId: 'edge-a', certificateFingerprint: digest('a'),
    runbookAllowlist: ['collect_inventory','network_diagnostics'], updateRing: 'canary', state: 'active', ...overrides }, admin);
}

describe('V6.5a edge and disconnected foundation (B326-B335)', () => {
  test('migrations create forty-three tables, thirteen permissions and three update rings idempotently', () => {
    const db = database(); migration139.up(db); migration140.up(db); migration141.up(db);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type=? AND name LIKE 'edge_%'").get('table').count).toBe(43);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key LIKE 'edge_%'").get().count).toBe(13);
    expect(db.prepare('SELECT slug FROM edge_update_rings ORDER BY rollout_percent').all().map(row => row.slug)).toEqual(['held','canary','stable']);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_role_permissions WHERE role_id=1 AND permission_key LIKE 'edge_%'").get().count).toBe(13); db.close();
  });

  test('site model validates IANA timezone, owns each host once and distinguishes expected disconnect', () => {
    const { db, service, site } = serviceAndSite();
    expect(site).toMatchObject({ slug: 'bucharest-edge', timezone: 'Europe/Bucharest', region: 'ro-bucharest',
      localOwner: 'platform-team', hosts: [{ id: 7, role: 'standalone' }], health: 'unknown' });
    const policy = service.saveConnectivity(site.id, { mode: 'intermittent', maxStalenessSeconds: 30,
      cacheTtlSeconds: 60, mutationMode: 'queue', expectedOfflineUntil: future(3600000) }, admin);
    expect(policy).toMatchObject({ mode: 'intermittent', mutationMode: 'queue' });
    expect(service.overview(admin).sites[0]).toMatchObject({ health: 'expected_disconnected', expectedDisconnect: true });
    expect(() => service.saveSite(siteInput({ slug: 'bad-zone', timezone: 'Europe/Unknown', hosts: [] }), admin)).toThrow('timezone');
    expect(() => service.saveSite(siteInput({ slug: 'second-edge', name: 'Second', hosts: [{ hostId: 7, role: 'worker' }] }), admin))
      .toThrow(expect.objectContaining({ code: 'EDGE_HOST_ALREADY_ASSIGNED' })); db.close();
  });

  test('intermittent read cache is hash-idempotent, explicitly stale and rejects credential material', () => {
    const { db, service, site } = serviceAndSite(); service.saveConnectivity(site.id,
      { mode: 'intermittent', maxStalenessSeconds: 30, cacheTtlSeconds: 30, mutationMode: 'deny' }, admin);
    const input = { providerRef: 'cluster/edge-a', resourceKind: 'node', resourceRef: 'node/a', observedAt: past(120000), payload: { ready: true } };
    const first = service.recordCache(site.id, input, admin); const duplicate = service.recordCache(site.id, input, admin);
    expect(first).toMatchObject({ state: 'stale', duplicate: false }); expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(() => service.recordCache(site.id, { ...input, observedAt: past(110000), payload: { url: 'https://example.test/data?token=inline' } }, admin))
      .toThrow(expect.objectContaining({ code: 'EDGE_SECRET_MATERIAL' })); db.close();
  });

  test('offline queue creates signed expiring intents and requires complete reconnect revalidation without execution', () => {
    const { db, service, site } = serviceAndSite(); const input = { actionKey: 'service.restart', targetRef: 'service/local-api',
      payload: { serviceRef: 'local-api' }, prerequisites: ['site_reconnected','identity_unchanged'], expiresAt: future(86400000) };
    expect(() => service.createIntent(site.id, input, admin)).toThrow(expect.objectContaining({ code: 'EDGE_MUTATION_QUEUE_DISABLED' }));
    service.saveConnectivity(site.id, { mode: 'intermittent', maxStalenessSeconds: 300, cacheTtlSeconds: 86400, mutationMode: 'queue' }, admin);
    const first = service.createIntent(site.id, input, admin); const duplicate = service.createIntent(site.id, input, admin);
    expect(first).toMatchObject({ state: 'queued', duplicate: false, providerMutationsStarted: 0, signatureAlgorithm: 'hmac-sha256-v1' });
    expect(first.signature).toMatch(/^[a-f0-9]{64}$/); expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    const incomplete = service.revalidateIntent(first.id, { checks: [{ prerequisite: 'site_reconnected', outcome: 'pass', evidenceRef: 'heartbeat/1' }] }, admin);
    expect(incomplete).toMatchObject({ state: 'revalidation_required', revalidation: { ready: false, missing: ['identity_unchanged'] } });
    const ready = service.revalidateIntent(first.id, { checks: [
      { prerequisite: 'site_reconnected', outcome: 'pass', evidenceRef: 'heartbeat/2' },
      { prerequisite: 'identity_unchanged', outcome: 'pass', evidenceRef: 'inventory/2' }] }, admin);
    expect(ready).toMatchObject({ state: 'ready_for_agent', revalidation: { ready: true }, providerMutationsStarted: 0 });
    expect(() => service.createIntent(site.id, { ...input, expiresAt: future(85000000), password: 'inline' }, admin))
      .toThrow(expect.objectContaining({ code: 'EDGE_SECRET_MATERIAL' })); db.close();
  });

  test('heartbeat accepts active registered agents, rejects replay and avoids false outage in expected windows', () => {
    const { db, service, site } = serviceAndSite(); registerAgent(service, site);
    service.saveConnectivity(site.id, { mode: 'intermittent', maxStalenessSeconds: 30, cacheTtlSeconds: 86400,
      mutationMode: 'deny', expectedOfflineUntil: future(3600000) }, admin);
    const heartbeat = service.heartbeat(site.id, { agentId: 'edge-a', sequence: 7, status: 'healthy', version: '1.0.0',
      capabilities: ['inventory','events'], observedAt: past(120000) }, admin);
    expect(heartbeat).toMatchObject({ sequence: 7, transport: 'admin_ingest_or_external_mtls_gateway' });
    expect(service.overview(admin).sites[0]).toMatchObject({ health: 'expected_disconnected', heartbeat: { sequence: 7 } });
    expect(() => service.heartbeat(site.id, { agentId: 'edge-a', sequence: 7, status: 'healthy', capabilities: [], observedAt: new Date().toISOString() }, admin))
      .toThrow(expect.objectContaining({ code: 'EDGE_HEARTBEAT_REPLAY' })); db.close();
  });

  test('bandwidth-aware store-and-forward compresses, deduplicates, prioritizes and hash-binds acknowledgements', () => {
    const { db, service, site } = serviceAndSite(); registerAgent(service, site);
    service.saveSyncPolicy(site.id, { bandwidthKbps: 128, maxBatchBytes: 1048576,
      priorityOrder: ['inventory','event','metric','artifact'] }, admin);
    const body = { agentId: 'edge-a', events: [
      { eventId: 'metric-1', category: 'metric', occurredAt: past(1000), payload: { cpuPercent: 42, samples: Array(100).fill(42) } },
      { eventId: 'inventory-1', category: 'inventory', occurredAt: past(900), payload: { nodes: 3, state: 'ready' } }] };
    const first = service.bufferEvents(site.id, body, admin); const duplicate = service.bufferEvents(site.id, body, admin);
    expect(first).toMatchObject({ acceptedCount: 2, duplicateCount: 0, compression: 'deflate-raw', providerMutationsStarted: 0 });
    expect(first.accepted[0].compressedBytes).toBeLessThan(first.accepted[0].rawBytes);
    expect(duplicate).toMatchObject({ acceptedCount: 0, duplicateCount: 2 });
    const plan = service.createSyncPlan(site.id, {}, admin);
    expect(plan.eventIds).toEqual([first.accepted[1].cursor, first.accepted[0].cursor]);
    expect(plan).toMatchObject({ priorityOrder: ['inventory','event','metric','artifact'], state: 'planned', providerMutationsStarted: 0 });
    expect(() => service.acknowledgeSyncPlan(plan.id, { planHash: 'wrong' }, admin)).toThrow(expect.objectContaining({ code: 'EDGE_SYNC_ACK_MISMATCH' }));
    const acknowledged = service.acknowledgeSyncPlan(plan.id, { planHash: plan.planHash }, admin);
    expect(acknowledged).toMatchObject({ state: 'acknowledged', duplicate: false });
    expect(db.prepare('SELECT COUNT(*) count FROM edge_event_buffer WHERE delivered_at IS NOT NULL').get().count).toBe(2); db.close();
  });

  test('local agent runbook envelopes are signed, expiring and strictly allowlisted', () => {
    const { db, service, site } = serviceAndSite(); const agent = registerAgent(service, site);
    const input = { runbookKey: 'collect_inventory', targetRef: 'site/bucharest-edge', parameters: { scope: 'all' }, expiresAt: future(3600000) };
    const first = service.createRunbookEnvelope(agent.id, input, admin); const duplicate = service.createRunbookEnvelope(agent.id, input, admin);
    expect(first).toMatchObject({ state: 'issued', duplicate: false, providerMutationsStarted: 0 });
    expect(first.signature).toMatch(/^[a-f0-9]{64}$/); expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(() => service.createRunbookEnvelope(agent.id, { ...input, runbookKey: 'rotate_logs' }, admin))
      .toThrow(expect.objectContaining({ code: 'EDGE_RUNBOOK_NOT_ALLOWED' }));
    expect(() => service.createRunbookEnvelope(agent.id, { ...input, expiresAt: future(3500000), parameters: { privateKey: 'inline' } }, admin))
      .toThrow(expect.objectContaining({ code: 'EDGE_SECRET_MATERIAL' })); db.close();
  });

  test('agent update rings retain verified offline bundle and rollback evidence but expose no apply', () => {
    const { db, service, site } = serviceAndSite(); const held = registerAgent(service, site, { agentId: 'held-agent', updateRing: 'held' });
    const input = { targetVersion: '1.1.0', bundle: { digest: digest('a'), localRef: 'mirror/agent-1.1.0',
      signatureIdentity: 'signer/platform-release', signatureVerified: true }, rollback: { version: '1.0.0', digest: digest('b'), localRef: 'mirror/agent-1.0.0' } };
    expect(service.planAgentUpdate(held.id, input, admin)).toMatchObject({ state: 'blocked', ring: 'held', applySupported: false, providerMutationsStarted: 0 });
    const canary = registerAgent(service, site, { agentId: 'canary-agent', updateRing: 'canary' });
    const planned = service.planAgentUpdate(canary.id, input, admin);
    expect(planned).toMatchObject({ state: 'planned', ring: 'canary', applySupported: false,
      evidence: { ringAllowsRollout: true, signatureVerified: true, trustedSigner: true, rollbackAvailable: true, agentActive: true } }); db.close();
  });

  test('air-gap bootstrap manifests are locally signed, private-key free and blocked on untrusted artifacts', () => {
    const { db, service, site } = serviceAndSite(); const artifact = { kind: 'certificate', name: 'site-ca', version: '1.0.0',
      digest: digest('a'), localRef: 'bundle/certs/site-ca.pem', byteSize: 2048,
      signatureIdentity: 'signer/platform-release', signatureVerified: true };
    const ready = service.createBootstrapManifest(site.id, { name: 'bootstrap', version: '1.0.0', artifacts: [artifact], expiresAt: future(7 * 86400000) }, admin);
    const blocked = service.createBootstrapManifest(site.id, { name: 'bootstrap-untrusted', version: '1.0.0',
      artifacts: [{ ...artifact, digest: digest('b'), signatureIdentity: 'signer/unknown' }], expiresAt: future(7 * 86400000) }, admin);
    expect(ready).toMatchObject({ state: 'ready', containsPrivateKeys: false, exportSupported: true, providerMutationsStarted: 0 });
    expect(ready.signature).toMatch(/^[a-f0-9]{64}$/); expect(blocked).toMatchObject({ state: 'blocked' });
    expect(() => service.createBootstrapManifest(site.id, { name: 'secret', version: '1.0.0', artifacts: [artifact],
      expiresAt: future(7 * 86400000), privateKey: 'inline' }, admin)).toThrow(expect.objectContaining({ code: 'EDGE_SECRET_MATERIAL' })); db.close();
  });

  test('offline content manifests cover OCI/ISO/template/package/docs with external trust and no implicit sync', () => {
    const { db, service, site } = serviceAndSite(); const input = { name: 'site-content', sourceMirrorRef: 'airgap/site-a', items: [
      { kind: 'oci', name: 'docker-dash', version: '8.65.0', digest: digest('a'), localRef: 'oci/docker-dash/8.65.0',
        byteSize: 524288000, signatureIdentity: 'signer/platform-release', signatureVerified: true },
      { kind: 'package', name: 'edge-agent', version: '1.0.0', digest: digest('b'), localRef: 'packages/edge-agent',
        byteSize: 10485760, signatureIdentity: 'signer/platform-release', signatureVerified: true }] };
    const first = service.saveMirrorManifest(site.id, input, admin); const duplicate = service.saveMirrorManifest(site.id, input, admin);
    expect(first).toMatchObject({ state: 'ready', totalBytes: 534773760, syncSupported: false, providerMutationsStarted: 0, duplicate: false });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(() => service.saveMirrorManifest(site.id, { ...input, apiToken: 'inline' }, admin)).toThrow(expect.objectContaining({ code: 'EDGE_SECRET_MATERIAL' })); db.close();
  });

  test('overview reports explicit execution boundaries and aggregate edge posture', () => {
    const { db, service, site } = serviceAndSite(); registerAgent(service, site);
    const overview = service.overview(admin);
    expect(overview.summary).toMatchObject({ sites: 1, activeAgents: 1, pendingEvents: 0 });
    expect(overview.updateRings).toHaveLength(3);
    expect(overview.capabilities).toMatchObject({ centralIntentExecution: false, centralRunbookExecution: false,
      updateApplySupported: false, mirrorSyncSupported: false, heartbeatTransport: 'admin_ingest_or_external_mtls_gateway' }); db.close();
  });

  test('server, API client and admin navigation expose the edge surface without inline handlers', () => {
    const root = path.join(__dirname, '../..');
    const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'public/js/pages/edge-platform.js'), 'utf8');
    expect(server).toContain("app.use('/api/edge'"); expect(api).toContain('getEdgeOverview()');
    expect(app).toContain("'edge-platform': () => EdgePlatformPage"); expect(index).toContain('href="#/edge-platform"');
    expect(index).toContain('/js/pages/edge-platform.js?v=__VERSION__'); expect(page).not.toMatch(/\son(?:click|change|submit)=/i);
  });
});
