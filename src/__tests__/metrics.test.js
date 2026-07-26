'use strict';

// Tests for src/services/metrics.js (v6.15.0)

const metrics = require('../services/metrics');

beforeEach(() => metrics._reset());

describe('recordRequest', () => {
  it('increments counter per method+statusClass', () => {
    metrics.recordRequest('GET', 200, 42);
    metrics.recordRequest('GET', 201, 10);
    metrics.recordRequest('POST', 500, 100);
    const s = metrics.snapshot();
    expect(s.httpRequests['GET|2xx']).toBe(2);
    expect(s.httpRequests['POST|5xx']).toBe(1);
  });

  it('accumulates durations per key', () => {
    metrics.recordRequest('GET', 200, 42);
    metrics.recordRequest('GET', 200, 58);
    const s = metrics.snapshot();
    expect(s.httpRequestDurationMs['GET|2xx']).toBe(100);
  });

  it('records 4xx+5xx into errors counter (exact status)', () => {
    metrics.recordRequest('GET', 200, 5);
    metrics.recordRequest('GET', 404, 5);
    metrics.recordRequest('POST', 500, 5);
    metrics.recordRequest('POST', 500, 5);
    const s = metrics.snapshot();
    expect(s.httpErrors['404']).toBe(1);
    expect(s.httpErrors['500']).toBe(2);
    expect(s.httpErrors['200']).toBeUndefined();
  });

  it('ignores invalid status codes', () => {
    metrics.recordRequest('GET', null, 10);
    metrics.recordRequest('GET', 'NaN', 10);
    metrics.recordRequest('GET', 50, 10);
    const s = metrics.snapshot();
    expect(Object.keys(s.httpRequests)).toHaveLength(0);
  });

  it('handles missing duration gracefully', () => {
    metrics.recordRequest('GET', 200);
    metrics.recordRequest('GET', 200, -5);  // negative ignored
    const s = metrics.snapshot();
    expect(s.httpRequests['GET|2xx']).toBe(2);
    // duration sum absent because only valid values were skipped
    expect(s.httpRequestDurationMs['GET|2xx']).toBeUndefined();
  });
});

describe('recordWsConnection', () => {
  it('tracks active + total separately', () => {
    metrics.recordWsConnection(1);
    metrics.recordWsConnection(1);
    metrics.recordWsConnection(1);
    metrics.recordWsConnection(-1);
    const s = metrics.snapshot();
    expect(s.wsConnectionsActive).toBe(2);
    expect(s.wsConnectionsTotal).toBe(3);
  });

  it('clamps active to 0 (no negative)', () => {
    metrics.recordWsConnection(-1);
    metrics.recordWsConnection(-1);
    expect(metrics.snapshot().wsConnectionsActive).toBe(0);
  });
});

describe('recordJobRun', () => {
  it('counts runs per job name', () => {
    metrics.recordJobRun('stats-aggregation');
    metrics.recordJobRun('stats-aggregation');
    metrics.recordJobRun('backup');
    const s = metrics.snapshot();
    expect(s.backgroundJobRuns['stats-aggregation']).toBe(2);
    expect(s.backgroundJobRuns['backup']).toBe(1);
  });

  it('counts errors separately', () => {
    metrics.recordJobRun('backup');
    metrics.recordJobRun('backup', true);
    metrics.recordJobRun('backup', true);
    const s = metrics.snapshot();
    expect(s.backgroundJobRuns['backup']).toBe(3);
    expect(s.backgroundJobErrors['backup']).toBe(2);
  });

  it('ignores null/empty job names', () => {
    metrics.recordJobRun(null);
    metrics.recordJobRun('');
    metrics.recordJobRun(undefined);
    expect(Object.keys(metrics.snapshot().backgroundJobRuns)).toHaveLength(0);
  });
});

describe('provider capability metrics', () => {
  it('keeps provider labels bounded and records probe/cache state', () => {
    metrics.recordProviderProbe('xen', 'reachable', 25);
    metrics.recordProviderProbe('xen', 'unreachable', 10);
    metrics.recordProviderCapabilityCache('hit');
    metrics.setProviderCapabilityUnknown('xen', 4);
    const snapshot = metrics.snapshot();
    expect(snapshot.providerProbeTotal).toEqual({ 'xen|reachable': 1, 'xen|unreachable': 1 });
    expect(snapshot.providerProbeDurationMs['xen|reachable']).toBe(25);
    expect(snapshot.providerCapabilityCacheTotal.hit).toBe(1);
    expect(snapshot.providerCapabilityUnknown.xen).toBe(4);
  });

  it('drops unsafe or unbounded labels', () => {
    metrics.recordProviderProbe('bad provider', 'reachable', 1);
    metrics.recordProviderCapabilityCache('invented');
    metrics.setProviderCapabilityUnknown('xen', -1);
    const snapshot = metrics.snapshot();
    expect(snapshot.providerProbeTotal).toEqual({});
    expect(snapshot.providerCapabilityCacheTotal).toEqual({});
    expect(snapshot.providerCapabilityUnknown).toEqual({});
  });
});

describe('renderPrometheus', () => {
  it('emits standard HELP/TYPE headers', () => {
    const out = metrics.renderPrometheus();
    expect(out).toContain('# HELP docker_dash_uptime_seconds');
    expect(out).toContain('# TYPE docker_dash_uptime_seconds gauge');
    expect(out).toContain('# HELP docker_dash_http_requests_total');
    expect(out).toContain('# TYPE docker_dash_http_requests_total counter');
    expect(out).toContain('# HELP docker_dash_ws_connections_active');
    expect(out).toContain('# TYPE docker_dash_ws_connections_active gauge');
  });

  it('renders accumulated request counters', () => {
    metrics.recordRequest('GET', 200, 10);
    metrics.recordRequest('POST', 500, 20);
    const out = metrics.renderPrometheus();
    expect(out).toMatch(/docker_dash_http_requests_total\{method="GET",status="2xx"\}\s+1/);
    expect(out).toMatch(/docker_dash_http_requests_total\{method="POST",status="5xx"\}\s+1/);
  });

  it('renders error counters with exact status codes', () => {
    metrics.recordRequest('GET', 404, 5);
    metrics.recordRequest('POST', 503, 5);
    const out = metrics.renderPrometheus();
    expect(out).toMatch(/docker_dash_http_errors_total\{status="404"\}\s+1/);
    expect(out).toMatch(/docker_dash_http_errors_total\{status="503"\}\s+1/);
  });

  it('renders ws gauges', () => {
    metrics.recordWsConnection(1);
    metrics.recordWsConnection(1);
    const out = metrics.renderPrometheus();
    expect(out).toMatch(/docker_dash_ws_connections_active\s+2/);
    expect(out).toMatch(/docker_dash_ws_connections_total\s+2/);
  });

  it('renders background job counters', () => {
    metrics.recordJobRun('backup');
    metrics.recordJobRun('stats', true);
    const out = metrics.renderPrometheus();
    expect(out).toMatch(/docker_dash_background_job_runs_total\{job="backup"\}\s+1/);
    expect(out).toMatch(/docker_dash_background_job_errors_total\{job="stats"\}\s+1/);
  });

  it('renders provider probe and capability metrics', () => {
    metrics.recordProviderProbe('proxmox', 'reachable', 15);
    metrics.recordProviderCapabilityCache('miss');
    metrics.setProviderCapabilityUnknown('proxmox', 2);
    const out = metrics.renderPrometheus();
    expect(out).toMatch(/docker_dash_provider_probe_total\{provider="proxmox",status="reachable"\}\s+1/);
    expect(out).toMatch(/docker_dash_provider_capability_cache_total\{result="miss"\}\s+1/);
    expect(out).toMatch(/docker_dash_provider_capability_unknown\{provider="proxmox"\}\s+2/);
  });

  it('ends with trailing newline (Prometheus convention)', () => {
    expect(metrics.renderPrometheus().endsWith('\n')).toBe(true);
  });
});

describe('uptime', () => {
  it('returns a non-negative number of seconds', () => {
    expect(metrics.getUptimeSeconds()).toBeGreaterThanOrEqual(0);
  });
});
