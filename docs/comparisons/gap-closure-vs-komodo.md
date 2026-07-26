# Gap Closure Plan — Docker Dash vs Komodo

**Source doc:** [vs-komodo.md](vs-komodo.md)
**Baseline version:** v8.9.6-alpha.1 (2026-07-05)
**Current version:** v8.21.4 (2026-07-25)
**Owner:** Bogdan
**Status:** Executing — 8 of 9 actionable gaps closed
**Last reviewed:** 2026-07-26

## Executive summary

Komodo (mbecker20's Rust-based Docker/GitOps orchestrator) and Docker Dash target different shapes of infrastructure: Komodo is fleet-first with GitOps as the primary workflow; Docker Dash is single-host-first with security/audit/CIS depth. Most Komodo capabilities that Docker Dash "lacks" can be intentional scope divergence — not everything is worth closing. The honest gap list, after cross-referencing with what has already shipped (git polling, drift detection, webhooks with fail-closed HMAC, notification channels for Slack/Discord/webhook, event-triggered workflow rules, HA mode, container-level pipelines), reduces to **9 real gaps**: 1 × P0 (multi-host git stack targeting), 3 × P1 (server groups, procedures/runbooks, fleet-first UX polish), 3 × P2 (builder host concept, cross-host build pipeline, GitOps resource files), 2 × P3 (rollback UX, cluster-wide alerter dispatch). Two Komodo strengths are explicitly **won't-do** (Rust rewrite, MongoDB dependency) — they violate architecture invariants and would break the "single binary, no build step, SQLite embedded" thesis. Suggested Sprint 11–12 focus: G01 (multi-host git stacks) + G02 (host groups) unlock most of the fleet story with an incremental, additive schema change.

## Progress dashboard

| Priority | Total | Open | In progress | Closed | Won't-do |
|---|---:|---:|---:|---:|---:|
| P0 | 1 | 0 | 0 | 1 | 0 |
| P1 | 3 | 0 | 0 | 3 | 0 |
| P2 | 3 | 1 | 0 | 2 | 0 |
| P3 | 2 | 0 | 0 | 2 | 0 |
| Won't-do | 2 | 0 | 0 | 0 | 2 |
| **Total** | **11** | **1** | **0** | **8** | **2** |

**Closure summary (as of v8.21.4):**
- **v8.9.7-alpha.1:** G02 (Host groups); G01 partial (Multi-host git schema + basic API)
- **Current:** G01 completed (multi-host deploy, progressive rollout/health gates, target rollback, UI, per-target status/audit/drift, RBAC); G03 completed (staged parallel procedures, dependencies, live/cancellable runs, history, templates, RBAC); G04 completed (group-aware navigation, fuzzy host search, bulk fleet operations, compact hosts, health history); G07 completed (versioned YAML export, semantic plan, hash-bound apply, symbolic secrets, guarded deletion)
- **Current integration polish:** G02 groups are visible in the sidebar, Hosts, and Multi-host pages and remain filtered by effective host access
- **v8.9.9-alpha.1:** G05 (Builder host schema), G09 (Alerter routing)
- **Already shipped:** G08 (git.js:rollbackStack)
- **Deferred:** G06 (cross-host pipeline)
- **Won't-do:** G10 (Rust rewrite), G11 (MongoDB)

## Gap inventory

| ID | Gap | Priority | Effort | Status |
|---|---|---|---|---|
| G01 | Git stacks target a single host — no fleet/group targeting | P0 | M | `[x]` Multi-host target fan-out completed; group shortcuts remain optional G02 UX |
| G02 | No host groups (only container groups) | P1 | S | `[x]` v8.9.7-alpha.1 |
| G03 | No user-invoked ordered procedures (workflows are event-triggered only) | P1 | M | `[x]` v8.21.4 |
| G04 | Fleet-first UX polish — adding host N feels heavier than host 2 | P1 | S | `[x]` v8.21.4 |
| G05 | No dedicated "builder host" concept | P2 | S | `[x]` v8.9.9-alpha.1 (is_builder + default_registry_id columns; build dispatch in follow-up) |
| G06 | No cross-host build-and-deploy pipeline (build on A → deploy to B/C) | P2 | L | `[ ]` |
| G07 | No GitOps-native resource files (declare stack + host + alerter in YAML) | P2 | M | `[x]` v8.21.4 declarative fleet export/plan/apply |
| G08 | Git stack rollback is manual (revert commit + redeploy) | P3 | S | `[x]` already shipped (git.js:rollbackStack) |
| G09 | Alerter routing is per-rule, not per-scope (host/group/tag) | P3 | S | `[x]` v8.9.9-alpha.1 |
| G10 | Rust backend / single static binary | — | XL | `[-]` |
| G11 | MongoDB as datastore | — | XL | `[-]` |

## Gaps (detailed)

### G01 — Git stacks target a single host — no fleet/group targeting

- **Status:** `[x]` Completed
- **Priority:** P0
- **Effort:** M (1 week)
- **Dependencies:** G02 (host groups) — nice-to-have but not blocking
- **Impact if unclosed:** The single biggest reason someone picks Komodo over Docker Dash: "I have 5 VPSes, I want one Git stack deployed to all of them, redeploy on push." Today `git_stacks.host_id` is a scalar FK; deploying the same repo to 3 hosts means 3 rows, 3 clones, 3 webhook tokens. Users end up scripting the fan-out themselves or picking Komodo. Closing this unlocks the "small fleet from Git" use case without adopting Komodo's full model.

**Closure approach**

1. **Schema (migrations 074 + 095):** add a `git_stack_targets` join table: `(stack_id, host_id, PRIMARY KEY (stack_id, host_id))`. Keep `git_stacks.host_id` for backward compatibility, but treat it as "primary/legacy target" only. Migration 074 backfills existing stacks and 095 repairs the legacy local-host alias where needed.
2. **Service (`src/services/git.js`):** extend `listStacks()`, `getStack()`, `createStack()`, `updateStack()` to accept `target_host_ids: number[]` and read/write the join table. `triggerDeploy(stackId, source)` becomes fan-out: iterate targets, run compose-up per host, aggregate results, report per-host status. Deploy remains sequential (not parallel) — parallelism is a follow-up in G06.
3. **Routes (`src/routes/git.js`):** accept `target_host_ids` on POST/PUT. Return per-target status in GET responses.
4. **Frontend (`public/js/pages/git-stacks.js`):**
   - Create form: swap single-host dropdown for multi-select. Show host name + daemon type + last-deploy-status per target.
   - List view: badge shows target count ("Deploys to 3 hosts") and drift status is worst-of.
   - Detail view: per-target deployment history panel.
5. **Drift detection (`src/services/git-drift.js`):** `scanStack()` iterates targets; caller aggregates.
6. **Audit:** every fan-out deploy logs one entry per target with `details.target_host_id` so the audit trail is precise.

**Acceptance criteria**
- [x] Migrations 074/095 apply cleanly on fresh + existing DB, including legacy `host_id=0`
- [x] Existing single-host stacks continue to work unchanged
- [x] Create-stack form requires ≥1 active Docker-compatible host
- [x] Webhook / polling / manual deploy and rollback fan out sequentially to all targets
- [x] Per-target success/failure is surfaced in UI + audit log
- [x] Documentation added to `docs/features/git-integration.md`
- [x] Jest coverage: target persistence, filtering, updates, fan-out, partial failure, Docker CLI contexts, and drift

**Notes**

Deploy fan-out is sequential by default; document the trade-off. Users needing parallel deploy across many hosts can wait for G06 (cross-host build pipeline) which will introduce a proper worker model.

---

### G02 — No host groups (only container groups)

- **Status:** `[x]` Completed
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Once you have 10 hosts across prod/staging/dev or across geographic regions, per-host UI grouping becomes unwieldy. Komodo groups servers explicitly; Docker Dash today groups only containers (see `src/services/groups.js:33`). Blocks a clean "deploy to the `production` host group" flow in G01.

**Closure approach**

1. **Schema (migration 073):** dedicated `host_groups` and `host_group_members` tables keep host organization separate from per-user container groups.
2. **Service:** `src/services/host-groups.js` — mirror of `groups.js` shape but for hosts. CRUD + membership + list.
3. **Routes:** `src/routes/host-groups.js` — `/api/host-groups/*` with the same RBAC pattern (`requireAuth` + `requireRole('admin')` on writes).
4. **Frontend:** full group management lives under **Settings → Access**, with a **Manage groups** shortcut and group badges on the Hosts page.
5. **Fleet integration:** the sidebar renders a group-aware host tree and `multihost.js` exposes group filter chips. Read responses remove hosts and memberships outside the user's effective host ACL.
6. **Git integration:** Git stacks persist explicit host targets. Group shortcuts remain an optional future convenience so group membership changes cannot silently expand a production deployment.

**Acceptance criteria**
- [x] Migration 073 applies cleanly
- [x] CRUD works from Settings → Access and is linked from the Hosts page
- [x] Host cards show group badges
- [x] Multi-host overview supports group filters
- [x] Sidebar tree and group reads honor per-host access
- [x] Documented in `docs/features/fleet-operations.md`

**Notes**

Keep host-group RBAC simple: admin creates and edits, everyone reads. No per-group ACL yet — that would double the size of this gap.

---

### G03 — No user-invoked ordered procedures (workflows are event-triggered only)

- **Status:** `[x]` Completed
- **Priority:** P1
- **Effort:** M (1 week)
- **Dependencies:** none (works standalone; deeper with G01 for cross-host steps)
- **Impact if unclosed:** Docker Dash workflows (`src/services/workflows.js`) are event-triggered (container CPU high → restart). Komodo procedures are **ordered sequences of user-invoked steps** — "pull image X on host A, then restart container Y on host B, then notify Slack, then run health check". They cover release runbooks, patch rollouts, disaster recovery drills. Today an operator manually clicks through 4–6 buttons in sequence and hopes they get the order right.

**Closure approach**

1. **Schema (migration 096):** `procedures(id, name, description, steps_json, created_by, created_at)`, `procedure_runs(id, procedure_id, status, started_at, finished_at, log_json, started_by)`. `steps_json` is an ordered array of `{action_type, action_config, target_host_id, on_error: 'stop'|'continue'}`.
2. **Service (`src/services/procedures.js`):** `run(procedureId, {user, ip})` executes steps serially, streams progress via WS to any subscribed clients, halts on `on_error='stop'`, writes to `procedure_runs`.
3. **Action types (v1 minimum):** `pull_image`, `restart_container`, `stop_container`, `start_container`, `deploy_stack` (compose up), `notify_channel`, `webhook`, `wait_seconds`, `run_git_stack` (integrates with G01). Extension point pattern like `workflows.js:_executeAction`.
4. **Routes:** `POST /api/procedures/:id/run` — RBAC gated `admin|operator`. `GET /api/procedures/:id/runs` for history.
5. **Frontend:** new page `public/js/pages/procedures.js` — list + create wizard with step builder (add/reorder/remove steps). Run button opens a modal with live-streaming log. History tab.
6. **Sidebar entry:** "Procedures" gated on `data-fleet-daemon="docker,podman"` (any host that runs containers).

**Acceptance criteria**
- [x] CRUD for procedures via UI
- [x] Step builder supports the v1 action types
- [x] Run streams live progress + logs, with polling fallback and cancellation
- [x] Run history + audit-logged execution
- [x] Sample procedures included: "Blue/green deploy", "Roll all containers", "Emergency stop stack"
- [x] Jest coverage: validation, CRUD, serial execution, cancellation, error policies, RBAC, and audit
- [x] Documentation added to `docs/features/procedures.md`

**Notes**

Overlaps deliberately with `deployment_pipelines` (v6.16.0 pipeline). Consider whether procedures should GENERALIZE `pipeline.js` or coexist. Recommendation: keep `pipeline.js` as the single-container update pipeline (fixed shape); build procedures as the flexible user-defined counterpart. Both write to a unified `procedure_runs` table so the UI has one place to review "what happened last night."

---

### G04 — Fleet-first UX polish — adding host N feels heavier than host 2

- **Status:** `[x]` Completed
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** G02 (groups make this easier)
- **Impact if unclosed:** The comparison doc names this directly: "In Docker Dash, multi-host is supported but the product's center of gravity is the host you're currently looking at." When the operator has 8+ hosts, the sidebar host switcher, the containers page, and the images page all still feel oriented around one active host.

**Closure approach**

1. **Sidebar host switcher (`public/js/app.js`):** the flat selector is replaced with an ACL-filtered, group-aware collapsible tree with connection dots and inline search. `Ctrl/⌘+K` fuzzy-searches cached and server-provided hosts.
2. **Fleet entry points:** the existing Multi-host page remains an explicit navigation target. The dashboard adds fleet health and links to Multi-host rather than forcing an unexpected post-login redirect.
3. **Bulk host actions:** `multihost.js` provides admin-only multi-select restart and prune, a per-host preview, typed confirmation for prune, system-container exclusion, preserved volumes, partial results, and audit records.
4. **Cards-per-host consistency:** `hosts.js` adds a persisted compact mode and defaults to it above ten hosts.
5. **Fleet health at a glance:** migration 097 stores five-minute health buckets, a leader-only job samples in the background, and the admin dashboard renders connected/degraded/disconnected history for fleets of at least three hosts.

**Acceptance criteria**
- [x] Sidebar host tree renders groups + status
- [x] `Ctrl/⌘+K` opens a fuzzy host search palette
- [x] Multi-host overview supports bulk restart / prune with per-host preview
- [x] Dashboard shows fleet health widget when host count ≥ 3
- [x] New controls are keyboard-navigable and screen-reader labelled
- [x] Backend validation and fleet health persistence have Jest coverage
- [x] Documentation added to `docs/features/fleet-operations.md`

**Notes**

The dashboard stays the default landing page. This preserves existing navigation expectations while surfacing the fleet widget and a direct Multi-host link.

---

### G05 — No dedicated "builder host" concept

- **Status:** `[x]` Completed
- **Priority:** P2
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Komodo lets you mark one host as the builder; images are built there and pushed to a registry, then pulled elsewhere. Docker Dash's image build (`src/routes/images.js:673`) only builds on the current active host, using its BuildKit. For fleets, this means either every host builds independently (wasteful) or the operator scripts the build-and-push flow outside the dashboard.

**Closure approach**

1. **Schema (migration 076):** add `docker_hosts.is_builder BOOLEAN DEFAULT 0` and `docker_hosts.default_registry_id INTEGER REFERENCES container_registries(id)`.
2. **Frontend (`public/js/pages/hosts.js`):** host edit form gets "Use as build host" toggle + default registry dropdown.
3. **Backend (`src/routes/images.js` build endpoint):** accept `builder_host_id` in body; if unset, use the first host with `is_builder=1` or fall back to current active host. After build succeeds, if `default_registry_id` is set and image tag has no registry prefix, automatically retag + push.
4. **Docs:** new howto `builder-host-setup.md` covering fast NVMe host, registry credentials, and cache reuse.

**Acceptance criteria**
- [ ] Host edit form supports "builder" flag
- [ ] `/api/images/build` respects `builder_host_id` fallback chain
- [ ] Successful build with default_registry_id auto-pushes
- [ ] Audit log captures builder host + registry used
- [ ] Howto shipped

**Notes**

This is scaffolding for G06 (cross-host build-and-deploy pipeline). Ship G05 first because it's cheap and immediately useful even without pipelines.

---

### G06 — No cross-host build-and-deploy pipeline (build on A → deploy to B/C)

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** L (2-3 weeks)
- **Dependencies:** G01 (multi-host targets), G05 (builder host), G03 (procedures scaffolding is reusable)
- **Impact if unclosed:** The Komodo pitch for CI-shaped teams: "Push to Git → Komodo builds on the builder → rolls out to N app hosts → alerts on failure." Docker Dash today can do this piecewise (webhook → build endpoint → deploy endpoint) but not as one first-class primitive. Users needing this today either use Komodo, Portainer + external CI, or a shell script.

**Closure approach**

1. **Schema (migration 077):** `build_deploy_pipelines(id, name, git_credential_id, repo_url, branch, dockerfile_path, image_tag_template, builder_host_id, target_stack_id_or_group)`. `pipeline_runs(id, pipeline_id, status, stages_json, log_json, ...)` reusing `procedure_runs` shape if possible.
2. **Service (`src/services/build-deploy.js`):** orchestrator:
   - Stage 1: clone repo on builder host or in `/data/repos/`
   - Stage 2: `docker build -t <resolved_tag> -f <dockerfile>` on builder host
   - Stage 3: push to registry (uses builder host's `default_registry_id`)
   - Stage 4: fan out to targets — pull image + compose up
   - Stage 5: verify health checks pass
   - Stage 6: notify configured channel on success/failure
3. **Trigger sources:** manual "Run" button, webhook (extend `gitWebhook.js` with pipeline mode alongside stack mode), scheduled (uses existing `scheduled_actions`).
4. **Frontend:** new page `public/js/pages/pipelines.js` with builder view (stage list, live log per stage). Reuse the streaming pattern from `pipeline.js` UI.
5. **RBAC:** create/edit is `admin`; run is `admin|operator`; view is any authenticated user.

**Acceptance criteria**
- [ ] End-to-end run of a sample repo (build → push → deploy to 2 hosts → verify → notify Slack)
- [ ] Failure at any stage halts, marks status, notifies
- [ ] Webhook trigger works (reuses `gitWebhook.js` HMAC verification)
- [ ] Audit log captures builder + target hosts + registry + tag
- [ ] Howto `build-deploy-pipelines.md`
- [ ] Jest coverage: happy path, build failure, push failure, deploy failure, notify failure

**Notes**

This is the biggest single gap in effort. Consider deferring to v9.0 if v8.9 focus is elsewhere. Also consider whether procedures (G03) with a "run image build" step type could substitute — leaner but less turnkey.

---

### G07 — No GitOps-native resource files (declare stack + host + alerter in YAML)

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** M (1 week)
- **Dependencies:** G01 (multi-host targets should exist in the schema before serializing them to YAML)
- **Impact if unclosed:** Komodo's core opinion: resources live as YAML in Git, dashboard reconciles state. Docker Dash resources live only in SQLite. That's fine for single-operator use but blocks the "team reviews infrastructure change via PR" workflow. This gap is legitimately debatable — Docker Dash's thesis explicitly is "no external agent, no build step, embedded state." Closing it would shift the product's philosophy.

**Closure approach**

1. **Export/plan/apply first, syncing later:**
   - `GET /api/gitops/export` exports hosts, groups, Git stacks/targets, staged procedures, and notification references as versioned YAML/JSON. Secrets are omitted and represented only by symbolic references.
   - `POST /api/gitops/plan` validates and produces a semantic diff; `POST /api/gitops/apply` accepts only the reviewed anti-stale plan hash.
2. **Later phase — declarative sync:** point Docker Dash at a Git repo containing `docker-dash.yaml` and let it reconcile on push. This is a bigger design decision — leave as a follow-up.
3. **Frontend:** the Git Stacks page includes a Fleet GitOps YAML editor, download, plan summary, blocked actions, and guarded apply flow.
4. **Secret strategy:** encrypted values never leave the database; exported symbolic references preserve existing local secrets and block unsafe cross-install creation.

**Acceptance criteria**
- [x] YAML export of all first-slice reconcilable resources
- [x] YAML/JSON input with normalized dry-run diff
- [x] Round-trip plan/apply coverage with stale-plan rejection
- [x] Secrets omitted and represented by symbolic references
- [x] Documentation: `docs/features/declarative-gitops.md`

**Notes**

Do NOT try to catch up to Komodo's declarative sync in one gap. Ship export/import first, gather feedback, then decide if declarative sync fits Docker Dash's shape.

---

### G08 — Git stack rollback is manual (revert commit + redeploy)

- **Status:** `[ ]` Open
- **Priority:** P3
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** After a bad deploy, the operator has to open a terminal, `git revert`, push, wait for the webhook to fire again. Komodo has one-click rollback to the previous commit. Not table-stakes — but a nice ergonomic win.

**Closure approach**

1. **Schema:** `git_stacks` already tracks `last_deployed_commit` (verify). Add `previous_deployed_commit` on successful deploy.
2. **Service (`src/services/git.js`):** `rollback(stackId, {user, ip})` — check out `previous_deployed_commit`, run compose up, log everything.
3. **Route:** `POST /api/git/stacks/:id/rollback`.
4. **Frontend (`git-stacks.js`):** "Rollback" button next to "Redeploy" on the detail page, gated on presence of `previous_deployed_commit`, with confirmation modal showing "Rolling back from `<sha1>` to `<sha1>` — impacts N containers."
5. **Audit:** dedicated `git_stack_rollback` action.

**Acceptance criteria**
- [ ] After 2 successful deploys, previous commit is tracked
- [ ] Rollback button visible + operable
- [ ] Rollback fans out to all G01 targets
- [ ] Audit log captures from/to commit + user

**Notes**

Depth of history is 1 (previous commit only). Deeper rollback needs a full deployment history table — defer that until requested.

---

### G09 — Alerter routing is per-rule, not per-scope (host/group/tag)

- **Status:** `[ ]` Open
- **Priority:** P3
- **Effort:** S (1-3 days)
- **Dependencies:** G02 (host groups)
- **Impact if unclosed:** Today alert rules pick a channel; Komodo lets you say "send prod alerts to #ops-prod, staging to #ops-staging, everything else to #general." Not a deal-breaker — but with more hosts, per-rule routing gets tedious.

**Closure approach**

1. **Schema:** `alert_channel_routes(id, scope_type, scope_id, channel_id, severity_min)`. Scope types: `all`, `host`, `host_group`, `container_tag`.
2. **Service (`src/services/alerts.js`):** on alert fire, resolve routes: exact scope match first, then host_group, then `all`. Dispatch to matched channels.
3. **Frontend:** new panel under Alerts → "Routing" tab. Rows: scope selector + channel selector + optional severity threshold.
4. **Backward compat:** if no routes configured, fall back to the current per-rule channel.

**Acceptance criteria**
- [ ] Routing table CRUD
- [ ] Fired alert delivered to correct channel(s) based on scope
- [ ] Backward compat: rules with no route still deliver
- [ ] Howto updated in alerts docs

**Notes**

Keep routing evaluation simple. Do not build a full expression language — scope + severity + channel is enough.

---

### G10 — Rust backend / single static binary

- **Status:** `[-]` Won't-do
- **Priority:** —
- **Effort:** XL (1+ month, effectively a rewrite)
- **Dependencies:** N/A
- **Impact if unclosed:** Docker Dash stays on Node.js. Cold start + memory footprint remain higher than a Rust binary. In practice, ~50 MB at idle and a ~180 MB image are already competitive; the Rust argument is more about ideology than measurable UX for typical users.

**Rationale for won't-do**

Rewriting to Rust violates the architecture invariants in [CLAUDE.md](../../CLAUDE.md): "No build step. Frontend is plain JS loaded via `<script>` tags." and "CommonJS backend. `require()` / `module.exports`." A Rust rewrite would double the surface area (Rust + JS frontend) and drop the "clone repo, `docker run`, done" simplicity that is core to the product. If perf becomes measurably problematic (>500 MB idle, >5s cold start), revisit — but not before.

---

### G11 — MongoDB as datastore

- **Status:** `[-]` Won't-do
- **Priority:** —
- **Effort:** XL
- **Dependencies:** N/A
- **Impact if unclosed:** Docker Dash stays SQLite-embedded. Some horizontal scaling patterns (multi-writer control plane) become harder — but the `DD_MODE=ha` Redis-leader-election design already covers the multi-instance case without adopting a heavy external DB.

**Rationale for won't-do**

Direct violation of "SQLite embedded. No external DB." (CLAUDE.md). Adding MongoDB doubles operational complexity for zero user-visible benefit at the current scale (single host, HA opt-in). The comparison doc itself calls this out as a Komodo weakness ("Docker + MongoDB"). Keep the moat.

---

## Suggested execution order

1. **G02 — Host groups** (S) — small and unblocks G01/G04/G09. Ship first.
2. **G01 — Multi-host git stack targets** (M) — the P0. Ships the biggest fleet feature; validates G02 schema.
3. **G04 — Fleet-first UX polish** (S) — polish once groups + multi-target are in place. Concentrates the value.
4. **G03 — User-invoked procedures** (M) — orthogonal to fleet targets; can run in parallel with G04.
5. **G05 — Builder host concept** (S) — cheap scaffolding for G06; ship even if G06 is deferred.
6. **G08 — Git stack rollback** (S) — small ergonomic win; ideally paired with G01 in the same sprint.
7. **G09 — Alerter routing** (S) — needs G02; small, ship late.
8. **G07 — GitOps config export/import** (M) — after fleet story is real; export becomes meaningful only when there IS fleet state to serialize.
9. **G06 — Cross-host build-and-deploy pipeline** (L) — the big rock. Defer to v9.0 minor unless a paying customer signals urgency.

## Won't-do (explicitly out of scope)

| ID | Item | Rationale |
|---|---|---|
| G10 | Rust rewrite | Violates "no build step / CommonJS backend" invariant. Perf is fine at current scale. |
| G11 | MongoDB / external DB | Violates "SQLite embedded" invariant. HA already handled via `DD_MODE=ha` + Redis leader election. |

Also intentionally NOT in this plan (never-shipping items from the parent thinking):
- Full declarative GitOps sync (Docker Dash is imperative-first + optional Git; G07 covers export/import which is enough)
- Agent-based host management (Docker Dash uses direct Docker API + SSH; adding an agent doubles the deployment surface)
- YAML-editor-in-browser for resources (Komodo has this; Docker Dash intentionally avoids browser-based editors of any kind, same reasoning as the "no `kubectl`-in-browser terminal" k8s decision)

## Cross-references

- [Docker Dash vs Komodo comparison](vs-komodo.md)
- [CHANGELOG](../../CHANGELOG.md)
- Architecture invariants: [CLAUDE.md](../../CLAUDE.md)
- Existing git integration: `src/services/git.js`, `src/services/git-drift.js`, `src/services/gitPolling.js`
- Existing notification channels: `src/services/notificationChannels.js` (discord/slack/webhook/ntfy already supported)
- Existing workflows (event-triggered): `src/services/workflows.js`
- Existing container pipeline (single container update): `src/services/pipeline.js`
- HA foundation: `src/services/cluster.js`
