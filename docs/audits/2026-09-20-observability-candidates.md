# Observability upgrade candidates - 2026-09-20

The production bootstrap fix is deployed on LAN and VPS, as recorded in the
[preceding checkpoint](2026-09-20-grafana-bootstrap.md). Production still runs
Prometheus 3.0.1 and Grafana 11.3.0. The newer images described here are tested
candidates built on LAN, not a completed production version upgrade.

## Prometheus

Official release metadata identifies
[Prometheus 3.14.0](https://github.com/prometheus/prometheus/releases/tag/v3.14.0).
The upstream image still contains vulnerable dependencies. The candidate
rebuild uses Go 1.27.1, OpenTelemetry 1.46.0, gRPC 1.83.2, x/crypto 0.57.0,
x/net 0.58.0 and the complete committed module lock. The upstream source module
checksum, source revision and prebuilt UI archive SHA-256 are verified. Both
Prometheus and promtool are rebuilt, preserving the upstream embedded UI.

[Build instructions and provenance](../../../docker/observability/prometheus/README.md)
describe the local source replacement and reproducibility limits. The build
passed the gRPC missing authority/Host-header regression. The pinned builder
digest resolved to the same tested image on a subsequent cached build.

A stopped production TSDB snapshot from LAN was restored to a disposable volume.
The candidate passed promtool configuration/rule validation, queried historical
samples from that backup, loaded two rule groups and two embedded UI assets,
and scraped the production app successfully using its existing read-only
collector credential. These checks passed again after a clean restart. The
test configuration had no remote-write destinations or Alertmanager receivers.
The canary and copied data volume were removed. Production data was untouched.

Remaining scanner findings:

- Trivy: two UNKNOWN findings, GO-2026-5932 in x/crypto 0.57.0, one per binary.
- Grype: three HIGH findings in upstream BusyBox 1.38.0:
  CVE-2026-38753, CVE-2026-38754 and CVE-2026-38755. Its report lists no fixed
  version. BusyBox was retained; no findings were suppressed.

## Grafana

Official release metadata identifies
[Grafana 13.2.2](https://github.com/grafana/grafana/releases/tag/v13.2.2).
The candidate preserves upstream Grafana and its bundled plugins, applies
Alpine package updates and restores runtime UID 472. Its package inventory is
included in `/usr/share/docker-dash/grafana/alpine-packages.txt`.
In particular, libcrypto3 and libssl3 moved from 3.5.7-r0 to 3.5.8-r0. The four
critical matches reported by Grype for the original image are absent from the
new scan. Package repositories are time-dependent; each future build needs a
new scan and image-identity check.

```sh
docker build --target production \
  -f docker/observability/grafana/Dockerfile \
  -t docker-dash-grafana:13.2.2-dd.1 .
```

Following the [Grafana upgrade guidance](https://grafana.com/docs/grafana/latest/upgrade-guide/upgrade-v13.0/),
a post-password-rotation LAN backup was restored to an isolated disposable
volume and upgraded through 11.6.16, 12.4.11 and 13.2.2. The existing signed
Logs Drilldown plugin was upgraded from 1.0.10 to
[2.5.2](https://grafana.com/api/plugins/grafana-lokiexplore-app/versions/2.5.2)
after the 11.6 stage. This retained the plugin instead of removing functionality
to reduce scanner output.

Every stage preserved account fingerprints, three dashboard/folder records,
the datasource UID and alert-rule counts. SQLite integrity stayed `ok`, no
migrations failed, health/login endpoints responded, and three UI assets loaded.
The final migration count was 732. Grafana migration containers had no network
access; only the separate plugin-install helper could reach the plugin service.
The sequence passed for both the stock final image and the patched candidate.
The patched candidate also passed all seven fresh-install bootstrap checks.
These are backend/data/asset checks, not a full interactive dashboard review.

Remaining patched-image findings:

| Scanner | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Trivy | 0 | 102 | 27 | 23 | 6 |
| Grype | 0 | 69 | 30 | 23 | 0 |

Many findings concern Go dependencies in Grafana and bundled backend plugins;
updating Alpine does not rebuild those binaries. No scanner exceptions were
added. Zero critical findings does not establish that the image is secure.

## Evidence and outstanding deployment work

The [machine-readable evidence](2026-09-20-observability-candidates.json)
records image/config identities, scanner findings and native test results.
Both scanners' ordered filesystem layers were checked against Docker inspect.
Exported OCI manifest and configuration bytes were hashed, their digest
relationship verified, and Grype's configuration identity matched to the
scanned image. This avoids assuming that manifest and configuration digests
are interchangeable.

Before promotion, resolve or explicitly assess the remaining vulnerabilities,
test against the VPS backup, take fresh rollback snapshots and verify live
scrapes after deployment. Grafana also needs an authenticated dashboard/query
check against Prometheus. Future Compose settings must retain the deployed
bootstrap guard and authenticated monitoring credentials. The app's pending
full authentication migration will revoke legacy collector keys, requiring
new collector keys during that rollout.
