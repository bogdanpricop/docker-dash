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
    const skipPrefixes = ['/auth', '/settings', '/hosts', '/notifications', '/webhooks', '/alerts/rules', '/favorites', '/audit', '/git/credentials', '/git/test-connection', '/groups', '/dashboard/preferences', '/docs'];
    if (skipPrefixes.some(p => path.startsWith(p))) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}hostId=${this._currentHostId}`;
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
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(`/api${this._appendHostId(path)}`, options);
      if (res.status === 401 && !path.startsWith('/auth/login')) {
        App.handleUnauthorized();
        throw new Error('Unauthorized');
      }
      const data = res.headers.get('content-type')?.includes('json')
        ? await res.json()
        : await res.text();
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
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
  scaleSwarmService(id, replicas)     { return this.post(`/swarm/services/${id}/scale`, { replicas }); },
  removeSwarmService(id)              { return this.delete(`/swarm/services/${id}`); },
  getSwarmTasks(serviceId)            { return this.get(`/swarm/tasks${serviceId ? `?service=${serviceId}` : ''}`); },

  // ─── SSL/TLS ──────────────────────────────────────
  runCisBenchmark(hostId) { return this.get(`/system/cis-benchmark${hostId ? `?hostId=${hostId}` : ''}`); },
  getCisHardenedCompose(containerName, hostId) { return this.get(`/system/cis/container/${encodeURIComponent(containerName)}/hardened-compose${hostId ? `?hostId=${hostId}` : ''}`); },
  getSslStatus() { return this.get('/system/ssl/status'); },
  getCaddyStatus() { return this.get('/system/ssl/caddy-status'); },
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

  // ─── Hosts ──────────────────────────────────────
  getHosts() { return this.get('/hosts'); },
  getHost(id) { return this.get(`/hosts/${id}`); },
  createHost(data) { return this.post('/hosts', data); },
  updateHost(id, data) { return this.put(`/hosts/${id}`, data); },
  deleteHost(id) { return this.delete(`/hosts/${id}`); },
  testHostConnection(data) { return this.post('/hosts/test', data); },
  testHost(id) { return this.post(`/hosts/${id}/test`); },
  getHostInfo(id) { return this.get(`/hosts/${id}/info`); },
  setDefaultHost(id) { return this.post(`/hosts/${id}/default`); },

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
