# Reproducible security rebuilds of bundled scanners

The latest upstream release binaries still embed known vulnerable dependencies:
Grype 0.119.0 was built with Go 1.26.3; Trivy 0.74.0 embeds affected gRPC,
containerd and telemetry dependencies. Updating the release download alone cannot
close the production image findings.

Build the same upstream source releases with Go 1.27.1 and pinned, verified module
overrides. Keep an explicit upstream module checksum and commit, the replacement
go.mod/go.sum files, build flags and a local version suffix so the result is never
misrepresented as the untouched upstream binary. Build without CGO and without
uncontrolled module updates. Preserve scanner licenses in the image.

Before replacing the runtime binaries, require successful compilation, version
output, analysis of the resulting Go module inventory, vulnerability analysis and
an actual image scan through each scanner. Keep the existing image publication
gate enabled; any remaining findings require remediation or a documented,
binary-specific applicability analysis, never a global vulnerability exclusion.

For GO-2026-5932, wildcard package entries from govulncheck do not establish that
OpenPGP functions are present. Inspect the compiled function table and bind any
non-applicability evidence to the exact binary hash. Docker daemon vulnerabilities
reported against a scanner's Docker client SDK require separate symbol and source
analysis; do not infer immunity merely from the word "client".

Docker Scout 1.24.0 is distributed as binaries from its public repository. Its
embedded module github.com/docker/scout-cli-plugin is not available from that
repository or its public module source URL. The handling of this component is a
product decision confirmed on 20 September 2026: temporarily exclude it from the
standard image while keeping Trivy/Grype, with explanations in both supported
source locales and HTTP 503 for explicit Scout requests. Do not
silently replace Scout output with a different engine while retaining its name.

Sources: [Grype release](https://github.com/anchore/grype/releases/tag/v0.119.0),
[Trivy release](https://github.com/aquasecurity/trivy/releases/tag/v0.74.0),
[Scout binaries](https://github.com/docker/scout-cli).
