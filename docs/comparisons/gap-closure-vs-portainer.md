# Gap Closure Plan — Docker Dash vs Portainer

**Source doc:** [vs-portainer.md](vs-portainer.md)
**Baseline version:** v8.9.6-alpha.1 (2026-07-05)
**Current version:** v8.9.10-alpha.1 (2026-07-06)
**Owner:** Bogdan
**Status:** Executing — 9 of 12 actionable gaps closed
**Last reviewed:** 2026-07-06

## Executive summary

The honest gap against Portainer is narrower than the marketing "Portainer is enterprise, we're not" framing suggests — Docker Dash already ships OIDC/OAuth, LDAP, TOTP, hash-chained audit log, 7-channel notifications, app + custom templates, container/stack lifecycle, Swarm, cloned/updated containers, and (as of Sprints 3-10) read-mostly integrations for Podman, Incus/LXD, Proxmox, Kubernetes, Nomad and Wasm. That leaves **13 real gaps** clustered in three groups: (1) **multi-tenant RBAC** — teams, host/environment groups, per-host access control (P0/P1, the deep gap that matters for shops with >1 user); (2) **Kubernetes maturity** — write ops, pod logs, cordon/drain, kubeconfig download (P1/P2, mostly already-scoped as alpha.2 follow-ups); (3) **Edge & operational polish** — container webhooks, volume browser, noVNC console, real-time Docker events stream (P1-P3). Roughly 4-6 weeks of focused work closes the P0/P1 tier; the Edge-agent-at-scale gap is explicitly **won't-do** — it fights the single-binary, no-agent architecture invariant, and the SSH-tunnel model already covers 95% of homelab/small-fleet cases.

## Progress dashboard

| Priority | Total | Open | In progress | Closed | Won't-do |
|---|---:|---:|---:|---:|---:|
| P0 | 2 | 0 | 0 | 2 | 0 |
| P1 | 5 | 0 | 0 | 5 | 0 |
| P2 | 4 | 3 | 0 | 1 | 0 |
| P3 | 2 | 0 | 0 | 1 | 1 |
| **Total** | **13** | **3** | **0** | **9** | **1** |

**Closure summary (as of v8.9.10-alpha.1):**
- **v8.9.7-alpha.1:** G03 (Host groups), G08 (KubeConfig), G13 (K8s Ingress/NP read)
- **v8.9.8-alpha.1:** G04 (K8s write ops), G05 (K8s pod logs), G06 (Container webhooks), G09 (Docker events)
- **v8.9.9-alpha.1:** G07 (Volume file browser — list/read/delete)
- **v8.9.10-alpha.1:** G01 (Teams), G02 (Per-host access control)
- **Deferred:** G10 (Proxmox noVNC — needs own deep-spec), G11 (custom RBAC roles — needs G01/G02 field-tested first)
- **Won't-do:** G12 (Edge Agent at scale — architecture conflict)

## Gap inventory

| ID | Gap | Priority | Effort | Status |
|---|---|---|---|---|
| G01 | Teams (user groups sharing permissions) | P0 | L | `[x]` v8.9.10-alpha.1 (teams primitive + CRUD + resolver; UI in follow-up) |
| G02 | Per-host / environment-level access control | P0 | M | `[x]` v8.9.10-alpha.1 (resolver + grant/revoke API; legacy_default flag preserves upgrade compat) |
| G03 | Host groups (bulk-apply access + tags) | P1 | S | `[x]` v8.9.7-alpha.1 |
| G04 | Kubernetes write ops (scale / restart / delete pod / cordon) | P1 | M | `[x]` v8.9.8-alpha.1 |
| G05 | Kubernetes pod log streaming | P1 | S | `[x]` v8.9.8-alpha.1 |
| G06 | Per-container webhook trigger URL (redeploy on POST) | P1 | S | `[x]` v8.9.8-alpha.1 |
| G07 | Volume file browser (list / upload / download / delete inside a volume) | P1 | M | `[x]` v8.9.9-alpha.1 (list + read + delete backend; upload deferred) |
| G08 | KubeConfig download for the logged-in user | P2 | XS | `[x]` v8.9.7-alpha.1 |
| G09 | Real-time Docker events stream on the UI | P2 | S | `[x]` v8.9.8-alpha.1 (backend SSE done; UI in v8.9.9) |
| G10 | Proxmox noVNC / SPICE console iframe | P2 | M | `[ ]` |
| G11 | Custom RBAC roles (beyond fixed admin/operator/viewer) | P2 | M | `[ ]` |
| G12 | Edge Agent (async polling from behind NAT, scale to thousands) | P3 | XL | `[-]` |
| G13 | Kubernetes Ingress / NetworkPolicy read view | P3 | S | `[x]` v8.9.7-alpha.1 |

## Gaps (detailed)

### G01 — Teams (user groups sharing permissions)

- **Status:** `[x]` Completed
- **Priority:** P0
- **Effort:** L (2-3 weeks)
- **Dependencies:** none (unblocks G02, G03)
- **Impact if unclosed:** Any organisation with more than a couple of operators has to grant permissions user-by-user. There is no way to say "the ops team can operate all prod hosts" without editing every user. This is the single biggest RBAC ceiling and the most common reason a Portainer user cites for not switching to Docker Dash.

**Closure approach**
Migration 077 adds `teams` and `team_members`; the admin-only `/api/teams` API and **Settings → Access** UI manage memberships. Team grants participate in per-host and host-group permission resolution, and all CRUD writes are audited. Stack permission generalization remains outside this environment-level gap.

**Acceptance criteria**
- [x] Migration 077 creates `teams` + `team_members` with cascading membership cleanup.
- [x] Admin-only team CRUD and membership management are exposed through the API and Settings → Access.
- [x] Host and host-group grants can target a team; membership changes affect resolution immediately.
- [x] Existing per-user access behavior remains backward compatible.
- [x] Service and end-to-end access-enforcement tests cover membership and resolution.

**Notes**
Portainer teams also have "team leaders" — deferred; not core to permission resolution.

---

### G02 — Per-host / environment-level access control

- **Status:** `[x]` Completed
- **Priority:** P0
- **Effort:** M (1 week)
- **Dependencies:** G01 (teams table), otherwise per-user only
- **Impact if unclosed:** Today a non-admin user with access to Docker Dash sees **every** registered host. There is no way to say "developer X can only touch the staging host, not prod". Portainer's environment-level access control is table-stakes for shared installs.

**Closure approach**
Migration 077 adds `host_permissions` for direct host or host-group targets and user or team subjects. `src/middleware/hostAccess.js` resolves `view`, `operate`, and `admin` access and fails closed. Host/resource routes and host selectors filter by effective permission. Administrators manage grants and the upgrade-compatibility default under **Settings → Access**.

**Acceptance criteria**
- [x] Migration 077 creates `host_permissions` with target and subject exclusivity checks.
- [x] Admin can grant `view`, `operate`, or `admin` to users or teams from Settings → Access.
- [x] Non-admin users see only permitted hosts and group memberships.
- [x] Method-aware middleware returns 403 when `operate` is required but the user only has `view`.
- [x] Admin remains global; the explicit `legacy_host_access_default` toggle preserves upgrade behavior until real grants are configured.
- [x] Resolver, middleware, route filtering, group grants, and API behavior have Jest coverage.

**Notes**
Choose the seeding strategy carefully — silent lockout on upgrade is a support nightmare. Seed a `legacy_access_grant` role that admins can opt out of after they configure real permissions.

---

### G03 — Host groups (bulk-apply access + tags)

- **Status:** `[x]` Completed
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** G02
- **Impact if unclosed:** Managing per-host permissions row-by-row when you have 20+ hosts is tedious. Portainer's "Environment Groups" let you say "prod-hosts group has these tags, ops-team has admin on prod-hosts."

**Closure approach**
Migration 073 adds `host_groups` and `host_group_members`; migration 077 adds mutually exclusive `host_group_id` permission targets. Settings → Access provides CRUD, membership, and grants. Hosts show group badges, Multi-host filters by group, and the sidebar uses an ACL-filtered group tree.

**Acceptance criteria**
- [x] Admin can create/edit/delete host groups.
- [x] A host can belong to N groups; group permissions apply to every member host.
- [x] Removing a host from a group removes group-derived access on that host.
- [x] Group reads expose only memberships visible under the caller's host ACL.
- [x] Service and access-enforcement tests cover group-derived resolution and precedence.

**Notes**
Portainer also has "Environment tags" as freeform labels — considered nice-to-have, could ship in the same migration as a `host_tags` table.

---

### G04 — Kubernetes write ops (scale / restart / delete pod / cordon)

- **Status:** `[~]` In progress (deep-spec labeled as alpha.2 target)
- **Priority:** P1
- **Effort:** M (1 week)
- **Dependencies:** none — Sprint 5 alpha.1 shipped read
- **Impact if unclosed:** Kubernetes integration is read-only. A homelab operator watching k3s workloads can see them fail but cannot restart a Deployment or delete a stuck pod without dropping to `kubectl`. This is the main "stopper" that keeps the K8s alpha from beta.

**Closure approach**
Extend `src/services/kubernetes.js` with `scaleDeployment(ns, name, replicas)`, `restartDeployment(ns, name)` (patch spec.template.metadata.annotations `kubectl.kubernetes.io/restartedAt`), `deletePod(ns, name)`, `cordonNode(name)`, `uncordonNode(name)`, `drainNode(name, opts)`. Add matching admin-only routes in `src/routes/kubernetes.js` (POST). Add row-action buttons in `public/js/pages/kubernetes-resources.js` (Scale, Restart, Delete, Cordon). Every op audit-logged via new audit actions `k8s_deployment_scale`, `_restart`, `k8s_pod_delete`, `k8s_node_cordon`, `_drain`.

**Acceptance criteria**
- [ ] Six new write methods on `KubernetesClient` with unit tests (patch body shape, HTTP verb, path).
- [ ] Six new routes at `/api/kubernetes/deployments/:ns/:name/{scale,restart}`, `/pods/:ns/:name`, `/nodes/:name/{cordon,uncordon,drain}` — admin only, audited.
- [ ] UI row-action buttons wired.
- [ ] End-to-end verified against a live k3s (checklist item in `homelab-setup-checklist.md`).
- [ ] Anti-features stay OUT: no YAML editor, no Helm, no exec-into-pod (confirm via smoke test that no such button appears).

**Notes**
See `plans/deep-spec-sprint-5-kubernetes.md`. Cordon/drain complexity: drain needs pod-eviction loop with grace-period respect — implement bounded (30-node cap per request, 5 min timeout).

---

### G05 — Kubernetes pod log streaming

- **Status:** `[ ]` Open
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** G04 (piggybacks on the same alpha.2)
- **Impact if unclosed:** Reading pod logs is the single most common K8s debugging action. Without it, the k8s tab is a shallow status viewer.

**Closure approach**
Add `streamPodLogs(ns, name, container, opts)` to `src/services/kubernetes.js` — returns a stdlib response readable stream from `/api/v1/namespaces/:ns/pods/:name/log?follow=true&container=...`. New WebSocket bridge at `/ws/k8s/pods/logs` (mirror the pattern from the container log WebSocket in `src/websocket/log-stream.js`). Frontend: add a "Logs" tab in the pod detail view of `kubernetes-resources.js`, reuse the existing xterm.js instance.

**Acceptance criteria**
- [ ] `KubernetesClient.streamPodLogs` returns a readable stream with correct headers.
- [ ] WebSocket route pipes to the browser with backpressure handling and 30 s idle-close.
- [ ] UI: click a pod → Logs tab → live tail visible; container dropdown for multi-container pods.
- [ ] 5 tests: cancellation, multi-container, 4xx surface, follow=false one-shot mode.

**Notes**
No pod exec (anti-feature per deep-spec). Log stream is safe read-only.

---

### G06 — Per-container webhook trigger URL (redeploy on POST)

- **Status:** `[ ]` Open
- **Priority:** P1
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** Portainer lets you generate a unique webhook URL per container/service — a CI job POSTs to it and the container pulls the latest image and recreates. Docker Dash today only offers this via **git-stack** webhooks (`src/routes/gitWebhook.js`). Container-level webhooks (image-pull based CD) are a common request from users who use Docker Hub / registry webhooks to trigger deploys.

**Closure approach**
New table `container_webhooks(id, host_id, container_id, container_name, token TEXT UNIQUE, action TEXT CHECK(action IN ('recreate','restart')), created_by, created_at, last_triggered_at)`. Migration `076_container_webhooks.js`. Routes: `POST /api/containers/:id/webhook` (create — admin only, audited), `GET /api/containers/:id/webhook`, `DELETE /api/containers/:id/webhook`, `POST /api/webhook/container/:token` (public, no auth, rate-limited to 10 req/min per token, audited on hit). On trigger: pull image, call the existing recreate path in `containers.js`. UI: add a "Webhook" section to container detail Settings tab with "Generate URL" + copy button.

**Acceptance criteria**
- [ ] Migration 076 + service + routes.
- [ ] Public trigger URL uses a 32-byte random token; unknown tokens 404, not 401 (avoid enumeration).
- [ ] Rate limiter blocks brute-force enumeration.
- [ ] Trigger uses the same recreate path as `/api/containers/:id/update` so behavior is consistent.
- [ ] Audit log entry `container_webhook_trigger` on every hit; `container_webhook_create` / `_delete` on lifecycle.
- [ ] UI shows last-triggered timestamp.

**Notes**
Design decision to record explicitly in the deep-spec: the trigger URL is unauthenticated — because CI systems (GitHub Actions webhook, Docker Hub webhook) cannot easily present a bearer token. The unguessable token IS the auth. Same threat model as Portainer's design.

---

### G07 — Volume file browser (list / upload / download / delete inside a volume)

- **Status:** `[ ]` Open
- **Priority:** P1
- **Effort:** M (1 week)
- **Dependencies:** none
- **Impact if unclosed:** When a volume gets corrupted or you need to inspect config files inside it, today the user has to SSH to the host and `docker run --rm -v vol:/data alpine sh`. Portainer's file browser lets you do this from the UI. Very high user-visible utility.

**Closure approach**
New routes in `src/routes/volumes.js`: `GET /api/volumes/:name/browse?path=...` (list), `GET /api/volumes/:name/download?path=...` (stream), `POST /api/volumes/:name/upload` (multipart, admin only), `DELETE /api/volumes/:name/file?path=...`. Implementation strategy: launch an ephemeral alpine container with the volume mounted read-only (for list/download) or read-write (for upload/delete), execute a small helper script. Path is `_shellEscaped` and constrained to stay under `/data`. Add a "Browse" tab in `public/js/pages/volumes.js` volume detail with a simple two-pane file explorer. All state changes audited.

**Acceptance criteria**
- [ ] Four routes with proper RBAC (browse = operator+, upload/delete = admin).
- [ ] Path traversal blocked (no `..`, must resolve inside `/data`).
- [ ] Upload size limit (100 MB default, configurable via `DD_MAX_UPLOAD_MB`).
- [ ] Ephemeral container is torn down even on error (finally block).
- [ ] UI: breadcrumbs, download button per file, upload button, delete confirm dialog.
- [ ] Audit actions `volume_file_upload`, `_delete`, `_download` (large-file downloads may skip audit — TBD).
- [ ] 10+ tests.

**Notes**
Security review required — this feature exposes arbitrary volume contents to admins. Add a note to `SECURITY.md` "Known tradeoffs" section: any admin can read any file inside any volume via the UI. That is already true (any admin can `docker exec` any container) but making it click-through invites social-engineering review.

---

### G08 — KubeConfig download for the logged-in user

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** XS (< 1 day)
- **Dependencies:** G01, G02 (needs teams + per-host access to be meaningful)
- **Impact if unclosed:** A K8s user has to configure their local `kubectl` separately from Docker Dash. Portainer generates a scoped kubeconfig that a user can download and drop in `~/.kube/config`. Low effort, medium delight.

**Closure approach**
Route `GET /api/kubernetes/kubeconfig?hostId=X` — reads the host row, extracts endpoint + CA cert + token from `daemon_config`, emits a valid kubeconfig YAML with a single-cluster + single-context. Frontend: "Download kubeconfig" button on `kubernetes-resources.js` info card.

**Acceptance criteria**
- [ ] Route emits valid YAML consumable by `kubectl`.
- [ ] The token embedded is the same token stored in `daemon_config` (not a new short-lived one) — document the sharing implication in a warning banner.
- [ ] Only users with `admin` or `operate` access on the target host can download (post-G02).
- [ ] Audit action `kubeconfig_download`.

**Notes**
No token exchange for now — the admin's k8s token is a shared secret already at the docker-dash tier. Scoped SA tokens are a future enhancement.

---

### G09 — Real-time Docker events stream on the UI

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** S (1-3 days)
- **Dependencies:** none
- **Impact if unclosed:** The current Timeline page shows **audit log** events. It does not show live Docker daemon events (container die, image pull, network create) as they happen. Portainer has a live event stream — good for debugging "why did my container just restart?"

**Closure approach**
`src/services/docker.js` already has `getEvents()` (line 794). Wire it into a WebSocket at `/ws/docker/events?hostId=X`, JSON-line stream. Add a "Live events" tab or right-side drawer on the Timeline page (`timeline.js`) with pause/resume + filter.

**Acceptance criteria**
- [ ] `/ws/docker/events` streams events, closes on hostId change or client disconnect.
- [ ] Filter dropdown (event type: container/image/network/volume).
- [ ] Timeline page renders the last 100 events in memory with auto-scroll.
- [ ] Optional persistence: store the last 24 h of events in a bounded ring buffer (SQLite table `docker_events_recent`, capped at 10 000 rows).

**Notes**
Portainer stores every event forever by default and it bloats the DB. Cap ours from day one.

---

### G10 — Proxmox noVNC / SPICE console iframe

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** M (1 week)
- **Dependencies:** none — Sprint 4 shipped read-only
- **Impact if unclosed:** For homelab Proxmox users, the "no console" gap forces them to switch to the Proxmox UI to touch a VM. Portainer doesn't do this either — but Proxmox users expect it because it's in the native Proxmox UI.

**Closure approach**
Reuse the existing Proxmox WebSocket ticket API: `POST /api2/json/nodes/:node/qemu/:vmid/vncproxy`, then embed noVNC (self-hosted; the library is small and MIT). New route `POST /api/proxmox/vms/:node/:vmid/console-ticket` — admin only, audited. Frontend: new modal in `proxmox-resources.js` with an `<iframe>` (or inline noVNC canvas). Bundle noVNC into `public/vendor/novnc/`.

**Acceptance criteria**
- [ ] Ticket endpoint returns short-lived (30 s) ticket + port.
- [ ] noVNC client connects; keyboard/mouse works.
- [ ] Session audited (`proxmox_console_open`).
- [ ] No bytes flow through docker-dash — the browser connects directly to Proxmox's WS (so the ticket must be exposed).
- [ ] Fallback: SPICE not supported in the first cut (documented as anti-feature for now).

**Notes**
This is the deferred alpha.2 item mentioned in v8.9.1-alpha.1's caveats. Worth its own deep-spec because "browser connects directly" changes the network topology assumption.

---

### G11 — Custom RBAC roles (beyond fixed admin/operator/viewer)

- **Status:** `[ ]` Open
- **Priority:** P2
- **Effort:** M (1 week)
- **Dependencies:** G01, G02 (teams + per-host)
- **Impact if unclosed:** Docker Dash has 3 fixed roles. Portainer Business supports custom roles like "container-viewer-only" or "stack-editor-no-secrets". Nice-to-have but real for larger shops.

**Closure approach**
New table `roles(id, name, description, permissions_json)` with a seed of the 3 built-in roles (immutable, `is_builtin=1`). Table `user_roles(user_id, role_id)` and `team_roles(team_id, role_id)`. Middleware `requireCapability(cap)` replaces the `requireRole('admin')` calls one-by-one — capability strings like `containers:write`, `stacks:delete`, `secrets:read`. New Settings page tab "Roles" with a permission-picker matrix.

**Acceptance criteria**
- [ ] Migration adds `roles` + `user_roles` + `team_roles` and seeds the 3 built-ins.
- [ ] Every existing `requireRole('admin')` call auto-maps to `requireCapability('*:admin')` for compat.
- [ ] Admin can create/edit custom roles.
- [ ] A new "read-only-except-restart" role can be created and assigned; test end-to-end.
- [ ] Documentation: capability matrix table checked into `docs/rbac-capabilities.md`.

**Notes**
This is the biggest RBAC refactor — do it AFTER G01+G02 land or you'll rewrite it twice.

---

### G12 — Edge Agent (async polling from behind NAT, scale to thousands)

- **Status:** `[-]` Won't-do
- **Priority:** P3
- **Effort:** XL (1+ month)
- **Dependencies:** would fight architecture invariants
- **Impact if unclosed:** Portainer Edge supports thousands of remote agents polling asynchronously through NAT. Docker Dash uses SSH tunnels or direct-TLS to reach hosts — perfectly fine for 1-50 hosts, but does not scale to a retail/IoT fleet of thousands.

**Closure approach**
N/A — see rationale.

**Acceptance criteria**
N/A

**Notes — WHY NOT**
1. Architecture invariant #1 (no build step) + #3 (CommonJS backend) do not preclude an agent binary, but shipping + versioning a **separate agent** contradicts the "single binary, one install target" DNA.
2. The comparison doc already acknowledges: "if you manage hundreds or thousands of Edge agents with NAT traversal — pick Portainer." Docker Dash is honest about its positioning as "one to a handful of Docker hosts."
3. The existing SSH-tunnel model (`src/services/ssh-tunnel.js`) covers 95% of "one host behind NAT" cases with `autossh`-style reverse tunnels documented in the howtos.
4. If ever revisited, gate behind a separate optional `docker-dash-agent` repository + a first-class opt-in "Edge Mode" — not a change to the main binary.

---

### G13 — Kubernetes Ingress / NetworkPolicy read view

- **Status:** `[ ]` Open
- **Priority:** P3
- **Effort:** S (1-3 days)
- **Dependencies:** G04 (piggybacks on same sprint)
- **Impact if unclosed:** Ingress + NetworkPolicy are missing from the K8s tab. Deep-spec lists **editing** them as anti-features, but read-only viewing is fine.

**Closure approach**
Extend `KubernetesClient` with `listIngresses(ns?)` and `listNetworkPolicies(ns?)`. Add two more tabs in `kubernetes-resources.js`. Read-only — no create/edit buttons. Aligns with existing anti-feature "no Ingress / RBAC / NetworkPolicy editor" (that stays true; viewing ≠ editing).

**Acceptance criteria**
- [ ] Two new list methods with unit tests.
- [ ] Two new tabs in the UI (Ingress + NetworkPolicy) showing name / namespace / rules summary.
- [ ] No mutation buttons anywhere on those tabs (confirm via test).

**Notes**
Small, low-risk, high UX-value follow-up to Sprint 5.

---

## Suggested execution order

1. **G01 — Teams** (P0, L). Foundation for every RBAC gap that follows.
2. **G02 — Per-host access control** (P0, M). Depends on G01; unlocks multi-tenant installs.
3. **G03 — Host groups** (P1, S). Tiny addition on top of G02.
4. **G06 — Container webhook** (P1, S). Independent; high user-visible value; ship in parallel with team above.
5. **G04 — K8s write ops** (P1, M). Already scoped as alpha.2 — do this next after RBAC lands.
6. **G05 — K8s pod logs** (P1, S). Piggyback on G04's sprint.
7. **G13 — K8s Ingress/NetworkPolicy read** (P3, S). Same sprint as G04+G05 — cheap add.
8. **G08 — KubeConfig download** (P2, XS). Trivial — do it while you're in the K8s file anyway.
9. **G07 — Volume browser** (P1, M). Independent; can parallelise with G04 sprint if a second developer.
10. **G09 — Live Docker events** (P2, S). Independent, low-risk polish.
11. **G10 — Proxmox noVNC console** (P2, M). Own deep-spec; ship as Sprint 4 alpha.2.
12. **G11 — Custom RBAC roles** (P2, M). Do LAST — after G01+G02 have shaken out.

**Total wall-clock** (single dev, no parallelism): ~10-12 weeks. With two devs parallelising the K8s and Volume-browser tracks: ~7-8 weeks. Add 2 weeks for verification against live daemons (homelab checklist run).

## Won't-do (explicitly out of scope)

| Item | Why not |
|---|---|
| **Edge Agent at scale (G12)** | Fights the single-binary architecture; SSH tunnels already cover small-fleet NAT cases; positioning doc says "pick Portainer for thousands of edge agents". |
| **Helm install / upgrade** | Anti-feature per `plans/deep-spec-sprint-5-kubernetes.md`. Docker Dash is a k3s **viewer**, not a **replacement for Helm**. Users needing Helm should use Lens or `helm` CLI. |
| **Kubernetes YAML editor** | Anti-feature per deep-spec. Editing YAML in-browser is the fastest path to cluster damage; users should use `kubectl apply`. |
| **Kubectl-in-browser terminal** | Anti-feature per deep-spec. Security nightmare in a web app (session hijacking = full cluster admin). |
| **Kubernetes Secret / ConfigMap viewer** | Anti-feature per deep-spec. Accidental disclosure risk outweighs utility; use `kubectl get secret`. |
| **CRD viewer** | Anti-feature per deep-spec. Scope creep. |
| **Angular / React / Vue rewrite** | Architecture invariant #2 (no frontend framework). Not a gap — a deliberate design choice. |
| **Build step / bundler** | Architecture invariant #1. Same. |
| **Kubernetes exec-into-pod** | Anti-feature per Sprint 5 deep-spec. Same rationale as kubectl-in-browser. |
| **Paid support / SLA** | Business decision, not code. Community-supported MIT is the positioning. |

## Cross-references

- [Docker Dash vs Portainer comparison](vs-portainer.md)
- [CHANGELOG](../../CHANGELOG.md)
- [SECURITY](../../SECURITY.md) — "Known Security Tradeoffs" section
- Deep-specs (gitignored, referenced by name):
  - `plans/deep-spec-sprint-5-kubernetes.md` (K8s anti-features + roadmap)
  - `plans/deep-spec-sprint-4-proxmox.md` (Proxmox positioning + noVNC deferral)
  - `plans/deep-spec-sprint-3-incus.md` (multi-daemon architecture)
- RBAC middleware: [src/middleware/auth.js](../../src/middleware/auth.js)
- Permissions service: [src/services/permissions.js](../../src/services/permissions.js)
- Stack-permission model (extend for teams/hosts): [src/db/migrations/036_stack_permissions.js](../../src/db/migrations/036_stack_permissions.js)
