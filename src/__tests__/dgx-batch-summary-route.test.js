'use strict';
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => req.user ? next() : res.sendStatus(401),
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.sendStatus(403),
  writeable: (_req, _res, next) => next(),
}));
const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');
const docker = require('../services/docker');
const dgx = require('../services/ai/dgx');
const batch = require('../services/ai/features/dgx-batch-summary');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 800, username: 'batch-admin', role: 'admin' }; next(); });
app.use('/images', require('../routes/images'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
let db;
let first;
let foreign;
let unverified;
beforeAll(() => {
  db = getDb();
  db.prepare("INSERT INTO users (id,username,password_hash,role,is_active) VALUES (800,'batch-admin','fixture','admin',1)").run();
  db.prepare("INSERT INTO docker_hosts (id,name,connection_type,daemon_type,is_active) VALUES (811,'Batch Host','socket','docker',1),(812,'Foreign Host','socket','docker',1)").run();
  const insert = db.prepare("INSERT INTO scan_results (image_id,verified_image_id,image_name,scanner,host_id,results_json) VALUES ('sha256:a',?,'app:1','trivy',?,'[]')");
  first = Number(insert.run('sha256:a',811).lastInsertRowid);
  foreign = Number(insert.run('sha256:a',812).lastInsertRowid);
  unverified = Number(insert.run(null,811).lastInsertRowid);
});
beforeEach(() => {
  jest.spyOn(docker, 'listContainers').mockResolvedValue([]);
  jest.spyOn(dgx, 'settings').mockReturnValue({ enabled: false });
  jest.spyOn(batch, 'summarize').mockResolvedValue({ images: [], dgxStatus: 'disabled' });
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

test('loads exactly the requested verified scan from the selected host', async () => {
  await request(app).post('/images/scan-batch-summary?hostId=811').send({ scanIds: [first] }).expect(200);
  expect(batch.summarize).toHaveBeenCalledWith(expect.objectContaining({ scans: [expect.objectContaining({ id: first })] }), { enabled: false });
});

test('rejects foreign, unverified, duplicate and excessive scan selections before inference', async () => {
  for (const ids of [[foreign], [unverified], [first, foreign]]) {
    await request(app).post('/images/scan-batch-summary?hostId=811').send({ scanIds: ids }).expect(404);
  }
  for (const ids of [[first, first], [], Array.from({ length: 501 }, (_, index) => index + 1)]) {
    await request(app).post('/images/scan-batch-summary?hostId=811').send({ scanIds: ids }).expect(400);
  }
  expect(batch.summarize).not.toHaveBeenCalled();
});
