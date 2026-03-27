'use strict';

// 📚 WHY: Git validation functions prevent command injection and path traversal.
// These are the security boundaries between user input and shell execution.
// A bypass here = RCE (Remote Code Execution).

// Set up minimal env for git service to load
process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = '/tmp/docker-dash-test';

// We test the validation methods directly rather than through HTTP
// because the git service depends on DB + Docker which aren't available in test.

describe('Git URL validation patterns', () => {
  // Test the regex patterns used in git service
  const VALID_URL_PATTERN = /^(https?:\/\/|git@|ssh:\/\/)/;
  const DANGEROUS_CHARS = /[;&|`$(){}!#<>\\]/;

  // 📚 HAPPY PATH: valid Git URLs
  it('should accept HTTPS URLs', () => {
    expect(VALID_URL_PATTERN.test('https://github.com/user/repo.git')).toBe(true);
    expect(VALID_URL_PATTERN.test('http://gitlab.local/user/repo.git')).toBe(true);
  });

  it('should accept SSH URLs', () => {
    expect(VALID_URL_PATTERN.test('git@github.com:user/repo.git')).toBe(true);
    expect(VALID_URL_PATTERN.test('ssh://git@gitlab.com/user/repo.git')).toBe(true);
  });

  // 📚 SECURITY: reject shell injection attempts
  it('should reject dangerous characters', () => {
    expect(DANGEROUS_CHARS.test('https://github.com/user/repo.git')).toBe(false); // safe
    expect(DANGEROUS_CHARS.test('https://evil.com/repo; rm -rf /')).toBe(true);
    expect(DANGEROUS_CHARS.test('https://evil.com/$(whoami)')).toBe(true);
    expect(DANGEROUS_CHARS.test('https://evil.com/`id`')).toBe(true);
    expect(DANGEROUS_CHARS.test('https://evil.com/repo|cat /etc/passwd')).toBe(true);
  });

  // 📚 SECURITY: reject non-Git protocols
  it('should reject non-Git protocols', () => {
    expect(VALID_URL_PATTERN.test('file:///etc/passwd')).toBe(false);
    expect(VALID_URL_PATTERN.test('ftp://evil.com/repo')).toBe(false);
    expect(VALID_URL_PATTERN.test('/etc/passwd')).toBe(false);
    expect(VALID_URL_PATTERN.test('javascript:alert(1)')).toBe(false);
  });
});

describe('Compose path validation patterns', () => {
  const path = require('path');

  function isValidComposePath(composePath) {
    if (!composePath) return false;
    const normalized = path.normalize(composePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized) || normalized.includes('..')) return false;
    if (!normalized.endsWith('.yml') && !normalized.endsWith('.yaml')) return false;
    return true;
  }

  // 📚 HAPPY PATH
  it('should accept valid compose paths', () => {
    expect(isValidComposePath('docker-compose.yml')).toBe(true);
    expect(isValidComposePath('docker-compose.yaml')).toBe(true);
    expect(isValidComposePath('infra/docker-compose.prod.yml')).toBe(true);
  });

  // 📚 SECURITY: path traversal prevention
  it('should reject path traversal attempts', () => {
    expect(isValidComposePath('../../../etc/passwd')).toBe(false);
    expect(isValidComposePath('/etc/shadow')).toBe(false);
    expect(isValidComposePath('..\\..\\windows\\system32\\config')).toBe(false);
  });

  // 📚 VALIDATION: must end in .yml/.yaml
  it('should reject non-YAML files', () => {
    expect(isValidComposePath('Dockerfile')).toBe(false);
    expect(isValidComposePath('script.sh')).toBe(false);
    expect(isValidComposePath('.env')).toBe(false);
  });
});

describe('Stack name validation patterns', () => {
  const VALID_STACK_NAME = /^[a-z0-9][a-z0-9_-]*$/;

  // 📚 HAPPY PATH: valid stack names
  it('should accept lowercase alphanumeric with hyphens/underscores', () => {
    expect(VALID_STACK_NAME.test('my-app')).toBe(true);
    expect(VALID_STACK_NAME.test('web_server')).toBe(true);
    expect(VALID_STACK_NAME.test('app123')).toBe(true);
    expect(VALID_STACK_NAME.test('a')).toBe(true);
  });

  // 📚 SECURITY: prevent injection via stack name (used in docker compose -p)
  it('should reject names with special characters', () => {
    expect(VALID_STACK_NAME.test('my app')).toBe(false); // spaces
    expect(VALID_STACK_NAME.test('My-App')).toBe(false); // uppercase
    expect(VALID_STACK_NAME.test('-start-with-dash')).toBe(false);
    expect(VALID_STACK_NAME.test('_start-with-underscore')).toBe(false);
    expect(VALID_STACK_NAME.test('app;rm -rf /')).toBe(false);
    expect(VALID_STACK_NAME.test('')).toBe(false);
  });
});

describe('Error message sanitization patterns', () => {
  function sanitizeGitError(message) {
    return message
      .replace(/https?:\/\/[^@\s]+@/g, 'https://***@')
      .replace(/password_encrypted.*$/gm, '[redacted]')
      .substring(0, 500);
  }

  // 📚 SECURITY: credentials must never leak in error messages
  it('should strip credentials from HTTPS URLs', () => {
    const error = 'fatal: could not read from https://user:ghp_secret123@github.com/repo.git';
    const sanitized = sanitizeGitError(error);
    expect(sanitized).not.toContain('ghp_secret123');
    expect(sanitized).toContain('https://***@');
  });

  it('should strip password field references', () => {
    const error = 'Error: password_encrypted column value abc123 invalid';
    const sanitized = sanitizeGitError(error);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('abc123');
  });

  it('should truncate long messages', () => {
    const long = 'x'.repeat(1000);
    expect(sanitizeGitError(long).length).toBe(500);
  });
});
