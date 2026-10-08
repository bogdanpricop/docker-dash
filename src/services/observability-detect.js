'use strict';

// Observability stack detection — v7.2.0 (probe added v7.6.0)
//
// Scans the local Docker daemon for running Prometheus / Grafana
// containers. Used by the in-app wizard at /system/observability to
// decide which of the three UX branches to render:
//   (A) both found → integration path (scrape config + dashboard import)
//   (B) one found  → partial-stack guidance
//   (C) none found → deploy-ours guidance
//
// v7.6.0 adds reachability probing — once the wizard has a containerId,
// it can ask "is this Prometheus actually responding to /-/healthy and is
// this Grafana responding to /api/health?". Two failure modes the original
// image-prefix-only detection couldn't catch: (1) container running but
// the process inside it crashed; (2) container running but on a different
// network so we can't actually reach it.
//
// Pure detection — never modifies Docker state, never throws, logs a
// warn on unexpected errors and returns null slots. Admin-gated at the
// route layer so this runs only from the wizard page.

const http = require('http');
const log = require('../utils/logger')('obs-detect');

// Image-name prefixes we recognize. Users who run renamed images (private
// mirror, custom tag) aren't detected — acceptable edge case; they already
// know what monitoring they have and can use the manual-entry path.
const PROMETHEUS_IMAGE_PATTERNS = [
  'prom/prometheus',
  'prometheus-community/',
  'bitnami/prometheus',
];

const GRAFANA_IMAGE_PATTERNS = [
  'grafana/grafana',
  'grafana/grafana-enterprise',
  'bitnami/grafana',
];

function _matchesAny(image, patterns) {
  const lower = String(image || '').toLowerCase();
  return patterns.some(p => lower.startsWith(p));
}

function _cleanName(names) {
  if (!Array.isArray(names) || names.length === 0) return '';
  return String(names[0] || '').replace(/^\//, '');
}

function _containerPort(ports, internalPort) {
  if (!Array.isArray(ports)) return null;
  const found = ports.find(p => p.PrivatePort === internalPort && p.PublicPort);
  return found ? found.PublicPort : null;
}

/**
 * Detect running Prometheus + Grafana containers on the local Docker daemon.
 *
 * @param {object} dockerService - the project's dockerService (src/services/docker.js)
 * @returns {Promise<{
 *   prometheus: null | {containerId, name, image, internalUrl, externalPort},
 *   grafana:    null | {containerId, name, image, internalUrl, externalPort},
 *   dockerDashContainerId: null | string,
 * }>}
 */
async function detect(dockerService) {
  const result = {
    prometheus: null,
    grafana: null,
    dockerDashContainerId: null,
  };

  let containers = [];
  try {
    const docker = dockerService.getDocker(0);
    containers = await docker.listContainers({ all: false });
  } catch (err) {
    log.warn('listContainers failed during detection', { message: err.message });
    return result;
  }

  for (const c of containers) {
    const name = _cleanName(c.Names);
    const image = c.Image || '';

    if (!result.prometheus && _matchesAny(image, PROMETHEUS_IMAGE_PATTERNS)) {
      result.prometheus = {
        containerId: (c.Id || '').substring(0, 12),
        name,
        image,
        // Internal URL is what OTHER containers on the same Docker network
        // would use. The wizard shows this in the scrape-config snippet.
        internalUrl: name ? `http://${name}:9090` : null,
        // External port (host-published) — shown if the user wants to hit
        // Prometheus from a browser. null if not exposed.
        externalPort: _containerPort(c.Ports, 9090),
      };
    }

    if (!result.grafana && _matchesAny(image, GRAFANA_IMAGE_PATTERNS)) {
      result.grafana = {
        containerId: (c.Id || '').substring(0, 12),
        name,
        image,
        internalUrl: name ? `http://${name}:3000` : null,
        externalPort: _containerPort(c.Ports, 3000),
      };
    }

    // Identify our own container so the scrape-config snippet uses the
    // correct target name. Falls back to 'app' (the compose service name).
    if (!result.dockerDashContainerId && /docker-dash(?!-redis|-prometheus|-grafana|-caddy)/.test(name)) {
      result.dockerDashContainerId = (c.Id || '').substring(0, 12);
    }
  }

  log.debug('Detection result', {
    prometheus: result.prometheus?.name || null,
    grafana: result.grafana?.name || null,
    self: result.dockerDashContainerId || null,
  });

  return result;
}

/**
 * v7.6.0 — Probe a single HTTP endpoint and return reachability.
 * Used by the wizard to verify that detected containers are actually
 * responding (not just running). 2-second timeout — we're probing
 * containers on the same Docker network or localhost; anything slower
 * than that is effectively unreachable for UX purposes.
 *
 * @param {string} urlString  e.g. "http://docker-dash-prometheus:9090/-/healthy"
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
function _probe(urlString) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlString); }
    catch (err) { return resolve({ ok: false, error: 'invalid URL' }); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return resolve({ ok: false, error: 'unsupported protocol' });
    }
    const lib = url.protocol === 'https:' ? require('https') : http;
    const req = lib.request(url, {
      method: 'GET',
      timeout: 2000,
      rejectUnauthorized: true,
    }, (res) => {
      // Drain to free the socket
      res.on('data', () => {});
      res.on('end', () => {
        // Healthy = any 2xx. Some Grafana versions answer 401 to /api/health
        // when auth is locked down — treat that as "reachable" with a note.
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

/**
 * v7.6.0 — Probe both detected services (if present). Returns a map of
 * { prometheus, grafana } each with { ok, status?, error?, url } so the
 * wizard can render a status pill per service.
 *
 * @param {object} detection - the result of detect()
 */
async function probe(detection) {
  const result = { prometheus: null, grafana: null };

  if (detection.prometheus?.internalUrl) {
    const url = `${detection.prometheus.internalUrl}/-/healthy`;
    result.prometheus = { url, ...(await _probe(url)) };
  }
  if (detection.grafana?.internalUrl) {
    const url = `${detection.grafana.internalUrl}/api/health`;
    result.grafana = { url, ...(await _probe(url)) };
  }

  return result;
}

module.exports = {
  detect,
  probe,
  _internals: { PROMETHEUS_IMAGE_PATTERNS, GRAFANA_IMAGE_PATTERNS, _matchesAny, _cleanName, _containerPort, _probe },
};
