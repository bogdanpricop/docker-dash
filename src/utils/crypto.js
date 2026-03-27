'use strict';

const crypto = require('crypto');
const config = require('../config');

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
  const key = Buffer.from(config.security.encryptionKey || config.app.secret, 'utf8')
    .subarray(0, 32)
    .toString('hex')
    .padEnd(64, '0');
  const keyBuf = Buffer.from(key.substring(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/** AES-256-GCM decrypt */
function decrypt(ciphertext) {
  const key = Buffer.from(config.security.encryptionKey || config.app.secret, 'utf8')
    .subarray(0, 32)
    .toString('hex')
    .padEnd(64, '0');
  const keyBuf = Buffer.from(key.substring(0, 64), 'hex');
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
