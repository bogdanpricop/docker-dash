# Narrow patch on the deployed monitoring image. No dependency/schema changes.
FROM docker-dash:8.96.8-monitoring.1-audit-caf8b19 AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/version.js ./src/version.js
COPY src/services/docker-prune-guard.js ./src/services/docker-prune-guard.js
COPY public/js/i18n/en.js public/js/i18n/ro.js ./public/js/i18n/
COPY public/js/pages/whatsnew.js ./public/js/pages/whatsnew.js
ARG SOURCE_REVISION
LABEL org.opencontainers.image.version="8.96.8+monitoring.1.prune.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      com.docker-dash.backport.base-revision="caf8b195d478f706a351196e5cb32dcd15b0d142"
