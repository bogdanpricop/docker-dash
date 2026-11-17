'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function page(api = {}) {
  const context = vm.createContext({ window: {}, Api: api, Utils: {
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/pages/security.js'), 'utf8'), context);
  return context.window.SecurityPage;
}

test('summary evidence opens the scan in the batch host scope and escapes display text', () => {
  const p = page();
  const buttons = [{ dataset: { batchScan: '17' }, addEventListener: jest.fn() }];
  const element = { innerHTML: '', querySelector: () => null, querySelectorAll: () => buttons };
  p._viewScanDetail = jest.fn();
  p._renderBatchSummary(12, { succeeded: 1, entries: [], summary: {
    dgxStatus: 'disabled', images: [{ image: '<img src=x>', critical: 1, high: 0, fixable: 1,
      consumers: [{ name: '<script>' }], scans: [{ id: 17, scanner: 'trivy' }] }],
  } }, element);
  expect(element.innerHTML).toContain('&lt;img src=x>');
  expect(element.innerHTML).not.toContain('<script>');
  buttons[0].addEventListener.mock.calls[0][1]();
  expect(p._viewScanDetail).toHaveBeenCalledWith(17, 12);
});

test('automatic summary sends only this batch saved supported scan IDs to its original host', async () => {
  const api = { post: jest.fn().mockResolvedValue({ dgxStatus: 'disabled', images: [] }) };
  const p = page(api);
  const run = { entries: [{ scanId: 17, scanner: 'trivy' }, { scanId: 18, scanner: 'none' }, { status: 'Failed' }], hideSecondary: true };
  p._batchRuns.set(12, run);
  p._renderBatchRun = jest.fn();
  await p._summarizeBatch(12, run);
  expect(api.post).toHaveBeenCalledWith('/images/scan-batch-summary?hostId=12&secondary=hide', { scanIds: [17] });
  expect(run.summaryLoading).toBe(false);
  expect(run.summary.images).toEqual([]);
});
