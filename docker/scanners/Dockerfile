FROM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
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
