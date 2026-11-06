'use strict';

// Claude Messages API with JSON output for Claude 5 and tool use for older models.

const https = require('https');
const { AiProvider, AiProviderError } = require('./base');
const cloudSchema = require('./cloud-schema');

const ANTHROPIC_API_VERSION = '2023-06-01';

class AnthropicProvider extends AiProvider {
  static defaultModel = 'claude-haiku-5-5';

  constructor(config) {
    super(config);
    if (!config.apiKey) throw new Error('AnthropicProvider requires apiKey');
    this.apiKey = config.apiKey;
    this.model = config.model || AnthropicProvider.defaultModel;
    this.baseUrl = config.endpointUrl || 'https://api.anthropic.com';
  }

  async test() {
    const start = Date.now();
    try {
      const result = await this._request('GET', '/v1/models/' + encodeURIComponent(this.model), null, 5000);
      return {
        ok: true,
        model: this.model,
        latencyMs: Date.now() - start,
        modelEcho: result.id || this.model,
      };
    } catch (err) {
      return { ok: false, error: err.message, latencyMs: Date.now() - start };
    }
  }

  async structured(req) {
    const start = Date.now();
    const toolName = req.toolName || 'structured_output';
    const nativeJson = /^claude-(?:haiku|sonnet|opus|fable|mythos)-5(?:-|$)/.test(this.model);
    const body = {
      model: this.model,
      max_tokens: (req.maxTokens || 1024) + (nativeJson ? 2048 : 0),
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      ...(nativeJson ? {
        output_config: { effort: 'low', format: { type: 'json_schema', schema: cloudSchema(req.schema) } },
      } : {
        tools: [{
          name: toolName,
          description: 'Return the structured output for the user request',
          input_schema: req.schema,
        }],
        tool_choice: { type: 'tool', name: toolName },
      }),
    };

    let response;
    try {
      response = await this._request('POST', '/v1/messages', body, req.timeoutMs || 15000);
    } catch (err) {
      throw new AiProviderError(`Anthropic request failed: ${err.message}`, {
        code: err.code || 'network',
        statusCode: err.statusCode,
        retriable: err.retriable === true,
      });
    }

    const blocks = response.content || [];
    const output = nativeJson ? blocks.find(b => b.type === 'text')
      : blocks.find(b => b.type === 'tool_use' && b.name === toolName);
    if (!output || ['max_tokens', 'refusal'].includes(response.stop_reason)) {
      throw new AiProviderError(`Anthropic returned no complete structured output (stop: ${response.stop_reason || 'unknown'})`, {
        code: nativeJson ? 'empty-response' : 'no-tool-use',
      });
    }
    let data;
    try { data = nativeJson ? JSON.parse(output.text) : output.input; }
    catch { throw new AiProviderError('Anthropic returned invalid structured JSON', { code: 'malformed-json' }); }

    return {
      data,
      usage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
      },
      model: response.model || this.model,
      latencyMs: Date.now() - start,
    };
  }

  _request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const payload = body ? JSON.stringify(body) : null;
      const req = https.request(url, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
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
            // Try to extract Anthropic's error message for a friendlier display
            let detail = text.substring(0, 200);
            try {
              const j = JSON.parse(text);
              if (j.error?.message) detail = j.error.message;
            } catch { /* leave raw */ }
            const err = new Error(`HTTP ${res.statusCode}: ${detail}`);
            err.code = `http-${res.statusCode}`;
            err.statusCode = res.statusCode;
            err.retriable = res.statusCode >= 500 || res.statusCode === 429;
            return reject(err);
          }
          try { resolve(JSON.parse(text)); }
          catch { reject(new Error('Anthropic returned non-JSON response')); }
        });
      });
      req.on('error', (err) => {
        const e = new Error(err.message);
        e.code = err.code;
        reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Anthropic request timed out');
        err.code = 'timeout';
        err.retriable = true;
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = AnthropicProvider;
