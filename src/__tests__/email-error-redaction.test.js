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
  expect(JSON.stringify(log.error.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('secret-token-in-code');
});
