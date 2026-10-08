# Installed scanner artifact review, 20 September 2026

The four installed Go tools were read through verified SSH forwards from the
running LAN and VPS 8.96.6 containers. Their binary SHA-256 values, compiled
package inventories, build information and source manifests exactly match the
previously reviewed source builds. Neither application was restarted or modified.

Image: `sha256:8bb32b9be7ca066e21fbe1fa09c302c7c5545548d7a226664cecbf6dbb43e5fb`.
The [machine-readable report](2026-09-20-installed-scanner-artifacts.json) contains
both observations, binary hashes and metadata hashes. Its image identity is also
bound to the [8.96.6 scan evidence](2026-09-20-image-8.96.6.json).

| Tool | Version | Compiled package inventory |
| --- | --- | --- |
| Docker CLI | 29.7.2+dd.1 | Exact reviewed binary and metadata |
| Docker Compose | 5.5.1+dd.1 | Exact reviewed binary and metadata |
| Trivy | 0.74.0+dd.1 | Exact reviewed binary and metadata |
| Grype | 0.119.0+dd.1 | Exact reviewed binary and metadata |

## Interpretation of specific findings

These conclusions apply only to the exact installed artifacts in the report.
They are not a vulnerability exemption for other images or for the Docker daemon.

- CVE-2026-84445 / GHSA-2v4p-qf9q-27wj in Docker CLI and Trivy: the selected
  gRPC v1.84.0 module matches the tested source checksum and transport source
  digest. Its upstream `Test/MissingAuthorityAndHostHeader` regression previously
  passed, as recorded in the [rebuild evidence](2026-09-20-scanner-rebuild.md).
  The [upstream advisory](https://github.com/grpc/grpc-go/security/advisories/GHSA-2v4p-qf9q-27wj)
  describes affected versions through 1.83.1 and patched releases 1.83.2/1.82.2.
  The scanner databases' broader version intervals conflict with that source and
  regression evidence. The installed-artifact command verifies the binary and
  provenance binding; it does not rerun the upstream regression test.
- CVE-2026-41567, CVE-2026-42306 and GO-2026-4887 in Grype: the compiled package
  graph contains Docker/Moby client and API types, but none of their daemon,
  API server or plugin implementation packages. The vulnerabilities concern
  [daemon archive handling](https://github.com/moby/moby/security/advisories/GHSA-x86f-5xw2-fm2r),
  [daemon filesystem races](https://github.com/moby/moby/security/advisories/GHSA-rg2x-37c3-w2rh)
  and [daemon AuthZ enforcement](https://github.com/moby/moby/security/advisories/GHSA-x744-4wpc-v9h2).
  This supports a code-absent finding for the exact Grype binary. The reviewed
  namespace check includes both `github.com/docker/docker` and
  `github.com/moby/moby`; client internal packages are allowed, server packages
  are not. It does not infer code absence solely from missing function symbols.
- GO-2026-5932 in Compose, Trivy and Grype: the deprecated
  `golang.org/x/crypto/openpgp` package and all its child packages are absent from
  each compiled graph. The separate ProtonMail OpenPGP implementation is not
  confused with that namespace. See the package-level evidence in the
  [scanner rebuild](2026-09-20-scanner-rebuild-evidence.json) and
  [Compose rebuild](2026-09-20-compose-rebuild.md) reports.

## Findings and release restrictions retained

Raw findings remain **Trivy: 4 High, 2 Medium, 3 Unknown; Grype: 4 High, 5 Medium**.
No Critical findings were reported in these image scans. These are separate
scanner results, not a combined count or a clean-image verdict.

CVE-2026-85091 in the application's Alpine zlib 1.3.2-r0 remains unresolved.
The [Ubuntu security analysis](https://ubuntu.com/security/CVE-2026-85091), updated
16 September, states that the initially proposed change did not fix the
reproducer. This review does not establish that the application's zlib calls
cannot reach the vulnerable code. BusyBox and nghttp2 findings also remain open.
The helper image's smaller package inventory does not remediate the application
image. The exposed LAN Docker API on port 2375 remains a separate critical
operational issue; the package analysis does not change it.

There are no new scanner ignores, VEX exceptions or changes to admission/CI
thresholds. Public image publication remains blocked. Local deployments are the
user-authorized audit checkpoints documented in the
[deployment report](2026-09-20-deployment-8.96.6.md).

## Reproducing the read-only check

Use Node 24.21.0 and the repository dependencies. Forward a loopback TCP port to
the selected host's Docker socket over SSH with host-key verification. Set
`DD_SCANNER_AUDIT_DOCKER_URL` to that loopback HTTP endpoint,
`DD_SCANNER_AUDIT_IMAGE` to the expected immutable image ID and
`DD_SCANNER_AUDIT_CONTAINER` to the container name or ID. Optionally set
`DD_SCANNER_AUDIT_OUTPUT` to a new output file, then run:

```text
node scripts/verify-scanner-artifacts.js
```

The checker streams the actual executable bytes without executing commands in
the application, validates one regular tar entry per requested path, bounds each
transfer and compares the installed metadata to the reviewed lock file. It
checks container identity, running state and start time before and after reading.
A changed artifact fails the check and requires a new source review, not an
automatic update of the expected hashes. A hash match proves equality to the
reviewed build, not that the build or its host is immune to compromise.

The focused tests cover modified binaries/provenance, gRPC/compiler mismatches,
unexpected compiled server packages, deprecated OpenPGP, duplicate/path/type/
oversize archive entries and truncated transfers. All 22 tests passed. Together
with the image-admission and deployment-admission suites, validation passed
145 tests across three suites; repository lint and script syntax passed too.
Both external health endpoints still returned HTTP 200, `ok`, version 8.96.6 at
05:16:26 UTC after this read-only audit.
