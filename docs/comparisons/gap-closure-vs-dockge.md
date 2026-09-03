# Gap Closure Plan — Docker Dash vs Dockge

**Source doc:** [vs-dockge.md](vs-dockge.md)
**Baseline version:** v8.9.6-alpha.1 (2026-07-05)
**Current version:** v8.21.4 (2026-07-25)
**Owner:** Bogdan
**Status:** Complete — 8 of 8 actionable gaps closed
**Last reviewed:** 2026-07-25

## Executive summary

Dockge and Docker Dash are different-shape tools: Dockge is a minimal, opinionated Compose-stack manager; Docker Dash is a broad-scope Docker dashboard. Most of what "Dockge does better" per the comparison doc — focused scope, UX minimalism, small image, Svelte reactivity, Uptime Kuma sibling feel — reflects deliberate design differences that Docker Dash will NOT try to erase. All eight actionable Stacks gaps are now closed: Compose actions stream asynchronously, stack detail multiplexes every service's logs, stopped disk stacks remain actionable, a Compose-first layout lowers navigation cost, and both YAML and visual form editing are available.

## Progress dashboard

| Priority | Total | Open | In progress | Closed | Won't-do |
|---|---:|---:|---:|---:|---:|
| P0 | 1 | 0 | 0 | 1 | 0 |
| P1 | 2 | 0 | 0 | 2 | 0 |
| P2 | 2 | 0 | 0 | 2 | 0 |
| P3 | 3 | 0 | 0 | 3 | 0 |
| Won't-do | 4 | 0 | 0 | 0 | 4 |
| **Total** | **12** | **0** | **0** | **8** | **4** |

**Closure summary (as of v8.21.4):**
- **v8.9.7-alpha.1:** G06 (docker-run → compose converter — backend)
- **v8.9.9-alpha.1:** G04 discovery foundation, G06 UI polish, G08 (Uptime Kuma auto-detect)
- **Current:** G01 (non-blocking Compose runner + SSE); G02 (offline YAML editor + two-stage validation); G03 (combined stack history + multiplexed live logs); G04 completed (disk/runtime merge, stopped-stack actions, canonical path hardening); G05 (Compose-first dashboard and simple mode); G07 (comment-preserving visual service editor)
- **Deferred:** none
- **Won't-do:** W01-W04 (image size, Svelte, scope cut, drop scanners)

## Gap inventory

| ID | Gap | Priority | Effort | Status |
|---|---|---|---|---|
| G01 | Compose `up`/`down`/`pull`/`restart` is blocking `execFileSync` with no live output | P0 | M | `[x]` v8.21.4 |
| G02 | Compose YAML editor is plain `<textarea>`, no syntax highlighting or lint | P1 | M | `[x]` v8.21.4 |
| G03 | No stack-level combined log stream (all services, one view, live) | P1 | S | `[x]` v8.21.4 |
| G04 | No filesystem-first stacks discovery (point at `/opt/stacks`, auto-import) | P2 | S | `[x]` v8.21.4 |
| G05 | No "simple mode" / Compose-first landing to lower learning curve | P2 | XS | `[x]` v8.21.4 |
| G06 | `docker run` command → compose converter not exposed as paste-command UI | P3 | S | `[x]` v8.9.9-alpha.1 (backend + UI done) |
| G07 | No interactive form-based service editor (edit ports/env/mounts via forms, not YAML) | P3 | L | `[x]` v8.21.4 |
| G08 | No sibling-app discovery/deep link for Uptime Kuma | P3 | XS | `[x]` v8.21.4 |
| W01 | Match Dockge image size (~30-50 MB) | — | — | `[-]` |
| W02 | Rewrite frontend in Svelte / add build step | — | — | `[-]` |
| W03 | Reduce scope to Compose-only | — | — | `[-]` |
| W04 | Drop bundled scanners (Trivy/Grype/Scout) for footprint | — | — | `[-]` |

## Gaps (detailed)

### G01 — Compose actions block the event loop and hide progress

- **Status:** `[x]` Completed
- **Priority:** P0
- **Effort:** M (1 week)
- **Dependencies:** none
- **Impact if unclosed:** [`src/routes/system-stacks.js:41,189,293,361`](../../src/routes/system-stacks.js) calls `execFileSync('docker', ['compose', ...])` with a 120 s timeout. This freezes the Node event loop for the whole duration on any concurrent request, and returns nothing to the client until the compose command finishes. Users see a spinning button for 30-120 s on `up`/`pull` with no signal that anything is happening; a slow pull looks identical to a hung server. Dockge streams every line of `docker compose` output live via Socket.IO — one of its main UX wins. This is our largest concrete Stacks-flow gap.

**Closure approach**

1. `src/services/compose-runner.js` uses `spawn('docker', ['compose', '--ansi', 'never', ...])`, consumes both pipes continuously, enforces a 120-second timeout, and bounds captured output at 5 MB.
2. `POST /api/system/compose/:stack/:action/stream` sends `start`, `output`, `done`, and `error` SSE events. The existing JSON action endpoint uses the same runner.
3. `public/js/pages/stacks.js` opens an accessible live-output dialog from list and detail actions. Closing the dialog does not terminate a deployment halfway through.
4. Config rendering/validation and create/deploy paths no longer use synchronous Compose execution.
5. Success and failure audit entries include status, host, exit code, duration, and a 4 KB output tail.

**Acceptance criteria**
- [x] `execFileSync` removed from `src/routes/system-stacks.js`
- [x] Legacy JSON and new `/stream` SSE action endpoints use the same asynchronous runner
- [x] Frontend action buttons open a live-output panel for stdout and stderr
- [x] Independent Compose actions can run concurrently
- [x] Audit log records `compose_up` / `compose_down` / `compose_restart` / `compose_pull` with bounded output and exit metadata
- [x] Runner, concurrency, timeout, failure, SSE, RBAC, audit, and legacy endpoint behavior have Jest coverage
- [x] Documentation added to `docs/features/compose-stacks.md`

**Notes**

The normal API rate limiter and a three-operation per-user concurrency cap both apply. Compose output is capped at 5 MB and emits an explicit truncation warning; all later pipe data is still consumed so the child cannot stall.

---

### G02 — Compose YAML editor is a plain textarea

- **Status:** `[x]` Completed
- **Priority:** P1
- **Effort:** M (1 week)
- **Dependencies:** none; the no-build invariant is preserved by vendoring browser-ready assets
- **Impact if unclosed:** In [`public/js/pages/stacks.js:380`](../../public/js/pages/stacks.js) the create-stack YAML input is a `<textarea>`; the config-tab view is a read-only `<pre>` at line 290. Compare to Dockge's Monaco-based editor with YAML syntax highlighting, bracket matching, and (in newer versions) `docker-compose.yml` schema validation. Users editing anything non-trivial go copy the YAML into VSCode, edit, paste back — a bad experience that pushes Compose-first users toward Dockge.

**Closure approach**

The official browser-ready CodeMirror 5.65.21 distribution and js-yaml 5.2.2 UMD build are vendored under `public/vendor/`, with their licenses. `public/js/utils/yaml-editor.js` progressively enhances a textarea and exposes `mount`, `getValue`, `setValue`, `validate`, `focus`, `refresh`, and `destroy`. It is wired into three places:

1. Create-stack modal, with local YAML validation followed by authoritative `docker compose config` validation.
2. Compose-config tab, editable for admins and read-only for viewers, with the same two-stage validation before save.
3. Git-stack Edit & Push modal, which safely reads the configured Compose file, validates it locally and on the server, then commits and pushes it.

The Git file endpoint validates relative `.yml`/`.yaml` paths, keeps reads inside the repository, rejects non-files and caps content at 2 MB. Client-side parse errors include line and column information; server-side Compose validation remains the source of truth.

**Acceptance criteria**
- [x] CodeMirror browser distribution and js-yaml are vendored under `public/vendor/` (offline, no CDN, no build step)
- [x] `YamlEditor.mount()` utility exists and is documented in a JSDoc header
- [x] Create-stack modal uses the editor
- [x] Compose-config tab uses the editor with a Save button for administrators and a read-only view otherwise
- [x] Git-stack editing loads and edits the configured Compose file
- [x] Client-side YAML syntax errors surface inline before Save
- [x] Server-side `docker compose config` validation runs before create, save, or Git push
- [x] Editor works in light and dark themes (respects Docker Dash CSS variables)
- [x] Functional asset delta is 136.2 KiB gzipped, below the 300 KiB budget

**Notes**

CLAUDE.md invariant #1 forbids a build step, not third-party JS. The current CodeMirror 6 packages are modular and expect a bundler or module loader, while the official CodeMirror 5 distribution ships browser-ready files. Vendoring that distribution keeps Docker Dash offline-capable and preserves the existing no-build frontend.

---

### G03 — No stack-level combined log stream

- **Status:** `[x]` Completed
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Docker Dash has a per-container live log stream (WebSocket topic `logs:subscribe` in [`public/js/pages/container-detail.js:1545`](../../public/js/pages/container-detail.js) → [`src/ws/index.js:238`](../../src/ws/index.js)) and a Log Explorer at [`public/js/pages/logs.js`](../../public/js/pages/logs.js) that aggregates across containers but polls. Neither is exposed on the stack-detail page. Dockge's stack view shows `docker compose logs -f` output — one combined, interleaved, live tail of every service in the stack. That's the workflow "I just brought this stack up, is it healthy?" — currently our users have to click through each service one by one.

**Closure approach**

1. The Compose detail view adds a **Logs** tab with timestamp-sorted history from the existing multi-log endpoint and live continuation over WebSocket.
2. The WS protocol adds `logs:subscribe-many`, multiplexes up to 25 daemon streams per client, tags every message with its container ID, and retains the legacy single-container protocol.
3. The UI color-hashes service names, prefixes each line, caps scrollback at 5,000 lines, and exposes search, Follow, Pause/Resume, Clear, and Download.
4. Tab/page changes unsubscribe and destroy only the relevant streams; WebSocket reconnect restores the active stack subscription.
5. Host and stack `view` permissions are checked before a live stream opens. HTTP single/multi-log reads also enforce stack visibility.

**Acceptance criteria**
- [x] New "Logs" tab in the compose-stack detail page
- [x] Follow toggle live-scrolls new lines
- [x] Each line is prefixed with `[service-name]` in a stable per-service color
- [x] Pause / Resume / Clear / Download controls are implemented
- [x] Tab switch, page navigation, socket close, and reconnect clean up or restore subscriptions correctly
- [x] Works for 1–20 services and warns/caps cleanly above 20
- [x] Multiplexing, limits, ACL denial, tagging, and unsubscribe behavior have Jest coverage

**Notes**

Git-stack detail, Nomad, and Kubernetes views remain follow-ups; this closure applies to local Compose stack detail.

---

### G04 — No filesystem-first stacks discovery

- **Status:** `[x]` Completed
- **Priority:** P2
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** [`src/routes/system-stacks.js:203`](../../src/routes/system-stacks.js) `GET /stacks` builds the stack list from **running** containers' `com.docker.compose.project` labels. If a stack is `down`, it disappears from the UI entirely — the compose file on disk is invisible. Dockge's mental model is inverse: point at a stacks directory (default `/opt/stacks` in Dockge, configurable), scan for `docker-compose.yml` files, list every stack whether up or down. This is why Dockge users can bring a stopped stack back up with one click.

**Closure approach**

`DD_STACKS_DIR` (default `/opt/stacks`, comma-separated) feeds `src/services/stacks-fs.js`, which scans three levels without following nested symlinks. `GET /stacks` merges canonical disk definitions with runtime projects, excludes Docker Dash Git-repo storage, and gives runtime state precedence. Disk-only stacks show a stopped badge, configured services, and working Up/Pull actions. The detail endpoint reads their Compose and `.env` files even with no containers.

**Acceptance criteria**
- [x] `DD_STACKS_DIR` documented in `.env.example`
- [x] `src/services/stacks-fs.js` unit-tested for discovery, canonical containment, depth, and symlink handling
- [x] Stopped stacks appear in the Stacks list with a distinct disk-discovered badge
- [x] Bringing a stopped stack up uses the same asynchronous Compose action route
- [x] Canonical paths outside configured roots are rejected
- [x] Git-managed repository storage is excluded from filesystem results

**Notes**

Docker Dash's managed Git repositories live under `/data/repos` and are excluded before the merge. A future configurable Git clone root must preserve the same exclusion rule.

---

### G05 — No "Compose-first" landing / simple mode

- **Status:** `[x]` Completed
- **Priority:** P2
- **Effort:** XS (< 1 day)
- **Dependencies:** none
- **Impact if unclosed:** New Docker Dash users hit a Dashboard that surfaces 20+ modules (Registry, CIS, Security, Backup, Observability wizard, ...). A user coming from Dockge expecting "compose editor + up/down" gets sensory overload. Dockge wins on onboarding time because its scope is smaller — we can't shrink the scope, but we can make Stacks the visually dominant first-run action.

**Closure approach**

The Dashboard now shows a Compose-first card until the user dismisses it; dismissal is stored in the existing per-user preferences API. The standard sidebar starts with Dashboard, Stacks, Containers, and Images. `?mode=simple` persists in a same-site cookie and reduces navigation to those four primary entries plus a single More accordion; Show all restores the complete layout without removing any feature.

**Acceptance criteria**
- [x] Sidebar order updated: Dashboard, Stacks, Containers, Images, ... (Stacks moves to #2)
- [x] First-use banner card on Dashboard links to Stacks and persists dismissal per user
- [x] `?mode=simple` collapses secondary sections; Show all restores the complete sidebar

**Notes**

Do not remove features — this is layout only. Existing power users must be able to keep the full sidebar.

---

### G06 — `docker run` command → compose converter not exposed

- **Status:** `[x]` Completed
- **Priority:** P3
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Docker Dash has [`_generateComposeFromInspect`](../../src/routes/system-stacks.js) (line 56) and [`generateCompose`](../../src/routes/containers.js) (line 962) that turn an already-running container into compose YAML. What's missing is the Dockge-style "paste your `docker run` command, get a compose file back" workflow — useful for users adopting a docs recipe. This is a paste-command UI, not a container→compose converter.

**Closure approach**

`src/services/docker-run-parser.js` tokenizes quoted commands and converts common runtime flags into a Compose service. The authenticated converter endpoint returns the generated YAML and suggested service name. The Stacks toolbar opens a converter dialog whose output uses the shared YAML editor; after review and editing, **Create Stack** carries the YAML and suggested name into the normal create/validate/deploy flow.

**Acceptance criteria**
- [x] `POST /api/compose/convert` handles common `docker run` flags
- [x] Malformed commands return HTTP 400 with a specific parse error message
- [x] Convert modal is accessible from the Stacks page toolbar
- [x] Generated YAML is editable and linted before Create Stack
- [x] Create Stack receives the generated YAML and suggested service name
- [x] Unit tests cover ports, volumes, environment, restart, network, quoted arguments, and parser failures

**Notes**

Existing `_generateComposeFromInspect` covers a different use case (existing container → compose). Do not conflate — keep both entry points.

---

### G07 — No interactive form-based service editor

- **Status:** `[x]` Completed
- **Priority:** P3
- **Effort:** L (2-3 weeks)
- **Dependencies:** G02 (YAML editor) should ship first
- **Impact if unclosed:** Users editing a service's environment variables, port mappings, or volume mounts have to hand-edit YAML. Newer Dockge versions offer a form-based service editor for the common fields (Portainer does too). This is a UX-luxury feature, not a blocker.

**Closure approach**

`public/js/components/compose-service-form.js` renders controls for `image`, `restart`, `ports[]`, `environment[]`, `volumes[]`, `depends_on[]`, and `networks[]`, plus add/remove service actions. The official `yaml` browser module is vendored and loaded only when Form view is opened. It edits document nodes instead of serializing a plain object, preserving comments, advanced fields, key order, and all top-level sections that the form does not own. The Compose Config tab switches bidirectionally between Form and the G02 YAML editor; Save synchronizes the active form, then uses local YAML lint and authoritative server-side Compose validation before the existing config endpoint writes anything.

**Acceptance criteria**
- [x] Form-based edit covers image, restart, ports, environment, volumes, depends_on, and networks
- [x] Services can be added, renamed, and removed with duplicate/name validation
- [x] Toggle between YAML and Form preserves edits in both directions
- [x] Node-level round-trip through the `yaml` package preserves comments and untouched fields
- [x] Fields not owned by the form (`build`, `healthcheck`, `deploy`, etc.) show an "Edit these fields in YAML view" warning
- [x] Invalid service, environment, restart, port, and volume input is surfaced inline
- [x] Save writes through the existing config endpoint after local and server Compose validation
- [x] Viewers receive the same Form/YAML switch in read-only mode

**Notes**

Form view is marked `preview` because it deliberately owns only common service fields. YAML remains the complete source of truth for advanced Compose features, while the node-level update strategy ensures those features are not discarded.

---

### G08 — No Uptime Kuma sibling-app discovery/deep link

- **Status:** `[x]` Completed
- **Priority:** P3
- **Effort:** XS (< 1 day)
- **Dependencies:** none
- **Impact if unclosed:** Comparison doc calls out "integrated with the louislam ecosystem — Uptime Kuma sibling feel." Dockge users often run Uptime Kuma next to Dockge. Docker Dash should at least recognize that sibling service and provide a direct path to it.

**Closure approach**

`GET /api/integrations/uptime-kuma` searches the selected host for the official image, includes stopped containers, and returns bounded container metadata plus its published port. The Stacks page consumes that endpoint on load and shows a visible detection banner with a safe same-host deep link when port 3001 is published. Discovery failures remain non-fatal to stack management.

**Acceptance criteria**
- [x] Uptime Kuma is detected on the currently selected host, including when stopped
- [x] Stacks page shows a detection banner and container name
- [x] Published port produces an HTTP(S)-validated deep link using the current hostname
- [x] Missing port or daemon errors degrade safely without blocking Stacks
- [x] Route behavior has Jest coverage

**Notes**

Automatic monitor creation is intentionally not claimed: Uptime Kuma's documented API keys are for metrics access, while monitor mutation still relies on its internal Socket.IO protocol. Docker Dash does not store a Kuma account password or bind itself to an unsupported private API. The integration namespace remains extensible to Statping, Gatus, or Kener.

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

## Closure result

All eight actionable gaps are closed. W01-W04 remain deliberate product decisions rather than implementation backlog.

## Cross-references

- [Docker Dash vs Dockge comparison](vs-dockge.md)
- [CHANGELOG](../../CHANGELOG.md)
- [`src/routes/system-stacks.js`](../../src/routes/system-stacks.js) — compose routes (G01, G02, G04)
- [`public/js/pages/stacks.js`](../../public/js/pages/stacks.js) — Stacks UI (G02, G03, G06)
- [`src/ws/index.js`](../../src/ws/index.js) — WebSocket topics (G01, G03)
- [`src/routes/images.js`](../../src/routes/images.js) — SSE reference pattern (G01)
- [`src/routes/misc.js`](../../src/routes/misc.js) — Watchtower detection pattern to mirror for G08
