'use strict';

// 📚 WHY: GitOps drift detection (v8.3.0) tells operators when a git-managed
// stack's running state diverges from the git-checked-out compose. It's
// READ-ONLY — a false "in sync" hides real drift, a false "drifted" cries wolf.
// The pure detectDrift + normalizeImage + parseComposeServices core must be
// exactly right; this suite pins it.

process.env.APP_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const { normalizeImage, parseComposeServices, detectDrift } = require('../services/git-drift');

describe('normalizeImage', () => {
  it('expands a bare name to docker.io/library/name:latest', () => {
    expect(normalizeImage('nginx')).toBe('docker.io/library/nginx:latest');
  });
  it('keeps an explicit tag', () => {
    expect(normalizeImage('nginx:1.25')).toBe('docker.io/library/nginx:1.25');
  });
  it('treats bare name == fully-qualified latest', () => {
    expect(normalizeImage('nginx')).toBe(normalizeImage('docker.io/library/nginx:latest'));
  });
  it('different tags are not equal', () => {
    expect(normalizeImage('nginx:1.25')).not.toBe(normalizeImage('nginx:1.26'));
  });
  it('preserves a custom registry host', () => {
    expect(normalizeImage('ghcr.io/foo/bar')).toBe('ghcr.io/foo/bar:latest');
  });
  it('preserves a registry with port', () => {
    expect(normalizeImage('localhost:5000/myapp:v1')).toBe('localhost:5000/myapp:v1');
  });
  it('strips a digest and compares by repo (no tag → latest)', () => {
    expect(normalizeImage('nginx@sha256:abc')).toBe('docker.io/library/nginx:latest');
  });
  it('handles empty / non-string input', () => {
    expect(normalizeImage('')).toBe('');
    expect(normalizeImage(null)).toBe('');
    expect(normalizeImage(undefined)).toBe('');
  });
});

describe('parseComposeServices', () => {
  it('extracts image + container_name per service', () => {
    const yaml = 'services:\n  web:\n    image: nginx:1.25\n    container_name: my-web\n  db:\n    image: postgres:16\n';
    const out = parseComposeServices(yaml);
    expect(out.web).toEqual({ image: 'nginx:1.25', container_name: 'my-web', hasBuild: false });
    expect(out.db.image).toBe('postgres:16');
  });
  it('flags build-only services', () => {
    const yaml = 'services:\n  app:\n    build: .\n';
    const out = parseComposeServices(yaml);
    expect(out.app.hasBuild).toBe(true);
    expect(out.app.image).toBe(null);
  });
  it('returns empty object for compose with no services', () => {
    expect(parseComposeServices('version: "3"\n')).toEqual({});
  });
  it('throws on malformed YAML (caller catches)', () => {
    expect(() => parseComposeServices('services:\n  web:\n  - bad: : :\n  indent')).toThrow();
  });
});

describe('detectDrift', () => {
  it('reports inSync when every service matches a running container with same image', () => {
    const desired = { web: { image: 'nginx:1.25', hasBuild: false }, db: { image: 'postgres:16', hasBuild: false } };
    const actual = [
      { name: 'web-1', service: 'web', image: 'nginx:1.25', state: 'running' },
      { name: 'db-1', service: 'db', image: 'postgres:16', state: 'running' },
    ];
    const r = detectDrift(desired, actual);
    expect(r.inSync).toBe(true);
    expect(r.drifts).toHaveLength(0);
    expect(r.checkedAt).toBeTruthy();
  });

  it('detects a missing service (declared, no container)', () => {
    const desired = { web: { image: 'nginx', hasBuild: false }, db: { image: 'postgres', hasBuild: false } };
    const actual = [{ name: 'web-1', service: 'web', image: 'nginx', state: 'running' }];
    const r = detectDrift(desired, actual);
    expect(r.inSync).toBe(false);
    expect(r.drifts).toContainEqual({ type: 'missing', service: 'db', expected: 'postgres' });
  });

  it('detects an extra container (running, not declared)', () => {
    const desired = { web: { image: 'nginx', hasBuild: false } };
    const actual = [
      { name: 'web-1', service: 'web', image: 'nginx', state: 'running' },
      { name: 'rogue-1', service: 'rogue', image: 'redis', state: 'running' },
    ];
    const r = detectDrift(desired, actual);
    expect(r.drifts).toContainEqual({ type: 'extra', service: 'rogue', container: 'rogue-1' });
  });

  it('detects a stopped container', () => {
    const desired = { web: { image: 'nginx', hasBuild: false } };
    const actual = [{ name: 'web-1', service: 'web', image: 'nginx', state: 'exited' }];
    const r = detectDrift(desired, actual);
    expect(r.drifts).toContainEqual({ type: 'stopped', service: 'web', container: 'web-1', state: 'exited' });
  });

  it('detects an image mismatch', () => {
    const desired = { web: { image: 'nginx:1.25', hasBuild: false } };
    const actual = [{ name: 'web-1', service: 'web', image: 'nginx:1.26', state: 'running' }];
    const r = detectDrift(desired, actual);
    expect(r.drifts).toContainEqual({ type: 'image_mismatch', service: 'web', expected: 'nginx:1.25', actual: 'nginx:1.26' });
  });

  it('does NOT flag image mismatch for build-only services', () => {
    const desired = { app: { image: null, hasBuild: true } };
    const actual = [{ name: 'app-1', service: 'app', image: 'myproject-app:latest', state: 'running' }];
    const r = detectDrift(desired, actual);
    expect(r.inSync).toBe(true);
  });

  it('treats bare image == fully-qualified latest (no false mismatch)', () => {
    const desired = { web: { image: 'nginx', hasBuild: false } };
    const actual = [{ name: 'web-1', service: 'web', image: 'docker.io/library/nginx:latest', state: 'running' }];
    const r = detectDrift(desired, actual);
    expect(r.inSync).toBe(true);
  });

  it('reports multiple simultaneous drifts', () => {
    const desired = { web: { image: 'nginx:1.25', hasBuild: false }, db: { image: 'postgres:16', hasBuild: false } };
    const actual = [
      { name: 'web-1', service: 'web', image: 'nginx:1.26', state: 'running' }, // image_mismatch
      { name: 'extra-1', service: 'cache', image: 'redis', state: 'running' },  // extra
      // db missing
    ];
    const r = detectDrift(desired, actual);
    const types = r.drifts.map(d => d.type).sort();
    expect(types).toEqual(['extra', 'image_mismatch', 'missing']);
  });

  it('handles empty compose gracefully (no services declared)', () => {
    const r = detectDrift({}, [{ name: 'x', service: 'x', image: 'y', state: 'running' }]);
    // an undeclared running container under the project IS extra
    expect(r.drifts).toContainEqual({ type: 'extra', service: 'x', container: 'x' });
  });

  it('ignores containers with no compose.service label', () => {
    const desired = { web: { image: 'nginx', hasBuild: false } };
    const actual = [
      { name: 'web-1', service: 'web', image: 'nginx', state: 'running' },
      { name: 'manual-1', service: null, image: 'busybox', state: 'running' }, // no service label
    ];
    const r = detectDrift(desired, actual);
    expect(r.inSync).toBe(true); // null-service container is not counted as extra
  });
});
