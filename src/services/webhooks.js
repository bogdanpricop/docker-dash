'use strict';

const { validateHeaderName, validateHeaderValue } = require('node:http');
const { getDb } = require('../db');
const { decrypt, encrypt, hmacSign } = require('../utils/crypto');
const { now, tryParseJson } = require('../utils/helpers');
const { networkDiagnostic, safeProviderText } = require('../utils/notification-diagnostics');
const httpUrl = require('../utils/http-url');
const log = require('../utils/logger')('webhooks');

const forbiddenHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'expect', 'proxy-authorization', 'x-signature-256']);
const invalid = message => Object.assign(new Error(message), { status: 400 });

function deliveryConfig({ url, headers = {}, secret }) {
  const endpoint = httpUrl(url);
  if (!endpoint || url.length > 4096) throw invalid('Webhook destination must be an HTTP or HTTPS URL without embedded credentials');
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 32) {
    throw invalid('Webhook headers must be an object with at most 32 entries');
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || value.length > 4096 || forbiddenHeaders.has(name.toLowerCase())) {
      throw invalid('Invalid webhook header');
    }
    try { validateHeaderName(name); validateHeaderValue(name, value); }
    catch { throw invalid('Invalid webhook header'); }
  }
  if (secret != null && (typeof secret !== 'string' || secret.length > 4096)) throw invalid('Invalid webhook signing secret');
  return { url: endpoint.href, headers: JSON.stringify(headers), secret: secret || null };
}

function eventList(value) {
  if (typeof value === 'string') return value.split(',').map(event => event.trim()).filter(Boolean);
  return Array.isArray(value) ? value : ['*'];
}

function matches(row, event) {
  const events = eventList(tryParseJson(row.events, []));
  return events.includes('*') || events.includes(event);
}

function storedConfig(row) {
  if (!row.delivery_config_enc) return { url: row.url, headers: row.headers, secret: row.secret };
  return JSON.parse(decrypt(row.delivery_config_enc));
}

function publicHook(row) {
  const { delivery_config_enc, secret, headers, url, ...info } = row;
  try {
    const delivery = storedConfig({ delivery_config_enc, secret, headers, url });
    return { ...info, url: httpUrl(delivery.url)?.origin || '', hasSecret: Boolean(delivery.secret),
      hasCustomHeaders: Object.keys(tryParseJson(delivery.headers, {}) || {}).length > 0 };
  } catch {
    return { ...info, url: '', configurationUnavailable: true };
  }
}

async function readResponse(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes).toString('utf8');
      bytes += value.byteLength;
      if (bytes > 4096) return '';
      chunks.push(Buffer.from(value));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function methodOf(method) {
  if (typeof method !== 'string' || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    throw invalid('Webhook method must be POST, PUT, PATCH or DELETE');
  }
  return method.toUpperCase();
}

class WebhookService {
  async dispatch(eventType, payload) {
    const hooks = getDb().prepare('SELECT * FROM webhooks WHERE is_active = 1').all();
    for (const hook of hooks) {
      if (!matches(hook, eventType)) continue;
      this._deliver(hook, eventType, payload).catch(() => log.warn('Webhook delivery could not be recorded', { hookId: hook.id }));
    }
  }

  async test(id) {
    const hook = this._get(id);
    if (!hook) throw Object.assign(new Error('Webhook not found'), { status: 404 });
    return this._deliver(hook, 'test', { message: 'Test event from Docker Dash' }, 1, true);
  }

  async _deliver(hook, eventType, payload, attempt = 1, test = false) {
    const db = getDb();
    const current = this._get(hook.id);
    if (!current || current.delivery_config_enc !== hook.delivery_config_enc || current.method !== hook.method
      || (!test && (!current.is_active || !matches(current, eventType)))) return { ok: false };
    const body = JSON.stringify({ event: eventType, timestamp: now(), data: payload });
    let responseCode = 0, responseBody = '', success = false, error = null;
    let retryable = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const saved = storedConfig(current);
      const config = deliveryConfig({ ...saved, headers: tryParseJson(saved.headers, {}) });
      const customHeaders = JSON.parse(config.headers);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'DockerDash/2.0', ...customHeaders };
      if (config.secret) headers['X-Signature-256'] = 'sha256=' + hmacSign(body, config.secret);

      retryable = true;
      const response = await fetch(config.url, {
        method: methodOf(hook.method),
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      responseCode = response.status;
      retryable = responseCode >= 500 || responseCode === 408 || responseCode === 429;
      responseBody = safeProviderText(await readResponse(response), [config.url, config.secret, ...Object.values(customHeaders)]) || '';
      success = response.ok;
      if (responseCode >= 300 && responseCode < 400) error = 'Webhook redirects are blocked. Configure the final URL.';
    } catch (failure) {
      error = networkDiagnostic(failure).reason || (failure.status === 400 ? failure.message : 'Webhook request failed');
    } finally {
      clearTimeout(timeout);
    }

    if (this._get(hook.id)) {
      db.prepare(`
        INSERT INTO webhook_deliveries (webhook_id, event, payload, response_code, response_body, attempts, success, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(hook.id, eventType, body.substring(0, 5000), responseCode, responseBody, attempt, success ? 1 : 0, error);
    }
    if (!test && !success && retryable && attempt < 3) {
      const retry = setTimeout(() => {
        this._deliver(hook, eventType, payload, attempt + 1)
          .catch(() => log.warn('Webhook retry could not be recorded', { hookId: hook.id }));
      }, attempt * 5000);
      retry.unref();
    }
    return { ok: success, status: responseCode, ...(error ? { error } : {}) };
  }

  _get(id) { return getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id); }
  get(id) {
    const row = this._get(id);
    return row && publicHook(row);
  }
  list() { return getDb().prepare('SELECT * FROM webhooks ORDER BY name').all().map(publicHook); }

  create(data) {
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200) throw invalid('Webhook name is required');
    const config = deliveryConfig(data);
    const result = getDb().prepare(`
      INSERT INTO webhooks (name, url, method, delivery_config_enc, events, is_active, created_by)
      VALUES (?, '', ?, ?, ?, ?, ?)
    `).run(data.name.trim(), methodOf(data.method ?? 'POST'), encrypt(JSON.stringify(config)),
      JSON.stringify(eventList(data.events)), data.is_active === false || data.is_active === 0 ? 0 : 1, data.created_by || null);
    return { id: result.lastInsertRowid };
  }

  update(id, data) {
    const row = this._get(id);
    if (!row) throw Object.assign(new Error('Webhook not found'), { status: 404 });
    const name = data.name ?? row.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw invalid('Webhook name is required');
    let encoded = row.delivery_config_enc;
    if (data.url !== undefined || data.headers !== undefined || data.secret !== undefined || !encoded) {
      const current = storedConfig(row);
      const config = deliveryConfig({
        url: data.url ?? current.url,
        headers: data.headers === undefined ? tryParseJson(current.headers, {}) : data.headers,
        secret: data.secret === undefined ? current.secret : data.secret,
      });
      encoded = encrypt(JSON.stringify(config));
    }
    getDb().prepare(`
      UPDATE webhooks SET name = ?, method = ?, url = '', headers = '{}', secret = NULL,
        delivery_config_enc = ?, events = ?, is_active = ?, updated_at = ? WHERE id = ?
    `).run(name.trim(), methodOf(data.method ?? row.method), encoded,
      data.events === undefined ? row.events : JSON.stringify(eventList(data.events)),
      data.is_active === undefined ? row.is_active : Number(Boolean(data.is_active)), now(), id);
  }

  delete(id) {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
      db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    })();
  }

  getDeliveries(hookId, { page = 1, limit = 20 } = {}) {
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const offset = (Math.min(100000, Math.max(1, page)) - 1) * boundedLimit;
    return getDb().prepare(`
      SELECT * FROM webhook_deliveries WHERE webhook_id = ?
      ORDER BY delivered_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(hookId, boundedLimit, offset);
  }
}

module.exports = new WebhookService();
