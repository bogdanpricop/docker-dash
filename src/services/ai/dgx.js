'use strict';

const https = require('node:https');
const dns = require('node:dns');
const { isIP } = require('node:net');
const { X509Certificate } = require('node:crypto');
const { getDb } = require('../../db');
const { encrypt, decrypt } = require('../../utils/crypto');

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CA_BYTES = 12 * 1024;

function isPrivateAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function gatewayOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter the internal DGX HTTPS address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (isIP(url.hostname) && !isPrivateAddress(url.hostname)) || url.hostname.startsWith('[')
    || !url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw new Error('Use an HTTPS origin on the private network, without a path or credentials.');
  }
  return url.origin;
}

// Check the addresses used by the actual connection, including DNS aliases.
function privateLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || !addresses.every(entry => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error('DGX must resolve to private IPv4 addresses.'), { code: 'DGX_PRIVATE_ADDRESS' }));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function normalizeCa(value) {
  if (!value) return '';
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (Buffer.byteLength(value) > MAX_CA_BYTES || !blocks?.length
    || value.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) {
    throw new Error('Paste the internal CA certificate in PEM format.');
  }
  try {
    if (!blocks.every(pem => new X509Certificate(pem).ca)) throw new Error();
  } catch {
    throw new Error('A valid CA certificate is required.');
  }
  return blocks.join('\n') + '\n';
}

function settings(database = getDb()) {
  const row = database.prepare('SELECT enabled, endpoint, model, ca_pem, key_encrypted FROM dgx_triage_settings WHERE id = 1').get();
  return {
    enabled: Boolean(row.enabled),
    endpoint: row.endpoint,
    model: row.model,
    caPem: row.ca_pem,
    hasKey: Boolean(row.key_encrypted),
    encryptedKey: row.key_encrypted,
  };
}

function publicSettings(database = getDb()) {
  const { encryptedKey: _secret, ...config } = settings(database);
  return config;
}

function saveSettings(input, database = getDb()) {
  const current = settings(database);
  const { enabled, endpoint, model, caPem } = input;
  if (typeof enabled !== 'boolean' || typeof endpoint !== 'string' || endpoint.length > 320
    || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)
    || typeof caPem !== 'string') {
    throw new Error('Check the DGX endpoint, model and certificate fields.');
  }
  const origin = endpoint.trim() ? gatewayOrigin(endpoint.trim()) : '';
  const ca = normalizeCa(caPem);
  const supplied = input.apiKey;
  if (supplied !== undefined && supplied !== null &&
    (typeof supplied !== 'string' || !/^[A-Za-z0-9._~-]{24,200}$/.test(supplied))) {
    throw new Error('Enter a valid DGX gateway key.');
  }
  // A key belongs to the original endpoint and trust configuration.
  const keepKey = supplied === undefined && origin === current.endpoint && ca === current.caPem;
  const key = keepKey ? current.encryptedKey : supplied ? encrypt(supplied) : null;
  if (enabled && (!origin || !ca || !key)) throw new Error('Configure the DGX address, internal CA and gateway key before enabling triage.');
  database.prepare('UPDATE dgx_triage_settings SET enabled = ?, endpoint = ?, model = ?, ca_pem = ?, key_encrypted = ? WHERE id = 1')
    .run(Number(enabled), origin, model, ca, key);
  return publicSettings(database);
}

function request(config, path, body, timeoutMs) {
  if (!config.endpoint || !config.caPem || !config.encryptedKey) throw new Error('Complete the DGX gateway settings first.');
  const url = new URL(path, gatewayOrigin(config.endpoint));
  const key = decrypt(config.encryptedKey);
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: data ? 'POST' : 'GET',
      agent: false,
      ca: config.caPem,
      minVersion: 'TLSv1.2',
      lookup: privateLookup,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, response => {
      if (response.statusCode !== 200) {
        reject(new Error('DGX gateway returned HTTP ' + response.statusCode + '.'));
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          reject(new Error('DGX returned a response larger than the allowed limit.'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('The DGX response was interrupted.')));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('DGX returned an invalid JSON response.')); }
      });
    });
    req.on('error', error => {
      const code = /^[A-Z0-9_]+$/.test(error.code || '') ? ' (' + error.code + ')' : '';
      reject(new Error('The DGX HTTPS request failed' + code + '.'));
    });
    req.end(data);
  });
}

async function test(config = settings()) {
  const started = Date.now();
  const response = await request(config, '/v1/models', null, 8000);
  if (!Array.isArray(response?.data) || !response.data.some(entry => entry?.id === config.model)) {
    throw new Error('The configured model is not available on the DGX gateway.');
  }
  return { model: config.model, latencyMs: Date.now() - started };
}

module.exports = { settings, publicSettings, saveSettings, request, test };
