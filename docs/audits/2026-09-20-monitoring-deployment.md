# Monitoring access deployment — 2026-09-20

The monitoring-only backport is deployed on LAN and VPS from source
`caf8b195d478f706a351196e5cb32dcd15b0d142`, on branch
`codex/monitoring-security-backport`. Image:
`sha256:d525e7e556aab759c6315894306f13a7e7fb6591d0ea70c5f821a2f367672753`.
The regular audit branch includes the dedicated collector-key permission too,
but its broader authentication changes are not yet deployed.

| Target | Running version | Fresh private backup | Anonymous metrics/status | Prometheus scrape |
| --- | --- | --- | --- | --- |
| LAN | 8.96.8+monitoring.1 | 1,852,420,096 bytes / integrity OK | 401 | up, authenticated |
| VPS | 8.96.8+monitoring.1 | 625,119,232 bytes / integrity OK | 401 | up, authenticated |

Application containers are healthy, without source bind mounts. Environment,
encryption keys, user/host counts, data mounts and helper image are preserved.
The schema remains 177; no authentication migrations or dependency changes
were included in this private backport. The complete base image layer prefix
is unchanged. Compared base source content matches the deployed revision
after normalizing Windows/Linux line endings; exact hashes are recorded.

Prometheus keeps its existing immutable image and data volume. Its configuration
passes promtool, and each new container has completed a fresh authenticated
scrape. A dedicated administrator-owned API key with only `monitoring.read`
permits GET/HEAD on metrics and detailed cluster status; other reads and writes
are refused, even if mixed with broader legacy permissions. An inactive or
non-admin owner cannot use it. Health checks remain public.

The keys have no automatic expiry. They live in each private remote release
directory (0700), in a 0644 file mounted individually read-only into Prometheus
so the unprivileged container UID can read it. No raw key is recorded in Git,
image layers or this evidence. Revoke/replace explicitly; recreate the collector
after replacing a file-backed mount. The full authentication migration revokes
legacy API keys, including these: reissue and verify scraping in that rollout.

Validation: backport 363 suites / 4,797 passed / one skipped; current audit
branch 381 suites / 5,216 passed / one skipped; ESLint and 60/60 page help pass.
Both hosts passed four grouped native HTTP checks against the exact bundled
image and all copied source hashes. The pending full update passed 60 native
checks per host with explicitly recorded source overlays; those checks do not
mean the complete update is deployed.

Trivy reports 4 High, 2 Medium and 3 Unknown; Grype reports 4 High and 5 Medium,
with zero Critical. Both identify the built image and the same ordered rootfs
layers; OCI manifest/config hashes were verified. Findings match the earlier
8.96.10 scan by identifier, package, installed version and severity. Findings
remain open; scanner gates were not weakened. Docker Scout stays excluded for
the previously documented vulnerable, closed-source plugin dependencies.

The first LAN attempt restored the original application automatically because
the deploy helper omitted the observability Compose profile during validation.
The temporary key was revoked; Prometheus had not yet been changed. The retry
enabled the profile, validated the configuration with promtool, took a new
private backup and completed successfully. Owned successful backup/canary/scan
containers were removed. No daemon was restarted or globally pruned.

Remaining: supply the correct public reset-link URLs for the full update;
secure the unauthenticated LAN Docker 2375 endpoint through authorized daemon
administration; update and test the existing Prometheus 3.0.1/Grafana 11.3.0
stack separately; continue the feature and security audit. This checkpoint
does not establish that all project work is complete or all risks are closed.

Machine-readable evidence: [monitoring-deployment.json](2026-09-20-monitoring-deployment.json).
