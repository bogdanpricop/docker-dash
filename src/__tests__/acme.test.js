'use strict';

// Tests for src/services/acme.js (v6.5 LE Wizard orchestrator)
//
// Uses an in-memory SQLite + a temp dir for credential files.
// Caddy admin is stubbed via a non-existent socket (any push attempt fails
// fast with ENOENT, which we check separately in caddy-config.test.js).

process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a per-test-run temp dir for credential files (and clean it up)
const TEST_SECRETS_DIR = path.join(os.tmpdir(), 'dd-acme-test-' + Date.now());
process.env.CADDY_SECRETS_DIR = TEST_SECRETS_DIR;
process.env.CADDY_ADMIN_SOCKET = '/tmp/no-such-caddy-admin.sock-' + Date.now();

// Use in-memory DB
process.env.DB_PATH = ':memory:';

const acme = require('../services/acme');
const { getDb } = require('../db');

// When run in a shared Jest worker with other tests, the DB module is cached
// and our :memory: DB_PATH override may be ignored (some other test loaded
// db/index.js first). To make tests deterministic regardless of DB state,
// every credential name gets a per-run unique suffix.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const N = (base) => `${base}-${RUN_ID}`;

beforeAll(() => {
  // First getDb() call applies migrations (db/index.js:24)
  getDb();
});

afterAll(() => {
  // Clean up our test credentials (best-effort, ignore failures)
  try {
    const db = getDb();
    db.prepare(`DELETE FROM acme_managed_certs WHERE credentials_id IN (SELECT id FROM acme_credentials WHERE name LIKE ?)`).run(`%${RUN_ID}`);
    db.prepare('DELETE FROM acme_credentials WHERE name LIKE ?').run(`%${RUN_ID}`);
  } catch {}
});

afterAll(() => {
  // Cleanup temp credential dir
  try { fs.rmSync(TEST_SECRETS_DIR, { recursive: true, force: true }); } catch {}
});

describe('acme.createCredential', () => {
  it('creates a Cloudflare credential and writes the secret file', async () => {
    const result = await acme.createCredential({
      name: N('test-cf-1'),
      providerId: 'cloudflare',
      credentials: { api_token: 'test-token-value-here' },
      userId: 1,
    });

    expect(result.id).toBeGreaterThan(0);
    expect(result.name).toBe(N('test-cf-1'));
    expect(result.providerId).toBe('cloudflare');

    // Secret file written to disk
    const expectedFile = path.join(TEST_SECRETS_DIR, String(result.id), 'api_token');
    expect(fs.existsSync(expectedFile)).toBe(true);
    expect(fs.readFileSync(expectedFile, 'utf8')).toBe('test-token-value-here');

    // DB row stored encrypted (NOT plaintext)
    const row = getDb().prepare('SELECT credentials_encrypted FROM acme_credentials WHERE id = ?').get(result.id);
    expect(row.credentials_encrypted).not.toContain('test-token-value-here');
    expect(row.credentials_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('rejects duplicate credential names', async () => {
    const dupName = N('test-cf-dup');
    await acme.createCredential({
      name: dupName, providerId: 'cloudflare', credentials: { api_token: 'first' },
    });
    await expect(acme.createCredential({
      name: dupName, providerId: 'cloudflare', credentials: { api_token: 'second' },
    })).rejects.toThrow(/UNIQUE/);
  });

  it('rejects unknown provider', async () => {
    await expect(acme.createCredential({
      name: N('test-bad-provider'),
      providerId: 'not-real',
      credentials: { api_token: 'x' },
    })).rejects.toThrow(/Unknown provider/);
  });

  it('rejects missing required field', async () => {
    await expect(acme.createCredential({
      name: N('test-cf-no-token'),
      providerId: 'cloudflare',
      credentials: {},
    })).rejects.toThrow(/api_token/);
  });
});

describe('acme.rotateCredential', () => {
  it('updates the encrypted blob AND replaces the on-disk file atomically', async () => {
    const created = await acme.createCredential({
      name: N('test-cf-rotate'),
      providerId: 'cloudflare',
      credentials: { api_token: 'original-token' },
    });

    await acme.rotateCredential(created.id, { api_token: 'rotated-token' });

    const filePath = path.join(TEST_SECRETS_DIR, String(created.id), 'api_token');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('rotated-token');

    // No .tmp file left behind
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });

  it('throws on unknown credential id', async () => {
    await expect(acme.rotateCredential(999999, { api_token: 'x' }))
      .rejects.toThrow(/not found/);
  });
});

describe('acme.deleteCredential', () => {
  it('removes DB row and on-disk file', async () => {
    const created = await acme.createCredential({
      name: N('test-cf-delete'),
      providerId: 'cloudflare',
      credentials: { api_token: 'delete-me' },
    });

    await acme.deleteCredential(created.id);

    const row = getDb().prepare('SELECT id FROM acme_credentials WHERE id = ?').get(created.id);
    expect(row).toBeUndefined();

    const dir = path.join(TEST_SECRETS_DIR, String(created.id));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses to delete a credential that is in use', async () => {
    const created = await acme.createCredential({
      name: N('test-cf-in-use'),
      providerId: 'cloudflare',
      credentials: { api_token: 'in-use-token' },
    });
    // Manually link a cert to this credential
    const linkedDomain = N('linked.example.com');
    getDb().prepare(`
      INSERT INTO acme_managed_certs (domain, challenge_type, provider_id, credentials_id)
      VALUES (?, 'dns-01', 'cloudflare', ?)
    `).run(linkedDomain, created.id);

    await expect(acme.deleteCredential(created.id)).rejects.toThrow(/in use/);

    // Cleanup
    getDb().prepare('DELETE FROM acme_managed_certs WHERE domain = ?').run(linkedDomain);
    await acme.deleteCredential(created.id);
  });
});

describe('acme.issueCertificate — input validation', () => {
  it('rejects empty domains', async () => {
    await expect(acme.issueCertificate({
      domains: [], email: 'a@b.com', challengeType: 'http-01',
    })).rejects.toThrow(/domains/);
  });

  it('rejects missing email', async () => {
    await expect(acme.issueCertificate({
      domains: ['x.example.com'], email: '', challengeType: 'http-01',
    })).rejects.toThrow(/email/);
  });

  it('forces dns-01 for wildcard domains', async () => {
    await expect(acme.issueCertificate({
      domains: ['*.example.com'], email: 'a@b.com', challengeType: 'http-01',
    })).rejects.toThrow(/Wildcard.*dns-01/);
  });
});
