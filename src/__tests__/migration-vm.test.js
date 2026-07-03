'use strict';

// v8.9.2-alpha.1 — Sprint 7 (VM migration) tests.
//
// Covers the pure helpers (spec validation, source ext detection,
// shell escape) and job persistence (createJob writes a row, listJobs
// returns it, getJob fetches by id). The SSH exec / qemu-img path is
// NOT covered — that needs a real Proxmox host to verify against.

process.env.APP_SECRET = 'test-migration-vm';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// Stub setImmediate so createJob doesn't kick off runJob during tests —
// runJob would try to reach a real SSH host and fail. We just want to
// verify the row was persisted correctly.
const originalSetImmediate = global.setImmediate;
global.setImmediate = () => { /* swallow — no worker in tests */ };

const migrationSvc = require('../services/migration-vm');
const { getDb } = require('../db');

// Restore setImmediate for anything downstream that needs it (Jest
// internals).
afterAll(() => { global.setImmediate = originalSetImmediate; });

describe('migration-vm service (v8.9.2-alpha.1)', () => {
  describe('_validateSpec', () => {
    const { _validateSpec } = migrationSvc._internals;

    it('rejects missing sourceUrl', () => {
      expect(() => _validateSpec({})).toThrow(/sourceUrl/);
    });

    it('rejects non-http source', () => {
      expect(() => _validateSpec({ sourceUrl: 'file:///etc/passwd' })).toThrow(/http/);
    });

    it('rejects bogus destination host id', () => {
      expect(() => _validateSpec({
        sourceUrl: 'https://example.com/x.vmdk',
        destinationHostId: 0,
      })).toThrow(/destinationHostId/);
    });

    it('rejects bogus VMID (below range)', () => {
      expect(() => _validateSpec({
        sourceUrl: 'https://example.com/x.vmdk',
        destinationHostId: 3, destinationNode: 'pve',
        destinationStorage: 'local-lvm', destinationVmName: 'test',
        destinationVmid: 42,      // too low
      })).toThrow(/destinationVmid/i);
    });

    it('rejects bogus VM name (shell metacharacters)', () => {
      expect(() => _validateSpec({
        sourceUrl: 'https://example.com/x.vmdk',
        destinationHostId: 3, destinationNode: 'pve',
        destinationStorage: 'local-lvm', destinationVmName: 'bad; rm -rf /',
        destinationVmid: 200,
      })).toThrow(/destinationVmName/);
    });

    it('accepts a fully-formed spec', () => {
      expect(() => _validateSpec({
        sourceUrl: 'https://example.com/appliance.ova',
        destinationHostId: 3,
        destinationNode: 'pve',
        destinationStorage: 'local-lvm',
        destinationVmName: 'migrated-web',
        destinationVmid: 200,
      })).not.toThrow();
    });
  });

  describe('_sourceExt', () => {
    const { _sourceExt } = migrationSvc._internals;

    it('detects OVA from URL suffix', () => {
      expect(_sourceExt('https://x/y.ova', 'auto')).toBe('ova');
    });

    it('detects VMDK from URL suffix', () => {
      expect(_sourceExt('https://x/y.VMDK', 'auto')).toBe('vmdk');
    });

    it('detects QCOW2', () => {
      expect(_sourceExt('https://x/disk.qcow2', 'auto')).toBe('qcow2');
    });

    it('detects raw from .img alias', () => {
      expect(_sourceExt('https://x/disk.img', 'auto')).toBe('raw');
    });

    it('defaults to raw when URL has no known extension', () => {
      expect(_sourceExt('https://example.com/some-blob', 'auto')).toBe('raw');
    });

    it('honors an explicit declared format over the URL suffix', () => {
      expect(_sourceExt('https://x/disk.raw', 'qcow2')).toBe('qcow2');
    });
  });

  describe('_shellEscape', () => {
    const { _shellEscape } = migrationSvc._internals;

    it('single-quotes safe values', () => {
      expect(_shellEscape('hello')).toBe(`'hello'`);
    });

    it('escapes embedded single quotes safely', () => {
      // classic POSIX pattern: close quote, escape, reopen.
      expect(_shellEscape(`it's a value`)).toBe(`'it'\\''s a value'`);
    });

    it('handles null/undefined gracefully', () => {
      expect(_shellEscape(null)).toBe(`''`);
      expect(_shellEscape(undefined)).toBe(`''`);
    });

    it('escaped output stays as a single shell word (POSIX close-escape-reopen pattern)', () => {
      // Attempting `; rm -rf /` payload. Our _shellEscape uses the
      // classic POSIX pattern: close single quote, escape literal
      // apostrophe with backslash, reopen single quote. The RESULT
      // when parsed by a POSIX shell is one contiguous word — the
      // dangerous content stays literal.
      const dangerous = `hi'; rm -rf /`;
      const escaped = _shellEscape(dangerous);
      // Framed by outer single quotes.
      expect(escaped.startsWith("'")).toBe(true);
      expect(escaped.endsWith("'")).toBe(true);
      // Contains the escape-apostrophe pattern where the payload's
      // literal ' was.
      expect(escaped).toContain(`'\\''`);
    });
  });

  describe('job persistence', () => {
    beforeAll(() => {
      // Insert a fake destination host row so FK doesn't break.
      const db = getDb();
      db.prepare(`INSERT OR IGNORE INTO docker_hosts
        (id, name, connection_type, daemon_type, daemon_config)
        VALUES (777, 'test-pve', 'tcp', 'proxmox', ?)`)
        .run(JSON.stringify({
          endpoint: 'https://pve.example.com:8006',
          tokenId: 'root@pam!test', tokenSecret: 'x',
          sshConfig: { host: '10.0.0.1', user: 'root', privateKey: 'stub' },
        }));
    });

    it('createJob persists a row and returns the id', () => {
      const id = migrationSvc.createJob({
        sourceUrl: 'https://example.com/x.ova',
        destinationHostId: 777,
        destinationNode: 'pve',
        destinationStorage: 'local-lvm',
        destinationVmName: 'test',
        destinationVmid: 900,
      }, null);
      expect(id).toBeGreaterThan(0);
      const row = migrationSvc.getJob(id);
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
      expect(row.destination_vm_name).toBe('test');
      expect(row.destination_vmid).toBe(900);
      expect(row.created_by).toBeNull();
      expect(row.progress).toBe(0);
    });

    it('listJobs returns the created rows', () => {
      // Note: we don't assert strict order because both createJob calls
      // may share the same second-resolution created_at timestamp.
      // What matters is that both rows appear.
      const id1 = migrationSvc.createJob({
        sourceUrl: 'https://example.com/one.vmdk',
        destinationHostId: 777, destinationNode: 'pve',
        destinationStorage: 'local-lvm', destinationVmName: 'one',
        destinationVmid: 901,
      }, null);
      const id2 = migrationSvc.createJob({
        sourceUrl: 'https://example.com/two.vmdk',
        destinationHostId: 777, destinationNode: 'pve',
        destinationStorage: 'local-lvm', destinationVmName: 'two',
        destinationVmid: 902,
      }, null);
      const jobs = migrationSvc.listJobs(50);
      const ids = jobs.map(j => j.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });
  });
});
