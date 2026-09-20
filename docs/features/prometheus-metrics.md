# Prometheus Metrics Reference

**Introduced:** v6.15.0  
**Endpoint:** `GET /api/metrics`  
**Content-Type:** `text/plain` (Prometheus text format 0.0.4)

---

## Overview

Docker Dash exposes an in-process metrics endpoint in Prometheus text format. It requires no external library — the protocol is straightforward enough that the implementation ([`src/services/metrics.js`](../../src/services/metrics.js)) is a single self-contained module using plain `Map`-based counters and gauges.

The endpoint combines two data sources:

1. **Container stats** — pulled from the running Docker daemon via the stats aggregation service (totals + per-container CPU/memory)
2. **Application-level metrics** — uptime, HTTP request counters, WebSocket gauge, and background job run/error counters (v6.15.0+)

---

## Authentication

Metrics and `/api/cluster/status` expose global operational information and require
authentication. Use a global service token with `monitoring.read` (recommended) or
the broader `api.read`. Administrator user sessions and administrator read API keys
also work. Tenant-scoped credentials, viewers and operators are refused.

```
GET /api/metrics
Authorization: Bearer <monitoring-token>
```

Missing, invalid, expired or revoked credentials return 401; insufficient authority
returns 403. Responses use no-store. `/api/health` remains public for liveness checks.
Service credentials last at most 24 hours; arrange rotation before expiry. Rotation
revokes the old credential immediately. Update the scraper file as part of rotation.
See the [operator setup guide](observability.md#2-enabling).

---

## Metrics Reference

### Container / Docker stats (always present)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `docker_dash_containers_total` | gauge | — | Total container count seen in last stats poll |
| `docker_dash_cpu_total` | gauge | — | Sum of CPU % across all containers |
| `docker_dash_memory_used_bytes` | gauge | — | Sum of memory usage in bytes across all containers |
| `docker_dash_container_cpu` | gauge | `name` | Per-container CPU % (label = sanitized container name) |
| `docker_dash_container_memory_bytes` | gauge | `name` | Per-container memory usage in bytes |

> **Note:** `docker_dash_container_*` entries are high-cardinality per container. On a host with 50+ containers this is expected; on multi-host deployments only the local host's containers are included.

### Application uptime

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `docker_dash_uptime_seconds` | gauge | — | Process uptime since last start (seconds) |

### HTTP request metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `docker_dash_http_requests_total` | counter | `method`, `status` | Total requests, partitioned by HTTP method and status bucket |
| `docker_dash_http_request_duration_ms` | counter | `method`, `status` | Summed request duration in ms (divide by `_total` for average) |
| `docker_dash_http_errors_total` | counter | `status` | Total 4xx+5xx responses by **exact** status code |

Status bucket values for `status` label: `2xx`, `3xx`, `4xx`, `5xx`. This is intentionally low-cardinality — individual URL paths are not recorded.

### WebSocket metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `docker_dash_ws_connections_active` | gauge | — | Currently open WebSocket connections |
| `docker_dash_ws_connections_total` | counter | — | Lifetime WebSocket connects since last start |

### Background job metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `docker_dash_background_job_runs_total` | counter | `job` | Total executions per job name |
| `docker_dash_background_job_errors_total` | counter | `job` | Total errors per job name |

Known job names (as of v6.16.0): `alert-evaluate`, `schedule-executor`, `sandbox-ttl-sweep`, `security-alert-windowed`, `stats-aggregate-1h`, `stats-aggregate-1m`.

---

## Sample Output

Real output from staging (v6.16.0, ~6 minutes uptime):

```
# HELP docker_dash_containers_total Total containers
# TYPE docker_dash_containers_total gauge
docker_dash_containers_total 0
# HELP docker_dash_cpu_total Total CPU usage percent
# TYPE docker_dash_cpu_total gauge
docker_dash_cpu_total 0.00
# HELP docker_dash_memory_used_bytes Total memory usage
# TYPE docker_dash_memory_used_bytes gauge
docker_dash_memory_used_bytes 0
# HELP docker_dash_uptime_seconds Process uptime in seconds
# TYPE docker_dash_uptime_seconds gauge
docker_dash_uptime_seconds 377
# HELP docker_dash_http_requests_total Total HTTP requests handled
# TYPE docker_dash_http_requests_total counter
docker_dash_http_requests_total{method="GET",status="3xx"} 12
docker_dash_http_requests_total{method="GET",status="4xx"} 6
docker_dash_http_requests_total{method="GET",status="2xx"} 6
# HELP docker_dash_http_request_duration_ms Summed request duration in ms (...)
# TYPE docker_dash_http_request_duration_ms counter
docker_dash_http_request_duration_ms{method="GET",status="3xx"} 14
docker_dash_http_request_duration_ms{method="GET",status="4xx"} 7
docker_dash_http_request_duration_ms{method="GET",status="2xx"} 6
# HELP docker_dash_http_errors_total Total HTTP 4xx+5xx responses by exact status
# TYPE docker_dash_http_errors_total counter
docker_dash_http_errors_total{status="401"} 6
# HELP docker_dash_ws_connections_active Currently open WebSocket connections
# TYPE docker_dash_ws_connections_active gauge
docker_dash_ws_connections_active 1
# HELP docker_dash_ws_connections_total Total WebSocket connections opened (counter)
# TYPE docker_dash_ws_connections_total counter
docker_dash_ws_connections_total 1
# HELP docker_dash_background_job_runs_total Total background job executions by job name
# TYPE docker_dash_background_job_runs_total counter
docker_dash_background_job_runs_total{job="alert-evaluate"} 37
docker_dash_background_job_runs_total{job="schedule-executor"} 7
docker_dash_background_job_runs_total{job="sandbox-ttl-sweep"} 12
docker_dash_background_job_runs_total{job="security-alert-windowed"} 6
docker_dash_background_job_runs_total{job="stats-aggregate-1h"} 1
docker_dash_background_job_runs_total{job="stats-aggregate-1m"} 3
# HELP docker_dash_background_job_errors_total Total background job errors by job name
# TYPE docker_dash_background_job_errors_total counter
```

---

## Prometheus Scrape Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: docker_dash
    static_configs:
      - targets: ['your-host:8101']
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/monitoring_token
    scrape_interval: 30s
```

Mount a private file containing only the raw token at the configured path. The
generated wizard snippet and bundled Compose profile use this same file mapping.
No raw credential belongs in version-controlled YAML.

---

## Example Grafana Queries

### HTTP 5xx error rate per second

```promql
rate(docker_dash_http_requests_total{status="5xx"}[5m])
```

### Average request latency per method (ms)

```promql
rate(docker_dash_http_request_duration_ms[5m])
/
rate(docker_dash_http_requests_total[5m])
```

### Active WebSocket connections

```promql
docker_dash_ws_connections_active
```

### Background job failure ratio

```promql
rate(docker_dash_background_job_errors_total[5m])
/
rate(docker_dash_background_job_runs_total[5m])
```

---

## Cardinality Notes

HTTP metrics use **bucketed status classes** (`2xx`/`3xx`/`4xx`/`5xx`) instead of individual paths or exact statuses. This keeps cardinality bounded regardless of traffic volume or URL diversity — critical for homelab Prometheus instances with limited TSDB storage.

The only high-cardinality dimension is `docker_dash_http_errors_total`, which records the **exact** status code (e.g. `401`, `404`, `500`). The number of distinct HTTP status codes in practice is small (typically < 10), so this is safe.

---

## Limitations

- **No histograms.** Duration is tracked as a running sum + count. You can compute averages but not percentiles (p95, p99). Adding native histograms would require `prom-client` or a custom bucket implementation.
- **No exemplars.** Trace IDs are not attached to metrics.
- **No Docker daemon metrics.** Container CPU/memory comes from Docker Dash's own polling, not directly from the Docker daemon's own `/metrics` endpoint. Pulling daemon internals (goroutines, build cache, image layer stats) is out of scope.
- **In-memory only.** Counters reset on process restart. Prometheus's own TSDB handles persistence.
- **Local host only.** Multi-host deployments expose metrics for the host running Docker Dash only; remote hosts' containers are not individually enumerated (only their aggregate totals if polled).

---

## See Also

- Source: [`src/services/metrics.js`](../../src/services/metrics.js)
- Route registration: [`src/routes/misc.js`](../../src/routes/misc.js) (`router.get('/metrics', …)`)
- CHANGELOG: v6.15.0 entry
- Related: [`docs/features/platform-detection.md`](./platform-detection.md)
