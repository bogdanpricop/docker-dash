# Docker Dash — Known Backlog

**Reviewed:** 2026-09-19. The entries below are historical v8.2-era decisions.
Current provider/market-research work is tracked in [the active plan](docs/planning/remaining-market-research-implementation-plan.md).
See [the September audit](docs/audits/2026-09-19-project-security.md) for current findings.

**Closed in the audit working tree (pending release):** dependency refresh,
self-hosted browser library refresh with reproducibility checks, LDAP login flow,
LDAP credential encryption, exact group authorization, verified outbound TLS,
CSRF boundary fixes, retention digest protection and truthful CI failure reporting.
Dockerode 5 and frontend self-hosting were already present before this audit;
the deferred entries below no longer describe those components' current state.

**Still open:** provider roadmap/canaries, Cloudflare live-test credentials,
untagged registry enumeration/cleanup, and real infrastructure validation.

This is the single source of truth for deferred work. Each item lists WHY it's deferred (not just WHAT), so future contributors don't waste cycles rediscovering the rationale.

---

## P1 — Enterprise readiness

### F16 — `ldapjs` replacement with `ldapts`

**Status (updated 2026-04-22):** ✅ Shipped in v6.13.0. `src/services/ldap.js` rewritten against `ldapts`'s Promise-based API; public interface preserved bit-for-bit so no caller changes needed. `ldapjs` and its 9 deprecated `@ldapjs/*` sub-packages fully removed. 740 tests passing (unchanged — no LDAP tests in repo; change statically verified).

**Remaining follow-up (manual staging tests before next enterprise rollout):**
1. OpenLDAP simple bind + search with `userFilter` containing nested `(&(...)(...))`
2. Active Directory bind with quoted CN in DN (`CN="Last, First",OU=...`) — `strictDN: true` default in ldapts may reject what ldapjs accepted
3. AD `memberOf` group-matching case-insensitive substring match
4. LDAPS with self-signed cert + `tlsSkipVerify: true`
5. LDAPS with valid CA + `tlsSkipVerify: false` (no accidental bypass)
6. UTF-8 in username (e.g. `müller`)
7. Username containing `*` / `(` / `)` / `\` (injection-escape path)
8. Connection timeout on unreachable host (~5s)
9. Empty search result handling

**Enterprise LDAP users:** test on staging before updating production. Confidence is medium (code correct per docs, but unverified against a live server).

### F30 — Distributed rate limiter (Redis-backed) — opt-in HA mode

**Status (updated 2026-05-05):** ✅ Fully shipped across the v6.17 → v7.0 → v7.2 series. HA mode is production-ready.

**Final shape:**
- v6.17.0 — `src/services/cluster.js` HA abstraction + Redis-backed rate limiter (`INCR + PEXPIRE` fixed-window) + `docker-compose --profile ha` + `ioredis` as optionalDependencies + 23 mock tests.
- v6.17.1 — WebSocket pub/sub via Redis (fixed "user on replica A misses events from replica B").
- v6.17.2 — Leader election via `SET NX PX` for all cron jobs + Docker event stream + SSH tunnels + git polling.
- v7.0.0 — Operator runbook ([`docs/features/ha-failover-runbook.md`](docs/features/ha-failover-runbook.md)) + sticky-session LB configs ([`docs/features/ha-lb-configs.md`](docs/features/ha-lb-configs.md)) + staging soak verified (3-replica deploy with lock acquire, graceful leader handover, Redis restart recovery). `/api/cluster/status` + 4 Prometheus gauges.
- v7.1.0 — Bundled Prometheus + Grafana observability stack with HA-aware dashboard panels.
- v7.2.0 — In-app Observability Wizard at System → Observability with detect/integrate/deploy paths.

**Multi-replica HA in production is supported as of v7.0.0.** Documented operator runbook covers the failure modes (leader death, rolling restart, Redis failure, split-brain detection, recovery checklist).

---

## P2 — UX polish

### LE Wizard: WebSocket progress (replace 3s polling)

**Status (updated 2026-04-20):** ✅ Shipped in v6.6.5. Channel `acme:job:<jobId>` broadcasts on each state transition; polling kept as 15s safety net. Service layer stays WS-independent (broadcaster injected at startup).

**Still open:** the pre-existing gap that `acme_jobs.status` never transitions `running → success`. Requires a background Caddy-state watcher. Tracked below.

### LE Wizard: Background watcher for issuance completion

**Status (updated 2026-04-20):** ✅ Shipped in v6.6.6. `src/services/acme-watcher.js` polls every 10s, 60s grace period, 10min hard timeout. 7 unit tests. Publishes via the v6.6.5 WS channel.

### Remediation Wizard: WS progress for live log streaming

**Status (updated 2026-04-20):** ✅ Shipped in v6.6.6. Per-job channel `remediate:job:<id>` broadcasts on every state transition AND every log line. Polling kept as 10s safety net.


### Remediation Wizard: entry points on security.js / stacks.js / cis.js

**Status (updated 2026-04-21):** ✅ Fully shipped. v6.6.3 added CIS + stacks entry points. v6.9.4 closes the `security.js` gap with "Containers using this image" drill-down modal — click the wrench icon on any image scan row → lists running containers using that image → Fix button opens RemediateWizard scoped to container.

### i18n: 25% of keys missing in non-EN locales

**Status (updated 2026-04-21):** ✅ Tooling shipped in v6.11.0. New System → Translations tab integrates Google Translate + DeepL free-tier APIs (500k chars/month each, tracked per-provider/month with hard quota stop) plus a review/export workflow. Keys stay missing until an admin runs auto-translate → reviews → exports the locale file → commits. That's a 10-minute flow per language now instead of "wait for translators."

**What still requires human oversight:** Reviewing machine translations before shipping them. The UI forces per-row Accept/Reject (no bulk accept) precisely so a bad auto-translation doesn't land in production.

---

## P2 — Dependency majors (deferred after 2026-04-20 audit)

**Current state:** npm audit shows 0 vulnerabilities after v6.6.4 bump (nodemailer 7→8). All within-major patches applied (dotenv, eslint, puppeteer, simple-git).

Available major upgrades, deliberately not taken:

- ~~**bcrypt 5 → 6**~~ — ✅ shipped in v6.7.1 (native deps refresh). Rebuilt against Node 24.
- ~~**better-sqlite3 11 → 12**~~ — ✅ shipped in v6.7.1 (native deps refresh). Prepared-statement API stayed backward-compatible.
- ~~**diff 5 → 9**~~ — ✅ shipped in v6.10.0. API for `createPatch` stayed compatible across v5→v9; no code change needed beyond `npm install` + overrides bump. All 10 compose-diff tests green.
- ~~**express 4 → 5**~~ — ✅ shipped in v6.14.0. Actually only needed 2 line changes + dropping an obsolete `path-to-regexp: ^0.1.13` override from `overrides` (added for a v4 CVE that's irrelevant on v5 where the transitive dep is `path-to-regexp@8.4.2`). 740 tests passing unchanged. BACKLOG's 8-12h estimate was too pessimistic — real cost was ~2h because the codebase was already v5-idiomatic. Deep-spec at `plans/deep-spec-express5-migration.md` for details.
- ~~**node-cron 3 → 4**~~ — ✅ shipped in v6.9.2. API for `schedule()` / `validate()` / `.stop()` stayed backward-compatible; no call-site changes.
- **helmet 8 → 9** (if/when released) — tracked separately in security audit cycle.

**Proposed approach:** bundle these into one "major-dep bump" session in v6.8+ with a full regression run, not sprinkle them into feature PRs.

## P3 — Operational

### GHCR push permission for custom Caddy image

**Status (updated 2026-04-22):** ✅ Resolved. GHA workflows `caddy-image.yml` and `egress-filter-image.yml` now successfully build + push to `ghcr.io/<owner>/docker-dash-caddy` and `docker-dash-egress-filter` on every tag push. Workflow permissions are configured correctly.

### LE staging integration test in CI

**Status (updated 2026-04-22):** Code shipped in v6.9.2 — `src/__tests__/acme-cloudflare-live.test.js` hits Cloudflare's `/user/tokens/verify` endpoint when `CLOUDFLARE_TEST_TOKEN` env/secret is set. Intentionally skipped (one of the 4 skipped tests in the suite) when the secret is absent.

**Still pending (user action, not code):** provision `CLOUDFLARE_TEST_TOKEN` as a GitHub Actions secret in Repo Settings → Secrets and variables → Actions. After that, the test runs on every push and will catch:
- Credential-validation drift if Cloudflare deprecates token endpoints
- Token revocation / expiry
- Global API Key vs scoped token format regressions

**Effort:** 5 minutes (paste one token into a GHA secret).

### GHA actions on deprecated Node.js 20

**Status (updated 2026-04-22):** ✅ Shipped in v6.13.1. All 4 workflows (`ci.yml`, `docker-build.yml`, `caddy-image.yml`, `egress-filter-image.yml`) bumped to the first Node-24 major of each action: `actions/checkout@v5`, `actions/setup-node@v5`, `docker/setup-qemu-action@v4`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/metadata-action@v6`, `docker/build-push-action@v6`. Kept `node-version: '20'` for tests (mirrors the production Dockerfile base image); only the actions' own runtime moved to Node 24.

**Pre-deadline:** was 2026-06-02 GitHub-forced. Done with 40+ days of margin.

### F20 — Retroactive `down()` for 44 existing migrations

**Decision:** NOT doing this. Going forward only. All migrations from 043 onwards have `down()`. Retroactively adding them to 001-042 would be ~1 day of mechanical work with zero operational value (those migrations shipped; no one rolls back to 6.1 by deleting migration 041).

### Multi-host SSH exec channel

**Status (updated 2026-04-20):** ✅ Shipped in v6.8.0. `src/services/ssh-tunnel.js` gained `exec / fileExists / readFile / writeFile`; `src/services/remote-fs.js` dispatches local-vs-remote; `remediate.js` + `docker-runner.js` use remote paths transparently for any `hostId > 0`. Remediation Wizard Apply mode now works end-to-end on remote hosts.

---

## P3 — Nice-to-have

- Sandbox-clone "test fix on copy first" mode for Remediation Wizard
- Cross-stack fleet remediation
- Docker Dash's own `docker update` sandbox for risky updates
- Per-image hint database for Remediation Wizard (crowd-sourced or first-party)
- Scheduled remediation rollouts (apply at 02:00)
- Email/Slack notifications on remediation apply/rollback
- Rollback UX improvements (side-by-side "before vs after" beyond 60s window, by keeping extended snapshots)

---

## P2 — AI roadmap (gated on v8.0.0 production signal)

### AI vulnerability triage

**Status (added 2026-05-05):** Deep-spec drafted in v8.0.0 ([`plans/deep-spec-ai-features.md`](plans/deep-spec-ai-features.md)). Deferred until v8.0.0 audit search has accumulated production signal.

**Acceptance gate before implementation:**
- ≥2 weeks of v8.0.0 audit NL search uptime in real installs
- ≥1 redactor catch on real prompt content (proves the privacy gate works in the wild, not only on the test corpus)
- Zero compliance issues raised by operators

**Scope:** Rank Trivy/Grype scan results by real exploitability via EPSS scores + LLM reasoning over the CVE description + the actual call-site reachability. Read-only — no auto-remediation. Surfaces in Security tab with "Likely exploitable" / "Theoretical" / "False positive in our context" labels.

### AI incident triage

**Status (added 2026-05-05):** Same gate as AI vulnerability triage above.

**Scope:** Container restart-loop diagnosis from `inspect` + last 200 log lines + recent stats. Output: ranked hypothesis ("OOMKilled" / "config error" / "dependency unreachable" / "permission denied on volume mount") with the supporting evidence in each case. Read-only — no auto-restart, no auto-rollback.

### Cosign signature cryptographic verification

**Status (added 2026-04-29):** v8.1.0 surfaces signature *presence* via OCI annotations only — actual `cosign verify` is deferred. Needs cosign binary handling, key management UX, and additional UI affordances. Tracked for a future v8.x minor.

---

## P2 — Architecture refactors (frontend done in v8.2.x waves; backend deferred)

### Frontend "aircraft carrier" splits — DONE in v8.2.x further-split

| File | Was | Now | Modules extracted |
|------|-----|-----|-------------------|
| `public/js/pages/system.js` | 6011 | 2618 | system-egress + system-templates + system-backup + system-ssl + system-cis + system-secrets + system-translations |
| `public/js/pages/settings.js` | 2037 | 572 | settings-users + settings-registries + settings-git + settings-workflows + settings-logforwarding + settings-ldap + settings-ai |

All extracts verified via Puppeteer (12+12 methods present, all tabs render).

### Frontend remaining (lower priority — not strictly necessary)

- `public/js/pages/containers.js` — 3240 LOC (already split once in v6.16.0; still big but list+filter are cohesive)
- `public/js/pages/container-detail.js` — 2718 LOC (already lazy-loaded; could split per tab — Files / Logs / Stats)
- `public/js/pages/images.js` — 1595 LOC (could split list / push / browse)
- `public/js/app.js` — 2051 LOC (init + delegated handlers + routing — split would be cosmetic)

### Backend route splits — DONE in v8.2.x wave 6

| File | Was | Now | Sub-routers |
|------|-----|-----|-------------|
| `src/routes/system.js` | 2827 | 1646 | system-backup (17 routes) + system-stacks (9) + system-schedules (7) + system-database (5) |
| `src/routes/misc.js` | 1780 | 1433 | misc-favorites (3) + misc-notifications (6) + misc-api-keys (3) + misc-audit (3) + misc-ai (2) |

External API URLs unchanged. All 1398 tests pass; 10 sub-router endpoints verified live via curl.

### Remaining backend candidates (LOWER priority)

- `src/routes/containers.js` — 2087 LOC, 65 routes. Container CRUD + lifecycle + exec + logs + stats are tightly coupled around `dockerService.containerAction()`; split would be cosmetic.

### How-To content migration to markdown files

**Status (shipped 2026-05-05, partial):** New convention shipped in v8.2.x: `src/db/howto-content/<slug>.md` with YAML front-matter, loaded at startup via `src/services/howto-loader.js`. Existing 84 howtos still live in their original migrations (040, 041, 042, 048, 059) — they continue to work.

**Remaining (not blocking):** Migrate the 84 existing howtos to markdown files piece-by-piece. Each migration is 10 minutes (extract HTML body → wrap in front-matter → drop in `howto-content/`). No regression risk — markdown files OVERWRITE DB rows on next startup.

## P3 — Frontend self-hosting (partial in v8.2.x, full deferred)

### Self-host remaining CDN dependencies

**Status (added 2026-05-05):** Partially shipped in v8.2.x.

**Done:**
- Chart.js 4.4.1 → `public/lib/chart.umd.min.js` (~205 KB). Removes one external CDN dependency. Note: this does NOT eliminate `'unsafe-eval'` from CSP — Chart.js uses `new Function()` internally regardless of where it's served from.

**Deferred:**
- **FontAwesome 6.5.1** (CSS + woff2/woff/ttf font files, ~1.6 MB total). Currently from `cdnjs.cloudflare.com`. Self-host requires copying font files + the CSS that references them via relative paths, plus updating `CSP fontSrc` to drop the cdnjs entry. ~30 min work; defer until needed (e.g., if Edge Tracking Prevention starts blocking the cdn).
- **xterm.js 5 + addon-fit** (~600 KB total). Currently from `cdn.jsdelivr.net`. Same pattern — copy + CSS refs + CSP update.
- **Google Fonts** (if used). Check `public/css/app.css` for any `@import` from `fonts.googleapis.com`.

Triggering condition: if jsDelivr or cdnjs becomes unreliable (Edge Tracking Prevention auto-block, regional outage, deprecation), self-host the rest immediately. Until then, the CSP allowlist scoped to those exact CDN hostnames is acceptable.

## P3 — Dependency major bumps (deferred non-blocking)

### dockerode 4 → 5 migration

**Status (added 2026-05-05):** `npm audit --omit=dev` reports one moderate-severity transitive advisory ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — `uuid <14.0.0` via `dockerode 4.x`). Documented as accepted in [`SECURITY.md` §7](SECURITY.md) — the vulnerable code path (`uuid.v3/v5/v6` with caller-supplied `buf`) is unreachable from how Docker Dash uses dockerode.

**Plan:** Migrate to `dockerode 5.x` in a future release as a clean dependency-bump session, not as a security-driven hotfix. Affects ~40 call sites in `src/services/docker.js`; needs a regression run and possibly minor signature changes.

**Re-trigger:** Re-run `npm audit` quarterly; if the advisory upgrades to high/critical or a new exploit demonstrates reachability through dockerode, treat as urgent.

---

## What's in the current release (v8.2.0)

For context — everything above is beyond what's shipped. Current state highlights (most recent first):

- **v8.2.0** pCloud backup target + weekly stack bundle archive + monthly hash-chain-preserving audit log dump (3 off-site artifacts to free-tier pCloud, AES-256-GCM token storage, quota-aware uploads)
- v8.1.x Registry Hygiene Pack — build provenance panel + retention policies with dry-run + 5-layer safety + remote/virtual repos via Distribution proxy. Plus 3 v8.1.x bug fixes (lazy-load detail, files-tab preview-mode selector, BusyBox file listing)
- v8.0.x AI features (BYOK, off by default) — provider abstraction across Anthropic / OpenAI / Ollama, audit log NL search, privacy-first redactor (validated 100/100), SHA-256 payload hash audit. AI Workload template pack (12 templates: Ollama, RAG stack, vLLM, etc.)
- v7.x HA mode production-ready (Redis-backed leader election + WS pub/sub + sticky-session runbook), bundled Prometheus + Grafana observability with in-app wizard, image registry workflow (push + browse + delete), in-app update notifications, sample plugin + CONTRIBUTING.md, Express 5 migration, CI lint enforcement
- v6.x foundations — LE Wizard, Remediation Wizard, Outbound Network Filter, Per-container Security tab, Translations tooling, NAS auto-detection, Cloud vendor badges, ldapjs → ldapts migration
- **1122 tests passing + 4 skipped across 70 suites**
- **64 auto-migrations**
- **84 built-in How-To guides** (EN + RO; AI category covers Ollama on CPU/GPU + GPU passthrough + RAG stack walkthrough)
- **47 built-in App Templates** (incl. AI Workload Pack of 12)
- **451 API endpoints**

---

## How to propose a new item

1. Is it truly blocked (infrastructure / external decision)? → P2 or P3
2. Can it be done in <1 day by a single dev? → P1 or "just do it" in the next session
3. Does it change the product's positioning (e.g., HA mode)? → Major version milestone

For items that become "just do it": open a GitHub issue with the `ready-to-implement` label.
