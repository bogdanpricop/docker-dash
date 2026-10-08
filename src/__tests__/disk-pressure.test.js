'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-disk-pressure-'));
process.env.APP_SECRET = 'disk-pressure-test-secret';
process.env.ENCRYPTION_KEY = 'disk-pressure-test-key-32-chars';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const docker = require('../services/docker');
const pressure = require('../services/disk-pressure');

let hostId;

beforeAll(() => {
  hostId = getDb().prepare('SELECT id FROM docker_hosts WHERE is_default=1').get().id;
  pressure.updatePolicy(hostId, {
    enabled: true, dry_run_only: true, threshold_percent: 80,
    max_docker_bytes: 1024 * 1024 * 1024, min_age_hours: 24,
    prune_containers: true, prune_images: true, prune_networks: true,
  });
});

beforeEach(() => {
  jest.spyOn(docker, 'withPruneProtection').mockImplementation(async (_host, action) => action({ helperImage: null }));
  const old = Math.floor((Date.now() - 48 * 3600000) / 1000);
  jest.spyOn(docker, 'getDiskUsage').mockResolvedValue({
    Images: [{ Size: 2 * 1024 * 1024 * 1024 }], Containers: [], Volumes: [], BuildCache: [],
  });
  jest.spyOn(docker, 'getInfo').mockResolvedValue({ diskTotal: 1000, diskUsed: 900 });
  jest.spyOn(docker, 'listContainers').mockResolvedValue([
    { id: 'old', name: 'old-stopped', state: 'exited', created: old, labels: {}, image: 'old:image', imageId: 'aaaaaaaaaaaa' },
    { id: 'protected', name: 'keep', state: 'exited', created: old, labels: { 'docker-dash.protect': 'true' }, image: 'keep:image', imageId: 'bbbbbbbbbbbb' },
    { id: 'running', name: 'live', state: 'running', created: old, labels: {}, image: 'live:image', imageId: 'cccccccccccc' },
  ]);
  jest.spyOn(docker, 'listImages').mockResolvedValue([
    { id: 'sha256:aaaaaaaaaaaa', shortId: 'aaaaaaaaaaaa', repoTags: ['old:image'], size: 100, created: old, labels: {} },
    { id: 'sha256:dddddddddddd', shortId: 'dddddddddddd', repoTags: ['unused:image'], size: 200, created: old, labels: {} },
    { id: 'sha256:eeeeeeeeeeee', shortId: 'eeeeeeeeeeee', repoTags: ['protected:image'], size: 300, created: old, labels: { 'docker-dash.protect': 'yes' } },
  ]);
  jest.spyOn(docker, 'listNetworks').mockResolvedValue([
    { id: 'bridge', name: 'bridge', containers: {}, created: new Date(old * 1000).toISOString(), labels: {} },
    { id: 'unused-net', name: 'unused-net', containers: {}, created: new Date(old * 1000).toISOString(), labels: {} },
  ]);
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => { closeDb(); fs.rmSync(testDataDir, { recursive: true, force: true }); });

describe('disk-pressure safeguards', () => {
  it('selects only old, unused, unprotected resources and never volumes', async () => {
    const evaluation = await pressure.evaluate(hostId);
    expect(evaluation.threshold_met).toBe(true);
    expect(evaluation.candidates.containers.map(item => item.id)).toEqual(['old']);
    expect(evaluation.candidates.images.map(item => item.id)).toEqual(['sha256:dddddddddddd']);
    expect(evaluation.candidates.networks.map(item => item.id)).toEqual(['unused-net']);
    expect(evaluation.candidates.volumes).toEqual([]);
  });

  it('defaults policy execution to a persisted dry-run plan', async () => {
    const remove = jest.spyOn(docker, 'removeImage').mockResolvedValue();
    const result = await pressure.run(hostId, { force: true, triggerType: 'manual' });
    expect(result).toMatchObject({ status: 'planned', dry_run: true });
    expect(remove).not.toHaveBeenCalled();
    expect(pressure.history(hostId)[0]).toMatchObject({ status: 'planned', dry_run: true });
  });

  it('deletes exact candidates after explicit live-mode enablement and still preserves volumes', async () => {
    pressure.updatePolicy(hostId, { dry_run_only: false });
    const removeContainer = jest.spyOn(docker, 'removeContainer').mockResolvedValue();
    const removeImage = jest.spyOn(docker, 'removeImage').mockResolvedValue();
    const removeNetwork = jest.spyOn(docker, 'removeNetwork').mockResolvedValue();
    const result = await pressure.run(hostId, { force: true, triggerType: 'manual' });
    expect(result.status).toBe('success');
    expect(removeContainer).toHaveBeenCalledWith('old', { force: false, v: false }, hostId);
    expect(removeImage).toHaveBeenCalledWith('sha256:dddddddddddd', { force: false }, hostId);
    expect(removeNetwork).toHaveBeenCalledWith('unused-net', hostId);
    expect(result.results.volumes).toEqual([]);
    pressure.updatePolicy(hostId, { dry_run_only: true });
  });

  it('cannot delete candidates while a recovery reservation blocks cleanup', async () => {
    pressure.updatePolicy(hostId, { dry_run_only: false });
    docker.withPruneProtection.mockRejectedValue(Object.assign(new Error('recovery pending'), { status: 409 }));
    const remove = jest.spyOn(docker, 'removeContainer').mockResolvedValue();
    try {
      await expect(pressure.run(hostId, { force: true })).rejects.toMatchObject({ status: 409 });
      expect(remove).not.toHaveBeenCalled();
    } finally { pressure.updatePolicy(hostId, { dry_run_only: true }); }
  });

  it('preserves the helper even if it was selected before acquiring the guard', async () => {
    pressure.updatePolicy(hostId, { dry_run_only: false });
    docker.withPruneProtection.mockImplementation(async (_host, action) => action({ helperImage: 'sha256:dddddddddddd' }));
    jest.spyOn(docker, 'removeContainer').mockResolvedValue(); jest.spyOn(docker, 'removeNetwork').mockResolvedValue();
    const remove = jest.spyOn(docker, 'removeImage').mockResolvedValue();
    try {
      const result = await pressure.run(hostId, { force: true });
      expect(remove).not.toHaveBeenCalled(); expect(result.results.images[0].status).toBe('protected');
    } finally { pressure.updatePolicy(hostId, { dry_run_only: true }); }
  });

  it('propagates uncertain deletion to the guard and stops subsequent deletions', async () => {
    pressure.updatePolicy(hostId, { dry_run_only: false });
    jest.spyOn(docker, 'removeContainer').mockRejectedValue(new Error('response lost'));
    const remove = jest.spyOn(docker, 'removeImage').mockResolvedValue();
    try {
      await expect(pressure.run(hostId, { force: true })).rejects.toThrow('response lost');
      expect(remove).not.toHaveBeenCalled(); expect(pressure.history(hostId)[0].status).toBe('failed');
    } finally { pressure.updatePolicy(hostId, { dry_run_only: true }); }
  });
});
