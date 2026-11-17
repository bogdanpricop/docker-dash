'use strict';

const Database = require('better-sqlite3');
const mockDb = new Database(':memory:');
const mockDocker = {};
jest.mock('../db', () => ({ getDb: () => mockDb }));
jest.mock('../services/docker', () => ({ getDocker: jest.fn(() => mockDocker) }));
jest.mock('../services/ai/dgx', () => ({ settings: jest.fn(() => ({ enabled: true, model: 'test' })) }));
jest.mock('../services/ai/features/dgx-triage', () => ({ analyze: jest.fn(async () => ({ findings: [], model: 'test' })) }));
jest.mock('../services/image-scan-results', () => ({
  hasFix: finding => Boolean(finding.fixedIn),
  scanAndSave: jest.fn(),
}));
const dgx = require('../services/ai/dgx');
const scanner = require('../services/image-scan-results');
const reviews = require('../services/deployment-security');
const image = suffix => 'sha256:' + suffix.repeat(64);
const finding = (id, severity = 'high', fixedIn = '2.0') => ({ id, package: 'example', severity, version: '1.0', fixedIn });
const evidence = (id, engine, rows) => ({ id, scanner: engine, results_json: JSON.stringify(rows) });

beforeAll(() => {
  require('../db/migrations/197_deployment_security_reviews').up(mockDb);
  mockDb.exec(`CREATE TABLE scan_results (id INTEGER PRIMARY KEY,host_id INTEGER,verified_image_id TEXT,
    scanner TEXT,scanned_at TEXT DEFAULT (datetime('now')),results_json TEXT);`);
});
beforeEach(() => {
  mockDb.exec('DELETE FROM deployment_security_reviews; DELETE FROM scan_results;');
  jest.clearAllMocks();
  dgx.settings.mockReturnValue({ enabled: true, model: 'test' });
  scanner.scanAndSave.mockImplementation(async (docker, imageId, name, engine, hostId) => {
    expect(docker).toBe(mockDocker);
    const rows = imageId === image('a') ? [finding('CVE-2026-1000')] : [];
    const result = mockDb.prepare('INSERT INTO scan_results(host_id,verified_image_id,scanner,results_json) VALUES(?,?,?,?)')
      .run(hostId, imageId, engine, JSON.stringify(rows));
    return { scanId: Number(result.lastInsertRowid) };
  });
});
afterAll(() => { reviews.stop(); mockDb.close(); });

const enqueue = () => reviews.enqueue({ operationId: 'deployment-1', hostId: 7, containerName: 'app',
  previousImageId: image('a'), currentImageId: image('b') });
async function settled(id) {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve));
    const row = reviews.list(7, 'app').find(item => item.id === id);
    if (['complete', 'failed'].includes(row.status)) return row;
  }
  throw new Error('Review did not complete');
}

test('compares advisory and package evidence and reports new blockers separately', () => {
  const result = reviews.compare(evidence(1, 'trivy', [finding('OLD')]),
    evidence(2, 'trivy', [finding('NEW', 'critical'), finding('LOW', 'low', '')]));
  expect(result).toMatchObject({ removedCount: 1, addedCount: 2, blockerCount: 1, fixableCount: 1,
    previousScanId: 1, currentScanId: 2 });
  expect(result.removed[0].id).toBe('OLD');
});

test('treats uppercase and unrecognized severities as promotion blockers', () => {
  const result = reviews.compare(evidence(1, 'trivy', []), evidence(2, 'trivy', [
    finding('UPPER', 'HIGH'), finding('MISSING', ''), finding('UNRECOGNIZED', 'other'), finding('LOW', 'low'),
  ]));
  expect(result.blockerCount).toBe(3);
});

test('queues each deployment once and persists both scanner comparisons for the exact host and image IDs', async () => {
  const id = enqueue();
  expect(enqueue()).toBeNull();
  const row = await settled(id);
  expect(row.status).toBe('complete');
  expect(scanner.scanAndSave).toHaveBeenCalledTimes(4);
  expect(scanner.scanAndSave.mock.calls.every(args => args[4] === 7)).toBe(true);
  expect(row.report).toMatchObject({ previousImageId: image('a'), currentImageId: image('b'), promotionEligible: true, reviewRequired: true });
  expect(row.report.comparisons.map(c => c.scanner)).toEqual(['trivy', 'grype']);
  expect(reviews.list(8, 'app')).toEqual([]);
  expect(reviews.acknowledge(id, 8, 'app', 'admin')).toBe(false);
  expect(reviews.acknowledge(id, 7, 'app', 'operator')).toBe(true);
  expect(reviews.list(7, 'app')[0].reviewed_by).toBe('operator');
});

test('missing scanner evidence blocks promotion and is retained without claiming a successful comparison', async () => {
  const implementation = scanner.scanAndSave.getMockImplementation();
  scanner.scanAndSave.mockImplementation(async (...args) => {
    if (args[3] === 'grype') throw new Error('scanner secret diagnostic');
    return implementation(...args);
  });
  const row = await settled(enqueue());
  expect(row.report.promotionEligible).toBe(false);
  expect(row.report.comparisons).toHaveLength(1);
  expect(row.report.errors[0].scanner).toBe('grype');
  expect(JSON.stringify(row)).not.toContain('secret diagnostic');
});

test('disabled DGX skips automatic scans and interrupted evidence can be retried within the authorized container scope', async () => {
  dgx.settings.mockReturnValue({ enabled: false });
  expect(enqueue()).toBeNull();
  expect(scanner.scanAndSave).not.toHaveBeenCalled();
  dgx.settings.mockReturnValue({ enabled: true });
  scanner.scanAndSave.mockRejectedValueOnce(new Error('unavailable')).mockRejectedValueOnce(new Error('unavailable'));
  const id = enqueue();
  expect((await settled(id)).status).toBe('failed');
  expect(reviews.retry(id, 7, 'other-container')).toBe(false);
  expect(reviews.retry(id, 7, 'app')).toBe(true);
  expect((await settled(id)).status).toBe('complete');
});

test('temporary scanner archive paths do not report unchanged OS CVEs as removed and added', () => {
  const a = { ...finding('CVE-2026-1234'), _class: 'os-package', target: '/data/tmp/dd-image-admission-old/image.tar (alpine 3.22)' };
  const b = { ...a, target: '/data/tmp/dd-image-admission-new/image.tar (alpine 3.23)' };
  const result = reviews.compare(evidence(1, 'trivy', [a]), evidence(2, 'trivy', [b]));
  expect(result.removedCount).toBe(0);
  expect(result.addedCount).toBe(0);
  expect(result.currentCount).toBe(1);
});
