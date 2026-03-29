'use strict';

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';

const { generateSecret, generateTOTP, verifyTOTP, generateOtpauthURI, generateRecoveryCodes, toBase32, fromBase32 } = require('../utils/totp');

describe('TOTP Utils', () => {
  describe('base32 encoding', () => {
    it('should round-trip encode and decode', () => {
      const original = Buffer.from('Hello!');
      const encoded = toBase32(original);
      const decoded = fromBase32(encoded);
      expect(decoded.toString()).toBe('Hello!');
    });

    it('should produce valid base32 characters', () => {
      const encoded = toBase32(Buffer.from('test'));
      expect(encoded).toMatch(/^[A-Z2-7]+$/);
    });
  });

  describe('generateSecret', () => {
    it('should generate a base32-encoded secret', () => {
      const secret = generateSecret();
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      expect(secret.length).toBeGreaterThan(20); // 20 bytes = 32 base32 chars
    });

    it('should generate unique secrets', () => {
      const secrets = new Set(Array.from({ length: 10 }, () => generateSecret()));
      expect(secrets.size).toBe(10);
    });
  });

  describe('generateTOTP', () => {
    it('should generate a 6-digit code', () => {
      const secret = generateSecret();
      const code = generateTOTP(secret);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('should generate the same code for the same time', () => {
      const secret = generateSecret();
      const time = 1600000000000; // fixed timestamp
      const code1 = generateTOTP(secret, time);
      const code2 = generateTOTP(secret, time);
      expect(code1).toBe(code2);
    });

    it('should generate different codes for different time windows', () => {
      const secret = generateSecret();
      const code1 = generateTOTP(secret, 1600000000000);
      const code2 = generateTOTP(secret, 1600000060000); // 60s later = different window
      expect(code1).not.toBe(code2);
    });
  });

  describe('verifyTOTP', () => {
    it('should verify a valid code', () => {
      const secret = generateSecret();
      const code = generateTOTP(secret);
      expect(verifyTOTP(secret, code)).toBe(true);
    });

    it('should reject an invalid code', () => {
      const secret = generateSecret();
      expect(verifyTOTP(secret, '000000')).toBe(false);
    });

    it('should reject codes that are not 6 digits', () => {
      const secret = generateSecret();
      expect(verifyTOTP(secret, '12345')).toBe(false);
      expect(verifyTOTP(secret, '1234567')).toBe(false);
      expect(verifyTOTP(secret, 'abcdef')).toBe(false);
      expect(verifyTOTP(secret, '')).toBe(false);
      expect(verifyTOTP(secret, null)).toBe(false);
    });

    it('should accept code within time window tolerance', () => {
      const secret = generateSecret();
      // Generate code for current time
      const code = generateTOTP(secret, Date.now());
      // Should still verify (within window=1)
      expect(verifyTOTP(secret, code, 1)).toBe(true);
    });
  });

  describe('generateOtpauthURI', () => {
    it('should return a valid otpauth URI', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const uri = generateOtpauthURI(secret, 'admin');
      expect(uri).toBe('otpauth://totp/Docker%20Dash:admin?secret=JBSWY3DPEHPK3PXP&issuer=Docker%20Dash&algorithm=SHA1&digits=6&period=30');
    });

    it('should handle special characters in username', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const uri = generateOtpauthURI(secret, 'user@example.com');
      expect(uri).toContain('user%40example.com');
    });
  });

  describe('generateRecoveryCodes', () => {
    it('should generate 10 codes', () => {
      const codes = generateRecoveryCodes();
      expect(codes.length).toBe(10);
    });

    it('should generate 8-character lowercase alphanumeric codes', () => {
      const codes = generateRecoveryCodes();
      for (const code of codes) {
        expect(code.length).toBe(8);
        expect(code).toMatch(/^[a-z0-9]+$/);
      }
    });

    it('should generate unique codes', () => {
      const codes = generateRecoveryCodes();
      const unique = new Set(codes);
      expect(unique.size).toBe(10);
    });
  });
});
