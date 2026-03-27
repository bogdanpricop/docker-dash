/* ═══════════════════════════════════════════════════
   pages/whatsnew.js — What's New / Changelog
   ═══════════════════════════════════════════════════ */
'use strict';

const WhatsNewPage = {

  // ─── Changelog Data ──────────────────────────────
  // Add new releases at the TOP of this array.
  // Types: feature, fix, improvement, security, breaking
  _releases: [
    {
      version: '2.3.0',
      date: '2026-03-27',
      title: 'Git Auto-Deploy, Diff View & Rollback (Phase 2+3)',
      changes: [
        { type: 'feature', text: 'Webhook receiver — GitHub, GitLab, Gitea, Bitbucket push events trigger automatic deploys' },
        { type: 'feature', text: 'Webhook signature validation — HMAC-SHA256 for GitHub/Gitea/Bitbucket, token header for GitLab' },
        { type: 'feature', text: 'Polling auto-update — configurable interval checks for new commits and auto-deploys' },
        { type: 'feature', text: 'Deployment history — full audit trail of every deployment with commit, trigger, status, duration' },
        { type: 'feature', text: 'Diff view — see exactly what changed between deployed and latest commit before redeploying' },
        { type: 'feature', text: 'Rollback — one-click revert to any previous successful deployment' },
        { type: 'feature', text: 'Auto-deploy configuration UI — webhook URL generation, provider selection, polling config' },
        { type: 'feature', text: 'Deploy-on-push toggle — optionally detect changes but only notify (no auto-deploy)' },
        { type: 'improvement', text: 'Enhanced stack detail view — dual-card layout with auto-deploy status, deployment history table' },
        { type: 'improvement', text: 'Deployment count and duration tracking on each stack' },
        { type: 'improvement', text: 'WebSocket real-time events for deploy start/success/failure' },
        { type: 'security', text: 'Timing-safe signature comparison to prevent timing attacks on webhook validation' },
        { type: 'security', text: 'Separate rate limiter for webhook endpoint (30 req/min per IP)' },
      ],
    },
    {
      version: '2.2.0',
      date: '2026-03-27',
      title: 'Git Repository Integration (Phase 1)',
      changes: [
        { type: 'feature', text: 'Deploy Docker Compose stacks directly from Git repositories — clone, deploy, and manage from the UI' },
        { type: 'feature', text: 'Git Credentials Manager — save and reuse tokens, passwords, and SSH keys (AES-256-GCM encrypted at rest)' },
        { type: 'feature', text: 'Test Connection — validate Git repo access and auto-populate branches before deploying' },
        { type: 'feature', text: 'Pull & Redeploy — one-click sync from Git remote with force reset option' },
        { type: 'feature', text: 'Check for Updates — compare local HEAD vs remote without deploying, see new commits' },
        { type: 'feature', text: 'Git Stack detail view — current commit, deploy status, error messages, repo info' },
        { type: 'feature', text: 'New sidebar navigation — dedicated Git Stacks page' },
        { type: 'feature', text: 'Git Credentials tab in Settings — create, edit, delete credentials with usage tracking' },
        { type: 'feature', text: 'Branch selection and compose file path configuration per stack' },
        { type: 'feature', text: 'Environment variable overrides — inject env vars without editing the repo' },
        { type: 'security', text: 'Git URL validation — prevents command injection via shell metacharacters' },
        { type: 'security', text: 'Compose path validation — prevents path traversal attacks' },
        { type: 'security', text: 'Error message sanitization — removes credentials from Git error output' },
        { type: 'security', text: 'SSH key handling — temp files with 0600 permissions, auto-cleanup on stack delete' },
        { type: 'improvement', text: 'Dockerfile updated — git + openssh-client added to Alpine image (~20MB)' },
        { type: 'improvement', text: 'Audit logging for all Git operations (credential CRUD, stack CRUD, deploy, check)' },
        { type: 'improvement', text: 'WebSocket broadcast for deploy status changes (real-time UI updates)' },
        { type: 'improvement', text: 'i18n — Git Stacks translations added for English, Romanian, German' },
      ],
    },
    {
      version: '2.1.0',
      date: '2026-03-26',
      title: 'i18n Modular System & Security Hardening',
      changes: [
        { type: 'feature', text: 'Modular i18n system — translations split into separate files per language (i18n/en.js, i18n/ro.js)' },
        { type: 'feature', text: 'Language plugin system — add a new language by dropping a single .js file + one script tag' },
        { type: 'feature', text: 'Translation template — TEMPLATE.js with all ~900 keys ready to translate' },
        { type: 'feature', text: 'Dynamic language selector — cycles through all registered languages (not hardcoded EN/RO)' },
        { type: 'feature', text: 'Initial Security Setup wizard — forces password change on first login with default admin' },
        { type: 'feature', text: 'Password policy — minimum 8 characters, at least 1 number, blocks common passwords' },
        { type: 'feature', text: 'Security banner — warns if default admin account is still active' },
        { type: 'feature', text: 'Optional personal admin creation during setup wizard' },
        { type: 'security', text: 'Bearer token fallback — authentication works when browser blocks cookies (Edge Tracking Prevention, HTTP on public IPs)' },
        { type: 'security', text: 'Cookie sameSite changed from strict to lax for HTTP compatibility' },
        { type: 'security', text: 'Session token returned in login response body (not just cookie) for non-cookie auth' },
        { type: 'fix', text: 'Setup wizard shows current username and asks for current password when session is restored' },
        { type: 'fix', text: 'Setup complete flag saved before password change (which invalidates session)' },
        { type: 'improvement', text: 'WebSocket auth fallback via query parameter token' },
        { type: 'improvement', text: 'i18n README with full instructions for contributors' },
      ],
    },
    {
      version: '2.0.1',
      date: '2026-03-26',
      title: 'Open Source Ready & Polish',
      changes: [
        { type: 'feature', text: 'About page — view and edit open-source files (README, LICENSE, CONTRIBUTING, .env.example, .gitignore) directly from the UI' },
        { type: 'feature', text: "What's New page — changelog with version history (this page)" },
        { type: 'fix', text: 'Security page now respects selected host — scan history filtered by host_id' },
        { type: 'fix', text: 'Edit Host dialog now loads full SSH config (host, port, username, docker socket) from server' },
        { type: 'fix', text: 'Edit Host dialog now includes Test Connection button (was missing)' },
        { type: 'fix', text: 'SSH tunnel "socket hang up" — added socat/nc/streamlocal fallback chain' },
        { type: 'improvement', text: 'TCP+TLS guide — full step-by-step TLS certificate generation instructions' },
        { type: 'improvement', text: 'SSH Tunnel guide — socat install commands for 7 Linux distributions' },
        { type: 'improvement', text: 'Connection type cards reorganized in 2x2 grid layout' },
        { type: 'improvement', text: 'Dockerfile updated to include open-source files in production image' },
        { type: 'improvement', text: '.dockerignore fixed to allow README.md, LICENSE, CONTRIBUTING.md, .gitignore' },
      ],
    },
    {
      version: '2.0.0',
      date: '2026-03-26',
      title: 'Multi-Host Docker Management',
      changes: [
        { type: 'feature', text: 'Multi-host support — manage multiple Docker hosts from a single instance' },
        { type: 'feature', text: 'TCP + TLS connections — connect to remote Docker hosts over the network with mutual TLS' },
        { type: 'feature', text: 'SSH Tunnel connections — secure tunnel via ssh2 library with auto-reconnect' },
        { type: 'feature', text: 'Docker Desktop support — connect via TCP port 2375' },
        { type: 'feature', text: 'Host management page — add, edit, delete, test connection, view Docker info' },
        { type: 'feature', text: 'Host selector dropdown in sidebar — switch between hosts instantly' },
        { type: 'feature', text: 'Per-host stats collection — independent collectors with failure isolation' },
        { type: 'feature', text: 'Per-host event streams — Docker events monitored per host' },
        { type: 'feature', text: 'Host health checks — periodic connectivity monitoring (60s interval)' },
        { type: 'feature', text: 'Connection guide — detailed setup instructions for each connection type' },
        { type: 'improvement', text: 'All API endpoints now accept hostId parameter for multi-host context' },
        { type: 'improvement', text: 'WebSocket exec and log streams support hostId' },
        { type: 'improvement', text: 'Stats error logging rate-limited to 1 per 5 minutes per host' },
        { type: 'improvement', text: 'Event stream reconnect with exponential backoff' },
      ],
    },
    {
      version: '1.6.0',
      date: '2026-03-24',
      title: 'Security & Vulnerability Scanning',
      changes: [
        { type: 'feature', text: 'Security page — dedicated vulnerability management dashboard' },
        { type: 'feature', text: 'Trivy scanner integration — automatic vulnerability detection' },
        { type: 'feature', text: 'Docker Scout integration — SARIF format parsing with Docker Hub auth' },
        { type: 'feature', text: 'Scan history — persistent storage with search, grouping, and bulk delete' },
        { type: 'feature', text: 'AI-assisted remediation — generated prompts for fixing vulnerabilities' },
        { type: 'feature', text: 'Smart vulnerability classification — npm vs OS vs third-party binary' },
        { type: 'security', text: 'npm overrides for 7 CVEs: cross-spawn, glob, minimatch, tar, brace-expansion, diff' },
        { type: 'security', text: 'Alpine package upgrades in Dockerfile for OS-level CVEs' },
        { type: 'fix', text: 'Docker Scout --format json replaced with --format sarif (json was invalid)' },
        { type: 'fix', text: 'Scout authentication persisted to /data/.docker/ (survives container restart)' },
        { type: 'fix', text: 'Clipboard API fallback for HTTP contexts using document.execCommand' },
        { type: 'fix', text: 'CSP scriptSrcAttr added for inline event handlers' },
      ],
    },
    {
      version: '1.5.0',
      date: '2026-03-22',
      title: 'Feature Parity with Portainer',
      changes: [
        { type: 'feature', text: 'Network topology — interactive canvas with drag, zoom, pan, hover highlighting' },
        { type: 'feature', text: 'Container terminal — xterm.js with shell selection and resize' },
        { type: 'feature', text: 'Live log streaming — WebSocket-based real-time container log follow' },
        { type: 'feature', text: 'Dashboard live graphs — CPU/memory time-series charts (rolling 60 points)' },
        { type: 'feature', text: 'Compose/Stacks — list, view YAML, edit, deploy with environment variables' },
        { type: 'feature', text: 'Container creation wizard — from image config with port/volume/env mapping' },
        { type: 'feature', text: 'Registry management — Docker Hub and generic v2 registry support' },
        { type: 'feature', text: 'Image build — stream build output via SSE' },
        { type: 'feature', text: 'Container clone/duplicate and update/recreate' },
        { type: 'feature', text: 'Container export (docker-compose.yml, docker run, JSON)' },
        { type: 'feature', text: 'Quick container actions menu' },
        { type: 'feature', text: 'WebSocket hardening — heartbeat, rate limiting, cleanup' },
        { type: 'improvement', text: 'Container size displayed in detail header' },
        { type: 'improvement', text: 'Image/volume footers with count and total size' },
      ],
    },
    {
      version: '1.1.0',
      date: '2026-03-20',
      title: 'Performance & Stability',
      changes: [
        { type: 'fix', text: 'Stats pipeline O(n²) query — changed to INSERT OR IGNORE with UNIQUE indexes' },
        { type: 'fix', text: 'docker_events table bloat (7GB) — added cleanup + VACUUM, reduced to 307MB' },
        { type: 'fix', text: 'CPU usage dropped from 59% to <2%, health check from 28s to 3ms' },
        { type: 'feature', text: 'Automatic log cleanup — data older than 7 days purged hourly' },
        { type: 'feature', text: 'Database tab in System page — DB info, table sizes, manual cleanup/vacuum' },
        { type: 'improvement', text: 'Stats aggregation: raw → 1min → 1hour with configurable retention' },
      ],
    },
    {
      version: '1.0.0',
      date: '2026-03-18',
      title: 'Initial Release',
      changes: [
        { type: 'feature', text: 'Container management — list, start, stop, restart, remove with bulk actions' },
        { type: 'feature', text: 'Image management — list, pull, remove with size display' },
        { type: 'feature', text: 'Volume and network management' },
        { type: 'feature', text: 'Real-time stats collection (10s interval) with SQLite storage' },
        { type: 'feature', text: 'Alert system — CPU/memory threshold rules with email/webhook notifications' },
        { type: 'feature', text: 'User management — admin, operator, viewer roles' },
        { type: 'feature', text: 'Audit log — all actions tracked' },
        { type: 'feature', text: 'Dark/light theme with system detection' },
        { type: 'feature', text: 'i18n — English and Romanian' },
        { type: 'feature', text: 'Firewall management (UFW)' },
        { type: 'feature', text: 'Command palette (Ctrl+K)' },
      ],
    },
  ],

  // ─── Render ──────────────────────────────────────

  async render(container) {
    const current = this._releases[0]?.version || '?';

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-bullhorn"></i> What's New</h2>
        <div class="page-actions">
          <span class="badge badge-info" style="font-size:12px">v${Utils.escapeHtml(current)}</span>
        </div>
      </div>
      <div id="whatsnew-content">${this._renderReleases()}</div>
    `;
  },

  _renderReleases() {
    const typeIcons = {
      feature: { icon: 'fa-star', color: 'var(--accent)', label: 'New' },
      fix: { icon: 'fa-bug', color: 'var(--red)', label: 'Fix' },
      improvement: { icon: 'fa-arrow-up', color: 'var(--green)', label: 'Improved' },
      security: { icon: 'fa-shield-alt', color: 'var(--yellow)', label: 'Security' },
      breaking: { icon: 'fa-exclamation-triangle', color: 'var(--red)', label: 'Breaking' },
    };

    return this._releases.map((release, idx) => {
      const isLatest = idx === 0;
      const changesByType = {};
      for (const c of release.changes) {
        if (!changesByType[c.type]) changesByType[c.type] = [];
        changesByType[c.type].push(c.text);
      }

      // Order: breaking, security, feature, improvement, fix
      const typeOrder = ['breaking', 'security', 'feature', 'improvement', 'fix'];
      const sections = typeOrder
        .filter(t => changesByType[t]?.length)
        .map(t => {
          const info = typeIcons[t] || typeIcons.feature;
          return `
            <div style="margin-bottom:12px">
              <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:${info.color}">
                <i class="fas ${info.icon}" style="width:16px"></i> ${info.label}
              </div>
              <ul style="margin:0;padding-left:24px;line-height:1.8">
                ${changesByType[t].map(text => `<li class="text-sm">${Utils.escapeHtml(text)}</li>`).join('')}
              </ul>
            </div>
          `;
        }).join('');

      return `
        <div class="card" style="margin-bottom:16px${isLatest ? ';border-color:var(--accent)' : ''}">
          <div class="card-header" style="display:flex;align-items:center;gap:10px">
            <h3 style="margin:0;display:flex;align-items:center;gap:8px">
              <span style="background:${isLatest ? 'var(--accent)' : 'var(--surface2)'};color:${isLatest ? '#fff' : 'var(--text)'};padding:2px 10px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:14px">v${Utils.escapeHtml(release.version)}</span>
              ${Utils.escapeHtml(release.title)}
            </h3>
            <span class="text-sm text-muted" style="margin-left:auto">${Utils.escapeHtml(release.date)}</span>
            ${isLatest ? '<span class="badge" style="background:var(--green);color:#fff;font-size:10px">Latest</span>' : ''}
          </div>
          <div class="card-body">${sections}</div>
        </div>
      `;
    }).join('');
  },

  destroy() {},
};

window.WhatsNewPage = WhatsNewPage;
