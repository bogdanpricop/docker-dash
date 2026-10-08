# Grafana bootstrap security checkpoint - 2026-09-20

The optional Compose profile previously defaulted to `admin/admin`. The LAN
Grafana database still accepted that password. Its administrator password was
rotated to a random value, stored only in a private file on that host. The VPS
account was already using a different password and was preserved. Neither host
had active Grafana authentication tokens or API keys during this checkpoint.

## Configuration and compatibility

The profile now requires `GRAFANA_ADMIN_PASSWORD_FILE`, a read-only file mounted
only into Grafana. A startup guard validates the file before the official
`/run.sh` entrypoint. Missing, empty, whitespace-only, short, oversized and
embedded-newline values fail startup. Valid values contain 20-256 characters;
operators must generate a unique random password. This is format validation,
not a password entropy estimate.

`GRAFANA_ADMIN_PASSWORD` no longer supplies the bundled bootstrap password.
Move that value into the private file before recreating the service. An existing
Grafana database keeps its account credentials: changing a bootstrap file does
not reset them. See [operator instructions](../features/observability.md).

Linux host parent directories are owner-only (0700). Individual bootstrap files
are 0644 so the explicitly mounted file is readable by container UID 472; other
host users cannot traverse the private parent. LAN's rotated account password
is stored separately with mode 0600. Password contents were not copied into Git,
command arguments, local reports or Docker container configuration environment
values. Docker administrators can access mounted secrets and remain trusted.

## Validation and deployment

- Two relevant Jest suites: 56 tests passed.
- Native bundled Compose validation on both hosts: four grouped checks each,
  including app-only startup configuration without observability secrets.
- Native fresh Grafana bootstrap checks: seven grouped checks on 11.3.0 in LAN
  and seven on 13.2.2 on VPS. Configured credentials authenticated, anonymous
  access and `admin/admin` returned 401. Disposable containers were removed.
- Both production Grafana data volumes were backed up while stopped. Private
  archives were restored into disposable volumes, SQLite integrity and account/
  dashboard preservation were verified, and archive checksums matched.
- The guard was deployed to both existing Grafana 11.3.0 containers. Existing
  images, ports, data/provisioning mounts and unrelated environment settings
  were preserved. Post-deployment health returned `database: ok`, restart
  counts were zero, and authenticated Prometheus collection remained up.
- Account fingerprints and database row counts matched the pre-deployment
  snapshots. Default password and anonymous access were rejected on both hosts.

Machine-readable [evidence](2026-09-20-grafana-bootstrap.json) contains image
identities, guard checksum and private rollback/configuration paths, never
password values. Each host retains its stopped original Grafana container and
private snapshot. The generated `compose-bootstrap.json` override records the
live guard mounts; future Compose deployments must preserve these settings or
use the updated repository profile with its required secret configured.

The LAN snapshot made before password rotation is historical recovery material;
restoring it would restore the default password. Use the verified post-rotation
snapshot listed in the evidence. Rollback after any later Grafana schema upgrade
must restore the matching database backup, not start an old binary on a migrated
database.

## Remaining work

This checkpoint fixes bootstrap and account configuration; it does not upgrade
the live Grafana or Prometheus binaries. Official release metadata identifies
[Grafana 13.2.2](https://github.com/grafana/grafana/releases/tag/v13.2.2) and
[Prometheus 3.14.0](https://github.com/prometheus/prometheus/releases/tag/v3.14.0).
Both candidate images were pulled and scanned. Findings remain in their bundled
dependencies, including critical OpenSSL findings in the Grafana candidate.
Fresh-install bootstrap tests do not establish production migration safety.
Dependency remediation, staged migration on database copies and rescanning
remain required before the version upgrade.

The wider audit also retains the LAN unauthenticated Docker endpoint and the
pending public password-reset URLs as unresolved items. No claim of complete
security or full project completion is made by this checkpoint.
