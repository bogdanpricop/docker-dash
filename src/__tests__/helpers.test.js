'use strict';

const { sanitizeShellArg, safeParseInt, safeJsonParse, sanitizeId, formatBytes, tryParseJson, now } = require('../utils/helpers');

// 📚 WHY: Utility functions are pure (input → output, no side effects).
// They're the easiest to test and the most reliable tests.
// A bug in sanitizeShellArg = command injection vulnerability.

describe('sanitizeShellArg', () => {
  // 📚 HAPPY PATH: normal strings should pass through unchanged
  it('should preserve normal strings', () => {
    expect(sanitizeShellArg('hello')).toBe('hello');
    expect(sanitizeShellArg('/opt/my-app')).toBe('/opt/my-app');
    expect(sanitizeShellArg('my-container_v2')).toBe('my-container_v2');
  });

  // 📚 SECURITY: these are the characters that enable shell injection
  it('should strip shell metacharacters', () => {
    expect(sanitizeShellArg('hello; rm -rf /')).toBe('hello rm -rf /');
    expect(sanitizeShellArg('test && echo pwned')).toBe('test  echo pwned');
    expect(sanitizeShellArg('$(whoami)')).toBe('whoami');
    expect(sanitizeShellArg('`id`')).toBe('id');
    expect(sanitizeShellArg('a|b')).toBe('ab');
  });

  // 📚 EDGE CASES: null, undefined, empty
  it('should handle null/undefined/empty', () => {
    expect(sanitizeShellArg(null)).toBe('');
    expect(sanitizeShellArg(undefined)).toBe('');
    expect(sanitizeShellArg('')).toBe('');
  });

  // 📚 REAL ATTACK: Docker label injection attempt
  it('should neutralize Docker label injection', () => {
    const malicious = '"; rm -rf / #';
    const result = sanitizeShellArg(malicious);
    expect(result).not.toContain(';');
    expect(result).not.toContain('"');
  });
});

describe('safeParseInt', () => {
  it('should parse valid integers', () => {
    expect(safeParseInt('42')).toBe(42);
    expect(safeParseInt('0')).toBe(0);
    expect(safeParseInt('-1')).toBe(-1);
  });

  // 📚 WHY: parseInt('abc') returns NaN which breaks DB queries silently
  it('should return null for non-numeric input', () => {
    expect(safeParseInt('abc')).toBeNull();
    expect(safeParseInt('')).toBeNull();
    expect(safeParseInt(undefined)).toBeNull();
    expect(safeParseInt(null)).toBeNull();
    expect(safeParseInt('12.5abc')).toBe(12); // parseInt behavior — parses leading digits
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  // 📚 WHY: JSON.parse on corrupted DB data crashes the entire endpoint
  it('should return fallback for invalid JSON', () => {
    expect(safeJsonParse('not json', [])).toEqual([]);
    expect(safeJsonParse(undefined, {})).toEqual({});
    expect(safeJsonParse('', null)).toBeNull();
  });
});

describe('tryParseJson', () => {
  it('should parse valid JSON', () => {
    expect(tryParseJson('{"x":1}')).toEqual({ x: 1 });
  });

  it('should return fallback for invalid JSON', () => {
    expect(tryParseJson('bad', 'default')).toBe('default');
    expect(tryParseJson(null)).toBeNull();
  });
});

describe('sanitizeId', () => {
  it('should keep valid hex container IDs', () => {
    expect(sanitizeId('abc123def456')).toBe('abc123def456');
  });

  it('should strip non-hex characters', () => {
    expect(sanitizeId('abc; rm -rf /')).toBe('abcf');
  });

  it('should truncate to 64 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeId(long).length).toBe(64);
  });

  it('should return null for invalid input', () => {
    expect(sanitizeId(null)).toBeNull();
    expect(sanitizeId('')).toBeNull();
    expect(sanitizeId(123)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('should format bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('should handle null/undefined', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});

describe('now', () => {
  it('should return ISO-like datetime string', () => {
    const result = now();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
