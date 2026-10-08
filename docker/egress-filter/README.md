# dd-egress-proxy

Docker Dash Outbound Network Filter sidecar — v6.7 milestone.

## What it does

Hostname-based outbound allowlist for Docker containers. Peeks at the first
packet of each TCP connection, extracts the destination hostname (TLS SNI or
HTTP Host header), compares it to the policy allowlist, and either forwards
the connection to the real destination or resets it.

**No TLS decryption. No cert injection.** The filtered container sees the
destination's real cert, never ours.

## Application authorization

Docker Dash writes schema-2 configuration and resolves each TCP peer to exactly
one running container using live Docker inventory and inspect. Container and
Compose-stack policies on that host are intersected: every enforce policy must
allow the destination. Audit policies cannot override an enforce denial.
Missing policies, ambiguous sources, invalid replies, timeouts and an unavailable
resolver deny new connections. Existing streams keep their initial authorization.

The application creates `resolver.sock` beside `DD_EGRESS_POLICY_PATH`. Mount
that directory into the sidecar at `/etc/dd-egress:ro`; the socket is mode 0600,
so both processes must use a compatible UID. The sidecar requires no Docker
socket. Upgrade both components together: older sidecars see the empty enforce
allowlist in schema-2 files and deny access. Manually supplied legacy files below
remain available for standalone single-policy use.

Source identity assumes a trusted bridge preserving container source IPs. It is
not cryptographic workload attestation: peers able to spoof IP/ARP, privileged
containers and shared NAT require host network isolation/anti-spoofing controls.
Use one local app/resolver/sidecar domain per Docker host. Remote volume/socket
transport is not implemented. Authorization checks do not by themselves prevent
direct traffic bypassing the proxy; the runner's firewall must also be validated.

## Build

Multi-arch (amd64 + arm64):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t docker-dash-egress-filter:v6.7.0-alpha.2 \
  --push \
  .
```

Local build (for the current arch):

```bash
docker build -t docker-dash-egress-filter:local .
```

## Run (standalone, manual testing)

1. Write a `policy.json`:

```json
{
  "version": 1,
  "mode": "enforce",
  "allowlist": ["docker.io", "registry.npmjs.org", "*.github.com"],
  "updated_at": "2026-04-20T10:00:00Z"
}
```

`mode` is one of `enforce` or `audit-only`. The `audit-only` mode logs the
denied attempts to stderr but forwards them anyway — use for migration.
Unknown modes and malformed/oversized policy files are rejected. Failed reloads
keep the previous validated policy.

IMDS endpoints (`169.254.169.254`, `metadata.google.internal`,
`169.254.170.2`, `fd00:ec2::254`) are **always blocked, including audit-only**.
Matching handles trailing DNS dots and IPv4-mapped IPv6. DNS is resolved once;
all returned addresses are checked before dialing a validated IP, so an allowed
DNS alias cannot redirect the proxy to one of these metadata addresses.

2. Run the sidecar:

```bash
docker run --rm \
  --name dd-egress \
  -v "$PWD/policy.json:/etc/dd-egress/policy.json:ro" \
  -p 29193:29193 \
  -e DD_EGRESS_METRICS_LISTEN=:9191 \
  docker-dash-egress-filter:local
```

3. Point a filtered container at it via HTTP_PROXY:

```bash
docker run --rm -it \
  -e HTTP_PROXY=http://dd-egress:29193 \
  -e HTTPS_PROXY=http://dd-egress:29193 \
  --network container:dd-egress \
  alpine sh -c "apk add curl && curl -sI https://registry.npmjs.org"
```

## Environment variables

| Env var | Default | Meaning |
|---|---|---|
| `DD_EGRESS_LISTEN` | `:29193` | Bind address |
| `DD_EGRESS_POLICY_PATH` | `/etc/dd-egress/policy.json` | Policy file path |
| `DD_EGRESS_RESOLVER_SOCKET` | `/etc/dd-egress/resolver.sock` | Private application authorization socket for schema 2 |
| `DD_EGRESS_METRICS_LISTEN` | *(empty → disabled)* | Prometheus-compatible `/metrics` endpoint |
| `DD_EGRESS_BLOCKLOG_PATH` | `/var/log/dd-egress/denied.log` | Append-only deny log |

## Protocol

| First packet | Hostname source |
|---|---|
| TLS 1.2/1.3 | SNI in ClientHello |
| HTTP 1.x | `Host:` header (or `CONNECT host:port`) |
| Anything else | Blocked (`reason=unknown-protocol`). Connect via HTTPS for auto-detect. |

SNI works across all modern TLS clients. Containers that send TLS without SNI
(rare — very old clients) will be blocked.

HTTP headers are bounded to 16 KiB and read through their terminator. Plain HTTP
defaults to port 80, TLS to 443; explicit HTTP/CONNECT ports are validated.
CONNECT receives a proxy `200 Connection Established` response and its headers
are consumed locally before tunnel bytes are forwarded. TLS ClientHello records
are bounded to 16 KiB; fragmented or unsupported handshakes fail closed.

The filter authorizes a connection's destination. It does not inspect subsequent
encrypted traffic or provide per-request authorization inside a tunnel. Custom
transparent TLS ports require an explicit CONNECT destination; the sidecar does
not recover the original destination port from a NAT redirect.

## Verification

With Go 1.27.1, run `go vet ./...`, `go test ./...` and
`go test -fuzz=FuzzSNI -fuzztime=5s -parallel=2`. Tests cover policy rejection,
IMDS pins in every mode, DNS alias/rebinding protection, hostname boundaries,
IPv6/ports, bounded HTTP headers, real TLS ClientHello parsing, CONNECT tunneling
and response delivery after a TCP half-close. All sockets are loopback-only.
CI also runs the race detector; Docker builds run the unit/integration tests
before cross-compilation. Actual container network-namespace/iptables wiring
still requires Docker integration testing.

## Policy reload

Send `SIGHUP` to reload `policy.json` atomically:

```bash
docker kill --signal=HUP dd-egress
```

In-flight connections keep their old policy snapshot; new connections use
the new policy. Validated in preflight P3.

## Metrics

If `DD_EGRESS_METRICS_LISTEN` is set, exposes:

- `GET /health` — `ok policy_v<N> allowlist=<N> mode=<M>`, 503 if no policy
- `GET /metrics` — Prometheus text format:
  - `dd_egress_connections_allowed_total`
  - `dd_egress_connections_blocked_total`
  - `dd_egress_connections_audit_only_total`
  - `dd_egress_upstream_errors_total`
  - `dd_egress_policy_reloads_total`

## What's NOT in the sidecar

- **No iptables/nftables rules.** The sidecar doesn't know about target
  containers' netns — the `egress-runner.js` helper in Docker Dash itself
  installs redirect rules (v6.7.0-rc1).
- **No DB.** Policy comes from disk. Docker Dash writes `policy.json` on
  every create/update and SIGHUPs this sidecar.
- **No TLS decryption.** Deliberate — never break the container's trust chain.

## Image size

~2-2.5 MB (scratch base + static Go binary). P8 preflight measured
5.0 MB amd64 / 4.8 MB arm64 for the binary itself.
