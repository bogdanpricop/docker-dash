'use strict';
const https = require('https');
const { TextDecoder } = require('util');
const MAX_BYTES = 1024 * 1024, DEADLINE_MS = 10000, MAX_IN_FLIGHT = 8;
let inFlight = 0;

function endpoint(value) {
  let url;
  try { if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error(); url = new URL(value); }
  catch { throw new Error('Invalid OIDC endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid OIDC endpoint');
  return url;
}

function fetchJson(value, options = {}) {
  let url;
  try { url = endpoint(value); } catch (error) { return Promise.reject(error); }
  if (inFlight >= MAX_IN_FLIGHT) return Promise.reject(new Error('OIDC transport busy'));
  inFlight++;
  return new Promise((resolve, reject) => {
    let request, response, settled = false, size = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); inFlight--; chunks.length = 0;
      if (error) { response?.destroy(); request?.destroy(); reject(error); }
      else resolve(result);
    };
    const fail = message => finish(new Error(message));
    // This deadline starts before DNS/connect/TLS and is never reset by traffic.
    const timer = setTimeout(() => fail('OIDC request deadline exceeded'), DEADLINE_MS);
    try {
      request = https.request({
        hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port,
        path: url.pathname + url.search, method: options.method || 'GET',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(options.headers || {}) },
        agent: false, minVersion: 'TLSv1.2', rejectUnauthorized: true, maxHeaderSize: 16384,
      }, res => {
        response = res;
        res.on('error', () => fail('OIDC response failed'));
        res.on('aborted', () => fail('OIDC response interrupted'));
        res.on('close', () => { if (!settled) fail('OIDC response incomplete'); });
        if (settled) { res.destroy(); return; }
        if (res.statusCode !== 200) { fail('OIDC provider returned an unsuccessful status'); return; }
        const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json' && type !== 'application/jwk-set+json') { fail('OIDC response must be JSON'); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'].toLowerCase() !== 'identity') { fail('OIDC encoded response refused'); return; }
        const length = res.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { fail('OIDC response too large'); return; }
        res.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_BYTES) { fail('OIDC response too large'); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (!res.complete) { fail('OIDC response incomplete'); return; }
          try {
            const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
            finish(null, { status: res.statusCode, body });
          } catch { fail('OIDC response must be a JSON object'); }
        });
      });
      request.on('error', () => fail('OIDC request failed'));
      request.on('close', () => { if (!settled) fail('OIDC request interrupted'); });
      if (options.body) request.write(options.body);
      request.end();
    } catch { fail('OIDC request failed'); }
  });
}

module.exports = { fetchJson, endpoint, MAX_BYTES, DEADLINE_MS, MAX_IN_FLIGHT };
