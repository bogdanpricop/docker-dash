'use strict';

// Observability dashboard import — v7.2.0
//
// POSTs the bundled Docker Dash dashboard JSON to a user-provided Grafana
// instance via the /api/dashboards/db endpoint. Used by the in-app wizard
// at /system/observability when the user has an existing Grafana and
// wants to install our dashboard without manual upload.
//
// Also exports the Prometheus scrape-config YAML snippet — static,
// pure function, no I/O.

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const log = require('../utils/logger')('obs-import');

const DASHBOARD_JSON_PATH = path.join(
  __dirname, '..', '..',
  'docker', 'observability', 'grafana', 'dashboards',
  'docker-dash-overview.json'
);

/**
 * Load the bundled dashboard JSON as a JS object. Throws with a clear
 * message if the file is missing or malformed (shouldn't happen on a
 * correctly-built Docker Dash image — the file ships with the repo).
 */
function _loadDashboard() {
  let raw;
  try {
    raw = fs.readFileSync(DASHBOARD_JSON_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Dashboard JSON missing at ${DASHBOARD_JSON_PATH}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Dashboard JSON malformed: ${err.message}`);
  }
}

/**
 * POST the dashboard JSON to `<grafanaUrl>/api/dashboards/db`.
 *
 * @param {string} grafanaUrl - e.g. "http://grafana:3000" or "https://monitoring.example.com"
 * @param {string} token - Grafana service-account token with Dashboard:Write scope
 * @returns {Promise<{success: true, dashboardUid: string, dashboardUrl: string}>}
 * @throws {Error} on network failure, non-200 response, or Grafana API error
 */
async function importDashboard(grafanaUrl, token) {
  if (!grafanaUrl || !token) {
    throw new Error('grafanaUrl and token are required');
  }

  const dashboard = _loadDashboard();
  // Grafana expects { dashboard: {...}, overwrite: bool, message: string }
  // The file on disk is the bare dashboard body; wrap it.
  const payload = {
    dashboard,
    overwrite: true,
    message: 'Imported by Docker Dash observability wizard',
  };
  // Strip conflicting fields on re-import (Grafana complains about stale
  // id/version if left in).
  delete payload.dashboard.id;
  delete payload.dashboard.version;

  let url;
  try {
    url = new URL('/api/dashboards/db', grafanaUrl);
  } catch (err) {
    throw new Error(`Invalid grafanaUrl: ${err.message}`);
  }

  const body = JSON.stringify(payload);
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10000,
  };

  const response = await new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Grafana API timed out (10s) — check URL and network reachability'));
    });
    req.write(body);
    req.end();
  });

  if (response.status !== 200) {
    const snippet = response.body.substring(0, 300);
    log.warn('Grafana import failed', { status: response.status, bodySnippet: snippet });
    throw new Error(`Grafana returned HTTP ${response.status}: ${snippet}`);
  }

  let parsed = {};
  try { parsed = JSON.parse(response.body); } catch { /* tolerate non-JSON on success too */ }

  const dashboardUid = parsed.uid || 'docker-dash-overview';
  const dashboardUrl = parsed.url
    ? new URL(parsed.url, grafanaUrl).toString()
    : `${grafanaUrl.replace(/\/$/, '')}/d/${dashboardUid}`;

  return { success: true, dashboardUid, dashboardUrl };
}

/**
 * Return the Prometheus scrape-config YAML snippet to paste into the
 * user's prometheus.yml. Pure function, no I/O. Uses container name +
 * internal port by default since that's the standalone/default compose
 * setup; external scrapers (Prometheus on a different host) edit the
 * `targets:` line after pasting.
 *
 * @param {string} [targetName='docker-dash'] - compose service name or container name
 * @param {number} [port=8101] - app port
 * @returns {string} YAML snippet
 */
function scrapeConfigSnippet(targetName = 'docker-dash', port = 8101) {
  return `scrape_configs:
  - job_name: docker-dash
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/monitoring_token
    scrape_interval: 15s
    static_configs:
      - targets: ['${targetName}:${port}']
        labels:
          service: docker-dash
`;
}

module.exports = {
  importDashboard,
  scrapeConfigSnippet,
  _internals: { _loadDashboard, DASHBOARD_JSON_PATH },
};
