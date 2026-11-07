'use strict';

process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'settings-delivery-fixture';
process.env.ENCRYPTION_KEY = 'settings-delivery-encryption-fixture';

const http = require('node:http');
const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');
const auth = require('../services/auth');
const config = require('../config');
const logForwarder = require('../services/log-forwarder');

const app = express();
app.use(express.json());
app.use('/secrets', require('../routes/secrets'));
app.use('/forwarders', require('../routes/log-forwarders'));
let token;
const send = (method, path) => request(app)[method](path).set('Authorization', 'Bearer ' + token);

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'settings-admin', 'unused', 'admin')").run();
  token = auth._createSession(db.prepare('SELECT * FROM users WHERE id = 1').get(), '127.0.0.1', 'test').token;
});
afterAll(closeDb);

test('validates secret values and prevents caching the decrypted response', async () => {
  await send('post', '/secrets').send({ name: 12, value: 'test' }).expect(400);
  await send('post', '/secrets').send({ name: 'SECRET', value: { invalid: true } }).expect(400);
  const created = await send('post', '/secrets').send({ name: 'SECRET', value: 'line 1\nline 2' }).expect(201);
  const path = '/secrets/' + created.body.id;
  await send('put', path).send({ description: [] }).expect(400);
  const read = await send('get', path).expect('Cache-Control', 'no-store').expect(200);
  expect(read.body.value).toBe('line 1\nline 2');
  expect((await send('get', '/secrets')).body[0]).not.toHaveProperty('value');
});

test('blocks secret changes and forwarder dispatch in read-only mode', async () => {
  const previous = config.features.readOnly;
  config.features.readOnly = true;
  try {
    await send('post', '/secrets').send({ name: 'blocked', value: 'fixture' }).expect(403);
    await send('post', '/forwarders/1/test').expect(403);
    await send('put', '/forwarders/1').send({ enabled: false }).expect(403);
  } finally { config.features.readOnly = previous; }
});

test.each([
  { type: 'syslog', config: { host: 'localhost', port: 65536 } },
  { type: 'syslog', config: { host: 'localhost', protocol: 'https' } },
  { type: 'http', config: { url: 'file:///etc/passwd' } },
  { type: 'http', config: { url: 'https://logs.example.test', headers: { 'Content-Length': '9999' } } },
])('rejects invalid forwarder configurations', async fields => {
  await send('post', '/forwarders').send({ name: 'Invalid', ...fields }).expect(400);
});

test('tests a disabled Elasticsearch forwarder and detects bulk rejection behind HTTP 200', async () => {
  let path, body = '';
  const collector = http.createServer((req, res) => {
    path = req.url;
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ errors: true, items: [{ index: { status: 403, error: 'private-response' } }] }));
    });
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  try {
    const created = await send('post', '/forwarders').send({
      name: 'Fixture', type: 'elasticsearch', enabled: false,
      config: { url: 'http://127.0.0.1:' + collector.address().port + '/prefix/', index: 'test-logs' },
    }).expect(201);
    const route = '/forwarders/' + created.body.id;
    const saved = await send('get', route).expect('Cache-Control', 'no-store').expect(200);
    expect(saved.body.enabled).toBe(0);
    const result = await send('post', route + '/test').expect(502);
    expect(result.body.details).toMatchObject({ rejected: 1, itemStatuses: [403] });
    expect(JSON.stringify(result.body)).not.toContain('private-response');
    expect(path).toBe('/prefix/_bulk');
    expect(JSON.parse(body.split('\n')[0]).index._index).toBe('test-logs');
  } finally { await new Promise(resolve => collector.close(resolve)); }
});

test('tracks live delivery and recovery without storing collector content or counting manual tests', async () => {
  let status = 403;
  const collector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = status;
      res.end(status === 403 ? 'private-log-data secret-token' : undefined);
    });
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  try {
    const destination = { url: 'http://127.0.0.1:' + collector.address().port, headers: { Authorization: 'Bearer secret-token' } };
    const { body: { id } } = await send('post', '/forwarders')
      .send({ name: 'Live fixture', type: 'http', config: destination }).expect(201);
    const route = '/forwarders/' + id;
    const read = async () => (await send('get', '/forwarders').expect('Cache-Control', 'no-store').expect(200))
      .body.find(row => row.id === id);
    const until = async predicate => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const row = await read();
        if (predicate(row.delivery)) return row;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Delivery status did not update');
    };
    const empty = { lastSuccessAt: null, lastErrorAt: null, lastError: null };
    expect((await read()).delivery).toEqual(empty);
    await send('post', route + '/test').expect(502);
    expect((await read()).delivery).toEqual(empty);

    const batch = Array.from({ length: 100 }, () => ({
      containerId: 'fixture', containerName: 'fixture', line: 'private-log-data', timestamp: new Date().toISOString(),
    }));
    logForwarder.ingestLines(batch);
    const failed = await until(delivery => delivery.lastErrorAt);
    expect(failed.delivery.lastSuccessAt).toBeNull();
    expect(failed.delivery.lastError).toMatchObject({ httpStatus: 403, attempt: 1, batchSize: 100, reason: expect.any(String) });
    expect(JSON.stringify(failed)).not.toMatch(/private-log-data|secret-token|127\.0\.0\.1/);

    status = 204;
    await send('post', route + '/test').expect(200);
    expect((await read()).delivery).toEqual(failed.delivery);
    logForwarder.ingestLines(batch);
    const recovered = await until(delivery => delivery.lastSuccessAt);
    expect(Date.parse(recovered.delivery.lastSuccessAt)).toBeGreaterThan(Date.parse(failed.delivery.lastErrorAt));
    expect(recovered.delivery.lastError).toEqual(failed.delivery.lastError);

    await send('put', route).send({ name: 'Renamed', config: destination }).expect(200);
    await send('put', route).send({ enabled: false }).expect(200);
    expect((await read()).delivery).toEqual(recovered.delivery);
    await send('put', route).send({ config: { ...destination, url: destination.url + '/other' } }).expect(200);
    expect((await read()).delivery).toEqual(empty);
    await send('delete', route).expect(200);
  } finally {
    logForwarder.stopAll();
    await new Promise(resolve => collector.close(resolve));
  }
});
