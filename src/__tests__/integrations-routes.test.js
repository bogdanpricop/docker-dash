'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../services/docker', () => ({ listContainers: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); },
}));
jest.mock('../middleware/hostId', () => ({
  extractHostId: (req, _res, next) => { req.hostId = Number(req.query.hostId || 0); next(); },
}));

const dockerService = require('../services/docker');
const app = express();
app.use('/api/integrations', require('../routes/integrations'));

describe('monitoring integration discovery', () => {
  beforeEach(() => jest.clearAllMocks());

  test('detects Uptime Kuma and exposes its published port', async () => {
    dockerService.listContainers.mockResolvedValue([{
      Id: 'kuma-id', Names: ['/uptime-kuma'], Image: 'louislam/uptime-kuma:2',
      Ports: [{ PrivatePort: 3001, PublicPort: 43001 }],
    }]);
    const response = await request(app).get('/api/integrations/uptime-kuma?hostId=7').expect(200);
    expect(dockerService.listContainers).toHaveBeenCalledWith(7, { all: true });
    expect(response.body).toMatchObject({
      detected: true, url: 'http://<this-host>:43001',
      container: { id: 'kuma-id', name: '/uptime-kuma', image: 'louislam/uptime-kuma:2' },
    });
  });

  test('returns a stable negative result when absent or unavailable', async () => {
    dockerService.listContainers.mockResolvedValue([{ Image: 'nginx:alpine' }]);
    await request(app).get('/api/integrations/uptime-kuma')
      .expect(200, { detected: false });

    dockerService.listContainers.mockRejectedValue(new Error('daemon unavailable'));
    const unavailable = await request(app).get('/api/integrations/uptime-kuma').expect(200);
    expect(unavailable.body).toEqual({ detected: false, error: 'daemon unavailable' });
  });
});
