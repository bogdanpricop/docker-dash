'use strict';

// Tests for src/services/ai/index.js (v8.0.0)
//
// Uses MockAiProvider so we don't depend on real LLM APIs. Real provider
// integration is covered separately by spike S1-S3 protocols (run when
// API keys are available).

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

jest.resetModules();

describe('AI service', () => {
  let db, aiService, MockAiProvider, AiNotConfiguredError;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
    aiService = require('../services/ai');
    ({ MockAiProvider, AiNotConfiguredError } = require('../services/ai/providers/base'));
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`
    ).run();
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM ai_settings').run();
    db.prepare('INSERT INTO ai_settings (id, enabled) VALUES (1, 0)').run();
    aiService._resetTestProvider();
  });

  describe('isEnabled', () => {
    it('returns false when not configured', () => {
      expect(aiService.isEnabled()).toBe(false);
    });

    it('returns false when enabled=1 but no provider', () => {
      db.prepare('UPDATE ai_settings SET enabled = 1 WHERE id = 1').run();
      expect(aiService.isEnabled()).toBe(false);
    });

    it('returns true when enabled=1 + provider set', () => {
      db.prepare(`UPDATE ai_settings SET enabled = 1, provider = 'ollama', endpoint_url = 'http://localhost:11434' WHERE id = 1`).run();
      expect(aiService.isEnabled()).toBe(true);
    });
  });

  describe('saveSettings', () => {
    it('rejects enabled=true without provider', () => {
      expect(() => aiService.saveSettings({ enabled: true })).toThrow(/Cannot enable.*without a provider/);
    });

    it('rejects unknown provider', () => {
      expect(() => aiService.saveSettings({ provider: 'fakebrain' })).toThrow(/Unknown provider/);
    });

    it('rejects cloud provider with enabled but no key', () => {
      expect(() => aiService.saveSettings({ enabled: true, provider: 'anthropic' })).toThrow(/require an API key/);
    });

    it('rejects ollama provider without endpoint_url', () => {
      expect(() => aiService.saveSettings({ enabled: true, provider: 'ollama' })).toThrow(/requires endpoint_url/);
    });

    it('rejects invalid custom redaction patterns', () => {
      expect(() => aiService.saveSettings({
        provider: 'ollama',
        endpointUrl: 'http://localhost:11434',
        customRedactionPatterns: ['(unclosed'],
      })).toThrow(/invalid regex/);
    });

    it('persists valid Ollama config', () => {
      aiService.saveSettings({
        enabled: true,
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        endpointUrl: 'http://localhost:11434',
      }, 1);
      const view = aiService.getSettingsForApi();
      expect(view).toEqual(expect.objectContaining({
        enabled: true,
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        endpointUrl: 'http://localhost:11434',
        hasApiKey: false,
      }));
    });

    it('encrypts API key on save', () => {
      aiService.saveSettings({
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: 'sk-ant-test',
      }, 1);
      const row = db.prepare('SELECT api_key_encrypted FROM ai_settings WHERE id = 1').get();
      // Encrypted form is iv:tag:data hex
      expect(row.api_key_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      // getSettingsForApi never exposes the decrypted key
      expect(aiService.getSettingsForApi().hasApiKey).toBe(true);
      expect(aiService.getSettingsForApi()).not.toHaveProperty('apiKey');
    });

    it('clearing key requires disabling first (cannot leave enabled+keyless)', () => {
      aiService.saveSettings({ enabled: true, provider: 'anthropic', apiKey: 'k1' }, 1);
      expect(() => aiService.saveSettings({ apiKey: null }, 1))
        .toThrow(/require an API key/);
      // Disable first → then clearing the key works
      aiService.saveSettings({ enabled: false }, 1);
      aiService.saveSettings({ apiKey: null }, 1);
      expect(aiService.getSettingsForApi().hasApiKey).toBe(false);
    });

    it('omitting apiKey leaves it unchanged', () => {
      aiService.saveSettings({ enabled: true, provider: 'anthropic', apiKey: 'k1' }, 1);
      aiService.saveSettings({ model: 'claude-sonnet-4-6' }, 1);
      expect(aiService.getSettingsForApi().hasApiKey).toBe(true);
    });

    it('does not carry a key or endpoint over to a different provider', () => {
      aiService.saveSettings({
        enabled: true, provider: 'anthropic', apiKey: 'old-key',
        endpointUrl: 'https://old-proxy.example.test', model: 'claude-haiku-5-5',
      }, 1);
      expect(() => aiService.saveSettings({ provider: 'openai' }, 1)).toThrow(/require an API key/);
      expect(aiService.getSettingsForApi().provider).toBe('anthropic');
      aiService.saveSettings({ provider: 'openai', apiKey: 'new-key' }, 1);
      expect(aiService.getSettingsForApi()).toMatchObject({ provider: 'openai', model: null, endpointUrl: null, hasApiKey: true });
    });
  });

  describe('call — with MockAiProvider', () => {
    function _enableMock(responses, opts = {}) {
      db.prepare(`UPDATE ai_settings SET enabled = 1, provider = 'ollama', endpoint_url = 'http://localhost:11434' WHERE id = 1`).run();
      const mock = new MockAiProvider({ responses, ...opts });
      aiService._setTestProvider(mock);
      return mock;
    }

    it('throws AiNotConfiguredError when disabled', async () => {
      await expect(aiService.call('test', { systemPrompt: 's', userPrompt: 'u', schema: { type: 'object' } }))
        .rejects.toThrow(AiNotConfiguredError);
    });

    it('routes the prompt through the redactor before calling provider', async () => {
      const mock = _enableMock({
        'IP redacted': { ok: true },
      });
      await aiService.call('test', {
        systemPrompt: 's',
        userPrompt: 'IP redacted: 10.0.0.5',
        schema: { type: 'object' },
      });
      // Verify the mock saw the REDACTED prompt (no 10.0.0.5)
      expect(mock.calls[0].userPrompt).not.toContain('10.0.0.5');
      expect(mock.calls[0].userPrompt).toContain('[REDACTED:ip]');
    });

    it('returns redactions + payloadHash in the result', async () => {
      _enableMock({ 'hello': { ok: true } });
      const result = await aiService.call('test', {
        systemPrompt: 's',
        userPrompt: 'hello',
        schema: { type: 'object' },
      });
      expect(result.payloadHash).toMatch(/^[0-9a-f]{8}$/);
      expect(result.redactions).toEqual({});
      expect(result.data).toEqual({ ok: true });
    });

    it('writes audit log entry with action=ai_call on success', async () => {
      _enableMock({ 'q1': { ok: true } });
      await aiService.call('test-feature', {
        systemPrompt: 's',
        userPrompt: 'q1',
        schema: { type: 'object' },
      }, { userId: 1, username: 'admin' });
      const row = db.prepare(
        `SELECT * FROM audit_log WHERE action = 'ai_call' ORDER BY id DESC LIMIT 1`
      ).get();
      expect(row).toBeTruthy();
      const details = JSON.parse(row.details);
      expect(details.ok).toBe(true);
      expect(details.provider).toBe('ollama');
      expect(details.payloadHash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('writes audit log entry with ok=false when provider throws', async () => {
      _enableMock({});  // no canned response → MockAiProvider throws
      await expect(aiService.call('test', {
        systemPrompt: 's',
        userPrompt: 'unmatched',
        schema: { type: 'object' },
      }, { userId: 1, username: 'admin' })).rejects.toThrow();
      const row = db.prepare(
        `SELECT * FROM audit_log WHERE action = 'ai_call' ORDER BY id DESC LIMIT 1`
      ).get();
      const details = JSON.parse(row.details);
      expect(details.ok).toBe(false);
      expect(details.error).toBeTruthy();
    });

    it('rejects schema-noncompliant provider response', async () => {
      _enableMock({ 'q': { actor: 12345 } });  // actor must be string
      await expect(aiService.call('test', {
        systemPrompt: 's',
        userPrompt: 'q',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { actor: { type: 'string' } },
        },
      })).rejects.toThrow(/schema validation/);
    });

    it('passes when schema validation succeeds', async () => {
      _enableMock({ 'q': { actor: 'alice' } });
      const r = await aiService.call('test', {
        systemPrompt: 's',
        userPrompt: 'q',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { actor: { type: 'string', maxLength: 64 } },
        },
      });
      expect(r.data.actor).toBe('alice');
    });
  });

  describe('schema validator', () => {
    const { _validateSchema } = aiService = require('../services/ai')._internals;

    it('accepts valid object', () => {
      expect(_validateSchema({ a: 'x' }, {
        type: 'object',
        properties: { a: { type: 'string' } },
      })).toEqual({ ok: true });
    });

    it('rejects unknown property when additionalProperties=false', () => {
      const r = _validateSchema({ a: 'x', b: 'y' }, {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/unexpected property: b/);
    });

    it('enforces maxLength on string', () => {
      const r = _validateSchema({ a: 'x'.repeat(100) }, {
        type: 'object',
        properties: { a: { type: 'string', maxLength: 10 } },
      });
      expect(r.ok).toBe(false);
    });

    it('enforces enum on string', () => {
      const r = _validateSchema({ a: 'qux' }, {
        type: 'object',
        properties: { a: { type: 'string', enum: ['foo', 'bar'] } },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not in enum/);
    });

    it('enforces integer minimum/maximum', () => {
      const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 100 } } };
      expect(_validateSchema({ n: 50 }, schema).ok).toBe(true);
      expect(_validateSchema({ n: 0 }, schema).ok).toBe(false);
      expect(_validateSchema({ n: 200 }, schema).ok).toBe(false);
    });

    it('validates ISO 8601 date-time strings', () => {
      const schema = { type: 'object', properties: { d: { type: 'string', format: 'date-time' } } };
      expect(_validateSchema({ d: '2026-04-26T12:00:00Z' }, schema).ok).toBe(true);
      expect(_validateSchema({ d: '2026-04-26' }, schema).ok).toBe(false);
      expect(_validateSchema({ d: 'tuesday' }, schema).ok).toBe(false);
    });
  });
});
