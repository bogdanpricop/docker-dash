# Narrow patch on the deployed monitoring image. No dependency/schema changes.
FROM docker-dash:8.96.8-monitoring.1-prune.1-05f6cf2b AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/version.js ./src/version.js
COPY src/services/docker-prune-guard.js ./src/services/docker-prune-guard.js
COPY public/js/i18n/en.js public/js/i18n/ro.js ./public/js/i18n/
COPY public/js/pages/whatsnew.js ./public/js/pages/whatsnew.js
ARG SOURCE_REVISION
LABEL org.opencontainers.image.version="8.96.8+monitoring.1.prune.2" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      com.docker-dash.backport.base-revision="05f6cf2bd2059f03a887bb506e59a6896f650f90"
