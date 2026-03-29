'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer to base32 (RFC 4648)
 */
function toBase32(buffer) {
  let bits = '';
  let result = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5).padEnd(5, '0');
    result += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return result;
}

/**
 * Decode a base32 string to Buffer
 */
function fromBase32(str) {
  let bits = '';
  for (const c of str.toUpperCase().replace(/=+$/, '')) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generate a random 20-byte (160-bit) TOTP secret per RFC 4226
 * Returns base32-encoded string
 */
function generateSecret() {
  return toBase32(crypto.randomBytes(20));
}

/**
 * Generate a TOTP code for a given secret and counter
 * @param {Buffer} secretBuffer - The raw secret bytes
 * @param {number} counter - The time-based counter
 * @returns {string} 6-digit TOTP code
 */
function generateCode(secretBuffer, counter) {
  const buf = Buffer.alloc(8);
  // Write as big-endian 64-bit integer
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', secretBuffer).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return code.toString().padStart(6, '0');
}

/**
 * Generate a TOTP code for the current time
 * @param {string} secret - Base32-encoded secret
 * @param {number} [timeMs] - Time in milliseconds (defaults to now)
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP(secret, timeMs) {
  const secretBuffer = fromBase32(secret);
  const counter = Math.floor((timeMs || Date.now()) / 30000);
  return generateCode(secretBuffer, counter);
}

/**
 * Verify a TOTP code against a secret
 * Checks current time window +/- 1 step for clock skew tolerance
 * @param {string} secret - Base32-encoded secret
 * @param {string} code - 6-digit code to verify
 * @param {number} [window=1] - Number of time steps to check in each direction
 * @returns {boolean}
 */
function verifyTOTP(secret, code, window = 1) {
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) return false;

  const secretBuffer = fromBase32(secret);
  const counter = Math.floor(Date.now() / 30000);

  for (let i = -window; i <= window; i++) {
    const expected = generateCode(secretBuffer, counter + i);
    if (timingSafeEqual(expected, code)) return true;
  }
  return false;
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generate an otpauth:// URI for QR code generation
 * @param {string} secret - Base32-encoded secret
 * @param {string} username - Account name
 * @param {string} [issuer='Docker Dash'] - Issuer name
 * @returns {string}
 */
function generateOtpauthURI(secret, username, issuer = 'Docker Dash') {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedUser = encodeURIComponent(username);
  return `otpauth://totp/${encodedIssuer}:${encodedUser}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generate 10 random 8-character alphanumeric recovery codes
 * @returns {string[]}
 */
function generateRecoveryCodes() {
  const codes = [];
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) {
      code += chars[bytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

module.exports = {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  generateOtpauthURI,
  generateRecoveryCodes,
  toBase32,
  fromBase32,
};
