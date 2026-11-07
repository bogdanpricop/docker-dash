'use strict';

// Ollama provider — v8.0.0
//
// Self-hosted local LLM. Privacy-first path: zero outbound traffic to
// non-user-controlled hosts. Uses Ollama's REST API at /api/chat with
// `format: "json"` to coax JSON output, then we validate against the
// schema client-side (which all providers go through anyway).
//
// Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
//
// Recommended models (per spike S3 protocol): qwen2.5-coder:7b for the
// 8GB-RAM common case; llama3.3 or deepseek-r1 for larger boxes.

const http = require('http');
const https = require('https');
const { AiProvider, AiProviderError } = require('./base');
const { httpDiagnostic, networkDiagnostic } = require('../../../utils/notification-diagnostics');

class OllamaProvider extends AiProvider {
  constructor(config) {
    super(config);
    if (!config.endpointUrl) {
      throw new Error('OllamaProvider requires endpointUrl (e.g. http://localhost:11434)');
    }
    this.endpoint = config.endpointUrl.replace(/\/+$/, '');
    this.model = config.model || 'qwen2.5-coder:7b';
  }

  async test() {
    const start = Date.now();
    try {
      const result = await this._request('GET', '/api/tags', null, 5000);
      const models = (result.models || []).map(m => m.name);
      const found = models.includes(this.model) || models.some(m => m.startsWith(this.model + ':'));
      return {
        ok: found,
        model: this.model,
        latencyMs: Date.now() - start,
        availableModels: models.length,
        modelInstalled: found,
        ...(found ? {} : { error: 'The selected model is not installed on this Ollama server.' }),
      };
    } catch (err) {
      const details = err.statusCode ? httpDiagnostic(err.statusCode) : networkDiagnostic(err);
      return { ok: false, error: details.reason || 'Ollama connection test failed.', ...details, latencyMs: Date.now() - start };
    }
  }

  async structured(req) {
    const start = Date.now();
    const messages = [
      { role: 'system', content: req.systemPrompt + '\n\nYou must respond with a JSON object that matches this schema:\n' + JSON.stringify(req.schema) + '\n\nReturn ONLY the JSON object, no other text.' },
      { role: 'user', content: req.userPrompt },
    ];

    const body = {
      model: this.model,
      messages,
      stream: false,
      format: 'json',
      options: {
        // Reduce randomness for deterministic-ish JSON output
        temperature: 0.1,
        num_predict: req.maxTokens || 1024,
      },
    };

    let response;
    try {
      response = await this._request('POST', '/api/chat', body, req.timeoutMs || 30000);
    } catch (err) {
      throw new AiProviderError(`Ollama request failed: ${err.message}`, {
        code: err.code || 'network',
        retriable: err.retriable === true,
      });
    }

    const content = response.message?.content;
    if (!content) {
      throw new AiProviderError('Ollama returned no message content', { code: 'empty-response' });
    }

    let parsed;
    try { parsed = JSON.parse(content); }
    catch (err) {
      throw new AiProviderError(
        `Ollama did not return valid JSON. The model "${this.model}" may not support format:json reliably. ` +
        `Try a different model (qwen2.5-coder:7b, llama3.3, deepseek-r1).`,
        { code: 'malformed-json' },
      );
    }

    return {
      data: parsed,
      usage: {
        input: response.prompt_eval_count || 0,
        output: response.eval_count || 0,
      },
      model: this.model,
      latencyMs: Date.now() - start,
    };
  }

  _request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.endpoint);
      const lib = url.protocol === 'https:' ? https : http;
      const payload = body ? JSON.stringify(body) : null;
      const req = lib.request(url, {
        method,
        headers: {
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
            err.retriable = res.statusCode >= 500 || res.statusCode === 429;
            return reject(err);
          }
          try { resolve(JSON.parse(text)); }
          catch { resolve({ raw: text }); }
        });
      });
      req.on('error', (err) => {
        const e = new Error(err.message);
        e.code = err.code;
        reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Ollama request timed out');
        err.code = 'timeout';
        err.retriable = true;
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = OllamaProvider;
