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
    expect(result.body.details.rejected).toBe(1);
    expect(JSON.stringify(result.body)).not.toContain('private-response');
    expect(path).toBe('/prefix/_bulk');
    expect(JSON.parse(body.split('\n')[0]).index._index).toBe('test-logs');
  } finally { await new Promise(resolve => collector.close(resolve)); }
});
