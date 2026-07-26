'use strict';

// Metrics service — v6.15.0
//
// Minimal in-memory metrics collection surfaced via GET /api/metrics in
// Prometheus text format. No external library (no prom-client) — the
// Prometheus text protocol is trivially simple and the metrics we care
// about are counters + gauges, not histograms.
//
// Why this exists: v5.0.0 production readiness audit flagged the metrics
// endpoint as "-1 Monitoring" because it only exposed 3 gauges (container
// count, total CPU, total memory). This module adds HTTP request counters,
// error counters, active WebSocket connections, background job runs, and
// uptime — enough to build a Grafana dashboard that answers "is the app
// healthy and how hard is it being used" without extra tooling.
//
// Memory footprint: Maps keyed by small cardinality (HTTP status bucket
// × method = ~30 entries max). Zero growth concern for the intended scale
// (homelab/SMB, <10k req/min).

const _startTime = Date.now();

// HTTP request metrics — keyed by "method|statusClass" (e.g. "GET|2xx")
const _httpRequestsTotal = new Map();        // counter: total requests
const _httpRequestDurationMs = new Map();    // counter: summed duration

// Generic error counter — keyed by statusCode (only populated for 4xx/5xx)
const _httpErrorsTotal = new Map();

// WebSocket connections — gauge
let _wsConnectionsActive = 0;
let _wsConnectionsTotal = 0;                 // counter: lifetime connects

// Background job runs — counter per job name
const _backgroundJobRuns = new Map();
const _backgroundJobErrors = new Map();

// Provider SDK v2 — deliberately low-cardinality labels. Provider type and
// coarse status/cache result are bounded enums; endpoint IDs/names never
// become labels.
const _providerProbeTotal = new Map();
const _providerProbeDurationMs = new Map();
const _providerCapabilityCacheTotal = new Map();
const _providerCapabilityUnknown = new Map();
const _providerConformanceTotal = new Map();

/** Record an HTTP request after it has finished. */
function recordRequest(method, statusCode, durationMs) {
  if (typeof statusCode !== 'number' || statusCode < 100) return;  // drop invalid
  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  const key = `${method}|${statusClass}`;
  _httpRequestsTotal.set(key, (_httpRequestsTotal.get(key) || 0) + 1);
  if (typeof durationMs === 'number' && durationMs >= 0) {
    _httpRequestDurationMs.set(key, (_httpRequestDurationMs.get(key) || 0) + durationMs);
  }
  if (statusCode >= 400) {
    const k = String(statusCode);
    _httpErrorsTotal.set(k, (_httpErrorsTotal.get(k) || 0) + 1);
  }
}

/** Record a WebSocket connect/disconnect event. delta = +1 on open, -1 on close. */
function recordWsConnection(delta) {
  if (delta === 1) {
    _wsConnectionsActive += 1;
    _wsConnectionsTotal += 1;
  } else if (delta === -1) {
    _wsConnectionsActive = Math.max(0, _wsConnectionsActive - 1);
  }
}

/** Record a background job run (success or error). */
function recordJobRun(jobName, isError = false) {
  if (!jobName) return;
  _backgroundJobRuns.set(jobName, (_backgroundJobRuns.get(jobName) || 0) + 1);
  if (isError) {
    _backgroundJobErrors.set(jobName, (_backgroundJobErrors.get(jobName) || 0) + 1);
  }
}

function recordProviderProbe(provider, status, durationMs) {
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider || '')) return;
  if (!['reachable', 'unreachable'].includes(status)) return;
  const key = `${provider}|${status}`;
  _providerProbeTotal.set(key, (_providerProbeTotal.get(key) || 0) + 1);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    _providerProbeDurationMs.set(key, (_providerProbeDurationMs.get(key) || 0) + durationMs);
  }
}

function recordProviderCapabilityCache(result) {
  if (!['hit', 'miss', 'stale'].includes(result)) return;
  _providerCapabilityCacheTotal.set(result, (_providerCapabilityCacheTotal.get(result) || 0) + 1);
}

function setProviderCapabilityUnknown(provider, count) {
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider || '')) return;
  if (!Number.isFinite(count) || count < 0) return;
  _providerCapabilityUnknown.set(provider, Math.floor(count));
}

function recordProviderConformance(provider, grade) {
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider || '')) return;
  if (!['certified', 'conditional', 'failed'].includes(grade)) return;
  const key = `${provider}|${grade}`;
  _providerConformanceTotal.set(key, (_providerConformanceTotal.get(key) || 0) + 1);
}

function getUptimeSeconds() {
  return Math.floor((Date.now() - _startTime) / 1000);
}

/** Get a plain-object snapshot — useful for tests and debugging. */
function snapshot() {
  return {
    uptime: getUptimeSeconds(),
    httpRequests: Object.fromEntries(_httpRequestsTotal),
    httpRequestDurationMs: Object.fromEntries(_httpRequestDurationMs),
    httpErrors: Object.fromEntries(_httpErrorsTotal),
    wsConnectionsActive: _wsConnectionsActive,
    wsConnectionsTotal: _wsConnectionsTotal,
    backgroundJobRuns: Object.fromEntries(_backgroundJobRuns),
    backgroundJobErrors: Object.fromEntries(_backgroundJobErrors),
    providerProbeTotal: Object.fromEntries(_providerProbeTotal),
    providerProbeDurationMs: Object.fromEntries(_providerProbeDurationMs),
    providerCapabilityCacheTotal: Object.fromEntries(_providerCapabilityCacheTotal),
    providerCapabilityUnknown: Object.fromEntries(_providerCapabilityUnknown),
    providerConformanceTotal: Object.fromEntries(_providerConformanceTotal),
  };
}

/** Reset all counters. Test-only helper. */
function _reset() {
  _httpRequestsTotal.clear();
  _httpRequestDurationMs.clear();
  _httpErrorsTotal.clear();
  _wsConnectionsActive = 0;
  _wsConnectionsTotal = 0;
  _backgroundJobRuns.clear();
  _backgroundJobErrors.clear();
  _providerProbeTotal.clear();
  _providerProbeDurationMs.clear();
  _providerCapabilityCacheTotal.clear();
  _providerCapabilityUnknown.clear();
  _providerConformanceTotal.clear();
}

/** Render accumulated metrics as Prometheus text format. */
function renderPrometheus() {
  const lines = [];

  lines.push('# HELP docker_dash_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE docker_dash_uptime_seconds gauge');
  lines.push(`docker_dash_uptime_seconds ${getUptimeSeconds()}`);

  lines.push('# HELP docker_dash_http_requests_total Total HTTP requests handled');
  lines.push('# TYPE docker_dash_http_requests_total counter');
  for (const [key, count] of _httpRequestsTotal) {
    const [method, statusClass] = key.split('|');
    lines.push(`docker_dash_http_requests_total{method="${method}",status="${statusClass}"} ${count}`);
  }

  lines.push('# HELP docker_dash_http_request_duration_ms Summed request duration in ms (divide by docker_dash_http_requests_total for avg)');
  lines.push('# TYPE docker_dash_http_request_duration_ms counter');
  for (const [key, totalMs] of _httpRequestDurationMs) {
    const [method, statusClass] = key.split('|');
    lines.push(`docker_dash_http_request_duration_ms{method="${method}",status="${statusClass}"} ${totalMs}`);
  }

  lines.push('# HELP docker_dash_http_errors_total Total HTTP 4xx+5xx responses by exact status');
  lines.push('# TYPE docker_dash_http_errors_total counter');
  for (const [status, count] of _httpErrorsTotal) {
    lines.push(`docker_dash_http_errors_total{status="${status}"} ${count}`);
  }

  lines.push('# HELP docker_dash_ws_connections_active Currently open WebSocket connections');
  lines.push('# TYPE docker_dash_ws_connections_active gauge');
  lines.push(`docker_dash_ws_connections_active ${_wsConnectionsActive}`);

  lines.push('# HELP docker_dash_ws_connections_total Total WebSocket connections opened (counter)');
  lines.push('# TYPE docker_dash_ws_connections_total counter');
  lines.push(`docker_dash_ws_connections_total ${_wsConnectionsTotal}`);

  lines.push('# HELP docker_dash_background_job_runs_total Total background job executions by job name');
  lines.push('# TYPE docker_dash_background_job_runs_total counter');
  for (const [job, count] of _backgroundJobRuns) {
    lines.push(`docker_dash_background_job_runs_total{job="${job}"} ${count}`);
  }

  lines.push('# HELP docker_dash_background_job_errors_total Total background job errors by job name');
  lines.push('# TYPE docker_dash_background_job_errors_total counter');
  for (const [job, count] of _backgroundJobErrors) {
    lines.push(`docker_dash_background_job_errors_total{job="${job}"} ${count}`);
  }

  lines.push('# HELP docker_dash_provider_probe_total Provider capability probes by provider and result');
  lines.push('# TYPE docker_dash_provider_probe_total counter');
  for (const [key, count] of _providerProbeTotal) {
    const [provider, status] = key.split('|');
    lines.push(`docker_dash_provider_probe_total{provider="${provider}",status="${status}"} ${count}`);
  }

  lines.push('# HELP docker_dash_provider_probe_duration_ms Summed provider capability probe duration in milliseconds');
  lines.push('# TYPE docker_dash_provider_probe_duration_ms counter');
  for (const [key, total] of _providerProbeDurationMs) {
    const [provider, status] = key.split('|');
    lines.push(`docker_dash_provider_probe_duration_ms{provider="${provider}",status="${status}"} ${total}`);
  }

  lines.push('# HELP docker_dash_provider_capability_cache_total Provider capability cache outcomes');
  lines.push('# TYPE docker_dash_provider_capability_cache_total counter');
  for (const [result, count] of _providerCapabilityCacheTotal) {
    lines.push(`docker_dash_provider_capability_cache_total{result="${result}"} ${count}`);
  }

  lines.push('# HELP docker_dash_provider_capability_unknown Unknown capability count by provider');
  lines.push('# TYPE docker_dash_provider_capability_unknown gauge');
  for (const [provider, count] of _providerCapabilityUnknown) {
    lines.push(`docker_dash_provider_capability_unknown{provider="${provider}"} ${count}`);
  }

  lines.push('# HELP docker_dash_provider_conformance_total Provider conformance runs by provider and grade');
  lines.push('# TYPE docker_dash_provider_conformance_total counter');
  for (const [key, count] of _providerConformanceTotal) {
    const [provider, grade] = key.split('|');
    lines.push(`docker_dash_provider_conformance_total{provider="${provider}",grade="${grade}"} ${count}`);
  }

  return lines.join('\n') + '\n';
}

module.exports = {
  recordRequest,
  recordWsConnection,
  recordJobRun,
  recordProviderProbe,
  recordProviderCapabilityCache,
  setProviderCapabilityUnknown,
  recordProviderConformance,
  getUptimeSeconds,
  snapshot,
  renderPrometheus,
  _reset,
};
