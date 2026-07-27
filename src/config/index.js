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
    // Out-of-band terminal recovery/incident override:
    // managed = database policy, deny = force closed, allow = ignore DB locks.
    terminalAccessOverride: env('DD_TERMINAL_ACCESS_OVERRIDE', 'managed'),
  },
  stats: {
    collectIntervalMs: int('STATS_INTERVAL_MS', 10000),
    retentionRawHours: int('STATS_RAW_RETENTION_HOURS', 24),
    retention1mDays: int('STATS_1M_RETENTION_DAYS', 7),
    retention1hDays: int('STATS_1H_RETENTION_DAYS', 7),
    retention1dDays: int('STATS_1D_RETENTION_DAYS', 90),
  },
  retention: {
    auditDays: int('AUDIT_RETENTION_DAYS', 365),
    eventDays: int('EVENT_RETENTION_DAYS', 7),
    // Persist high-frequency Docker `exec_*` events (exec_create/start/die).
    // Default OFF: container healthchecks fire 3 exec events every few seconds
    // per container, which dominates docker_events (>95% on busy hosts) and
    // bloats the DB. They're still broadcast live + fed to the notifier; we just
    // don't store them. Set DD_STORE_EXEC_EVENTS=true to persist them anyway.
    storeExecEvents: bool('DD_STORE_EXEC_EVENTS', false),
  },
  features: {
    exec: bool('ENABLE_EXEC', true),
    prune: bool('ENABLE_PRUNE', true),
    create: bool('ENABLE_CREATE', true),
    remove: bool('ENABLE_REMOVE', true),
    multiHost: bool('ENABLE_MULTI_HOST', false),
    readOnly: bool('READ_ONLY_MODE', false),
    ssoHeaders: bool('ENABLE_SSO_HEADERS', false),
    // Additive, read-only endpoint for the versioned multi-provider contract.
    // Kept as a flag so operators can canary the new schema independently.
    providerSdkV2: bool('DD_PROVIDER_SDK_V2', true),
    // Mutation canary. Preflight remains inspectable while submit routes and
    // UI actions stay closed unless an operator explicitly enables this.
    providerVmPower: bool('DD_PROVIDER_VM_POWER', false),
    providerVmSnapshots: bool('DD_PROVIDER_VM_SNAPSHOTS', false),
    providerVmSnapshotAutomation: bool('DD_PROVIDER_VM_SNAPSHOT_AUTOMATION', false),
    providerVmProvisioning: bool('DD_PROVIDER_VM_PROVISIONING', false),
    providerVmGuestCustomization: bool('DD_PROVIDER_VM_GUEST_CUSTOMIZATION', false),
    providerVmConsole: bool('DD_PROVIDER_VM_CONSOLE', false),
    providerVmMigration: bool('DD_PROVIDER_VM_MIGRATION', false),
    providerHostMaintenance: bool('DD_PROVIDER_HOST_MAINTENANCE', false),
    providerHaReadiness: bool('DD_PROVIDER_HA_READINESS', false),
    providerPlacementAdvisory: bool('DD_PROVIDER_PLACEMENT_ADVISORY', false),
    providerHaPolicyMutation: bool('DD_PROVIDER_HA_POLICY_MUTATION', false),
    providerAffinityMutation: bool('DD_PROVIDER_AFFINITY_MUTATION', false),
    providerRebalanceApply: bool('DD_PROVIDER_REBALANCE_APPLY', false),
    // Read-only common inventory for provider-native backup repositories and
    // recovery points. Restore and backup execution remain separately gated.
    providerRecoveryPointInventory: bool('DD_PROVIDER_RECOVERY_POINT_INVENTORY', false),
    // Declarative backup policy authoring and plan-only scheduling. This flag
    // never authorizes a provider backup or retention mutation.
    providerBackupPolicies: bool('DD_PROVIDER_BACKUP_POLICIES', false),
    // Durable provider backup submission. Authorization remains per policy and
    // retention deletion is not implied by this execution flag.
    providerBackupExecution: bool('DD_PROVIDER_BACKUP_EXECUTION', false),
    providerRecoveryRestore: bool('DD_PROVIDER_RECOVERY_RESTORE', false),
    providerRestoreDrills: bool('DD_PROVIDER_RESTORE_DRILLS', false),
    providerDrRunbooks: bool('DD_PROVIDER_DR_RUNBOOKS', false),
  },
  providerOperations: {
    concurrency: int('DD_PROVIDER_OPERATION_CONCURRENCY', 4),
    pollMs: int('DD_PROVIDER_OPERATION_POLL_MS', 1000),
    leaseMs: int('DD_PROVIDER_OPERATION_LEASE_MS', 30000),
  },
  providerHostMaintenance: {
    pollLimit: Math.min(100, Math.max(1, int('DD_PROVIDER_HOST_MAINTENANCE_POLL_LIMIT', 20))),
    leaseMs: Math.min(5 * 60 * 1000, Math.max(15_000, int('DD_PROVIDER_HOST_MAINTENANCE_LEASE_MS', 90_000))),
    nativeTimeoutSeconds: Math.min(86400, Math.max(60, int('DD_PROVIDER_HOST_MAINTENANCE_NATIVE_TIMEOUT_SECONDS', 3600))),
  },
  providerHaReadiness: {
    freshnessMs: Math.min(15 * 60 * 1000, Math.max(15_000, int('DD_PROVIDER_HA_FRESHNESS_MS', 60_000))),
    historyLimit: Math.min(500, Math.max(12, int('DD_PROVIDER_HA_HISTORY_LIMIT', 96))),
    endpointConcurrency: Math.min(4, Math.max(1, int('DD_PROVIDER_HA_ENDPOINT_CONCURRENCY', 2))),
  },
  providerPlacementAdvisory: {
    freshnessMs: Math.min(15 * 60 * 1000, Math.max(15_000, int('DD_PROVIDER_PLACEMENT_FRESHNESS_MS', 60_000))),
    maxRebalanceVms: Math.min(20, Math.max(1, int('DD_PROVIDER_PLACEMENT_MAX_REBALANCE_VMS', 20))),
    endpointConcurrency: Math.min(2, Math.max(1, int('DD_PROVIDER_PLACEMENT_ENDPOINT_CONCURRENCY', 2))),
    planTtlMs: Math.min(30 * 60 * 1000, Math.max(60_000, int('DD_PROVIDER_PLACEMENT_PLAN_TTL_MS', 5 * 60_000))),
  },
  providerPlacementChanges: {
    concurrency: Math.min(5, Math.max(1, int('DD_PROVIDER_PLACEMENT_CHANGE_CONCURRENCY', 2))),
    maxMoves: Math.min(20, Math.max(1, int('DD_PROVIDER_PLACEMENT_CHANGE_MAX_MOVES', 20))),
    approvalTtlMs: Math.min(24 * 60 * 60 * 1000,
      Math.max(60_000, int('DD_PROVIDER_PLACEMENT_CHANGE_APPROVAL_TTL_MS', 15 * 60_000))),
  },
  providerSnapshots: {
    maxCount: int('DD_PROVIDER_VM_SNAPSHOT_MAX_COUNT', 32),
    maxDepth: int('DD_PROVIDER_VM_SNAPSHOT_MAX_DEPTH', 16),
  },
  providerResilience: {
    concurrency: int('DD_PROVIDER_MAX_CONCURRENCY', 2),
    maxQueue: int('DD_PROVIDER_MAX_QUEUE', 64),
    timeoutMs: int('DD_PROVIDER_REQUEST_TIMEOUT_MS', 30000),
    failureThreshold: int('DD_PROVIDER_CIRCUIT_FAILURES', 3),
    cooldownMs: int('DD_PROVIDER_CIRCUIT_COOLDOWN_MS', 30000),
  },
  providerConformance: {
    retentionDays: int('DD_PROVIDER_CONFORMANCE_RETENTION_DAYS', 365),
  },
  providerConsole: {
    tokenTtlSeconds: Math.min(120, Math.max(15, int('DD_PROVIDER_VM_CONSOLE_TOKEN_TTL_SECONDS', 45))),
    maxPendingPerUser: Math.min(20, Math.max(1, int('DD_PROVIDER_VM_CONSOLE_MAX_PENDING_PER_USER', 5))),
    maxActivePerUser: Math.min(20, Math.max(1, int('DD_PROVIDER_VM_CONSOLE_MAX_ACTIVE_PER_USER', 3))),
    maxActivePerIp: Math.min(50, Math.max(1, int('DD_PROVIDER_VM_CONSOLE_MAX_ACTIVE_PER_IP', 5))),
    maxSessionSeconds: Math.min(8 * 3600, Math.max(60, int('DD_PROVIDER_VM_CONSOLE_MAX_SESSION_SECONDS', 3600))),
    accessOverride: env('DD_PROVIDER_VM_CONSOLE_ACCESS_OVERRIDE', 'managed'),
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
    // v8.7.6 — Group → role mapping (Entra ID & any OIDC IdP).
    // groupClaim names the ID-token claim that lists groups (Entra defaults
    // to "groups"; some IdPs use "roles" if app-roles are configured). The
    // three *_GROUPS lists are comma-separated. Match is case-insensitive
    // exact on the claim value (works for both Entra group IDs/GUIDs and
    // display-names). When ANY of the three lists is configured, the
    // existing user's role is RE-EVALUATED on every login (so removing
    // someone from the admin group in Entra demotes them on next sign-in).
    // When all three lists are empty, behavior is unchanged: every SSO
    // user gets defaultRole and existing roles are never overwritten.
    groupClaim: env('OIDC_GROUP_CLAIM', 'groups'),
    adminGroups: env('OIDC_ROLE_ADMIN_GROUPS', '').split(',').map(s => s.trim()).filter(Boolean),
    operatorGroups: env('OIDC_ROLE_OPERATOR_GROUPS', '').split(',').map(s => s.trim()).filter(Boolean),
    viewerGroups: env('OIDC_ROLE_VIEWER_GROUPS', '').split(',').map(s => s.trim()).filter(Boolean),
  },
};

// pCloud config lives in DB (UI-editable, no restart). 5s cache so cron picks
// up schedule changes promptly without DB round-trip on every read.
let _pcloudCache = { enabled: false };
let _pcloudCacheAt = 0;
const PCLOUD_CACHE_TTL = 5000;

Object.defineProperty(module.exports, 'pcloud', {
  configurable: true,
  get() {
    const now = Date.now();
    if (now - _pcloudCacheAt < PCLOUD_CACHE_TTL) return _pcloudCache;
    try {
      const { getDb } = require('../db');
      const row = getDb().prepare(
        'SELECT enabled, region, db_schedule, stack_schedule, audit_schedule FROM pcloud_config WHERE id=1'
      ).get();
      _pcloudCache = row
        ? {
            enabled: !!row.enabled,
            region: row.region,
            schedules: { db: row.db_schedule, stack: row.stack_schedule, audit: row.audit_schedule },
          }
        : { enabled: false };
    } catch {
      _pcloudCache = { enabled: false };
    }
    _pcloudCacheAt = now;
    return _pcloudCache;
  },
});

/** Invalidate pCloud config cache after writes so next read sees fresh state. */
module.exports.invalidatePcloudCache = function () {
  _pcloudCacheAt = 0;
};
