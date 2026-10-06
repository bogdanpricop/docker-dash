FROM golang:1.27.1-alpine@sha256:4cb7ac979db5fcc41cae44b2227ba5ab8a51e8807f40d9ba4dee20a0ad960b5b AS build
RUN apk add --no-cache bash gzip
WORKDIR /build
COPY docker/observability/prometheus/go.mod docker/observability/prometheus/go.sum ./
COPY docker/observability/prometheus/build.sh /build-prometheus.sh
RUN sh /build-prometheus.sh
RUN CGO_ENABLED=0 go list -mod=readonly -deps -tags netgo,builtinassets github.com/prometheus/prometheus/cmd/prometheus > /out/provenance/prometheus.packages.txt \
    && CGO_ENABLED=0 go list -mod=readonly -deps -tags netgo,builtinassets github.com/prometheus/prometheus/cmd/promtool > /out/provenance/promtool.packages.txt
COPY docker/observability/prometheus/verify-surface.go /verify-surface.go
RUN go run /verify-surface.go && cp /verify-surface.go /out/provenance/

FROM prom/prometheus:v3.15.0@sha256:86b17a25c2db1d16a61b16b3c8f336679eb19e26333d03e808da387206e40faa AS upstream

FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS busybox-test
RUN apt-get update && apt-get install -y --no-install-recommends build-essential bzip2 ca-certificates curl patch \
    && rm -rf /var/lib/apt/lists/*
COPY --from=upstream /bin/busybox /reference/busybox
COPY docker/observability/prometheus/busybox/patches/ /patches/
COPY docker/observability/prometheus/busybox/patches.json /patches.json
COPY docker/observability/prometheus/busybox/alpine-3.24.config /alpine-3.24.config
COPY docker/observability/prometheus/busybox/build.sh /build-busybox.sh
COPY docker/observability/prometheus/busybox/regression.sh /regression.sh
RUN sh /build-busybox.sh
COPY docker/observability/prometheus/busybox/asan-check.sh /asan-check.sh
RUN sh /asan-check.sh

FROM golang:1.27.1-alpine@sha256:4cb7ac979db5fcc41cae44b2227ba5ab8a51e8807f40d9ba4dee20a0ad960b5b AS busybox-build
RUN apk add --no-cache build-base linux-headers curl bzip2 patch diffutils
COPY --from=upstream /bin/busybox /reference/busybox
COPY --from=busybox-test /out/busybox/ /out/busybox/
COPY docker/observability/prometheus/busybox/patches/ /patches/
COPY docker/observability/prometheus/busybox/patches.json /patches.json
COPY docker/observability/prometheus/busybox/alpine-3.24.config /alpine-3.24.config
COPY docker/observability/prometheus/busybox/build.sh /build-busybox.sh
COPY docker/observability/prometheus/busybox/regression.sh /regression.sh
RUN BUSYBOX_STATIC=1 sh /build-busybox.sh

FROM upstream AS production
COPY --from=build /out/prometheus /out/promtool /bin/
COPY --from=build /out/provenance/ /usr/share/docker-dash/prometheus/
COPY --from=busybox-build /out/busybox.bin /tmp/busybox
COPY --from=busybox-build /out/busybox/ /usr/share/docker-dash/busybox/
USER root
# Official BusyBox applets are hardlinks. Replace every applet reference, not
# only /bin/busybox, or sh/awk could continue to execute the old binary.
RUN /tmp/busybox sh -ec '/tmp/busybox cp /tmp/busybox /bin/busybox; for applet in $(/bin/busybox --list); do /bin/busybox ln -sf /bin/busybox "/bin/$applet"; done; /bin/busybox rm /tmp/busybox'
USER nobody
LABEL org.opencontainers.image.version="3.15.0+dd.4" \
      com.docker-dash.security-rebuild="prometheus-dependencies-and-busybox-backports"
