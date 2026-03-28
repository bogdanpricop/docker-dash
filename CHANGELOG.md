# Changelog

All notable changes to Docker Dash are documented here.

## [3.10.2] - 2026-03-28

### Added
- Interactive **Comparison page** — 52 features vs Portainer/Dockge/Dockhand with search/filter
- **17 API integration tests** with supertest (84 total tests)
- **GitHub issue/PR templates** for community contributions
- **README badges** — CI, version, license, tests, production readiness

### Changed
- GitHub repo description and 12 topics for discoverability
- .env.example updated with all v3 environment variables

## [3.10.1] - 2026-03-27

### Added
- **Welcome onboarding modal** for first-time users (Ctrl+K, theme, language tips)
- **ARIA labels** auto-applied to all icon-only action buttons
- **Toast `role="alert"`** for screen reader accessibility
- **Tab ARIA roles** (`role="tablist"`, `role="tab"`) on all tab components
- **Auto-refresh** on Volumes and Networks pages (30s interval)
- **Chart.js theme-aware colors** (light/dark auto-detection)

## [3.10.0] - 2026-03-27

### Fixed
- Dashboard **error state** — shows retry banner on API failure (was silent)
- **WCAG contrast** — text-dim darkened to pass 4.5:1 ratio
- **Focus-visible** keyboard navigation outlines on all interactive elements
- **Password policy** unified to 8 chars minimum everywhere
- **Sidebar icons** deduplicated (Firewall=fire, Hosts=sitemap)

### Added
- **Sidebar section labels** — Resources, Operations, Admin

## [3.9.0] - 2026-03-27

### Security
- **scrypt KDF** for encryption key derivation (replaces improvised padding)
- **Startup validation** — warns on weak APP_SECRET/ENCRYPTION_KEY in production
- **Trust proxy** restricted to loopback in production mode
- **JSON body limit** reduced from 10MB to 2MB

### Added
- **Database backup API** — POST /api/backup/database
- **GitHub Actions CI** — tests + syntax + i18n on every push
- **ESLint** — 0 errors, basic security rules

## [3.8.0] - 2026-03-27

### Security
- **Input validation middleware** — validateId, validateBody, sanitizeBody
- **Prototype pollution protection** on all request bodies
- **Git deploy/push rate limited** to 5/min/IP
- **Enhanced error handler** — 5xx no longer leaks internal details
- **SSH key cleanup** on startup (removes stale keys >24h)

### Fixed
- All `JSON.parse` calls wrapped with safe tryParseJson
- `console.log` in DB migrations replaced with structured logger

## [3.7.1] - 2026-03-27

### Security (CRITICAL)
- **Command injection** via Docker labels fixed — execFileSync replaces execSync
- **ReDoS** via user regex fixed — length limit + timeout test
- **Smart-restart DoS** fixed — returns backoff delay instead of blocking

## [3.7.0] - 2026-03-27

### Added
- **Event-driven notifications** — container crash/OOM/unhealthy auto-sent to all channels
- **Global search** — search containers, images, volumes, networks, Git stacks, audit log
- **Container dependency graph** — network-based relationship mapping

## [3.6.0] - 2026-03-27

### Added
- **Stack export** — download compose stack as portable JSON bundle
- **Stack import** — upload bundle and deploy on any host
- **Import preview** — validate before deploying
- **Generate compose** from any bundle

## [3.5.0] - 2026-03-27

### Added
- **Cross-host container migration** with zero-downtime
- **Stack migration** — all containers in a compose stack
- **Migration preview** (dry run) with warnings
- Health check verification before stopping source

## [3.4.0] - 2026-03-27

### Added
- **Workflow automation** — IF-THEN rules (CPU high → restart, crash → notify)
- **Dashboard preferences** — per-user widget order and visibility
- **README** completely rewritten with 60+ features

## [3.3.0] - 2026-03-27

### Added
- **Mobile responsive UI** — hamburger menu, touch-friendly buttons, scrollable tables
- **Resource recommendations** — smart analysis with actionable advice
- **Comparison API** — /api/compare returns feature matrix

## [3.2.0] - 2026-03-27

### Added
- **Enhanced log search** — regex, log level filtering (ERROR/WARN/INFO/DEBUG)
- **App template marketplace** — 20 curated one-click templates
- **Watchtower detection** — migration advisory to Docker Dash native updates

## [3.1.0] - 2026-03-27

### Added
- **Scheduled maintenance windows** — cron-based pull/scan/update
- **Smart restart** with exponential backoff and crash-loop detection
- **Public status page** — unauthenticated service status

## [3.0.0] - 2026-03-27

### Added
- **Deploy preview** — check for image updates via digest comparison
- **Safe-pull container update** — Trivy scan before swap, blocks critical CVEs
- **Guided troubleshooting wizard** — 8-step diagnostic for any container

## [2.10.0] - 2026-03-27

### Added
- **Image freshness dashboard** — freshness score based on age + vulnerabilities
- **Audit log analytics** — top users, actions, targets, hourly/daily heatmap

## [2.9.0] - 2026-03-27

### Added
- **Container uptime reports** — uptime %, restarts, hours tracked
- **Resource usage trends** — 7-day linear regression with 24h forecasting
- **Memory exhaustion prediction** — "will exceed limit in N hours"
- **Per-container cost estimation** — weighted CPU+memory share of VPS cost

## [2.8.0] - 2026-03-27

### Added
- **docker run → Compose converter**
- **AI-powered log analysis** — diagnostic prompts for ChatGPT/Claude
- **Traefik/Caddy label generator** — domain + port → ready-to-use labels
- **Tools tab** in System page

## [2.7.0] - 2026-03-27

### Added
- **7 notification channels** — Discord, Slack, Telegram, Ntfy, Gotify, Email, Webhook
- **SSO header authentication** — Authelia, Authentik, Caddy, Traefik support

## [2.6.0] - 2026-03-27

### Added
- **Container Health Score** (0-100) — composite from state, health, restarts, CPU/memory
- **Plain-English container status** — exit codes mapped to human-readable messages
- **Self-reporting resource footprint** — /api/footprint endpoint

## [2.2.0 - 2.5.0] - 2026-03-27

### Added
- **Git integration** — deploy from repos, credentials, webhooks, polling
- **Diff view** — see changes before redeploying
- **Deployment rollback** — revert to any previous deployment
- **Push to Git** — edit compose in UI, commit and push
- **Multi-file compose** — multiple YAML override files
- **Environment variable management** — per-stack overrides with encryption
- **Custom CA certificates** — for self-hosted Git servers
