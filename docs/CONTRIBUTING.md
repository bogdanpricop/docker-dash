# Contributing to Docker Dash

Thanks for your interest! This guide gets you from `git clone` to a merged PR in **about an hour**, assuming you have Node.js 24.21+ and Docker installed.

> **TL;DR for the impatient**: clone → `npm install` → `cp .env.example .env` → `npm run dev` → open `http://localhost:8101` → log in as `admin` / `admin` → start editing files. The page at `/sample-feature` (admin-only) is a working reference; copy it to start your own contribution.

---

## Table of contents

1. [Local setup](#1-local-setup)
2. [Project layout (1-pager)](#2-project-layout-1-pager)
3. [The 12-step checklist for a new page](#3-the-12-step-checklist-for-a-new-page)
4. [Conventions](#4-conventions)
   - [Security](#security)
   - [RBAC + audit](#rbac--audit)
   - [i18n](#i18n)
   - [Error handling](#error-handling)
   - [Logging](#logging)
5. [Tests + lint](#5-tests--lint)
6. [Versioning + release flow](#6-versioning--release-flow)
7. [Pull request template](#7-pull-request-template)
8. [What we won't merge](#8-what-we-wont-merge)
9. [Getting help](#9-getting-help)

---

## 1. Local setup

### Prerequisites

- **Node.js 24.21+** (`node --version` must report `v24.21.x` or later in the Node 24 LTS line)
- **Docker** (engine + CLI; needed because Docker Dash *manages Docker* — most features need a real socket to talk to)
- **Git** for cloning + branching

Optional but recommended:
- **VS Code** with the ESLint extension
- A second terminal for `docker compose logs -f`

### Steps

```bash
# 1. Clone + install
git clone https://github.com/bogdanpricop/docker-dash.git
cd docker-dash
npm install

# 2. Configure
cp .env.example .env
# Edit .env if needed. Defaults work for local dev.
# Generate a strong APP_SECRET if you'll test in production mode:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Run in dev mode (auto-restart on file changes)
npm run dev

# 4. Open the UI
open http://localhost:8101
# Log in as admin / admin (you'll be prompted to change the password
# on first login — pick anything, it's local).
```

### Connecting to Docker

By default the dev process connects to your local Docker socket (`/var/run/docker.sock` on macOS/Linux, `\\.\pipe\docker_engine` on Windows). If you don't have Docker running, the app starts but most pages will show errors — that's fine for frontend-only work.

### Database

Uses SQLite (`/data/docker-dash.db` in the running container, `./data/docker-dash.db` in dev mode unless `DB_PATH` overrides). Migrations apply automatically at startup — see `src/db/migrations/`.

---

## 2. Project layout (1-pager)

```
docker-dash/
├── src/                          ← Backend (Node.js + Express + better-sqlite3)
│   ├── server.js                 ← Express app + helmet + middleware + route mounts
│   ├── version.js                ← Auto-synced from package.json
│   ├── config/                   ← Env-var parsing (single source of truth)
│   ├── db/                       ← SQLite + migration runner
│   │   └── migrations/           ← Numbered SQL/JS migrations (000_initial → 060_…)
│   ├── routes/                   ← Express routers — one file per feature
│   ├── services/                 ← Business logic — pure(ish) functions
│   ├── jobs/index.js             ← Cron jobs (leader-gated in HA via _m wrapper)
│   ├── middleware/               ← auth, csrf, hostId extraction
│   ├── utils/                    ← logger, helpers, asyncHandler
│   ├── ws/                       ← WebSocket server (auth + pub/sub + cross-replica)
│   └── __tests__/                ← Jest unit tests (900+ across ~60 suites)
│
├── public/                       ← Frontend (vanilla JS, no build step)
│   ├── index.html                ← Single-page shell with all <script> tags
│   ├── css/app.css               ← One file, ~1500 lines, CSS variables for theming
│   └── js/
│       ├── app.js                ← Router (App._pages registry) + auth flow
│       ├── api.js                ← Fetch wrapper (CSRF, Bearer token, 401 handling)
│       ├── ws.js                 ← WebSocket client (cookie-first auth + reconnect)
│       ├── i18n.js + i18n/*.js   ← 11 languages, EN is source-of-truth
│       ├── components/           ← Modal, Toast, Table, ContextMenu, etc.
│       ├── pages/                ← One file per page (lazy-loaded for big ones)
│       └── update-notifier.js    ← v7.3.0 — sidebar update badge
│
├── docker/                       ← Compose profiles (caddy, observability, etc.)
├── docs/                         ← Operator docs + this contributor guide
│   └── features/                 ← Per-feature deep dives
├── examples/                     ← Reference implementations
│   └── sample-feature/           ← The page wired up at /sample-feature
└── scripts/                      ← npm-lifecycle scripts (sync-version.js, etc.)
```

**Key rule**: backend code never imports frontend code, and vice versa. The contract is HTTP (REST + WebSocket).

---

## 3. The 12-step checklist for a new page

Open [`examples/sample-feature/README.md`](../examples/sample-feature/README.md) and follow it step-by-step. The TL;DR (for when you've done it once already):

1. **Service** — `src/services/<feature>.js` (pure logic, DB I/O)
2. **Route** — `src/routes/<feature>.js` (HTTP, RBAC, audit)
3. **Mount route** in `src/server.js` (before `/api` catch-all)
4. **WS broadcaster** wired in `src/server.js` (only if you broadcast)
5. **Cron job** in `src/jobs/index.js` (only if periodic)
6. **Page** — `public/js/pages/<feature>.js`
7. **Register** in `App._pages` (`public/js/app.js`)
8. **Script tag** in `public/index.html`
9. **Sidebar entry** in `public/index.html`
10. **i18n keys** in `public/js/i18n/en.js` + `ro.js`
11. **Tests** — `src/__tests__/<feature>.test.js`
12. **Bump version + CHANGELOG + What's New**

**Most features don't need all 12.** A read-only stats page might skip 4, 5, 9. A CLI-only utility might be just 1 + 11.

---

## 4. Conventions

### Security

- **CSP is strict** (`script-src 'self' <CDN allowlist>`, `script-src-attr 'none'`). No inline `<script>`, no inline `onclick=`. Move handlers to external `.js` files (see `public/js/login-reset.js` for the pattern).
- **No `eval()`, no `new Function()`**. The CSP allows `unsafe-eval` only for Chart.js — kept as a documented tradeoff in `SECURITY.md`.
- **All user input validated server-side**. Client-side validation is for UX only.
- **Parameterized queries only** (`db.prepare('... WHERE x = ?').get(value)`). Never string-concat SQL.
- **Never log secrets, tokens, passwords**. Audit log entries are searchable forever.
- **No outbound HTTP without disclosure**. Update-check is the only one and it's toggleable; if you add another, document it + provide an opt-out.

### RBAC + audit

Three roles: `viewer` (read-only), `operator` (mutate non-destructive), `admin` (everything + destructive).

```js
// Reads — any authenticated user
router.get('/things', requireAuth, asyncHandler(async (req, res) => { ... }));

// Mutate — operator + admin
router.post('/things', requireAuth, requireRole('admin', 'operator'), asyncHandler(...));

// Destructive — admin only + audit log
router.delete('/things/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  // do the work
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'thing_deleted',
    targetType: 'thing', targetId: req.params.id,
    details: { /* anything that helps post-incident review */ },
  });
  res.json({ ok: true });
}));
```

Audit log entries are queryable via `/api/audit` and visible in the Audit page UI. They're retained per `AUDIT_RETENTION_DAYS` (default 90).

### i18n

- EN (`public/js/i18n/en.js`) is the source of truth. Every key MUST exist in EN.
- RO (`ro.js`) should mirror EN for the project's primary user base.
- Other 9 languages auto-fall-back to EN via `_fallback: 'en'` — no need to translate them.
- Keys are namespaced: `nav.<page>`, `pages.<feature>.<key>`, `common.<key>`.
- Use placeholders: `'Welcome, {{name}}!'` then `i18n.t('greeting', { name: 'Bogdan' })`.
- **Never concatenate translated strings** — translations need to control word order.

### Error handling

- **Backend**: throw + let the central error handler (`src/server.js`) catch it. Use `asyncHandler(...)` for async routes so promise rejections reach the handler. Operational errors (4xx) get the message returned; server errors (5xx) get a generic "Internal server error" with the real message logged.
- **Frontend**: `try { ... } catch (err) { Toast.error(err.message); }`. Don't swallow errors silently. The 401 path is special — `Api.request` handles it (see v7.3.1 for the desync UX fix).

### Logging

- `const log = require('../utils/logger')('module-name');`
- Levels: `debug`, `info`, `warn`, `error`. Default visible level is `info`.
- Structured: `log.info('Did the thing', { count, durationMs });` (not `log.info('Did the thing: count=' + count)`).
- Don't log on hot paths (every request) — use Prometheus metrics for that.

---

## 5. Tests + lint

```bash
npm test          # Run the full Jest suite (900+ tests, ~7s)
npm test -- --watch        # Re-run on change
npm test -- update-check   # Run a single test file by name match
npm run lint      # ESLint on src/ — must be 0 warnings, 0 errors
```

**Your PR must keep the suite green.** If a flaky test fails, mention it in the PR — don't just rerun.

For new features:
- Write tests for the service layer (pure functions are easy to test).
- Use in-memory SQLite: `process.env.DB_PATH = ':memory:'`.
- Reset state in `beforeEach`: `db.prepare('DELETE FROM your_table').run()`.
- Don't test Express directly — test the service. Route tests are integration tests, do them sparingly.

---

## 6. Versioning + release flow

Docker Dash uses **semver-ish**: bug-fix patches bump the patch (`x.y.Z`), new features bump the minor (`x.Y.0`), breaking changes bump the major.

```bash
# 1. Bump the version in package.json
npm version patch        # or minor, or major
# (This runs scripts/sync-version.js automatically, syncing src/version.js
#  and docker-compose.yml.)

# 2. Add a new section to CHANGELOG.md at the top
# (See existing entries for format — date, title, ## Added/Fixed/Changed.)

# 3. Add an entry to public/js/pages/whatsnew.js _releases array (top)
#    so the in-app What's New page reflects the change.

# 4. Run tests + lint one more time
npm test && npm run lint

# 5. Commit + push + tag
git add -A
git commit -m "feat(<area>): <one-line summary>"
git push origin main
git tag v<X.Y.Z>
git push origin v<X.Y.Z>

# 6. Create the GitHub Release
gh release create v<X.Y.Z> --latest --title "v<X.Y.Z> — <title>" \
  --notes "$(cat <<EOF
## What's new
...
## Tests
931 passing / 60 suites
EOF
)"
```

**Maintainers handle the release flow** for merged PRs — you just bump the version + CHANGELOG and we'll tag/release after merge.

### Commit message style

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Scope optional but appreciated: `feat(updates): ...`.

---

## 7. Pull request template

```markdown
## What this PR does

<one-paragraph summary of the user-visible change>

## Why

<the problem this solves — link to the issue if applicable>

## Files touched

- `src/services/X.js` — new (~80 LOC)
- `src/routes/X.js` — new (~50 LOC)
- `public/js/pages/X.js` — new (~200 LOC)
- ...

## Tests

- N new tests in `src/__tests__/X.test.js`
- Suite still green: NNN passing / NN suites
- Manual test on local dev: <what you clicked + what you saw>

## Screenshots

<if it's a UI change>

## Breaking changes

<none / list>

## Checklist

- [ ] `npm test` green
- [ ] `npm run lint` clean
- [ ] CHANGELOG.md updated
- [ ] What's New entry added
- [ ] i18n keys added in en.js + ro.js
- [ ] No `console.log` left in production code
- [ ] No hardcoded secrets / tokens
- [ ] CSP-compliant (no inline scripts, no eval)
```

---

## 8. What we won't merge

- **Build-step additions** on the frontend (no webpack, no vite, no Tailwind, no React). Vanilla JS is a deliberate choice — it makes this codebase approachable to operators who know JS but not "the modern frontend stack."
- **New dependencies without justification.** Each `npm install <X>` adds attack surface, license complexity, and CVE follow-up work. PRs adding a dep should explain why a 50-line in-house implementation isn't enough.
- **Breaking the standalone default.** Docker Dash MUST run with zero external services (no Redis, no Postgres, no separate frontend). HA mode and observability profile are opt-in additions; nothing should require them.
- **Telemetry without opt-out.** No "phone home", no analytics IDs, no install telemetry. The single outbound call (update-check) is opt-out and disclosed.
- **Insecure defaults.** Default config should be strict. If a feature needs `unsafe-X`, document it in `SECURITY.md` with the tradeoff.

---

## 9. Getting help

- **Discussions** (questions, ideas): https://github.com/bogdanpricop/docker-dash/discussions
- **Issues** (bugs, feature requests): https://github.com/bogdanpricop/docker-dash/issues
- **Live demo of the patterns**: open the running app at `/sample-feature` (admin-only) and the source side-by-side.

We aim to respond to PRs within 1 week. Small PRs get reviewed faster than large ones — split when in doubt.

---

Welcome aboard. Looking forward to your PR. 🐳
