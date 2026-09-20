# HA Load Balancer — Configuration Examples

**Applies to:** v7.0.0+ Docker Dash running in HA mode (`DD_MODE=ha`) with 2+ replicas.

Docker Dash's HA mode requires a load balancer in front that supports **sticky sessions** (WebSocket connections must stick to the same replica for the life of the connection) and **health-check-based routing** (take replicas out of the pool when they fail `/api/health`).

This doc gives concrete configs for the 4 most common LBs. Pick one and adapt.

---

## Requirements for any LB

1. **Sticky sessions** — typically via cookie affinity. WS upgrades on `GET /ws` need to land on the same replica as any follow-up HTTP. Token in the session cookie (`ddash_session`) is our recommended stickiness key.
2. **Health checks** — poll `GET /api/health` every 10s on each replica. Remove from pool on non-2xx or timeout > 3s.
3. **WebSocket upgrade** — pass through `Upgrade: websocket` and `Connection: upgrade` headers.
4. **Set forwarding headers at the trusted proxy** — overwrite untrusted incoming values. Docker Dash defaults to `TRUST_PROXY=loopback` in every environment. For another proxy, list its actual IP/CIDR; service DNS names and hop counts are not accepted. Use `TRUST_PROXY=false` for direct access. SSO assertions additionally require the immediate peer in `SSO_TRUSTED_PROXY_IPS`.
5. **Long-lived connection support** — WS connections can live for hours. Don't set idle timeouts below 5 minutes.

---

## 1. Caddy (recommended — Docker Dash already ships an optional Caddy profile)

Best for small-to-medium deploys. Handles sticky-session, WS upgrade, and Let's Encrypt automatically.

### `Caddyfile`

```caddy
# HA load balancer for Docker Dash replicas
dashboard.example.com {
  # Sticky by cookie — WS connections stay on the same replica
  reverse_proxy /* docker-dash-1:8101 docker-dash-2:8101 docker-dash-3:8101 {
    lb_policy cookie ddash_lb              # affinity cookie
    lb_try_duration 5s                     # retry failover quickly
    lb_try_interval 500ms

    # Health check — /api/health
    health_uri /api/health
    health_interval 10s
    health_timeout 3s
    health_status 2xx

    # Pass through WebSocket upgrade headers
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}

    # Keep long WS connections alive
    transport http {
      keepalive 5m
      read_timeout 10m
      write_timeout 10m
    }
  }

  # Optional: TLS via Let's Encrypt
  tls admin@example.com
}
```

### Docker Dash `.env` for this setup

```bash
DD_MODE=ha
REDIS_URL=redis://redis:6379
TRUST_PROXY=172.30.10.5                    # example only: replace with actual Caddy IP/CIDR
COOKIE_SECURE=true                          # because Caddy provides TLS
```

### Advanced: route writes to leader only

If you want writes (`POST`/`PUT`/`DELETE`) to go directly to the leader (skipping the sticky hash), use a `@leader` matcher + conditional reverse_proxy. Requires the `/api/health` response exposing `role` (shipped in v7.0.0):

```caddy
@leader_node {
  # Match only the replica whose /api/health says role=leader.
  # This is experimental — consider whether the sticky-session-by-cookie
  # pattern above is already good enough for your workload (most cases: yes).
}
```

**Honest take:** in v7.0.0 the simpler "sticky by cookie + let each replica forward writes to leader internally" pattern is not yet wired (readers accept writes and they... go to local SQLite, which is the same shared file). Since writes land on the shared DB file regardless of which replica serves them, the SQLite single-writer concern is resolved at the `better-sqlite3` + WAL level, not at the LB level. **Don't over-engineer the LB.** Sticky-by-cookie is sufficient.

---

## 2. Traefik v3

Best for Docker Swarm / Kubernetes deployments, especially if you're already on Traefik.

### `docker-compose.yml` snippet (Swarm mode)

```yaml
services:
  docker-dash:
    # ... existing service config ...
    deploy:
      replicas: 3
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.dashboard.rule=Host(`dashboard.example.com`)"
        - "traefik.http.routers.dashboard.entrypoints=websecure"
        - "traefik.http.routers.dashboard.tls.certresolver=le"

        # Sticky session via cookie
        - "traefik.http.services.dashboard.loadbalancer.sticky.cookie=true"
        - "traefik.http.services.dashboard.loadbalancer.sticky.cookie.name=ddash_lb"
        - "traefik.http.services.dashboard.loadbalancer.sticky.cookie.httpOnly=true"
        - "traefik.http.services.dashboard.loadbalancer.sticky.cookie.secure=true"
        - "traefik.http.services.dashboard.loadbalancer.sticky.cookie.sameSite=strict"

        # Service port
        - "traefik.http.services.dashboard.loadbalancer.server.port=8101"

        # Health check
        - "traefik.http.services.dashboard.loadbalancer.healthcheck.path=/api/health"
        - "traefik.http.services.dashboard.loadbalancer.healthcheck.interval=10s"
        - "traefik.http.services.dashboard.loadbalancer.healthcheck.timeout=3s"
```

### `.env`

```bash
DD_MODE=ha
REDIS_URL=redis://redis:6379
TRUST_PROXY=172.30.10.5                    # example only: replace with actual Traefik IP/CIDR
COOKIE_SECURE=true
```

---

## 3. HAProxy 2.8+

Best for environments where you want fine-grained control and observability (HAProxy has the best stats page).

### `haproxy.cfg`

```
global
  daemon
  maxconn 4096
  log stdout format raw local0

defaults
  mode http
  log global
  option httplog
  option dontlognull
  # WebSockets can idle for a long time
  timeout connect 5s
  timeout client 10m
  timeout server 10m
  timeout tunnel 1h
  timeout http-request 10s
  timeout http-keep-alive 10s

frontend docker-dash-front
  bind *:80
  bind *:443 ssl crt /etc/haproxy/certs/dashboard.example.com.pem alpn h2,http/1.1

  # Redirect HTTP → HTTPS
  http-request redirect scheme https unless { ssl_fc }

  # WebSocket detection
  acl is_websocket hdr(Upgrade) -i WebSocket

  default_backend docker-dash-back

backend docker-dash-back
  mode http
  balance roundrobin
  # Sticky by cookie
  cookie ddash_lb insert indirect nocache httponly secure

  # Health check
  option httpchk
  http-check send meth GET uri /api/health
  http-check expect status 200

  # Servers
  server replica-1 docker-dash-1:8101 check cookie r1 inter 10s fall 3 rise 2
  server replica-2 docker-dash-2:8101 check cookie r2 inter 10s fall 3 rise 2
  server replica-3 docker-dash-3:8101 check cookie r3 inter 10s fall 3 rise 2

  # Pass WebSocket upgrades
  http-request set-header X-Real-IP %[src]
  http-request set-header X-Forwarded-For %[src]
  http-request set-header X-Forwarded-Proto https
```

### `.env`

```bash
DD_MODE=ha
REDIS_URL=redis://redis:6379
TRUST_PROXY=172.30.10.5                    # example only: replace with actual HAProxy IP/CIDR
COOKIE_SECURE=true
```

---

## 4. Nginx (open-source)

Best if you're already running nginx as your edge. Note: open-source nginx doesn't natively support cookie-based stickiness — use IP-hash instead, or upgrade to nginx Plus / nginx-sticky-module.

### `nginx.conf`

```nginx
upstream docker_dash_backend {
  # IP-hash = same client IP always goes to same replica (sticky by IP).
  # Less precise than cookie stickiness but no external modules required.
  # If behind a NAT / corporate proxy, many users share an IP → uneven
  # distribution. Evaluate for your environment.
  ip_hash;

  server docker-dash-1:8101 max_fails=3 fail_timeout=30s;
  server docker-dash-2:8101 max_fails=3 fail_timeout=30s;
  server docker-dash-3:8101 max_fails=3 fail_timeout=30s;

  keepalive 32;
}

server {
  listen 443 ssl http2;
  server_name dashboard.example.com;

  ssl_certificate     /etc/nginx/certs/dashboard.example.com.pem;
  ssl_certificate_key /etc/nginx/certs/dashboard.example.com.key;

  location / {
    proxy_pass http://docker_dash_backend;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Standard reverse-proxy headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Long-lived connections for WS
    proxy_read_timeout 10m;
    proxy_send_timeout 10m;
  }

  # Optional: passive health check via next_upstream
  # (active checks require nginx Plus or a sidecar)
  proxy_next_upstream error timeout http_502 http_503;
  proxy_next_upstream_tries 3;
}

server {
  listen 80;
  server_name dashboard.example.com;
  return 301 https://$host$request_uri;
}
```

### `.env`

```bash
DD_MODE=ha
REDIS_URL=redis://redis:6379
TRUST_PROXY=172.30.10.5                    # example only: replace with actual nginx IP/CIDR
COOKIE_SECURE=true
```

### Active health checks for open-source nginx (via sidecar)

If `ip_hash` + passive checks aren't good enough and you don't want nginx Plus, a sidecar pattern works:

```bash
# Simple external probe that removes unhealthy replicas from DNS/consul
while true; do
  for replica in docker-dash-1 docker-dash-2 docker-dash-3; do
    if ! curl -sf --max-time 3 http://$replica:8101/api/health > /dev/null; then
      echo "$replica unhealthy"
      # Update nginx upstream (requires NGINX_UPSTREAMS_DYNAMIC module or consul-template)
    fi
  done
  sleep 10
done
```

Most operators running nginx at scale use Consul + consul-template to regenerate the upstream block. Example config is out of scope here.

---

## Verifying your LB setup

After configuring any of the above, verify:

```bash
# 1. Health endpoint returns role info on each replica (direct, not through LB)
for i in 1 2 3; do
  echo "=== replica-$i ==="
  curl -s http://docker-dash-$i:8101/api/health | jq .
done
# Exactly one should show role="leader", rest "reader".

# 2. Through the LB, refresh the browser multiple times and confirm
#    the affinity cookie (ddash_lb) doesn't change.

# 3. WebSocket on /ws succeeds via LB. (Open Network tab in browser,
#    check that the WS upgrade returned 101 and stays open.)

# 4. Force-kill the leader replica and watch:
docker stop docker-dash-1                   # if it was leader
# Within ~10 seconds:
curl -s https://dashboard.example.com/api/health | jq .role
# Should now show a different replica (the new leader)
```

---

## Common pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| No sticky session | WS reconnects loop; subscriptions drop mid-session | Enable cookie affinity (Caddy `lb_policy cookie`, Traefik `sticky.cookie`, HAProxy `cookie ddash_lb insert`) |
| Idle timeout too short | WS disconnects every 30-60s | Set `proxy_read_timeout` / `transport http keepalive` to ≥5 min |
| Missing WebSocket headers | `/ws` returns 400 Bad Request | Pass `Upgrade` + `Connection: upgrade` headers explicitly |
| Health check too aggressive | Replicas flap in/out of pool during leader election | Interval ≥10s, timeout ≥3s, fall ≥3 |
| `TRUST_PROXY` wrong | Docker Dash records the LB IP; its clients share a quota | Set the actual trusted LB IP/CIDR, never its container name; verify header rewriting and direct-access restrictions |
| `COOKIE_SECURE=true` but LB doesn't terminate TLS | Login cookie rejected; users can't log in | Set `COOKIE_SECURE=false` if LB is HTTP → HTTP to backend; or terminate TLS at LB and keep `COOKIE_SECURE=true` |

---

## See also

- [HA Mode reference](ha-mode.md)
- [Failover runbook](ha-failover-runbook.md)
- Source: [src/middleware/csrf.js](../../src/middleware/csrf.js), [src/routes/misc.js](../../src/routes/misc.js) (health + cluster status endpoints)
