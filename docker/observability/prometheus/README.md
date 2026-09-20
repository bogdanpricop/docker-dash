# Prometheus security rebuild candidate

This directory builds Prometheus 3.14.0 with Go 1.27.1 and a locked dependency
graph. It is a tested candidate, not the default Compose image or a declaration
that all known vulnerabilities are fixed. See the
[audit evidence](../../../docs/audits/2026-09-20-observability-candidates.md).

From the repository root:

```sh
docker build --target production \
  -f docker/observability/prometheus/Dockerfile \
  -t docker-dash-prometheus:3.14.0-dd.1 .
```

The build verifies the upstream Go module checksum and the release UI archive's
SHA-256, generates the upstream embedded UI assets, then compiles both
`prometheus` and `promtool` with `-mod=readonly`. It tests gRPC's missing
authority/Host-header regression before compiling the application. The locked
gRPC 1.83.2 version is intentional; blindly choosing the highest available
version is not a substitute for advisory and regression checks.

Go build metadata, binary checksums, dependency locks, source identity, UI digest
and upstream notices are included under `/usr/share/docker-dash/prometheus/`.
Only the two binaries and this evidence are added to the upstream runtime image;
its user, entrypoint, certificates and other runtime utilities are retained.

The source module is copied into a local replacement for UI asset generation;
the shared Go module cache is not modified. The replacement is disclosed in the
embedded build metadata. Module source revision:
`d7598b7141418fa35be2b5ec5d0fefb634199610`.

Image inputs and Go dependencies are pinned. Builder Alpine packages are fetched
from its configured repositories, so this is not a promise of bit-identical
rebuilds at an arbitrary future date. Scan each built image and verify its
identity. Never replace a production image solely because this build succeeds.
