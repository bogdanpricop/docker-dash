# Scanner security rebuilds

These build modules use upstream Trivy 0.74.0 and Grype 0.119.0 source
with fixed dependency versions and Go 1.27.1. The root Dockerfile consumes this
build stage. Integration alone is not a claim that the production image is clean;
the final image vulnerability gate remains mandatory.
The same artifact stage also builds Docker CLI 29.7.2 from its verified upstream
module with Go 1.27.1 and pinned gRPC/telemetry updates. Its version is
`29.7.2+dd.1`; `build-cli.sh` records its source and binary provenance separately.
Application versions carry `+dd.1`. Grype's embedded Go metadata retains the
upstream module version/checksum and actual dependency versions. Trivy discloses
an explicit local source replacement; its verified upstream identity and patched
files are included separately in the build artifacts.

Trivy additionally requires the documented Go 1.27 JSON migration from
`json.SkipFunc` to `errors.ErrUnsupported` in two source files. A source-hash-checked
compiler overlay applies the compatibility changes to a verified source copy,
without modifying the module cache. The patched files are included in the
artifacts for review. The source module's Go directive is also raised from 1.26.3
to 1.27.1 to enable the new standard library API. All three upstream files have
fixed expected hashes; an unexpected source version aborts the build.
The build runs the upstream JSON/parser tests and the gRPC missing-authority
regression test before emitting Trivy.

Build from the repository root:

```sh
docker build -f docker/scanners/Dockerfile --target artifacts -t docker-dash-scanners:audit .
```

The artifact image contains the binaries, licenses, source checksum metadata,
actual dependency package graphs, Go build information and binary SHA-256 files.
It has no executable entrypoint. The production image includes provenance and
licenses under `/usr/share/docker-dash/scanners`, and binaries under
`/usr/local/bin`. Functional and vulnerability verification are required before
publishing the candidate image.

The source module checksums and release commits are pinned in `build.sh`.
`go.mod`/`go.sum` describe the complete build selection; builds use readonly
module resolution. Updating these locks requires comparing with the named
upstream release, rebuilding, and verifying image scanning and the security gate.

An absent function in the ELF pclntab is only supporting evidence because Go may
inline functions. For code-not-present findings, also inspect the package graph
from the same build. Do not apply an exception to a different binary hash.
