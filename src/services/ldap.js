'use strict';

/**
 * LDAP / Active Directory authentication service
 *
 * Supports:
 *  - LDAP (plain, port 389) and LDAPS (TLS, port 636)
 *  - Simple bind (username + password)
 *  - Service account bind + user search
 *  - Group membership filtering
 *  - Attribute mapping (uid, mail, displayName)
 *
 * Config stored in `settings` table under key `ldap_config` (JSON).
 */

const ldap = require('ldapjs');
const { getDb } = require('../db');
const log = require('../utils/logger')('ldap');

const CONFIG_KEY = 'ldap_config';

// ── Config CRUD ──────────────────────────────────────────────

function getConfig() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG_KEY);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function saveConfig(cfg) {
  const db = getDb();
  const json = JSON.stringify(cfg);
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

// ── LDAP client factory ──────────────────────────────────────

function _createClient(cfg) {
  const url = `${cfg.tls ? 'ldaps' : 'ldap'}://${cfg.host}:${cfg.port || (cfg.tls ? 636 : 389)}`;
  return ldap.createClient({
    url,
    timeout: 5000,
    connectTimeout: 5000,
    tlsOptions: cfg.tls && cfg.tlsSkipVerify ? { rejectUnauthorized: false } : undefined,
  });
}

function _bind(client, dn, password) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function _search(client, base, options) {
  return new Promise((resolve, reject) => {
    client.search(base, options, (err, res) => {
      if (err) return reject(err);
      const entries = [];
      res.on('searchEntry', e => entries.push(e.object));
      res.on('error', reject);
      res.on('end', () => resolve(entries));
    });
  });
}

function _destroy(client) {
  try { client.destroy(); } catch { /* ignore */ }
}

// ── Core operations ─────────────────────────────────────────

/**
 * Test connection — bind with service account and do a simple search
 */
async function testConnection(cfg) {
  const client = _createClient(cfg);
  try {
    await _bind(client, cfg.bindDn, cfg.bindPassword);
    const entries = await _search(client, cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter || '(objectClass=person)',
      attributes: [cfg.uidAttr || 'uid'],
      sizeLimit: 1,
      timeLimit: 5,
    });
    return { ok: true, usersFound: entries.length };
  } finally {
    _destroy(client);
  }
}

/**
 * Authenticate a user via LDAP
 * Returns user object on success, throws on failure
 */
async function authenticate(username, password) {
  const cfg = getConfig();
  if (!cfg || !cfg.enabled) return null; // LDAP not configured/enabled

  const client = _createClient(cfg);
  try {
    // Step 1: Bind with service account to find the user DN
    await _bind(client, cfg.bindDn, cfg.bindPassword);

    const uidAttr = cfg.uidAttr || 'uid';
    const filter = cfg.userFilter
      ? `(&${cfg.userFilter}(${uidAttr}=${ldap.escapeFilter(username)}))`
      : `(${uidAttr}=${ldap.escapeFilter(username)})`;

    const entries = await _search(client, cfg.baseDn, {
      scope: 'sub',
      filter,
      attributes: [uidAttr, 'mail', 'displayName', 'cn', 'memberOf'],
      sizeLimit: 1,
      timeLimit: 5,
    });

    if (!entries.length) {
      log.warn(`LDAP: user "${username}" not found`);
      return null;
    }

    const entry = entries[0];
    const userDn = entry.dn;

    // Step 2: Bind as the user to verify password
    const userClient = _createClient(cfg);
    try {
      await _bind(userClient, userDn, password);
    } finally {
      _destroy(userClient);
    }

    // Step 3: Check group membership (if configured)
    if (cfg.requiredGroup) {
      const memberOf = [].concat(entry.memberOf || []);
      const inGroup = memberOf.some(g =>
        g.toLowerCase() === cfg.requiredGroup.toLowerCase() ||
        g.toLowerCase().includes(cfg.requiredGroup.toLowerCase())
      );
      if (!inGroup) {
        log.warn(`LDAP: user "${username}" not in required group "${cfg.requiredGroup}"`);
        throw new Error('User is not in the required LDAP group');
      }
    }

    // Map attributes to Docker Dash user profile
    const mail = [].concat(entry.mail || [])[0] || `${username}@ldap`;
    const displayName = entry.displayName || entry.cn || username;

    log.info(`LDAP: authenticated user "${username}" (${userDn})`);
    return {
      ldapDn: userDn,
      username,
      email: mail,
      displayName,
      source: 'ldap',
    };
  } finally {
    _destroy(client);
  }
}

/**
 * List users from LDAP directory (for preview/sync)
 */
async function listUsers(cfg, limit = 50) {
  const client = _createClient(cfg);
  try {
    await _bind(client, cfg.bindDn, cfg.bindPassword);
    const uidAttr = cfg.uidAttr || 'uid';
    const entries = await _search(client, cfg.baseDn, {
      scope: 'sub',
      filter: cfg.userFilter || '(objectClass=person)',
      attributes: [uidAttr, 'mail', 'displayName', 'cn'],
      sizeLimit: limit,
      timeLimit: 10,
    });
    return entries.map(e => ({
      dn: e.dn,
      username: [].concat(e[uidAttr] || [])[0] || e.cn,
      email: [].concat(e.mail || [])[0] || '',
      displayName: e.displayName || e.cn || '',
    }));
  } finally {
    _destroy(client);
  }
}

module.exports = { getConfig, saveConfig, deleteConfig, testConnection, authenticate, listUsers };
