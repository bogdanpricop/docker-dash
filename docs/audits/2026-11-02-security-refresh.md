# Dependency security refresh — 2026-11-02

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

Final image reports, artifact-bound applicability checks and deployment evidence
are recorded after the rebuilt candidates pass their gates.
