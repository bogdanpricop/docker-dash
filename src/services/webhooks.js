'use strict';

const { getDb } = require('../db');
const { hmacSign } = require('../utils/crypto');
const { now, tryParseJson } = require('../utils/helpers');
const log = require('../utils/logger')('webhooks');

class WebhookService {
  /** Dispatch an event to all matching webhooks */
  async dispatch(eventType, payload) {
    const db = getDb();
    const hooks = db.prepare('SELECT * FROM webhooks WHERE is_active = 1').all();

    for (const hook of hooks) {
      const events = tryParseJson(hook.events, ['*']);
      if (!events.includes('*') && !events.includes(eventType)) continue;

      this._deliver(hook, eventType, payload).catch(e =>
        log.error('Webhook delivery failed', { hookId: hook.id, error: e.message })
      );
    }
  }

  async _deliver(hook, eventType, payload, attempt = 1) {
    const db = getDb();
    const body = JSON.stringify({ event: eventType, timestamp: now(), data: payload });
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'DockerDash/2.0',
      ...tryParseJson(hook.headers, {}),
    };

    if (hook.secret) {
      headers['X-Signature-256'] = 'sha256=' + hmacSign(body, hook.secret);
    }

    let responseCode = 0;
    let responseBody = '';
    let success = false;
    let error = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(hook.url, {
        method: hook.method || 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      responseCode = resp.status;
      responseBody = (await resp.text()).substring(0, 1000);
      success = resp.ok;
    } catch (e) {
      error = e.message;
    }

    db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event, payload, response_code, response_body, attempts, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(hook.id, eventType, body.substring(0, 5000), responseCode, responseBody, attempt, success ? 1 : 0, error);

    // Retry up to 3 times
    if (!success && attempt < 3) {
      const delay = attempt * 5000;
      setTimeout(() => this._deliver(hook, eventType, payload, attempt + 1), delay);
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────

  list() { return getDb().prepare('SELECT * FROM webhooks ORDER BY name').all(); }
  get(id) { return getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id); }

  create(data) {
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO webhooks (name, url, method, headers, secret, events, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.name, data.url, data.method || 'POST', JSON.stringify(data.headers || {}),
      data.secret || null, JSON.stringify(data.events || ['*']), data.is_active !== false ? 1 : 0,
      data.created_by || null);
    return { id: r.lastInsertRowid };
  }

  update(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];
    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.url !== undefined) { sets.push('url = ?'); params.push(data.url); }
    if (data.method !== undefined) { sets.push('method = ?'); params.push(data.method); }
    if (data.headers !== undefined) { sets.push('headers = ?'); params.push(JSON.stringify(data.headers)); }
    if (data.secret !== undefined) { sets.push('secret = ?'); params.push(data.secret); }
    if (data.events !== undefined) { sets.push('events = ?'); params.push(JSON.stringify(data.events)); }
    if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }
    sets.push('updated_at = ?'); params.push(now());
    params.push(id);
    db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id) {
    const db = getDb();
    db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  getDeliveries(hookId, { page = 1, limit = 20 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    return db.prepare(`
      SELECT * FROM webhook_deliveries WHERE webhook_id = ?
      ORDER BY delivered_at DESC LIMIT ? OFFSET ?
    `).all(hookId, limit, offset);
  }
}

module.exports = new WebhookService();
