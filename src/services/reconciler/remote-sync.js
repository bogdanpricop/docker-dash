'use strict';

// v8.9.44-alpha.1 — Reconciler remote sync (GitOps pull). A blueprint can name a
// remote HTTPS(S) URL as its desired-state source of truth. syncNow fetches that
// URL (Node stdlib https, no deps), JSON.parses it, runs it through the EXISTING
// validateDoc, and — only on success — updates the blueprint's doc. On any failure
// it records last_sync_status='error' + last_sync_error and leaves the good doc
// untouched. The optional Bearer token is encrypted at rest and never returned.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('../../utils/crypto');

function _db() { return require('../../db').getDb(); }

// http(s)-only URL validation (SSRF surface is admin-gated + audited; this rejects
// file:/ftp:/gopher: etc.). Returns the canonical URL string. Throws on anything else.
function _validateUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('source url is required');
  let u;
  try { u = new URL(s); } catch { throw new Error('source url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('source url must be http(s)');
  return u.toString();
}

// Dependency-free GET (Node stdlib), mirrors src/services/copilot/llm.js. Unlike
// the LLM client we KEEP default TLS verification — a GitOps source is a managed
// HTTPS endpoint, not a self-signed local box. Optional Bearer, 10s timeout, 4MB
// cap. Resolves the raw body string.
function _httpGet(url, token, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`bad url: ${e.message}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', 'User-Agent': 'docker-dash-reconciler' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(u, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; if (data.length > 4e6) req.destroy(new Error('remote response too large')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`remote HTTP ${res.statusCode}`));
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('remote request timed out')));
    req.on('error', reject);
    req.end();
  });
}

// Injection seam for tests: override _client.fetch to avoid the network.
const _client = { fetch: _httpGet };

// ── Source config (token redacted on read) ──────────────────
function setSource(id, { url, token, clearToken, autoSync, intervalMin } = {}) {
  const db = _db();
  const row = db.prepare('SELECT id, source_token_enc FROM blueprints WHERE id = ?').get(id);
  if (!row) throw new Error('Blueprint not found');
  const normUrl = _validateUrl(url);
  let tokenEnc = row.source_token_enc || null;
  if (clearToken) tokenEnc = null;
  else if (token) tokenEnc = crypto.encrypt(String(token));
  let interval = parseInt(intervalMin, 10);
  if (!Number.isFinite(interval) || interval < 1) interval = 60;
  db.prepare(`UPDATE blueprints SET
      source_url = ?, source_token_enc = ?, source_auto_sync = ?, source_interval_min = ?,
      updated_at = datetime('now') WHERE id = ?`)
    .run(normUrl, tokenEnc, autoSync ? 1 : 0, interval, id);
  return getSource(id);
}

// NEVER returns the token — only hasToken. Safe to send to the client.
function getSource(id) {
  const row = _db().prepare(`SELECT source_url, source_token_enc, source_auto_sync, source_interval_min,
      last_synced_at, last_sync_status, last_sync_error FROM blueprints WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    url: row.source_url || null,
    hasToken: !!row.source_token_enc,
    autoSync: !!row.source_auto_sync,
    intervalMin: row.source_interval_min || 60,
    lastSyncedAt: row.last_synced_at || null,
    lastSyncStatus: row.last_sync_status || null,
    lastSyncError: row.last_sync_error || null,
  };
}

// Fetch → parse → validateDoc → store. On failure: record error, keep good doc.
async function syncNow(id, user) {
  const rec = require('./index');
  const db = _db();
  const row = db.prepare('SELECT id, source_url, source_token_enc, doc FROM blueprints WHERE id = ?').get(id);
  if (!row) throw new Error('Blueprint not found');
  if (!row.source_url) throw new Error('No remote source configured for this blueprint');
  let token = null;
  if (row.source_token_enc) { try { token = crypto.decrypt(row.source_token_enc); } catch { token = null; } }
  try {
    const body = await _client.fetch(row.source_url, token);
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { throw new Error(`remote is not valid JSON: ${e.message}`); }
    const norm = rec.validateDoc(parsed); // throws with per-rule context on bad
    const nextJson = JSON.stringify(norm);
    const changed = row.doc !== nextJson;
    db.prepare(`UPDATE blueprints SET doc = ?, last_synced_at = datetime('now'),
        last_sync_status = 'ok', last_sync_error = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(nextJson, id);
    const summary = { changed, hosts: Object.keys(norm.hosts || {}).length };
    rec.recordRun(id, 'sync', summary, (user && user.username) || 'system');
    return { ok: true, changed, summary };
  } catch (e) {
    db.prepare(`UPDATE blueprints SET last_synced_at = datetime('now'),
        last_sync_status = 'error', last_sync_error = ? WHERE id = ?`)
      .run(String(e.message).slice(0, 500), id);
    return { ok: false, changed: false, error: e.message };
  }
}

module.exports = {
  setSource, getSource, syncNow,
  _internals: { _validateUrl, _httpGet, _client },
};
