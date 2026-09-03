'use strict';

const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration147 = require('../db/migrations/147_connector_marketplace_integrations');
const { ConnectorMarketplaceService, canonicalPayload } = require('../services/connector-marketplace');

const admin = { id: 1, username: 'admin', role: 'admin' };
function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT,password_hash TEXT,role TEXT,is_active INTEGER DEFAULT 1,display_name TEXT,auth_source TEXT DEFAULT 'local',must_change_password INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,kind TEXT DEFAULT 'internal',usage_mode TEXT DEFAULT 'production',status TEXT DEFAULT 'active',is_default INTEGER DEFAULT 0,trial_expires_at TEXT,created_by TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER,tenant_id INTEGER,role TEXT,is_owner INTEGER,created_at TEXT,PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY,name TEXT UNIQUE,description TEXT,created_by INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE team_members (team_id INTEGER,user_id INTEGER,is_leader INTEGER,added_by INTEGER,added_at TEXT,PRIMARY KEY(team_id,user_id));
    INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'admin','admin@test','x','admin');
    INSERT INTO tenants (id,slug,name) VALUES (1,'platform','Platform');
  `); migration124.up(db); migration147.up(db); return db;
}
function signedMarketplace(overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion: '1.0', connectorKey: 'enterprise-connectors', name: 'Enterprise connector pack', version: '1.0.0', publisher: 'Docker Dash', supportLevel: 'official',
    domains: ['cmdb','itsm','siem','secrets','ipam_dns','backup','monitoring','event_bus','openapi'],
    products: ['netbox','servicenow','glpi','splunk','elastic','sentinel','syslog','vault','key_vault','secrets_manager','onepassword','infoblox','powerdns','route53','veeam','commvault','rubrik','hycu','prometheus','grafana','datadog','zabbix','prtg','kafka','nats','amqp','sns','sqs','generic_openapi'],
    allowedHosts: ['api.example.test','monitor.example.test'], docsUrl: 'https://docs.example.test/connectors', ...overrides,
  };
  return { manifest, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), signatureBase64: crypto.sign(null, canonicalPayload(manifest), privateKey).toString('base64') };
}

describe('v8.73 signed connector marketplace (B406-B415)', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new ConnectorMarketplaceService(() => db); service.register(signedMarketplace(), admin); });
  afterEach(() => db.close());

  test('B406 verifies signed curated marketplace metadata and support level', () => {
    expect(service.overview(admin)).toMatchObject({ entries: [expect.objectContaining({ connectorKey: 'enterprise-connectors', supportLevel: 'official', signatureState: 'verified', domains: expect.arrayContaining(['cmdb','openapi']) })], contract: { signedMetadata: 'Ed25519' } });
    const invalid = signedMarketplace({ connectorKey: 'invalid-pack' }); invalid.signatureBase64 = Buffer.alloc(64).toString('base64');
    expect(() => service.register(invalid, admin)).toThrow(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
  });
  test('B407 creates hash-bound CMDB sync with per-field ownership rules', () => {
    const plan = service.planCmdbSync('enterprise-connectors', { product: 'netbox', direction: 'bidirectional', resourceType: 'vm', resourceRef: 'vm-42', ownershipRules: { owner: 'cmdb', powerState: 'docker-dash' }, changes: [{ field: 'owner', operation: 'set', owner: 'cmdb', valueHash: 'a'.repeat(64) }], conflicts: [] }, admin);
    expect(plan).toMatchObject({ product: 'netbox', state: 'ready', externalMutationsStarted: 0, changes: [{ owner: 'cmdb' }] });
    expect(() => service.planCmdbSync('enterprise-connectors', { product: 'netbox', direction: 'export', resourceType: 'vm', resourceRef: 'vm-42', ownershipRules: { owner: 'cmdb' }, changes: [{ field: 'owner', operation: 'set', owner: 'docker-dash', valueHash: 'b'.repeat(64) }], conflicts: [] }, admin)).toThrow(expect.objectContaining({ code: 'OWNERSHIP_MISMATCH' }));
  });
  test('B408 gates ITSM changes on approval and exact change window', () => {
    expect(service.linkItsmChange('enterprise-connectors', { product: 'servicenow', ticketRef: 'CHG001', ticketUrl: 'https://itsm.example.test/change/CHG001', windowStart: '2026-07-30T09:00:00Z', windowEnd: '2026-07-30T10:00:00Z', approvalState: 'approved', evidenceLinks: ['https://evidence.example.test/run/42'], evaluatedAt: '2026-07-30T09:30:00Z' }, admin)).toMatchObject({ gateState: 'ready', approvalState: 'approved', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(service.linkItsmChange('enterprise-connectors', { product: 'servicenow', ticketRef: 'CHG002', ticketUrl: 'https://itsm.example.test/change/CHG002', windowStart: '2026-07-30T09:00:00Z', windowEnd: '2026-07-30T10:00:00Z', approvalState: 'pending', evidenceLinks: [], evaluatedAt: '2026-07-30T09:30:00Z' }, admin).gateState).toBe('approval_required');
  });
  test('B409 normalizes SIEM events without persisting raw payloads', () => {
    const event = service.normalizeSiemEvent('enterprise-connectors', { product: 'splunk', eventType: 'vm.policy.denied', occurredAt: '2026-07-30T09:00:00Z', severity: 'high', resourceRef: 'vm-42', correlationId: 'run-42', attributes: { policy: 'production-guard', result: 'denied' } }, admin);
    expect(event).toMatchObject({ destinationKind: 'splunk', rawPayloadStored: false, envelope: { schemaRef: 'urn:docker-dash:event:1.0' } });
    expect(db.prepare('SELECT raw_payload_stored FROM siem_connector_events WHERE event_id=?').get(event.eventId).raw_payload_stored).toBe(0);
  });
  test('B410 stores provider-native secret references and rejects secret material', () => {
    expect(service.bindSecretReference('enterprise-connectors', { product: 'vault', referenceUri: 'vault://kv/docker-dash/netbox', purpose: 'connector_auth', scopes: ['cmdb.read'] }, admin)).toMatchObject({ providerKind: 'vault', secretMaterialStored: false, referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => service.bindSecretReference('enterprise-connectors', { product: 'vault', referenceUri: 'vault://kv/app', purpose: 'connector_auth', scopes: ['cmdb.read'], secretValue: 'forbidden' }, admin)).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
  });
  test('B411 creates ownership/version-bound IPAM and DNS lifecycle plans without apply', () => {
    expect(service.planIpamDns('enterprise-connectors', { product: 'infoblox', action: 'create', resourceRef: 'vm-42', recordType: 'A', address: '10.20.30.42', fqdn: 'vm42.example.test', ownershipToken: 'reservation-42', expectedVersion: 'etag-9' }, admin)).toMatchObject({ action: 'create', recordType: 'A', state: 'planned', externalMutationsStarted: 0 });
  });
  test('B412 normalizes backup job and recovery-point visibility', () => {
    expect(service.recordBackupObservation('enterprise-connectors', { product: 'veeam', jobRef: 'job-7', workloadRef: 'vm-42', status: 'success', lastRunAt: '2026-07-30T08:00:00Z', recoveryPoints: [{ id: 'rp-7', createdAt: '2026-07-30T08:00:00Z', type: 'incremental', verified: true, sizeBytes: 4096 }] }, admin)).toMatchObject({ providerKind: 'veeam', visibilityOnly: true, recoveryPoints: [{ verified: true }] });
  });
  test('B413 limits monitoring targets to signed HTTPS hosts and metric/label allowlists', () => {
    expect(service.saveMonitoringTarget('enterprise-connectors', { product: 'prometheus', endpointOrigin: 'https://monitor.example.test/api', mode: 'pull', metricAllowlist: ['vm_cpu_usage'], labelAllowlist: ['host_id'] }, admin)).toMatchObject({ endpointOrigin: 'https://monitor.example.test', enabled: false, networkCallsStarted: 0 });
    expect(() => service.saveMonitoringTarget('enterprise-connectors', { product: 'prometheus', endpointOrigin: 'https://evil.example.test', mode: 'pull', metricAllowlist: ['vm_cpu_usage'], labelAllowlist: [] }, admin)).toThrow(expect.objectContaining({ code: 'HOST_DENIED' }));
  });
  test('B414 creates schema-bound event-bus publications without publishing', () => {
    expect(service.planEventPublish('enterprise-connectors', { product: 'kafka', channel: 'docker-dash.events.v1', schemaRef: 'urn:docker-dash:event:1.0', event: { eventType: 'vm.changed', occurredAt: '2026-07-30T09:00:00Z', subject: 'vm-42', data: { state: 'running' } } }, admin)).toMatchObject({ deliveryState: 'planned', externalPublishesStarted: 0, envelope: { specVersion: '1.0' } });
  });
  test('B415 prototypes only allowlisted OpenAPI operations and fields without network calls', () => {
    service.registerOpenApiOperation('enterprise-connectors', { operationKey: 'vm_read', endpointOrigin: 'https://api.example.test/v1', method: 'GET', path: '/v1/vms', risk: 'read', allowedQuery: ['id'], allowedBody: [], responseSchemaHash: 'c'.repeat(64) }, admin);
    expect(service.prototypeOpenApiRequest('enterprise-connectors', 'vm_read', { query: { id: 'vm-42' }, body: {} }, admin)).toMatchObject({ allowlistEnforced: true, networkCallsStarted: 0, responsePayloadReturned: false, request: { method: 'GET', queryKeys: ['id'] } });
    expect(() => service.prototypeOpenApiRequest('enterprise-connectors', 'vm_read', { query: { command: 'delete' }, body: {} }, admin)).toThrow(expect.objectContaining({ code: 'FIELD_DENIED' }));
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'connector-marketplace.js'), 'utf8'); expect(routes).toContain("router.post('/:connectorKey/openapi-operations/:operationKey/prototypes'"); expect(routes).not.toMatch(/fetch\s*\(|https?\.request\s*\(/);
  });
});
