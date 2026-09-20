FROM golang:1.27.1-alpine AS scanner-build
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
WORKDIR /src/compose
COPY docker/scanners/compose/go.mod docker/scanners/compose/go.sum ./
COPY docker/scanners/build-compose.sh /build-compose.sh
RUN sh /build-compose.sh


### Base ###
FROM node:24.21.0-alpine AS base

# npm 11.19.1 includes security fixes absent from the current npm 12.0.2 bundle.
# Keep aligned with package.json and CI; reassess when npm 12 ships those fixes.
RUN npm install --global npm@11.19.1 --ignore-scripts

# SECURITY: Upgrade all Alpine packages to get latest security patches
RUN apk update && apk upgrade --no-cache

# System tools + Docker CLI/Compose plugin
# Compose is executed from inside Docker Dash for stack plans, Git deploys,
# pull-request previews, and OCI Compose artifacts.
RUN apk add --no-cache tini curl git openssh-client openssl

# Alpine's Docker CLI 29.5.3 predates the go-archive path traversal fix.
COPY --from=scanner-build /out/docker-cli /usr/local/bin/docker
COPY docker/scanners/docker-cli.LICENSE /usr/share/licenses/docker-cli/LICENSE

# Verified upstream Compose 5.5.1 source with patched containerd dependencies.
# Build provenance is included with the other security rebuilds below.
COPY --from=scanner-build /out/docker-compose /usr/libexec/docker/cli-plugins/docker-compose

# Verified source builds with pinned dependency security fixes and provenance.
COPY --from=scanner-build /out/trivy /out/grype /usr/local/bin/
COPY --from=scanner-build /out/*.txt /out/*.json /out/*.sha256 /out/*.LICENSE /out/*.mod /usr/share/docker-dash/scanners/

# Docker Scout is temporarily excluded: its latest published binary embeds
# vulnerable dependencies and its plugin source is not publicly available for
# a security rebuild. See docs/audits/2026-09-20-scout-exclusion.md.

WORKDIR /app
COPY package*.json .npmrc ./
ENV NODE_ENV=production

### Development ###
FROM base AS development
ENV NODE_ENV=development
# The development image provides source bind mounts + node --watch at runtime.
# Test-only native packages (notably canvas) need a full compiler toolchain and
# are intentionally kept in CI/local test environments, not this runtime image.
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data
EXPOSE 8101
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--watch", "src/server.js"]

### Production dependencies ###
FROM base AS deps
# Install the audited, reproducible production dependency tree.
RUN npm ci --omit=dev

### Production ###
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY entrypoint.sh ./
COPY package.json README.md LICENSE CONTRIBUTING.md .env.example .gitignore ./
RUN mkdir -p /data && chmod +x /app/entrypoint.sh

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
