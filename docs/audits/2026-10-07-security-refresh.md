# Security and dependency refresh — 2026-10-07

## Scope

This refresh covers the production Docker Dash image, the bundled image scanners,
the Docker CLI and Compose plugin, and the optional Prometheus and Grafana images.
Every production image was built on the LAN Docker host and exercised as an
isolated container before deployment.

## Versions

| Component | Verified version |
| --- | --- |
| Docker Dash | 8.96.11 |
| Node.js | 24.21.0 |
| npm used to create the production dependency layer | 12.2.0 |
| Trivy | 0.75.0+dd.2 |
| Grype | 0.120.1+dd.2 |
| Docker CLI | 29.8.2+dd.2 |
| Docker Compose | 5.6.0+dd.2 |
| Prometheus | 3.15.0+dd.4 |
| Grafana | 13.2.3+dd.4 |
| Go toolchain for rebuilt tools | 1.27.1 |

The Go and Node base image indexes are pinned by digest. Docker CLI 29.8.2 is
built from its verified module source using its upstream `vendor.mod` dependency
set. `go mod verify` runs before every Go binary build.

npm is needed only while creating `node_modules`. The latest npm package still
ships dependencies reported by container scanners, so npm and npx are removed
from the final runtime stage. Application dependencies remain installed from the
lockfile by npm 12.2.0. `npm audit` reports zero vulnerabilities and `npm outdated`
reports no outdated project packages.

The registry retention executor now deletes untagged OCI manifests by their
validated immutable SHA-256 digest. This closes the previous gap where the
policy selected those manifests but returned a `not implemented` error during
execution. Per-manifest and summary audit events remain mandatory.

## Image verification

The production smoke test passed native SQLite migrations, HTTP health and rate
limits, strict Git/SSH host verification, provider mTLS, LDAP StartTLS and LDAPS,
encrypted rollback history, persistent generated secrets, and non-executing env
file parsing. The Compose lifecycle canary passed configuration, create, health,
exec, volume persistence, restart, recreation, status inspection and cleanup.

Trivy and Grype scanned the three locally built images. There are no actionable
application, Alpine, Prometheus or Grafana findings after the refresh. The
remaining scanner records are accounted for below.

### Go module reachability

Trivy reports `GO-2026-5932` against `golang.org/x/crypto` in the scanner and
Compose binaries. The advisory concerns `golang.org/x/crypto/openpgp`; none of
the recorded compiled-package inventories contains an `openpgp` package.

Trivy and Grype associate daemon-side Moby advisories with Grype because the
binary records module `github.com/docker/docker` 28.5.2. The compiled inventory
contains only Docker API type packages and the client. It contains none of the
daemon, builder, archive, container-runtime or plugin implementation packages
affected by the reported archive upload, `docker cp`, authorization-plugin and
plugin privilege-validation defects.

### Distribution and source-patch matching

Grype's generic CPE matcher reports BusyBox and zlib records even when the
distribution or source build carries the fix. Trivy's Alpine-aware scan reports
no Alpine vulnerability for zlib 1.3.2-r1 or BusyBox 1.37.0-r31.

The Prometheus and Grafana BusyBox binaries are source builds with checksum-
verified fixes for CVE-2025-60876 and CVE-2026-38753 through CVE-2026-38755.
The build runs the upstream AWK suite, dedicated security regressions and an
exact applet-surface comparison. Grype identifies the upstream version string
and cannot infer those applied source patches.

## Runtime hardening

Prometheus and Grafana run with every Linux capability dropped and
`no-new-privileges`. Their read-only runtime smoke tests use UID/GID 65534 and
472 respectively. The Docker Dash production image removes build-only npm from
the runtime filesystem. Docker Scout remains excluded because its latest
published plugin embeds vulnerable dependencies and no corresponding plugin
source is available for a verified rebuild.

