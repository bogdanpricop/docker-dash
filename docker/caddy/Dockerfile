# syntax=docker/dockerfile:1
#
# Custom Caddy image for Docker Dash Let's Encrypt Wizard (v6.5+)
#
# Bundles five DNS provider plugins so users can request Let's Encrypt
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

ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-builder AS builder

# Allow auto-download of newer Go toolchain when plugins require a newer Go
# than the builder's bundled version. Required for route53@v1.6.0 (needs Go 1.25)
# and linode@v0.8.0 (also Go 1.25).
ENV GOTOOLCHAIN=auto

RUN xcaddy build \
  --with github.com/caddy-dns/cloudflare \
  --with github.com/caddy-dns/route53 \
  --with github.com/caddy-dns/digitalocean \
  --with github.com/caddy-dns/hetzner \
  --with github.com/caddy-dns/linode \
  --with github.com/caddy-dns/namecheap \
  --with github.com/caddy-dns/gandi \
  --with github.com/caddy-dns/porkbun \
  --with github.com/caddy-dns/ovh

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

LABEL org.opencontainers.image.source="https://github.com/bogdanpricop/docker-dash"
LABEL org.opencontainers.image.description="Caddy with DNS plugins for Docker Dash Let's Encrypt Wizard"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.title="docker-dash-caddy"
