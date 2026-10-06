# Scanner security rebuilds

These build modules use upstream Trivy 0.75.0 and Grype 0.120.1 source
with fixed dependency versions and Go 1.27.1. The root Dockerfile consumes this
build stage. Integration alone is not a claim that the production image is clean;
the final image vulnerability gate remains mandatory.
The same artifact stage also builds Docker CLI 29.8.2 from its verified upstream
module with Go 1.27.1 and pinned gRPC/telemetry updates. Its version is
`29.8.2+dd.2`; `build-cli.sh` records its source and binary provenance separately.
Compose 5.6.0 is also rebuilt from its verified upstream module, without source
patches, using containerd 2.4.1 and x/crypto 0.57.0. Its version is `5.6.0+dd.2`.
`build-compose.sh` runs the upstream Compose lifecycle/API/CLI unit tests with
the selected dependencies before compiling with the official `e2e` build tag.
Its binary is installed at `/usr/libexec/docker/cli-plugins/docker-compose`;
source checksum, dependency graph, build module, license and binary hash live
alongside the other provenance files. `scripts/smoke-compose-image.js` validates
an immutable image against a real Docker daemon in a disposable Compose project.
This update does not constitute an exception for scanner findings in other tools.
Application versions carry `+dd.2`. Embedded Go metadata retains the upstream
module version/checksum and the actual dependency versions.

Trivy 0.75.0 includes the Go 1.27 `json.SkipFunc` to
`errors.ErrUnsupported` migration upstream, so the prior compiler overlay has
been removed. The build runs the upstream JSON/parser tests and the gRPC
missing-authority regression test before emitting Trivy.

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
