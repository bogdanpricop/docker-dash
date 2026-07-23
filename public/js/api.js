/* ═══════════════════════════════════════════════════
   api.js — HTTP API Client
   ═══════════════════════════════════════════════════ */
'use strict';

const Api = {
  _currentHostId: 0,
  _bearerToken: null, // Fallback when cookies are blocked (Edge Tracking Prevention, HTTP on public IPs)

  /** Set current host context (0 = default/local) */
  setHost(hostId) {
    this._currentHostId = parseInt(hostId) || 0;
    localStorage.setItem('dd-host-id', this._currentHostId);
  },

  getHostId() {
    return this._currentHostId;
  },

  /** Restore host from localStorage */
  restoreHost() {
    const saved = localStorage.getItem('dd-host-id');
    if (saved) this._currentHostId = parseInt(saved) || 0;
  },

  /** Append hostId to URL if multi-host is active */
  _appendHostId(path) {
    if (this._currentHostId === 0) return path;
    // Skip host parameter for auth, settings, hosts, and other non-Docker endpoints
    // v8.9.11-alpha.9 — /vsphere carries its OWN daemon host id (the page
    // resolves the vSphere host explicitly), so the globally-selected host
    // must NOT be auto-appended — otherwise a selected Docker host leaks in
    // and the endpoint rejects it ("not a vSphere daemon").
    const skipPrefixes = ['/auth', '/settings', '/hosts', '/notifications', '/webhooks', '/alerts/rules', '/favorites', '/audit', '/git/credentials', '/git/test-connection', '/groups', '/dashboard/preferences', '/docs', '/howto', '/vsphere', '/incus', '/firewall', '/host-groups', '/teams', '/host-permissions', '/alert-routes'];
    if (skipPrefixes.some(p => path.startsWith(p))) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}hostId=${this._currentHostId}`;
  },

  /** Read XSRF cookie value (set by server on session creation, read by client for double-submit) */
  _readXsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  },

  async request(method, path, body = null, opts = {}) {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
    };
    // Add Bearer token if cookies might be blocked
    if (this._bearerToken) {
      options.headers['Authorization'] = `Bearer ${this._bearerToken}`;
    }
    // CSRF double-submit: send XSRF cookie value as header on state-mutating methods
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const xsrf = this._readXsrfToken();
      if (xsrf) options.headers['X-XSRF-TOKEN'] = xsrf;
    }
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(`/api${this._appendHostId(path)}`, options);
      if (res.status === 401 && !path.startsWith('/auth/login')) {
        // v7.3.1: mute error toasts for 6s so parallel in-flight requests
        // don't bury the login form with "Failed to load X: Unauthorized".
        // App.handleUnauthorized() is idempotent so repeated 401s are harmless.
        if (typeof Toast !== 'undefined') Toast.muteErrorsForMs(6000);
        App.handleUnauthorized();
        const err = new Error('Unauthorized');
        err.isAuthError = true;
        throw err;
      }
      const data = res.headers.get('content-type')?.includes('json')
        ? await res.json()
        : await res.text();
      if (!res.ok) {
        const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        console.error(`API ${method} ${path}:`, err.message);
      }
      throw err;
    }
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  delete(path, body) { return this.request('DELETE', path, body); },

  // ─── Auth ────────────────────────────────────────
  async login(username, password) {
    const res = await this.post('/auth/login', { username, password });
    // Store token for Bearer auth fallback (when cookies are blocked by browser)
    if (res.token) {
      this._bearerToken = res.token;
      try { sessionStorage.setItem('dd_token', res.token); } catch {}
    }
    return res;
  },
  async logout() {
    const res = await this.post('/auth/logout');
    this._bearerToken = null;
    try { sessionStorage.removeItem('dd_token'); } catch {}
    return res;
  },
  me() {
    // Restore token from sessionStorage if not in memory
    if (!this._bearerToken) {
      try { this._bearerToken = sessionStorage.getItem('dd_token'); } catch {}
    }
    return this.get('/auth/me');
  },
  changePassword(currentPassword, newPassword) {
    return this.post('/auth/change-password', { currentPassword, newPassword });
  },

  // ─── Users (admin) ──────────────────────────────
  getUsers() { return this.get('/auth/users'); },
  createUser(data) { return this.post('/auth/users', data); },
  updateUser(id, data) { return this.put(`/auth/users/${id}`, data); },
  deleteUser(id) { return this.delete(`/auth/users/${id}`); },
  sendPasswordReset(id, lang) { return this.post(`/auth/users/${id}/send-reset`, { lang, origin: window.location.origin }); },
  sendInvitation(id, lang) { return this.post(`/auth/users/${id}/send-invite`, { lang, origin: window.location.origin }); },

  // ─── Containers ──────────────────────────────────
  getContainers(all = true) { return this.get(`/containers?all=${all}`); },
  getContainer(id) { return this.get(`/containers/${id}/inspect`); },
  getContainerLogs(id, tail = 200, search = '', since = '') {
    let url = `/containers/${id}/logs?tail=${tail}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    return this.get(url);
  },
  getMultiLogs(opts = {}) {
    const params = new URLSearchParams();
    if (opts.containers) params.set('containers', opts.containers);
    if (opts.tail) params.set('tail', opts.tail);
    if (opts.since) params.set('since', opts.since);
    if (opts.search) params.set('search', opts.search);
    if (opts.level) params.set('level', opts.level);
    return this.get(`/containers/logs/multi?${params.toString()}`);
  },
  getContainerStats(id) { return this.get(`/containers/${id}/stats`); },
  containerAction(id, action) { return this.post(`/containers/${id}/${action}`); },
  removeContainer(id, force = false) { return this.delete(`/containers/${id}?force=${force}`); },
  renameContainer(id, name) { return this.post(`/containers/${id}/rename`, { name }); },
  bulkContainerAction(ids, action) { return this.post('/containers/bulk', { ids, action }); },

  // ─── Sandbox ─────────────────────────────────────
  createSandbox(data) { return this.post('/containers/sandbox', data); },
  getActiveSandboxes() { return this.get('/containers/sandbox/active'); },
  removeSandbox(id) { return this.delete(`/containers/sandbox/${id}`); },
  extendSandbox(id) { return this.post(`/containers/sandbox/${id}/extend`); },

  // ─── Container Metadata ─────────────────────────
  getAllContainerMeta() { return this.get('/containers/_meta'); },
  getContainerMeta(name) { return this.get(`/containers/${encodeURIComponent(name)}/meta`); },
  updateContainerMeta(name, data) { return this.put(`/containers/${encodeURIComponent(name)}/meta`, data); },

  // ─── Images ──────────────────────────────────────
  getImages() { return this.get('/images'); },
  getImage(id) { return this.get(`/images/${id}/inspect`); },
  getImageHistory(id) { return this.get(`/images/${id}/history`); },
  pullImage(name) { return this.post('/images/pull', { image: name }); },
  removeImage(id, force = false) { return this.delete(`/images/${id}?force=${force}`); },
  scanImage(id, scanner = 'auto') { return this.get(`/images/${id}/scan?scanner=${scanner}`); },
  getScanners() { return this.get('/images/scanners'); },

  // ─── Volumes ─────────────────────────────────────
  getVolumes() { return this.get('/volumes'); },
  getVolume(name) { return this.get(`/volumes/${name}/inspect`); },
  removeVolume(name) { return this.delete(`/volumes/${name}`); },
  createVolume(data) { return this.post('/volumes', data); },

  // ─── Networks ────────────────────────────────────
  getNetworks() { return this.get('/networks'); },
  getNetwork(id) { return this.get(`/networks/${id}/inspect`); },
  createNetwork(data) { return this.post('/networks', data); },
  removeNetwork(id) { return this.delete(`/networks/${id}`); },

  // ─── System ──────────────────────────────────────
  getSystemInfo() { return this.get('/system/info'); },
  getDiskUsage() { return this.get('/system/disk-usage'); },
  checkUpdates() { return this.get('/system/check-updates'); },
  prune(type) { return this.post(`/system/prune/${type}`); },
  getDatabaseInfo() { return this.get('/system/database'); },
  databaseCleanup() { return this.post('/system/database/cleanup'); },
  databaseCleanupAggressive(hours = 24) { return this.post('/system/database/cleanup-aggressive', { hours }); },
  databaseVacuum() { return this.post('/system/database/vacuum'); },
  updateContainer(id) { return this.post(`/containers/${id}/update`); },
  getDeployPreview(id) { return this.get(`/containers/${id}/deploy-preview`); },
  safeUpdateContainer(id) { return this.post(`/containers/${id}/safe-update`); },
  diagnoseContainer(id) { return this.get(`/containers/${id}/diagnose`); },
  smartRestart(id) { return this.post(`/containers/${id}/smart-restart`); },
  getContainerDeps(id) { return this.get(`/containers/${id}/dependencies`); },
  deployWithDeps(id, destHostId) { return this.post(`/containers/${id}/deploy-with-deps`, { destHostId }); },

  // ─── Maintenance Windows ──────────────────────────
  getMaintenanceWindows() { return this.get('/maintenance'); },
  createMaintenanceWindow(data) { return this.post('/maintenance', data); },
  updateMaintenanceWindow(id, data) { return this.put(`/maintenance/${id}`, data); },
  deleteMaintenanceWindow(id) { return this.delete(`/maintenance/${id}`); },

  // ─── Status Page ──────────────────────────────────
  getStatusPagePublic() { return this.get('/status-page/public'); },
  getStatusPageConfig() { return this.get('/status-page/config'); },
  updateStatusPageConfig(data) { return this.put('/status-page/config', data); },
  addStatusPageItem(data) { return this.post('/status-page/items', data); },
  removeStatusPageItem(id) { return this.delete(`/status-page/items/${id}`); },

  // ─── Templates ────────────────────────────────────
  getTemplates(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/templates${qs ? '?' + qs : ''}`);
  },
  getTemplate(id) { return this.get(`/templates/${id}`); },
  previewPortainerImport(url) { return this.post('/templates/import/preview', { url }); },
  importPortainerTemplates(templates) { return this.post('/templates/import', { templates }); },

  // ─── Registries ──────────────────────────────────
  getRegistries() { return this.get('/registries'); },
  createRegistry(data) { return this.post('/registries', data); },
  updateRegistry(id, data) { return this.put(`/registries/${id}`, data); },
  deleteRegistry(id) { return this.delete(`/registries/${id}`); },
  testRegistry(id) { return this.post(`/registries/${id}/test`); },
  getRegistryCatalog(id) { return this.get(`/registries/${id}/catalog`); },
  getRegistryTags(id, repo) { return this.get(`/registries/${id}/tags/${repo}`); },
  pullFromRegistry(id, image, tag) { return this.post(`/registries/${id}/pull`, { image, tag }); },

  // ─── OIDC ────────────────────────────────────────
  getOidcEnabled() { return this.get('/auth/oidc/enabled'); },
  getOidcLoginUrl() { return this.get('/auth/oidc/login'); },
  getSessions() { return this.get('/auth/sessions'); },
  terminateSession(id) { return this.delete(`/auth/sessions/${id}`); },

  getLdapConfig() { return this.get('/auth/ldap'); },
  saveLdapConfig(cfg) { return this.put('/auth/ldap', cfg); },
  deleteLdapConfig() { return this.delete('/auth/ldap'); },
  testLdapConnection(cfg) { return this.post('/auth/ldap/test', cfg); },
  getLdapUsers() { return this.get('/auth/ldap/users'); },

  // ─── Watchtower ───────────────────────────────────
  detectWatchtower() { return this.get('/watchtower'); },
  getResourceRecommendations() { return this.get('/stats/recommendations'); },
  getComparison() { return this.get('/compare'); },

  // ─── Workflows ────────────────────────────────────
  getWorkflows() { return this.get('/workflows'); },
  getWorkflowTemplates() { return this.get('/workflows/templates'); },
  createWorkflow(data) { return this.post('/workflows', data); },
  updateWorkflow(id, data) { return this.put(`/workflows/${id}`, data); },
  deleteWorkflow(id) { return this.delete(`/workflows/${id}`); },

  // ─── Dashboard Preferences ────────────────────────
  getDashboardPrefs() { return this.get('/dashboard/preferences'); },
  saveDashboardPrefs(data) { return this.put('/dashboard/preferences', data); },

  // ─── Migration ────────────────────────────────────
  previewMigration(data) { return this.post('/migrate/preview', data); },
  migrateContainer(data) { return this.post('/migrate/container', data); },
  migrateStack(data) { return this.post('/migrate/stack', data); },

  // ─── Stack Bundles (Export/Import) ────────────────
  exportStack(name) { return this.get(`/bundles/export/stack/${encodeURIComponent(name)}`); },
  exportContainer(id) { return this.get(`/bundles/export/container/${id}`); },
  exportBundleCompose(bundle) { return this.post('/bundles/export/compose', bundle); },
  importBundle(data) { return this.post('/bundles/import', data); },
  previewImport(bundle) { return this.post('/bundles/import/preview', { bundle }); },

  // ─── Search & Graph ───────────────────────────────
  globalSearch(q) { return this.get(`/search?q=${encodeURIComponent(q)}`); },
  getClusterHealth() { return this.get('/cluster-health'); },
  getDependencyGraph() { return this.get('/dependencies'); },
  getTopology() { return this.get('/system/topology'); },
  getStacks() { return this.get('/system/stacks'); },
  getStack(name) { return this.get(`/system/stacks/${encodeURIComponent(name)}`); },
  saveStackConfig(name, data) { return this.put(`/system/stacks/${encodeURIComponent(name)}/config`, data); },
  deployStack(name, data) { return this.post(`/system/stacks/${encodeURIComponent(name)}/deploy`, data); },
  updateContainerResources(id, data) { return this.put(`/system/containers/${id}/resources`, data); },

  // ─── Stats ───────────────────────────────────────
  getStatsOverview() { return this.get('/stats/overview'); },
  getContainerStatsHistory(id, range = '1h') {
    return this.get(`/stats/container/${id}?range=${range}`);
  },

  getSparklines() { return this.get('/stats/sparklines'); },
  getUptimeReport() { return this.get('/stats/uptime'); },
  getResourceTrends(id) { return this.get(`/stats/trends/${id}`); },
  getCostEstimation(monthlyCost) { return this.get(`/stats/cost?monthly_cost=${monthlyCost}`); },

  // ─── Alerts ──────────────────────────────────────
  getAlertRules() { return this.get('/alerts/rules'); },
  createAlertRule(data) { return this.post('/alerts/rules', data); },
  updateAlertRule(id, data) { return this.put(`/alerts/rules/${id}`, data); },
  deleteAlertRule(id) { return this.delete(`/alerts/rules/${id}`); },
  getActiveAlerts() { return this.get('/alerts/active'); },
  getAlertHistory(limit = 50) { return this.get(`/alerts/history?limit=${limit}`); },
  acknowledgeAlert(id) { return this.post(`/alerts/${id}/acknowledge`); },

  // ─── Webhooks ────────────────────────────────────
  getWebhooks() { return this.get('/webhooks'); },
  createWebhook(data) { return this.post('/webhooks', data); },
  deleteWebhook(id) { return this.delete(`/webhooks/${id}`); },
  testWebhook(id) { return this.post(`/webhooks/${id}/test`); },

  // ─── Containers (extended) ─────────────────────
  createContainer(data) { return this.post('/containers', data); },
  getContainerExport(id, format) { return this.get(`/containers/${id}/export?format=${format}`); },

  // ─── Firewall ──────────────────────────────────
  getFirewall() { return this.get('/system/firewall'); },
  addFirewallRule(data) { return this.post('/system/firewall/rule', data); },
  deleteFirewallRule(number) { return this.delete(`/system/firewall/rule/${number}`); },

  // ─── Firewall management MVP1 (v8.9.22, per-host over SSH/agent) ───
  fwStatus(hostId)            { return this.get(`/firewall/${hostId}/status`); },
  fwRules(hostId)             { return this.get(`/firewall/${hostId}/rules`); },
  fwAudit(hostId)            { return this.get(`/firewall/${hostId}/audit`); },
  fwAddRule(hostId, spec)     { return this.post(`/firewall/${hostId}/rule`, spec); },
  fwAllowIp(hostId, spec)     { return this.post(`/firewall/${hostId}/allow-ip`, spec); },
  fwBlockIp(hostId, spec)     { return this.post(`/firewall/${hostId}/block-ip`, spec); },
  fwOpenPort(hostId, spec)    { return this.post(`/firewall/${hostId}/open-port`, spec); },
  fwClosePort(hostId, spec)   { return this.post(`/firewall/${hostId}/close-port`, spec); },
  fwRemoveRule(hostId, uuid, extra) { return this.post(`/firewall/${hostId}/remove-rule`, { rule_uuid: uuid, ...(extra || {}) }); },
  fwExtendRule(hostId, uuid, minutes) { return this.post(`/firewall/${hostId}/extend-rule`, { rule_uuid: uuid, minutes }); },
  fwReconcile(hostId)         { return this.post(`/firewall/${hostId}/reconcile`, {}); },
  fwSnapshot(hostId, reason)  { return this.post(`/firewall/${hostId}/snapshot`, { reason }); },
  fwRollback(hostId, snapId)  { return this.post(`/firewall/${hostId}/rollback`, { snapshotId: snapId }); },
  fwGetAgentConfig(hostId)    { return this.get(`/firewall/${hostId}/agent-config`); },
  fwSetAgentConfig(hostId, d) { return this.post(`/firewall/${hostId}/agent-config`, d); },
  fwGetSudoConfig(hostId)     { return this.get(`/firewall/${hostId}/sudo-config`); },
  fwSetSudoConfig(hostId, d)  { return this.post(`/firewall/${hostId}/sudo-config`, d); },

  // ─── Platform (hypervisor) firewall write — Phase A: Proxmox (v8.11) ───
  // Commit-confirmed lifecycle: an apply/remove returns { changeId, revertAt,
  // provisional } and auto-reverts unless confirmed within the deadline.
  fwConfirmChange(hostId, changeId) { return this.post(`/firewall/${hostId}/confirm-change`, { changeId }); },
  fwRevertChange(hostId, changeId)  { return this.post(`/firewall/${hostId}/revert-change`, { changeId }); },
  fwPendingChanges(hostId)          { return this.get(`/firewall/${hostId}/pending-changes`); },

  // ─── Security Posture (v8.9.37) ───
  getPosture()                { return this.get('/posture'); },
  rescanPosture()             { return this.post('/posture/rescan', {}); },
  getPostureTrend(hostId)     { return this.get(`/posture/trend${hostId != null ? `?hostId=${hostId}` : ''}`); },
  getPostureMutes()           { return this.get('/posture/mutes'); },
  mutePosture(d)              { return this.post('/posture/mute', d); },
  unmutePosture(findingKey)   { return this.post('/posture/unmute', { findingKey }); },
  remediatePosture(action)    { return this.post('/posture/remediate', { action }); },

  // ─── Reconciler / Blueprints (v8.9.42) ───
  listBlueprints()            { return this.get('/blueprints'); },
  getBlueprint(id)            { return this.get(`/blueprints/${id}`); },
  createBlueprint(d)          { return this.post('/blueprints', d); },
  updateBlueprint(id, d)      { return this.put(`/blueprints/${id}`, d); },
  deleteBlueprint(id)         { return this.delete(`/blueprints/${id}`); },
  captureBlueprint(name)      { return this.post('/blueprints/capture', { name }); },
  planBlueprint(id)           { return this.get(`/blueprints/${id}/plan`); },
  applyBlueprint(id)          { return this.post(`/blueprints/${id}/apply`, {}); },
  importBlueprint(d)          { return this.post('/blueprints/import', d); },
  enforceBlueprint(id, on)    { return this.post(`/blueprints/${id}/enforce`, { enforce: on }); },
  setBlueprintSource(id, body){ return this.put(`/blueprints/${id}/source`, body); },
  syncBlueprint(id)           { return this.post(`/blueprints/${id}/sync`, {}); },

  // ─── Ops Copilot (v8.9.43) ───
  getCopilotBriefing(fresh)   { return this.get(`/copilot/briefing${fresh ? '?fresh=1' : ''}`); },
  askCopilot(question)        { return this.post('/copilot/ask', { question }); },
  getCopilotHistory()         { return this.get('/copilot/history'); },
  clearCopilotHistory()       { return this.delete('/copilot/history'); },
  getCopilotConfig()          { return this.get('/copilot/config'); },
  setCopilotConfig(d)         { return this.post('/copilot/config', d); },
  testCopilotConfig()         { return this.post('/copilot/config/test', {}); },

  // ─── Notifications ─────────────────────────────
  getNotifications(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/notifications${qs ? '?' + qs : ''}`);
  },
  getNotificationCount() { return this.get('/notifications/count'); },
  markNotificationRead(id) { return this.post(`/notifications/${id}/read`); },
  markAllNotificationsRead() { return this.post('/notifications/read-all'); },
  deleteNotification(id) { return this.delete(`/notifications/${id}`); },
  bulkNotifications(ids, action) { return this.post('/notifications/bulk', { ids, action }); },

  // ─── Container Groups ──────────────────────────────
  getGroups() { return this.get('/groups'); },
  getGroup(id) { return this.get(`/groups/${id}`); },
  createGroup(data) { return this.post('/groups', data); },
  updateGroup(id, data) { return this.put(`/groups/${id}`, data); },
  deleteGroup(id) { return this.delete(`/groups/${id}`); },
  addContainersToGroup(id, containerIds) { return this.post(`/groups/${id}/containers`, { containerIds }); },
  removeContainerFromGroup(groupId, containerId) { return this.delete(`/groups/${groupId}/containers/${containerId}`); },
  reorderGroups(order) { return this.put('/groups/order', { order }); },

  // ─── Compose (Stacks) ─────────────────────────────
  composeAction(stack, action) { return this.post(`/system/compose/${encodeURIComponent(stack)}/${action}`); },
  composeConfig(stack) { return this.get(`/system/compose/${encodeURIComponent(stack)}/config`); },

  // ─── Stack Permissions (RBAC) ─────────────────────
  getPermissions() { return this.get('/permissions'); },
  getUserPermissions(userId) { return this.get(`/permissions/user/${userId}`); },
  getMyPermissions() { return this.get('/permissions/me'); },
  setPermission(data) { return this.post('/permissions', data); },
  removePermission(stackName, userId) { return this.delete(`/permissions/${encodeURIComponent(stackName)}/${userId}`); },

  // ─── Swarm ───────────────────────────────────────
  getSwarmStatus()                    { return this.get('/swarm'); },
  swarmInit(data)                     { return this.post('/swarm/init', data); },
  swarmLeave(force)                   { return this.post('/swarm/leave', { force }); },
  getSwarmJoinToken()                 { return this.get('/swarm/join-token'); },
  getSwarmNodes()                     { return this.get('/swarm/nodes'); },
  updateSwarmNode(id, data)           { return this.patch(`/swarm/nodes/${id}`, data); },
  removeSwarmNode(id, force)          { return this.delete(`/swarm/nodes/${id}${force ? '?force=1' : ''}`); },
  getSwarmServices()                  { return this.get('/swarm/services'); },
  getSwarmService(id)                 { return this.get(`/swarm/services/${id}`); },
  createSwarmService(data)            { return this.post('/swarm/services', data); },
  // Deploy-to-swarm bridge (a): derive (do NOT create) a proposed service
  // spec from an existing standalone container. `hostId` is sent explicitly;
  // when it matches the globally-selected host the client also auto-appends
  // it, and the server takes the first value (the container's host wins).
  deriveSwarmServiceFromContainer(containerId, hostId) {
    return this.get(`/swarm/services/from-container?containerId=${encodeURIComponent(containerId)}&hostId=${encodeURIComponent(hostId || 0)}`);
  },
  scaleSwarmService(id, replicas)     { return this.post(`/swarm/services/${id}/scale`, { replicas }); },
  removeSwarmService(id)              { return this.delete(`/swarm/services/${id}`); },
  getSwarmTasks(serviceId)            { return this.get(`/swarm/tasks${serviceId ? `?service=${serviceId}` : ''}`); },
  // v8.8.0 — Stacks tab (Sprint 2). Stacks are derived server-side from
  // services grouped by the com.docker.stack.namespace label.
  getSwarmStacks()                    { return this.get('/swarm/stacks'); },
  removeSwarmStack(name)              { return this.delete(`/swarm/stacks/${encodeURIComponent(name)}`); },
  // v8.8.3 — deploy a stack from a compose YAML string. `source` is optional:
  // 'local-stack' tags a promotion of an existing single-host compose stack
  // (bridge b) for the audit trail; omitted for a raw YAML paste.
  deploySwarmStack(name, compose, source) { return this.post(`/swarm/stacks/${encodeURIComponent(name)}`, source ? { compose, source } : { compose }); },

  // ─── Incus (v8.9.0-alpha.2; hostId explicit as of v8.9.23) ───
  // Each call carries the Incus/LXD host id so the page works regardless of the
  // top-bar host selection (mirrors the vSphere page). /incus is in skipPrefixes.
  getIncusInfo(hostId)                { return this.get(`/incus/info?hostId=${hostId}`); },
  getIncusInstances(hostId, project)  { return this.get(`/incus/instances?hostId=${hostId}${project ? `&project=${encodeURIComponent(project)}` : ''}`); },
  getIncusInstance(hostId, name, project) { return this.get(`/incus/instances/${encodeURIComponent(name)}?hostId=${hostId}${project ? `&project=${encodeURIComponent(project)}` : ''}`); },
  startIncusInstance(hostId, name)    { return this.post(`/incus/instances/${encodeURIComponent(name)}/start?hostId=${hostId}`, {}); },
  stopIncusInstance(hostId, name, force) { return this.post(`/incus/instances/${encodeURIComponent(name)}/stop?hostId=${hostId}`, { force: !!force }); },
  restartIncusInstance(hostId, name)  { return this.post(`/incus/instances/${encodeURIComponent(name)}/restart?hostId=${hostId}`, {}); },
  freezeIncusInstance(hostId, name)   { return this.post(`/incus/instances/${encodeURIComponent(name)}/freeze?hostId=${hostId}`, {}); },
  unfreezeIncusInstance(hostId, name) { return this.post(`/incus/instances/${encodeURIComponent(name)}/unfreeze?hostId=${hostId}`, {}); },
  deleteIncusInstance(hostId, name)   { return this.delete(`/incus/instances/${encodeURIComponent(name)}?hostId=${hostId}`); },
  getIncusSnapshots(hostId, name)     { return this.get(`/incus/instances/${encodeURIComponent(name)}/snapshots?hostId=${hostId}`); },
  createIncusSnapshot(hostId, name, sn, st) { return this.post(`/incus/instances/${encodeURIComponent(name)}/snapshots?hostId=${hostId}`, { snapshotName: sn, stateful: !!st }); },
  restoreIncusSnapshot(hostId, name, sn) { return this.post(`/incus/instances/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(sn)}/restore?hostId=${hostId}`, {}); },
  deleteIncusSnapshot(hostId, name, sn) { return this.delete(`/incus/instances/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(sn)}?hostId=${hostId}`); },
  getIncusImages(hostId)              { return this.get(`/incus/images?hostId=${hostId}`); },
  getIncusProjects(hostId)            { return this.get(`/incus/projects?hostId=${hostId}`); },
  getIncusClientInfo(hostId)          { return this.get(`/incus/client-info?hostId=${hostId}`); },
  incusTrust(hostId, token)           { return this.post(`/incus/trust?hostId=${hostId}`, { token }); },

  // ─── Proxmox VE (v8.9.1-alpha.1) ────────────────
  getProxmoxInfo()                    { return this.get('/proxmox/info'); },
  getProxmoxNodes()                   { return this.get('/proxmox/nodes'); },
  getProxmoxVMs()                     { return this.get('/proxmox/vms'); },
  getProxmoxVM(node, vmid)            { return this.get(`/proxmox/vms/${encodeURIComponent(node)}/${encodeURIComponent(vmid)}`); },
  getProxmoxLXC()                     { return this.get('/proxmox/lxc'); },
  getProxmoxLXCInstance(node, vmid)   { return this.get(`/proxmox/lxc/${encodeURIComponent(node)}/${encodeURIComponent(vmid)}`); },
  getProxmoxStorages()                { return this.get('/proxmox/storages'); },
  getProxmoxBackups()                 { return this.get('/proxmox/backups'); },

  // ─── Host groups (v8.9.7-alpha.1, Gap Closure) ───
  listHostGroups()                    { return this.get('/host-groups'); },
  getHostGroup(id)                    { return this.get(`/host-groups/${id}`); },
  createHostGroup(data)               { return this.post('/host-groups', data); },
  updateHostGroup(id, data)           { return this.put(`/host-groups/${id}`, data); },
  deleteHostGroup(id)                 { return this.delete(`/host-groups/${id}`); },
  // ─── Git multi-host targets (v8.9.7, Komodo G01) ───
  getGitStackTargets(id)              { return this.get(`/git/stacks/${id}/targets`); },
  setGitStackTargets(id, hostIds)     { return this.put(`/git/stacks/${id}/targets`, { hostIds }); },
  deployGitStackAll(id)               { return this.post(`/git/stacks/${id}/deploy-all`); },
  // ─── K8s Ingress + NetworkPolicy + kubeconfig (Portainer G08, G13) ───
  getKubernetesIngresses(ns)          { return this.get(`/kubernetes/ingresses${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`); },
  getKubernetesNetworkPolicies(ns)    { return this.get(`/kubernetes/networkpolicies${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`); },
  // kubeconfig is a file download; use a link with X-Host-ID header manually
  // ─── Docker-run to compose converter (Dockge G06) ───
  convertDockerRun(command)           { return this.post('/compose/convert', { command }); },

  // ─── K8s write ops (v8.9.8, Portainer G04) ───
  scaleKubernetesDeployment(ns, name, replicas) {
    return this.post(`/kubernetes/deployments/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/scale`, { replicas });
  },
  restartKubernetesDeployment(ns, name) {
    return this.post(`/kubernetes/deployments/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/restart`, {});
  },
  deleteKubernetesPod(ns, name) {
    return this.delete(`/kubernetes/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`);
  },
  cordonKubernetesNode(name, unschedulable = true) {
    return this.post(`/kubernetes/nodes/${encodeURIComponent(name)}/cordon`, { unschedulable });
  },
  // Pod logs — SSE, use fetch + ReadableStream
  streamKubernetesPodLogs(ns, name, opts = {}) {
    const qs = new URLSearchParams();
    if (opts.container) qs.set('container', opts.container);
    if (opts.follow === false) qs.set('follow', '0');
    if (opts.tailLines) qs.set('tailLines', String(opts.tailLines));
    return `/api/kubernetes/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/logs?${qs}`;
  },

  // ─── Container webhooks (v8.9.8, Portainer G06) ───
  listContainerWebhooks()             { return this.get('/container-webhooks'); },
  getContainerWebhook(containerId)    { return this.get(`/container-webhooks/${containerId}`); },
  createContainerWebhook(containerId, data) { return this.post(`/container-webhooks/${containerId}`, data); },
  deleteContainerWebhook(containerId) { return this.delete(`/container-webhooks/${containerId}`); },

  // ─── Docker events SSE (v8.9.8, Portainer G09) ───
  dockerEventsStreamUrl(filter) {
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    return `/api/docker/events${qs}`;
  },

  // ─── Volume file browser (v8.9.9, Portainer G07) ───
  browseVolume(name, path)            { return this.get(`/volumes/${encodeURIComponent(name)}/browse?path=${encodeURIComponent(path || '/')}`); },
  readVolumeFile(name, path)          { return this.get(`/volumes/${encodeURIComponent(name)}/read?path=${encodeURIComponent(path)}`); },
  deleteVolumeFile(name, path)        { return this.delete(`/volumes/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`); },

  // ─── Uptime Kuma auto-detect (v8.9.9, Dockge G08) ───
  detectUptimeKuma()                  { return this.get('/integrations/uptime-kuma'); },

  // ─── Teams (v8.9.10, Portainer G01) ───
  listTeams()                         { return this.get('/teams'); },
  getTeam(id)                         { return this.get(`/teams/${id}`); },
  createTeam(data)                    { return this.post('/teams', data); },
  updateTeam(id, data)                { return this.put(`/teams/${id}`, data); },
  deleteTeam(id)                      { return this.delete(`/teams/${id}`); },
  addTeamMember(teamId, userId)       { return this.post(`/teams/${teamId}/members`, { userId }); },
  removeTeamMember(teamId, userId)    { return this.delete(`/teams/${teamId}/members/${userId}`); },

  // ─── Per-host access control (v8.9.10, Portainer G02) ───
  listHostPermissions(hostId)         { return this.get(`/host-permissions?hostId=${hostId}`); },
  grantHostPermission(data)           { return this.post('/host-permissions', data); },
  revokeHostPermission(id)            { return this.delete(`/host-permissions/${id}`); },
  getEffectiveHostPermission(hostId)  { return this.get(`/host-permissions/effective?hostId=${hostId}`); },
  getLegacyHostAccessDefault()        { return this.get('/host-permissions/legacy-default'); },
  setLegacyHostAccessDefault(enabled) { return this.post('/host-permissions/legacy-default', { enabled }); },

  // ─── Alert channel routing (v8.9.9, Komodo G09) ───
  listAlertRoutes()                   { return this.get('/alert-routes'); },
  createAlertRoute(data)              { return this.post('/alert-routes', data); },
  deleteAlertRoute(id)                { return this.delete(`/alert-routes/${id}`); },
  resolveAlertRoute(hostId, severity) { return this.get(`/alert-routes/resolve?${hostId ? `hostId=${hostId}&` : ''}severity=${encodeURIComponent(severity || 'info')}`); },

  // ─── Nomad (v8.9.5-alpha.1, Sprint 10) — read-only alpha ───
  getNomadInfo()                      { return this.get('/nomad/info'); },
  getNomadNamespaces()                { return this.get('/nomad/namespaces'); },
  getNomadJobs(namespace)             { return this.get(`/nomad/jobs${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },
  getNomadJob(id, namespace)          { return this.get(`/nomad/jobs/${encodeURIComponent(id)}${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },
  getNomadJobAllocations(id, ns)      { return this.get(`/nomad/jobs/${encodeURIComponent(id)}/allocations${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`); },
  getNomadAllocations(namespace)      { return this.get(`/nomad/allocations${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },
  getNomadNodes()                     { return this.get('/nomad/nodes'); },
  getNomadDeployments(namespace)      { return this.get(`/nomad/deployments${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },

  // ─── vSphere / ESXi (v8.9.11-alpha.1) — read-only alpha ───
  // hostId is explicit: the vSphere page resolves its own daemon host so it
  // works regardless of which host is selected in the top-bar switcher.
  reconnectVSphere(hostId)           { return this.post(`/vsphere/reconnect?hostId=${hostId}`, {}); },
  getVSphereInfo(hostId)              { return this.get(`/vsphere/info?hostId=${hostId}`); },
  getVSphereVMs(hostId)               { return this.get(`/vsphere/vms?hostId=${hostId}`); },
  getVSphereHosts(hostId)             { return this.get(`/vsphere/hosts?hostId=${hostId}`); },
  getVSphereDatastores(hostId)        { return this.get(`/vsphere/datastores?hostId=${hostId}`); },
  getVSphereVersionCheck(hostId)      { return this.get(`/vsphere/version-check?hostId=${hostId}`); },
  getVSphereNetworks(hostId)          { return this.get(`/vsphere/networks?hostId=${hostId}`); },
  getVSphereServices(hostId)          { return this.get(`/vsphere/services?hostId=${hostId}`); },
  getVSphereHostInfo(hostId)          { return this.get(`/vsphere/host-info?hostId=${hostId}`); },
  getVSphereHistory(hostId, limit)    { return this.get(`/vsphere/history?hostId=${hostId}&limit=${limit || 500}`); },
  browseVSphereDatastore(hostId, datastore, path) {
    return this.get(`/vsphere/datastore-browse?hostId=${hostId}&datastore=${encodeURIComponent(datastore)}&path=${encodeURIComponent(path || '')}`);
  },
  vsphereDatastoreDownloadUrl(hostId, datastore, path) {
    return `/api/vsphere/datastore-download?hostId=${hostId}&datastore=${encodeURIComponent(datastore)}&path=${encodeURIComponent(path)}`;
  },
  // Upload streams the raw File as the body (octet-stream) so the server can
  // pipe it straight to ESXi without multipart parsing.
  async uploadVSphereDatastoreFile(hostId, datastore, path, file) {
    const url = `/api/vsphere/datastore-upload?hostId=${hostId}&datastore=${encodeURIComponent(datastore)}&path=${encodeURIComponent(path)}`;
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (this._bearerToken) headers['Authorization'] = `Bearer ${this._bearerToken}`;
    const xsrf = this._readXsrfToken(); if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
    const res = await fetch(url, { method: 'PUT', headers, credentials: 'same-origin', body: file });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Upload failed (${res.status})`); }
    return res.json();
  },
  deleteVSphereDatastoreFile(hostId, datastore, path) {
    return this.delete(`/vsphere/datastore-file?hostId=${hostId}&datastore=${encodeURIComponent(datastore)}&path=${encodeURIComponent(path)}`);
  },
  vsphereServiceAction(hostId, action, serviceKey) {
    return this.post(`/vsphere/service/${action}?hostId=${hostId}`, { serviceKey });
  },
  getVSphereSshTelemetry(hostId)      { return this.get(`/vsphere/ssh/telemetry?hostId=${hostId}`); },
  testVSphereSsh(hostId)              { return this.post(`/vsphere/ssh/test?hostId=${hostId}`, {}); },

  // ─── Kubernetes (v8.9.4-alpha.1, Sprint 5) — read-only alpha ───
  getKubernetesVersion()              { return this.get('/kubernetes/version'); },
  getKubernetesNamespaces()           { return this.get('/kubernetes/namespaces'); },
  getKubernetesPods(namespace)        { return this.get(`/kubernetes/pods${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },
  getKubernetesDeployments(namespace) { return this.get(`/kubernetes/deployments${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },
  getKubernetesServices(namespace)    { return this.get(`/kubernetes/services${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''}`); },
  getKubernetesNodes()                { return this.get('/kubernetes/nodes'); },

  // ─── VM Migration (v8.9.2-alpha.1, Sprint 7) ───
  listMigrationJobs()                 { return this.get('/migration-vm?limit=100'); },
  getMigrationJob(id)                 { return this.get(`/migration-vm/${id}`); },
  createMigrationJob(spec)            { return this.post('/migration-vm', spec); },

  // ─── Secrets Audit ────────────────────────────────────
  getSecretsAudit() { return this.get('/system/secrets-audit'); },
  validateDeploy(data) { return this.post('/system/deploy-validate', data); },

  // ─── Egress Audit ─────────────────────────────────────
  getEgressAudit() { return this.get('/system/egress-audit'); },

  // ─── Translations (v6.11.0) ───────────────────────────
  translationsProviders()                      { return this.get('/translations/providers'); },
  translationsUpsertProvider(body)             { return this.post('/translations/providers', body); },
  translationsTestProvider(id)                 { return this.post(`/translations/providers/${id}/test`); },
  translationsPatchProvider(id, body)          { return this.patch(`/translations/providers/${id}`, body); },
  translationsDeleteProvider(id)               { return this.delete(`/translations/providers/${id}`); },
  translationsUsage(yearMonth)                 { return this.get(`/translations/usage${yearMonth ? `?yearMonth=${yearMonth}` : ''}`); },
  translationsLanguages()                      { return this.get('/translations/languages'); },
  translationsMissing(language)                { return this.get(`/translations/missing?language=${encodeURIComponent(language)}`); },
  translationsBatch(body)                      { return this.post('/translations/batch', body); },
  translationsList(opts = {})                  {
    const q = [];
    if (opts.language) q.push(`language=${encodeURIComponent(opts.language)}`);
    if (opts.status) q.push(`status=${encodeURIComponent(opts.status)}`);
    return this.get(`/translations${q.length ? '?' + q.join('&') : ''}`);
  },
  translationsPatch(id, body)                  { return this.patch(`/translations/${id}`, body); },
  translationsExportUrl(language)              { return `/api/translations/export?language=${encodeURIComponent(language)}`; },
  translationsMarkExported(language)           { return this.post('/translations/mark-exported', { language }); },

  // ─── Egress Filter (v6.7 alpha.1: config only, no enforcement yet) ──
  egressFilterPresets()                { return this.get('/egress-filter/presets'); },
  egressFilterListPolicies(hostId)     { return this.get(`/egress-filter/policies${hostId != null ? `?hostId=${hostId}` : ''}`); },
  egressFilterGetPolicy(id)            { return this.get(`/egress-filter/policies/${id}`); },
  egressFilterCreatePolicy(body)       { return this.post('/egress-filter/policies', body); },
  egressFilterUpdatePolicy(id, body)   { return this.patch(`/egress-filter/policies/${id}`, body); },
  egressFilterDeletePolicy(id, reason) { return this.delete(`/egress-filter/policies/${id}`, { reason }); },
  egressFilterApply(id)                { return this.post(`/egress-filter/policies/${id}/apply`); },
  egressFilterUnapply(id)              { return this.post(`/egress-filter/policies/${id}/unapply`); },
  egressFilterStatus(id)               { return this.get(`/egress-filter/policies/${id}/status`); },
  egressFilterBlockLog(id, opts = {}) {
    const q = [];
    if (opts.limit != null) q.push(`limit=${opts.limit}`);
    if (opts.sinceId != null) q.push(`sinceId=${opts.sinceId}`);
    return this.get(`/egress-filter/policies/${id}/block-log${q.length ? '?' + q.join('&') : ''}`);
  },
  egressFilterBlockLogGrouped(id, opts = {}) {
    const q = [];
    if (opts.sinceHours != null) q.push(`sinceHours=${opts.sinceHours}`);
    if (opts.limit != null) q.push(`limit=${opts.limit}`);
    return this.get(`/egress-filter/policies/${id}/block-log/grouped${q.length ? '?' + q.join('&') : ''}`);
  },
  egressFilterAllowHostname(id, hostname) {
    return this.post(`/egress-filter/policies/${id}/allow-hostname`, { hostname });
  },

  // ─── Secrets Wizard ───────────────────────────────────
  analyzeSecretsWizard(envContent) { return this.post('/system/secrets-wizard/analyze', { envContent }); },
  generateSecretsScript(data) {
    return fetch('/api/system/secrets-wizard/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this._bearerToken ? { Authorization: 'Bearer ' + this._bearerToken } : {}) },
      credentials: 'same-origin',
      body: JSON.stringify(data),
    }).then(r => r.text());
  },
  generateSecretsCompose(data) {
    return fetch('/api/system/secrets-wizard/generate-compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this._bearerToken ? { Authorization: 'Bearer ' + this._bearerToken } : {}) },
      credentials: 'same-origin',
      body: JSON.stringify(data),
    }).then(r => r.text());
  },

  // ─── Secret Rotations ────────────────────────────
  getSecretRotations() { return this.get('/secrets-rotations'); },
  getSecretRotationsSummary() { return this.get('/secrets-rotations/summary'); },
  registerSecretRotations(data) { return this.post('/secrets-rotations/bulk', data); },
  markSecretRotated(id, notes) { return this.post(`/secrets-rotations/${id}/mark-rotated`, { notes: notes || '' }); },
  updateSecretRotation(id, data) { return this.patch('/secrets-rotations/' + id, data); },
  deleteSecretRotation(id) { return this.delete('/secrets-rotations/' + id); },
  getSecretRotationHistory(id) { return this.get(`/secrets-rotations/${id}/history`); },

  // ─── Secrets Wizard Preflight ────────────────────
  secretsWizardPreflight() { return this.get('/system/secrets-wizard/preflight'); },

  // ─── Secrets Remote Deploy ───────────────────────
  deploySecretsRemote(data) { return this.post('/system/secrets-wizard/deploy-remote', data); },
  getSecretsDeployLog(jobId) { return this.get('/system/secrets-wizard/deploy-log/' + jobId); },

  // ─── Remediation Wizard (v6.6) ────────────────────
  remediateListCodes() { return this.get('/remediate/findings/codes'); },
  remediatePlan(data) { return this.post('/remediate/plan', data); },
  remediateApply(data) { return this.post('/remediate/apply', data); },
  remediateConfig() { return this.get('/remediate/config'); },
  remediateJob(jobId) { return this.get(`/remediate/job/${jobId}`); },
  remediateRollback(jobId) { return this.post(`/remediate/job/${jobId}/rollback`); },
  remediateListJobs(limit) { return this.get(`/remediate/jobs${limit ? '?limit=' + limit : ''}`); },

  // ─── ACME / Let's Encrypt Wizard (v6.5) ──────────
  acmeListProviders() { return this.get('/system/acme/providers'); },
  acmeHealth() { return this.get('/system/acme/health'); },
  acmeListCredentials() { return this.get('/system/acme/credentials'); },
  acmeCreateCredential(data) { return this.post('/system/acme/credentials', data); },
  acmeRotateCredential(id, credentials) { return this.patch(`/system/acme/credentials/${id}`, { credentials }); },
  acmeDeleteCredential(id) { return this.delete(`/system/acme/credentials/${id}`); },
  acmeValidateCredential(id) { return this.post(`/system/acme/credentials/${id}/validate`); },
  acmeIssue(data) { return this.post('/system/acme/issue', data); },
  acmeJob(jobId) { return this.get(`/system/acme/jobs/${jobId}`); },
  acmeListManagedCerts() { return this.get('/system/acme/managed-certs'); },
  acmeRemoveCert(domain) { return this.delete(`/system/acme/cert/${encodeURIComponent(domain)}`); },

  // ─── Certificate Management ──────────────────────
  getTrackedCertificates() { return this.get('/system/certificates'); },
  addTrackedCertificate(data) { return this.post('/system/certificates', data); },
  refreshCertificate(id) { return this.post(`/system/certificates/${id}/refresh`); },
  deleteTrackedCertificate(id) { return this.delete('/system/certificates/' + id); },
  generateCSR(data) { return this.post('/system/certificates/csr', data); },

  // ─── SSL/TLS ──────────────────────────────────────
  runCisBenchmark(hostId) { return this.get(`/system/cis-benchmark${hostId ? `?hostId=${hostId}` : ''}`); },
  getCisHardenedCompose(containerName, hostId) { return this.get(`/system/cis/container/${encodeURIComponent(containerName)}/hardened-compose${hostId ? `?hostId=${hostId}` : ''}`); },
  getSslStatus() { return this.get('/system/ssl/status'); },
  getCaddyStatus() { return this.get('/system/ssl/caddy-status'); },
  getCertificates() { return this.get('/system/ssl/certificates'); },
  generateSelfSigned(domain) { return this.post('/system/ssl/self-signed', { domain }); },
  saveCaddyfile(domain, upstreamPort) { return this.post('/system/ssl/caddy', { domain, upstreamPort }); },
  enableHttps(domain, upstreamPort) { return this.post('/system/ssl/enable', { domain, upstreamPort }); },
  removeSsl() { return this.delete('/system/ssl'); },

  // ─── Health Overview ─────────────────────────────
  getHealthOverview() { return this.get('/system/health-overview'); },

  // ─── Schedules ───────────────────────────────────
  getSchedules() { return this.get('/system/schedules'); },
  createSchedule(data) { return this.post('/system/schedules', data); },
  updateSchedule(id, data) { return this.put(`/system/schedules/${id}`, data); },
  deleteSchedule(id) { return this.delete(`/system/schedules/${id}`); },
  getScheduleHistory(id) { return this.get(`/system/schedules/${id}/history`); },
  runScheduleNow(id) { return this.post(`/system/schedules/${id}/run-now`); },
  previewCron(cron) { return this.get(`/system/schedules/preview?cron=${encodeURIComponent(cron)}`); },

  // ─── Container Files ─────────────────────────────
  getContainerFiles(id, path = '/') { return this.get(`/containers/${id}/files?path=${encodeURIComponent(path)}`); },
  getFileContent(id, path) { return this.get(`/containers/${id}/files/content?path=${encodeURIComponent(path)}`); },
  getFileDownloadUrl(id, path) { return `/api/containers/${id}/files/download?path=${encodeURIComponent(path)}`; },
  uploadFile(id, destPath, filename, base64Content) { return this.post(`/containers/${id}/files/upload`, { path: destPath, filename, content: base64Content }); },

  // ─── Container Diff ──────────────────────────────
  getContainerDiff(id) { return this.get(`/containers/${id}/diff`); },

  // ─── Container History & Rollback ────────────────
  getContainerHistory(id) { return this.get(`/containers/${id}/history`); },
  rollbackContainer(id, historyId) { return this.post(`/containers/${id}/rollback`, { historyId }); },

  // ─── Compose Validation ──────────────────────────
  validateStackConfig(name, data) { return this.post(`/system/stacks/${encodeURIComponent(name)}/validate`, data); },

  // ─── Backup & Restore ───────────────────────────
  restoreConfig(data) { return this.post('/system/backup/restore', data); },
  restoreDatabase(base64Content) { return this.post('/backup/restore', { content: base64Content }); },
  backupToS3(data) { return this.post('/system/backup/s3', data); },
  getBackupList() { return this.get('/system/backup/list'); },

  // ─── Docker Versions ─────────────────────────────
  getDockerVersions() { return this.get('/docker-versions'); },

  // ─── Resource Limits ─────────────────────────────
  updateContainerResources(id, data) { return this.put(`/system/containers/${id}/resources`, data); },

  // ─── Templates (uses /api/templates, defined above) ─

  // ─── Health Check Logs ────────────────────────────
  getHealthLogs(id) { return this.get(`/system/containers/${id}/health-logs`); },

  // ─── Topology ─────────────────────────────────────
  getTopology() { return this.get('/system/topology'); },

  // ─── Registries ────────────────────────────────────
  getRegistries() { return this.get('/registries'); },
  createRegistry(data) { return this.post('/registries', data); },
  updateRegistry(id, data) { return this.put(`/registries/${id}`, data); },
  deleteRegistry(id) { return this.delete(`/registries/${id}`); },
  testRegistry(id) { return this.post(`/registries/${id}/test`); },
  getRegistryCatalog(id) { return this.get(`/registries/${id}/catalog`); },
  getRegistryTags(id, repo) { return this.get(`/registries/${id}/tags/${repo}`); },
  getImageConfig(id) { return this.get(`/images/${encodeURIComponent(id)}/config`); },

  // ─── Git ─────────────────────────────────────────
  getGitCredentials() { return this.get('/git/credentials'); },
  createGitCredential(data) { return this.post('/git/credentials', data); },
  updateGitCredential(id, data) { return this.put(`/git/credentials/${id}`, data); },
  deleteGitCredential(id) { return this.delete(`/git/credentials/${id}`); },
  getGitStacks() { return this.get('/git/stacks'); },
  getGitStack(id) { return this.get(`/git/stacks/${id}`); },
  createGitStack(data) { return this.post('/git/stacks', data); },
  updateGitStack(id, data) { return this.put(`/git/stacks/${id}`, data); },
  deleteGitStack(id, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.delete(`/git/stacks/${id}${qs ? '?' + qs : ''}`);
  },
  deployGitStack(id, data) { return this.post(`/git/stacks/${id}/deploy`, data); },
  checkGitStack(id) { return this.post(`/git/stacks/${id}/check`); },
  testGitConnection(data) { return this.post('/git/test-connection', data); },
  getGitDeployments(id, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/git/stacks/${id}/deployments${qs ? '?' + qs : ''}`);
  },
  regenerateWebhook(id) { return this.post(`/git/stacks/${id}/webhook/regenerate`); },
  getWebhookUrl(id) { return this.get(`/git/stacks/${id}/webhook-url`); },
  updateAutoDeployConfig(id, data) { return this.put(`/git/stacks/${id}/auto-deploy`, data); },
  getGitDiff(id) { return this.get(`/git/stacks/${id}/diff`); },
  getGitDriftAll() { return this.get('/git/stacks/drift'); },
  getGitDrift(id) { return this.get(`/git/stacks/${id}/drift`); },
  scanGitDrift(id) { return this.post(`/git/stacks/${id}/drift-scan`); },
  rollbackGitStack(stackId, deploymentId) { return this.post(`/git/stacks/${stackId}/rollback/${deploymentId}`); },
  getGitEnv(id) { return this.get(`/git/stacks/${id}/env`); },
  updateGitEnv(id, variables) { return this.put(`/git/stacks/${id}/env`, { variables }); },
  importGitEnv(id, content, sensitiveKeys) { return this.post(`/git/stacks/${id}/env/import`, { content, sensitiveKeys }); },
  getRemoteStatus(id) { return this.get(`/git/stacks/${id}/remote-status`); },
  pushToGit(id, data) { return this.post(`/git/stacks/${id}/push`, data); },

  // ─── Notification Channels ──────────────────────
  getNotificationProviders() { return this.get('/notification-channels/providers'); },
  getNotificationChannels() { return this.get('/notification-channels'); },
  createNotificationChannel(data) { return this.post('/notification-channels', data); },
  updateNotificationChannel(id, data) { return this.put(`/notification-channels/${id}`, data); },
  deleteNotificationChannel(id) { return this.delete(`/notification-channels/${id}`); },
  testNotificationChannel(id) { return this.post(`/notification-channels/${id}/test`); },

  // ─── Multi-Host ─────────────────────────────────
  getMultiHostOverview() { return this.get('/multi-host/overview'); },

  // ─── Hosts ──────────────────────────────────────
  getHosts() { return this.get('/hosts'); },
  getHost(id) { return this.get(`/hosts/${id}`); },
  createHost(data) { return this.post('/hosts', data); },
  // v8.9.11-alpha.3 — test non-Docker host connection (wizard "Test" button).
  // hostId (optional) lets the Edit dialog test with stored secrets it can't
  // see: the backend merges blank fields from the saved daemon_config.
  testNonDockerHost(daemonType, daemonConfig, hostId) {
    return this.post('/hosts/test-non-docker', { daemonType, daemonConfig, hostId });
  },
  testHostSsh(sshConfig, hostId) {
    return this.post('/hosts/test-ssh', { sshConfig, hostId });
  },
  // ─── SSH Key Deployer (v8.9.16, System → Tools) ───
  generateSshKey(opts)                { return this.post('/ssh-keys/generate', opts || {}); },
  deploySshKey(payload)              { return this.post('/ssh-keys/deploy', payload); },
  testSshConnection(payload)         { return this.post('/ssh-keys/test-connection', payload); },
  testDeployedSshKey(payload)        { return this.post('/ssh-keys/test', payload); },
  attachSshKeyVsphere(payload)       { return this.post('/ssh-keys/attach-vsphere', payload); },
  listVsphereHostsForSsh()           { return this.get('/ssh-keys/vsphere-hosts'); },
  updateHost(id, data) { return this.put(`/hosts/${id}`, data); },
  deleteHost(id) { return this.delete(`/hosts/${id}`); },
  testHostConnection(data) { return this.post('/hosts/test', data); },
  testHost(id) { return this.post(`/hosts/${id}/test`); },
  // v8.10.x — Connection Health circuit breaker: manual "Retry" for a
  // paused/failing host (clears the circuit + forces a fresh attempt).
  reconnectHost(id) { return this.post(`/hosts/${id}/reconnect`); },
  getHostInfo(id) { return this.get(`/hosts/${id}/info`); },
  setDefaultHost(id) { return this.post(`/hosts/${id}/default`); },
  drainHost(id) { return this.post(`/hosts/${id}/drain`); },
  activateHost(id) { return this.post(`/hosts/${id}/activate`); },

  // ─── Onboarding & Provisioning Wizard (v8.15.0, Phase 1) ─────
  // One engine, one document (onboarding-declaration v1 — src/services/
  // provisioning/declaration.js). plan() is a dry-run (writes nothing);
  // apply() validates -> plans -> executes the saga and either resolves with
  // the completed run or rejects with {error, runId, step, resumable:true}
  // (409) so the wizard can offer Resume/Rollback. Secrets travel in the
  // declaration body (encrypted server-side on ingest) but are never echoed
  // back — every read endpoint below returns them redacted.
  onboardingPlan(decl) { return this.post('/onboarding/plan', decl); },
  onboardingApply(decl) { return this.post('/onboarding/apply', decl); },
  getActiveOnboardingRun() { return this.get('/onboarding/runs/active'); },
  getOnboardingRun(id) { return this.get(`/onboarding/runs/${id}`); },
  resumeOnboardingRun(id) { return this.post(`/onboarding/runs/${id}/resume`); },
  rollbackOnboardingRun(id) { return this.post(`/onboarding/runs/${id}/rollback`); },
  // Returns the download URL (Content-Disposition: attachment) — same
  // pattern as exportAuditCsv() below; the caller drives the actual download.
  // `asTemplate` emits a template-shaped spec instead of a declaration.
  exportOnboardingRunUrl(id, asTemplate) { return `/api/onboarding/runs/${id}/export${asTemplate ? '?asTemplate=1' : ''}`; },

  // ─── Onboarding templates (v8.16.0, Phase 2) ─────────────────
  // Built-ins (is_builtin=1) come from src/db/onboarding-templates/*.json and
  // are re-imported at every boot — the FILE overrides the DB row, so they can
  // be read but never written or deleted through the API. Custom templates
  // (is_builtin=0) are admin-created via saveOnboardingTemplate(). A template
  // never carries a secret: the server strips them before validating.
  listOnboardingTemplates() { return this.get('/onboarding/templates'); },
  getOnboardingTemplate(key) { return this.get(`/onboarding/templates/${encodeURIComponent(key)}`); },
  saveOnboardingTemplate(body) { return this.post('/onboarding/templates', body); },
  deleteOnboardingTemplate(key) { return this.delete(`/onboarding/templates/${encodeURIComponent(key)}`); },

  // ─── Demo / trial mock data + promotion gate (v8.17.0, Phase 3) ───
  // The generator is synthetic-by-construction (RFC1918/TEST-NET addresses,
  // *.test/*.example domains, viewer-only demo users) and every row it writes is
  // tagged `seed_run_id`, so purge/reset can never touch a real row. Production
  // is refused at three independent layers, and promoting a tenant to production
  // is blocked while any live batch or placeholder credential exists —
  // getTenantPromotion() returns the structured remediation list.
  getSeedCatalog(scenario) { return this.get(`/onboarding/seed/catalog${scenario ? `?scenario=${encodeURIComponent(scenario)}` : ''}`); },
  getTenantSeed(tenantId, all) { return this.get(`/onboarding/tenants/${tenantId}/seed${all ? '?all=1' : ''}`); },
  purgeTenantSeed(tenantId) { return this.post(`/onboarding/tenants/${tenantId}/seed/purge`); },
  resetTenantSeed(tenantId, body) { return this.post(`/onboarding/tenants/${tenantId}/seed/reset`, body || {}); },
  regenerateTenantSeed(tenantId, body) { return this.post(`/onboarding/tenants/${tenantId}/seed/regenerate`, body || {}); },
  getTenantPromotion(tenantId) { return this.get(`/onboarding/tenants/${tenantId}/promotion`); },
  promoteTenant(tenantId, body) { return this.post(`/onboarding/tenants/${tenantId}/promote`, body || {}); },

  // ─── Drift re-provision + trial lifecycle (v8.18.0, Phase 4) ───
  // replanOnboarding() is a READ-ONLY diff of a declaration vs an existing tenant
  // (categorized toCreate/toUpdate/inSync per resource); convergence is the
  // existing idempotent /apply. extendTrial() pushes a trial's expiry out and
  // reactivates a lapsed/suspended trial.
  replanOnboarding(tenantId, declaration) { return this.post(`/onboarding/tenants/${tenantId}/replan`, declaration); },
  extendTrial(tenantId, body) { return this.post(`/onboarding/tenants/${tenantId}/extend-trial`, body || {}); },

  // ─── About ─────────────────────────────────────
  getAboutFiles() { return this.get('/about/files'); },
  getAboutFile(name) { return this.get(`/about/file/${encodeURIComponent(name)}`); },
  saveAboutFile(name, content) { return this.put(`/about/file/${encodeURIComponent(name)}`, { content }); },

  // ─── User Preferences ─────────────────────────────
  getUserPreferences() { return this.get('/preferences'); },
  saveUserPreference(key, value) { return this.put('/preferences', { key, value }); },

  // ─── AI Chat ─────────────────────────────────────
  aiChat(prompt, provider, config) { return this.post('/ai/chat', { prompt, provider, config }); },
  aiGithubCompose(repoUrl, provider, config) { return this.post('/ai/github-compose', { repoUrl, provider, config }); },

  // ─── MOTD ────────────────────────────────────────
  getMotd() { return this.get('/motd'); },
  getMotdConfig() { return this.get('/motd/config'); },
  setMotd(data) { return this.put('/motd', typeof data === 'string' ? { motd: data } : data); },

  // ─── How-To ───────────────────────────────────
  getHowtoGuides(params = {}) { const qs = new URLSearchParams(params).toString(); return this.get(`/howto${qs ? '?' + qs : ''}`); },
  getHowtoGuide(slug) { return this.get(`/howto/${encodeURIComponent(slug)}`); },
  createHowtoGuide(data) { return this.post('/howto', data); },
  updateHowtoGuide(slug, data) { return this.put(`/howto/${encodeURIComponent(slug)}`, data); },
  deleteHowtoGuide(slug) { return this.delete(`/howto/${encodeURIComponent(slug)}`); },

  // ─── Misc ────────────────────────────────────────
  health() { return this.get('/health'); },
  getFootprint() { return this.get('/footprint'); },
  getFavorites() { return this.get('/favorites'); },
  toggleFavorite(containerId) { return this.post(`/favorites/${containerId}`); },
  getImageFreshness() { return this.get('/images/freshness'); },
  getAuditAnalytics(days = 7) { return this.get(`/audit/analytics?days=${days}`); },
  exportAuditCsv(days = 30) { return `/api/audit/export?days=${days}`; }, // Returns URL for download
  getAuditLog(page = 1, limit = 50) {
    return this.get(`/audit?page=${page}&limit=${limit}`);
  },
  getSettings() { return this.get('/settings'); },
  updateSetting(key, value) { return this.put(`/settings/${key}`, { value }); },
};

window.Api = Api;
