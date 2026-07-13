'use strict';

// v8.9.43-alpha.1 — minimal OpenAI-compatible chat client (Node stdlib only, no
// deps). Works with local Ollama / LM Studio / vLLM / OpenAI / OpenRouter. The
// base URL is expected to include the API prefix (e.g. http://host:11434/v1);
// we POST to {base}/chat/completions.

const http = require('http');
const https = require('https');
const { URL } = require('url');

function _reqOptions(config, payloadLen, timeoutMs) {
  const o = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': payloadLen },
    timeout: timeoutMs,
    // Local/self-hosted endpoints often use self-signed TLS; the user pointed us here.
    rejectUnauthorized: false,
  };
  if (config.apiKey) o.headers['Authorization'] = `Bearer ${config.apiKey}`;
  return o;
}

function chat({ config, messages, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    if (!config || !config.baseUrl) return reject(new Error('No LLM endpoint configured'));
    let u;
    try { u = new URL(String(config.baseUrl).replace(/\/+$/, '') + '/chat/completions'); }
    catch (e) { return reject(new Error(`Bad base URL: ${e.message}`)); }
    const body = Buffer.from(JSON.stringify({ model: config.model || 'gpt-4o-mini', messages, stream: false, temperature: 0.2 }));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, _reqOptions(config, body.length, timeoutMs), (res) => {
      let data = '';
      res.on('data', (d) => { data += d; if (data.length > 4e6) req.destroy(new Error('LLM response too large')); });
      res.on('end', () => {
        let json = null; try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error((json && (json.error && (json.error.message || json.error)) ) || `LLM HTTP ${res.statusCode}`));
        }
        const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        if (content == null) return reject(new Error('LLM returned no content'));
        resolve(String(content));
      });
    });
    req.on('timeout', () => req.destroy(new Error('LLM request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { chat, _internals: { _reqOptions } };
