'use strict';

// Caddy Admin API client over Unix socket — v6.5 Let's Encrypt Wizard
//
// The custom Caddy image (docker/caddy/Dockerfile) binds its admin endpoint
// to a Unix socket at /run/caddy/admin.sock. The same socket file is mounted
// (via the caddy-admin-sock Docker volume) into the Docker Dash app container
// at the same path. This means:
//   - User stacks on the same Docker network CANNOT reach the admin API
//   - Only containers that explicitly mount the volume can talk to it
//
// See docs/planning/v6.5/letsencrypt-wizard/03-deep-spec.md §10 for the
// security rationale (why this beats network isolation).

const http = require('http');
const log = require('../utils/logger')('caddy-config');

// Read per-call (not at module load) so tests can override after import.
function _socketPath() {
  return process.env.CADDY_ADMIN_SOCKET || '/run/caddy/admin.sock';
}

/**
 * Generic Caddy admin API call over Unix socket.
 * @param {string} method - GET/PUT/POST/DELETE/PATCH
 * @param {string} path - e.g. '/config/apps/tls/automation/policies'
 * @param {object} [body] - JSON body
 * @returns {Promise<object|null>}
 */
function caddyApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const socketPath = _socketPath();
    const opts = {
      socketPath,
      method,
      path,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      timeout: 10000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const error = new Error(`Caddy admin ${method} ${path} → ${res.statusCode}: ${data || '(no body)'}`);
          error.statusCode = res.statusCode;
          return reject(error);
        }
        if (!data) return resolve(null);
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); } // some endpoints return non-JSON
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ENOENT') {
        return reject(new Error(`Caddy admin socket not found at ${socketPath}. Is the Caddy container running with the caddy-admin-sock volume mounted?`));
      }
      if (err.code === 'ECONNREFUSED') {
        return reject(new Error(`Caddy admin socket exists but Caddy is not listening. Check the Caddy container.`));
      }
      reject(err);
    });
    req.on('timeout', () => { req.destroy(new Error(`Caddy admin ${method} ${path} timed out after 10s`)); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Fetch the entire Caddy config tree. */
async function fetchConfig() {
  return caddyApi('GET', '/config/');
}

/** Check whether a config sub-tree exists (returns true/false, never throws on 404). */
async function configPathExists(path) {
  try {
    await caddyApi('GET', '/config' + (path.startsWith('/') ? path : '/' + path));
    return true;
  } catch (e) {
    if (e.statusCode === 404 ||
        (e.statusCode === 400 && e.message.includes('invalid traversal path'))) return false;
    throw e;
  }
}

/**
 * Add an ACME-managed TLS policy to Caddy's config.
 *
 * Caddy's `apps/tls` sub-tree may not exist on first call (boot Caddyfile
 * may not have any TLS automation). The first ACME cert needs PUT to create
 * the structure; subsequent calls POST to append. Verified in preflight A1.
 *
 * @param {object} args
 * @param {string[]} args.subjects - domain list (e.g. ['api.example.com', '*.api.example.com'])
 * @param {string} args.email - ACME contact email
 * @param {'http-01'|'dns-01'} args.challengeType
 * @param {object} [args.providerConfig] - DNS provider config block (required for dns-01)
 * @param {boolean} [args.staging] - use Let's Encrypt staging endpoint
 * @returns {Promise<{policyIndex: number}>} - index of the new policy in the array
 */
async function addAcmePolicy({ subjects, email, challengeType, providerConfig, staging }) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new Error('subjects array required');
  }
  if (!email) throw new Error('email required');
  if (challengeType !== 'http-01' && challengeType !== 'dns-01') {
    throw new Error(`Invalid challengeType: ${challengeType}`);
  }
  if (challengeType === 'dns-01' && !providerConfig) {
    throw new Error('providerConfig required for dns-01 challenge');
  }

  const issuer = {
    module: 'acme',
    email,
  };
  if (staging) {
    issuer.ca = 'https://acme-staging-v02.api.letsencrypt.org/directory';
  }
  if (challengeType === 'dns-01') {
    issuer.challenges = { dns: { provider: providerConfig } };
  }

  const policy = { subjects, issuers: [issuer] };

  const tlsExists = await configPathExists('/apps/tls');

  if (!tlsExists) {
    // Bootstrap: PUT the whole tls app
    log.info('Caddy tls app does not exist; bootstrapping with first ACME policy', { subjects });
    await caddyApi('PUT', '/config/apps/tls', { automation: { policies: [policy] } });
    return { policyIndex: 0 };
  }

  // Append to existing policies array
  const existing = await caddyApi('GET', '/config/apps/tls/automation/policies');
  const newIndex = Array.isArray(existing) ? existing.length : 0;
  await caddyApi('POST', '/config/apps/tls/automation/policies', policy);
  log.info('Appended ACME policy to Caddy config', { subjects, policyIndex: newIndex });
  return { policyIndex: newIndex };
}

/**
 * Find the index of a policy whose `subjects` array matches the given list.
 * Returns -1 if not found.
 */
async function findAcmePolicyIndex(subjects) {
  const exists = await configPathExists('/apps/tls');
  if (!exists) return -1;
  const policies = await caddyApi('GET', '/config/apps/tls/automation/policies');
  if (!Array.isArray(policies)) return -1;
  const target = new Set(subjects);
  return policies.findIndex((p) =>
    Array.isArray(p.subjects) &&
    p.subjects.length === subjects.length &&
    p.subjects.every((s) => target.has(s))
  );
}

/**
 * Remove an ACME-managed policy by exact subject match.
 * @returns {Promise<boolean>} - true if removed, false if not found
 */
async function removeAcmePolicyBySubjects(subjects) {
  const idx = await findAcmePolicyIndex(subjects);
  if (idx === -1) return false;
  await caddyApi('DELETE', `/config/apps/tls/automation/policies/${idx}`);
  log.info('Removed ACME policy from Caddy config', { subjects, removedIndex: idx });
  return true;
}

/**
 * Remove an ACME-managed policy by index. Faster than the by-subjects variant
 * if you already know the index (we store it in acme_managed_certs.caddy_policy_index).
 * Note: indexes shift after each removal — callers must re-fetch indices for
 * batch operations.
 */
async function removeAcmePolicyByIndex(index) {
  await caddyApi('DELETE', `/config/apps/tls/automation/policies/${index}`);
  return true;
}

/** Health check: is Caddy admin reachable? */
async function isHealthy() {
  try {
    await caddyApi('GET', '/config/');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  caddyApi,
  fetchConfig,
  configPathExists,
  addAcmePolicy,
  findAcmePolicyIndex,
  removeAcmePolicyBySubjects,
  removeAcmePolicyByIndex,
  isHealthy,
};
