'use strict';

// Chat Completions with JSON Schema structured outputs.

const https = require('https');
const { AiProvider, AiProviderError } = require('./base');
const cloudSchema = require('./cloud-schema');

class OpenAiProvider extends AiProvider {
  static defaultModel = 'gpt-6-luna';

  constructor(config) {
    super(config);
    if (!config.apiKey) throw new Error('OpenAiProvider requires apiKey');
    this.apiKey = config.apiKey;
    this.model = config.model || OpenAiProvider.defaultModel;
    this.baseUrl = config.endpointUrl || 'https://api.openai.com';
  }

  async test() {
    const start = Date.now();
    try {
      // Cheapest possible test: list models. Verifies key is valid.
      const result = await this._request('GET', '/v1/models', null, 5000);
      const found = (result.data || []).some(m => m.id === this.model);
      return {
        ok: true,
        model: this.model,
        latencyMs: Date.now() - start,
        modelAvailable: found,
        warning: found ? null : `Model "${this.model}" not in account's available models — verify access.`,
      };
    } catch (err) {
      return { ok: false, error: err.message, latencyMs: Date.now() - start };
    }
  }

  async structured(req) {
    const start = Date.now();
    const modern = /^gpt-[56](?:[.-]|$)/.test(this.model);
    const reasoningEffort = /^(?:gpt-6-luna|gpt-6-sol|gpt-6\.1-terra)(?:-|$)/.test(this.model) ? 'none' : 'low';
    const maxTokens = req.maxTokens || 1024;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      ...(modern ? { max_completion_tokens: maxTokens + (reasoningEffort === 'low' ? 2048 : 0), reasoning_effort: reasoningEffort } : {
        max_tokens: maxTokens, temperature: 0,
      }),
      // Structured outputs — JSON schema enforced by the API.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: req.toolName || 'output',
          strict: true,
          schema: cloudSchema(req.schema, true),
        },
      },
    };

    let response;
    try {
      response = await this._request('POST', '/v1/chat/completions', body, req.timeoutMs || 15000);
    } catch (err) {
      throw new AiProviderError(`OpenAI request failed: ${err.message}`, {
        code: err.code || 'network',
        statusCode: err.statusCode,
        retriable: err.retriable === true,
      });
    }

    const content = response.choices?.[0]?.message?.content;
    if (!content || response.choices[0].finish_reason === 'length' || response.choices[0].message.refusal) {
      throw new AiProviderError('OpenAI returned no content', { code: 'empty-response' });
    }
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (err) {
      throw new AiProviderError(`OpenAI returned non-JSON despite structured-output request: ${err.message}`, {
        code: 'malformed-json',
      });
    }

    return {
      data: this._restoreOptionalFields(parsed, req.schema),
      usage: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
      },
      model: response.model || this.model,
      latencyMs: Date.now() - start,
    };
  }

  _restoreOptionalFields(value, schema) {
    if (Array.isArray(value) && schema?.items) return value.map(item => this._restoreOptionalFields(item, schema.items));
    if (!value || Array.isArray(value) || typeof value !== 'object' || !schema?.properties) return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key, entry]) => entry !== null || !Object.hasOwn(schema.properties, key) || schema.required?.includes(key))
      .map(([key, entry]) => [key, this._restoreOptionalFields(entry, schema.properties[key])]));
  }

  _request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const payload = body ? JSON.stringify(body) : null;
      const req = https.request(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}: ${text.substring(0, 200)}`);
            err.code = `http-${res.statusCode}`;
            err.statusCode = res.statusCode;
            err.retriable = res.statusCode >= 500 || res.statusCode === 429;
            return reject(err);
          }
          try { resolve(JSON.parse(text)); }
          catch { reject(new Error('OpenAI returned non-JSON top-level response')); }
        });
      });
      req.on('error', (err) => {
        const e = new Error(err.message);
        e.code = err.code;
        reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
        const err = new Error('OpenAI request timed out');
        err.code = 'timeout';
        err.retriable = true;
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = OpenAiProvider;
