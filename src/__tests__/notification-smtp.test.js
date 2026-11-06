'use strict';

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'notification-smtp-fixture-key';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const mailer = require('nodemailer');
const { getDb, closeDb } = require('../db');
const { smtp: serverSmtp } = require('../config');
const channels = require('../services/notificationChannels');
const smtp = require('../services/notification-smtp');
const email = require('../services/email');
const settings = require('../services/settings');

const external = {
  mode: 'external', host: 'smtp.example.test', port: 587, security: 'starttls',
  user: 'alerts@example.test', password: 'smtp-fixture-password',
  fromEmail: 'alerts@example.test', fromName: 'Docker Alerts',
};

beforeAll(() => {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
});

beforeEach(() => {
  settings.delete(smtp.KEY);
  getDb().prepare('DELETE FROM notification_channels').run();
  email._transporter = null;
  mailer.createTransport.mockReset().mockImplementation(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-fixture' }),
  }));
});

afterAll(closeDb);

test('external SMTP applies to channel tests while account email uses server SMTP', async () => {
  const response = smtp.save(external, 1);
  expect(response.external.passwordConfigured).toBe(true);
  expect(JSON.stringify(response)).not.toContain(external.password);
  expect(settings.get(smtp.KEY)).not.toContain(external.password);
  const { id } = channels.create({ name: 'Alert email', provider: 'email', config: { to: 'ops@example.test' }, created_by: 1 });
  await channels.test(id);
  expect(mailer.createTransport).toHaveBeenNthCalledWith(1, expect.objectContaining({
    host: external.host, port: 587, secure: false, requireTLS: true,
    auth: { user: external.user, pass: external.password }, tls: { rejectUnauthorized: true },
  }));
  expect(mailer.createTransport.mock.results[0].value.sendMail).toHaveBeenCalledWith(expect.objectContaining({
    to: 'ops@example.test', from: { name: external.fromName, address: external.fromEmail },
  }));
  await email.sendPasswordReset({ to: 'account@example.test', username: 'account', resetUrl: 'https://dashboard.example.test/reset' });
  expect(mailer.createTransport).toHaveBeenNthCalledWith(2, expect.objectContaining({ host: serverSmtp.host }));
});

test('preserves the external credential on the same account and restores server mode', () => {
  smtp.save({ ...external, port: 465, security: 'tls' }, 1);
  smtp.save({ ...external, port: 465, security: 'tls', password: '', fromName: 'Renamed' }, 1);
  expect(smtp.transport()).toMatchObject({ password: external.password, secure: true, requireTLS: false });
  expect(() => smtp.save({ ...external, host: 'other.example.test', password: '' }, 1)).toThrow('Enter the password');
  expect(smtp.transport().host).toBe(external.host);
  expect(smtp.save({ mode: 'server' }, 1).mode).toBe('server');
  expect(smtp.transport()).toBeUndefined();
  expect(smtp.publicSettings().external.passwordConfigured).toBe(true);
});

test.each([{ security: 'plain' }, { host: 'smtp://user:password@example.test' }, { port: 65536 }])(
  'rejects invalid external SMTP settings (%j)', fields => {
    expect(() => smtp.save({ ...external, ...fields }, 1)).toThrow();
    expect(smtp.transport()).toBeUndefined();
  },
);
