# Workstation fleet control plane rollout results

- **Release:** v8.92.0
- **Date:** 2026-08-05
- **Feature commit:** `3d077a2`
- **Release commit/tag:** `6b243df252cc0207716bc6c06293e6b32b3b7f8d` / `v8.92.0`

## Result

The generic bootc workstation fleet control plane is published and healthy on
both Docker targets. The release adds digest-pinned OCI trust and provenance,
Foreman/Katello read-only inventory, workstation posture/drift search, Edge
Site mapping, artifact channels and guarded update/rollback workflows.

Remote Foreman execution remains deliberately unavailable in production:
`DD_WORKSTATION_FOREMAN_MUTATIONS` resolves to `false` and the template
allowlist is empty on both targets. No Foreman job, registry mutation or
workstation update/rollback was attempted or inferred during this rollout.

## Source and workflow evidence

- draft PR: <https://github.com/bogdanpricop/docker-dash/pull/13>;
- release: <https://github.com/bogdanpricop/docker-dash/releases/tag/v8.92.0>;
- PR CI run `31034043776`: success in 2m16s;
- PR Docker run `31034043548`: success in 33s;
- tag Docker run `31034048225`: success in 1m17s;
- full local validation: 320 suites passed, 3,398 tests passed and 4 skipped;
- release-focused validation: 7 suites and 49 tests passed;
- ESLint: zero errors and the 14 known unrelated warnings;
- i18n, accessibility, JavaScript syntax, version synchronization, whitespace
  and the 450-feature research registry gates passed.

The exact annotated-tag archive contains 1,918 entries, is 20,219,987 bytes
and has SHA-256
`49c6f3d8507e186f461cce8fab7fb158d85c731bc09e6202aefb4c27bd7b59be`.
It contains no `.env`, `.git` or `node_modules` entry. Both remote copies
matched the same digest before extraction.

## Docker deployment evidence

| Target | Release directory | Image ID | Verified rollback backup |
|---|---|---|---|
| LAN `192.168.13.20` | `/home/localadmin-a/docker-dash-releases/v8.92.0-6b243df` | `sha256:0a42d349ad3b68079a0ea5714d3e86b84c340133a242ef8e75b0c279eb75e207` | `/data/backups/predeploy-v8.92.0-6b243df.db`, 3,922,575,360 bytes, mode 0600, SHA-256 `b57e2413b79641ec71b257609189dc5a23d601f7c45ce07e6479766e5ae53dba` |
| VPS `89.37.212.66` | `/opt/docker-dash/releases/v8.92.0-6b243df` | `sha256:224c7f6acf73b10d582db80efc1e7bcd2e3859b3a9df48075fa692011e13c79f` | `/data/backups/predeploy-v8.92.0-6b243df.db`, 459,431,936 bytes, mode 0600, SHA-256 `cf55f3f021a72f07689038abf87a7b5d42a938f561aab102c70a0d3124d9e572` |

Each host verified the archive, extracted an immutable release directory,
copied the protected base `.env` byte-for-byte with mode 0600, built the local
Docker image and created an online SQLite backup before promotion. Backup
`quick_check` returned `ok`. Compose recreated only service `app` and retained
an automatic application-only rollback to the previous Compose files and
image while all post-deploy gates ran.

The LAN uses the production target. The VPS intentionally preserves its
existing development override and read-only `/app/src` and `/app/public` bind
mounts, now pointing to the v8.92.0 release directory.

## Smoke and data verification

Both targets pass the same post-deploy contract:

- container and internal health are `healthy` / `status=ok`, version `8.92.0`;
- restart count is zero and critical migration/uncaught/fatal log matches are
  zero;
- external `/` and `/js/pages/workstation-fleet.js` return HTTP 200;
- the served asset exposes the `WorkstationFleetPage` contract;
- unauthenticated `/api/workstation-fleet/overview` returns HTTP 401;
- live SQLite `quick_check` is `ok`;
- migration `171_workstation_fleet.js` appears once;
- all seven workstation tables and all four `workstation_fleet.*` permissions
  exist; the complete permission catalog contains 120 rows;
- workstation fleet reads are enabled, Foreman mutations are disabled and the
  production template allowlist contains zero entries;
- the previous `docker-dash:8.91.4` image remains available on both hosts.

The integrated Browser skill was initialized as required, but the runtime
reported no available browser backend (`agent.browsers.list()` returned an
empty list). Interactive browser evidence is therefore not claimed; the
external HTTP/UI asset contract and the automated page/accessibility suites
are the recorded UI evidence for this session.

## Rollback

The immediate application rollback is `docker-dash:8.91.4`, using each
target's retained v8.91.4 Compose release. Because migration 171 adds only new
workstation control-plane tables and permissions, restoring the verified
pre-deploy database above is the conservative rollback for the prior image.

## External qualification boundary

Repository implementation, publication and Docker Dash deployment are closed.
Enabling remote update/rollback still requires infrastructure and authorization
outside this repository: a real least-privilege Foreman/Katello endpoint, the
deployment trust root, an exact allowlisted remote-job template and an approved
disposable workstation canary. These are production qualification inputs, not
unfinished application functionality.
