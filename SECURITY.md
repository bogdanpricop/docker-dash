# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 3.x     | :white_check_mark: |
| < 3.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Docker Dash, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to report

1. **Email:** Send details to the repository owner via GitHub (profile contact)
2. **GitHub:** Use [GitHub's private vulnerability reporting](https://github.com/bogdanpricop/docker-dash/security/advisories/new)

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

## Security Measures

Docker Dash implements:

- **bcrypt** password hashing (12 rounds)
- **AES-256-GCM** encryption for credentials at rest (scrypt KDF)
- **Parameterized SQL** queries (zero string concatenation)
- **execFileSync** for all shell commands (no template literal injection)
- **Rate limiting** on auth and deploy endpoints
- **Input validation** middleware with prototype pollution protection
- **Helmet.js** security headers (CSP, X-Frame-Options, HSTS via Caddy)
- **Session tokens** SHA-256 hashed in database
- **Startup validation** rejects weak secrets in production
- **67 unit + 17 integration tests** covering security-critical paths
- **ESLint** with no-eval, no-implied-eval, no-new-func rules
- **CI pipeline** with npm audit on every push

## Security Audit History

| Date | Auditor | Findings | Status |
|------|---------|----------|--------|
| 2026-03-27 | Internal (Claude Code) | 4 CRITICAL, 9 HIGH, 12 MEDIUM, 8 LOW | All CRITICAL+HIGH fixed |
| 2026-03-27 | Production readiness audit | Score: 9.2/10 | All P0+P1 resolved |
