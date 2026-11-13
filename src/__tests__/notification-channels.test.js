'use strict';

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'notification-channel-test-key';

jest.mock('../services/email', () => ({ send: jest.fn().mockResolvedValue({ ok: true }) }));

const { getDb, closeDb } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const channels = require('../services/notificationChannels');
const email = require('../services/email');

beforeAll(() => {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
});

beforeEach(() => {
  getDb().prepare('DELETE FROM notification_channels').run();
  email.send.mockClear();
});

afterAll(closeDb);
afterEach(() => jest.restoreAllMocks());

test('accepts formatted SMTP recipients and rejects invalid addresses and provider URLs', () => {
  expect(() => channels.create({ name: 'Email', provider: 'email',
    config: { to: ['Ops <ops@example.test>', 'second@example.test'] }, created_by: 1 })).not.toThrow();
  expect(() => channels.create({ name: 'Email', provider: 'email',
    config: { to: 'invalid-address' }, created_by: 1 })).toThrow('valid recipient');
  expect(() => channels.create({ name: 'Hook', provider: 'webhook',
    config: { url: 'https://user:secret@example.test' }, created_by: 1 })).toThrow('without embedded credentials');
});

test.each([undefined, {}, { to: '   ' }])('rejects an email channel without a recipient (%j)', config => {
  expect(() => channels.create({ name: 'Email', provider: 'email', config, created_by: 1 }))
    .toThrow('Recipient Email is required');
  expect(channels.list()).toHaveLength(0);
});

test('rejects an incomplete update and tests the original configured recipient', async () => {
  const { id } = channels.create({
    name: 'Email', provider: 'email', config: { to: 'ops@example.test' }, created_by: 1,
  });
  expect(() => channels.update(id, { config: {} })).toThrow('Recipient Email is required');
  await channels.test(id);
  expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.test' }));
});

test('restricts general broadcasts and targeted notifications while accepting scheduled reports and manual tests', async () => {
  const createEmail = (name, usage) => channels.create({ name, usage, provider: 'email', created_by: 1,
    config: { to: `${name}@example.test` } }).id;
  const scheduled = createEmail('scheduled', 'scheduled_scans');
  const message = { text: 'Container stopped' };
  expect(channels.hasGeneralChannels()).toBe(false);
  await require('../services/eventNotifier').processEvent({ type: 'container', action: 'stop', actorId: 'fixture-channel-stop' });
  await channels.sendToAll(message);
  expect(await channels.send(scheduled, message)).toBe(false);
  expect(email.send).not.toHaveBeenCalled();

  const general = createEmail('ops', 'general');
  const legacy = createEmail('legacy');
  const inactive = createEmail('inactive', 'all');
  channels.update(inactive, { is_active: false });
  expect(channels.hasGeneralChannels()).toBe(true);
  expect(channels.get(legacy).usage).toBe('all');
  await channels.sendToAll(message);
  expect(email.send.mock.calls.map(([mail]) => mail.to).sort()).toEqual(['legacy@example.test', 'ops@example.test']);

  email.send.mockClear();
  const report = { text: 'Security report for the scheduled scan' };
  await expect(channels.send(general, report, { usage: 'scheduled_scans', diagnostics: true })).rejects.toMatchObject({ status: 400 });
  await expect(channels.send(scheduled, report, { usage: 'scheduled_scans', diagnostics: true })).resolves.toBe(true);
  await channels.test(scheduled);
  expect(email.send.mock.calls.map(([mail]) => mail.to)).toEqual(['scheduled@example.test', 'scheduled@example.test']);

  const secret = channels.get(legacy).config_encrypted;
  channels.update(legacy, { usage: 'scheduled_scans' });
  expect(channels.get(legacy).config_encrypted).toBe(secret);
  expect(channels.list().find(channel => channel.id === legacy).usage).toBe('scheduled_scans');
  expect(() => channels.update(legacy, { usage: null })).toThrow('Invalid notification channel usage');
  expect(() => createEmail('unknown', 'other')).toThrow('Invalid notification channel usage');
});

test('blocks email attachments from reaching a webhook provider', async () => {
  const { id } = channels.create({ name: 'Hook', provider: 'webhook', config: { url: 'https://hooks.example.test/object' }, created_by: 1 });
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new global.Response('', { status: 200 }));
  await expect(channels.send(id, { text: 'Scan report', emailAttachments: [{ filename: 'report.html', content: 'fixture' }] },
    { usage: 'scheduled_scans' })).rejects.toThrow('Attachments require an email notification channel');
  expect(fetch).not.toHaveBeenCalled();
});

test('reports the missing recipient for a legacy channel before calling SMTP', async () => {
  const { lastInsertRowid } = getDb().prepare(`
    INSERT INTO notification_channels (name, provider, config_encrypted, created_by)
    VALUES ('Legacy email', 'email', ?, 1)
  `).run(encrypt('{}'));
  expect(channels.get(lastInsertRowid).usage).toBe('all');
  await expect(channels.test(lastInsertRowid)).rejects.toThrow('Recipient Email is required');
  expect(email.send).not.toHaveBeenCalled();
});

test('repairs a legacy email channel without replacing its ID', async () => {
  const { lastInsertRowid: id } = getDb().prepare(`
    INSERT INTO notification_channels (name, provider, config_encrypted, created_by)
    VALUES ('Legacy email', 'email', ?, 1)
  `).run(encrypt('{}'));
  channels.update(id, { name: 'Operations', configPatch: { to: 'ops@example.test' } });
  expect(channels.list()).toMatchObject([{ id, name: 'Operations', config: { to: 'ops@example.test' } }]);
  await channels.test(id);
  expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.test' }));
});

test('editing preserves saved credentials without returning them', () => {
  const original = { topic: 'alerts', token: 'private-ntfy-token' };
  const { id } = channels.create({ name: 'Alerts', provider: 'ntfy', config: original, created_by: 1 });
  const [listed] = channels.list();
  expect(listed.config).toEqual({ topic: 'alerts' });
  expect(listed.configuredSecrets).toEqual(['token']);
  expect(listed).not.toHaveProperty('config_encrypted');
  channels.update(id, { configPatch: { topic: 'operations' } });
  expect(JSON.parse(decrypt(channels.get(id).config_encrypted))).toEqual({ ...original, topic: 'operations' });
  channels.update(id, { configPatch: { token: null } });
  expect(JSON.parse(decrypt(channels.get(id).config_encrypted))).toEqual({ topic: 'operations' });
});

test.each([['discord', 'webhook_url'], ['webhook', 'url']])('does not disclose the saved %s URL', (provider, key) => {
  channels.create({ name: 'Team', provider, config: { [key]: 'https://hook.example.test/secret-token' }, created_by: 1 });
  expect(channels.list()[0]).toMatchObject({ config: {}, configuredSecrets: [key] });
  expect(JSON.stringify(channels.list())).not.toContain('secret-token');
});

test('includes only a redacted provider error excerpt on explicit tests', async () => {
  const url = 'https://hooks.example.test/api/path-secret?token=query-secret';
  const { id } = channels.create({ name: 'Hook', provider: 'webhook', config: { url }, created_by: 1 });
  jest.spyOn(global, 'fetch').mockImplementation(async () => new global.Response(JSON.stringify({
    message: 'Endpoint rejected the test path-secret query-secret ' + url,
    data: 'arbitrary response field',
  }), { status: 403, headers: { 'content-type': 'application/json' } }));
  const failure = await channels.test(id).catch(error => error);
  expect(failure.details).toMatchObject({ httpStatus: 403, response: expect.stringContaining('Endpoint rejected the test') });
  expect(JSON.stringify(failure.details)).not.toMatch(/path-secret|query-secret|hooks\.example\.test|arbitrary response/);
  const background = await channels.send(id, { text: 'Live message' }).catch(error => error);
  expect(background.message).toBe('HTTP 403');
  expect(background).not.toHaveProperty('details');
});

test.each([
  ['text/html', '<html>Raw server page</html>'],
  ['text/plain', 'a'.repeat(4097)],
])('keeps the status of unreadable or oversized %s failures', async (type, body) => {
  const { id } = channels.create({ name: 'Ntfy', provider: 'ntfy', config: { topic: 'alerts' }, created_by: 1 });
  jest.spyOn(global, 'fetch').mockResolvedValue(new global.Response(body, { status: 429, headers: { 'content-type': type } }));
  await expect(channels.test(id)).rejects.toMatchObject({ details: { httpStatus: 429, response: undefined, responseOmitted: true } });
});

test('reports Retry-After and masks short webhook tokens and encoded credentials', async () => {
  const url = 'https://hooks.example.test/abc?token=other-secret';
  const { id } = channels.create({ name: 'Hook', provider: 'webhook', config: { url }, created_by: 1 });
  jest.spyOn(global, 'fetch').mockResolvedValue(new global.Response(
    'Quota exhausted for abc ' + Buffer.from('other-secret').toString('base64url'), {
      status: 429, headers: { 'content-type': 'text/plain', 'retry-after': '42' },
    },
  ));
  await expect(channels.test(id)).rejects.toMatchObject({
    details: { httpStatus: 429, retryAfterSeconds: 42, response: 'Quota exhausted for [redacted] [redacted]' },
  });
});

test('rejects duplicate tests until the current attempt completes', async () => {
  const { id } = channels.create({ name: 'Email', provider: 'email', config: { to: 'ops@example.test' }, created_by: 1 });
  let finish;
  email.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = channels.test(id);
  await expect(channels.test(id)).rejects.toMatchObject({ details: { code: 'TEST_IN_PROGRESS' } });
  expect(email.send).toHaveBeenCalledTimes(1);
  finish({ ok: true });
  await pending;
  await channels.test(id);
  expect(email.send).toHaveBeenCalledTimes(2);
});

test('reports connection refusal and distinguishes inactive channels from successful sends', async () => {
  const { id } = channels.create({ name: 'Hook', provider: 'webhook', config: { url: 'https://hooks.example.test' }, created_by: 1 });
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed', {
    cause: new AggregateError([Object.assign(new Error('private path'), { code: 'ECONNREFUSED' })]),
  }));
  await expect(channels.test(id)).rejects.toMatchObject({
    details: { code: 'ECONNREFUSED', reason: 'The provider refused the connection.' },
  });
  channels.update(id, { is_active: false });
  await expect(channels.test(id)).rejects.toThrow('This notification channel is inactive');
  expect(fetch).toHaveBeenCalledTimes(1);
});
