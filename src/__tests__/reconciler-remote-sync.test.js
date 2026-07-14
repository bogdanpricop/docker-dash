'use strict';

// Reconciler remote sync (GitOps pull). Unit tests for URL validation, token
// redaction, and the fetch → validateDoc → store happy/error paths with the https
// client MOCKED via the injection seam (remoteSync._internals._client.fetch). No
// network is touched. Uses an in-memory SQLite so migration 084 runs for real.

process.env.APP_ENV = 'test';
process.env.APP_SECRET = 'test-secret-reconciler-remote-sync';
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

const { getDb } = require('../db');
getDb(); // runs migrations (082 blueprints + 084 blueprint_source)

const rec = require('../services/reconciler');
const remoteSync = require('../services/reconciler/remote-sync');

const VALID_DOC = { version: 1, hosts: { 2: { firewall: [{ action: 'allow', scope: 'host', destination_port: 443 }] } } };

function newBlueprint() {
  return rec.create({ name: 'gitops', description: 'test', doc: VALID_DOC, user: { username: 'tester' } }).id;
}

describe('remote-sync URL validation (http(s) only)', () => {
  const { _validateUrl } = remoteSync._internals;
  test('accepts http and https', () => {
    expect(_validateUrl('https://example.com/bp.json')).toMatch(/^https:\/\//);
    expect(_validateUrl('http://10.0.0.1/bp.json')).toMatch(/^http:\/\//);
  });
  test('rejects non-http(s) protocols (SSRF/file surface)', () => {
    expect(() => _validateUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => _validateUrl('ftp://host/x')).toThrow(/http/);
    expect(() => _validateUrl('gopher://host')).toThrow(/http/);
  });
  test('rejects empty and non-URL garbage', () => {
    expect(() => _validateUrl('')).toThrow(/required/);
    expect(() => _validateUrl('not a url')).toThrow(/valid/);
  });
  test('setSource rejects a non-http(s) url', () => {
    const id = newBlueprint();
    expect(() => remoteSync.setSource(id, { url: 'file:///etc/passwd' })).toThrow(/http/);
  });
});

describe('remote-sync token redaction', () => {
  test('setSource encrypts the token; getSource returns hasToken but never the value', () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json', token: 'super-secret-token', autoSync: true, intervalMin: 30 });
    const src = remoteSync.getSource(id);
    expect(src.hasToken).toBe(true);
    expect(src.token).toBeUndefined();
    expect(src.autoSync).toBe(true);
    expect(src.intervalMin).toBe(30);
    expect(JSON.stringify(src)).not.toContain('super-secret-token');
    // rec.get() must not leak the raw encrypted column either.
    const full = rec.get(id);
    expect(full.source.hasToken).toBe(true);
    expect(full.source_token_enc).toBeUndefined();
    expect(JSON.stringify(full)).not.toContain('super-secret-token');
  });
  test('clearToken removes the stored token', () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json', token: 'tok' });
    expect(remoteSync.getSource(id).hasToken).toBe(true);
    remoteSync.setSource(id, { url: 'https://example.com/bp.json', clearToken: true });
    expect(remoteSync.getSource(id).hasToken).toBe(false);
  });
  test('interval below 1 falls back to the default', () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json', intervalMin: 0 });
    expect(remoteSync.getSource(id).intervalMin).toBe(60);
  });
});

describe('remote-sync syncNow (fetch → validateDoc → store)', () => {
  const orig = remoteSync._internals._client.fetch;
  afterEach(() => { remoteSync._internals._client.fetch = orig; });

  test('happy path: valid remote doc updates the blueprint, status ok, changed=true', async () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json' });
    const remoteDoc = { version: 1, hosts: { 5: { firewall: [{ action: 'allow', scope: 'host', destination_port: 8080 }] } } };
    remoteSync._internals._client.fetch = async () => JSON.stringify(remoteDoc);
    const r = await remoteSync.syncNow(id, { username: 'tester' });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const full = rec.get(id);
    expect(full.doc.hosts['5']).toBeDefined();
    expect(full.doc.hosts['5'].firewall[0]).toMatchObject({ destination_port: 8080, protocol: 'tcp' });
    expect(full.source.lastSyncStatus).toBe('ok');
    expect(full.source.lastSyncError).toBeNull();
  });

  test('re-syncing identical content reports changed=false', async () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json' });
    remoteSync._internals._client.fetch = async () => JSON.stringify({ version: 1, hosts: { 7: { firewall: [] } } });
    await remoteSync.syncNow(id, { username: 't' });
    const r2 = await remoteSync.syncNow(id, { username: 't' });
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
  });

  test('network error: keeps the good doc, records error status', async () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json' });
    remoteSync._internals._client.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const before = rec.get(id).doc;
    const r = await remoteSync.syncNow(id, { username: 't' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
    const full = rec.get(id);
    expect(full.doc).toEqual(before);
    expect(full.source.lastSyncStatus).toBe('error');
    expect(full.source.lastSyncError).toMatch(/ECONNREFUSED/);
  });

  test('invalid JSON: keeps the good doc, records error', async () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json' });
    remoteSync._internals._client.fetch = async () => 'not json {';
    const before = rec.get(id).doc;
    const r = await remoteSync.syncNow(id, { username: 't' });
    expect(r.ok).toBe(false);
    expect(rec.get(id).doc).toEqual(before);
    expect(rec.get(id).source.lastSyncStatus).toBe('error');
  });

  test('invalid blueprint (validateDoc rejects): keeps the good doc', async () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json' });
    remoteSync._internals._client.fetch = async () => JSON.stringify({ version: 2, hosts: {} });
    const before = rec.get(id).doc;
    const r = await remoteSync.syncNow(id, { username: 't' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/version/);
    expect(rec.get(id).doc).toEqual(before);
  });

  test('passes a Bearer token to the fetcher when one is stored', async () => {
    const id = newBlueprint();
    remoteSync.setSource(id, { url: 'https://example.com/bp.json', token: 'sekret' });
    let seenToken = null;
    remoteSync._internals._client.fetch = async (_url, token) => { seenToken = token; return JSON.stringify(VALID_DOC); };
    await remoteSync.syncNow(id, { username: 't' });
    expect(seenToken).toBe('sekret');
  });

  test('syncNow without a configured source throws', async () => {
    const id = newBlueprint();
    await expect(remoteSync.syncNow(id, { username: 't' })).rejects.toThrow(/No remote source/);
  });
});
