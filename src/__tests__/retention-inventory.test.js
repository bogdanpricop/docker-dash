'use strict';

jest.mock('../services/registry', () => ({ tags: jest.fn(), manifest: jest.fn() }));
const registry = require('../services/registry');
const { _gatherTagsWithMetadata: gather } = require('../services/retention-cron')._internals;

beforeEach(() => jest.resetAllMocks());

test('retention refuses truncated inventories before looking up manifests', async () => {
  registry.tags.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => `tag-${i}`));
  await expect(gather(1, 'team/app')).rejects.toThrow(/complete inventory/);
  expect(registry.manifest).not.toHaveBeenCalled();
});

test('retention refuses a plan if even one tag has unreadable metadata', async () => {
  registry.tags.mockResolvedValue(['temporary', 'latest']);
  registry.manifest.mockResolvedValueOnce({ digest: 'sha256:shared', manifest: {} })
    .mockRejectedValueOnce(new Error('registry unavailable'));
  await expect(gather(1, 'team/app')).rejects.toThrow(/complete manifest metadata/);
});

test('complete tag inventory retains every digest for alias protection', async () => {
  registry.tags.mockResolvedValue(['temporary', 'latest']);
  registry.manifest.mockResolvedValue({ digest: 'sha256:shared', manifest: {} });
  const tags = await gather(1, 'team/app');
  expect(tags.map(t => t.tag)).toEqual(['temporary', 'latest']);
  expect(tags.every(t => t.digest === 'sha256:shared')).toBe(true);
});
