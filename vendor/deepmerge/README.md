# Patched deepmerge for Jest

This package contains the CommonJS build of [deepmerge 4.3.1](https://github.com/TehShrike/deepmerge/tree/v4.3.1) under its original MIT license. The root npm override uses it only for Jest configuration.

The fix for [CVE-2026-93753](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) rejects prototype keys on both sides of the merge, defines own properties directly and treats a failed property lookup as unsafe. The changes follow the remediation described by [waydeshi in upstream issue #273](https://github.com/TehShrike/deepmerge/issues/273). The Jest regression test covers both vulnerable paths and ordinary configuration merges.

Remove the override and this directory when a fixed upstream release is available and supported by Jest, or when Jest no longer uses deepmerge.
