# Security and dependency refresh — 2026-10-07

## Scope

This refresh covers the production Docker Dash image, the bundled image scanners,
the Docker CLI and Compose plugin, the optional Prometheus and Grafana images,
and the custom Caddy DNS image.
Every production image was built on the LAN Docker host and exercised as an
isolated container before deployment.

## Versions

| Component | Verified version |
| --- | --- |
| Docker Dash | 8.96.13 |
| Node.js | 24.21.0 |
| npm used to create the production dependency layer | 12.2.0 |
| Trivy | 0.75.0+dd.2 |
| Grype | 0.120.1+dd.2 |
| Docker CLI | 29.8.2+dd.2 |
| Docker Compose | 5.6.0+dd.2 |
| Prometheus | 3.15.0+dd.4 |
| Grafana | 13.2.3+dd.4 |
| Caddy | 2.11.7 with nine pinned DNS providers |
| Go toolchain for rebuilt tools | 1.27.1 |

The Go and Node base image indexes are pinned by digest. Docker CLI 29.8.2 is
built from its verified module source using its upstream `vendor.mod` dependency
set. `go mod verify` runs before every Go binary build.

npm is needed only while creating `node_modules`. The latest npm package still
ships dependencies reported by container scanners, so npm and npx are removed
from the final runtime stage. Application dependencies remain installed from the
lockfile by npm 12.2.0. Every CI and Docker install uses
`--strict-allow-scripts`, and a repository check prevents the Node/npm/toolchain
pins or that lifecycle-script policy from drifting. `npm audit` reports zero
vulnerabilities and `npm outdated` reports no outdated project packages.

The registry retention executor now deletes untagged OCI manifests by their
validated immutable SHA-256 digest. This closes the previous gap where the
policy selected those manifests but returned a `not implemented` error during
execution. Per-manifest and summary audit events remain mandatory.

SQLite spill files now use a mode-0700 directory on the persistent data volume.
This keeps large statistics rollups operational when the hardened container uses
a deliberately small `/tmp` tmpfs, without weakening the read-only root filesystem.

## Image verification

The production smoke test passed native SQLite migrations, HTTP health and rate
limits, strict Git/SSH host verification, provider mTLS, LDAP StartTLS and LDAPS,
encrypted rollback history, persistent generated secrets, and non-executing env
file parsing. The Compose lifecycle canary passed configuration, create, health,
exec, volume persistence, restart, recreation, status inspection and cleanup.

Trivy and Grype scanned the locally built images. There are no actionable
application, Alpine, Prometheus or Grafana findings after the refresh. The
remaining scanner records are accounted for below.

The custom Caddy image is a 22 MB minimal runtime containing the statically
linked Caddy binary, CA roots, MIME types, and only the BusyBox/musl files needed
by the Compose bootstrap and internal-CA paths. Caddy 2.11.7 and all nine DNS
providers are pinned. It passed HTTP and internal-TLS reverse-proxy smoke tests
with a read-only root filesystem, every capability dropped, and
`no-new-privileges`; both scanners report zero actionable HIGH or CRITICAL
findings.

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

This includes the newly published `CVE-2026-41567`, `CVE-2026-42306`, and
`GO-2026-4887`: their official package scope is the Docker daemon/AuthZ code,
while `grype.packages.txt` contains only `github.com/docker/docker/client` and
`github.com/docker/docker/api/...`.

### Distribution and source-patch matching

Grype's generic CPE matcher reports BusyBox and zlib records even when the
distribution or source build carries the fix. Alpine 3.24 packages
`CVE-2026-85091.patch` in zlib 1.3.2-r1 and declares that revision fixed;
Trivy's Alpine-aware scan reports no Alpine vulnerability for zlib 1.3.2-r1 or
BusyBox 1.37.0-r31.

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

The 8.96.13 deployment runs with a read-only root filesystem, all capabilities
dropped and `no-new-privileges` on both the LAN host and VPS. VPS application and
Grafana ports bind only to loopback. Persisted bootstrap secrets use mode 0600,
stale plaintext backup copies were removed, and the LAN encryption key was
restored from the last release proven to decrypt all three stored SSH host
configurations. Fingerprints from already trusted OpenSSH records were pinned for
the LAN host and VPS; the remaining `192.168.12.40` host stays fail-closed until
its fingerprint is verified out of band. Audit retention was raised from 7 to 90
days on both deployments.

