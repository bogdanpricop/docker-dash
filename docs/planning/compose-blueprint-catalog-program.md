# R9 implementation program — Compose blueprint catalog

**Date:** 2026-08-06

**Target release:** v8.93.0

**Source:** [`remaining-market-research-implementation-plan.md`](remaining-market-research-implementation-plan.md), Batch R9

**Status:** Validated locally; release and rollout pending

## Outcome

Deliver a curated Compose catalog that turns a verified OCI artifact into an operator-reviewable application definition without creating a second deployment engine or weakening the existing OCI Compose dry-run boundary.

## Capability ledger

| ID | Capability | Status | Evidence |
|---|---|---|---|
| CB-001 | Curated catalog metadata, ownership, support and lifecycle | Implemented | `compose_blueprints`, admin service/API and Compose Catalog UI |
| CB-002 | Immutable semantic versions and digest pinning | Implemented | `compose_blueprint_versions`, OCI manifest resolution, unique version/version hash |
| CB-003 | Cryptographic trust and signer identity | Implemented | Cosign-only publish/restore with publish-time re-verification |
| CB-004 | Typed parameter wizard | Implemented | closed schemas for string/integer/boolean/enum/secret_ref and generated UI |
| CB-005 | Secret-reference admission | Implemented | shared admission service; raw parameters absent from DB/audit |
| CB-006 | Compatibility and operational guidance | Implemented | daemon/environment/architecture/Compose declarations plus health, backup and resource metadata |
| CB-007 | Deterministic preview | Implemented | parameter/override/version/plan hashes and escaped rendered review |
| CB-008 | Safe OCI Compose hand-off | Implemented | idempotent stopped artifact creation; deploy remains a separate reviewed plan |
| CB-009 | Diff, deprecation and catalog restore | Implemented | safe version diff and re-verified deprecated→published restoration |
| CB-010 | RBAC, host scope, audit and history | Implemented | admin/operator gates, effective host access and hash-only history/audit |

## Accepted decisions

1. The catalog reuses OCI Compose rather than introducing another deploy executor.
2. Instantiation never deploys. It creates a digest-pinned OCI application definition only.
3. Only cryptographically verified Cosign versions may become the active default.
4. A restored version changes future catalog selection, not running workloads.
5. Blueprint inputs use exact allowlists; placeholders occupy a complete YAML scalar.
6. Secret values are out of scope. Only validated symbolic references are accepted.
7. Operational metadata is disclosed guidance, not a monitoring, backup or capacity reservation claim.
8. Inner image pinning remains a publisher responsibility until the remote OCI Compose bundle can be independently extracted and inspected.

## Definition of done

- [x] additive/idempotent migration and three governance permissions;
- [x] service state machines, closed validation and deterministic hashes;
- [x] registry digest resolution and Cosign publish/restore verification;
- [x] safe secret-reference rendering and OCI override validation;
- [x] stale-plan/idempotency enforcement with no raw parameter persistence;
- [x] route RBAC, effective host scope and sanitized audits;
- [x] catalog, authoring, diff, restore, wizard, preview and history UI;
- [x] all locale navigation labels and command-palette entry;
- [x] focused service/route/page/migration tests;
- [x] full Jest, ESLint, research, i18n/a11y and whitespace gates;
- [ ] v8.93.0 release/tag/push and Docker rollout evidence;
- [ ] real signed-artifact and browser qualification when external prerequisites are available.

## External qualification, not hidden local implementation

- a registry artifact signed by the deployment's approved identity;
- a usable Cosign binary and trust configuration on each Docker Dash node;
- Docker Compose 2.34+ and a disposable Docker/Podman deployment target;
- browser runtime for keyboard/focus/error-state smoke;
- publisher evidence that inner application images are digest-pinned where required;
- application-owner approval for health, backup/restore and resource guidance.

These items must remain explicit prerequisites. Fixtures or an unsigned public artifact cannot be reported as production trust evidence.

## Execution journal

| Date | State | Evidence | Notes |
|---|---|---|---|
| 2026-08-06 | Implemented locally | migration 172; service/API/UI; 4 focused suites / 31 tests | Full validation and rollout pending. |
| 2026-08-06 | Validated locally | 323 suites / 3,416 passed / 4 skipped; ESLint 0 errors; research 391/59/0; i18n/a11y/whitespace green | Known Redis mock handle notices and 14 pre-existing ESLint warnings remain non-blocking. |
