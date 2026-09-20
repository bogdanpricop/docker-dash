FROM golang:1.27.1-alpine@sha256:4cb7ac979db5fcc41cae44b2227ba5ab8a51e8807f40d9ba4dee20a0ad960b5b AS build
RUN apk add --no-cache bash gzip
WORKDIR /build
COPY docker/observability/prometheus/go.mod docker/observability/prometheus/go.sum ./
COPY docker/observability/prometheus/build.sh /build-prometheus.sh
RUN sh /build-prometheus.sh

FROM prom/prometheus:v3.14.0@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0 AS production
COPY --from=build /out/prometheus /out/promtool /bin/
COPY --from=build /out/provenance/ /usr/share/docker-dash/prometheus/
LABEL org.opencontainers.image.version="3.14.0+dd.1" \
      com.docker-dash.security-rebuild="prometheus-3.14.0-dependencies"
