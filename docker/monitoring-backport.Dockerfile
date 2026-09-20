# Private monitoring-only hotfix. The immutable base is the deployed 8.96.8
# production image; no OS, Node, npm, scanner, dependency or migration changes.
FROM sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/version.js ./src/version.js
COPY src/middleware/auth.js src/middleware/monitoring-access.js ./src/middleware/
COPY src/routes/misc.js ./src/routes/misc.js
COPY src/services/identity-governance.js src/services/observability-import.js ./src/services/
COPY public/js/help-content.js ./public/js/help-content.js
COPY public/js/i18n/en.js public/js/i18n/ro.js ./public/js/i18n/
COPY public/js/pages/observability-wizard.js ./public/js/pages/observability-wizard.js
COPY public/js/pages/whatsnew.js ./public/js/pages/whatsnew.js
ARG APP_VERSION=8.96.8+monitoring.1
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      com.docker-dash.backport.base-revision="29c26d2b248cbc57c580ed8df57b1d9744123064" \
      com.docker-dash.backport.upstream-revision="04337ec4da08f8c6d4396e63902ebf6f5e9a29f0"
