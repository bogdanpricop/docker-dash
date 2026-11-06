'use strict';

// v8.95.1 — container export must not carry credentials.
//
// The regression: /:id/export built its output by interpolating inspect data
// directly — env vars as `-e "KEY=VALUE"`, labels as `--label k="v"` — with no
// escaping and no redaction. A container's secrets were therefore exported
// verbatim into a command operators paste into tickets, and a value containing a
// quote produced a broken and potentially injectable string.

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
  writeable: (_req, _res, next) => next(),
  requireFeature: () => (_req, _res, next) => next(),
}));
jest.mock('../middleware/hostId', () => ({
  extractHostId: (req, _res, next) => { req.hostId = 0; next(); },
}));
jest.mock('../middleware/hostAccess', () => ({
  requireHostAccessForMethod: () => (_req, _res, next) => next(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/permissions', () => ({
  filterContainers: v => v,
  getEffectiveRole: jest.fn(() => 'admin'),
  hasPermission: jest.fn(() => true),
}));
jest.mock('../services/docker', () => ({
  inspectContainer: jest.fn(),
  getInfo: jest.fn(async () => ({})),
  listContainers: jest.fn(),
  getDocker: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');

const app = express();
app.use(express.json());
app.use('/api/containers', require('../routes/containers'));

const container = (over = {}) => ({
  id: 'abc', name: 'api', image: 'app:1.2.3',
  env: ['TZ=UTC', 'DB_PASSWORD=hunter2', 'API_KEY=sk-live-secret'],
  ports: { '80/tcp': [{ HostPort: '8080' }] },
  mounts: [{ Source: '/data', Destination: '/var/lib/app', RW: true }],
  networks: { proxy: {} },
  labels: { 'app.tier': 'backend', 'com.docker.compose.project': 'shop' },
  resources: {}, restartPolicy: { Name: 'unless-stopped' },
  isolation: { runtime: 'runc' },
  ...over,
});

const exportAs = (format) => request(app).get(`/api/containers/abc/export?format=${format}`);

beforeEach(() => jest.clearAllMocks());

describe('export as a run command', () => {
  it('masks secret-shaped env values', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    const res = await exportAs('run');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('sk-live-secret');
    expect(res.text).toContain('DB_PASSWORD=<redacted>');
    expect(res.text).toContain('API_KEY=<redacted>');
  });

  it('keeps ordinary env values intact', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    expect((await exportAs('run')).text).toContain('TZ=UTC');
  });

  it('says so when it masked something, rather than omitting silently', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    expect((await exportAs('run')).text).toContain('Fill them in before running');
  });

  it('adds no note when there was nothing to mask', async () => {
    dockerService.inspectContainer.mockResolvedValue(container({ env: ['TZ=UTC'] }));
    const res = await exportAs('run');
    expect(res.text).not.toContain('Fill them in');
  });

  it('shell-escapes a hostile value instead of breaking the command', async () => {
    dockerService.inspectContainer.mockResolvedValue(
      container({ env: ["MSG=x'; rm -rf /"], labels: {} })
    );
    const res = await exportAs('run');
    expect(res.text).toContain("'MSG=x'\\''; rm -rf /'");
  });

  it('still carries the parts that make the command usable', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    const text = (await exportAs('run')).text;
    expect(text).toContain('--name api');
    expect(text).toContain('-p 8080:80');
    expect(text).toContain('-v /data:/var/lib/app');
    expect(text).toContain('--network proxy');
    expect(text).toContain('--restart unless-stopped');
    // The image is always the last token of the command itself; the redaction
    // note, when present, follows it as a trailing comment.
    const command = text.split('\n#')[0].trim();
    expect(command.split('\n').pop()).toContain('app:1.2.3');
  });

  it('drops compose-managed labels, as before', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    const text = (await exportAs('run')).text;
    expect(text).toContain('app.tier=backend');
    expect(text).not.toContain('com.docker.compose.project');
  });
});

describe('export as compose', () => {
  it('masks secret-shaped env values', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    const res = await exportAs('compose');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('hunter2');
    expect(res.text).toContain('DB_PASSWORD=<redacted>');
  });

  it('notes the masking in a comment', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    expect((await exportAs('compose')).text).toContain('Fill them in before deploying');
  });

  it('still produces a usable service definition', async () => {
    dockerService.inspectContainer.mockResolvedValue(container());
    const text = (await exportAs('compose')).text;
    expect(text).toContain('services:');
    expect(text).toContain('image: app:1.2.3');
    expect(text).toContain('restart: unless-stopped');
    expect(text).toContain('- "8080:80"');
  });

  it('quotes a label value containing a quote instead of emitting broken YAML', async () => {
    dockerService.inspectContainer.mockResolvedValue(
      container({ env: [], labels: { 'app.note': 'says "hi"' } })
    );
    const text = (await exportAs('compose')).text;
    expect(text).toContain('app.note: "says \\"hi\\""');
  });
});
