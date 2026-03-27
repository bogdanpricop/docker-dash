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
    const skipPrefixes = ['/auth', '/settings', '/hosts', '/notifications', '/webhooks', '/alerts/rules', '/favorites', '/audit', '/git/credentials', '/git/test-connection'];
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
      if (res.status === 401) {
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
  getContainerLogs(id, tail = 200, search = '') {
    let url = `/containers/${id}/logs?tail=${tail}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    return this.get(url);
  },
  getContainerStats(id) { return this.get(`/containers/${id}/stats`); },
  containerAction(id, action) { return this.post(`/containers/${id}/${action}`); },
  removeContainer(id, force = false) { return this.delete(`/containers/${id}?force=${force}`); },
  renameContainer(id, name) { return this.post(`/containers/${id}/rename`, { name }); },
  bulkContainerAction(ids, action) { return this.post('/containers/bulk', { ids, action }); },

  // ─── Container Metadata ─────────────────────────
  getAllContainerMeta() { return this.get('/containers/_meta'); },
  getContainerMeta(name) { return this.get(`/containers/${encodeURIComponent(name)}/meta`); },
  updateContainerMeta(name, data) { return this.put(`/containers/${encodeURIComponent(name)}/meta`, data); },

  // ─── Images ──────────────────────────────────────
  getImages() { return this.get('/images'); },
  getImage(id) { return this.get(`/images/${id}/inspect`); },
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
  getNotifications() { return this.get('/notifications'); },
  getNotificationCount() { return this.get('/notifications/count'); },
  markNotificationRead(id) { return this.post(`/notifications/${id}/read`); },
  markAllNotificationsRead() { return this.post('/notifications/read-all'); },

  // ─── Compose (Stacks) ─────────────────────────────
  composeAction(stack, action) { return this.post(`/system/compose/${encodeURIComponent(stack)}/${action}`); },
  composeConfig(stack) { return this.get(`/system/compose/${encodeURIComponent(stack)}/config`); },

  // ─── Health Overview ─────────────────────────────
  getHealthOverview() { return this.get('/system/health-overview'); },

  // ─── Schedules ───────────────────────────────────
  getSchedules() { return this.get('/system/schedules'); },
  createSchedule(data) { return this.post('/system/schedules', data); },
  updateSchedule(id, data) { return this.put(`/system/schedules/${id}`, data); },
  deleteSchedule(id) { return this.delete(`/system/schedules/${id}`); },

  // ─── Backup & Restore ───────────────────────────
  restoreConfig(data) { return this.post('/system/backup/restore', data); },

  // ─── Resource Limits ─────────────────────────────
  updateContainerResources(id, data) { return this.put(`/system/containers/${id}/resources`, data); },

  // ─── Templates ────────────────────────────────────
  getTemplates() { return this.get('/system/templates'); },

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

  // ─── Misc ────────────────────────────────────────
  health() { return this.get('/health'); },
  getFootprint() { return this.get('/footprint'); },
  getFavorites() { return this.get('/favorites'); },
  toggleFavorite(containerId) { return this.post(`/favorites/${containerId}`); },
  getImageFreshness() { return this.get('/images/freshness'); },
  getAuditAnalytics(days = 7) { return this.get(`/audit/analytics?days=${days}`); },
  getAuditLog(page = 1, limit = 50) {
    return this.get(`/audit?page=${page}&limit=${limit}`);
  },
  getSettings() { return this.get('/settings'); },
  updateSetting(key, value) { return this.put(`/settings/${key}`, { value }); },
};

window.Api = Api;
