# Security Policy

The MFA, credential and session fixes below are bundled in the privately tested
[8.96.9 deployment candidate](docs/audits/2026-09-20-image-8.96.9.md). Both live
instances remain on 8.96.8. Candidate image findings and the account-email URL
clarification remain open; the candidate is not publicly published.

## OIDC browser binding (source checkpoint, not in the existing candidate)

The [group authorization follow-up](docs/audits/2026-09-20-oidc-group-revocation.md)
treats an empty group list as authoritative and applies the configured default role.
When mapping is enabled, absent/malformed/incomplete groups refuse login and revoke
the exact bound user's sessions, personal API keys, MFA challenges and reset links.
Mapped role changes also revoke old credentials before the new authorization commits.
Denial revocation commits before its audit. Role changes resolve the current role
under one SQLite write lock: a savepoint can roll back new grants while the outer
transaction still commits revocation after an audit/session failure. Corrected
claims require a new login and new API keys;
stored roles on denied logins are retained for review. This observes claims only at
login, not through continuous IdP polling or back-channel logout.

The subsequent [external identity checkpoint](docs/audits/2026-09-20-external-identities.md)
adds migration 181: OIDC issuer/subject and trusted-proxy namespace/subject identify
accounts independently of profile username or email. Collisions provision a separate
account instead of linking local, LDAP, SCIM, legacy SSO or another external identity.
Unbound historical SSO records retain their data/permissions but their credentials are
revoked; they are never automatically claimed. Password recovery and local password
changes are restricted to local accounts. OIDC account/session/audit changes are one
transaction; trusted-proxy roles follow the current asserted groups.

OIDC login now binds state to a five-minute HttpOnly, SameSite=Lax cookie and the
configured issuer, client and callback. The cookie holds a random PKCE verifier;
domain-separated HMACs derive state and nonce. HTTPS uses a host-prefixed Secure
cookie. The callback validates browser binding before atomically consuming state,
sends the S256 verifier and requires a signed ID token with the matching nonce,
issuer, audience/authorized party, subject and numeric lifetime claims. An invalid
or missing ID token cannot fall back to userinfo. Userinfo must have the same
subject and can only supplement missing profile fields, not role claims.

Only the most recent login started in the same browser cookie scope can complete.
In-flight logins from before the update must restart. Existing sessions are not
revoked by this change. Provider errors are not reflected in HTTP responses.
See [OIDC evidence and remaining boundaries](docs/audits/2026-09-20-oidc-browser-binding.md).
The existing 8.96.9 candidate must be rebuilt before these changes can be deployed.

## MFA replay and attempt limits (pending deployment)

Migration 180 records the last accepted TOTP counter and MFA failure/cooldown state.
Enrollment, login and privileged step-up share one counter boundary. A challenge
allows five attempts across TOTP/recovery requests; the account budget spans fresh
challenges and factor endpoints. It uses LOCKOUT_ATTEMPTS and LOCKOUT_DURATION_MS
(defaults: ten failures, thirty minutes), separately from password failures.
Recovery codes also honor the MFA cooldown. Correct factors reset failures;
password verification alone cannot do so. Transaction failures roll back factor
consumption along with credential issuance.

With synchronized clocks, enrolled users may need to wait up to 60 seconds immediately
after upgrade because pre-upgrade code acceptance was not recorded. Replacing the encrypted
authenticator secret resets its replay/cooldown state. See the
[MFA verification audit](docs/audits/2026-09-20-mfa-replay-and-attempts.md).

## Credential lifecycle (pending deployment)

Migration 179 adds a credential version checked after asynchronous password/LDAP
verification and before session/challenge issuance. Database triggers revoke pending
MFA challenges on password, authentication-source, account activity or TOTP enrollment
changes. Password/source/activity changes also invalidate existing sessions and reset
links, so reactivation cannot restore them. Concurrent login failures are serialized.
Password changes and MFA disable operations refuse stale credential snapshots.

Existing MFA enrollment cannot be replaced through setup or repeated enable calls;
it must first be disabled through the authenticated flow. MFA configuration routes
apply the writeable policy gate. Migration 179 clears pre-upgrade pending MFA
challenges, requiring those users to repeat login; established sessions are preserved
by the migration itself. See [evidence and limits](docs/audits/2026-09-20-auth-credential-lifecycle.md).

## Established WebSocket sessions (pending deployment)

The shared `/ws` endpoint revalidates its session digest before messages and
outbound data, after asynchronous stream startup and on a five-second idle sweep.
Revoked/expired sessions, inactive accounts, changed global roles, required password
changes and database failures close the client and its tracked streams. Close code
4003 returns the browser to login without attempting token-in-URL fallback.
The [WebSocket audit](docs/audits/2026-09-20-ws-session-revalidation.md) records native
checks and limits. This does not retract buffered bytes or undo commands already
executed remotely.

The separate `/ws/provider-console` gateway also checks the current global role,
host operate permission and effective console locks before serial/RFB I/O and on
a five-second idle sweep. Pending provider connections and handshake channels are
closed after disconnect/revocation. Storage failures deny access even if recording
the close audit fails. Fragmented reads yield to transport/timers instead of
spinning until their deadline. See the [provider-console audit](docs/audits/2026-09-20-provider-console-revalidation.md).
Provider adapters are mocked in these lifecycle canaries; real hypervisor console
compatibility, sustained throughput and queue/backpressure limits remain open.

## Authentication expiry (pending deployment)

Session, MFA challenge and OIDC state expiry is compared as parsed instants rather
than mixed-format strings. Invalid expiry values are refused. Login lockout and
security alerts now count the SQLite timestamps written by the production path.
MFA redemption and session creation share a write transaction, including recovery
code consumption; OIDC state is consumed atomically before provider requests.
See [verification and open boundaries](docs/audits/2026-09-20-auth-expiry.md).
The follow-up WebSocket checkpoints above add revalidation for the shared `/ws`
endpoint and the separate provider-console endpoint.

## Account recovery hardening (pending deployment)

Reset and invitation emails use the configured `PUBLIC_URL`, falling back to
`BASE_URL`. Configure the address users can reach, preferably HTTPS; the browser
can no longer choose the link destination. SMTP must be configured. Reset links
expire after 15 minutes, invitations after 24 hours. Token redemption rechecks
expiry and account activity after hashing and commits the password, token/session
invalidation and audit together. Password/email changes and deactivation revoke
outstanding account links. SMTP errors no longer expose message bodies to logs
or callers. Previously written logs, backups and reverse-proxy access logs are
outside this change; a clean application log now does not erase historical tokens.

See [verification and rollout status](docs/audits/2026-09-20-password-reset.md).
Public responses finish before account lookup or SMTP. Recovery delivery has
a per-process bound of 32 active/queued jobs and two workers, plus a shared
three-per-account hourly quota (Redis fixed windows in HA, local sliding windows
in standalone). Quota errors/timeouts refuse delivery. Pending work is volatile;
shutdown discards it and revokes in-flight links. Full queues return the same
generic response, so that response is not a delivery guarantee. Admin-triggered
email remains authenticated and synchronous. This change does not certify the
broader recovery flow or the deployment's transport security.

## Audit 2026-09-19 (working tree, pending release)

See [the audit report](docs/audits/2026-09-19-project-security.md) for changes,
validation evidence, dependency exceptions and deployment checks still required.
The historical audit entries below describe their original releases, not the
current vulnerability state. A clean dependency scan is not a security guarantee.

Outbound HTTPS/SMTP connections now verify certificates. For internal PKI, set
`NODE_EXTRA_CA_CERTS` to a PEM CA bundle readable inside the container; mount the
bundle read-only. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`. LDAP requires
verified LDAPS or StartTLS before any bind. The legacy TLS-verification bypass
is rejected; configure a verified CA in the LDAP settings for private PKI.
See the built-in `ldap-tls` guide for migration and certificate rotation.

LDAP service-account passwords are encrypted by migration 174 on startup. Keep
`ENCRYPTION_KEY` stable and backed up. Existing database backups/WAL snapshots may
still contain the old plaintext password; protect them and rotate that credential.
LDAP group restrictions now require the complete group DN (case-insensitive).

Container rollback snapshots are encrypted by migration 176 and on every new
history write. Authentication binds the snapshot to its host/container/image
identity; corrupt, plaintext or mismatched snapshots are refused before Docker
mutation. Encryption or storage failure also stops the update. Preserve the
installation key for recovery. This protects live records, not historical backup,
WAL or free-page copies, and does not make Docker replacement transactional. See
the built-in `rollback-history` guide for recovery and retention boundaries.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 8.96.x  | :white_check_mark: (current) |
| 8.1.x   | :white_check_mark: (security fixes only) |
| 8.0.x   | :white_check_mark: (security fixes only) |
| 7.x     | :warning: (best-effort security fixes; please upgrade to 8.x) |
| < 7.0   | :x: (unsupported — multiple breaking security improvements since) |

## Reporting a Vulnerability

If you discover a security vulnerability in Docker Dash, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to report

1. **GitHub:** Use [GitHub's private vulnerability reporting](https://github.com/bogdanpricop/docker-dash/security/advisories/new)
2. **Email:** Send details to the repository owner via GitHub profile

### What to include

- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)
- Affected version(s)
- Suggested fix (if you have one)

### What to expect

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 1 week
- **Fix:** Critical issues fixed within 72 hours, others within 2 weeks
- **Credit:** You will be credited in the release notes (unless you prefer anonymity)

## Security Architecture

### Authentication & Authorization
- **bcrypt** password hashing (12 rounds, configurable)
- **Session tokens** generated with `crypto.randomBytes(32)`, SHA-256 hashed before DB storage
- **Role-based access control** — admin, operator, viewer roles on every endpoint
- **Account lockout** after configurable failed attempts (default: 10) with timed lockout
- **IP-based rate limiting** on login (5/15min) and API endpoints (100/min)
- **SSO support** — Authelia, Authentik, Caddy forward_auth, Traefik (X-Forwarded-User headers)
- **API key authentication** as alternative to session-based auth
- **Forced password change** on first login for default admin
- **Password policy** — minimum 12 characters + uppercase, lowercase, digit and symbol + common password rejection, enforced via single `validatePassword()` on all password-setting flows (change-password, reset-password, create-user, token-based reset)

### Encryption & Secrets
- **AES-256-GCM** encryption for credentials at rest (Git tokens, SSH keys, registry passwords, notification tokens)
- **scrypt KDF** for encryption key derivation (N=16384, r=8, p=1) — not improvised padding
- **Startup validation** — calls `process.exit(1)` in production if APP_SECRET < 32 chars or ENCRYPTION_KEY < 16 chars, or if either matches a known default value
- **No hardcoded credentials** in source code (verified by automated scan)

### Input Validation & Injection Prevention
- **Parameterized SQL** queries everywhere (better-sqlite3 with `?` placeholders)
- **execFileSync** for all shell commands — zero `execSync` with template literal interpolation
- **Input validation middleware** — `validateId`, `validateBody`, `sanitizeBody`
- **Prototype pollution protection** — strips `__proto__`, `constructor`, `prototype` from request bodies
- **Git URL validation** — rejects shell metacharacters (`;&|$(){}`)
- **Compose path validation** — prevents path traversal (`../`)
- **ReDoS protection** — user regex limited to 200 chars with execution timeout
- **Error sanitization** — 5xx errors never leak internal file paths or credentials

### Transport & Headers
- **Helmet.js** security headers (X-Content-Type-Options, X-Frame-Options, CSP)
- **HTTPS** via Caddy reverse proxy (self-signed for internal, Let's Encrypt for public)
- **HSTS** headers via Caddy
- **Cookie flags** — HttpOnly, SameSite=Strict + Secure when HTTPS detected (falls back to SameSite=Lax on plain HTTP)
- **Trust proxy** restricted to loopback in production (prevents IP spoofing)
- **JSON body limit** — 2MB (prevents DoS via large payloads)
- **Request timeout** — 5 minutes (prevents hanging requests)

### Docker Socket Access
- Socket mounted **read-only** (`:ro`) in production docker-compose
- `no-new-privileges` security option enabled
- Feature flags to disable dangerous operations (`ENABLE_EXEC=false`, `READ_ONLY_MODE=true`)
- Audit log for every action with user, timestamp, and IP address

### Monitoring & Detection
- **Audit trail** — every user action logged (create, update, delete, deploy, login)
- **Event-driven notifications** — container crash, OOM kill, health failure auto-sent to Discord/Slack/Telegram
- **Workflow automation** — IF-THEN rules for automated response (restart on crash, notify on high CPU)
- **Daily automated backups** — cron at 02:00, keeps last 7 days

## Testing

- **1122 tests** across 70 test suites (100% passing; 4 skipped are live-Cloudflare ACME integration tests gated on a CI secret)
- Unit tests: crypto round-trip, input validation, shell sanitization, git patterns, AI redactor (33 cases — Bearer/env-assignment/connection-string/tokens/IP/email patterns), retention pure-evaluator (27 cases — 5 safety layers + protected-pattern globs), provenance parser (15 cases — OCI annotation linkifier + cosign presence detector), pCloud HTTP client (16 cases — auth/quota/retry/region routing)
- Integration tests: auth flow (login, session, logout, SSO), API endpoints (supertest), RBAC, security alerts, registry push/browse/delete + retention apply, AI provider abstraction with MockAiProvider, pCloud backup orchestration (14 cases), audit-log monthly dump with hash-chain integrity round-trip (gzip → upload → download → gunzip → chain-walk)
- **CI pipeline** — GitHub Actions runs tests + syntax check + `npm audit` + ESLint on every push (lint enforcement added in v7.7.0 — fails on any warning)
- **ESLint** — `no-eval`, `no-implied-eval`, `no-new-func`, `eqeqeq` rules enforced

## Security Audit History

| Date | Audit Type | Findings | Status |
|------|-----------|----------|--------|
| 2026-03-27 | Tech Debt Scan | 4 CRITICAL, 9 HIGH, 12 MEDIUM, 8 LOW | All CRITICAL+HIGH fixed |
| 2026-03-27 | Production Readiness v1 | Score: 7.4/10 | Improved to 8.2 |
| 2026-03-28 | Production Readiness v2 | Score: 8.8/10 | All P0+P1 resolved |
| 2026-03-28 | Shell Injection Audit | 0 vectors remaining | All execSync eliminated |
| 2026-03-28 | Final Security Scan | 0 warnings on server | Clean |
| 2026-04-22 | Production Readiness v6.16.1 → v7.0.0 | Score: 9.7 → 9.8/10 | HA mode production-ready (Redis-backed leader election + WS pub/sub) |
| 2026-04-27 | AI Features Pre-Release Spike (S4) | Redactor 100/100 on 27-case corpus | Bearer/env-assignment/connection-string patterns; bad custom regex aborts AI call |
| 2026-04-27 | AI Audit Trail Review | Every AI call writes provider + model + token counts + redaction counts + SHA-256 payload hash | Compliance-grade audit; operators can prove "did this exact text get sent?" without storing the prompt |
| 2026-04-29 | Registry Hygiene Pack Safety Review | 5 retention safety layers (default-disabled, min-3-tags floor, default protected patterns, server cap 200/run, audit per delete) | All 5 layers have dedicated regression tests in `retention.test.js` |
| 2026-05-05 | pCloud Backup Encryption Review | AES-256-GCM token at rest (existing `ENCRYPTION_KEY`), pre-flight quota gate at 95% + 50 MB safety margin, hash-chain preserved row-for-row across monthly dumps | Token never logged, never returned in GET responses; only the long-lived auth token persisted (password discarded after exchange) |
| 2026-05-05 | Dependency Audit (`npm audit --omit=dev`) | 1 moderate: `uuid <14.0.0` via `dockerode 4.x` (GHSA-w5hq-g745-h8pq) | Accepted initially; CLOSED same-day by upgrading to dockerode 5.x (zero API breaks; uuid dependency dropped upstream). `npm audit` now reports **0 vulnerabilities** |
| 2026-05-05 | Post-release remediation pass (waves 1-3) | 22 audit-identified issues, all closed | +234 tests (1122→1356/80 suites), CSP tightened to strict `'self'` (all CDN deps self-hosted), Egress UI extracted from monolith, a11y at Modal+Toast component level, dockerode 5 upgrade, 84 howtos migrated to markdown |

## Known Security Tradeoffs

The following are conscious design decisions, not oversights. Each represents a tradeoff between security hardening and product functionality.

### 1. CSP allows `unsafe-eval` (but NOT `unsafe-inline`)

**What:** The Content Security Policy permits `eval()` via `'unsafe-eval'` in scriptSrc. Inline scripts (`'unsafe-inline'`) have been **eliminated** as of v5.0.

**Why:** `unsafe-eval` is required by Chart.js 4.x which uses `new Function()` internally. Removing it would require replacing the charting library entirely.

**What was fixed (v5.0):** All 67 inline event handlers (`onclick=`, `onchange=`, etc.) across 12 files were converted to `addEventListener`. CSP `scriptSrc` no longer includes `'unsafe-inline'`, and `scriptSrcAttr` is set to `'none'`.

**Remaining:** `styleSrc` still allows `'unsafe-inline'` because inline `style="..."` attributes are used extensively and cannot be eliminated without a CSS-in-JS build step.

**Impact:** XSS via inline `<script>` injection is now blocked by CSP. XSS via `eval()` remains theoretically possible but requires an attacker to inject code that calls eval — mitigated by output escaping (`Utils.escapeHtml()`, 400+ usages).

**Mitigation:** Output escaping on all user-facing content. Helmet.js provides all other security headers. The application never calls `eval()` directly — only Chart.js does internally.

### 2. WebSocket accepts authentication token via query string

**What:** The WebSocket endpoint accepts the session token via `?token=` query parameter as a fallback when cookies are blocked.

**Why:** Some browsers (Edge with Tracking Prevention, Chrome with strict third-party cookie settings) block cookies on HTTP connections to IP addresses. Without the query param fallback, these users cannot use the real-time dashboard, terminal, or live logs.

**Impact:** Tokens in URLs can be exposed in server access logs, browser history, and referrer headers. OWASP recommends against passing sensitive data in URLs.

**Mitigation:** Cookie-based auth is always preferred — query param is only used when cookies fail. When query param auth is detected, it is logged at debug level for monitoring. HTTPS (via included Caddy config) encrypts the URL in transit. The token is a session token (not a permanent credential) with configurable TTL. **In `SECURITY_MODE=strict`, WebSocket query-string auth is completely disabled.**

### 3. Mixed authentication model (cookie + Bearer + API key)

**What:** The application accepts three authentication methods: session cookies (primary), Bearer tokens in Authorization header (API/CLI), and API keys (integrations).

**Why:** Session cookies are optimal for browser UI. Bearer tokens are needed for programmatic API access (scripts, CLI tools, monitoring). API keys enable long-lived integrations (Prometheus scraping, CI/CD webhooks).

**Impact:** More authentication paths means more surface area to secure. Each path must be independently validated and rate-limited.

**Mitigation:** Session cookies and Bearer tokens validate against the `sessions` table. API keys validate against a separate `api_keys` table with independent creation/revocation and **permission enforcement** (read-only keys are blocked from POST/PUT/DELETE by middleware). Rate limiting applies regardless of auth method. Audit log records the authentication method used. **In `SECURITY_MODE=strict`, the login response body omits the token entirely (cookie-only); Bearer and API key auth via Authorization header remain available by design.**

### 4. SSO header-based authentication

**What:** When `ENABLE_SSO_HEADERS=true`, the application trusts `X-Forwarded-User` headers to authenticate users without password verification.

**Why:** Common pattern for integration with Authelia, Authentik, Caddy forward_auth, and Traefik. These reverse proxies handle the actual authentication and inject the username header.

**Impact:** If the application is accidentally exposed without the trusted reverse proxy, an attacker can forge the header and authenticate as any user. This is the most operationally dangerous setting in Docker Dash.

**Mitigation:** Disabled by default (`ENABLE_SSO_HEADERS=false`). SSO assertions require the immediate socket peer to appear in `SSO_TRUSTED_PROXY_IPS`; a forwarded end-client address cannot grant this trust. `TRUST_PROXY` defaults to `loopback` in every environment and accepts explicit proxy IPs/CIDRs or `false`. The authentication proxy must strip incoming identity headers and set verified values. Restrict direct application access accordingly.

### 5. Rate limiter backend depends on deployment mode

**What:** In **standalone mode (default)**, the HTTP rate limiter uses an in-memory `Map` — sliding-window semantics. In **HA mode (`DD_MODE=ha`, v6.17.0+)**, the rate limiter backs onto Redis `INCR` + `PEXPIRE` — fixed-window semantics, shared across all replicas.

**Why:** Zero external dependencies is the default positioning; standalone users get rate limiting without running Redis. HA deployments opt into Redis anyway (for leader election + pub/sub), and the rate-limiter win — enforcing limits across N replicas instead of `limit × N` effective — is free on top of the existing Redis.

**Impact:**
- **Standalone:** rate limits reset on process restart. In a single-replica deploy that's appropriate; restart is rare.
- **HA (fixed-window):** 2× theoretical burst at bucket boundaries compared to sliding-window standalone. Example: a `10 req/min` limit could allow up to 20 requests in a 2-second window spanning two buckets. Average case is identical; burst matters only for DDoS-class inputs which are not what an internal rate limiter is for anyway.
- **HA (Redis unavailable, full, invalid response or delayed beyond three seconds):** fail-closed — HTTP 503 with `Retry-After: 3`; protected handlers do not run. HTTP 429 remains reserved for a confirmed exhausted quota. Late Redis results cannot resume the abandoned request.

Quota keys use a fixed configured scope and the client IP resolved by Express's proxy trust policy. Changing URL parameters, route capitalization, query strings or untrusted forwarding headers cannot create a new quota. The shared API limiter is one per-client budget across its mounted routes; login, MFA, reset and other dedicated limiters use separate named scopes. Configure trusted proxy addresses correctly to avoid grouping clients under a proxy address. This complements account lockout and RBAC; it does not replace them or upstream connection/DDoS controls.

A successful admission is reused only when the same limiter instance sees the same HTTP request again during router fallthrough. Other limiter instances still enforce their own quotas. Standalone cleanup follows each stored window's configured duration, including durations longer than an hour; it cannot replenish an unexpired budget. Expired client entries are reclaimed by the periodic cleanup. See the [quota lifecycle audit](docs/audits/2026-09-20-quota-lifecycle.md) for validation and deployment status.

**Mitigation:** Documented in [docs/features/ha-mode.md](docs/features/ha-mode.md#rate-limiter-semantics). Both modes implement the same API surface (`X-RateLimit-Remaining` response header, `Retry-After` on 429), so clients can't tell which backend is serving them. For target audiences (homelab standalone, corporate HA), both enforcement shapes are appropriate.

### 6. Docker socket access is inherently privileged

**What:** Docker Dash requires read access to the Docker socket to function.

**Why:** This is inherent to the entire category of Docker management tools (Portainer, Dockge, Lazydocker, etc.). There is no way to list/manage containers without socket access.

**Impact:** A compromised Docker Dash instance could potentially be used to escape to the host via Docker API. This is a structural limitation of all Docker management dashboards.

**Mitigation:** Socket mounted read-only (`:ro`) in production compose. `no-new-privileges` security option. Feature flags to disable dangerous operations (`ENABLE_EXEC=false`, `READ_ONLY_MODE=true`). Multi-user RBAC limits what each role can do. Audit trail on all actions.

### 7. Historical: moderate CVE `uuid <14.0.0` via `dockerode 4.x` — **CLOSED 2026-05-05**

**Status:** Closed. Upgraded to `dockerode 5.0.0` in the v8.2.x post-audit remediation pass. dockerode 5 dropped the `uuid` package entirely, so the transitive advisory ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)) is no longer reachable. `npm audit --omit=dev` now reports **0 vulnerabilities**.

**Why the upgrade was non-breaking despite the major version bump:** dockerode 5.0.0's release notes (verified in advance) listed only "dropped uuid package, bumped minimum Node version requirement" as the breaking change. No public API changed. All 1356 tests passed without modification on first try.

**Kept here as historical record** so a future maintainer reading the audit history understands the rationale for the original "accepted" status and the path that closed it.

## Deployment Recommendations

| Deployment scenario | Mode | Suitability | Notes |
|---|---|---|---|
| Homelab / personal | Standalone | **Excellent** | Ideal use case. Run behind HTTPS, generate strong secrets. |
| Small team / staging | Standalone + `--profile tls` | **Excellent** | Caddy handles HTTPS + Let's Encrypt. Use SSO if available (LDAP / Authelia / Authentik). |
| Production (internal, single-host) | Standalone | **Good** | Restrict network access, use TLS, disable exec if not needed. |
| Production (internal, high-availability) | **HA** (`DD_MODE=ha`) | **Good** — v7.0.0+ | 2-3 replicas + Redis + sticky-session LB. Leader election + cross-replica WS + Redis rate limiter. Followed by staging soak per the [failover runbook](docs/features/ha-failover-runbook.md). |
| Public internet | Standalone or HA | **Capable with caveats** | Must use HTTPS, strong secrets, and understand CSP trade-off (`unsafe-eval` for Chart.js). |
| Multi-tenant SaaS | — | **Not recommended** | Docker Dash assumes one organization per instance. No tenant isolation layer. |
| Geographic multi-region active-active | — | **Not supported** | SQLite single-writer limits HA to same-AZ. Would require a Postgres backend (not on current roadmap). |

## Vulnerability Fixes (v3.7.1 — v3.9.0)

| CVE-like | Severity | Description | Fix |
|----------|----------|-------------|-----|
| DD-001 | CRITICAL | Command injection via Docker labels in execSync | Replaced with execFileSync + arg arrays |
| DD-002 | CRITICAL | ReDoS via user-supplied regex in log search | Length limit (200) + execution timeout |
| DD-003 | CRITICAL | Smart-restart DoS blocking event loop 120s | Return backoff to client, no server sleep |
| DD-004 | CRITICAL | Unvalidated request bodies (prototype pollution) | validate.js middleware on all endpoints |
