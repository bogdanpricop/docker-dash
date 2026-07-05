# Gap Closure Plan — Docker Dash vs Dockge

**Source doc:** [vs-dockge.md](vs-dockge.md)
**Baseline version:** v8.9.6-alpha.1 (2026-07-05)
**Owner:** (TBD)
**Status:** Draft
**Last reviewed:** 2026-07-05

## Executive summary

Dockge and Docker Dash are different-shape tools: Dockge is a minimal, opinionated Compose-stack manager; Docker Dash is a broad-scope Docker dashboard. Most of what "Dockge does better" per the comparison doc — focused scope, UX minimalism, small image, Svelte reactivity, Uptime Kuma sibling feel — reflects deliberate design differences that Docker Dash will NOT try to erase. The real, closable gaps are narrower and concentrated in the Stacks flow itself: (a) the compose YAML editor is a plain `<textarea>` instead of a syntax-highlighted editor, (b) compose `up`/`down`/`pull` is invoked via blocking `execFileSync` with no live output stream, and (c) there is no stack-level aggregated log view. Everything else is either already shipped (WebSocket log streaming per container, exec terminal, git-stacks with auto-deploy + webhooks, compose validation, run→compose converter) or a `won't-do` by design. Estimated closure: 1 P0 (M) + 2 P1 (S+M) + 2 P2 (S) + 3 P3 (XS-L), ~3-4 weeks of focused work to reach "Compose parity."

## Progress dashboard

| Priority | Total | Open | In progress | Closed | Won't-do |
|---|---:|---:|---:|---:|---:|
| P0 | 1 | 1 | 0 | 0 | 0 |
| P1 | 2 | 2 | 0 | 0 | 0 |
| P2 | 2 | 2 | 0 | 0 | 0 |
| P3 | 3 | 3 | 0 | 0 | 0 |
| Won't-do | 4 | 0 | 0 | 0 | 4 |
| **Total** | **12** | **8** | **0** | **0** | **4** |

## Gap inventory

| ID | Gap | Priority | Effort | Status |
|---|---|---|---|---|
| G01 | Compose `up`/`down`/`pull`/`restart` is blocking `execFileSync` with no live output | P0 | M | `[ ]` |
| G02 | Compose YAML editor is plain `<textarea>`, no syntax highlighting or lint | P1 | M | `[ ]` |
| G03 | No stack-level combined log stream (all services, one view, live) | P1 | S | `[ ]` |
| G04 | No filesystem-first stacks discovery (point at `/opt/stacks`, auto-import) | P2 | S | `[ ]` |
| G05 | No "simple mode" / Compose-first landing to lower learning curve | P2 | XS | `[ ]` |
| G06 | `docker run` command → compose converter not exposed as paste-command UI | P3 | S | `[x]` v8.9.7-alpha.1 (backend done, UI in ship 3) |
| G07 | No interactive form-based service editor (edit ports/env/mounts via forms, not YAML) | P3 | L | `[ ]` |
| G08 | No sibling-app deep link (Uptime Kuma monitor auto-registration) | P3 | XS | `[ ]` |
| W01 | Match Dockge image size (~30-50 MB) | — | — | `[-]` |
| W02 | Rewrite frontend in Svelte / add build step | — | — | `[-]` |
| W03 | Reduce scope to Compose-only | — | — | `[-]` |
| W04 | Drop bundled scanners (Trivy/Grype/Scout) for footprint | — | — | `[-]` |

## Gaps (detailed)

### G01 — Compose actions block the event loop and hide progress

- **Status:** `[ ]` Open
- **Priority:** P0
- **Effort:** M (1 week)
- **Dependencies:** none
- **Impact if unclosed:** [`src/routes/system-stacks.js:41,189,293,361`](../../src/routes/system-stacks.js) calls `execFileSync('docker', ['compose', ...])` with a 120 s timeout. This freezes the Node event loop for the whole duration on any concurrent request, and returns nothing to the client until the compose command finishes. Users see a spinning button for 30-120 s on `up`/`pull` with no signal that anything is happening; a slow pull looks identical to a hung server. Dockge streams every line of `docker compose` output live via Socket.IO — one of its main UX wins. This is our largest concrete Stacks-flow gap.

**Closure approach**

Replace `execFileSync` with `spawn` in `src/routes/system-stacks.js` for the four action paths (`up`, `down`, `restart`, `pull`) + the create/deploy paths that also currently call `execFileSync('docker', ['compose', 'up', '-d'])`. Stream stdout/stderr via one of two transports, in this order of preference:

1. **SSE** — reuse the pattern already shipped in [`src/routes/images.js:713`](../../src/routes/images.js) (image pull SSE) and [`src/routes/registries.js:151`](../../src/routes/registries.js) (registry push SSE). Route: `POST /api/compose/:stack/:action/stream` returns `text/event-stream`; the existing non-streaming path stays as a fallback.
2. **WebSocket** — new topics `compose:action:start` / `compose:action:data` / `compose:action:end` mirroring the existing `logs:*` pattern in [`src/ws/index.js:238`](../../src/ws/index.js).

Frontend: update `_loadComposeDetail` and the card-action button handler in [`public/js/pages/stacks.js:126-146`](../../public/js/pages/stacks.js) to open the SSE stream (or WS subscription), append lines to a live output panel inside a modal or drawer, and show a progress spinner that flips to a green check on `end`. Follow the pattern in existing SSE consumers.

Also add a per-action audit entry that records the exit code and truncated output tail (already done for the sync path — preserve it).

**Acceptance criteria**
- [ ] `execFileSync('docker', ['compose', ...])` removed from all six occurrences in `src/routes/system-stacks.js`
- [ ] `POST /api/compose/:stack/:action` supports both sync (legacy) and streaming (new `?stream=1` or new `/stream` route) modes
- [ ] Frontend action buttons open a live-output panel that streams `docker compose up` output line-by-line
- [ ] Concurrent compose actions on two different stacks work in parallel without blocking each other
- [ ] Audit log still records `compose_up` / `compose_down` etc. with truncated output
- [ ] Existing unit tests in `src/__tests__/system-stacks.test.js` (or equivalent) still pass; new streaming test added

**Notes**

Consider a per-user rate limit (max 3 concurrent stream sessions) to avoid resource exhaustion on shared installs. The 16 MB response cap used by [Nomad](../../src/services/nomad.js) and [Kubernetes](../../src/services/kubernetes.js) clients is a good reference; compose output is unbounded so cap total bytes streamed at 5 MB and truncate with a warning line.

---

### G02 — Compose YAML editor is a plain textarea

- **Status:** `[ ]` Open
- **Priority:** P1
- **Effort:** M (1 week)
- **Dependencies:** none (but blocked by CLAUDE.md invariant #1 "no build step" — closure must use CDN-loaded prebuilt bundle, or vendored copy under `public/vendor/`)
- **Impact if unclosed:** In [`public/js/pages/stacks.js:380`](../../public/js/pages/stacks.js) the create-stack YAML input is a `<textarea>`; the config-tab view is a read-only `<pre>` at line 290. Compare to Dockge's Monaco-based editor with YAML syntax highlighting, bracket matching, and (in newer versions) `docker-compose.yml` schema validation. Users editing anything non-trivial go copy the YAML into VSCode, edit, paste back — a bad experience that pushes Compose-first users toward Dockge.

**Closure approach**

Vendor CodeMirror 6 (~200 KB gzipped, single JS + CSS file, no build step) under `public/vendor/codemirror/`. Ship a `public/js/utils/yaml-editor.js` wrapper exposing `YamlEditor.mount(el, { value, onChange, readOnly })` returning `{ getValue, setValue, destroy }`. Wire it into three places:

1. Create-stack modal (`_createStackDialog` in `stacks.js:368`)
2. Compose-config tab (currently `<pre>` in `stacks.js:290`) — replace with editor + Save button that calls existing `PUT /api/stacks/:name/config`
3. Git-stack detail page config viewer (in `public/js/pages/git-stacks.js` if present)

Add client-side YAML parse validation via the already-installed `yaml` package's browser build (or `js-yaml` via CDN) — highlight the offending line before the user clicks Save. The server-side compose-config validation at [`src/routes/system-stacks.js:179`](../../src/routes/system-stacks.js) stays as the source of truth.

**Acceptance criteria**
- [ ] CodeMirror 6 vendored (no CDN — offline install must work) under `public/vendor/codemirror/`
- [ ] `YamlEditor.mount()` utility exists and is documented in a JSDoc header
- [ ] Create-stack modal uses the editor
- [ ] Compose-config tab uses the editor with a Save button
- [ ] Client-side YAML syntax errors surface inline before Save
- [ ] Editor works in light and dark themes (respects `--surface`, `--text`)
- [ ] Bundle size delta stays under 300 KB gzipped

**Notes**

CLAUDE.md invariant #1 forbids a build step, not third-party JS. Vendoring a prebuilt CodeMirror bundle is compliant. Monaco is off the table — it's 2 MB+ and would require asset chunks Docker Dash doesn't serve. If CodeMirror 6 turns out too heavy, ACE editor is a smaller alternative.

---

### G03 — No stack-level combined log stream

- **Status:** `[ ]` Open
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Docker Dash has a per-container live log stream (WebSocket topic `logs:subscribe` in [`public/js/pages/container-detail.js:1545`](../../public/js/pages/container-detail.js) → [`src/ws/index.js:238`](../../src/ws/index.js)) and a Log Explorer at [`public/js/pages/logs.js`](../../public/js/pages/logs.js) that aggregates across containers but polls. Neither is exposed on the stack-detail page. Dockge's stack view shows `docker compose logs -f` output — one combined, interleaved, live tail of every service in the stack. That's the workflow "I just brought this stack up, is it healthy?" — currently our users have to click through each service one by one.

**Closure approach**

Add a `Logs` tab to the compose stack detail view in `public/js/pages/stacks.js` (alongside existing `Services` and `Config` tabs at line 212). On tab entry, fan-out `logs:subscribe` to every container in the stack, tag each line with the container name in a colored gutter (color-hash the name, like `docker compose logs` does), and interleave into a single scrollback with a Follow toggle. Reuse the existing WS log plumbing — no new backend route needed; just a client-side aggregator.

**Acceptance criteria**
- [ ] New "Logs" tab in the compose-stack detail page
- [ ] Follow toggle live-scrolls new lines
- [ ] Each line prefixed with `[service-name]` in a per-service color
- [ ] Pause / Resume / Clear / Download buttons work
- [ ] Unsubscribes correctly on tab switch and page navigation (no dangling WS handlers)
- [ ] Works when the stack has 1-10 services; degrades gracefully above 20

**Notes**

Git-stack detail page should get the same treatment. Consider adding to Nomad/Kubernetes stack views later as follow-up (not part of this gap).

---

### G04 — No filesystem-first stacks discovery

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** [`src/routes/system-stacks.js:203`](../../src/routes/system-stacks.js) `GET /stacks` builds the stack list from **running** containers' `com.docker.compose.project` labels. If a stack is `down`, it disappears from the UI entirely — the compose file on disk is invisible. Dockge's mental model is inverse: point at a stacks directory (default `/opt/stacks` in Dockge, configurable), scan for `docker-compose.yml` files, list every stack whether up or down. This is why Dockge users can bring a stopped stack back up with one click.

**Closure approach**

New config `DD_STACKS_DIR` env var (default `/opt/stacks`, comma-separated for multiple roots). New service `src/services/stacks-fs.js` that walks the roots (depth 2), finds every `docker-compose.yml` / `compose.yml`, parses the top-level `services:` key, and returns `{ name, path, servicesCount, status: 'unknown' }`. Merge into `GET /stacks` result — running-container stacks take precedence for status; disk-only stacks show `stopped` badge with an `Up` button. Add a "Import from disk" toggle on the Stacks page. Symlink-follow off by default, path canonicalization to keep users inside the configured roots.

**Acceptance criteria**
- [ ] `DD_STACKS_DIR` documented in `.env.example`
- [ ] `src/services/stacks-fs.js` unit-tested (path traversal guard, symlink handling)
- [ ] Stopped stacks appear in the Stacks list with a distinct "stopped" badge
- [ ] Bringing a stopped stack up works via the same `POST /compose/:stack/up` route
- [ ] Path outside `DD_STACKS_DIR` roots rejected with 400

**Notes**

Coordinate with Git Stacks — a git-managed stack cloned to a subdirectory of `DD_STACKS_DIR` should not be double-counted. Match on `working_dir` label of a running container and on git-stack `local_path` in the DB.

---

### G05 — No "Compose-first" landing / simple mode

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** XS (< 1 day)
- **Dependencies:** none
- **Impact if unclosed:** New Docker Dash users hit a Dashboard that surfaces 20+ modules (Registry, CIS, Security, Backup, Observability wizard, ...). A user coming from Dockge expecting "compose editor + up/down" gets sensory overload. Dockge wins on onboarding time because its scope is smaller — we can't shrink the scope, but we can make Stacks the visually dominant first-run action.

**Closure approach**

On first login (detect via `settings.first_login_at` — add if missing), pin a card at the top of the Dashboard: "Manage your stacks →" with a subtitle "Compose-first? Start here." Link to `#/stacks`. Second: promote **Stacks** to the top of the sidebar (currently under `Containers` — see [`public/js/app.js`](../../public/js/app.js) sidebar order). Third: add a `?mode=simple` URL flag persisted to a cookie that collapses non-essential sidebar groups (Security, Registry, Observability) into a single "More" accordion.

**Acceptance criteria**
- [ ] Sidebar order updated: Dashboard, Stacks, Containers, Images, ... (Stacks moves to #2)
- [ ] First-login banner card on Dashboard linking to Stacks (dismissible, persists in `settings`)
- [ ] `?mode=simple` collapses side sections; user can toggle back via a `Show all` link

**Notes**

Do not remove features — this is layout only. Existing power users must be able to keep the full sidebar.

---

### G06 — `docker run` command → compose converter not exposed

- **Status:** `[ ]` Open
- **Priority:** P3
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Docker Dash has [`_generateComposeFromInspect`](../../src/routes/system-stacks.js) (line 56) and [`generateCompose`](../../src/routes/containers.js) (line 962) that turn an already-running container into compose YAML. What's missing is the Dockge-style "paste your `docker run` command, get a compose file back" workflow — useful for users adopting a docs recipe. This is a paste-command UI, not a container→compose converter.

**Closure approach**

Server: add `POST /api/compose/convert` that accepts `{ dockerRunCommand: '...' }`, parses the flags (image, --name, -p, -v, -e, --restart, --network, --user, -w, --entrypoint, cmd args), and returns generated YAML. Reuse the tokenizer style from existing helpers. Frontend: add a "Convert `docker run`" button next to "Create Stack" that opens a modal with a textarea for the command and a preview of the resulting YAML — user can edit and click "Create Stack."

**Acceptance criteria**
- [ ] `POST /api/compose/convert` handles all common `docker run` flags
- [ ] Malformed commands return a 400 with a specific parse error message
- [ ] Convert modal accessible from the Stacks page toolbar
- [ ] Generated YAML editable before create
- [ ] Unit tests cover: `-p 8080:80`, `-v /host:/ct`, `-e FOO=bar`, `--restart unless-stopped`, `--network mynet`, quoted args

**Notes**

Existing `_generateComposeFromInspect` covers a different use case (existing container → compose). Do not conflate — keep both entry points.

---

### G07 — No interactive form-based service editor

- **Status:** `[ ]` Open
- **Priority:** P3
- **Effort:** L (2-3 weeks)
- **Dependencies:** G02 (YAML editor) should ship first
- **Impact if unclosed:** Users editing a service's environment variables, port mappings, or volume mounts have to hand-edit YAML. Newer Dockge versions offer a form-based service editor for the common fields (Portainer does too). This is a UX-luxury feature, not a blocker.

**Closure approach**

New component `public/js/components/compose-service-form.js` — takes a parsed service block, renders form controls for `image`, `restart`, `ports[]`, `environment[]`, `volumes[]`, `depends_on[]`, `networks[]`. Round-trips through the `yaml` npm package (already a dependency) to preserve comments and key order as much as possible. Two-way binding: form edits update the YAML view via G02's editor, and vice versa. Add a "Form / YAML" toggle on the compose-config tab.

**Acceptance criteria**
- [ ] Form-based edit covers image, restart, ports, environment, volumes, depends_on
- [ ] Toggle between YAML and Form preserves edits
- [ ] Round-trip through `yaml` package preserves comments
- [ ] Fields NOT in the form (build:, healthcheck:, deploy:, etc.) show a warning "Edit these in YAML view"
- [ ] Save writes back through existing `PUT /api/stacks/:name/config`

**Notes**

This is genuinely nice but far from table-stakes. Suggest deferring until after v9.0.0. Consider marking the "Form" tab as `(preview)` in the UI so users know it's not the source of truth.

---

### G08 — No Uptime Kuma sibling-app auto-registration

- **Status:** `[ ]` Open
- **Priority:** P3
- **Effort:** XS (< 1 day)
- **Dependencies:** none
- **Impact if unclosed:** Comparison doc calls out "integrated with the louislam ecosystem — Uptime Kuma sibling feel." Dockge users often run Uptime Kuma next to Dockge. We can't replicate the ecosystem branding, but we can add: (a) auto-detection when an Uptime Kuma container is on the same host, (b) a one-click "Add monitor" that pushes the current stack's public endpoint to a configured Uptime Kuma instance via its API.

**Closure approach**

Extend the existing Watchtower detection pattern at [`src/routes/misc.js:845`](../../src/routes/misc.js): add `GET /api/uptime-kuma` that finds a container with image `louislam/uptime-kuma`. If detected, surface an "Uptime Kuma" chip on the stack card + a "Register monitor" button that uses Kuma's `/api/monitors` (via a stored API key in settings) to create a monitor for each service's public port. Add a `settings-integrations.js` panel to hold the API key.

**Acceptance criteria**
- [ ] Uptime Kuma detected on the current host — shows chip in Stacks page
- [ ] "Register monitor" button creates a monitor via Uptime Kuma API
- [ ] Settings page holds the encrypted API key (use `src/utils/crypto.js`)
- [ ] Audit log records `uptime_kuma_monitor_created`

**Notes**

Do not tie this exclusively to Uptime Kuma. Frame as "Monitoring integrations" — Uptime Kuma is the first; Statping / Gatus / Kener could follow. Keeps us honest about scope.

---

## Won't-do (explicitly out of scope)

### W01 — Match Dockge image size (~30-50 MB)

Docker Dash's image is ~180 MB because it bundles Trivy, Grype, and Docker Scout binaries so vulnerability scanning works out of the box without operator setup. This is a headline feature. Stripping the scanners to save 130 MB would break the value proposition. Rejected.

### W02 — Rewrite frontend in Svelte / add build step

Violates two of Docker Dash's non-negotiable architecture invariants (CLAUDE.md: "No build step" + "No frontend framework"). The vanilla-JS-served-as-is design is a shipping/audit/security choice: no supply-chain risk from bundler plugins, no reproducibility question, single-binary deploy. Rejected.

### W03 — Reduce scope to Compose-only

Docker Dash is deliberately broader than Dockge — multi-host, HA, security, backup, observability, alerts. Narrowing the scope to match Dockge would delete features that are the reason existing users chose Docker Dash. What we CAN do is make Stacks feel first-class to users who only want Stacks (see G05). Rejected as stated.

### W04 — Drop bundled scanners for footprint

Same reason as W01 but explicit: Trivy + Grype + Scout are the security-scanning backbone; making them "install separately" would push Docker Dash into the same category as bare-metal Portainer and delete the differentiator. Rejected.

## Suggested execution order

1. **G01** (P0, M) — unblocks live compose feedback; largest UX pain
2. **G03** (P1, S) — stack-level log stream; fast win once WS log plumbing is understood
3. **G02** (P1, M) — YAML editor; unblocks G07 later
4. **G05** (P2, XS) — Compose-first landing; XS, do it while G01 is in review
5. **G04** (P2, S) — filesystem stacks discovery
6. **G06** (P3, S) — `docker run` converter
7. **G08** (P3, XS) — Uptime Kuma auto-detect
8. **G07** (P3, L) — form-based service editor — defer past v9.0.0

Cumulative effort assuming one person: **~4 weeks** to G06, +**2-3 weeks** for G07 if pursued.

## Cross-references

- [Docker Dash vs Dockge comparison](vs-dockge.md)
- [CHANGELOG](../../CHANGELOG.md)
- [`src/routes/system-stacks.js`](../../src/routes/system-stacks.js) — compose routes (G01, G02, G04)
- [`public/js/pages/stacks.js`](../../public/js/pages/stacks.js) — Stacks UI (G02, G03, G06)
- [`src/ws/index.js`](../../src/ws/index.js) — WebSocket topics (G01, G03)
- [`src/routes/images.js`](../../src/routes/images.js) — SSE reference pattern (G01)
- [`src/routes/misc.js`](../../src/routes/misc.js) — Watchtower detection pattern to mirror for G08
