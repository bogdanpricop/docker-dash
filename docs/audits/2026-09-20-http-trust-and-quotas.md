# HTTP identity and quota enforcement, 20 September 2026

Status: deployed in [8.96.7 on LAN and VPS](2026-09-20-deployment-8.96.7.md).
Both applications remain standalone, with SSO disabled and no custom proxy trust.
Eight HTTP/Redis scenarios per host passed against hash-verified bundled sources
in the [final image](2026-09-20-image-8.96.7.md).

## Corrected trust boundaries

`getClientIp` formerly preferred the leftmost `X-Forwarded-For` value or
`X-Real-IP` without consulting Express's trusted-proxy configuration. This
allowed direct callers to rotate rate-limit identities and forge audit IPs.
It now uses Express's resolved `req.ip`, falling back only to the socket address
for raw Node requests. The default proxy policy is `loopback` in every
environment, removing the former implicit trust-all development default.
Explicit proxy IPs/CIDRs and `false` are supported; blanket `true` and hop counts
are refused. Express validates the supplied addresses when configuring the app.

SSO assertion trust is checked separately against the immediate socket peer.
An end-client address supplied through forwarding headers cannot satisfy
`SSO_TRUSTED_PROXY_IPS`. A trusted proxy may forward a client outside that
allow-list without losing its own assertion authority. The proxy must still
authenticate users and overwrite incoming identity/forwarding headers. This
follows [Express's documented proxy trust model](https://expressjs.com/en/guide/behind-proxies/).

## Corrected quota behavior

The old limiter allowed protected handlers to run when Redis failed and could
wait indefinitely for a backend response. It now requires a valid quota decision
within three seconds. Failure, OOM, invalid responses and deadlines return HTTP
503 with `Retry-After: 3`. Only a confirmed exhausted quota returns HTTP 429.
Late results cannot call the next handler or write another response.

Keys now use fixed configured scopes, not request URLs. Changing a resource ID,
route case or query string cannot create a fresh API budget. The shared API
limiter uses one per-client scope across its mounts. Login, MFA verification,
MFA recovery, reset requests, reset-token validation, password reset, public
webhooks, status pages, Git deploy and procedure execution have named scopes.
Invalid counts/windows are refused during middleware construction.

## Validation

- **361 Jest suites passed: 4,736 tests passed, one omitted.** Thirty-two new
  tests cover trusted/untrusted proxy chains, forged headers, stable scopes,
  separated clients/scopes, invalid quota responses, bounded failures, late
  success, abandoned responses, and SSO socket-peer trust.
- All six actual public login/MFA/password-reset routes were tested with an
  unavailable quota backend: each returned 503 without setting a session cookie
  or reaching authentication/database work.
- Lint passed. New smoke scripts and configuration helpers passed syntax checks.
- Eight native HTTP/Redis scenarios passed on **each** authorized Docker host:
  direct-client identity spoofing refusal; shared quota despite URL/case/header
  changes; closest-untrusted-hop resolution; real Redis `CLIENT PAUSE` producing
  bounded 503; no mutation after a late reply; recovery after pause; rejection
  under Redis `noeviction` memory pressure; recovery after pressure removal.

The [JSON evidence](2026-09-20-http-trust-and-quotas.json) records source hashes,
image identities and both observations. The controller used the deployed 8.96.6
image with the explicitly listed source files overlaid in its own filesystem.
These were real Express HTTP requests and real Redis commands, but the protected
mutation was a disposable counter. No production authentication or mutation was
attempted, and no production database was used.

Redis was bound to loopback inside a namespace shared only with the disposable
controller, authenticated with a generated test-only password. There were no
published ports or production/socket mounts. All owned containers and ephemeral
Redis data were removed after the checks. The backend was the same pinned Redis
8.10.1 test image documented in the [lease audit](2026-09-20-ha-lease.md); this is
not a recommendation to deploy that version. The newer 8.10.2 official image was
not available at the preceding check.

To reproduce, pull that pinned test image, set `DD_SMOKE_APP_IMAGE` to an exact
application image ID and `DD_SMOKE_DOCKER_URL` to a verified SSH loopback Docker
forward, then run `node scripts/smoke-http-quota.js`.

## Rollout considerations and remaining limits

Verify actual `TRUST_PROXY` and `SSO_TRUSTED_PROXY_IPS` values before rollout.
Proxy service DNS names are not accepted address lists. Use exact proxy IPs or
appropriately restricted CIDRs, and verify header rewriting and direct-access
restrictions. With proxy trust disabled or misconfigured, clients behind one
proxy share its IP budget; the application does not guess their identities.

The existing default API limit is now genuinely shared across its mounts:
100 requests per minute per resolved client, unless configured otherwise.
Named keys differ from legacy URL keys, so this rollout begins new quota windows;
mixed application versions do not share equivalent counters. Drain/restart
replicas in a controlled rollout and retain account lockout/proxy controls.

Redis outages intentionally reduce availability of rate-limited routes. Final-image
testing found that health was still mounted behind the shared API limiter; this
was corrected before deployment. Exact GET/HEAD `/api/health` probes now precede
the limiter; health-prefix lookalikes remain limited. A timed-out Redis
command may still consume quota later; it cannot resume protected work. The
lease connection's no-replay behavior is separate from the general quota client.
Fixed-window HA bursts, standalone resets after restart, distributed-source
attacks, upstream connection limits and trusted-proxy compromise remain separate
concerns. This correction does not certify all authentication or network paths.

## Rezumat operational

Headerele trimise de un client direct nu mai pot schimba IP-ul folosit la audit
si limitare. SSO verifica proxy-ul conectat direct, separat de IP-ul clientului.
La indisponibilitatea Redis, cererile limitate primesc 503 in cel mult aproximativ
trei secunde; operatia protejata nu porneste. Schimbarea URL-ului sau a literelor
din ruta nu mai creeaza un buget nou. Verifica IP-urile proxy-urilor si limitele
configurate inainte de deploy. Corectiile sunt testate pe ambele hosturi in
containere temporare si instalate in aplicatiile live 8.96.7.
