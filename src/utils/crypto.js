'use strict';

const crypto = require('crypto');
const config = require('../config');

// ─── Key Derivation ─────────────────────────────────────
// Derive a proper 256-bit key from the user's secret using scrypt KDF.
// The salt is fixed per-installation (derived from the secret itself)
// because we need deterministic keys for encrypt/decrypt round-trips.
// This is a significant improvement over the previous improvised padding.

let _derivedKey = null;

function _getKey() {
  if (_derivedKey) return _derivedKey;
  const secret = config.security.encryptionKey || config.app.secret || 'fallback-key';
  // Use scrypt to derive a proper 256-bit key
  // Salt is SHA-256 of the secret (deterministic per-installation)
  const salt = crypto.createHash('sha256').update('docker-dash-key-salt:' + secret).digest();
  _derivedKey = crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  return _derivedKey;
}

/** Generate cryptographically secure random token */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 hash */
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** AES-256-GCM encrypt */
function encrypt(plaintext) {
  const keyBuf = _getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/** AES-256-GCM decrypt */
function decrypt(ciphertext) {
  const keyBuf = _getKey();
  const [ivHex, tagHex, data] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/** HMAC-SHA256 for webhook signing */
function hmacSign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

module.exports = { generateToken, sha256, encrypt, decrypt, hmacSign };
