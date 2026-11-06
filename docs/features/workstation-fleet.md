# Workstation fleet: bootc, OCI trust and Foreman/Katello

Docker Dash can inventory Linux workstations from Foreman/Katello, evaluate their security and image posture, and manage a local release policy for digest-pinned bootc OCI images. An independently gated workflow can submit an allowlisted Foreman remote job for update or rollback and records success only after a post-read observes the exact target digest.

This is a generic integration. It is not tied to EU OS, does not build or redistribute an operating system, and does not replace Foreman, Katello, FreeIPA or an OCI registry.

## What is implemented

- HTTPS Foreman connection profiles with encrypted token/password storage and optional custom CA;
- bounded, read-only Foreman/Katello inventory synchronization;
- bounded host-fact enrichment for Secure Boot, TPM, disk encryption, SELinux, identity enrollment, patch age and bootc digest;
- Foreman location or host-group mapping to an existing Docker Dash Edge Site and scope reference;
- bootc detection from OCI config labels and annotations;
- digest pinning, multi-platform index resolution, SBOM/referrer discovery and bounded provenance;
- `held`, `canary` and `stable` local artifact channels with bounded, visible promotion evidence history;
- cryptographic Cosign verification reuse from OCI Compose;
- searchable workstation inventory with site, group, health, posture, drift and channel filters;
- immutable, idempotent, 15-minute update/rollback plans;
- explicit local cancellation for plans that have not been submitted to Foreman;
- default-off remote execution, exact template allowlist, typed confirmation, current evidence checks and post-read verification;
- administrator-only API/UI and sanitized audit events.

## Safety model

Inventory synchronization makes only `GET` requests. Artifact inspection reads registry manifests, config blobs and referrers; promotions change only local Docker Dash policy. Neither operation changes Foreman or the registry.

Deleting a Foreman profile cascades its synchronized inventory, sync history and terminal workflow records. Docker Dash blocks deletion while a synchronization or a `planned`/`running` workflow exists, and the UI requires an explicit destructive confirmation.

The normalized Foreman base URL becomes immutable after the first inventory or sync record exists. This prevents stale numeric host IDs from being replayed against a different Foreman endpoint; configure a new profile when the endpoint identity changes. Credential and trusted-CA rotation remain available. Reconciliation, like execution, requires the profile to be enabled with TLS verification on.

Remote execution is unavailable unless every condition below is true:

1. `DD_WORKSTATION_FOREMAN_MUTATIONS=true`;
2. the requested Foreman job template is in `DD_WORKSTATION_FOREMAN_JOB_TEMPLATES`;
3. the Foreman connection is enabled, its host identity is numeric and TLS verification is enabled;
4. the workstation is online and its normalized evidence is fresh;
5. the target artifact is bootc-compatible, cryptographically verified and still in its plan-bound `canary` or `stable` channel;
6. device source hash, artifact verification hash, plan hash and idempotency key remain current;
7. maintenance-window and approval references are present;
8. the administrator types the exact workstation name.

A completed Foreman task is not sufficient for success. Docker Dash reads the host again and records `succeeded` only when the reported bootc digest equals the plan target. Missing facts, a different digest or changed evidence fail closed. Raw remote-job output is not persisted.

Execution atomically claims a planned workflow before submission. Concurrent or repeated execute requests observe the same running plan and cannot dispatch a second job. If the process stops between the claim and saving Foreman's task identity, reconciliation reports `submissionPending` without retrying; after the bounded timeout it records `FOREMAN_JOB_SUBMISSION_TIMEOUT` and requires an operator to inspect Foreman before creating another plan.

If a previously promoted artifact is re-inspected without valid cryptographic trust, it is automatically demoted to `held` and its prior plans can no longer execute.

## Configuration

```dotenv
# Read-only control plane and UI
DD_WORKSTATION_FLEET=true

# Foreman read limits
DD_WORKSTATION_FOREMAN_TIMEOUT_MS=30000
DD_WORKSTATION_FOREMAN_MAX_PAGES=20
DD_WORKSTATION_FOREMAN_MAX_ITEMS=2000
DD_WORKSTATION_FOREMAN_MAX_FACT_HOSTS=500
DD_WORKSTATION_FOREMAN_FACT_CONCURRENCY=5
DD_WORKSTATION_EVIDENCE_MAX_AGE_HOURS=24
DD_WORKSTATION_FOREMAN_JOB_TIMEOUT_MINUTES=120

# Keep disabled until the production canary is approved
DD_WORKSTATION_FOREMAN_MUTATIONS=false
DD_WORKSTATION_FOREMAN_JOB_TEMPLATES=101,102
```

The feature flag defaults on, but remote mutation defaults off and the template allowlist defaults empty. Global `READ_ONLY_MODE=true` and the global provider-operation gate continue to block writes.

## Foreman credential and facts

Use a dedicated least-privilege Foreman account. Read-only rollout needs access to:

- `/api/status`;
- `/api/organizations`, `/api/locations`, `/api/hostgroups` and `/api/hosts`;
- `/api/hosts/:id/facts` when workstation facts are available;
- `/api/job_templates/:id` for fail-closed input-contract validation before execution;
- `/katello/api/content_views` and `/katello/api/environments` when Katello is installed.

Katello endpoints and per-host facts are optional for inventory. Missing access produces partial/unknown evidence rather than invented compliance. Docker Dash stores only selected normalized facts, not the raw fact set.

The collector recognizes these representative keys, including their documented aliases:

| Evidence | Preferred fact |
|---|---|
| bootc image | `bootc_digest` |
| bootc version | `bootc_version` |
| Secure Boot | `secure_boot` |
| TPM | `tpm_present` |
| disk encryption | `disk_encrypted` |
| SELinux | `selinux_state` |
| identity enrollment | `identity_enrolled` |
| patch age | `patch_age_days` |

The bootc digest must be a complete `sha256:` digest. Values that cannot be validated remain unknown.

## Foreman remote-job contract

The approved template receives seven inputs:

| Input | Meaning |
|---|---|
| `docker_dash_action` | `update` or `rollback` |
| `docker_dash_target_image` | canonical `registry/repository@sha256:...` OCI reference, without credentials |
| `docker_dash_target_digest` | exact target `sha256:` digest |
| `docker_dash_idempotency_key` | immutable request identity |
| `docker_dash_plan_hash` | exact immutable Docker Dash plan hash |
| `docker_dash_approval_ref` | operator-supplied approval/change reference |
| `docker_dash_maintenance_window_ref` | operator-supplied maintenance-window reference |

Docker Dash selects the target with the exact numeric Foreman host ID. Non-numeric selectors are rejected before network I/O. The template is responsible for performing the organization-approved bootc command, preserving its own execution log and returning a normal Foreman job status.

Immediately before submission, Docker Dash reads the exact numeric job template and verifies that all seven inputs above exist. A missing input blocks execution while the plan remains `planned`; the template body is never returned or stored.

The adapter follows Foreman's documented [`POST /api/job_invocations`](https://apidocs.theforeman.org/katello/4.17/apidoc/v2/job_invocations/create.html) contract, including the required `static_query` targeting type, and validates inputs through [`GET /api/job_templates/:id`](https://apidocs.theforeman.org/katello/latest/apidoc/v2/job_templates/show.html). This compatibility basis was last reviewed on 2026-08-05; production qualification against the deployed Foreman/Katello version remains required.

## Operator workflow

1. Open **Admin → Workstation Fleet**.
2. Add the Foreman HTTPS endpoint, credential and CA; test the connection.
3. Synchronize inventory. Review partial warnings and unknown posture before treating any score as compliance evidence.
4. Map Foreman locations or host groups to Edge Sites where relevant.
5. Inspect a registry image. For rollout, choose Cosign and provide the deployment's explicit signer identity regexp; Cosign inspection fails closed without it.
6. Promote the verified digest from `held` to `canary`. Promote from `canary` to `stable` only after external canary evidence exists.
7. Create an update or rollback plan with approval, maintenance window and idempotency references.
8. Run **Preflight**. It is local/read-only and lists every deterministic blocker without contacting Foreman.
9. If approval or timing changes before submission, cancel the plan with a reason and create a new immutable plan later. Docker Dash refuses local cancellation after a Foreman task has started.
10. In a qualified environment only, enable the mutation flag and exact template allowlist, restart Docker Dash, then execute the plan.
11. Reconcile the running plan until post-read verification reaches `succeeded` or a terminal failure. Jobs that exceed the configured timeout terminate as `FOREMAN_JOB_TIMEOUT`.

## API surface

All endpoints require an authenticated administrator.

| Method | Endpoint | Boundary |
|---|---|---|
| `GET` | `/api/workstation-fleet/overview` | local read |
| `GET` | `/api/workstation-fleet/devices` | local read/filter |
| `POST/PUT/DELETE` | `/api/workstation-fleet/connections...` | local profile write |
| `POST` | `/api/workstation-fleet/connections/:id/test` | upstream read |
| `POST` | `/api/workstation-fleet/connections/:id/sync` | upstream read, local inventory write |
| `PUT/DELETE` | `/api/workstation-fleet/.../mappings` | local mapping write |
| `POST` | `/api/workstation-fleet/artifacts/inspect` | registry read, local evidence write |
| `GET` | `/api/workstation-fleet/artifacts/:id/promotions` | paginated local promotion history, maximum 100 rows |
| `POST` | `/api/workstation-fleet/artifacts/:id/promote` | local policy write |
| `POST` | `/api/workstation-fleet/devices/:id/plans` | local immutable plan |
| `GET` | `/api/workstation-fleet/plans/:id/preflight` | local deterministic readiness, zero upstream calls |
| `POST` | `/api/workstation-fleet/plans/:id/cancel` | local cancellation before submission, zero upstream calls |
| `POST` | `/api/workstation-fleet/plans/:id/execute` | gated Foreman mutation |
| `POST` | `/api/workstation-fleet/plans/:id/reconcile` | upstream post-read, local state write |

## Production qualification checklist

- [ ] Use a real least-privilege Foreman/Katello credential and a trusted CA.
- [ ] Confirm the required facts are published for a disposable enrolled workstation.
- [ ] Inspect an image signed by the deployment's actual trust root.
- [ ] Approve exact remote-job template IDs; do not use a generic shell template.
- [ ] Run update and rollback against a disposable canary in an approved maintenance window.
- [ ] Verify that replay, stale evidence, TLS-off, wrong typed confirmation and digest mismatch all remain blocked.
- [ ] Review Docker Dash audit events and Foreman job history without copying credentials or raw output.
- [ ] Enable mutations only for the canary window; disable the flag immediately if qualification fails.

Local automated tests validate the software contract. They do not certify a production Foreman template, an external signer, or a specific workstation image.

## Troubleshooting

- `host_facts_unavailable`: inventory succeeded, but facts are missing or forbidden. Grant the minimum facts read permission or publish the selected values as approved host parameters.
- `host_facts_truncated`: raise `DD_WORKSTATION_FOREMAN_MAX_FACT_HOSTS` only after evaluating Foreman load.
- `BOOTC_SIGNATURE_NOT_VERIFIED`: annotation presence is not cryptographic verification. Install/configure Cosign and inspect with policy `cosign`.
- `WORKSTATION_EVIDENCE_STALE`: synchronize Foreman again and create a new plan.
- `WORKSTATION_ARTIFACT_EVIDENCE_CHANGED`: re-inspect/promote the artifact and create a new plan; never reuse the old plan hash.
- `WORKSTATION_PLAN_CANCELLED`: the unsubmitted plan was closed locally and cannot be reused; create a new plan if approval is restored.
- `FOREMAN_CONNECTION_ACTIVE_WORKFLOW`: finish the active sync, cancel planned workflows and reconcile running workflows before deleting the connection.
- `FOREMAN_CONNECTION_IDENTITY_LOCKED`: the profile already owns synchronized evidence; create a new profile instead of repointing it to another Foreman URL.
- `FOREMAN_TLS_REQUIRED_FOR_MUTATION`: configure a trusted CA and enable TLS verification.
- `FOREMAN_JOB_TIMEOUT`: the remote job exceeded the bounded runtime. Inspect Foreman before creating a replacement plan; do not assume that the remote process stopped.
- `FOREMAN_JOB_SUBMISSION_TIMEOUT`: no Foreman task identity was persisted after the atomic claim. Inspect Foreman job history using the plan hash and idempotency key before creating a replacement plan.
- `WORKSTATION_POST_READ_MISMATCH`: Foreman reported job completion, but the target digest was not observed. Treat this as a failed rollout and investigate in Foreman.
