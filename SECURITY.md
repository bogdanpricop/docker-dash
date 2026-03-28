# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 4.x     | :white_check_mark: |
| 3.x     | :white_check_mark: (security fixes only) |
| < 3.0   | :x:                |

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
- **Password policy** — minimum 8 characters everywhere (unified across all endpoints)

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
- **Cookie flags** — HttpOnly, SameSite=Lax (Secure when behind HTTPS)
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

- **104 tests** across 8 test files (100% passing)
- Unit tests: crypto round-trip, input validation, shell sanitization, git patterns
- Integration tests: auth flow (login, session, logout, SSO), API endpoints (supertest)
- **CI pipeline** — GitHub Actions runs tests + syntax check + npm audit on every push
- **ESLint** — `no-eval`, `no-implied-eval`, `no-new-func`, `eqeqeq` rules enforced

## Security Audit History

| Date | Audit Type | Findings | Status |
|------|-----------|----------|--------|
| 2026-03-27 | Tech Debt Scan | 4 CRITICAL, 9 HIGH, 12 MEDIUM, 8 LOW | All CRITICAL+HIGH fixed |
| 2026-03-27 | Production Readiness v1 | Score: 7.4/10 | Improved to 8.2 |
| 2026-03-28 | Production Readiness v2 | Score: 8.8/10 | All P0+P1 resolved |
| 2026-03-28 | Shell Injection Audit | 0 vectors remaining | All execSync eliminated |
| 2026-03-28 | Final Security Scan | 0 warnings on server | Clean |

## Vulnerability Fixes (v3.7.1 — v3.9.0)

| CVE-like | Severity | Description | Fix |
|----------|----------|-------------|-----|
| DD-001 | CRITICAL | Command injection via Docker labels in execSync | Replaced with execFileSync + arg arrays |
| DD-002 | CRITICAL | ReDoS via user-supplied regex in log search | Length limit (200) + execution timeout |
| DD-003 | CRITICAL | Smart-restart DoS blocking event loop 120s | Return backoff to client, no server sleep |
| DD-004 | CRITICAL | Unvalidated request bodies (prototype pollution) | validate.js middleware on all endpoints |
