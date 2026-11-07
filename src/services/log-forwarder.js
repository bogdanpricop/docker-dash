'use strict';

const http = require('http');
const https = require('https');
const dgram = require('dgram');
const net = require('net');
const { getDb } = require('../db');
const { decrypt } = require('../utils/crypto');
const log = require('../utils/logger')('log-forwarder');
const httpUrl = require('../utils/http-url');
const { httpDiagnostic, networkDiagnostic } = require('../utils/notification-diagnostics');
const config = require('../config');

// ─── Batch buffer per forwarder ─────────────────────────
const _buffers = new Map(); // forwarderId -> { lines: [], timer }
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFERED_LINES = 1000;
const MAX_RETRIES = 2;

/**
 * Add records from a container log stream to each enabled destination.
 */
function ingestLines(lines) {
  if (!lines.length || config.features.readOnly) return;
  let forwarders;
  try {
    forwarders = getDb().prepare('SELECT id FROM log_forwarders WHERE enabled = 1').all();
  } catch { return; }

  for (const { id } of forwarders) {
    if (!_buffers.has(id)) _buffers.set(id, { lines: [], retries: 0, dropped: 0 });
    const buffer = _buffers.get(id);
    const room = MAX_BUFFERED_LINES - buffer.lines.length;
    buffer.lines.push(...lines.slice(0, room));
    buffer.dropped += Math.max(0, lines.length - room);
    schedule(id, buffer);
  }
}

function schedule(id, buffer, retryDelay) {
  if (buffer.sending || !buffer.lines.length) return;
  const delay = retryDelay ?? (buffer.lines.length >= BATCH_SIZE ? 0 : FLUSH_INTERVAL_MS);
  if (buffer.timer && (buffer.retries || buffer.immediate || delay > 0)) return;
  clearTimeout(buffer.timer);
  buffer.immediate = delay === 0;
  buffer.timer = setTimeout(() => {
    buffer.timer = undefined;
    void flush(id, buffer);
  }, delay).unref();
}

function retryable(error) {
  const status = error.details?.httpStatus;
  return status === 408 || status === 429 || status >= 500 ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code);
}

function deliveryDiagnostic(error) {
  const details = error.details || networkDiagnostic(error);
  return { ...details, reason: details.reason || 'Docker Dash could not send the log batch.' };
}

function recordDelivery(destination, buffer, details, now) {
  if (!destination || _buffers.get(destination.id) !== buffer) return;
  try {
    const db = getDb();
    const where = 'WHERE id = ? AND enabled = 1 AND type = ? AND config_json_encrypted = ?';
    const identity = [destination.id, destination.type, destination.config_json_encrypted];
    const timestamp = new Date(now).toISOString();
    if (details) {
      db.prepare(`UPDATE log_forwarders SET last_delivery_error_at = ?, last_delivery_error_json = ? ${where}`)
        .run(timestamp, JSON.stringify(details), ...identity);
    } else {
      db.prepare(`UPDATE log_forwarders SET last_delivery_at = ? ${where}`).run(timestamp, ...identity);
    }
  } catch {
    // Recording the outcome must never cause an already delivered batch to be sent again.
    log.warn('Could not save log delivery status', { forwarderId: destination.id });
  }
}

async function flush(id, buffer) {
  if (_buffers.get(id) !== buffer || buffer.sending || !buffer.lines.length) return;
  buffer.sending = true;
  let retryDelay, lines, destination;
  try {
    destination = !config.features.readOnly &&
      getDb().prepare('SELECT * FROM log_forwarders WHERE id = ? AND enabled = 1').get(id);
    if (!destination) { discardBuffer(id); return; }
    lines = buffer.lines.splice(0, BATCH_SIZE);
    if (buffer.dropped) {
      log.warn('Log forwarding queue reached its limit', { forwarderId: id, dropped: buffer.dropped });
      buffer.dropped = 0;
    }
    await deliver(destination, lines);
    recordDelivery(destination, buffer, null, Date.now());
    buffer.retries = 0;
  } catch (error) {
    if (_buffers.get(id) !== buffer) return;
    const attempt = buffer.retries + 1;
    if (lines && retryable(error) && buffer.retries < MAX_RETRIES) {
      buffer.retries++;
      buffer.lines.unshift(...lines);
      if (buffer.lines.length > MAX_BUFFERED_LINES) {
        buffer.dropped += buffer.lines.length - MAX_BUFFERED_LINES;
        buffer.lines.length = MAX_BUFFERED_LINES;
      }
      retryDelay = Math.min(60000, Math.max(5000 * buffer.retries, (error.details?.retryAfterSeconds || 0) * 1000));
    } else {
      if (!lines) buffer.lines.splice(0, BATCH_SIZE);
      buffer.retries = 0;
      log.warn('Log batch could not be delivered', { forwarderId: id, lines: lines?.length, status: error.details?.httpStatus });
    }
    const now = Date.now();
    recordDelivery(destination, buffer, {
      ...deliveryDiagnostic(error),
      attempt,
      batchSize: lines?.length,
      ...(retryDelay && { retryAt: new Date(now + retryDelay).toISOString() }),
    }, now);
  } finally {
    buffer.sending = false;
    if (_buffers.get(id) === buffer) schedule(id, buffer, retryDelay);
  }
}

function discardBuffer(id) {
  const buffer = _buffers.get(id);
  if (buffer?.timer) clearTimeout(buffer.timer);
  _buffers.delete(id);
}

function collectorPath(value, suffix) {
  const url = httpUrl(value);
  if (!url) throw Object.assign(new Error('Invalid collector URL'), { code: 'ERR_INVALID_URL' });
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  return url.href;
}

// ─── Loki Push API ──────────────────────────────────────────
async function _sendLoki(config, lines) {
  const streams = new Map();
  for (const l of lines) {
    const labels = { container: l.containerName || 'unknown', job: 'docker-dash' };
    if (l.hostId != null) labels.host_id = String(l.hostId);
    if (l.stream) labels.stream = l.stream;
    const key = JSON.stringify(labels);
    if (!streams.has(key)) streams.set(key, { stream: labels, values: [] });
    const fraction = (/\.(\d{1,9})Z$/.exec(l.timestamp)?.[1] || '').padEnd(9, '0');
    const seconds = BigInt(Math.floor(Date.parse(l.timestamp) / 1000));
    const timestamp = (seconds * 1000000000n + BigInt(fraction)).toString();
    streams.get(key).values.push([timestamp, l.line]);
  }

  const payload = {
    streams: [...streams.values()],
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
      host_id: l.hostId,
      host_name: l.hostName,
      stream: l.stream,
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
    const statuses = Array.isArray(response?.items) ? response.items.map(item => item?.index?.status)
      .filter(status => Number.isInteger(status) && status >= 300 && status <= 599) : [];
    const rejected = statuses.length;
    const reason = rejected ? 'Elasticsearch rejected one or more log entries.' : 'Elasticsearch did not return a successful bulk acknowledgement.';
    throw Object.assign(new Error(reason), {
      details: { reason, ...(rejected && { rejected, itemStatuses: [...new Set(statuses)].sort() }) },
    });
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
      hostId: l.hostId,
      hostName: l.hostName,
      stream: l.stream,
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
    if (!parsedUrl) return reject(Object.assign(new Error('Invalid collector URL'), { code: 'ERR_INVALID_URL' }));

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
        details.reason = {
          400: 'The destination rejected the request. Check the expected payload and collector settings.',
          401: 'The destination rejected the credentials. Check the authentication headers.',
          403: 'The destination denied access. Check the permissions for this collector.',
          404: 'The destination endpoint was not found. Check the configured URL.',
          408: 'The destination timed out while handling the request.',
          410: 'The configured destination endpoint is gone.',
          413: 'The destination rejected the batch because the request was too large.',
          429: 'The destination is rate limiting requests.',
        }[res.statusCode] || details.reason || 'The destination returned an unsuccessful HTTP response.';
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { details }));
        res.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      if (rawBody) res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          const reason = 'The Elasticsearch bulk acknowledgement exceeded the 1 MiB response limit.';
          reject(Object.assign(new Error(reason), { details: { reason } }));
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
  const testLines = [{
    containerName: 'docker-dash-test',
    containerId: 'test-0000',
    line: 'Docker Dash log forwarder test message — ' + new Date().toISOString(),
    timestamp: new Date().toISOString(),
  }];

  const destination = await deliver(forwarder, testLines);
  const udp = forwarder.type === 'syslog' && (destination.protocol || 'udp').toLowerCase() === 'udp';
  return { ok: true, message: udp ? 'Test datagram sent. Check the Syslog collector for receipt.' : 'Test message sent successfully' };
}

async function deliver(forwarder, lines) {
  let destination;
  try { destination = JSON.parse(decrypt(forwarder.config_json_encrypted)); }
  catch {
    const reason = 'The saved destination settings could not be decrypted or read. Re-enter the destination settings.';
    throw Object.assign(new Error(reason), { details: { reason } });
  }
  switch (forwarder.type) {
    case 'loki': await _sendLoki(destination, lines); break;
    case 'elasticsearch': await _sendElasticsearch(destination, lines); break;
    case 'http': await _sendHttp(destination, lines); break;
    case 'syslog': await _sendSyslog(destination, lines); break;
    default: throw new Error('Unknown forwarder type');
  }
  return destination;
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

module.exports = { ingestLines, testForwarder, deliveryDiagnostic, discardBuffer, stopAll };
