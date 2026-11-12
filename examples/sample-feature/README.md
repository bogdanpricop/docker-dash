# Sample Feature — Contributor Demo

A deliberately minimal but complete reference for adding a new feature to Docker Dash. **Live at `/sample-feature`** in the running app (admin-only sidebar entry, hidden from production via `DD_SHOW_SAMPLE_PLUGIN=false`).

If you're new here, read this README and then walk through the actual files in the order listed below. The goal is for you to be able to add your own feature in **under an hour** by copying this pattern.

> 📖 **For the full contributor onboarding (setup, conventions, PR flow), see [`docs/CONTRIBUTING.md`](../../docs/CONTRIBUTING.md).**

---

## What it does

A counter that:
- Persists to the SQLite `settings` table.
- Auto-increments once a minute via a cron job (leader-only in HA).
- Updates every connected browser/tab in real time via WebSocket.
- Can be manually incremented (operator + admin) or reset (admin only, audited).

The page itself shows the live counter, the action buttons, and **a "How this works" panel with one collapsible card per layer** — each card linking to the actual source file on GitHub.

This is intentionally trivial as a domain — it lets you focus on the **scaffolding pattern** without getting distracted by business logic.

---

## File map (the 7 layers + glue)

```
src/services/sample-feature.js          # Layer 1 — Service (DB + WS broadcast)
src/routes/sample-feature.js            # Layer 2 — REST routes (RBAC + audit)
public/js/pages/sample-feature.js       # Layer 3 — Frontend page (WS subscribe)
src/__tests__/sample-feature.test.js    # Layer 7 — Unit tests

src/jobs/index.js                       # GLUE — cron entry calls service.tick()
src/server.js                           # GLUE — mount route + wire WS broadcaster
public/index.html                       # GLUE — sidebar nav-item + <script> tag
public/js/app.js                        # GLUE — page in App._pages registry
public/js/i18n/en.js + ro.js            # GLUE — translation keys
```

That's **9 files** for a complete vertical slice. Most features need fewer (no cron, no WS, etc.).

---

## Step-by-step: add your own feature

Replace `sample-feature` with your feature name in this checklist (use `kebab-case` in URLs, `camelCase` in JS, `snake_case` in DB keys/cron job names).

### 1. Service (`src/services/<your-feature>.js`)
- One file per feature.
- Pure functions where possible.
- No HTTP, no Express. Just business logic + DB I/O.
- If you broadcast WS events: export `setWsBroadcaster(fn)` and call it from `src/server.js` startup.

### 2. Route (`src/routes/<your-feature>.js`)
- Standard Express router.
- `router.use(requireAuth)` at the top.
- `requireRole('admin')` or `requireRole('admin', 'operator')` per route as needed.
- Wrap async handlers in `asyncHandler(...)` so errors land in the central handler.
- For destructive actions: call `auditService.log({ userId, username, action, targetType, targetId, details })`.

### 3. Mount the route in `src/server.js`
```js
app.use('/api/<your-feature>', apiLimiter, require('./routes/<your-feature>'));
```
Place it before `app.use('/api', ...)` (the catch-all `misc` router).

### 4. Wire the WS broadcaster in `src/server.js` (only if you broadcast)
Inside `start()`, after `wsServer.attach(server)`:
```js
const myFeature = require('./services/<your-feature>');
myFeature.setWsBroadcaster(
  (type, data, channel) => wsServer.broadcast(type, data, channel)
);
```

### 5. Cron job in `src/jobs/index.js` (only if you need a periodic tick)
```js
jobs.push(cron.schedule('* * * * *', _m('<your-feature>-tick', () => {
  require('../services/<your-feature>').tick();
})));
```
The `_m(...)` wrapper adds Prometheus metrics + leader-only gating in HA mode.

### 6. Frontend page (`public/js/pages/<your-feature>.js`)
- Module assigned to `window.<YourFeature>Page`.
- Implements `async render(container)` and `destroy()` (to clean up timers + WS subscriptions).
- Use `Api.get/post(...)`, `Modal.open(...)`, `Toast.success/error(...)`, `i18n.t(...)`, `Utils.escapeHtml(...)`.
- WS subscribe: `WS.subscribe('your-feature:channel')` + `WS.on('your-feature:type', handler)`.

### 7. Register the page in `public/js/app.js`
```js
'<your-feature>': () => YourFeaturePage,
```
in the `App._pages` registry.

### 8. Add the script tag in `public/index.html`
```html
<script src="/js/pages/<your-feature>.js?v=__BUILD__"></script>
```
Place it next to the other page scripts.

`__BUILD__` is the cache-busting token, computed automatically from the
served files' contents (`scripts/build-id.js`). Use it for asset URLs.
`__VERSION__` is the release version — use it only for user-visible version
strings.

### 9. Add a sidebar entry in `public/index.html`
```html
<a href="#/<your-feature>" class="nav-item" data-page="<your-feature>">
  <i class="fas fa-<icon>"></i><span>Your Feature</span>
</a>
```
Add `class="nav-item admin-only"` if it should be admin-only.

### 10. i18n keys in `public/js/i18n/en.js` and `ro.js`
- Sidebar label under `nav: { '<your-feature>': '...' }`.
- Page-specific keys under `pages: { yourFeature: { ... } }`.
- EN is the source of truth; RO must mirror its structure (other languages fall back to EN).

### 11. Unit tests in `src/__tests__/<your-feature>.test.js`
- Copy [`sample-feature.test.js`](../../src/__tests__/sample-feature.test.js) as a starting point.
- Use in-memory SQLite (`process.env.DB_PATH = ':memory:'`) + `db.prepare('DELETE FROM <table>').run()` in `beforeEach` for isolation.
- Run `npm test` — all 900+ tests should still pass.

### 12. Bump the version + update CHANGELOG.md + What's New
- `package.json` → `npm run version` syncs `src/version.js` + `docker-compose.yml`.
- Add a `## [X.Y.Z] - YYYY-MM-DD — <one-line title>` section to [`CHANGELOG.md`](../../CHANGELOG.md).
- Add an entry to `_releases` in [`public/js/pages/whatsnew.js`](../../public/js/pages/whatsnew.js).

---

## Visibility flag

The sample feature is gated by `DD_SHOW_SAMPLE_PLUGIN`:
- **Default (unset / `true`)**: route mounted, sidebar entry visible to admins, cron runs.
- **`false`**: route returns 404, sidebar hidden via `admin-only` class + non-existence, cron skips.

Production deployments that don't want this in the sidebar should set `DD_SHOW_SAMPLE_PLUGIN=false` in their `.env`.

---

## Why these patterns?

Brief rationale for each:

- **Pure-function services** make unit testing trivial (no Express mocking, no DB mocking — use `:memory:`).
- **`requireAuth` + `requireRole` per route** instead of a global gate makes the security posture readable from a single grep.
- **Audit log on destructive actions** is non-negotiable — every operator action that mutates state should be queryable later.
- **Cron jobs leader-gated** prevents N× duplication in HA mode (4 replicas would otherwise hit the daily backup 4 times — corrupting it).
- **WebSocket pub/sub via Redis in HA** means a click on replica A propagates to subscribers on replica B in milliseconds.
- **i18n EN as source-of-truth + auto-fallback** means contributors don't need to translate to all 11 languages — just EN. RO is a courtesy because it's the project's primary user base.
- **No build step on the frontend** — vanilla JS modules loaded by `<script>` tags, hot-reloadable on every save. No webpack/vite/esbuild pain.

---

## Need help?

- Read [`docs/CONTRIBUTING.md`](../../docs/CONTRIBUTING.md) for setup, conventions, and PR flow.
- Open a discussion: https://github.com/bogdanpricop/docker-dash/discussions
- Open an issue: https://github.com/bogdanpricop/docker-dash/issues
