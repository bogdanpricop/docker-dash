'use strict';

const { randomBytes, randomUUID } = require('crypto');
const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registry = require('../provider-sdk/registry');
const resourceSnapshots = require('../provider-sdk/resource-snapshots');
const identityStore = require('../provider-sdk/identity-store');
const access = require('./access');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

class ProviderConsoleError extends Error {
  constructor(message, code = 'PROVIDER_CONSOLE_ERROR', status = 400) {
    super(message);
    this.name = 'ProviderConsoleError';
    this.code = code;
    this.status = status;
  }
}

function _blocker(type, reason, evidence = null) {
  return { type, reason: String(reason || 'Console is unavailable').slice(0, 500), evidence };
}

async function preflightForHost(host, resourceId, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) {
    throw new ProviderConsoleError('Valid provider host required', 'INVALID_HOST');
  }
  const id = access.normalizeResourceId(resourceId);
  const database = options.database || getDb();
  let resource = resourceSnapshots.get(id, Number(host.id), 'virtualMachine', database);
  if (!resource || options.refresh === true) {
    try {
      const inventory = await (options.registry || registry).resourcesForHost(host, 'virtual-machines', {
        limit: 500, database,
      });
      resource = inventory.items.find(item => item.id === id) || null;
    } catch (err) {
      if (!resource) throw err;
    }
  }
  if (!resource) throw new ProviderConsoleError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);

  let capabilities;
  try { capabilities = await (options.registry || registry).capabilitiesForHost(host); }
  catch { capabilities = { probe: { status: 'unreachable' }, features: {} }; }
  const evidence = capabilities.features?.['vm.console'];
  const blockers = [];
  if (!evidence || !['supported', 'conditional'].includes(evidence.state)) {
    blockers.push(_blocker('CAPABILITY_UNSUPPORTED', evidence?.reason || 'The provider console adapter is unavailable', {
      capability: 'vm.console', state: evidence?.state || 'unsupported',
    }));
  }
  if (capabilities.probe?.status !== 'reachable') {
    blockers.push(_blocker('PROVIDER_UNREACHABLE', 'The provider endpoint is currently unreachable'));
  }
  if (!['running', 'paused'].includes(resource.status?.powerState)) {
    blockers.push(_blocker('RESOURCE_STATE_BLOCKED', 'The VM must be running before opening its console', {
      state: resource.status?.powerState || 'unknown',
    }));
  }
  if (!options.canOperate) {
    blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for VM console access'));
  }
  const lock = access.effective(Number(host.id), id, database);
  if (lock.locked) {
    blockers.push(_blocker('CONSOLE_ACCESS_LOCKED', lock.reason || 'VM console access is locked', {
      source: lock.source,
    }));
  }
  return {
    schemaVersion: '1.0', ready: blockers.length === 0,
    provider: { type: host.daemon_type, endpointId: Number(host.id) },
    resource: { id, displayName: resource.displayName, powerState: resource.status?.powerState || 'unknown' },
    token: {
      ttlSeconds: config.providerConsole.tokenTtlSeconds,
      singleUse: true, transport: 'same-origin-websocket', credentialIsolation: 'server-side',
    },
    capability: evidence || null, lock, blockers,
  };
}

function _cleanup(database) {
  database.prepare(`DELETE FROM provider_console_sessions
    WHERE julianday(COALESCE(closed_at, expires_at)) < julianday('now', '-1 day')`).run();
}

async function createForHost(host, resourceId, options = {}) {
  const database = options.database || getDb();
  const plan = await preflightForHost(host, resourceId, options);
  if (!plan.ready) {
    throw new ProviderConsoleError(plan.blockers[0].reason, plan.blockers[0].type, 409);
  }
  const userId = Number(options.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ProviderConsoleError('Authenticated user required', 'AUTHENTICATION_REQUIRED', 401);
  }
  _cleanup(database);
  const pendingForUser = database.prepare(`SELECT COUNT(*) AS count FROM provider_console_sessions
    WHERE user_id = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')`).get(userId).count;
  if (pendingForUser >= config.providerConsole.maxPendingPerUser) {
    throw new ProviderConsoleError('Too many pending console launch tokens', 'CONSOLE_TOKEN_RATE_LIMIT', 429);
  }
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + config.providerConsole.tokenTtlSeconds * 1000).toISOString();
  database.prepare(`INSERT INTO provider_console_sessions
    (id, token_hash, host_id, resource_id, provider_type, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, sha256(token), Number(host.id), plan.resource.id, String(host.daemon_type), userId, expiresAt
  );
  return {
    schemaVersion: '1.0', id: sessionId, token, expiresAt,
    resource: plan.resource, provider: plan.provider,
  };
}

function consume(token, userId, options = {}) {
  const database = options.database || getDb();
  const safeToken = String(token || '');
  const uid = Number(userId);
  if (!TOKEN_RE.test(safeToken) || !Number.isInteger(uid) || uid <= 0) {
    throw new ProviderConsoleError('Console launch token is invalid or expired', 'INVALID_CONSOLE_TOKEN', 401);
  }
  const hash = sha256(safeToken);
  const row = database.transaction(() => {
    const candidate = database.prepare(`SELECT * FROM provider_console_sessions
      WHERE token_hash = ? AND user_id = ? AND consumed_at IS NULL
        AND julianday(expires_at) > julianday('now')`).get(hash, uid);
    if (!candidate) return null;
    const changed = database.prepare(`UPDATE provider_console_sessions
      SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL`).run(candidate.id);
    return changed.changes === 1 ? candidate : null;
  })();
  if (!row) throw new ProviderConsoleError('Console launch token is invalid or expired', 'INVALID_CONSOLE_TOKEN', 401);
  const lock = access.effective(row.host_id, row.resource_id, database);
  if (lock.locked) {
    markClosed(row.id, 'access_locked', database);
    throw new ProviderConsoleError(lock.reason || 'VM console access is locked', 'CONSOLE_ACCESS_LOCKED', 423);
  }
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(row.host_id);
  if (!host) {
    markClosed(row.id, 'provider_unavailable', database);
    throw new ProviderConsoleError('Provider host is unavailable', 'PROVIDER_UNAVAILABLE', 409);
  }
  const identity = identityStore.resolveCanonical(row.resource_id, {
    hostId: row.host_id, kind: 'virtualMachine',
  }, database);
  if (!identity || identity.providerType !== row.provider_type) {
    markClosed(row.id, 'identity_unavailable', database);
    throw new ProviderConsoleError('Virtual machine identity is unavailable', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const resource = resourceSnapshots.get(row.resource_id, row.host_id, 'virtualMachine', database);
  return { ...row, host, identity, resource, lock };
}

function markConnected(id, protocol, database = getDb()) {
  database.prepare(`UPDATE provider_console_sessions SET connected_at = datetime('now'), protocol = ?
    WHERE id = ? AND connected_at IS NULL`).run(protocol, id);
}

function markClosed(id, code, database = getDb()) {
  database.prepare(`UPDATE provider_console_sessions SET closed_at = COALESCE(closed_at, datetime('now')),
    close_code = COALESCE(close_code, ?) WHERE id = ?`).run(String(code || 'closed').slice(0, 80), id);
}

module.exports = {
  ProviderConsoleError, TOKEN_RE, preflightForHost, createForHost, consume,
  markConnected, markClosed,
  _internals: { _blocker, _cleanup },
};
