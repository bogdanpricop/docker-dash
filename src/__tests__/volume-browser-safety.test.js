'use strict';

// v8.9.9-alpha.1 — Portainer G07 closure tests: path traversal safety.

const { _safePath } = require('../services/volume-browser');

describe('volume-browser _safePath (v8.9.9-alpha.1)', () => {
  it('resolves root path', () => {
    expect(_safePath('/')).toBe('/data');
  });
  it('resolves a normal path', () => {
    expect(_safePath('/config')).toBe('/data/config');
  });
  it('normalizes trailing slash', () => {
    expect(_safePath('/config/')).toBe('/data/config');
  });
  it('blocks .. traversal that escapes /data', () => {
    // path.posix.resolve('/data', '.', '/../../etc/passwd') resolves to
    // '/etc/passwd' which is outside /data → must throw.
    expect(() => _safePath('/../../etc/passwd')).toThrow(/Path traversal/);
  });
  it('allows a normal absolute path (stays under /data)', () => {
    const p = _safePath('/foo');
    expect(p.startsWith('/data')).toBe(true);
    expect(p).toBe('/data/foo');
  });
});
