'use strict';

// Provider abstraction — v8.0.0
//
// Every AI provider (Anthropic, OpenAI, Ollama) implements this interface.
// The hard constraint: providers MUST support structured-output / tool-use.
// We never call providers in free-text mode for any v8.x feature — output
// must conform to a JSON schema, validated client-side after the call.
//
// Errors all extend AiProviderError so callers can distinguish AI errors
// from generic JS errors and surface them gracefully.

class AiProviderError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.code = opts.code || 'unknown';
    this.statusCode = opts.statusCode || null;
    this.retriable = opts.retriable === true;
  }
}

class AiNotConfiguredError extends Error {
  constructor() {
    super('AI is not configured. Configure a provider in Settings → AI.');
    this.name = 'AiNotConfiguredError';
  }
}

/**
 * Base class for AI providers. Subclasses must implement test() and structured().
 * Constructor receives the resolved settings: { provider, model, apiKey, endpointUrl }.
 */
class AiProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * Cheap connectivity + auth check. Used by Settings → AI → "Test connection"
   * before saving credentials. Should NOT burn real-feature tokens.
   *
   * @returns {Promise<{ok: true, model: string, latencyMs: number} | {ok: false, error: string, latencyMs: number}>}
   */
  async test() {
    throw new Error('AiProvider.test() not implemented');
  }

  /**
   * Call the provider with a structured-output prompt.
   *
   * @param {object} req
   * @param {string} req.systemPrompt   Instructions for the model
   * @param {string} req.userPrompt     The (already-redacted) user input
   * @param {object} req.schema         JSON schema the response MUST conform to
   * @param {string} req.toolName       Name of the "tool" / function (used by Anthropic + OpenAI)
   * @param {number} [req.maxTokens=1024]
   * @param {number} [req.timeoutMs=15000]
   *
   * @returns {Promise<{
   *   data: object,                    Parsed AND schema-validated
   *   usage: { input: number, output: number },
   *   model: string,
   *   latencyMs: number,
   * }>}
   *
   * Throws AiProviderError on auth failure, network error, timeout, malformed
   * response, or schema validation failure. Caller can trust .data is valid.
   */
  async structured(_req) {
    throw new Error('AiProvider.structured() not implemented');
  }
}

/**
 * MockAiProvider — used by unit tests and as a fallback when the real
 * provider can't be loaded. Returns canned responses keyed by user prompt.
 *
 * Tests inject `responses` map: { promptSubstring → responseObject }
 * If no key matches, throws a controlled error so tests don't get silent
 * empty results.
 */
class MockAiProvider extends AiProvider {
  constructor(config = {}) {
    super({ provider: 'mock', model: 'mock-1', ...config });
    this.responses = config.responses || {};
    this.testResult = config.testResult || { ok: true, model: 'mock-1', latencyMs: 0 };
    this.calls = [];  // recorded for assertions
  }

  async test() {
    return this.testResult;
  }

  async structured(req) {
    this.calls.push(req);
    const start = Date.now();
    for (const [key, value] of Object.entries(this.responses)) {
      if (req.userPrompt.includes(key)) {
        return {
          data: value,
          usage: { input: req.userPrompt.length, output: JSON.stringify(value).length },
          model: this.config.model,
          latencyMs: Date.now() - start,
        };
      }
    }
    throw new AiProviderError(`MockAiProvider: no canned response for prompt: ${req.userPrompt.substring(0, 50)}…`, { code: 'mock-no-match' });
  }
}

module.exports = {
  AiProvider,
  AiProviderError,
  AiNotConfiguredError,
  MockAiProvider,
};
