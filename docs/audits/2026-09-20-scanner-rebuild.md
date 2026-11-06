# Scanner rebuild validation, 20 September 2026

The production Dockerfile now builds Trivy 0.74.0 and Grype 0.119.0 from verified
upstream source with pinned security updates, using Go 1.27.1. Versions include
`+dd.1` to distinguish these binaries from upstream release downloads. Docker
Scout is excluded by the [confirmed product decision](2026-09-20-scout-exclusion.md).

## Checks completed before the Linux image build

- Linux amd64 cross-compilation of both scanners succeeded.
- Both scanners ran an actual Docker image scan in disposable controllers on the
  authorized LAN test daemon. Trivy reported zero vulnerabilities in the egress
  builder image; Grype reported four matches. This difference is not treated as
  proof that either scanner failed, or as a clean bill for the production image.
  Grype's matches are CVE-2026-85091 (High, zlib 1.3.2-r0) and CVE-2025-60876
  (Medium, busybox, busybox-binsh and ssl_client 1.37.0-r31). The builder has Alpine
  packages; the separate egress runtime uses scratch. Do not transfer this finding
  to the scratch runtime without checking its actual inventory. The application
  image must be checked with both scanners. CI now runs both security gates.
  The [Alpine 3.24 package recipe](https://raw.githubusercontent.com/alpinelinux/aports/3.24-stable/main/zlib/APKBUILD)
  still selects zlib 1.3.2-r0 without a patch for CVE-2026-85091. The
  [Ubuntu security team's analysis](https://ubuntu.com/security/CVE-2026-85091)
  explains that the initially suggested upstream change did not fix the reproducer.
  Updating packages alone therefore does not establish remediation; no exclusion
  or unverified source patch was applied for this finding.
- Trivy's upstream JSON wrapper and CloudFormation parser tests passed with its
  two source compatibility patches and updated Go directive. The generator checks
  original source hashes and fails on an unexpected file or directive.
- The exact selected gRPC 1.84.0 dependency passed its upstream
  `Test/MissingAuthorityAndHostHeader` regression test.
- Application tests: 344 suites passed, 4,291 tests passed, one skipped. Lint and
  JavaScript syntax checks passed. Scout explanations and available scanner choices
  passed actual browser checks under CSP in English and Romanian.

## Remaining raw Go vulnerability findings

The [machine-readable evidence](2026-09-20-scanner-rebuild-evidence.json) identifies
the scanner binary hashes and package inventories. The actual Linux image
artifacts match both cross-compiled binaries byte for byte and contain the same
compiled package graphs. It is audit evidence, not
an ignore list. A `govulncheck -json` exit status of zero does not mean no findings;
the JSON findings were parsed explicitly.

Grype retains six advisory IDs in the module-based output: five Docker daemon
advisories and GO-2026-5932 against deprecated OpenPGP. Their affected packages
are absent from the same build's compiled dependency graph. Function-table checks
also found none of those namespaces; the package graph is necessary because
absence of a function alone cannot rule out inlining.

Trivy retains three advisory IDs:

- GO-2026-5932: the affected OpenPGP packages are absent from its compiled graph.
- GO-2026-6443 / CVE-2026-84445: gRPC packages are present, so this is not a
  code-absent case. The [upstream advisory](https://github.com/grpc/grpc-go/security/advisories/GHSA-2v4p-qf9q-27wj)
  identifies versions through 1.83.1 as affected and documents the early rejection
  fix. Selected 1.84.0 contains that fix and passes the upstream regression test.
  Its `internal/transport/http2_server.go` SHA-256 is
  `6ff2da17e276ba22a782dffe467ec32b664895d12faccfbb5fc1ec40d59cdcf6c`.
  The Go vulnerability database's broader version interval conflicts with this
  upstream evidence.
- GO-2026-4919 / CVE-2026-33634: the [upstream supply-chain advisory](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)
  concerns specific compromised March releases and states the malicious code
  was not in the main source branch. This build uses verified v0.74.0 source,
  not the affected release binaries. The unbounded Go database interval needs
  artifact-specific interpretation.

No global exclusions were added. The final Linux image needs its own hashes,
functional checks and complete vulnerability scan; the publication gate remains
enabled until applicable High/Critical/Unknown findings are resolved.

## Initial Linux candidate

Built and tested image:
`sha256:a64f40b88ce0d1bafa8c4119c61e10754fb66bc78b61c32c7709f4aad2937e2c`.
Startup, SQLite migrations, HTTP health, restart secret persistence, 0600 secret
permissions, safe dotenv parsing and explicit environment precedence passed.
Both scanners ran against the image, their installed SHA-256 values matched
build provenance, and Scout was absent. The real admission canary blocked the
previous vulnerable application image and accepted the Trivy-clean control image.
All test controllers were removed after their checks.

[Trivy raw findings](2026-09-20-rebuilt-image-vulnerabilities.json): 3 High,
2 Medium, 2 Unknown (7 total), compared with 76 findings in the earlier image.
[The independent Grype scan](2026-09-20-scanner-image-functional.json) reports
1 Critical, 22 High, 17 Medium and 5 Low (45 matches). These counts must not be
combined or presented as a clean image: scanners use different inventories,
advisory sources and matching logic. Grype findings require location/version
analysis beyond the two rebuilt scanner binaries.

The candidate was not published or deployed. CI runs both vulnerability gates
before registry login. No global vulnerability exclusions were introduced.

## Follow-up: bundled Docker tools and GNU wget

The detailed [Grype location report](2026-09-20-grype-image-vulnerabilities.json)
identified the Critical alert in Alpine Compose 5.1.4 (`golang.org/x/crypto` 0.48.0),
plus additional outdated libraries in that binary. The Dockerfile now selects
[Compose 5.5.1](https://github.com/docker/compose/releases/tag/v5.5.1), verifying
GitHub's SHA-256 asset digest for amd64 or arm64. Its amd64 binary embeds Go 1.26.8
and x/crypto 0.56.0, fixing the reported Critical advisory. Raw govulncheck output
for that binary retains GO-2026-5932 and GO-2026-6444; zero matching OpenPGP/CRI
function symbols are supporting evidence only, not sufficient for an exemption.

Alpine Docker CLI 29.5.3 also predates the go-archive extraction fix for
[CVE-2026-17106](https://github.com/moby/go-archive/security/advisories/GHSA-hfg8-hc9c-6c3h).
An intermediate candidate copied the CLI binary from official `docker:29.7.2-cli`,
pinned by multi-platform manifest digest
`sha256:3f4743208d2338c934d7b8bcfbe1bb54c0b2355c510ad5e0f31c0c4a54bd704e`,
and includes its Apache license.

The unused GNU wget package has been removed; the image healthcheck uses the
already-installed curl. The Proxmox migration service's remote wget command is
unchanged because it runs on the provider host. BusyBox remains a separate Alpine
component; removing GNU wget is not a claim to fix its advisory.

Startup verification now checks the selected Docker CLI/Compose versions, offline
Compose configuration parsing and the curl health probe. The final updated
candidate still requires both image vulnerability scans before release.

The intermediate official CLI image embedded Go 1.26.5 and reintroduced eight
stdlib alerts in Trivy. It was therefore superseded by a source build of Docker
CLI 29.7.2 with Go 1.27.1 and patched gRPC/telemetry dependencies, using the verified
upstream module checksum `h1:dlkwallR8XqfeVnA2ELEhdwvb4lsSwuB4IgsG8Q9cLY=` and
commit `a7dcaa6fdb6ed04aacbfdc76357fdae01605609e`. Its version is explicitly
`29.7.2+dd.1`; the source metadata, dependency graph, build information, license and
binary digest are included alongside scanner provenance. This avoids treating
an official release version as proof that its compiler is up to date.

## Latest validated candidate and release verdict

Final candidate after the CLI/Compose changes:
`sha256:85bb9f5e662c7877b062a894b1b951590b35a602f0090fada2395e228439cd33`.
The [final paired scan report](2026-09-20-final-image-vulnerabilities.json) contains
all findings, package versions and affected paths without suppressions:

| Scanner | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Trivy 0.74.0+dd.1 | 0 | 4 | 3 | 0 | 3 |
| Grype 0.119.0+dd.1 | 0 | 4 | 6 | 0 | 0 |

Grype fell from 45 to 10 matches after updating Compose, removing GNU wget and
rebuilding Docker CLI. Trivy reports ten raw matches after cataloging the new
standalone CLI and Compose binaries. The remaining Go findings need the precise
applicability evidence above; they were not globally ignored. CVE-2026-85091 in
Alpine zlib remains unresolved. Medium findings in BusyBox and nghttp2 are also
retained. No claim that all image vulnerabilities are fixed is justified.

Docker CLI's installed binary hash is
`7e54c86884f89d4e08881648a25c2abbce0e206231974990ce8c49e91a84d0c9`.
It matches build provenance and reports Go 1.27.1 in binary metadata. Its raw
binary govulncheck finding set is only GO-2026-6443 (the gRPC database interval
issue documented above); the old compiler findings are gone.

The latest candidate again passed production startup, SQLite/HTTP health,
Docker CLI 29.7.2+dd.1 and Compose 5.5.1 version checks, offline Compose parsing,
curl health probing and secret persistence/precedence checks. All audit/smoke
controllers are removed. Existing host workloads were not replaced, and neither
image publication nor live daemon hardening was performed. The independent
Trivy and Grype publication gates remain enabled and block this candidate.
