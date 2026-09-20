FROM golang:1.27.1-alpine AS build
COPY docker/scanners/build.sh /build.sh
COPY docker/scanners/trivy-json-compat.go /trivy-json-compat.go
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

FROM scratch AS artifacts
COPY --from=build /out/ /
