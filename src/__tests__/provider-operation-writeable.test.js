'use strict';

const mockDecision = jest.fn();
const mockConfig = {
  app: { env: 'test' }, session: { cookieName: 'sid' },
  features: { readOnly: false, ssoHeaders: false },
};

jest.mock('../config', () => mockConfig);
jest.mock('../services/auth', () => ({}));
jest.mock('../services/misc', () => ({ apiKeys: {} }));
jest.mock('../services/provider-operations/policy', () => ({ globalHttpGate: (...args) => mockDecision(...args) }));

const { writeable } = require('../middleware/auth');

function invoke(method) {
  const req = { method };
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const next = jest.fn();
  writeable(req, res, next);
  return { res, next };
}

describe('Dynamic operation write gate', () => {
  beforeEach(() => {
    mockConfig.features.readOnly = false;
    mockDecision.mockReset().mockReturnValue({ allowed: true });
  });

  it('does not query mutation policy for safe HTTP methods', () => {
    const { next } = invoke('GET');
    expect(next).toHaveBeenCalled();
    expect(mockDecision).not.toHaveBeenCalled();
  });

  it('blocks writes when the dynamic global policy is read-only', () => {
    mockDecision.mockReturnValue({ allowed: false, code: 'OPERATION_READ_ONLY', reason: 'Change freeze' });
    const { res, next } = invoke('POST');
    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({ error: 'Change freeze', code: 'OPERATION_READ_ONLY' });
    expect(next).not.toHaveBeenCalled();
  });

  it('preserves the environment read-only fail-closed behavior', () => {
    mockConfig.features.readOnly = true;
    const { res } = invoke('DELETE');
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/read-only/i);
    expect(mockDecision).not.toHaveBeenCalled();
  });
});
