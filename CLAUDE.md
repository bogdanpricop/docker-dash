# CLAUDE.md — Docker Dash project conventions

This file is loaded into every Claude Code session in this repo. Keep it tight; durable conventions only, not transient state.

## What this project is

Self-hosted Docker management dashboard. Single binary, no build step, vanilla JS frontend, SQLite embedded. Two deployment modes: **standalone** (default) and **HA** (opt-in `DD_MODE=ha`, Redis-backed leader election).

Current version source of truth: [`src/version.js`](src/version.js). Bump via `npm version X.Y.Z` (runs `scripts/sync-version.js` to propagate to `docker-compose.yml` + `package.json`).

## Architecture invariants — DO NOT violate

1. **No build step.** Frontend is plain JS loaded via `<script>` tags. Don't add webpack/vite/esbuild. CSS is one file `public/css/app.css`.
2. **No frontend framework.** No React/Vue/Svelte. Plain DOM manipulation via objects with `render(container)` methods.
3. **CommonJS backend.** `require()` / `module.exports`. Don't introduce ESM `import`.
4. **SQLite embedded.** No external DB. Migrations auto-apply at startup from `src/db/migrations/NNN_*.js`. Numbering is monotonic — never reuse a number.
5. **Audit trail mandatory** for any state-changing action: `auditService.log({ userId, username, action, targetType, targetId, details, ip })`.
6. **RBAC mandatory** on routes that touch state: `requireAuth` + `requireRole('admin')` + `writeable` middleware chain.
7. **Output escaping.** Frontend uses `Utils.escapeHtml(value)` on every interpolated user-facing string. Inline `onclick=` in template strings is forbidden — use `addEventListener` after rendering.
8. **No secrets in source.** AES-256-GCM via `src/utils/crypto.js` for credentials at rest. `ENCRYPTION_KEY` env var required at startup.

## Every page carries a "?" help button — NON-NEGOTIABLE

Every routed page in `App._pages` has a `?` button in its header opening a modal
that explains what the page does and what each action means. This was a standing
requirement that went unenforced for a long time: 50 of 59 pages shipped without
one before v8.94.1.

**How to satisfy it now:** add an entry to `public/js/help-content.js` keyed by
the route name. `PageHelp` (`public/js/components/page-help.js`) injects the
button after render, so **no per-page code is needed**. Nine older pages
hand-rolled their own `_showHelp()`; the injector backs off when it finds an
existing `.prune-help-btn`, so those keep working.

Content rules:
- Say what the page actually does, including what it *refuses* to do.
- English is the fallback; add `ro` too (no diacritics, matching `ro.js`).
- Long-form prose lives in `help-content.js`, not `i18n/*.js` — same reasoning
  that keeps how-to guides in markdown.

**Enforced:** `npm run check:page-help` exits non-zero if any routed page has
neither an entry nor its own button. Run it when adding a page.

## Deep-spec discipline (the project's own workflow)

Strategic features ship in order: deep-spec → feature-spec → code → tests → release. Plans live in `plans/` (gitignored, local-only). The discipline is non-negotiable for major features (everything that ships in a `.0` minor): write the strategic intent before code, get acceptance, then execute.

Anti-features are documented WITH RATIONALE in each deep-spec's "OUT" section. If the user later asks "why didn't we ship X?", the deep-spec answers in writing.

Examples already in `plans/` (gitignored, but referenced by CHANGELOG):
- `deep-spec-ai-features.md` (v8.0.0)
- `deep-spec-registry-hygiene-pack.md` (v8.1.0)
- `deep-spec-v8.2.0-pcloud-and-archives.md` (v8.2.0)

## Operational conventions

- **Port:** `8101` (HTTP) — referenced in `.env.example`, `docker-compose.yml`, README. Do NOT use `3456` (legacy from v5.x docs that may still appear).
- **Default admin:** `admin` / `admin` (forced password change on first login). `c#12` is the local dev override.
- **Test runner:** `npm test` runs Jest with `--forceExit`. CI lint is enforced as of v7.7.0 — fails on any warning.
- **Deploy targets:** local (Docker Desktop), LAN (`192.168.13.20`, user `localadmin-a`), public VPS (`89.37.212.66`, user `root`). Both remotes use SSH key auth (no password). See [`memory/server_deploy.md`](C:/Users/bogdan.pricop/.claude/projects/c--Users-bogdan-pricop-OneDrive---All4Labels-Documents-TypeScript-docker-dash/memory/server_deploy.md) for the full sequence.
- **Build target:** ALWAYS pass `--target production` to `docker build`. Buildkit otherwise tries the `development` stage in parallel and fails on `npm install` if dev-deps registry is unreachable.

## File-size guidelines (post-v8.2.0 audit)

- Frontend pages > 1500 lines should split via the `containers.js` + `container-detail.js` lazy-merge pattern (see v6.16.0 architecture). For non-lazy splits (pure organisational), see the v8.2.x `system-egress.js` extract.
- Backend route files > 2000 lines should split by sub-resource.
- Migrations should NOT contain bulk content (howto guides, template seeds). Use `src/db/howto-content/<slug>.md` (with optional `.ro.md` companion) and the import-at-startup loader (`src/services/howto-loader.js`) instead.

## How-To content precedence (v8.2.x)

When the server starts, this is the order of operations on `howto_guides`:

1. Migrations 040, 041, 042, 048, 050, 052, 053, 055, 058-062 INSERT initial built-in rows (historical seed).
2. `howto-loader.js` walks `src/db/howto-content/`, parses each `.md` file's YAML front-matter, UPSERTS into `howto_guides`. Markdown content **overrides** the migration content for any matching slug.

**Practical rule:** to add or edit a how-to, drop a markdown file. Don't touch migrations. The 132 markdown files committed in v8.2.x are the canonical source for the 66 howtos that have body content; migrations remain only as the schema-of-record + safety net for fresh installs that have no markdown directory mounted (which shouldn't happen with the production image, but the redundancy is cheap).

To migrate a how-to from migration to markdown: drop `src/db/howto-content/<slug>.md` with the same `slug` as the migration's INSERT. Loader UPSERTs, migration's content stops being the source of truth.

## Commit conventions

`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` prefix + scope. Sign-off with the `Co-Authored-By: Claude` trailer when the session is AI-assisted. Examples in recent `git log`.

## Release workflow

1. Bump version: `npm version X.Y.Z` (auto-syncs `src/version.js`, `docker-compose.yml`, stages files).
2. Update `CHANGELOG.md` (most-recent at top).
3. Update `public/js/pages/whatsnew.js` `_releases` array (most-recent at top).
4. Commit + tag: `git tag vX.Y.Z && git push origin main --tags`.
5. GitHub release with `gh release create vX.Y.Z --latest` (the `--latest` flag matters — without it, GitHub UI shows older releases as "Latest").
6. Deploy to all 3 targets (local + LAN + VPS) — `--target production` on remotes.

## Known cross-session quirks

- Read tool may be blocked if `claude-mem` plugin hook fails. If you see PreToolUse hook errors, fall back to `Bash` with `cat`/`sed` until the user fixes the hook.
- Permission `setup_completed` flag in DB defaults to `false`. Fresh deploys show "Initial Security Setup" modal. To skip for screenshot scripts: `UPDATE settings SET value='true' WHERE key='setup_completed'; UPDATE users SET must_change_password=0 WHERE username='admin';`.

## Where to look first

| Need | Open |
|------|------|
| What's planned next | `plans/` (gitignored) |
| What shipped recently | `CHANGELOG.md` first 200 lines |
| Architecture trade-offs | `SECURITY.md` "Known Security Tradeoffs" + `docs/features/*.md` |
| User-facing copy + i18n keys | `public/js/i18n/en.js` (canonical) + `public/js/i18n/<lang>.js` |
| RBAC matrix | `src/middleware/auth.js` — `requireAuth`, `requireRole`, `writeable` |
| Audit actions enum | `src/services/ai/features/audit-actions-list.js` (174 entries as of v8.2.0) |
