# Keep the official Grafana release, update its OS packages, and reduce the
# bundled backend-plugin surface to the Prometheus datasource used here.
FROM grafana/grafana:13.2.3@sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572 AS upstream

FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS busybox-build
RUN apk add --no-cache build-base linux-headers curl bzip2 patch diffutils
COPY --from=upstream /bin/busybox /reference/busybox
COPY docker/observability/prometheus/busybox/patches/ /patches/
COPY docker/observability/prometheus/busybox/patches.json /patches.json
COPY docker/observability/prometheus/busybox/alpine-3.24.config /alpine-3.24.config
COPY docker/observability/prometheus/busybox/build.sh /build-busybox.sh
COPY docker/observability/prometheus/busybox/regression.sh /regression.sh
RUN BUSYBOX_REFERENCE_PROFILE=grafana BUSYBOX_STATIC=1 sh /build-busybox.sh

FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS grafana-build
RUN apk add --no-cache build-base curl
WORKDIR /build
RUN curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      -o /tmp/grafana.tar.gz \
      https://codeload.github.com/grafana/grafana/tar.gz/refs/tags/v13.2.3 \
    && echo '8e31ab62f206cc2d4964373bf0c3502793210aba50a11cc3ff2f0db790cedab0  /tmp/grafana.tar.gz' | sha256sum -c - \
    && mkdir source \
    && tar -xzf /tmp/grafana.tar.gz --strip-components=1 -C source
WORKDIR /build/source
COPY docker/observability/grafana/core/go.mod docker/observability/grafana/core/go.sum ./
COPY docker/observability/grafana/core/build.sh /build-grafana.sh
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    sh /build-grafana.sh

FROM upstream AS prometheus-plugin
ARG TARGETARCH
USER root
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) digest='d24df3eaff9ae61f00d7e857f508fc306912dcf50d657150d1e472e851799fc4' ;; \
      arm64) digest='24db8e4d28c836b8f61da6addce0d8f3d498ae1759ca419938f995323e359342' ;; \
      s390x) digest='4fa587d2ca8f0f49242a89d55a7db846099a4f528d0b1d25f458d249122a3bf4' ;; \
      *) echo "Unsupported Grafana plugin architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    asset="prometheus-13.2.5.linux_${TARGETARCH}.zip"; \
    url="https://github.com/grafana/grafana-prometheus-datasource/releases/download/v13.2.5/${asset}"; \
    wget -q -O /tmp/prometheus.zip "$url"; \
    echo "$digest  /tmp/prometheus.zip" | sha256sum -c -; \
    mkdir -p /tmp/plugin /tmp/provenance; \
    unzip -q /tmp/prometheus.zip -d /tmp/plugin; \
    test "$(sed -n 's/.*\"version\": \"\([^\"]*\)\".*/\1/p' /tmp/plugin/prometheus/plugin.json | head -1)" = '13.2.5'; \
    test -x /tmp/plugin/prometheus/gpx_grafana-prometheus-datasource_linux_${TARGETARCH}; \
    printf '%s  %s\n' "$digest" "$asset" > /tmp/provenance/prometheus-plugin-asset.sha256; \
    printf '%s\n' "$url" > /tmp/provenance/prometheus-plugin-source.txt; \
    find /tmp/plugin/prometheus -type f -exec sha256sum {} + | sort > /tmp/provenance/prometheus-plugin-files.sha256

FROM upstream AS production
USER root
RUN apk upgrade --no-cache \
    && rm -rf /usr/share/grafana/data/plugins-bundled/* \
    && mkdir -p /usr/share/docker-dash/grafana \
    && apk info -v | sort > /usr/share/docker-dash/grafana/alpine-packages.txt \
    && chmod 755 /usr/share/docker-dash /usr/share/docker-dash/grafana \
    && chmod 644 /usr/share/docker-dash/grafana/alpine-packages.txt
COPY --from=prometheus-plugin --chown=472:0 /tmp/plugin/prometheus/ /usr/share/grafana/data/plugins-bundled/prometheus/
COPY --from=prometheus-plugin /tmp/provenance/ /usr/share/docker-dash/grafana/
COPY --from=grafana-build --chown=472:0 /out/grafana /usr/share/grafana/bin/grafana
COPY --from=grafana-build /out/provenance/ /usr/share/docker-dash/grafana/core/
COPY --from=busybox-build /out/busybox.bin /tmp/busybox
COPY --from=busybox-build /out/busybox/ /usr/share/docker-dash/busybox/
RUN chmod 755 /usr/share/grafana/bin/grafana \
    && chmod 755 /usr/share/grafana/data/plugins-bundled/prometheus \
    && find /usr/share/grafana/data/plugins-bundled/prometheus -type d -exec chmod 755 {} + \
    && find /usr/share/grafana/data/plugins-bundled/prometheus -type f -exec chmod 644 {} + \
    && chmod 755 /usr/share/grafana/data/plugins-bundled/prometheus/gpx_* \
    && chmod 644 /usr/share/docker-dash/grafana/prometheus-plugin-* \
    && chmod -R a+rX /usr/share/docker-dash/grafana/core \
    && /tmp/busybox sh -ec '/tmp/busybox cp /tmp/busybox /bin/busybox; for applet in $(/bin/busybox --list); do /bin/busybox ln -sf /bin/busybox "/bin/$applet"; done; /bin/busybox rm /tmp/busybox'
USER 472
ENV GF_PLUGINS_PREINSTALL_DISABLED=true \
    GF_PATHS_PLUGINS=/var/lib/grafana/reviewed-plugins
LABEL org.opencontainers.image.version="13.2.3+dd.4" \
      com.docker-dash.security-patch="grafana-dependencies-busybox-and-bundled-plugin-refresh" \
      com.docker-dash.bundled-datasources="prometheus"
