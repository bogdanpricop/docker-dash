'use strict';

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'notification-channel-test-key';

jest.mock('../services/email', () => ({ send: jest.fn().mockResolvedValue({ ok: true }) }));

const { getDb, closeDb } = require('../db');
const { encrypt } = require('../utils/crypto');
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

test('reports the missing recipient for a legacy channel before calling SMTP', async () => {
  const { lastInsertRowid } = getDb().prepare(`
    INSERT INTO notification_channels (name, provider, config_encrypted, created_by)
    VALUES ('Legacy email', 'email', ?, 1)
  `).run(encrypt('{}'));
  await expect(channels.test(lastInsertRowid)).rejects.toThrow('Recipient Email is required');
  expect(email.send).not.toHaveBeenCalled();
});
