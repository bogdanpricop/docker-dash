'use strict';

// 📚 WHY: Crypto functions protect Git credentials, SSH keys, notification tokens.
// If encrypt/decrypt breaks, users lose access to all their integrations.
// If hmacSign breaks, webhook validation fails (security hole or false rejections).

// Need to set config before requiring crypto
process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';

const { encrypt, decrypt, generateToken, sha256, hmacSign } = require('../utils/crypto');

describe('encrypt / decrypt', () => {
  // 📚 HAPPY PATH: round-trip — encrypt then decrypt should return original
  it('should round-trip encrypt and decrypt', () => {
    const plaintext = 'ghp_mySecretGitHubToken123456';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  // 📚 FORMAT: encrypted output should be iv:tag:ciphertext
  it('should produce iv:tag:ciphertext format', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    expect(parts[0].length).toBe(24); // 12-byte IV = 24 hex chars
    expect(parts[1].length).toBe(32); // 16-byte auth tag = 32 hex chars
    expect(parts[2].length).toBeGreaterThan(0);
  });

  // 📚 SECURITY: same plaintext should produce different ciphertext (random IV)
  it('should produce different ciphertext for same plaintext', () => {
    const a = encrypt('same-text');
    const b = encrypt('same-text');
    expect(a).not.toBe(b);
    // But both should decrypt to the same thing
    expect(decrypt(a)).toBe(decrypt(b));
  });

  // 📚 EDGE: empty string
  it('should handle empty string', () => {
    const encrypted = encrypt('');
    expect(decrypt(encrypted)).toBe('');
  });

  // 📚 EDGE: unicode content (SSH keys contain special chars)
  it('should handle unicode and special characters', () => {
    const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nbase64content+/=\n-----END OPENSSH PRIVATE KEY-----';
    const encrypted = encrypt(text);
    expect(decrypt(encrypted)).toBe(text);
  });

  // 📚 SECURITY: tampered ciphertext should fail to decrypt
  it('should throw on tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    const parts = encrypted.split(':');
    parts[2] = 'ff' + parts[2].substring(2); // tamper with ciphertext
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
});

describe('generateToken', () => {
  it('should generate hex string of correct length', () => {
    const token = generateToken(32);
    expect(token.length).toBe(64); // 32 bytes = 64 hex chars
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  // 📚 SECURITY: tokens must be unique
  it('should generate unique tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken(16)));
    expect(tokens.size).toBe(100); // all unique
  });
});

describe('sha256', () => {
  it('should produce consistent hashes', () => {
    const hash = sha256('test');
    expect(hash).toBe(sha256('test'));
    expect(hash.length).toBe(64);
  });

  it('should produce different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('hmacSign', () => {
  // 📚 WHY: HMAC is used for webhook signature validation.
  // Wrong implementation = webhooks rejected or faked.
  it('should produce consistent HMAC for same input+secret', () => {
    const sig = hmacSign('payload', 'secret');
    expect(sig).toBe(hmacSign('payload', 'secret'));
    expect(sig.length).toBe(64); // SHA-256 = 64 hex chars
  });

  it('should produce different HMAC for different secrets', () => {
    expect(hmacSign('payload', 'secret1')).not.toBe(hmacSign('payload', 'secret2'));
  });

  it('should produce different HMAC for different payloads', () => {
    expect(hmacSign('payload1', 'secret')).not.toBe(hmacSign('payload2', 'secret'));
  });
});
