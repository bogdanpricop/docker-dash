# containerd manifest validation in standard scanner builds

The image gate detected CVE-2026-95839 in the standard Trivy and Compose dependency graphs during AI Compute host-selection validation. The [containerd advisory](https://github.com/containerd/containerd/security/advisories/GHSA-vwhp-8p66-mq4f) describes a panic when a malformed child digest reaches manifest-subject label processing. The upstream fix validates the digest before truncating it.

Both build modules now require containerd **v2.4.2**, with its module checksum in `go.sum`. The affected `core/images` package is compiled into these utilities, so a package-absence exception would be inappropriate. No exception was added for this advisory.

Build evidence:

* Go **1.27.4**, `CGO_ENABLED=0`, the existing trimpath/build flags and verified upstream source checksums.
* Both build scripts run `TestSetChildrenMappedLabelsMalformedDigest` from the selected dependency, including short, missing and empty digests and a valid-digest control.
* Existing Compose lifecycle/API/CLI tests and Trivy JSON/parser/gRPC regressions run before compilation.
* Trivy `0.75.0+dd.3`: SHA-256 `51af5012a8c06710f1d427a9c03400ddfa89b8e4578124be886c41c694b2986a`.
* Compose `5.6.0+dd.3`: SHA-256 `055f2a083b1904b1f1e91072e72ee3caca898b24a0b8846f8251e812f8d4d9da`.

The reviewed artifact ledger records the new binary/build-info hashes and explicitly checks the compiled containerd version and checksum. Compiled-package inventories and upstream-source hashes are unchanged. Existing OpenPGP code-absence rules retain their scope and expiry; only their exact artifact hashes follow the newly reviewed binaries. The final image gate still rejects new High/Critical findings and unreviewed unknown findings.

The LAN/VPS deployment bases already contain newer maintenance builds, Trivy `0.76.2+security-20261118` and Compose `5.8.0+security-20261118`, with containerd v2.4.2. Those installed utilities are retained rather than replaced by older upstream utility releases. The standard repository build is corrected independently. Both actual deployment candidates were scanned by Trivy and Grype with no blocking findings.
