'use strict';

const { timingSafeEqual } = require('node:crypto');

function normalizeFingerprint(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) throw Object.assign(new Error('SSH hostKeySha256 is required. Obtain the server fingerprint through a trusted console or verified connection.'), { statusCode: 400 });
  if (/^[a-f0-9]{64}$/i.test(input)) return input.toLowerCase();
  const match = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(input);
  if (match) {
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length === 32 && bytes.toString('base64').replace(/=+$/, '') === match[1]) return bytes.toString('hex');
  }
  throw Object.assign(new Error('SSH hostKeySha256 must be a SHA-256 64-character hex digest or an OpenSSH SHA256: fingerprint'), { statusCode: 400 });
}

function hostKeyOptions(config) {
  const expected = Buffer.from(normalizeFingerprint(config?.hostKeySha256), 'hex');
  return {
    hostHash: 'sha256',
    hostVerifier(hash) {
      return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)
        && timingSafeEqual(expected, Buffer.from(hash, 'hex'));
    },
  };
}

module.exports = { normalizeFingerprint, hostKeyOptions };
