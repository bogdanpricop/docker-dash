'use strict';

const path = require('path');

// Load .env from project root
const envPath = process.env.ENV_FILE || path.join(__dirname, '..', '..', '.env');
try { require('dotenv').config({ path: envPath }); } catch { /* dotenv optional */ }

const env = (key, fallback) => process.env[key] ?? fallback;
const int = (key, fallback) => parseInt(env(key, fallback), 10);
const bool = (key, fallback) => {
  const v = env(key, String(fallback));
  return v === 'true' || v === '1';
};

const securityMode = env('SECURITY_MODE', 'standard'); // 'standard' | 'strict'
const isStrict = securityMode === 'strict';

module.exports = {
  app: {
    env: env('APP_ENV', 'development'),
    name: env('APP_NAME', 'Docker Dash'),
    port: int('APP_PORT', 8101),
    host: env('APP_HOST', '0.0.0.0'),
    secret: env('APP_SECRET', 'change-me-in-production-' + Date.now()),
    baseUrl: env('BASE_URL', 'http://localhost:8101'),
    publicUrl: env('PUBLIC_URL', 'http://localhost:8101'),
  },
  db: {
    path: env('DB_PATH', '/data/docker-dash.db'),
  },
  docker: {
    socketPath: env('DOCKER_SOCKET', '/var/run/docker.sock'),
  },
  session: {
    ttl: int('SESSION_TTL_HOURS', isStrict ? 8 : 24) * 3600 * 1000,
    cookieName: env('SESSION_COOKIE', 'dd_sid'),
    secureCookie: bool('COOKIE_SECURE', isStrict),
  },
  rateLimit: {
    loginMaxAttempts: int('RATE_LIMIT_LOGIN_MAX', 5),
    loginWindowMs: int('RATE_LIMIT_LOGIN_WINDOW_MS', 15 * 60 * 1000),
    apiMaxRequests: int('RATE_LIMIT_API_MAX', 100),
    apiWindowMs: int('RATE_LIMIT_API_WINDOW_MS', 60 * 1000),
  },
  security: {
    mode: securityMode,
    isStrict,
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    lockoutAttempts: int('LOCKOUT_ATTEMPTS', 10),
    lockoutDurationMs: int('LOCKOUT_DURATION_MS', 30 * 60 * 1000),
    encryptionKey: env('ENCRYPTION_KEY', ''),
    passwordMaxAgeDays: int('PASSWORD_MAX_AGE_DAYS', isStrict ? 90 : 0),
    disableTokenInBody: bool('DISABLE_TOKEN_IN_BODY', isStrict),
    disableWsQueryAuth: bool('DISABLE_WS_QUERY_AUTH', isStrict),
  },
  stats: {
    collectIntervalMs: int('STATS_INTERVAL_MS', 10000),
    retentionRawHours: int('STATS_RAW_RETENTION_HOURS', 24),
    retention1mDays: int('STATS_1M_RETENTION_DAYS', 7),
    retention1hDays: int('STATS_1H_RETENTION_DAYS', 7),
  },
  retention: {
    auditDays: int('AUDIT_RETENTION_DAYS', 7),
    eventDays: int('EVENT_RETENTION_DAYS', 7),
  },
  features: {
    exec: bool('ENABLE_EXEC', true),
    prune: bool('ENABLE_PRUNE', true),
    create: bool('ENABLE_CREATE', true),
    remove: bool('ENABLE_REMOVE', true),
    multiHost: bool('ENABLE_MULTI_HOST', false),
    readOnly: bool('READ_ONLY_MODE', false),
    ssoHeaders: bool('ENABLE_SSO_HEADERS', false),
  },
  smtp: {
    host: env('SMTP_HOST', 'localhost'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: env('SMTP_USER', ''),
    password: env('SMTP_PASSWORD', ''),
    fromName: env('SMTP_FROM_NAME', 'Docker Dash'),
    fromEmail: env('SMTP_FROM_EMAIL', 'noreply@example.com'),
  },
  git: {
    deploymentRetentionDays: int('GIT_DEPLOYMENT_RETENTION_DAYS', 90),
    pollingMinIntervalSeconds: int('GIT_POLLING_MIN_INTERVAL', 60),
  },
  admin: {
    defaultPassword: env('ADMIN_PASSWORD', 'admin'),
    defaultUsername: env('ADMIN_USERNAME', 'admin'),
  },
  s3: {
    enabled: bool('S3_ENABLED', false),
    endpoint: env('S3_ENDPOINT', ''),
    bucket: env('S3_BUCKET', ''),
    accessKey: env('S3_ACCESS_KEY', ''),
    secretKey: env('S3_SECRET_KEY', ''),
    region: env('S3_REGION', 'us-east-1'),
    backupSchedule: env('S3_BACKUP_SCHEDULE', '0 3 * * *'),
  },
  oidc: {
    enabled: bool('OIDC_ENABLED', false),
    issuerUrl: env('OIDC_ISSUER_URL', ''),
    clientId: env('OIDC_CLIENT_ID', ''),
    clientSecret: env('OIDC_CLIENT_SECRET', ''),
    redirectUri: env('OIDC_REDIRECT_URI', ''),
    defaultRole: env('OIDC_DEFAULT_ROLE', 'viewer'),
  },
};
