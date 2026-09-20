'use strict';

// AI Service — v8.0.0 entry point
//
// Single call site: aiService.call(featureName, userPrompt, schema, opts).
// Wraps:
//   1. Settings lookup (off-by-default, throws AiNotConfiguredError if disabled)
//   2. Redactor (D4: throws AiRedactionError if regex fails)
//   3. Provider selection + lazy adapter load
//   4. Schema validation (defense in depth — even if provider claims compliance)
//   5. Audit log entry (every call, success or failure)
//
// All AI features in v8.x consume this. Never instantiate providers
// directly from feature code.

const { getDb } = require('../../db');
const { encrypt, decrypt } = require('../../utils/crypto');
const log = require('../../utils/logger')('ai');
const { redact } = require('./redactor');
const { AiProviderError, AiNotConfiguredError } = require('./providers/base');
const auditService = require('../audit');

const KNOWN_PROVIDERS = ['anthropic', 'openai', 'ollama'];

// Test-only override — set by tests to inject a MockAiProvider.
let _testProvider = null;

/**
 * Read AI settings from DB. Returns the in-memory shape (decrypted key,
 * parsed custom patterns). Throws if DB row is missing (migration didn't run).
 */
function _readSettings() {
  const row = getDb().prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  if (!row) throw new Error('ai_settings row missing — did the v8.0.0 migration run?');
  return {
    enabled: row.enabled === 1,
    provider: row.provider,
    model: row.model,
    apiKey: row.api_key_encrypted ? _decryptOrThrow(row.api_key_encrypted) : null,
    endpointUrl: row.endpoint_url,
    customRedactionPatterns: _parseJsonOrEmpty(row.custom_redaction_patterns),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function _decryptOrThrow(encrypted) {
  try { return decrypt(encrypted); }
  catch (err) {
    log.error('AI key decrypt failed', { error: err.message });
    throw new Error('AI provider key cannot be decrypted (was ENCRYPTION_KEY rotated?)');
  }
}

function _parseJsonOrEmpty(s) {
  if (!s) return [];
  try { return JSON.parse(s); }
  catch { return []; }
}

/**
 * Persist settings. API key is re-encrypted on every write. Caller must
 * pass `apiKey` undefined to leave it unchanged, null to clear it, string
 * to replace it.
 */
function saveSettings(updates, userId = null) {
  const current = _readSettings();
  const merged = { ...current, ...updates };

  // Validate
  if (merged.enabled && !merged.provider) {
    throw new Error('Cannot enable AI without a provider configured');
  }
  if (merged.provider && !KNOWN_PROVIDERS.includes(merged.provider)) {
    throw new Error(`Unknown provider: ${merged.provider}. Allowed: ${KNOWN_PROVIDERS.join(', ')}`);
  }
  if (merged.provider !== 'ollama' && merged.enabled && !merged.apiKey) {
    throw new Error('Cloud providers require an API key');
  }
  if (merged.provider === 'ollama' && !merged.endpointUrl) {
    throw new Error('Ollama provider requires endpoint_url');
  }
  if (merged.customRedactionPatterns) {
    // Compile to validate — throws on bad regex
    require('./redactor').compileCustomPatterns(merged.customRedactionPatterns);
  }

  const apiKeyEncrypted = updates.apiKey === undefined
    ? current.apiKey ? encrypt(current.apiKey) : null
    : updates.apiKey === null ? null : encrypt(updates.apiKey);

  getDb().prepare(`
    UPDATE ai_settings SET
      enabled = ?,
      provider = ?,
      model = ?,
      api_key_encrypted = ?,
      endpoint_url = ?,
      custom_redaction_patterns = ?,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = ?
    WHERE id = 1
  `).run(
    merged.enabled ? 1 : 0,
    merged.provider,
    merged.model,
    apiKeyEncrypted,
    merged.endpointUrl,
    merged.customRedactionPatterns ? JSON.stringify(merged.customRedactionPatterns) : null,
    userId,
  );
}

/**
 * Build a public-safe view of settings for API responses. NEVER returns
 * the decrypted key — replaces with masked indicator.
 */
function getSettingsForApi() {
  const s = _readSettings();
  return {
    enabled: s.enabled,
    provider: s.provider,
    model: s.model,
    hasApiKey: !!s.apiKey,
    endpointUrl: s.endpointUrl,
    customRedactionPatterns: s.customRedactionPatterns || [],
    updatedAt: s.updatedAt,
  };
}

function isEnabled() {
  try {
    const s = _readSettings();
    return s.enabled && !!s.provider;
  } catch {
    return false;
  }
}

/**
 * Test-only: inject a MockAiProvider so unit tests don't need real settings.
 * Cleared between tests via _resetTestProvider().
 */
function _setTestProvider(provider) { _testProvider = provider; }
function _resetTestProvider() { _testProvider = null; }

/**
 * Resolve the right adapter for the configured provider. Adapters are
 * lazily required to avoid loading unused HTTP clients.
 */
function _getAdapter(settings) {
  if (_testProvider) return _testProvider;
  if (!settings.provider) throw new AiNotConfiguredError();
  switch (settings.provider) {
    case 'anthropic': return new (require('./providers/anthropic'))({ ...settings });
    case 'openai':    return new (require('./providers/openai'))({ ...settings });
    case 'ollama':    return new (require('./providers/ollama'))({ ...settings });
    default: throw new AiNotConfiguredError();
  }
}

/**
 * The single feature call site.
 *
 * @param {string} featureName - identifier audited (e.g. 'audit-nl-search')
 * @param {object} req
 * @param {string} req.systemPrompt
 * @param {string} req.userPrompt
 * @param {object} req.schema - JSON schema for output
 * @param {string} req.toolName - name surfaced to provider's tool-use API
 * @param {number} [req.maxTokens]
 * @param {number} [req.timeoutMs]
 * @param {object} [audit] - extra audit fields
 * @param {number} [audit.userId]
 * @param {string} [audit.username]
 * @param {string} [audit.ip]
 *
 * @returns {Promise<{data, usage, model, latencyMs, redactions, payloadHash}>}
 */
async function call(featureName, req, audit = {}) {
  if (!featureName || typeof featureName !== 'string') {
    throw new Error('featureName required');
  }
  const settings = _readSettings();
  if (!settings.enabled) throw new AiNotConfiguredError();

  // 1. Redact (D4: throws AiRedactionError if any regex fails)
  const { redacted, counts: redactions, payloadHash } = redact(
    req.userPrompt,
    settings.customRedactionPatterns,
  );

  // 2. Call provider
  const adapter = _getAdapter(settings);
  let result, errorOut = null;
  try {
    result = await adapter.structured({ ...req, userPrompt: redacted });
  } catch (err) {
    errorOut = err;
  }

  // 3. Validate output against schema (defense in depth — never trust the model)
  if (result && req.schema) {
    const valid = _validateSchema(result.data, req.schema);
    if (!valid.ok) {
      errorOut = new AiProviderError(
        `Provider returned data that failed schema validation: ${valid.error}`,
        { code: 'schema-violation' },
      );
      result = null;
    }
  }

  // 4. Audit log every call (success OR failure)
  try {
    auditService.log({
      userId: audit.userId,
      username: audit.username,
      action: 'ai_call',
      targetType: 'ai-feature',
      targetId: featureName,
      details: {
        provider: settings.provider,
        model: result?.model || settings.model || 'unknown',
        inputTokens: result?.usage?.input || 0,
        outputTokens: result?.usage?.output || 0,
        durationMs: result?.latencyMs || 0,
        redactions,
        payloadHash,
        ok: !errorOut,
        ...(errorOut ? { error: String(errorOut.message).substring(0, 300) } : {}),
      },
      ip: audit.ip,
    });
  } catch (auditErr) {
    log.warn('AI audit log failed (non-fatal)', { error: auditErr.message });
  }

  if (errorOut) throw errorOut;
  return { ...result, redactions, payloadHash };
}

/**
 * Lightweight schema check using Node's built-in regex/type assertions.
 * For v8.0.0 we keep dependencies tight — no ajv. Schema covers our
 * limited use case (top-level object with primitive properties + enum).
 */
function _validateSchema(data, schema) {
  if (!schema || schema.type !== 'object') return { ok: true };
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'expected object' };
  }
  const props = schema.properties || {};
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(data)) {
      if (!(k in props)) return { ok: false, error: `unexpected property: ${k}` };
    }
  }
  for (const [k, v] of Object.entries(data)) {
    const ps = props[k];
    if (!ps) continue;
    if (ps.type === 'string') {
      if (typeof v !== 'string') return { ok: false, error: `${k}: expected string` };
      if (ps.maxLength != null && v.length > ps.maxLength) return { ok: false, error: `${k}: exceeds maxLength` };
      if (ps.enum && !ps.enum.includes(v)) return { ok: false, error: `${k}: not in enum` };
      if (ps.format === 'date-time' && !_isIsoDate(v)) return { ok: false, error: `${k}: invalid date-time` };
    } else if (ps.type === 'integer') {
      if (!Number.isInteger(v)) return { ok: false, error: `${k}: expected integer` };
      if (ps.minimum != null && v < ps.minimum) return { ok: false, error: `${k}: below minimum` };
      if (ps.maximum != null && v > ps.maximum) return { ok: false, error: `${k}: above maximum` };
    }
  }
  return { ok: true };
}

function _isIsoDate(s) {
  // Accept ISO 8601 date-time
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s);
}

module.exports = {
  call,
  isEnabled,
  saveSettings,
  getSettingsForApi,
  KNOWN_PROVIDERS,
  // Test-only
  _setTestProvider,
  _resetTestProvider,
  _internals: { _readSettings, _validateSchema },
};
