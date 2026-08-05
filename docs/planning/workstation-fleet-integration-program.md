# Workstation fleet integration program

**Started:** 2026-08-05  
**Baseline:** v8.91.4 / `agent/advanced-compose-gitops`  
**Release:** v8.92.0  
**Research input:** EU OS bootc, Foreman/Katello and FreeIPA operating model  
**Product boundary:** Docker Dash remains an infrastructure control plane. It does not build a desktop distribution, manage end-user files, or replace Foreman/FreeIPA.

## Outcome

Deliver the generally useful parts of the EU OS operating model without coupling Docker Dash to one distribution:

1. bootc-aware OCI artifact intelligence;
2. cryptographic trust and SBOM evidence;
3. canary/stable/held artifact channels;
4. Foreman/Katello read-only inventory sync;
5. workstation security and lifecycle posture;
6. site/group mapping into the existing Edge model;
7. guarded bootc update and rollback workflows.

EU OS remains an optional compatibility profile and source of test fixtures. Demo images must be digest-pinned and must not be represented as production-certified or as an official European Union product.

## Delivery register

| ID | Capability | Value | Mutation boundary | Status | Evidence |
|---|---|---:|---|---|---|
| WF-001 | Bootable OCI/bootc detection | High | read-only | Done | OCI index/config inspection and negative admission tests |
| WF-002 | OCI provenance, SBOM references and Cosign trust result | High | local verification only | Done | Bounded provenance, signer policy/hash and referrer tests |
| WF-003 | Artifact channels and promotion history | High | local control plane | Done | Canary-before-stable plus automatic fail-closed demotion tests |
| WF-004 | Foreman connection profiles | High | encrypted credentials; HTTPS only | Done | URL, encryption, secret-absence and TLS tests |
| WF-005 | Foreman/Katello inventory synchronization | High | read-only external calls | Done | Bounded pagination/facts, optional Katello and sync tests |
| WF-006 | Workstation inventory and search/filter UI | High | read-only | Done | Combined search, site, group, health, posture, drift and channel page test |
| WF-007 | Workstation security/lifecycle posture | High | evidence evaluation | Done | Seven-state posture evaluation with unknown handling |
| WF-008 | Foreman location/host-group to Edge Site mapping | Medium | local metadata | Done | Immediate remap/delete and evidence invalidation tests |
| WF-009 | bootc drift assessment | High | read-only | Done | Stable/canary/unapproved digest posture contract |
| WF-010 | Canary/stable update plan and apply | High | default-off external mutation | Implemented, gated | Fixture-complete; production Foreman canary remains external |
| WF-011 | bootc rollback plan and apply | High | default-off external mutation | Implemented, gated | Same immutable digest workflow and external qualification boundary |
| WF-012 | Audit, idempotency, plan hash and post-read verification | High | fail-closed | Done | Route audits, plan/artifact/device hashes and exact digest post-read tests |
| WF-013 | API/UI/i18n/accessibility coverage | High | local | Done | 11 locale nav labels, page/API/route contracts, no inline handlers |
| WF-014 | Markdown runbook and rollout record | High | documentation | Done | This register and `docs/features/workstation-fleet.md` |
| WF-015 | Deterministic execution preflight and bounded running state | High | read-only preflight; local timeout | Done | Blocker matrix, trace inputs and no-network timeout tests |
| WF-016 | Foreman contract and operator lifecycle closure | High | read-only contract check; local cancellation | Done | Required static targeting, exact input validation, visible promotion history and pre-submit cancellation tests |

## Explicit non-goals

- building or redistributing EU OS images;
- KDE or desktop application management;
- user-file synchronization, Nextcloud or endpoint backup execution;
- Windows application compatibility;
- replacing Foreman, Katello, FreeIPA, Active Directory or an OCI registry;
- silently executing remote jobs when a feature flag, approval, current plan or verification evidence is missing.

## Safety contract

- Foreman profiles accept HTTPS endpoints only. TLS verification is on by default.
- Passwords/tokens are encrypted at rest and never returned by API responses or audit records.
- Sync is read-only and bounded by page/item/time limits.
- Artifact identity is digest-based; mutable tags are never sufficient for apply.
- Signature presence and cryptographic verification are distinct states.
- SBOM data is bounded and stored as normalized evidence or immutable references, never as an unbounded registry payload.
- Promotion changes only Docker Dash policy state. It does not mutate a registry or Foreman.
- Remote update/rollback requires an independent default-off flag, current plan hash, idempotency key, approved channel, maintenance window evidence and post-read verification.
- Unknown Foreman capabilities, task loss, authentication expiry or partial responses fail closed.

## Acceptance criteria

### Read-only foundation

- [x] A bootc artifact can be registered only with a valid `sha256:` digest.
- [x] OCI annotations/config identify bootc without treating ordinary application images as bootable.
- [x] Provenance includes base image, source, revision, version, OS/architecture and SBOM references.
- [x] Cosign verification records the exact digest, signer policy and output hash.
- [x] Foreman sync normalizes organizations, locations, host groups, hosts, content views and lifecycle environments.
- [x] Sync never stores raw credentials or unbounded upstream responses.
- [x] Workstations are searchable and filterable by site, group, channel, health, drift and compliance.
- [x] Posture distinguishes pass, fail and unknown for Secure Boot, TPM, disk encryption, SELinux, patch age, image drift and identity enrollment.

### Guarded operations

- [x] Update and rollback plans are immutable, digest-bound and idempotent.
- [x] `held` blocks apply; `canary` and `stable` require exact channel policy.
- [x] Apply is unavailable unless `DD_WORKSTATION_FOREMAN_MUTATIONS=true`.
- [x] Apply accepts only allowlisted Foreman remote-job templates.
- [x] Post-read must observe the target/rollback digest before success is recorded.
- [x] Secrets, bearer tokens and remote job output are absent from audit details.
- [x] Preflight exposes every deterministic apply blocker without starting an upstream call.
- [x] Foreman receives plan, approval and maintenance-window trace references.
- [x] A running workflow terminates locally after the configured timeout instead of remaining indefinite.
- [x] Concurrent execute requests are serialized by an atomic local claim and dispatch at most one Foreman job.
- [x] Unsubmitted plans can be cancelled locally with a bounded reason; running jobs cannot be falsely represented as cancelled.
- [x] Foreman profiles cannot be deleted while sync or planned/running workflow state depends on them.
- [x] A synchronized profile cannot be repointed to another Foreman endpoint, and reconciliation requires verified TLS.
- [x] Artifact channel transitions and their evidence hashes are available to administrators through the UI/API.

### Verification

- [x] Migration up/down and idempotency tests.
- [x] Unit tests for artifact, Foreman transport, sync, posture and workflow services.
- [x] Route authorization and audit tests.
- [x] Page contract, search/filter and accessibility checks.
- [x] Focused regression, full Jest, ESLint, syntax, i18n/a11y and whitespace checks.

## Execution journal

| Date | Workflow | Status | Evidence / decision |
|---|---|---|---|
| 2026-08-05 | Scope and architecture | Done | Generic bootc + Foreman integration selected; EU OS branding and endpoint file management rejected as core scope. |
| 2026-08-05 | Repository audit | Done | Existing Registry, OCI Compose Cosign, Edge, Governance, Identity and Operation Core foundations will be reused. No workspace `AGENTS.md` is present. |
| 2026-08-05 | OCI artifact and release policy | Done | Digest pinning, bootc evidence, SBOM/referrers, bounded provenance, reusable Cosign trust and held/canary/stable policy implemented. |
| 2026-08-05 | Foreman/Katello connector | Done | Encrypted HTTPS profiles, bounded pagination, optional Katello, bounded facts enrichment and read-only sync implemented. |
| 2026-08-05 | Workstation inventory | Done | Posture, drift, combined filters and immediate Foreman-to-Edge mapping lifecycle implemented. |
| 2026-08-05 | Guarded lifecycle | Done locally | Default-off update/rollback plan, template allowlist, fresh evidence, verified TLS, typed confirmation and exact digest post-read implemented. |
| 2026-08-05 | Focused validation | Passed | 11 suites / 107 tests; ESLint 0 errors; i18n, accessibility and research gates passed. |
| 2026-08-05 | Full validation | Passed | 320 suites; 3,398 passed; 4 skipped; 0 failed. Full migration chain included `171_workstation_fleet.js`. |
| 2026-08-05 | Operational closure | Done | Added zero-network preflight, connection/host checks, trace inputs and bounded remote-job timeout. |
| 2026-08-05 | API/lifecycle closure | Done | Aligned Foreman submission with required static targeting and template inputs; added atomic submit claim, bounded paginated promotion history and local pre-submit cancellation. |
| 2026-08-05 | Final repository gates | Passed | Full Jest, ESLint (0 errors), 11-language i18n, accessibility, 450-feature research registry and whitespace checks passed. |
| 2026-08-05 | Isolated startup smoke | Passed | Temporary database applied the full migration chain including `171_workstation_fleet.js`; the server reached ready state on loopback and temporary data was removed. |
| 2026-08-05 | GitHub publication | Passed | Feature `3d077a2`, release `6b243df`, tag/release v8.92.0 and draft PR #13 published; CI plus PR/tag Docker workflows passed. |
| 2026-08-05 | Docker rollout | Passed | LAN and VPS healthy on v8.92.0 with verified SQLite backups, migration 171 once, 0 restarts and v8.91.4 rollback retained. |
| 2026-08-05 | External HTTP/UI smoke | Passed | Health, root and Workstation Fleet asset passed on both targets; unauthenticated administrator API returned 401. |
| 2026-08-05 | Interactive browser smoke | External | Browser skill initialized, but the runtime exposed zero browser backends; no unrelated browser mechanism was substituted. |

## Local closure statement

All repository changes and locally testable acceptance criteria in this program are complete. Remote mutation remains deliberately disabled by default. A real Foreman/Katello, registry trust root and disposable workstation are qualification dependencies, not missing repository implementations. No production enablement is claimed until the checklist in `docs/features/workstation-fleet.md` is executed against approved infrastructure.

The full Jest command exited successfully but retained the repository's existing Redis mock teardown/open-handle warnings after completion. They did not fail a suite and are outside this feature's execution path.

## External qualification still required after local completion

Local implementation cannot truthfully close the following without infrastructure supplied or approved outside the repository:

- a real Foreman/Katello endpoint and least-privilege read credential;
- a disposable workstation or VM enrolled in Foreman for update/rollback canary;
- an approved remote-job template identifier and maintenance window;
- a registry image signed by the deployment's actual trust root;
- browser runtime for recorded interactive smoke if the integrated browser is unavailable.

These prerequisites do not block fixture-complete implementation. They block only promotion from locally verified/default-off to production-enabled.
