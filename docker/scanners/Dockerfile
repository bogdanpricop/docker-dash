FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
COPY docker/scanners/build.sh /build.sh
WORKDIR /src/grype
COPY docker/scanners/grype/go.mod docker/scanners/grype/go.sum ./
RUN sh /build.sh grype
WORKDIR /src/trivy
COPY docker/scanners/trivy/go.mod docker/scanners/trivy/go.sum ./
RUN sh /build.sh trivy
WORKDIR /src/docker-cli
COPY docker/scanners/docker-cli/go.mod docker/scanners/docker-cli/go.sum ./
COPY docker/scanners/build-cli.sh /build-cli.sh
RUN sh /build-cli.sh
WORKDIR /src/compose
COPY docker/scanners/compose/go.mod docker/scanners/compose/go.sum ./
COPY docker/scanners/build-compose.sh /build-compose.sh
RUN sh /build-compose.sh

FROM scratch AS artifacts
COPY --from=build /out/ /
