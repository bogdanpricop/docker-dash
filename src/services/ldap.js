'use strict';

/**
 * LDAP / Active Directory authentication service
 *
 * Supports:
 *  - LDAP with mandatory StartTLS (port 389) and LDAPS (port 636)
 *  - Simple bind (username + password)
 *  - Service account bind + user search
 *  - Group membership filtering
 *  - Attribute mapping (uid, mail, displayName)
 *
 * Config stored in `settings` table under key `ldap_config` (JSON).
 *
 * Implementation uses `ldapts` (modern Promise-based LDAP client).
 * The public interface (getConfig / saveConfig / deleteConfig / testConnection /
 * authenticate / listUsers) is preserved bit-for-bit against the previous
 * `ldapjs` implementation so callers do not need to change.
 */

const { Client } = require('ldapts');
const net = require('node:net');
const tls = require('node:tls');
const { tlsOptions } = require('../utils/provider-tls');
const { getDb } = require('../db');
const log = require('../utils/logger')('ldap');
const { encrypt, decrypt } = require('../utils/crypto');

const CONFIG_KEY = 'ldap_config';

// ── Config CRUD ──────────────────────────────────────────────

function getConfig() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG_KEY);
  if (!row) return null;
  let cfg;
  try { cfg = JSON.parse(row.value); } catch { return null; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  if (cfg.bindPasswordEncrypted) {
    cfg.bindPassword = decrypt(cfg.bindPasswordEncrypted);
    delete cfg.bindPasswordEncrypted;
  }
  return cfg;
}

function saveConfig(cfg) {
  _verifiedTls(cfg);
  if (cfg.host) _connectionSpec(cfg);
  const db = getDb();
  const stored = { ...cfg };
  delete stored.bindPasswordEncrypted;
  if (stored.bindPassword) stored.bindPasswordEncrypted = encrypt(stored.bindPassword);
  delete stored.bindPassword;
  const json = JSON.stringify(stored);
  const exists = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(CONFIG_KEY);
  if (exists) {
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(json, CONFIG_KEY);
  } else {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(CONFIG_KEY, json);
  }
}

function deleteConfig() {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(CONFIG_KEY);
}

// ── Filter escaping (RFC 4515) ───────────────────────────────
//
// `ldapjs` exposed `ldap.escapeFilter`. `ldapts` uses Filter classes that
// escape internally, but many callers build filter strings directly, so we
// keep a standalone helper with the same semantics.
//
// RFC 4515 specifies that '*', '(', ')', '\' and NUL must be encoded as
// '\xx' where xx is the two-hex-digit byte value. We also escape other
// low control bytes defensively.
function _escapeFilter(value) {
  if (value == null) return '';
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x00: out += '\\00'; break;
      case 0x28: out += '\\28'; break; // (
      case 0x29: out += '\\29'; break; // )
      case 0x2a: out += '\\2a'; break; // *
      case 0x5c: out += '\\5c'; break; // \
      default:   out += s[i];
    }
  }
  return out;
}

// ── LDAP client factory ──────────────────────────────────────

const invalidConfig = message => Object.assign(new Error(message), { status: 400, code: 'LDAP_TLS_REQUIRED' });

function _verifiedTls(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw invalidConfig('LDAP configuration is required');
  if (cfg.tls !== undefined && typeof cfg.tls !== 'boolean') throw invalidConfig('LDAP tls must be a boolean');
  if (cfg.tlsSkipVerify !== undefined && cfg.tlsSkipVerify !== false) {
    throw invalidConfig('LDAP certificate verification is required; configure a verified CA and disable the legacy TLS bypass');
  }
  return tlsOptions({ caCert: cfg.caCert });
}

function _connectionSpec(cfg) {
  const trust = _verifiedTls(cfg);
  const host = typeof cfg.host === 'string' ? cfg.host.replace(/^\[([^\]]+)\]$/, '$1') : '';
  if (!net.isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)) {
    throw invalidConfig('LDAP host must be a DNS name or IP address, without URL credentials, path or port');
  }
  const rawPort = cfg.port === undefined || cfg.port === null || cfg.port === '' ? (cfg.tls ? 636 : 389) : cfg.port;
  if (!/^\d+$/.test(String(rawPort)) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw invalidConfig('Invalid LDAP port');
  const port = Number(rawPort), authority = net.isIP(host) === 6 ? `[${host}]` : host;
  return { url: `${cfg.tls ? 'ldaps' : 'ldap'}://${authority}:${port}`, trust: {
    ...trust, host, ...(net.isIP(host) ? {} : { servername: host }),
    checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(host, certificate),
  } };
}

async function _createClient(cfg) {
  const { url, trust } = _connectionSpec(cfg);
  let plainConnections = 0;
  const client = new Client({
    url, timeout: 5000, connectTimeout: 5000, autoRebind: false,
    // ldapts interprets any tlsOptions as immediate TLS, even on ldap://.
    ...(cfg.tls ? { tlsOptions: trust } : {}),
    createConnection(...args) {
      if (++plainConnections > 1) throw invalidConfig('LDAP connection was lost; unencrypted reconnect refused');
      return net.connect(...args);
    },
    createSecureConnection(...args) {
      const socket = tls.connect(...args);
      // Absolute deadline: trickled handshake bytes must not reset the budget.
      const timer = setTimeout(() => socket.destroy(new Error('LDAP TLS handshake timed out')), 5000);
      timer.unref?.();
      socket.once('secureConnect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
      return socket;
    },
  });
  try {
    if (!cfg.tls) await client.startTLS(trust);
    return client;
  } catch (error) {
    await _destroy(client);
    throw error;
  }
}

async function _destroy(client) {
  try {
    await client.unbind();
  } catch {
    /* ignore — unbind can throw if already disconnected */
  }
}

/**
 * Normalize an ldapts search entry into the shape previous callers expect
 * from ldapjs (`entry.object`): a plain object with `dn` plus attribute
 * fields where single-valued attributes are strings, multi-valued are
 * arrays. ldapts already returns a similar shape from `SearchEntry.toObject()`
 * via the `searchEntries` collection, so mostly this is a pass-through.
 *
 * ldapts `Entry` value types: `Buffer | Buffer[] | string[] | string`.
 * For our use (uid, mail, displayName, cn, memberOf) we expect strings, but
 * we coerce Buffer values defensively to match the previous behavior where
 * ldapjs returned strings for these text attributes.
 */
function _normalizeEntry(entry) {
  const out = { dn: entry.dn };
  for (const k of Object.keys(entry)) {
    if (k === 'dn') continue;
    const v = entry[k];
    if (Buffer.isBuffer(v)) {
      out[k] = v.toString('utf8');
    } else if (Array.isArray(v)) {
      out[k] = v.map(x => Buffer.isBuffer(x) ? x.toString('utf8') : x);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Core operations ─────────────────────────────────────────

/**
 * Test connection — bind with service account and do a simple search
 */
async function testConnection(cfg) {
  const client = await _createClient(cfg);
  try {
    await client.bind(cfg.bindDn, cfg.bindPassword);
    const { searchEntries } = await client.search(cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter || '(objectClass=person)',
      attributes: [cfg.uidAttr || 'uid'],
      sizeLimit: 1,
      timeLimit: 5,
    });
    return { ok: true, usersFound: searchEntries.length };
  } finally {
    await _destroy(client);
  }
}

/**
 * Authenticate a user via LDAP
 * Returns user object on success, throws on failure
 */
async function authenticate(username, password) {
  // Empty passwords can turn an LDAP bind into anonymous authentication.
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) return null;
  const cfg = getConfig();
  if (!cfg || !cfg.enabled) return null; // LDAP not configured/enabled

  const client = await _createClient(cfg);
  try {
    // Step 1: Bind with service account to find the user DN
    await client.bind(cfg.bindDn, cfg.bindPassword);

    const uidAttr = cfg.uidAttr || 'uid';
    const filter = cfg.userFilter
      ? `(&${cfg.userFilter}(${uidAttr}=${_escapeFilter(username)}))`
      : `(${uidAttr}=${_escapeFilter(username)})`;

    const { searchEntries } = await client.search(cfg.baseDn, {
      scope: 'sub',
      filter,
      attributes: [uidAttr, 'mail', 'displayName', 'cn', 'memberOf'],
      sizeLimit: 1,
      timeLimit: 5,
    });

    if (!searchEntries.length) {
      log.warn(`LDAP: user "${username}" not found`);
      return null;
    }

    const entry = _normalizeEntry(searchEntries[0]);
    const userDn = entry.dn;

    // Step 2: Bind as the user to verify password
    const userClient = await _createClient(cfg);
    try {
      await userClient.bind(userDn, password);
    } finally {
      await _destroy(userClient);
    }

    // Step 3: Check group membership (if configured)
    if (cfg.requiredGroup) {
      const memberOf = [].concat(entry.memberOf || []);
      const inGroup = memberOf.some(g =>
        g.toLowerCase() === cfg.requiredGroup.toLowerCase()
      );
      if (!inGroup) {
        log.warn(`LDAP: user "${username}" not in required group "${cfg.requiredGroup}"`);
        throw new Error('User is not in the required LDAP group');
      }
    }

    // Map attributes to Docker Dash user profile
    const mail = [].concat(entry.mail || [])[0] || `${username}@ldap`;
    const displayName = [].concat(entry.displayName || entry.cn || username)[0];

    log.info(`LDAP: authenticated user "${username}" (${userDn})`);
    return {
      ldapDn: userDn,
      username,
      email: mail,
      displayName,
      source: 'ldap',
    };
  } finally {
    await _destroy(client);
  }
}

/**
 * List users from LDAP directory (for preview/sync)
 */
async function listUsers(cfg, limit = 50) {
  const client = await _createClient(cfg);
  try {
    await client.bind(cfg.bindDn, cfg.bindPassword);
    const uidAttr = cfg.uidAttr || 'uid';
    const { searchEntries } = await client.search(cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter || '(objectClass=person)',
      attributes: [uidAttr, 'mail', 'displayName', 'cn'],
      sizeLimit: limit,
      timeLimit: 10,
    });
    return searchEntries.map(raw => {
      const e = _normalizeEntry(raw);
      return {
        dn: e.dn,
        username: [].concat(e[uidAttr] || [])[0] || e.cn,
        email: [].concat(e.mail || [])[0] || '',
        displayName: e.displayName || e.cn || '',
      };
    });
  } finally {
    await _destroy(client);
  }
}

module.exports = { getConfig, saveConfig, deleteConfig, testConnection, authenticate, listUsers };
