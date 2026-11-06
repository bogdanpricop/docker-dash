'use strict';

// v8.96.0 — Diagnostic Sessions end to end, against a real SQLite database with
// synthetic rows in the tables a session reads. Nothing is mocked below the
// service, because the thing worth proving is that a session correlates the data
// that actually exists rather than data a mock agreed to return.

process.env.APP_SECRET = 'test-secret-for-diagnostics-routes';
process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'DiagRouteTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json());
app.use(cookieParser());

const { getDb } = require('../db');
const db = getDb();

const authService = require('../services/auth');
authService.seedAdmin();

app.use('/api/auth', require('../routes/auth'));
app.use('/api/diagnostics', require('../routes/diagnostics'));

let token = null;
const auth = () => ({ Authorization: `Bearer ${token}` });

const FROM = '2026-08-11T00:00:00.000Z';
const TO = '2026-08-11T00:30:00.000Z';
const at = (min) => new Date(Date.parse(FROM) + min * 60000).toISOString();

beforeAll(async () => {
  require('./helpers/seedTestAdmin').clearMustChange('admin');
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'DiagRouteTest123!' });
  token = res.body.token;
  if (!token) throw new Error('login failed for diagnostics route tests');

  // Container metrics inside the window, with a deliberate gap between minutes
  // 3 and 20 and a counter reset at minute 21.
  const ins = db.prepare(`INSERT INTO container_stats
    (host_id, container_id, container_name, cpu_percent, mem_usage, mem_limit, net_rx, net_tx, blk_read, blk_write, pids, recorded_at)
    VALUES (0,?,?,?,?,?,?,?,0,0,1,?)`);
  ins.run('web-123', 'web', 10, 100, 1000, 1000, 10, at(1));
  ins.run('web-123', 'web', 20, 200, 1000, 2000, 20, at(2));
  ins.run('web-123', 'web', 30, 300, 1000, 3000, 30, at(3));
  ins.run('web-123', 'web', 40, 400, 1000, 50, 5, at(21));   // counter reset

  db.prepare(`INSERT INTO docker_events (host_id, event_type, action, actor_id, actor_name, attributes, event_time)
    VALUES (0,'container','restart','web-123','web-123','{}',?)`).run(at(20));
  db.prepare(`INSERT INTO health_events (host_id, container_id, container_name, status, output, exit_code, recorded_at)
    VALUES (0,'web-123','web','unhealthy','',1,?)`).run(at(20));
});

const createSession = (over = {}) => request(app).post('/api/diagnostics/sessions').set(auth()).send({
  name: 'Incident 14:32', from: FROM, to: TO,
  subjects: [{ type: 'container', ref: 'web-123', hostId: 0, displayName: 'web' }],
  ...over,
});

describe('sessions — lifecycle', () => {
  it('requires auth', async () => {
    expect((await request(app).get('/api/diagnostics/sessions')).status).toBe(401);
  });

  it('creates a session storing only its definition', async () => {
    const res = await createSession();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Incident 14:32', window_start: FROM, window_end: TO });
    expect(res.body.subjects).toHaveLength(1);
    expect(res.body.uuid).toMatch(/^[0-9a-f-]{36}$/);
    // No sample table exists to copy into — the point of retrospective mode.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'diagnostic%'").all();
    expect(tables.map(t => t.name).sort()).toEqual(['diagnostic_session_subjects', 'diagnostic_sessions']);
  });

  it('lists sessions with their subject count', async () => {
    const res = await request(app).get('/api/diagnostics/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].subject_count).toBe(1);
  });

  it('deletes a session and its subjects', async () => {
    const id = (await createSession({ name: 'to delete' })).body.id;
    expect((await request(app).delete(`/api/diagnostics/sessions/${id}`).set(auth())).status).toBe(200);
    expect((await request(app).get(`/api/diagnostics/sessions/${id}`).set(auth())).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) n FROM diagnostic_session_subjects WHERE session_id = ?').get(id).n).toBe(0);
  });
});

describe('sessions — validation', () => {
  it('rejects a window shorter than a minute', async () => {
    const res = await createSession({ to: new Date(Date.parse(FROM) + 5000).toISOString() });
    expect(res.status).toBe(400);
  });

  it('rejects an inverted window', async () => {
    expect((await createSession({ from: TO, to: FROM })).status).toBe(400);
  });

  it('rejects a window longer than 30 days', async () => {
    expect((await createSession({ to: '2026-10-01T00:00:00.000Z' })).status).toBe(400);
  });

  it('rejects more than 25 subjects', async () => {
    const subjects = Array.from({ length: 26 }, (_, i) => ({ type: 'container', ref: `c${i}` }));
    expect((await createSession({ subjects })).status).toBe(400);
  });

  it('rejects an unknown subject type', async () => {
    expect((await createSession({ subjects: [{ type: 'toaster', ref: 'x' }] })).status).toBe(400);
  });

  it('rejects an empty subject list', async () => {
    expect((await createSession({ subjects: [] })).status).toBe(400);
  });
});

describe('timeline — the correlated view', () => {
  let id;
  beforeAll(async () => { id = (await createSession({ name: 'timeline' })).body.id; });

  const timeline = (qs = '') => request(app).get(`/api/diagnostics/sessions/${id}/timeline${qs}`).set(auth());

  it('puts every series on one shared axis', async () => {
    const res = await timeline('?buckets=60');
    expect(res.status).toBe(200);
    expect(res.body.buckets).toBe(60);
    const cpu = res.body.series[0].metrics.find(m => m.key === 'cpu');
    const mem = res.body.series[0].metrics.find(m => m.key === 'mem');
    expect(cpu.points).toHaveLength(60);
    expect(cpu.points.map(p => p.t)).toEqual(mem.points.map(p => p.t));
  });

  it('names the resolution it used rather than leaving it implied', async () => {
    expect((await timeline()).body.resolution).toBe('raw');   // 30-minute window
  });

  it('renders the recorded gap as gaps, not zeros', async () => {
    const cpu = (await timeline('?buckets=30')).body.series[0].metrics.find(m => m.key === 'cpu');
    const empty = cpu.points.filter(p => p.v === null).length;
    expect(empty).toBeGreaterThan(20);            // minutes 4-20 had no samples
    expect(cpu.points.some(p => p.v === 0)).toBe(false);
  });

  it('breaks the cumulative counter at the reset instead of spiking negative', async () => {
    const rx = (await timeline('?buckets=30')).body.series[0].metrics.find(m => m.key === 'net_rx');
    expect(rx.cumulative).toBe(true);
    expect(rx.points.every(p => p.v === null || p.v >= 0)).toBe(true);
  });

  it('marks events, health transitions and audit entries on the axis', async () => {
    const sources = new Set((await timeline()).body.annotations.map(a => a.source));
    expect(sources.has('docker_event')).toBe(true);
    expect(sources.has('health')).toBe(true);
  });

  it('never puts a client IP in an annotation', async () => {
    const body = JSON.stringify((await timeline()).body.annotations);
    expect(body).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  it('reports clock skew rather than correcting it', async () => {
    const res = await timeline();
    expect(typeof res.body.clockSkewMs).toBe('number');
    expect(res.body).toHaveProperty('clockSkewWarning');
  });

  it('says a VM subject has no telemetry rather than drawing an empty chart', async () => {
    const vm = (await createSession({
      name: 'vm', subjects: [{ type: 'vm', ref: 'vm-100', providerHostId: 1, displayName: 'db-vm' }],
    })).body;
    const res = await request(app).get(`/api/diagnostics/sessions/${vm.id}/timeline`).set(auth());
    expect(res.body.series[0]).toMatchObject({ type: 'vm', hasData: false });
  });

  it('404s for a session that does not exist', async () => {
    expect((await request(app).get('/api/diagnostics/sessions/999999/timeline').set(auth())).status).toBe(404);
  });
});

describe('export', () => {
  it('returns the timeline with a stamp, and audits the fact', async () => {
    const id = (await createSession({ name: 'export me' })).body.id;
    const res = await request(app).get(`/api/diagnostics/sessions/${id}/export`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.exportedAt).toBeTruthy();
    expect(res.body.series).toBeDefined();

    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'diagnostic_session_export' ORDER BY id DESC LIMIT 1").get();
    expect(row).toBeTruthy();
    expect(row.target_id).toBe(String(id));
  });

  it('audits creation with counts, not the subject list', async () => {
    await createSession({ name: 'audited' });
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'diagnostic_session_create' ORDER BY id DESC LIMIT 1").get();
    const details = JSON.parse(row.details);
    expect(details).toMatchObject({ subjects: 1, from: FROM, to: TO });
    expect(JSON.stringify(details)).not.toContain('web-123');
  });
});
