# Image admission for safe updates and pipelines

The current safe-update and pipeline code treats scanner failure as success,
scans a mutable tag through the local CLI default endpoint and recreates the
container from that mutable tag. The selected remote daemon may therefore run an
image different from the scanned image. This change closes all three paths.

- After pull, retain and validate the immutable image ID from the selected
  Docker client. Export that ID through the same client's image archive API.
- Scan the archive with Trivy using explicit vulnerability-only configuration,
  bounded export bytes, bounded output, timeouts and private temporary files.
  Remove all temporary files on success and failure. Never shell-interpolate
  image names or credentials.
- Require a schema-2 container-image report with a cryptographically bound metadata config ID
  and nonempty recognized inventory. Validate vulnerability records and severity.
  Critical, high and unknown severity findings block admission. Empty/malformed
  output, unsupported inventory, missing scanner, timeout and export errors block.
- Recreate using the admitted immutable ID, even if the original tag changes.
  Denial happens before stopping/removing the original container; persist audit
  evidence for denial. Explicit pipeline skip-scan remains an explicit override,
  never a fallback from a failed required scan.
- Tests must prove no stop/remove/create occurs on scanner failure or denial,
  the selected Docker client's exact image is exported, report identity mismatch
  is rejected, temp files are removed and the admitted image ID is deployed.

This admission change does not close the separate transactional swap/rollback,
concurrent operation locking or scanner-binary supply-chain findings.

Docker classic IDs identify configuration blobs; Docker 29 containerd IDs can
identify OCI manifests or indexes. Parse bounded archive metadata without path
extraction and verify SHA-256 at each link from the selected immutable ID to its
configuration. Select exactly one matching OS/architecture/variant from indexes,
and pass that platform explicitly to Trivy. Reject missing, duplicate, tampered,
ambiguous or mismatched metadata before scanning. The deployment ID remains the
original Docker ID, while the report must identify its verified config digest.

Verification must also fail the entire pipeline when the replacement exits,
becomes unhealthy or cannot be inspected. A stopped original remains stopped and
has verification explicitly skipped. Failed audit persistence cannot be reported
as a successful pipeline.

## Independent scanner requirement (20 September audit)

A real Alpine control image passed Trivy but Grype detected CVE-2026-85091 in
zlib. Required admission must therefore obtain valid reports from both Trivy and
Grype, using the same exported archive, verified config digest and platform.
There is no fallback from one engine to another. Critical, High or Unknown in
either report denies admission, including unfixed vulnerabilities.

Run scanners sequentially to retain the two-process concurrency bound. The
overall deadline is eight minutes, with a three-minute process limit for each
scanner. Keep the export and temporary-file limits. Remove scanner environment
overrides and provide private explicit configurations, with no user filters,
ignore rules or VEX documents. Grype is limited to Docker/OCI archive providers;
it must not resolve a registry tag or use the local daemon.

Validate Grype's engine identity, bound image config ID, valid database metadata
and freshness (120 hours, five minutes of forward clock tolerance). Require a
recognized database schema and an unfiltered configuration. Reject ignored
matches and malformed finding records. Keep separate per-engine evidence.
Combined severity totals count scanner findings, not unique vulnerabilities;
the same vulnerability can occur in both reports. Missing or unverified evidence
denies admission even if the other scanner reports zero findings.

Regression coverage must include engine disagreement, either engine missing or
failing, malformed/mismatched Grype reports, stale databases, unknown severity,
configuration/environment bypasses, shared-archive identity and cleanup. Real
Docker verification must demonstrate both a dual-engine clean control and a
Trivy-clean/Grype-blocked image without stopping existing workloads.
