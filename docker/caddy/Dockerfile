# syntax=docker/dockerfile:1
#
# Custom Caddy image for Docker Dash Let's Encrypt Wizard (v6.5+)
#
# Bundles nine DNS provider plugins so users can request Let's Encrypt
# certificates via DNS-01 challenge from inside Docker Dash:
#   - Cloudflare
#   - AWS Route53
#   - DigitalOcean
#   - Hetzner
#   - Linode
#
# To add a new provider: add another `--with github.com/caddy-dns/<provider>`
# line below and bump the image tag.
#
# Verified working in preflight A4 (2026-04-20) with Caddy 2.11.2 + GOTOOLCHAIN=auto.
# See docs/planning/v6.5/letsencrypt-wizard/05-preflight-results.md.

ARG CADDY_VERSION=2.11.7
ARG CADDY_BUILDER_DIGEST=sha256:80331d37e7d4d230f186f2707079e279f32552924f101ee659e8cae9f9877c26
ARG CADDY_RUNTIME_DIGEST=sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
ARG ALPINE_RUNTIME_VERSION=3.24
ARG ALPINE_RUNTIME_DIGEST=sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM --platform=$BUILDPLATFORM caddy:${CADDY_VERSION}-builder@${CADDY_BUILDER_DIGEST} AS builder

ARG TARGETOS
ARG TARGETARCH

# Allow auto-download of newer Go toolchain when plugins require a newer Go
# than the builder's bundled version. Required for route53@v1.6.0 (needs Go 1.25)
# and linode@v0.8.0 (also Go 1.25).
ENV GOTOOLCHAIN=auto

RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} xcaddy build \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/route53@v1.6.2 \
  --with github.com/caddy-dns/digitalocean@v0.0.0-20250606074528-04bde2867106 \
  --with github.com/caddy-dns/hetzner/v2@v2.0.1 \
  --with github.com/caddy-dns/linode@v0.8.0 \
  --with github.com/caddy-dns/namecheap@v1.0.0 \
  --with github.com/caddy-dns/gandi@v1.1.0 \
  --with github.com/caddy-dns/porkbun@v0.3.1 \
  --with github.com/caddy-dns/ovh@v1.1.0

# xcaddy grants cap_net_bind_service to its output. Remove the file capability
# so the binary remains executable when operators drop every container capability.
RUN setcap -r /usr/bin/caddy

FROM caddy:${CADDY_VERSION}-alpine@${CADDY_RUNTIME_DIGEST} AS caddy-runtime-assets

FROM alpine:${ALPINE_RUNTIME_VERSION}@${ALPINE_RUNTIME_DIGEST} AS runtime-files
RUN apk update && apk upgrade --no-cache \
  && apk add --no-cache ca-certificates mailcap \
  && mkdir -p /rootfs/bin /rootfs/lib /rootfs/config/caddy /rootfs/data/caddy \
       /rootfs/etc/ssl/certs /rootfs/etc/caddy /rootfs/usr/share/caddy \
  && cp /bin/busybox /rootfs/bin/busybox \
  && cp -a /lib/ld-musl-*.so.1 /rootfs/lib/ \
  && ln -s busybox /rootfs/bin/sh \
  && ln -s busybox /rootfs/bin/cp \
  && ln -s busybox /rootfs/bin/tee \
  && cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ca-certificates.crt \
  && cp /etc/mime.types /rootfs/etc/mime.types \
  && chmod 1777 /rootfs/config/caddy /rootfs/data/caddy

FROM scratch
ARG CADDY_VERSION
COPY --from=runtime-files /rootfs/ /
COPY --from=caddy-runtime-assets /etc/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=caddy-runtime-assets /usr/share/caddy/index.html /usr/share/caddy/index.html
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

ENV PATH=/usr/bin:/bin
ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data

LABEL org.opencontainers.image.source="https://github.com/bogdanpricop/docker-dash"
LABEL org.opencontainers.image.description="Caddy with DNS plugins for Docker Dash Let's Encrypt Wizard"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.title="docker-dash-caddy"
LABEL org.opencontainers.image.version="v${CADDY_VERSION}"

EXPOSE 80 443 443/udp 2019
VOLUME ["/config", "/data"]
WORKDIR /srv
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
