'use strict';

process.env.APP_SECRET = 'outbound-tls-test-secret';
process.env.ENCRYPTION_KEY = 'outbound-tls-encryption-key';
process.env.DB_PATH = ':memory:';

const { EventEmitter } = require('events');
const https = require('https');
const { encrypt } = require('../utils/crypto');

afterEach(() => jest.restoreAllMocks());

function rejectUntrustedCertificate() {
  return jest.spyOn(https, 'request').mockImplementation((url, options) => {
    const opts = typeof url === 'object' && !(url instanceof URL) ? url : options;
    expect(opts.rejectUnauthorized).toBe(true);
    const req = new EventEmitter();
    req.write = jest.fn();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    req.end = () => process.nextTick(() => req.emit('error', new Error('self-signed certificate')));
    return req;
  });
}

test('SMTP validates certificates and cannot resolve message content from local files or URLs', () => {
  const email = require('../services/email');
  const opts = email._getTransporter().options;
  expect(opts.tls.rejectUnauthorized).toBe(true);
  expect(opts.disableFileAccess).toBe(true);
  expect(opts.disableUrlAccess).toBe(true);
});

test('Copilot fails closed for an untrusted HTTPS endpoint', async () => {
  rejectUntrustedCertificate();
  await expect(require('../services/copilot/llm').chat({
    config: { baseUrl: 'https://llm.example.test/v1', apiKey: 'secret' }, messages: [],
  })).rejects.toThrow('self-signed certificate');
});

test('registry requests fail closed for an untrusted HTTPS endpoint', async () => {
  rejectUntrustedCertificate();
  await expect(require('../services/registry')._apiCall({ url: 'https://registry.example.test' }, '/v2/'))
    .rejects.toThrow('self-signed certificate');
});

test('HTTPS log forwarding fails closed for an untrusted collector', async () => {
  rejectUntrustedCertificate();
  await expect(require('../services/log-forwarder').testForwarder({
    type: 'loki', config_json_encrypted: encrypt(JSON.stringify({ url: 'https://logs.example.test' })),
  })).rejects.toThrow('self-signed certificate');
});
