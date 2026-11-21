# OpenSSL November 2026 CVE review — apk openssl 3.5.9-r1

**Date:** 2026-11-21 · **Scope:** `openssl`, `libssl3`, `libcrypto3` 3.5.9-r1 (Alpine 3.24)
in the production image · **Outcome:** five grype HIGH findings reviewed as
`vulnerable_code_not_present`, time-boxed to 2026-12-20.

## Context

Grype began blocking the image gate on 2026-11-21 with five CVEs against the
Alpine OpenSSL packages. No fixed apk exists: Alpine's latest build is
3.5.9-r1 (2026-11-18), the Alpine security tracker lists no fixed version for
any of them, and upstream fixes land in OpenSSL 3.5.10, scheduled for
**1 December 2026** (per the 2026-11-17 advisory). The previous November
findings were resolved by requiring 3.5.9-r1; these are newer CVEs against
that same build.

## Why the image is not affected

The Node.js runtime (`node:24.22.3-alpine`) statically bundles its own
OpenSSL — the application's TLS, crypto and HTTP stacks never touch the apk
`libssl3`/`libcrypto3`. The apk OpenSSL serves only `curl` (container
healthcheck to localhost), `git` (HTTPS fetches of user-configured repos),
`openssh-client` (SSH; libcrypto primitives only, no TLS) and `apk-tools`
(raw RSA index signatures). None of those exercises the vulnerable code paths:

| CVE | Vulnerable component (upstream) | Why unreachable here |
|---|---|---|
| CVE-2026-107493 | UAF in `PEM_X509_INFO_read_bio_ex()` **only when the caller passes a pre-populated stack**; OpenSSL's own callers pass NULL (OpenSSL severity: Low, advisory 2026-11-17) | No consumer calls `PEM_X509_INFO_read*` with a caller-supplied stack |
| CVE-2026-124709 | QUIC **server** memory retention for policy-rejected streams (OpenSSL severity: Low, advisory 2026-11-17) | Nothing in the image runs an OpenSSL QUIC server |
| CVE-2026-107494 | QUIC stack queues unbounded `RETIRE_CONNECTION_ID` frames (GHSA-9x26-7724-x23j; NVD 9.1, unreviewed) | No consumer is built with OpenSSL QUIC (Alpine curl has no HTTP/3 over OpenSSL QUIC; git/openssh have no QUIC) |
| CVE-2026-121482 | Quadratic CPU when verifying crafted CMS/PKCS#7 SignedData with CRL checking (GHSA-frqh-hqg8-j36v; NVD 7.5) | No consumer verifies CMS/PKCS#7 (apk-tools verifies plain RSA signatures, not CMS) |
| CVE-2026-84786 | NULL deref in a **DANE-enabled** TLS client processing crafted certificate/TLSA combinations (GHSA-fwhc-6r4g-7gqw; NVD 7.5) | No consumer enables DANE/TLSA validation (curl and git do not implement OpenSSL DANE; openssh uses libcrypto only) |

All five are denial-of-service class (no confidentiality or integrity impact
per the published CVSS vectors); OpenSSL itself rates the two it has
triaged as Low.

## Exit condition

The policy exceptions expire on **2026-12-20**. Expected resolution: Alpine
ships an openssl apk with the 3.5.10 backports (upstream release 2026-12-01),
after which the Dockerfile pin moves from `>=3.5.9-r1` to the fixed revision
and the gate's stale-exception check forces removal of these rules.

## Sources

- https://openssl-library.org/news/secadv/20261117.txt (CVE-2026-107493, CVE-2026-124709, fixes in 3.5.10)
- https://github.com/advisories/GHSA-9x26-7724-x23j (CVE-2026-107494)
- https://github.com/advisories/GHSA-frqh-hqg8-j36v (CVE-2026-121482)
- https://github.com/advisories/GHSA-fwhc-6r4g-7gqw (CVE-2026-84786)
- https://security.alpinelinux.org/srcpkg/openssl (no fixed version recorded as of 2026-11-21)
