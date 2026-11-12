'use strict';

// Service-layer tests for src/services/webhooks.js — post-v8.2.x audit gap closure.
//
// Why this file exists:
//   webhooks-endpoints.test.js covers the route layer end-to-end via supertest,
//   but does NOT exercise the service singleton's outbound-delivery state machine,
//   HMAC signing, retry policy, or delivery-log persistence. Those are the bits
//   that actually leak secrets / drop events / loop forever if they regress —
//   so the service layer needs its own coverage independent of HTTP routing.
//
// Boundary notes:
//   - DB lives in-memory (DB_PATH=':memory:') and migrations 005_webhooks.js
//     runs automatically on getDb() — same path as production.
//   - global.fetch is replaced per-test with a controllable mock so no real
//     network is touched (Node 18+ runtime fetch is what the service uses).
//   - jest fake timers are used to drive the retry backoff without sleeping
//     in real time (delivery uses setTimeout(attempt * 5000, ...)).

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

jest.resetModules();

const crypto = require('crypto');
const { setImmediate: nextTurn } = require('node:timers');
const flushDelivery = () => new Promise(nextTurn);

describe('webhooks service — service layer (v8.2.x audit)', () => {
  let db;
  let webhooks;
  let originalFetch;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
    // Seed a placeholder admin so FK on webhooks.created_by is satisfied for
    // the test that exercises the created_by code path.
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`
    ).run();
    webhooks = require('../services/webhooks');
    originalFetch = global.fetch;
  });

  afterAll(() => {
    // Drain anything the dispatch state machine queued so we don't trigger
    // post-teardown logger writes / require() of migration modules.
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
    global.fetch = originalFetch;
    const { closeDb } = require('../db');
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM webhook_deliveries').run();
    db.prepare('DELETE FROM webhooks').run();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    // The service schedules retries via setTimeout for any failure. Clear
    // them so they don't fire in a later test (or after teardown) and cause
    // unrelated DB writes / "import after teardown" noise.
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ── helpers ───────────────────────────────────────────────────────────

  /** Build a fetch-Response-like object the service's await resp.text() expects. */
  function fakeResponse({ status = 200, body = 'ok' } = {}) {
    return new global.Response(body, { status });
  }

  /** Read the latest delivery row for a webhook (most recent first). */
  function latestDelivery(hookId) {
    return db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1'
    ).get(hookId);
  }

  /** Force the service's queued setTimeout retries to drain to completion. */
  async function drainRetries(maxIterations = 10) {
    // Each retry schedules another setTimeout, so we loop:
    //   advance fake timers → flush microtasks (await fetch) → repeat.
    for (let i = 0; i < maxIterations; i++) {
      // Drain pending micro-tasks before advancing timers.
      await flushDelivery();
      jest.runOnlyPendingTimers();
      await flushDelivery();
    }
  }

  it('tests only the requested hook and reports a blocked redirect without retaining the response', async () => {
    const { id } = webhooks.create({ name: 'selected', url: 'https://example.test/hook?token=hidden-value' });
    webhooks.create({ name: 'unrelated', url: 'https://example.test/unrelated' });
    global.fetch.mockResolvedValueOnce(new global.Response('x'.repeat(5000), {
      status: 307, headers: { Location: 'http://127.0.0.1/private' },
    }));
    await expect(webhooks.test(id)).resolves.toMatchObject({ ok: false, status: 307 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].redirect).toBe('manual');
    expect(latestDelivery(id).response_body).toBe('');
    expect(JSON.stringify(webhooks.get(id))).not.toContain('hidden-value');
  });

  it('cancels pending delivery after its destination is changed or disabled', async () => {
    jest.useFakeTimers();
    const { id } = webhooks.create({ name: 'revoked', url: 'https://example.test/original' });
    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 503 }));
    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    webhooks.update(id, { url: 'https://example.test/new', is_active: false });
    await drainRetries();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['ftp://example.test/hook', 'https://user:pass@example.test/hook', 'https://example.test/hook#fragment'])
  ('rejects an invalid delivery destination %s', url => {
    expect(() => webhooks.create({ name: 'invalid', url })).toThrow('Webhook destination');
  });

  it('migrates existing webhook credentials without changing the delivery target', () => {
    const Database = require('better-sqlite3');
    const legacy = new Database(':memory:');
    try {
      legacy.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
      require('../db/migrations/005_webhooks').up(legacy);
      const url = 'https://example.test/old?token=legacy-value';
      const headers = JSON.stringify({ Authorization: 'Bearer private-value' });
      legacy.prepare("INSERT INTO webhooks (name,url,headers,secret) VALUES ('legacy',?,?,?)").run(url, headers, 'signing-key');
      legacy.transaction(() => require('../db/migrations/191_encrypt_webhook_destinations').up(legacy))();
      const row = legacy.prepare('SELECT * FROM webhooks').get();
      expect(row).toMatchObject({ url: '', headers: '{}', secret: null });
      expect(JSON.parse(require('../utils/crypto').decrypt(row.delivery_config_enc))).toEqual({ url, headers, secret: 'signing-key' });
    } finally { legacy.close(); }
  });

  // ── 1. CREATE ─────────────────────────────────────────────────────────

  it('1. create() persists a webhook and returns the new id', () => {
    const { id } = webhooks.create({
      name: 'hook-create',
      url: 'https://example.test/hook',
      events: ['container.start'],
      secret: 'shh',
      created_by: 1,
    });
    expect(id).toBeGreaterThan(0);

    const row = webhooks.get(id);
    expect(row.name).toBe('hook-create');
    expect(row.url).toBe('https://example.test');
    expect(row.method).toBe('POST'); // default
    expect(row.is_active).toBe(1);
    expect(JSON.parse(row.events)).toEqual(['container.start']);
  });

  // ── 2. CREATE — secret is stored on row & used for HMAC ───────────────

  it('2. create() stores the HMAC secret used to sign outbound payloads', () => {
    const { id } = webhooks.create({
      name: 'hook-secret',
      url: 'https://example.test/hook',
      secret: 'super-shared-secret',
    });
    const row = webhooks.get(id);
    expect(row.hasSecret).toBe(true);
    expect(row.secret).toBeUndefined();
    const stored = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    expect(stored).toMatchObject({ url: '', headers: '{}', secret: null });
    expect(stored.delivery_config_enc).not.toContain('super-shared-secret');
    expect(JSON.parse(require('../utils/crypto').decrypt(stored.delivery_config_enc))).toMatchObject({
      url: 'https://example.test/hook', secret: 'super-shared-secret',
    });
  });

  // ── 3. UPDATE — idempotent ────────────────────────────────────────────

  it('3. update() is idempotent — applying the same partial update twice is a no-op', () => {
    const { id } = webhooks.create({ name: 'orig', url: 'https://example.test/x' });

    webhooks.update(id, { name: 'renamed', is_active: false });
    const after1 = webhooks.get(id);
    expect(after1.name).toBe('renamed');
    expect(after1.is_active).toBe(0);

    webhooks.update(id, { name: 'renamed', is_active: false });
    const after2 = webhooks.get(id);
    expect(after2.name).toBe('renamed');
    expect(after2.is_active).toBe(0);
    // Total row count unchanged — update never duplicates.
    const count = db.prepare('SELECT COUNT(*) AS c FROM webhooks').get().c;
    expect(count).toBe(1);
  });

  // ── 4. DELETE cascades webhook_deliveries ────────────────────────────

  it('4. delete() cascades to webhook_deliveries (no orphan rows)', () => {
    const { id } = webhooks.create({ name: 'cascade', url: 'https://example.test/x' });
    db.prepare(
      'INSERT INTO webhook_deliveries (webhook_id, event, payload, response_code, attempts, success) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, 'container.start', '{}', 200, 1, 1);
    db.prepare(
      'INSERT INTO webhook_deliveries (webhook_id, event, payload, response_code, attempts, success) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, 'container.stop', '{}', 500, 3, 0);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE webhook_id = ?').get(id).c
    ).toBe(2);

    webhooks.delete(id);

    expect(webhooks.get(id)).toBeUndefined();
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE webhook_id = ?').get(id).c
    ).toBe(0);
  });

  // ── 5. LIST returns rows ordered by name ─────────────────────────────

  it('5. list() returns all webhooks ordered by name', () => {
    webhooks.create({ name: 'zeta',  url: 'https://example.test/z' });
    webhooks.create({ name: 'alpha', url: 'https://example.test/a' });
    webhooks.create({ name: 'mike',  url: 'https://example.test/m' });

    const rows = webhooks.list();
    expect(rows.map(r => r.name)).toEqual(['alpha', 'mike', 'zeta']);
  });

  // ── 6. HMAC outbound signature header is set when secret present ─────

  it('6. dispatch() signs outbound body with HMAC-SHA256 in X-Signature-256 header', async () => {
    const { id } = webhooks.create({
      name: 'sign',
      url: 'https://example.test/h',
      secret: 'mysecret',
      events: ['*'],
    });

    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', { foo: 'bar' });
    // dispatch fires-and-forgets; let the microtask queue drain.
    await flushDelivery();
    await flushDelivery();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://example.test/h');

    expect(init.headers['X-Signature-256']).toBeTruthy();
    expect(init.headers['X-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Recompute HMAC of the actual body with the actual secret — must match.
    const expectedHex = crypto.createHmac('sha256', 'mysecret').update(init.body).digest('hex');
    expect(init.headers['X-Signature-256']).toBe('sha256=' + expectedHex);

    // Loose await to let the post-fetch DB write settle.
    await flushDelivery();
    expect(latestDelivery(id)).toBeTruthy();
  });

  // ── 7. HMAC verification (round-trip) ────────────────────────────────

  it('7. HMAC signature is verifiable end-to-end (sign → verify with same secret)', async () => {
    const { id } = webhooks.create({
      name: 'verify',
      url: 'https://example.test/h',
      secret: 'verify-me',
      events: ['*'],
    });

    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', { ok: true });
    await flushDelivery();
    await flushDelivery();

    const [, init] = global.fetch.mock.calls[0];
    const sigHeader = init.headers['X-Signature-256'];
    const sigHex = sigHeader.replace(/^sha256=/, '');

    // Receiver-side verification using timingSafeEqual (the contract a real
    // consumer would implement).
    const recomputed = crypto.createHmac('sha256', 'verify-me').update(init.body).digest('hex');
    const a = Buffer.from(sigHex, 'hex');
    const b = Buffer.from(recomputed, 'hex');
    expect(a.length).toBe(b.length);
    expect(crypto.timingSafeEqual(a, b)).toBe(true);

    // A bad secret must NOT verify.
    const bad = crypto.createHmac('sha256', 'wrong-secret').update(init.body).digest('hex');
    expect(crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(bad, 'hex'))).toBe(false);

    expect(id).toBeGreaterThan(0); // sanity guard against unused-var lint warning
  });

  // ── 8. Outbound headers (Content-Type + UA + custom merge) ───────────

  it('8. outbound POST sends Content-Type=application/json, User-Agent, and merges custom headers', async () => {
    webhooks.create({
      name: 'headers',
      url: 'https://example.test/h',
      headers: { 'X-Custom': 'abc', 'X-Env': 'test' },
      events: ['*'],
    });

    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    await flushDelivery();

    const [, init] = global.fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/^DockerDash\//);
    expect(init.headers['X-Custom']).toBe('abc');
    expect(init.headers['X-Env']).toBe('test');
  });

  // ── 9. Retry on 5xx ──────────────────────────────────────────────────

  it('9. retries delivery on 5xx response (then succeeds on 2nd attempt)', async () => {
    jest.useFakeTimers();

    const { id } = webhooks.create({
      name: 'retry-5xx',
      url: 'https://example.test/h',
      events: ['*'],
    });

    global.fetch
      .mockResolvedValueOnce(fakeResponse({ status: 503, body: 'unavailable' }))
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: 'ok' }));

    await webhooks.dispatch('container.start', {});
    await drainRetries(5);

    expect(global.fetch).toHaveBeenCalledTimes(2);

    // Two delivery rows: attempt=1 failure, attempt=2 success.
    const rows = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id ASC'
    ).all(id);
    expect(rows).toHaveLength(2);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].success).toBe(0);
    expect(rows[0].response_code).toBe(503);
    expect(rows[1].attempts).toBe(2);
    expect(rows[1].success).toBe(1);
    expect(rows[1].response_code).toBe(200);
  });

  // ── 10. Gives up after N retries ─────────────────────────────────────

  it('10. gives up after 3 attempts and persists the final failure', async () => {
    jest.useFakeTimers();

    const { id } = webhooks.create({
      name: 'retry-exhaust',
      url: 'https://example.test/h',
      events: ['*'],
    });

    global.fetch
      .mockResolvedValueOnce(fakeResponse({ status: 500, body: 'boom' }))
      .mockResolvedValueOnce(fakeResponse({ status: 502, body: 'bad gateway' }))
      .mockResolvedValueOnce(fakeResponse({ status: 504, body: 'timeout' }));

    await webhooks.dispatch('container.start', {});
    await drainRetries(8);

    // Exactly 3 attempts — no 4th retry scheduled.
    expect(global.fetch).toHaveBeenCalledTimes(3);

    const rows = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id ASC'
    ).all(id);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.success === 0)).toBe(true);
    expect(rows.map(r => r.attempts)).toEqual([1, 2, 3]);
    expect(rows.map(r => r.response_code)).toEqual([500, 502, 504]);
  });

  // ── 11. Timeout via AbortController ──────────────────────────────────

  it('11. respects request timeout — aborted fetch is recorded as failure with error', async () => {
    jest.useFakeTimers();

    const { id } = webhooks.create({
      name: 'timeout',
      url: 'https://example.test/slow',
      events: ['*'],
    });

    // Simulate fetch rejecting because the AbortController.signal fired.
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    global.fetch.mockImplementation(async (_url, init) => {
      // Confirm the service really did pass an AbortSignal — that's the
      // mechanism it uses to enforce the 10s timeout.
      expect(init.signal).toBeDefined();
      expect(typeof init.signal.aborted).toBe('boolean');
      throw abortErr;
    });

    await webhooks.dispatch('container.start', {});
    // Service catches the error, writes the row, then schedules a retry —
    // we only care about the FIRST recorded delivery here.
    await flushDelivery();
    await flushDelivery();
    await flushDelivery();

    const row = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id ASC LIMIT 1'
    ).get(id);
    expect(row).toBeTruthy();
    expect(row.success).toBe(0);
    expect(row.response_code).toBe(0);
    expect(row.error).toMatch(/timed out/i);
  });

  // ── 12. Delivery log persistence — success path ──────────────────────

  it('12. persists a successful delivery row with response code, body, and attempt count', async () => {
    const { id } = webhooks.create({
      name: 'log-success',
      url: 'https://example.test/h',
      events: ['*'],
    });

    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 201, body: 'created' }));
    await webhooks.dispatch('container.start', { hello: 'world' });
    await flushDelivery();
    await flushDelivery();

    const row = latestDelivery(id);
    expect(row).toBeTruthy();
    expect(row.success).toBe(1);
    expect(row.response_code).toBe(201);
    expect(row.response_body).toBe('created');
    expect(row.attempts).toBe(1);
    expect(row.error).toBeNull();
    expect(row.event).toBe('container.start');

    // Payload column should be the JSON body that was sent.
    const parsed = JSON.parse(row.payload);
    expect(parsed.event).toBe('container.start');
    expect(parsed.data).toEqual({ hello: 'world' });
    expect(parsed.timestamp).toBeTruthy();
  });

  // ── 13. Replay protection — body includes a timestamp ────────────────

  it('13. signed body includes a timestamp (replay protection — sigs vary across calls)', async () => {
    const realNow = Date;
    const { id } = webhooks.create({
      name: 'replay',
      url: 'https://example.test/h',
      secret: 'replay-secret',
      events: ['*'],
    });

    // First call — frozen at T1.
    global.Date = class extends realNow {
      constructor() { super(); return new realNow('2026-01-01T00:00:00Z'); }
      static now() { return new realNow('2026-01-01T00:00:00Z').getTime(); }
    };
    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', { x: 1 });
    await flushDelivery();
    await flushDelivery();

    // Second call — frozen at T2 (one minute later).
    global.Date = class extends realNow {
      constructor() { super(); return new realNow('2026-01-01T00:01:00Z'); }
      static now() { return new realNow('2026-01-01T00:01:00Z').getTime(); }
    };
    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', { x: 1 });
    await flushDelivery();
    await flushDelivery();

    global.Date = realNow;

    const calls = global.fetch.mock.calls;
    expect(calls).toHaveLength(2);

    const body1 = JSON.parse(calls[0][1].body);
    const body2 = JSON.parse(calls[1][1].body);
    expect(body1.timestamp).toBeTruthy();
    expect(body2.timestamp).toBeTruthy();
    expect(body1.timestamp).not.toBe(body2.timestamp);

    // Same payload + different timestamps → different signatures (replay-safe).
    expect(calls[0][1].headers['X-Signature-256']).not.toBe(
      calls[1][1].headers['X-Signature-256']
    );

    expect(id).toBeGreaterThan(0);
  });

  // ── 14. Disabled webhook is NOT delivered (enable/disable toggle) ────

  it('14. dispatch() skips inactive webhooks; toggling is_active re-enables delivery', async () => {
    const { id } = webhooks.create({
      name: 'toggle',
      url: 'https://example.test/h',
      events: ['*'],
      is_active: false,
    });

    global.fetch.mockResolvedValue(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    await flushDelivery();
    expect(global.fetch).not.toHaveBeenCalled();

    // Re-enable via update — row remains, NOT a delete + recreate.
    webhooks.update(id, { is_active: true });
    expect(webhooks.get(id).is_active).toBe(1);

    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    await flushDelivery();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // ── 15. Event-type filtering — only matching events fire ─────────────

  it('15. dispatch() only fires hooks whose events list matches (or is "*")', async () => {
    const wildcard = webhooks.create({
      name: 'wildcard',
      url: 'https://example.test/wild',
      events: ['*'],
    }).id;
    const specific = webhooks.create({
      name: 'specific',
      url: 'https://example.test/specific',
      events: ['container.start'],
    }).id;
    const other = webhooks.create({
      name: 'other',
      url: 'https://example.test/other',
      events: ['image.pulled'],
    }).id;

    global.fetch.mockResolvedValue(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    await flushDelivery();

    const calls = global.fetch.mock.calls.map(c => c[0]);
    expect(calls).toContain('https://example.test/wild');
    expect(calls).toContain('https://example.test/specific');
    expect(calls).not.toContain('https://example.test/other');

    expect(wildcard).toBeGreaterThan(0);
    expect(specific).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
  });

  // ── 16. Delivery log persistence — failure path ──────────────────────

  it('16. persists a failed delivery with error message when fetch rejects', async () => {
    jest.useFakeTimers();

    const { id } = webhooks.create({
      name: 'log-fail',
      url: 'https://example.test/h',
      events: ['*'],
    });

    global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:443'));
    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    await flushDelivery();
    await flushDelivery();

    const row = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id ASC LIMIT 1'
    ).get(id);
    expect(row).toBeTruthy();
    expect(row.success).toBe(0);
    expect(row.response_code).toBe(0);
    expect(row.error).toBe('Webhook request failed');
  });

  // ── 17. getDeliveries pagination ─────────────────────────────────────

  it('17. getDeliveries() returns rows for a hook ordered most-recent first', () => {
    const { id } = webhooks.create({ name: 'pag', url: 'https://example.test/h' });

    // Seed 5 delivery rows with explicit ascending timestamps.
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO webhook_deliveries
          (webhook_id, event, payload, response_code, attempts, success, delivered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        'container.start',
        JSON.stringify({ i }),
        200,
        1,
        1,
        // strictly ordered timestamps so DESC ordering is unambiguous
        `2026-05-05 10:00:0${i}`
      );
    }

    const page1 = webhooks.getDeliveries(id, { page: 1, limit: 2 });
    expect(page1).toHaveLength(2);
    // Most-recent first.
    expect(JSON.parse(page1[0].payload).i).toBe(4);
    expect(JSON.parse(page1[1].payload).i).toBe(3);

    const page2 = webhooks.getDeliveries(id, { page: 2, limit: 2 });
    expect(page2).toHaveLength(2);
    expect(JSON.parse(page2[0].payload).i).toBe(2);
    expect(JSON.parse(page2[1].payload).i).toBe(1);

    const page3 = webhooks.getDeliveries(id, { page: 3, limit: 2 });
    expect(page3).toHaveLength(1);
    expect(JSON.parse(page3[0].payload).i).toBe(0);
  });

  // ── 18. Malformed events JSON fails closed ─────────────────────────

  it('18. malformed events JSON cannot subscribe to every event', async () => {
    // Insert a webhook with deliberately corrupt events column.
    const r = db.prepare(`
      INSERT INTO webhooks (name, url, method, headers, secret, events, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('corrupt', 'https://example.test/h', 'POST', '{}', null, '{not-json', 1);
    const id = r.lastInsertRowid;

    global.fetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));
    await webhooks.dispatch('container.start', {});
    await flushDelivery();
    await flushDelivery();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(latestDelivery(id)).toBeUndefined();
  });
});
