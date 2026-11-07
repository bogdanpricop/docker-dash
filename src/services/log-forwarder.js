'use strict';

const http = require('http');
const https = require('https');
const dgram = require('dgram');
const net = require('net');
const { getDb } = require('../db');
const { decrypt } = require('../utils/crypto');
const log = require('../utils/logger')('log-forwarder');
const httpUrl = require('../utils/http-url');
const { httpDiagnostic } = require('../utils/notification-diagnostics');

// ─── Batch buffer per forwarder ─────────────────────────
const _buffers = new Map(); // forwarderId -> { lines: [], timer }
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;

/**
 * Add a log line to the forwarder buffer.
 * Called from Docker event stream integration.
 */
function ingestLine(containerName, containerId, line, timestamp) {
  const db = getDb();
  let forwarders;
  try {
    forwarders = db.prepare('SELECT * FROM log_forwarders WHERE enabled = 1').all();
  } catch { return; }

  for (const fw of forwarders) {
    const fwId = fw.id;
    if (!_buffers.has(fwId)) {
      _buffers.set(fwId, { lines: [], timer: null });
    }
    const buf = _buffers.get(fwId);
    buf.lines.push({ containerName, containerId, line, timestamp: timestamp || new Date().toISOString() });

    if (buf.lines.length >= BATCH_SIZE) {
      _flush(fw);
    } else if (!buf.timer) {
      buf.timer = setTimeout(() => _flush(fw), FLUSH_INTERVAL_MS);
    }
  }
}

async function _flush(forwarder) {
  const buf = _buffers.get(forwarder.id);
  if (!buf || buf.lines.length === 0) return;

  const lines = buf.lines.splice(0);
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }

  let config;
  try { config = JSON.parse(decrypt(forwarder.config_json_encrypted)); }
  catch (e) { log.error(`Forwarder ${forwarder.id}: config decrypt failed`, e.message); return; }

  try {
    switch (forwarder.type) {
      case 'loki': await _sendLoki(config, lines); break;
      case 'elasticsearch': await _sendElasticsearch(config, lines); break;
      case 'http': await _sendHttp(config, lines); break;
      case 'syslog': await _sendSyslog(config, lines); break;
      default: log.warn(`Unknown forwarder type: ${forwarder.type}`);
    }
  } catch (err) {
    log.error(`Forwarder ${forwarder.name} (${forwarder.type}) send failed`, err.message);
  }
}

function discardBuffer(id) {
  const buffer = _buffers.get(id);
  if (buffer?.timer) clearTimeout(buffer.timer);
  _buffers.delete(id);
}

function collectorPath(value, suffix) {
  const url = httpUrl(value);
  if (!url) throw new Error('Invalid collector URL');
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  return url.href;
}

// ─── Loki Push API ──────────────────────────────────────────
async function _sendLoki(config, lines) {
  // Group by container
  const streams = {};
  for (const l of lines) {
    const key = l.containerName || 'unknown';
    if (!streams[key]) streams[key] = [];
    const ts = new Date(l.timestamp).getTime() * 1000000; // nanoseconds
    streams[key].push([String(ts), l.line]);
  }

  const payload = {
    streams: Object.entries(streams).map(([name, values]) => ({
      stream: { container: name, job: 'docker-dash' },
      values,
    })),
  };

  await _httpPost(collectorPath(config.url, '/loki/api/v1/push'), payload, config.headers || {});
}

// ─── Elasticsearch Bulk API ─────────────────────────────────
async function _sendElasticsearch(config, lines) {
  const index = config.index || 'docker-dash-logs';
  let bulk = '';
  for (const l of lines) {
    bulk += JSON.stringify({ index: { _index: index } }) + '\n';
    bulk += JSON.stringify({
      '@timestamp': l.timestamp,
      container_name: l.containerName,
      container_id: l.containerId,
      message: l.line,
    }) + '\n';
  }

  const data = await _httpPost(collectorPath(config.url, '/_bulk'), bulk, {
    'Content-Type': 'application/x-ndjson',
    ...(config.headers || {}),
  }, true);
  let response;
  try { response = JSON.parse(data); } catch { /* Report malformed acknowledgements below. */ }
  if (response?.errors !== false) {
    const rejected = Array.isArray(response?.items) ? response.items.filter(item => item?.index?.status >= 300).length : 0;
    const reason = rejected ? 'Elasticsearch rejected one or more log entries.' : 'Elasticsearch did not return a successful bulk acknowledgement.';
    throw Object.assign(new Error(reason), { details: { reason, ...(rejected ? { rejected } : {}) } });
  }
}

// ─── Generic HTTP Webhook ───────────────────────────────────
async function _sendHttp(config, lines) {
  const payload = {
    source: 'docker-dash',
    timestamp: new Date().toISOString(),
    logs: lines.map(l => ({
      timestamp: l.timestamp,
      container: l.containerName,
      containerId: l.containerId,
      message: l.line,
    })),
  };

  await _httpPost(config.url, payload, config.headers || {});
}

// ─── Syslog (UDP/TCP, RFC 5424) ────────────────────────────
async function _sendSyslog(config, lines) {
  const host = config.host || 'localhost';
  const port = parseInt(config.port) || 514;
  const protocol = (config.protocol || 'udp').toLowerCase();
  const facility = 1; // user-level
  const severity = 6; // informational
  const priority = facility * 8 + severity;

  for (const l of lines) {
    const ts = new Date(l.timestamp).toISOString();
    // RFC 5424 format
    const msg = `<${priority}>1 ${ts} docker-dash ${l.containerName || '-'} - - - ${l.line}`;

    if (protocol === 'udp') {
      await new Promise((resolve, reject) => {
        const client = dgram.createSocket(net.isIP(host) === 6 ? 'udp6' : 'udp4');
        const buf = Buffer.from(msg);
        client.send(buf, 0, buf.length, port, host, (err) => {
          client.close();
          if (err) reject(err); else resolve();
        });
      });
    } else {
      await new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.connect(port, host, () => {
          client.write(msg + '\n', () => { client.end(); resolve(); });
        });
        client.on('error', reject);
        client.setTimeout(5000, () => { client.destroy(); reject(Object.assign(new Error('Syslog TCP timeout'), { code: 'ETIMEDOUT' })); });
      });
    }
  }
}

// ─── Shared HTTP POST helper ────────────────────────────────
function _httpPost(url, body, extraHeaders = {}, rawBody = false) {
  return new Promise((resolve, reject) => {
    const parsedUrl = httpUrl(url);
    if (!parsedUrl) return reject(new Error('Invalid collector URL'));

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = rawBody ? body : JSON.stringify(body);

    const custom = Object.fromEntries(Object.entries(extraHeaders).filter(([name]) => !/^(content-length|transfer-encoding)$/i.test(name)));
    const headers = {
      'Content-Type': rawBody ? (extraHeaders['Content-Type'] || 'text/plain') : 'application/json',
      ...custom,
      'Content-Length': Buffer.byteLength(payload),
    };

    const req = transport.request({
      method: 'POST',
      hostname: parsedUrl.hostname.replace(/^\[|\]$/g, ''),
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers,
      rejectUnauthorized: true,
    }, (res) => {
      res.on('error', reject);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const details = httpDiagnostic(res.statusCode, res.headers['retry-after']);
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { details }));
        res.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      if (rawBody) res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('Bulk acknowledgement exceeded the size limit'));
          res.destroy();
        } else chunks.push(chunk);
      });
      else res.resume();
      res.on('end', () => resolve(rawBody ? Buffer.concat(chunks).toString('utf8') : undefined));
    });

    req.on('error', reject);
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('HTTP POST timeout'), { code: 'ETIMEDOUT' })), 15000).unref();
    req.once('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

/**
 * Test a forwarder by sending a test log line.
 */
async function testForwarder(forwarder) {
  let config;
  try { config = JSON.parse(decrypt(forwarder.config_json_encrypted)); }
  catch { throw new Error('Failed to decrypt forwarder config'); }

  const testLines = [{
    containerName: 'docker-dash-test',
    containerId: 'test-0000',
    line: 'Docker Dash log forwarder test message — ' + new Date().toISOString(),
    timestamp: new Date().toISOString(),
  }];

  switch (forwarder.type) {
    case 'loki': await _sendLoki(config, testLines); break;
    case 'elasticsearch': await _sendElasticsearch(config, testLines); break;
    case 'http': await _sendHttp(config, testLines); break;
    case 'syslog': await _sendSyslog(config, testLines); break;
    default: throw new Error('Unknown forwarder type: ' + forwarder.type);
  }

  const udp = forwarder.type === 'syslog' && (config.protocol || 'udp').toLowerCase() === 'udp';
  return { ok: true, message: udp ? 'Test datagram sent. Check the Syslog collector for receipt.' : 'Test message sent successfully' };
}

/**
 * Stop all flush timers (for graceful shutdown).
 */
function stopAll() {
  for (const [, buf] of _buffers) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  _buffers.clear();
}

module.exports = { ingestLine, testForwarder, discardBuffer, stopAll };
