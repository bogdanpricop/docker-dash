### Base ###
FROM node:20-alpine AS base

# SECURITY: Upgrade all Alpine packages to get latest security patches
RUN apk update && apk upgrade --no-cache

# System tools + Docker CLI + gcompat (glibc compat for Docker Scout)
RUN apk add --no-cache tini wget curl docker-cli gcompat git openssh-client

# Install Trivy vulnerability scanner (latest stable)
RUN wget -qO - https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Install Docker Scout CLI plugin (latest release)
# NOTE: Scout binary contains Go dependencies (grpc, stdlib, otel) with known CVEs.
# These are in the pre-compiled binary and cannot be fixed here.
# They will be resolved when Docker releases a new Scout version.
RUN mkdir -p /usr/lib/docker/cli-plugins && \
    SCOUT_VERSION=$(wget -qO- "https://api.github.com/repos/docker/scout-cli/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p') && \
    wget -qO /tmp/scout.tar.gz \
      "https://github.com/docker/scout-cli/releases/download/v${SCOUT_VERSION}/docker-scout_${SCOUT_VERSION}_linux_amd64.tar.gz" && \
    tar -xzf /tmp/scout.tar.gz -C /usr/lib/docker/cli-plugins docker-scout && \
    chmod +x /usr/lib/docker/cli-plugins/docker-scout && \
    rm -f /tmp/scout.tar.gz

WORKDIR /app
COPY package*.json ./
ENV NODE_ENV=production

### Development ###
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY . .
RUN mkdir -p /data
EXPOSE 8101
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--watch", "src/server.js"]

### Production dependencies ###
FROM base AS deps
# npm ci uses package-lock.json which already has patched versions via overrides:
#   cross-spawn >=7.0.5, glob >=10.5.0, minimatch >=9.0.7,
#   tar >=7.5.11, brace-expansion >=2.0.2, nodemailer >=7.0.7
RUN npm ci --omit=dev

### Production ###
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY package.json README.md LICENSE CONTRIBUTING.md .env.example .gitignore ./
RUN mkdir -p /data
EXPOSE 8101
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8101/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
