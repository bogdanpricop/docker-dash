'use strict';

const { summarize } = require('../services/ai/features/dgx-batch-summary');
const scan = (id, image, rows, scanner = 'trivy') => ({ id, verified_image_id: image, image_name: image + ':latest',
  scanner, scanned_at: '2026-11-17T00:00:00Z', results_json: JSON.stringify(rows) });
const finding = { id: 'CVE-2026-12345', package: 'libexample', version: '1', severity: 'high', fixedIn: '2' };

test('deduplicates scanner evidence per image and associates only matching containers', async () => {
  const analyze = jest.fn();
  const result = await summarize({ scans: [scan(1, 'a', [finding]), scan(2, 'a', [{ ...finding, severity: 'critical', fixedIn: '' }], 'grype'),
    scan(3, 'b', [finding])], containers: [{ id: 'one', name: 'app', imageIdFull: 'a', state: 'running' },
    { id: 'other', name: 'foreign', imageIdFull: 'unscanned', state: 'running' }] }, { enabled: false }, analyze);
  expect(result.images).toHaveLength(2);
  expect(result.images[0]).toMatchObject({ imageId: 'a', total: 1, critical: 1, high: 0, fixable: 1,
    consumers: [{ name: 'app' }], scans: [{ id: 1 }, { id: 2 }] });
  expect(result.images[1].consumers).toEqual([]);
  expect(analyze).not.toHaveBeenCalled();
});

test('AI receives image-scoped batch evidence and failures preserve the scan summary', async () => {
  const analyze = jest.fn().mockRejectedValue(new Error('Gateway unavailable'));
  const result = await summarize({ scans: [scan(7, 'a', [finding])], containers: [] }, { enabled: true }, analyze);
  expect(analyze.mock.calls[0][0]).toMatchObject({ stack: true, scans: [{ id: 7, imageId: 'a' }] });
  expect(result).toMatchObject({ dgxStatus: 'failed', dgxError: 'Gateway unavailable', scanCount: 1,
    images: [{ total: 1, high: 1 }] });
});

test('retains verified AI references and skips inference for an empty batch', async () => {
  const analyze = jest.fn().mockResolvedValue({ transport: 'dgx', findings: [{ sources: [{ scanId: 7 }] }] });
  const result = await summarize({ scans: [scan(7, 'a', [finding])], containers: [] }, { enabled: true }, analyze);
  expect(result.analysis.findings[0].sources).toEqual([{ scanId: 7 }]);
  expect(result.dgxStatus).toBe('completed');
  analyze.mockClear();
  await summarize({ scans: [], containers: [] }, { enabled: false }, analyze);
  expect(analyze).not.toHaveBeenCalled();
});
