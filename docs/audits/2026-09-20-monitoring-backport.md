# Monitoring-only backport for the deployed 8.96.8 image

Version: `8.96.8+monitoring.1`; source branch: `codex/monitoring-security-backport`.
This private checkpoint applies the monitoring access fix from `04337ec` to
the deployed `29c26d2` source. It is not the complete security audit release.

`/api/metrics` and `/api/cluster/status` now require an administrator or a
global service credential with `monitoring.read` or `api.read`. Anonymous
requests return 401, tenant credentials and ordinary users return 403.
`/api/health` stays public. Monitoring responses use `Cache-Control: no-store`;
metrics declare the Prometheus text format version. Scrape configuration and
EN/RO help explain the credential file and expiry/rotation requirements.

Both live servers already run Prometheus, scraping Docker Dash successfully.
Their migration therefore also uses a dedicated administrator-owned API key
with only `monitoring.read`. The permission allows only the two monitoring
GET/HEAD routes, including if accidentally mixed with broad legacy permissions.
It refuses other reads, writes, viewer-owned keys and revoked/expired keys.
These persistent infrastructure keys have no automatic expiry; revoke/replace
them explicitly and reissue them with the later authentication migration.
The credential is stored only in each private remote release directory, with
a read-only single-file mount into Prometheus. No credential is in Git, image
layers or local audit logs. The collector is recreated with its existing
immutable image and data volume; application health and a fresh authenticated
Prometheus scrape must both pass after deployment.

The immutable production base is
`sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b`.
Build with `docker/monitoring-backport.Dockerfile` and target `production`.
The Docker image tag uses `8.96.8-monitoring.1-audit-<revision>` because Docker
tags cannot contain the SemVer build-metadata `+`. The source/package version
retains `8.96.8+monitoring.1`. The normal Compose fallback remains 8.96.8;
deployment must select the explicit immutable hotfix image, as recorded in the
deployment evidence. This is not a public registry release.

No migrations or dependency changes are included. Existing reset, MFA, SSO,
SCIM and service-credential lifecycle behavior remains that of 8.96.8. Their
later audit fixes still require the full update; in particular the correct
public reset-link URLs must be supplied before that rollout. Docker Scout
remains excluded for the documented vulnerable, closed-binary dependencies.
Known image findings and the unauthenticated LAN Docker daemon are not fixed
by this monitoring patch.

Validation before build: 363 suites pass (4,797 tests, one skipped), including
GET/HEAD, case/trailing-slash variants, administrator and viewer API keys,
global/tenant service scopes, expiry/revocation, public health and credential
file configuration and the dedicated collector key. The first full run found
two checkout/environment issues: a CA fixture converted to CRLF on Windows
and a missing test encryption key. With the fixture restored to LF and an
explicit test-only key, the full run passes; neither requires a production
code change. ESLint and page help coverage (60/60) pass. Deployment and native-image verification
are recorded separately after execution; this document is not evidence that
a rollout has already succeeded.
