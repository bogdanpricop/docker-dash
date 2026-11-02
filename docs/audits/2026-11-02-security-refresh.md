# Dependency security refresh — 2026-11-02

Final image IDs and unfiltered finding summaries are recorded in
[the scan results](2026-11-02-security-results.json).

Docker Dash uses Node.js/CommonJS, vanilla browser JavaScript and embedded Go
tools. There is no PHP runtime, Composer manifest or PHP source to migrate.
The direct JavaScript dependency inventory, including development scope, is in
[the machine-readable inventory](2026-11-02-dependency-inventory.json).

## Findings and corrections

- Initial npm audit: 29 affected dependency entries (5 high, 21 moderate, 3 low),
  including propagated entries for tools depending on vulnerable packages.
- Express 5.3.0 brings body-parser 2.4.0; fixes the compressed-request-body DoS
  [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828).
- Nodemailer 10.3.1 fixes the three address-parser advisories
  [GHSA-8c8m-p3m8-cjg8](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8),
  [GHSA-m943-m63m-w62w](https://github.com/advisories/GHSA-m943-m63m-w62w) and
  [GHSA-85x2-q946-cp5h](https://github.com/advisories/GHSA-85x2-q946-cp5h).
- Updated qs and Puppeteer/Zod through the integrity-checked npm lockfile.
- Pin glob 14.0.3 and minimatch 11.0.4 using npm overrides. The existing Jest and
  ESLint releases still request affected older major versions; both packages
  retain the CommonJS APIs these callers use. Full tests and lint validate them.
- Node.js 24.22.2 addresses the
  [October security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
  Node/npm pins remain synchronized between CI, Dockerfile and package metadata.
- Build-only npm is updated to 12.2.1; it remains absent from production runtime.
- Go tools are rebuilt with Go 1.27.3, x/net 0.62.0 and go-jose/v4 4.1.6.
- Rebuilding the digest-pinned Node/Alpine base refreshes Brotli, curl, Expat and
  musl packages; cached old OS layers must not be reused for the security rollout.
- Grafana's source dependency set also updates kin-openapi to 0.149.0. Caddy's
  build pins Go 1.27.3 and updates chi/v5 to 5.4.0 and the shared Go patches.

## Unpatched development dependency

The remaining npm advisory is low severity
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4),
deepmerge 4.3.1, pulled in by Jest configuration. Upstream lists no patched
version. npm reports five entries for this one root advisory and its Jest
dependants. No production dependency uses deepmerge.

`npm run audit:dependencies` first requires a clean production audit, then allows
only this exact low advisory and its named Jest dependants until 2026-12-02.
New advisories, severity increases, scanner failures and expiry fail the check.
Raw `npm audit` continues to report the outstanding issue; no advisory is hidden.
Do not use npm's proposed forced downgrade to Jest 25 or ESLint 4.

## Validation

Local Node 24.22.2 tests: 5,226 passed, one skipped, two Windows shell timeouts in
the existing remote-secret-script tests. The new audit-policy tests pass 3/3.
The authoritative complete suite runs in Linux CI. Lint, JavaScript syntax,
toolchain pins, byte-identical browser assets, page help and real-browser library
interaction checks pass locally. Production npm audit reports zero advisories.

Linux CI passed all 383 suites: 5,231 passed tests and one skipped. The production
image startup/secret persistence smoke test passed. Both Trivy and Grype reports
passed the unchanged strict image gate after refreshing exact binary hashes and
the x/crypto version in the existing applicability records. The six permitted
records are still confined to absent OpenPGP code and absent Docker daemon code;
the gate verifies the actual compiled-package inventories and metadata hashes.

Final Trivy findings include no npm application or Alpine vulnerabilities.
The Docker distribution module still has a medium advisory without a published
fixed version. Grype's embedded Docker module also has medium daemon-side
findings; the recorded binary contains only the Docker client/API packages.

## Auxiliary images and remaining limitations

- Prometheus 3.15.0: rebuilt with Go 1.27.3 and x/net 0.62.0. Only the previously
  analyzed OpenPGP module advisory remains; the deprecated package is absent.
- Grafana 13.2.3 core: rebuilt with Go 1.27.3, x/net 0.62.0, go-jose/v4 4.1.6
  and kin-openapi 0.149.0. The core scan retains only the absent-OpenPGP record.
- Grafana's separately signed Prometheus plugin is upgraded from 13.2.3 to the
  latest official signed release 13.2.5, with per-architecture SHA-256 verification.
  This fixes its High/Medium Go and network findings. Its x/net 0.61.0 still has
  CVE-2026-78661 and CVE-2026-97045, currently UNKNOWN severity, fixed in x/net
  0.62.0. That library fix is not yet delivered in an official signed plugin;
  replacing the executable would invalidate its signature. This remains open.
- Caddy 2.11.7: rebuilt with Go 1.27.3, x/net 0.62.0, chi/v5 5.4.0 and go-jose/v4
  4.1.6. Its transitive go-jose/v3 branch has no published fix for
  CVE-2026-116587 (High), CVE-2026-116585 and CVE-2026-116586 (Medium).
  This remains open alongside the absent-OpenPGP module record. The VPS public
  HTTPS endpoint uses its existing Traefik proxy, not this optional Caddy helper.

Grafana's automatic plugin preinstallation is disabled. Both live databases have
only the Prometheus datasource configured. A separate reviewed-plugin directory
prevents previously auto-downloaded extras from being loaded; their original
files are retained for rollback. Plugin signature verification remains enabled.

## Deployment evidence

Version 8.96.17 runs with Node 24.22.2 on both LAN and VPS, with healthy container
and HTTP health checks. The production image has no npm/npx binary. Read-only
root filesystems, dropped capabilities, private secrets and existing encrypted
credentials are preserved. The scanner's cache and temporary files now use
mode-0700 directories on the data volume; a real Trivy scan passed with a
read-only filesystem and a 64 MiB /tmp tmpfs.

Private predeployment SQLite backups passed integrity_check on both systems;
Grafana and LAN Prometheus volumes were also backed up while stopped. The same
built images were transferred from LAN to VPS and their immutable IDs compared.
Prometheus and Caddy were updated on LAN; Grafana was updated on both systems.
The LAN Caddy helper has no host-published ports, avoiding the existing Traefik
listener on ports 80/443. VPS application port 8101 remains loopback-only behind
the existing docker.amond.ro HTTPS endpoint.
