# Keep the upstream application and plugins, then apply Alpine security updates.
# Build and scan before deployment; the upstream tag alone is not a security gate.
FROM grafana/grafana:13.2.2@sha256:ac461fb352abc50da10a51c7d02462e9c05488f11f53f14b3ad79a8145f638a0 AS production
USER root
RUN apk upgrade --no-cache \
    && mkdir -p /usr/share/docker-dash/grafana \
    && apk info -v | sort > /usr/share/docker-dash/grafana/alpine-packages.txt \
    && chmod 755 /usr/share/docker-dash /usr/share/docker-dash/grafana \
    && chmod 644 /usr/share/docker-dash/grafana/alpine-packages.txt
USER 472
LABEL org.opencontainers.image.version="13.2.2+dd.1" \
      com.docker-dash.security-patch="alpine-packages"
