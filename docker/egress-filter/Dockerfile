# syntax=docker/dockerfile:1
#
# Docker Dash Outbound Network Filter sidecar — v6.7.0-alpha.2
#
# Production image. Ships a single ~5 MB static Go binary that does SNI peek
# + HTTP Host parsing + hostname allowlist check + forward-or-deny.
#
# Multi-arch (amd64 + arm64). Cross-compile pattern validated in preflight P8.
#
# Run (standalone, for manual testing via HTTP_PROXY):
#   docker run --name dd-egress -v /path/to/policy.json:/etc/dd-egress/policy.json:ro \
#     -p 29193:29193 docker-dash-egress-filter:v6.7.0-alpha.2
#
# Integration with Docker Dash (from rc1): docker-compose.yml wires the sidecar
# with SHARED_VOLUME mount + signals SIGHUP on policy changes.

ARG GO_VERSION=1.27.1
ARG BUILDPLATFORM

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY go.mod .
# COPY go.sum . — none yet; stdlib-only for v6.7-alpha.2
COPY *.go ./

# Run the local protocol/security regressions on the builder architecture before
# cross-compiling either production target. No external endpoints are contacted.
RUN CGO_ENABLED=0 go test ./... && go vet ./...

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/dd-egress-proxy .

FROM scratch

COPY --from=build /out/dd-egress-proxy /dd-egress-proxy

# Default config — override via env at runtime
ENV DD_EGRESS_LISTEN=:29193 \
    DD_EGRESS_POLICY_PATH=/etc/dd-egress/policy.json \
    DD_EGRESS_BLOCKLOG_PATH=/var/log/dd-egress/denied.log

EXPOSE 29193

LABEL org.opencontainers.image.source="https://github.com/bogdanpricop/docker-dash"
LABEL org.opencontainers.image.description="Docker Dash Outbound Network Filter sidecar — SNI-based allowlist proxy"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.title="docker-dash-egress-filter"
LABEL org.opencontainers.image.version="6.7.0-alpha.2"

ENTRYPOINT ["/dd-egress-proxy"]
