# Product research: high-leverage extensions beyond the current gap lists

**Research date:** 2026-07-26  
**Scope:** Docker/Compose fleet operations, GitOps, deployment safety, developer workflows, and operational guardrails.  
**Method:** compare current Docker Dash capabilities with current official Docker Compose, Komodo, Portainer, and Coolify documentation, then remove ideas that merely duplicate shipped features.

## Executive recommendation

All eight recommendations in the focused implementation sequence are now delivered: Compose Deployment Plan; progressive Git-stack rollout; staged parallel procedures; declarative fleet export/plan/apply; pull-request previews; pinned OCI Compose artifacts; disk-pressure automation; and optional managed Git write-back.

The completed developer-platform and operations sequence is:

1. **Pull-request preview stacks with TTL cleanup and isolated secrets.** — Done
2. **OCI-published Compose artifacts with pinned digests.** — Done
3. **Disk-pressure automation with protected resources.** — Done
4. **Optional managed Git write-back for declarative fleet documents.** — Done

The completed sequence compounds existing work: deployment planning makes one target safer; rollout waves make many targets safer; procedure stages provide the reusable execution engine; declarative sync then becomes a controlled desired-state layer rather than another deploy path.

## Evidence from adjacent products

- Docker Compose exposes global `--dry-run`, machine-readable `--progress json`, bounded `--parallel`, profiles, Git-based Compose inputs, OCI-published Compose artifacts, `compose publish`, Watch, and Bridge. The dry-run output includes the ordered pulls, builds, network/container creation, health waits, and starts that a real command would perform. See [Docker Compose CLI reference](https://docs.docker.com/reference/cli/docker/compose/).
- Komodo Resource Sync diffs declarative resources against live state, alerts on pending changes, requires manual confirmation unless a webhook is configured, supports tag-scoped syncs, and can commit UI edits back to Git in managed mode. Its declarations also support cross-resource `after` dependencies and procedure stages containing multiple executions. See [Komodo Sync Resources](https://komo.do/docs/automate/sync-resources).
- Portainer Edge Stack updates can run in fixed-size or exponential waves, insert delays, enforce timeouts, and choose continue, pause, or rollback after a failed wave. Git deployments also support relative-path content and per-device GitOps configuration. See [Portainer Edge Stack update configurations](https://docs.portainer.io/user/edge/stacks/add) and [relative-path support](https://docs.portainer.io/advanced/relative-paths).
- Coolify creates isolated pull-request deployments with dedicated URLs and preview-only environment variables, then removes them when the PR closes. It also exposes an administrator-controlled terminal kill switch and scheduled database backups to S3-compatible storage. See [Coolify preview deployments](https://coolify.io/docs/applications/ci-cd/github/preview-deploy), [terminal access control](https://coolify.io/docs/knowledge-base/server/terminal-access), and [database backups](https://coolify.io/docs/databases/backups).

## Prioritized opportunity map

| Priority | Opportunity | Why it fits Docker Dash now | First useful slice | Effort | Main risk |
|---|---|---|---|---:|---|
| Done | Compose Deployment Plan | Reuses the new streamed Compose runner and stack UI; improves safety without new state | `POST /compose/:stack/:action/plan`, normalized plan output, confirmation modal, audit | S–M | Older Compose versions return an explicit 501; the UI requires a separate unplanned-run confirmation |
| Done | Progressive fleet rollout | Multi-host Git targets, host groups, health history, rollback, and procedures now exist | Fixed/exponential waves, delay, per-target health gate, pause/continue/rollback policy | M | Target-scoped rollback is persisted and audited |
| Done | Parallel procedure stages + dependency graph | Independent pulls/checks no longer block one another | Stage model with bounded concurrency, dependency validation, persisted per-step status | M | Already-started external operations remain cooperatively cancellable |
| Done | Declarative resource sync | Closes Komodo G07 and makes fleet config reviewable/reproducible | Export, schema/reference validation, semantic plan, hash-bound manual apply | M–L | Managed Git write-back remains a follow-up |
| Done | PR preview stacks | Git/webhook/deployment primitives already exist; large developer-experience gain | GitHub PR webhook, generated project name, isolated env set, URL metadata, close/TTL cleanup | L | Forks default off; enabled forks never receive base-repository credentials |
| Done | OCI Compose artifacts | Native Compose can publish and consume versioned `oci://` definitions | Import pinned digest, show provenance, deploy with local override, optional signature policy | M | Digest-bound dry-run and explicit annotation/cosign trust modes |
| Done | Disk-pressure automation | Docker Dash already reports storage and offers cleanup actions | Threshold policy, dry-run candidate list, minimum age, protected labels, audit, no volume deletion | M | Disabled + dry-run defaults, exact candidates, cooldown, protected labels |
| P2 | Emergency terminal lock | Existing container terminals benefit from a central incident control | Global and per-host deny flag; admins included; terminate active WS exec sessions; audit | S | Lockout recovery needs environment/config override |
| P3 | Curated Compose blueprint catalog | Existing sample/plugin and onboarding catalogs are not an application marketplace | Signed curated index, pinned images, healthchecks, backup hints, variables wizard | M–L | Template supply-chain ownership and update policy |
| P3 | Signed extension API | A sample plugin exists, but a stable trust and compatibility model would unlock integrations | Read-only UI panels first; manifest/API version; signatures; explicit capabilities | L | Long-term API compatibility and privileged plugin code |

## Concrete designs

### 1. Compose Deployment Plan

The API accepts only the existing allowlisted actions (`up`, `down`, `restart`, `pull`). It resolves the same working directory and remote Docker CLI environment as execution, then runs:

```text
docker compose --ansi never --progress json --dry-run <action arguments>
```

The server captures bounded raw progress and also normalizes recognized JSON records into a small stable model:

```json
{
  "kind": "container|network|volume|image|build|health|unknown",
  "operation": "create|remove|pull|build|start|restart|wait|noop|unknown",
  "resource": "demo-web-1",
  "status": "planned|warning",
  "raw": "bounded original record"
}
```

Compatibility behavior matters: detect support once per host, cache it briefly, and return `501 compose_dry_run_unsupported` instead of silently executing or pretending the plan is complete. The UI can fall back to the current confirmation dialog, clearly labelled “plan unavailable”. Plans are short-lived observations, not durable deployment promises; save only a bounded audit summary and hash of the plan.

### 2. Progressive fleet rollout

Extend a multi-host Git deployment with a rollout policy:

```json
{
  "strategy": "fixed|exponential",
  "initialWave": 1,
  "multiplier": 2,
  "maxParallel": 3,
  "delaySeconds": 30,
  "healthTimeoutSeconds": 120,
  "onFailure": "pause|continue|rollback"
}
```

After each wave, require all targets to be running and, when configured by the image, satisfy Docker health. Persist the target commit before mutation. On rollback, revert only targets attempted by the current run, in reverse wave order. The UI should make partial state explicit: `3 updated / 1 failed / 6 untouched / 3 rolled back`.

### 3. Procedure stages and dependencies

Keep serial execution as the default. A procedure becomes an ordered list of stages; enabled steps inside a stage may run concurrently with a per-procedure cap. Add optional `needs` edges only within or across prior stages, reject cycles at save time, and retain the current `stop|continue` behavior at stage level. This is enough for fan-out checks and pulls without turning the product into a generic workflow language.

### 4. Declarative resource sync

Start with export/import and manual approval, not a permanent reconciler:

1. Export a versioned document containing hosts (without credentials), host groups, Git stacks/targets, procedures, and notification references.
2. Validate schema and references before touching the database.
3. Compute a semantic diff with `create`, `update`, `delete`, `blocked`, and `unchanged` actions.
4. Require a second explicit apply request carrying the diff hash; reject stale plans.
5. Keep deletion disabled unless the document opts into authoritative ownership.

Secrets should be symbolic references only. A later managed mode may open or commit a Git change, but the database remains authoritative until ownership and conflict semantics are proven.

### 5. Preview stacks

Treat every preview as hostile by default: separate environment-variable set, no production secrets, restricted host/group allowlist, resource caps, generated Compose project name, unique hostname, and mandatory expiry. Webhook signatures and repository membership checks must fail closed. Closing or merging the PR triggers cleanup; a periodic reaper handles missed webhooks.

### 6. OCI Compose artifacts

Implemented with Compose 2.34+ capability enforcement, registry tag-to-digest resolution, digest-only runtime references, mandatory dry-run planning, guarded local overrides, and distinct annotation-detection versus cryptographic cosign policies.

### 7. Disk-pressure automation

Implemented as per-host opt-in policies with dry-run defaults, age thresholds, exact candidate IDs, protected-label handling, no volume deletion, cooldowns, leader-only scheduling, audit, and run history. Remote hosts use an explicit Docker-byte ceiling when filesystem capacity is unavailable through the Engine API.

### 8. Managed Git write-back

Implemented as deterministic, secret-free fleet export into an existing Git-stack checkout. Review hashes bind the document and both Git heads; apply is non-force, rejects remote conflicts, and can optionally run after successful declarative apply.

## Ideas deliberately not prioritized

- **Generic AI chat:** Docker Dash already has Ops Copilot. A future AI addition should be narrowly grounded in incident timelines or propose a reviewed procedure; it must not execute mutations from free-form text.
- **Another rollback button:** Git-stack and remediation rollback already exist. The missing value is wave-aware rollback with precise partial-state accounting.
- **Another backup upload screen:** Docker Dash already has dashboard backup-to-S3 support. The valuable extension is workload/database backup policies and verified restore drills, not a duplicate destination form.
- **Unrestricted host shell:** container exec already exists and the Kubernetes comparison explicitly rejects broad browser-admin terminals. The useful borrowing from Coolify is the emergency deny switch, not more shell privilege.
- **A large plugin marketplace immediately:** ship a small, versioned, read-only extension boundary before allowing privileged third-party code.
- **Compose Watch as a production feature:** useful for developer workstations, but remote file watching and rebuild loops conflict with the product's operations-first scope. Revisit only as an explicitly non-production mode.

## Suggested delivery order

### Release A — safer Compose operations

- Compose Deployment Plan with capability detection and bounded output.
- Literal/capped multi-container log search and split-frame-safe WebSocket decoding (already implemented during this research pass).
- Emergency terminal lock if a small security slice is desired.

### Release B — safe fleet changes

- [x] Fixed and exponential rollout waves.
- [x] Health gates and pause/continue policies.
- [x] Automatic rollback for targets changed by the current run.

### Release C — reusable orchestration

- [x] Parallel procedure stages and dependency validation.
- [x] Declarative export/plan/apply with diff hash and manual approval.

### Release D — developer platform

- [x] Preview stacks with isolated secrets and TTL cleanup.
- [x] OCI Compose artifacts pinned by digest and optional signature enforcement.

### Release E — operational autonomy

- [x] Disk-pressure automation with protected resources and no volume deletion.
- [x] Managed GitOps write-back with conflict detection and non-force commits.

## Success measures

- Percentage of Compose mutations previewed before execution.
- Fleet deployment failure containment: median targets changed before an unhealthy rollout pauses.
- Median time to recover a partial fleet deployment.
- Procedure elapsed time reduction after safe parallel stages.
- Declarative sync plans applied without manual correction and stale-plan rejection rate.
- Preview environments automatically removed within their TTL and zero production-secret exposure incidents.
