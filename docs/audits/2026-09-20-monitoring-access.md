# Global monitoring authorization — 2026-09-20

Source baseline: `123df41`. Not deployed or included in the existing 8.96.10 image.
[Machine-readable evidence](2026-09-20-monitoring-access.json).

## Finding and correction

Ten regression cases failed against the original routes: anonymous GET/HEAD,
viewer sessions, tenant credentials and unrelated service scopes could read global
metrics or the detailed cluster snapshot. The original optional-authentication
middleware never required a principal or checked its scope.

Both `/api/metrics` and `/api/cluster/status` now require authentication. Global
service tokens may carry the dedicated `monitoring.read` or the broader existing
`api.read`. Administrator sessions and administrator API keys with read permission
also work. Non-admin users, tenant credentials and unrelated scopes are refused.
The dedicated scope cannot access other application data. Invalid, expired and
revoked credentials receive 401 rather than falling back to public access.

No-store headers apply before authentication, including denied responses. HEAD and
case/trailing-slash variants follow the same policy. Unauthorized requests never
collect container statistics. Metrics explicitly declare Prometheus text format
0.0.4. Public `/api/health` keeps its liveness/version/cluster-role metadata.

## Scraper compatibility and rollout

Existing anonymous scrapers must configure credentials. The bundled Compose profile
mounts `MONITORING_TOKEN_FILE` (default `./.secrets/monitoring-token`) only into the
Prometheus service. Bundled YAML and generated wizard snippets read the raw token
from `/run/secrets/monitoring_token` using Bearer authorization. The private default
directory is excluded from Git and Docker build contexts. It is not required when
running the app without the observability profile.

The [operator guide](../features/observability.md#2-enabling) covers host-file
permissions, renewal before the 24-hour maximum lifetime and the bind-mount inode
consideration when replacing a credential file. Rotation invalidates the old token
immediately. Administrators must update the scraper credential as part of rotation;
automatic long-lived credential issuance is not introduced. Global api.read remains
compatible for existing automation; monitoring.read provides narrower new access.

The wizard and help explain the credential requirement in English/Romanian. HA
examples now use private curl configuration rather than unauthenticated requests.
For external scraping, HTTPS and certificate validation remain required operational
setup; the bundled app target uses the internal Compose network.

Configuration references: [Prometheus authorization](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_config)
and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

## Verification

- Original regressions: ten failed tests.
- Final focused run: 64 passed; 34 new monitoring cases.
- Full suite: 381 suites, 5,215 passed, one skipped. Subsequent changes added only
  frontend credential guidance and documentation; final lint passed.
- Help coverage remains 60/60.
- LAN and VPS each passed 59 native authentication checks with hash-verified source
  overlays. New checks exercise anonymous denial, global/tenant/user scope, real
  HTTP metrics format, credential-file reading, rotation/revocation and public health.
- Each host also passed three checks with the bundled provenance-verified Compose
  CLI: configuration without a monitoring credential, observability secret mapping,
  and CLI provenance. No Docker socket was mounted for these configuration checks.
- All owned canary containers were removed. No real email or external IdP calls.

These checks did not deploy a Prometheus/Grafana stack or run an actual Prometheus
scrape loop. Their existing image pins still need their own update/revalidation in
the wider dependency audit. This checkpoint does not clear container image findings.

## Live state

Read-only HEAD requests at 11:08 UTC confirmed HTTP 200 without credentials for both
paths on LAN and VPS. No response bodies or container names were collected. The
production endpoints therefore remain exposed until a tested deployment applies
the correction. Full rollout still awaits the requested account-email URL values;
a separate backport of this independent correction can be evaluated for earlier
deployment. Existing live images/configuration were not changed in this checkpoint.
