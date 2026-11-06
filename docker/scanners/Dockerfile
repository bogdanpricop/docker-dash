FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
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
