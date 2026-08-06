# Compose blueprint catalog rollout results

- **Release:** v8.93.0
- **Date:** 2026-08-06
- **Commit/tag:** `accba7ea6ef55e732ff41ca6f08a42fa6123d7b9` / `v8.93.0`
- **Program:** [`compose-blueprint-catalog-program.md`](compose-blueprint-catalog-program.md)

## Result

The signed Compose blueprint catalog is published and healthy on both Docker targets. Migration 172 adds the catalog, immutable versions, hash-only instantiation history and three governance permissions. The release includes typed parameters, secret-reference admission, compatibility and operational profiles, deterministic previews, version diff/restore and an idempotent hand-off to the existing OCI Compose deployment boundary.

No catalog version or OCI application was created during rollout because production qualification requires an artifact signed by the deployment's approved identity. No workload, registry, secret manager or provider mutation was attempted. Catalog instantiation cannot deploy a workload; the separate OCI Compose dry-run and confirmation remain mandatory.

## Source and validation evidence

- draft PR: <https://github.com/bogdanpricop/docker-dash/pull/13>;
- release: <https://github.com/bogdanpricop/docker-dash/releases/tag/v8.93.0>;
- PR CI run `31071668105`: success;
- PR Docker run `31071668249`: success;
- tag Docker run `31071668072`: success;
- local validation: 323 suites, 3,416 tests passed and 4 skipped;
- focused validation: 4 suites and 31 tests passed;
- ESLint: zero errors and 14 known warnings outside this change;
- virtualization registry: 450 features, 391 `Done`, 59 `Partial`, 0 `Open`;
- self-service i18n, accessibility, JavaScript syntax and whitespace gates passed.

The exact annotated-tag archive contains 1,928 entries, is 20,255,379 bytes and has SHA-256 `555850fedc8e3965fa94d184a5c30685684e01fc06c8fd4ad05e2adbf5357a8e`. It contains no `.env`, `.git` or `node_modules` entry. Both remote copies matched this digest before extraction.

## Docker deployment evidence

| Target | Release directory | Image ID | Verified rollback backup |
|---|---|---|---|
| LAN `192.168.13.20` | `/home/localadmin-a/docker-dash-releases/v8.93.0-accba7e` | `sha256:3be4df5d8886f7a84ee273b15dc049ca50ab665442498e94ffbcc3fdd2b363cd` | `/data/backups/predeploy-v8.93.0-accba7e.db`, 4,010,610,688 bytes, mode 0600, SHA-256 `28f932d8564fa609b64f9db35eae43b5fa9b34583a41be4d456b217f57663211` |
| VPS `89.37.212.66` | `/opt/docker-dash/releases/v8.93.0-accba7e` | `sha256:83adf56dae5faf25bc44a2993e9ce78034f78e49c0f201cbbf4bfaa4cf471d35` | `/data/backups/predeploy-v8.93.0-accba7e.db`, 448,106,496 bytes, mode 0600, SHA-256 `e9545d717cc4e04ed0657058848c5293363caeb2841d0424361756787a05d8a3` |

Each target verified and extracted the exact release archive, copied its protected `.env` with mode 0600, built the versioned image and created an online SQLite backup. Backup and live database `quick_check` both returned `ok`. Compose recreated only service `app` under the existing explicit `docker-dash` project. The VPS preserved its development override and its read-only `/app/src` and `/app/public` mounts now resolve from the v8.93.0 release directory.

The first LAN promotion command omitted the explicit Compose project name. Docker refused to create the derived release-name network because its address pools were exhausted. The failure occurred before container recreation; v8.92.0 remained healthy and unchanged. The corrected command used `-p docker-dash`, reused the existing network/volumes and completed successfully. The rollback harness also uses the explicit project name.

## Runtime smoke

Both targets satisfy the same contract:

- internal and external `/api/health` return `status=ok`, version `8.93.0`;
- container health is `healthy`, restart count is zero and critical migration/uncaught/fatal log matches are zero;
- external `/` and `/js/pages/compose-catalog.js` return HTTP 200;
- the served asset contains the `ComposeCatalogPage` contract;
- unauthenticated `/api/compose-blueprints` returns HTTP 401;
- live SQLite `quick_check` is `ok`;
- migration `172_compose_blueprint_catalog.js` appears exactly once;
- all three catalog tables and all three `compose_blueprint.*` permissions exist;
- the complete governance permission catalog contains 123 entries;
- catalog tables are empty, confirming rollout did not invent or import a signed application;
- the prior `docker-dash:8.92.0-6b243df` image remains available on both hosts.

The in-app Browser runtime was initialized for UI smoke but exposed no browser backend. Interactive browser evidence is therefore not claimed. External HTTP/UI asset checks plus automated page, navigation, locale and accessibility tests are the available evidence.

## Rollback

The immediate application rollback is `docker-dash:8.92.0-6b243df` from each retained v8.92.0 release directory, using explicit Compose project `docker-dash`. Because migration 172 is additive, restoring the verified pre-deploy database is the conservative rollback if the previous application image must run. OCI applications created later from the catalog are separate records and are not removed by changing the catalog default.

## External qualification boundary

Repository implementation, release and Docker Dash rollout are complete. Production catalog qualification still requires an approved signed OCI Compose artifact, the installation's Cosign trust configuration, publisher review of inner image pinning, an application owner for operational guidance, Docker Compose 2.34+ and a disposable target. Browser smoke can be added when a browser backend is available. These are explicit operational inputs, not unfinished repository functionality.
