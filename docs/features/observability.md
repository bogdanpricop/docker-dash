# Observability Stack — Prometheus + Grafana

**Introduced:** v7.1.0
**Optional — opt-in via `docker compose --profile observability up -d`**
**Works in both standalone and HA mode.**

Docker Dash ships an opt-in observability stack that deploys Prometheus (scraping `/api/metrics`) + Grafana (with a pre-provisioned dashboard) alongside the app. Configure the monitoring credential before starting this profile; Grafana dashboards and its datasource are provisioned automatically.

For operators who already run Prometheus or Grafana: skip this profile and integrate manually — [see §5 below](#5-integrating-with-an-existing-prometheusgrafana).

---

## 1. What's in the stack

| Service | Image | Purpose | Exposed |
|---------|-------|---------|:-------:|
| `prometheus` | `prom/prometheus:v3.0.1` | Scrapes `/api/metrics` every 15s, 7-day retention | No (internal only) |
| `grafana` | `grafana/grafana:11.3.0` | Queries Prometheus, serves the pre-provisioned dashboard | Yes (`:3001` by default) |

Both services run with `no-new-privileges:true`. Data persists across restarts via named Docker volumes (`docker-dash-prometheus-data`, `docker-dash-grafana-data`).

## 1a. In-app wizard (v7.2.0+)

Instead of learning Prometheus + Grafana config from scratch, navigate to **System → Observability** in the Docker Dash UI. The wizard detects what's already running on your host and shows the right next steps:

| Detection result | What the wizard offers |
|------------------|------------------------|
| Both Prometheus + Grafana found | Scrape-config YAML snippet (Copy button) + "Import dashboard" form (URL + service-account token → one-click import via Grafana API) |
| Only one found | Three options — deploy our bundled stack, install the missing piece manually, or integrate manually |
| Neither found | Deploy command + "Or import to remote Grafana" form |

**Admin-only.** The wizard uses:

- `GET /api/observability/detect` — scans running containers for Prometheus/Grafana image prefixes (`prom/prometheus`, `grafana/grafana`, `bitnami/*`, Grafana Enterprise). Never modifies Docker state.
- `POST /api/observability/import-dashboard` — receives a Grafana URL + service-account token, forwards our dashboard JSON to `<grafanaUrl>/api/dashboards/db` with `Authorization: Bearer <token>`. Token is **never stored** in Docker Dash — it's forwarded and discarded after the response.

**Security notes** ([deep-spec §5](../../plans/deep-spec-observability-wizard.md)):
- Both endpoints require `admin` role. Operators and viewers don't see the sidebar link.
- Outbound import POST has a 10-second timeout. No redirect following.
- Audit log entry per import (success or failure) — records Grafana URL + admin username, excludes token.
- Token field uses `<input type="password">` and is cleared from the DOM on success.

**Limitations:**
- Detection only sees containers on the local Docker daemon. Prometheus/Grafana running on a different host are not auto-detected — use the "external Grafana" form to point at them manually.
- Custom image tags (private mirrors, non-standard names) aren't matched. Operators in that situation already know what they have and can use the manual form.
- The wizard doesn't auto-deploy. The "Deploy" path shows copy-paste instructions. Rationale: deploying Prometheus + Grafana from inside the Docker Dash container requires config-file bind-mounts the container can't provide without host path knowledge. v7.3.0 may add auto-deploy via dockerode with embedded config.

## 2. Enabling

Start the app first and sign in as an administrator. In **Identity & Policy**, issue
a service token with only `monitoring.read`, no tenant, and a suitable lifetime
(maximum 24 hours). Save its raw value in a private host file. Set
`MONITORING_TOKEN_FILE` to that file; the default is `./.secrets/monitoring-token`.
The Compose profile mounts it only into Prometheus as `/run/secrets/monitoring_token`.
The `.secrets` directory is excluded from Git and Docker build contexts.

Keep the parent directory owner-only (0700 on Linux). The file must be readable by
the Prometheus container user: Compose file-backed secrets preserve host file
permissions. For example, a 0644 file inside that private 0700 directory remains
inaccessible to other host users while the explicitly mounted file is readable in
Prometheus. Never make the parent directory public or commit the token.

Arrange credential rotation before expiry. Rotation revokes the old token immediately;
update the existing file contents promptly. Replacing the host file by rename can
leave a Compose bind mount on the old inode; recreate Prometheus after such a replacement.
Without a valid credential, scrapes return 401/403 and dashboards stop receiving data.
Running the app without the observability profile does not require this secret.

Existing scrapers must configure authentication before rollout. Global `api.read`
service credentials remain compatible; prefer the narrower `monitoring.read` for
new integrations. Metrics contain container names and operational data. Use HTTPS
with certificate verification when scraping over an untrusted network; the bundled
`app:8101` target is the internal Compose connection.

The file configuration follows the documented
[Prometheus authorization settings](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_config)
and [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

Grafana also requires `GRAFANA_ADMIN_PASSWORD_FILE`, defaulting to
`./.secrets/grafana-admin-password`. Its startup guard refuses a missing, empty,
multiline, whitespace-only or short password file (20-256 characters).
Generate a unique secret before the first boot. Keep the host parent directory
0700 and make the individual mounted file readable by Grafana's container UID.
The file is mounted read-only and its contents are not part of Compose environment
values. Changing it does **not** reset a password already stored in Grafana's
database; use Grafana's password-change flow or administrator CLI for that.

```bash
# Create the private bootstrap file once; do not overwrite an existing secret.
mkdir -p .secrets
chmod 700 .secrets
(umask 077; set -C; openssl rand -base64 36 > .secrets/grafana-admin-password)
chmod 644 .secrets/grafana-admin-password

# After configuring both credential files — adds Prometheus + Grafana
docker compose --profile observability up -d

# With a custom bootstrap username and an existing private password file
GRAFANA_ADMIN_USER=ops GRAFANA_ADMIN_PASSWORD_FILE=/private/grafana-password \
  docker compose --profile observability up -d

# With custom Grafana port (default 3001 to avoid clash with app's 8101 + common :3000)
GRAFANA_PORT=4000 docker compose --profile observability up -d
```

Open Grafana at `http://<host>:3001` (or your `GRAFANA_PORT`). On a fresh database,
log in with `GRAFANA_ADMIN_USER` (default `admin`) and the generated password.
Existing installations retain their stored credentials. There is no bundled
`admin/admin` fallback. `GRAFANA_ADMIN_PASSWORD` is no longer read by this Compose
profile: move any bootstrap value from `.env` into the private file.

Dashboard: **Docker Dash → Docker Dash — Overview**. Populates within 30s of first scrape.

## 3. What the dashboard shows

Eight panels on a single grid. Panels are designed to work whether you're in standalone or HA mode — HA-specific panels show 0 / N/A in standalone.

| Panel | Metric(s) | Why it matters |
|-------|-----------|----------------|
| **Cluster role** | `docker_dash_cluster_role` | See each replica's current role. Standalone shows `standalone`; HA shows `leader` or `reader` per node. |
| **Redis (HA only)** | `docker_dash_cluster_redis_connected` | Binary gauge — red if HA mode can't reach Redis; green otherwise. Standalone shows "down / N/A" (intentional). |
| **Active WebSocket connections** | `sum(docker_dash_ws_connections_active)` | Live users. Drops to zero = everyone disconnected; sustained high = capacity check. |
| **Containers managed** | `docker_dash_containers_total` | Stat card. From Docker Dash's own stats aggregator. |
| **HTTP request rate** | `sum by(method, status) (rate(docker_dash_http_requests_total[5m]))` | Per HTTP method × status class (2xx/3xx/4xx/5xx). 5xx spikes → investigate errors panel. |
| **Avg HTTP latency** | `sum(rate(...duration_ms)) / sum(rate(...requests_total))` | Time-series, ms. Thresholds at 500ms (amber) and 2000ms (red). |
| **Background job runs** | `sum by(job) (rate(docker_dash_background_job_runs_total[15m]))` | Flat line = job stopped running. In HA mode indicates leader election issue; in standalone = cron misconfig. |
| **HTTP errors (by status)** | `sum by(status) (rate(docker_dash_http_errors_total[5m]))` | Stacked. 429 = rate limiter firing; 5xx = investigate logs. |

Dashboard uses `docker-dash-prom` data source UID. If you copy the JSON to your own Grafana, update the UID or re-point via data source variables.

## 4. Recommended alerts

Copy these into Grafana's Alerting → Alert rules (or your Alertmanager config). All reference metrics from Docker Dash's `/api/metrics`:

```yaml
# 1. No leader elected (HA)
sum(docker_dash_cluster_role == 1) != 1
# for: 30s
# severity: critical — split-brain or no leader

# 2. Redis down (HA)
docker_dash_cluster_redis_connected == 0
# for: 10s
# severity: critical — HA mode degraded

# 3. Stalled leader heartbeat
docker_dash_cluster_heartbeat_age_seconds > 15
# for: 30s
# severity: warning — leader overload or partition

# 4. 5xx spike
sum(rate(docker_dash_http_errors_total{status=~"5.."}[5m])) > 0.5
# for: 2m
# severity: warning — >0.5 err/sec sustained

# 5. Slow requests
sum(rate(docker_dash_http_request_duration_ms[5m])) / sum(rate(docker_dash_http_requests_total[5m])) > 2000
# for: 5m
# severity: warning — avg latency >2s

# 6. Background jobs stalled
rate(docker_dash_background_job_runs_total{job="stats-aggregate-1m"}[10m]) == 0
# for: 5m
# severity: warning — stats aggregation stopped
```

Only #1 and #2 are HA-specific. The rest apply to both modes.

## 5. Integrating with an existing Prometheus / Grafana

If you already run Prometheus and Grafana elsewhere, you don't need the `observability` profile. Two integration paths:

### 5.1 Add Docker Dash as a scrape target in your existing Prometheus

Append to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: docker-dash
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/monitoring_token
    static_configs:
      - targets: ['docker-dash-host:8101']      # DNS name or IP
        labels:
          service: docker-dash

  # If HA mode with N replicas, list each replica:
  # - targets: ['dd-replica-1:8101', 'dd-replica-2:8101', 'dd-replica-3:8101']
```

Reload Prometheus (`curl -X POST http://prometheus:9090/-/reload` if `--web.enable-lifecycle` is set, or SIGHUP the process).

### 5.2 Import the dashboard into your existing Grafana

```bash
# Grab the dashboard JSON
curl -O https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/docker/observability/grafana/dashboards/docker-dash-overview.json

# Import via Grafana UI: Dashboards → New → Import → Upload JSON
# OR via API:
curl -X POST https://<grafana>/api/dashboards/db \
  -H "Authorization: Bearer <grafana-service-account-token>" \
  -H "Content-Type: application/json" \
  -d @docker-dash-overview.json
```

**Important**: after import, update the dashboard's data source to point at your Prometheus instance (Grafana will prompt automatically).

## 6. Security hardening checklist

Before exposing Grafana beyond your trusted network:

- [ ] **Check Grafana credentials**. New installs require the private bootstrap file. Existing databases keep their stored password; explicitly change any legacy default and review active sessions.
- [ ] **Do NOT expose Prometheus externally.** The default compose config binds Prometheus to the internal network only. Leave it that way unless you have an explicit reason.
- [ ] **Put Grafana behind HTTPS**. Grafana has its own HTTPS config (`GF_SERVER_PROTOCOL=https`), or terminate TLS at a reverse proxy (Caddy/Traefik). Same-host setup can reuse the `--profile tls` Caddy.
- [ ] **Disable anonymous access** (default). We set `GF_AUTH_ANONYMOUS_ENABLED=false`.
- [ ] **Disable user sign-up** (default). `GF_USERS_ALLOW_SIGN_UP=false` means only admin can create users.
- [ ] **Consider SSO**. Grafana supports OAuth / LDAP / OIDC. See [Grafana authentication docs](https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/).
- [ ] **Review data-source access**. Ours is `access: proxy` (Grafana proxies queries — the browser never hits Prometheus directly), which is the safer default.

## 7. Common-sense deployment recommendations

If you're deploying Prometheus + Grafana from scratch (not just using ours):

### Persistent storage

Use named volumes or bind mounts for `/prometheus` and `/var/lib/grafana`. Our compose profile does this:
- `docker-dash-prometheus-data` → `/prometheus` (7-day retention default; ~200MB-1GB depending on scrape density)
- `docker-dash-grafana-data` → `/var/lib/grafana` (includes dashboards you create in the UI, not the auto-provisioned ones)

### Resource limits

Under normal Docker Dash load (`~10 req/s`, few containers, few WS clients), Prometheus + Grafana consume:
- Prometheus: ~80-150MB RAM, <1% CPU
- Grafana: ~120-180MB RAM, <1% CPU

Under load, set Docker resource limits:
```yaml
# In docker-compose.yml, under each service:
deploy:
  resources:
    limits:
      memory: 512M
      cpus: '0.5'
```

### Retention vs disk

Default Prometheus retention: **7 days**. For longer retention, edit the compose profile's `--storage.tsdb.retention.time=30d` (or whatever). Each additional day typically adds ~50-200MB depending on scrape density.

For **long-term metrics storage** (months/years), offload to a remote-write target like [Thanos](https://thanos.io/), [Cortex](https://cortexmetrics.io/), or [Victoria Metrics](https://victoriametrics.com/). Scope out of this doc — Docker Dash's metrics are operational, not long-term historical.

### Scaling considerations

- **Prometheus is single-instance.** Our profile uses one. For redundancy, run a second one with the same scrape config. Grafana can failover between them via data-source config.
- **Grafana is stateless for dashboards** (when provisioned from files). Your existing Grafana deployment will work if you just add the Docker Dash dashboard JSON.

### Connectivity for HA mode deploys

If you run Docker Dash in HA mode with N replicas, Prometheus needs to scrape each replica independently. Options:

**Option 1 — Static targets** (N known replicas):
```yaml
scrape_configs:
  - job_name: docker-dash
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/monitoring_token
    static_configs:
      - targets: ['dd-1:8101', 'dd-2:8101', 'dd-3:8101']
        labels:
          service: docker-dash
```

**Option 2 — Docker SD** (auto-discover running containers matching a label):
```yaml
scrape_configs:
  - job_name: docker-dash
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/monitoring_token
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 30s
    relabel_configs:
      # Match containers with the docker-dash label
      - source_labels: [__meta_docker_container_label_com_docker_compose_service]
        regex: 'app'
        action: keep
      # Set target to container port 8101
      - source_labels: [__meta_docker_container_name]
        regex: '/(.+)'
        target_label: instance
        replacement: '${1}'
      - source_labels: [__address__]
        target_label: __address__
        replacement: '${1}:8101'
```

Docker SD requires Prometheus to have access to the Docker socket (mount it read-only). Works well in Docker Swarm; adapt to `kubernetes_sd_configs` for K8s.

## 8. Teardown

```bash
# Stop + remove Prometheus + Grafana containers, KEEP data volumes
docker compose --profile observability down

# Stop + remove containers AND drop data volumes (nuclear option)
docker compose --profile observability down -v
```

The main Docker Dash app is unaffected — it keeps running.

## 9. Known limitations

- **No histograms** — Docker Dash exports counters and gauges only. Latency is "average over window", not p50/p95/p99. If you need percentiles, add a Prometheus histogram via a separate exporter (out of scope — would require instrumentation).
- **No container-per-container metrics rollup** — per-container CPU/memory is exposed as a gauge series, but Prometheus cardinality can explode on long-lived named containers. If you manage hundreds of containers, consider a separate cAdvisor deployment for per-container time series.
- **Per-replica scrape in HA** — with N replicas, you get N series per metric. Prometheus handles this fine up to ~100 replicas. Beyond that, add remote-write offload.

## 10. See also

- Source:
  - [`docker/observability/prometheus.yml`](../../docker/observability/prometheus.yml)
  - [`docker/observability/grafana/`](../../docker/observability/grafana/)
  - [`src/services/metrics.js`](../../src/services/metrics.js) — the metric producer
  - [`src/routes/misc.js`](../../src/routes/misc.js) — the `/api/metrics` endpoint
- Related docs:
  - [HA Mode](ha-mode.md) — when cluster metrics are meaningful
  - [HA Failover Runbook](ha-failover-runbook.md) — what the cluster alerts protect against
  - [Prometheus Metrics Reference](prometheus-metrics.md) — the full metric catalog
