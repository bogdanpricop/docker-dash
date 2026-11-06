'use strict';
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../utils/logger', () => { const logger = { info: jest.fn(), error: jest.fn() }; return () => logger; });
const mailer = require('nodemailer'), email = require('../services/email'), log = require('../utils/logger')();

test.each(['EAUTH', 'secret-token-in-code'])('SMTP errors are redacted before logging and propagation (%s)', async code => {
  const secret = 'private-reset-token-in-message';
  const raw = Object.assign(new Error('SMTP response contains ' + secret), { code, response: secret });
  email._transporter = null;
  mailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockRejectedValue(raw) });
  let result;
  try { await email.send({ to: 'fixture@example.test', subject: 'Reset', html: secret }); } catch (error) { result = error; }
  expect(result.message).toBe('Email delivery failed');
  expect(result.code).toBe(code === 'EAUTH' ? 'EAUTH' : 'SEND_FAILED');
  expect(result).not.toHaveProperty('response');
  expect(result).not.toHaveProperty('cause');
  expect(result).not.toHaveProperty('details');
  expect(JSON.stringify(log.error.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('secret-token-in-code');
});

test('a test send returns the SMTP reply after redacting credentials and addresses', async () => {
  const smtp = { host: 'smtp.example.test', port: 25, user: 'fixture-user', password: 'fixture-password' };
  const raw = Object.assign(new Error('Raw message must stay private'), {
    code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550,
    response: '550 5.7.1 Relay access denied for <ops@example.test> fixture-user fixture-password',
  });
  mailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockRejectedValue(raw) });
  const error = await email.send({ smtp, to: 'ops@example.test', diagnostics: true }).catch(error => error);
  expect(error.details).toMatchObject({
    code: 'EENVELOPE', command: 'RCPT TO', smtpStatus: 550, smtpEnhancedStatus: '5.7.1',
    response: expect.stringContaining('Relay access denied'),
  });
  expect(JSON.stringify(error.details)).not.toMatch(/ops@example\.test|fixture-user|fixture-password|Raw message/);
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('Relay access denied');
});

test.each([
  [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, response: '535 5.7.8 raw auth response' },
    { code: 'EAUTH', command: 'AUTH', smtpStatus: 535, smtpEnhancedStatus: '5.7.8' }],
  [{ code: 'ESOCKET', originalCode: 'ECONNREFUSED', command: 'CONN' }, { code: 'ECONNREFUSED', command: 'CONN' }],
])('exposes diagnostic codes without raw auth or socket text', async (fields, expected) => {
  const smtp = { host: 'smtp.example.test', port: 25 };
  mailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('raw data'), fields)) });
  const error = await email.send({ smtp, to: 'ops@example.test', diagnostics: true }).catch(error => error);
  expect(error.details).toMatchObject(expected);
  expect(error.details.response).toBeUndefined();
});
