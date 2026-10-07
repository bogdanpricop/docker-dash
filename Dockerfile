FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS scanner-build
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


### Base ###
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base

# Keep the package manager itself pinned and audited alongside application code.
RUN npm install --global npm@12.2.0 --ignore-scripts

# SECURITY: Upgrade all Alpine packages to get latest security patches
RUN apk update && apk upgrade --no-cache

# System tools + Docker CLI/Compose plugin
# Compose is executed from inside Docker Dash for stack plans, Git deploys,
# pull-request previews, and OCI Compose artifacts.
RUN apk add --no-cache tini curl git openssh-client openssl

# Use the verified source build instead of Alpine's independently packaged CLI.
COPY --from=scanner-build /out/docker-cli /usr/local/bin/docker
COPY docker/scanners/docker-cli.LICENSE /usr/share/licenses/docker-cli/LICENSE

# Verified upstream Compose 5.6.0 source with current containerd dependencies.
# Build provenance is included with the other security rebuilds below.
COPY --from=scanner-build /out/docker-compose /usr/libexec/docker/cli-plugins/docker-compose

# Verified source builds with pinned dependency security fixes and provenance.
COPY --from=scanner-build /out/trivy /out/grype /usr/local/bin/
COPY --from=scanner-build /out/*.txt /out/*.json /out/*.sha256 /out/*.LICENSE /out/*.mod /usr/share/docker-dash/scanners/

# Docker Scout is temporarily excluded: its latest published binary embeds
# vulnerable dependencies and its plugin source is not publicly available for
# a security rebuild. See docs/audits/2026-09-20-scout-exclusion.md.

WORKDIR /app
COPY package*.json ./
ENV NODE_ENV=production

### Development ###
FROM base AS development
ENV NODE_ENV=development
# The development image provides source bind mounts + node --watch at runtime.
# Test-only native packages (notably canvas) need a full compiler toolchain and
# are intentionally kept in CI/local test environments, not this runtime image.
RUN npm ci --omit=dev --strict-allow-scripts
COPY . .
RUN mkdir -p /data
EXPOSE 8101
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--watch", "src/server.js"]

### Production dependencies ###
FROM base AS deps
# Install the audited, reproducible production dependency tree.
RUN npm ci --omit=dev --strict-allow-scripts

### Production ###
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY entrypoint.sh ./
COPY package.json README.md LICENSE CONTRIBUTING.md .env.example .gitignore ./
# npm is needed only in the dependency stage. Removing it from the runtime image
# avoids shipping its package graph and reduces the production attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /data \
    && chmod +x /app/entrypoint.sh

# Version label — read from package.json at build time
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.title="Docker Dash" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.description="Full-featured Docker management dashboard" \
      org.opencontainers.image.source="https://github.com/bogdanpricop/docker-dash" \
      org.opencontainers.image.authors="Bogdan Pricop <bogdan.pricop@gmail.com>" \
      org.opencontainers.image.licenses="MIT"

EXPOSE 8101
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD sh -c "curl --fail --silent --show-error --max-time 4 http://localhost:\${APP_PORT:-8101}/api/health >/dev/null || exit 1"
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "src/server.js"]
