'use strict';

const { validateId, validateBody, sanitizeBody } = require('../middleware/validate');

// 📚 WHY: Input validation middleware is the FIRST line of defense.
// If these fail, attackers bypass all downstream checks.

// Helper to create mock Express req/res/next
function mockReqRes(params = {}, body = {}) {
  const req = { params, body };
  const res = {
    _status: null, _json: null,
    status(s) { this._status = s; return this; },
    json(j) { this._json = j; return this; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, wasNextCalled: () => nextCalled };
}

describe('validateId', () => {
  // 📚 HAPPY PATH: valid numeric ID
  it('should pass valid numeric ID and call next', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({ id: '42' });
    validateId(req, res, next);
    expect(wasNextCalled()).toBe(true);
    expect(req.params.id).toBe('42');
  });

  // 📚 SECURITY: prevent NaN from reaching DB queries
  it('should return 400 for non-numeric ID', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({ id: 'abc' });
    validateId(req, res, next);
    expect(wasNextCalled()).toBe(false);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/Invalid ID/i);
  });

  it('should return 400 for negative ID', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({ id: '-5' });
    validateId(req, res, next);
    expect(wasNextCalled()).toBe(false);
    expect(res._status).toBe(400);
  });

  it('should return 400 for empty ID', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({ id: '' });
    validateId(req, res, next);
    expect(wasNextCalled()).toBe(false);
  });
});

describe('validateBody', () => {
  // 📚 HAPPY PATH: all required fields present
  it('should pass when all required fields exist', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({}, { name: 'test', email: 'a@b.c' });
    validateBody('name', 'email')(req, res, next);
    expect(wasNextCalled()).toBe(true);
  });

  // 📚 VALIDATION: missing required field
  it('should return 400 when required field is missing', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({}, { name: 'test' });
    validateBody('name', 'email')(req, res, next);
    expect(wasNextCalled()).toBe(false);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('email');
  });

  // 📚 EDGE: empty string should fail validation
  it('should reject empty string as missing', () => {
    const { req, res, next, wasNextCalled } = mockReqRes({}, { name: '' });
    validateBody('name')(req, res, next);
    expect(wasNextCalled()).toBe(false);
    expect(res._status).toBe(400);
  });

  // 📚 SECURITY: null body
  it('should return 400 for null/missing body', () => {
    const req = { body: null, params: {} };
    const res = { _status: null, _json: null, status(s) { this._status = s; return this; }, json(j) { this._json = j; } };
    let called = false;
    validateBody('name')(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
  });
});

describe('sanitizeBody', () => {
  // 📚 WHY: prototype pollution is a real attack vector in Node.js
  it('should only keep allowed fields, stripping pollution vectors', () => {
    const body = { name: 'test', prototype: { x: 1 }, __proto__: { admin: true } };
    const { req, res, next } = mockReqRes({}, body);
    sanitizeBody('name')(req, res, next);
    expect(req.body.name).toBe('test');
    expect(req.body.hasOwnProperty('prototype')).toBe(false);
    // Only 'name' should remain as own property
    expect(Object.keys(req.body)).toEqual(['name']);
  });

  // 📚 WHITELIST: only allowed fields pass through
  it('should strip unknown fields when allowedFields specified', () => {
    const { req, res, next } = mockReqRes({}, { name: 'test', role: 'admin', secret: 'hack' });
    sanitizeBody('name', 'role')(req, res, next);
    expect(req.body).toEqual({ name: 'test', role: 'admin' });
    expect(req.body.secret).toBeUndefined();
  });

  it('should handle missing body gracefully', () => {
    const req = { body: null, params: {} };
    const res = {};
    let called = false;
    sanitizeBody('name')(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.body).toEqual({});
  });
});
