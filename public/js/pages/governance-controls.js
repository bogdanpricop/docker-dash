/* Identity, capacity, lifecycle and metrics governance — V4.6b/V4.6c */
'use strict';

const GovernanceControlsPage = {
  _container: null,
  _tab: 'capacity',
  _data: {},

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      const [catalog, projects, approvals, policies, blackouts, realms, tokens, trusts,
        governanceCatalog, subjects, lifecycleCatalog, leases, sod, reviews, freshness,
        observabilityCatalog, contention, storagePerformance, networkPerformance, observedEvents, signalState, topology,
        advancedObservability, sloReports, infrastructureAutomation, lifecycleUpdates, lifecycleMaintenance, lifecycleAssurance, finopsFoundation, finopsOptimization, finopsSustainability, hardwarePerformance, hardwareDevices, hardwareAdvanced, providerPlugins, connectorMarketplace, migrationFactory, platformFoundation, vmContentMobility, storageAdvanced, networkAdvanced] = await Promise.all([
        Api.getGovernanceControlsCatalog(), Api.listGovernanceProjects(), Api.listApprovalRequests(),
        Api.listApprovalPolicies(), Api.listBlackouts(), Api.listIdentityRealms(), Api.listServiceTokens(), Api.listWorkloadTrusts(),
        Api.getGovernanceCatalog(), Api.getGovernanceSubjects(), Api.getGovernanceLifecycleCatalog(), Api.listResourceLeases(),
        Api.getSeparationOfDutiesReport(), Api.listAccessReviewCampaigns(), Api.getVmMetricFreshness(),
        Api.getVmObservabilityCatalog(), Api.getVmPerformanceDashboard('contention'), Api.getVmPerformanceDashboard('storage'),
        Api.getVmPerformanceDashboard('network'), Api.listVmObservabilityEvents({ limit: 100 }), Api.getVmSignalRules(),
        Api.getVmObservabilityTopology(),
        Api.getVmObservabilityAdvanced(), Api.getVmSloReports(), Api.getInfrastructureAutomation(), Api.getLifecycleUpdates(),
        Api.getLifecycleMaintenance(),
        Api.getLifecycleAssurance(),
        Api.getFinOpsFoundation(),
        Api.getFinOpsOptimization(),
        Api.getFinOpsSustainability(),
        Api.getHardwarePerformance(),
        Api.getHardwareDevices(),
        Api.getHardwareAdvanced(),
        Api.getProviderPlugins(),
        Api.getConnectorMarketplace(),
        Api.getMigrationFactory(),
        Api.getPlatformFoundation(),
        Api.getVmContentMobility(),
        Api.getStorageAdvanced(),
        Api.getNetworkAdvanced(),
      ]);
      this._data = { catalog, projects: projects.projects || [], approvals: approvals.requests || [],
        policies: policies.policies || [], blackouts: blackouts.windows || [], realms: realms.realms || [],
        tokens: tokens.tokens || [], trusts: trusts.trusts || [], governanceCatalog, subjects,
        lifecycleCatalog, leases: leases.leases || [], sod: sod.findings || [], reviews: reviews.campaigns || [], freshness,
        observabilityCatalog, contention, storagePerformance, networkPerformance, observedEvents: observedEvents.events || [],
        signalState, topology, advancedObservability, sloReports: sloReports.reports || [], infrastructureAutomation,
        lifecycleUpdates, lifecycleMaintenance, lifecycleAssurance, finopsFoundation, finopsOptimization, finopsSustainability, hardwarePerformance, hardwareDevices, hardwareAdvanced, providerPlugins, connectorMarketplace, migrationFactory, platformFoundation, vmContentMobility, storageAdvanced, networkAdvanced };
      this._paint();
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><i class="fas fa-shield-halved"></i><h3>${i18n.t('nav.governance-controls')}</h3><p>${Utils.escapeHtml(error.message)}</p></div>`;
    }
  },

  _paint() {
    const pending = this._data.approvals.filter(item => item.state === 'pending').length;
    this._container.innerHTML = `<div class="control-surface"><div class="page-header"><div><h1 class="page-title"><i class="fas fa-shield-halved" style="color:var(--accent);margin-right:10px"></i>${i18n.t('nav.governance-controls')}</h1>
      <p class="page-subtitle">Capacity limits, federated identities, short-lived credentials, approvals and change freezes.</p></div>
      <button class="btn btn-secondary" id="gc-refresh"><i class="fas fa-rotate"></i> Refresh</button></div>
      <div class="info-grid">
        ${this._stat('fa-gauge-high', 'Extended metrics', this._data.catalog.capacityMetrics.length)}
        ${this._stat('fa-hourglass-half', 'Pending approvals', pending)}
        ${this._stat('fa-right-to-bracket', 'Identity realms', this._data.realms.length)}
        ${this._stat('fa-clock', 'Cleanup pending', this._data.leases.filter(item => item.state === 'cleanup_pending').length)}
      </div>
      <div class="tabs control-tabs" role="tablist" aria-label="Identity and policy sections">
        ${this._tabButton('capacity', 'fa-gauge-high', 'Capacity')}
        ${this._tabButton('approvals', 'fa-user-check', 'Approvals')}
        ${this._tabButton('identity', 'fa-id-card', 'Identity & tokens')}
        ${this._tabButton('blackouts', 'fa-ban', 'Blackouts')}
        ${this._tabButton('lifecycle', 'fa-arrows-rotate', 'Lifecycle')}
        ${this._tabButton('metrics', 'fa-chart-line', 'VM metrics')}
        ${this._tabButton('observability', 'fa-wave-square', 'Observability')}
        ${this._tabButton('automation', 'fa-code-branch', 'Automation & IaC')}
        ${this._tabButton('updates', 'fa-arrow-up-from-bracket', 'Lifecycle & updates')}
        ${this._tabButton('finops', 'fa-coins', 'FinOps')}
        ${this._tabButton('hardware', 'fa-microchip', 'Hardware & performance')}
        ${this._tabButton('plugins', 'fa-puzzle-piece', 'Provider plugins')}
        ${this._tabButton('connectors', 'fa-plug-circle-bolt', 'Connector marketplace')}
        ${this._tabButton('migration-factory', 'fa-truck-fast', 'Migration factory')}
        ${this._tabButton('platform-foundation', 'fa-cubes-stacked', 'Platform foundation')}
        ${this._tabButton('vm-content-mobility', 'fa-arrows-left-right-to-line', 'Content & mobility')}
        ${this._tabButton('storage-advanced', 'fa-hard-drive', 'Storage advanced')}
        ${this._tabButton('network-advanced', 'fa-network-wired', 'Network advanced')}
      </div><div id="gc-content" role="tabpanel" tabindex="0">${this._content()}</div></div>`;
    this._bind();
  },
  _stat(icon, label, value) { return `<div class="info-item"><div class="info-label"><i class="fas ${icon}" style="margin-right:5px"></i>${label}</div><div class="info-value">${value}</div></div>`; },
  _tabButton(tab, icon, label) { const active = this._tab === tab; return `<button type="button" class="tab ${active ? 'active' : ''}" data-gc-tab="${tab}" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</button>`; },
  _content() {
    if (this._tab === 'approvals') return this._approvals();
    if (this._tab === 'identity') return this._identity();
    if (this._tab === 'blackouts') return this._blackouts();
    if (this._tab === 'lifecycle') return this._lifecycle();
    if (this._tab === 'metrics') return this._metrics();
    if (this._tab === 'observability') return this._observability();
    if (this._tab === 'automation') return this._automation();
    if (this._tab === 'updates') return this._updates();
    if (this._tab === 'finops') return this._finops();
    if (this._tab === 'hardware') return this._hardware();
    if (this._tab === 'plugins') return this._plugins();
    if (this._tab === 'connectors') return this._connectors();
    if (this._tab === 'migration-factory') return this._migrationFactory();
    if (this._tab === 'platform-foundation') return this._platformFoundation();
    if (this._tab === 'vm-content-mobility') return this._vmContentMobility();
    if (this._tab === 'storage-advanced') return this._storageAdvanced();
    if (this._tab === 'network-advanced') return this._networkAdvanced();
    return this._capacity();
  },
  _actions(buttons) { return `<div style="display:flex;justify-content:flex-end;gap:7px;margin-bottom:12px;flex-wrap:wrap">${buttons}</div>`; },
  _empty(text, colspan = 5) { return `<tr><td colspan="${colspan}" class="text-muted">${text}</td></tr>`; },

  _capacity() {
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-quota-request"><i class="fas fa-arrow-up"></i> Request quota</button>
      <button class="btn btn-primary btn-sm" id="gc-capacity-open"><i class="fas fa-sliders"></i> View / account capacity</button>`)}
      <div class="card"><div class="card-header"><div><h3>Project capacity accounting</h3><p class="text-muted text-sm">Network/public IP, snapshot/backup and GPU/device quotas are explicit control-plane accounting; providers are never mutated automatically.</p></div></div>
      <div style="padding:15px;display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px">
        ${this._metricGroup('Network', ['nic_count','network_count','public_ip_count','security_group_count'])}
        ${this._metricGroup('Protection', ['snapshot_count','snapshot_bytes','backup_count','backup_bytes'])}
        ${this._metricGroup('Accelerators', ['gpu_count','device_count','accelerator_seconds'])}
      </div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><table class="data-table"><thead><tr><th>Project</th><th>Mode</th><th>Owner</th><th>Members</th></tr></thead><tbody>
      ${this._data.projects.map(project => `<tr><td><strong>${Utils.escapeHtml(project.name)}</strong><div class="text-xs text-muted mono">${Utils.escapeHtml(project.slug)}</div></td><td>${Utils.escapeHtml(project.usageMode)}</td><td>${Utils.escapeHtml(project.owner?.username || '—')}</td><td>${project.memberCount}</td></tr>`).join('') || this._empty('No projects', 4)}</tbody></table></div>`;
  },
  _metricGroup(title, metrics) { return `<div><strong>${title}</strong><div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">${metrics.map(metric => `<span class="badge badge-secondary mono">${metric}</span>`).join('')}</div></div>`; },

  _approvals() {
    return `${this._actions(`<button class="btn btn-primary btn-sm" id="gc-new-policy"><i class="fas fa-plus"></i> Approval policy</button>`)}
      <div class="card" style="overflow:auto"><div class="card-header"><h3>Approval queue</h3></div><table class="data-table"><thead><tr><th>Action</th><th>Requester</th><th>Risk / environment</th><th>Progress</th><th>State</th><th></th></tr></thead><tbody>
      ${this._data.approvals.map(item => `<tr><td><strong class="mono text-sm">${Utils.escapeHtml(item.action_key)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.reason)}</div></td>
        <td>${Utils.escapeHtml(item.requester_username)}</td><td>${item.risk} / ${Utils.escapeHtml(item.environment)}</td><td>${item.approvals}/${item.approvals_required}</td>
        <td><span class="badge ${item.state === 'approved' ? 'badge-success' : item.state === 'pending' ? 'badge-warning' : 'badge-secondary'}">${Utils.escapeHtml(item.state)}</span></td>
        <td>${item.state === 'pending' ? `<button class="action-btn success" data-gc-approve="${item.id}" title="Approve"><i class="fas fa-check"></i></button><button class="action-btn danger" data-gc-reject="${item.id}" title="Reject"><i class="fas fa-times"></i></button>` : ''}</td></tr>`).join('') || this._empty('No approval requests', 6)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Policies</h3></div><table class="data-table"><thead><tr><th>Name</th><th>Action pattern</th><th>Environment</th><th>Risk</th><th>Approvers</th><th></th></tr></thead><tbody>
      ${this._data.policies.map(item => `<tr><td>${Utils.escapeHtml(item.name)}</td><td class="mono text-sm">${Utils.escapeHtml(item.action_pattern)}</td><td>${item.environment}</td><td>${item.minimum_risk}+</td><td>${item.approvals_required}${item.requester_cannot_approve ? ' · SoD' : ''}</td><td><button class="action-btn danger" data-gc-delete-policy="${item.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('') || this._empty('No policies', 6)}</tbody></table></div>`;
  },

  _identity() {
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-new-realm"><i class="fas fa-plus"></i> Federation realm</button><button class="btn btn-secondary btn-sm" id="gc-new-trust"><i class="fas fa-plus"></i> Workload trust</button><button class="btn btn-primary btn-sm" id="gc-new-token"><i class="fas fa-key"></i> Service token</button>`)}
      <div class="card" style="overflow:auto"><div class="card-header"><div><h3>Federation realms</h3><p class="text-muted text-sm">Domain routing hands login to native OIDC or a trusted OIDC/SAML broker.</p></div></div><table class="data-table"><thead><tr><th>Realm</th><th>Protocol</th><th>Domains</th><th>Login</th><th></th></tr></thead><tbody>
      ${this._data.realms.map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.slug)}</div></td><td>${item.protocol}</td><td>${item.domains.map(Utils.escapeHtml).join(', ')}</td><td class="mono text-xs">${Utils.escapeHtml(item.login_url)}</td><td><button class="action-btn danger" data-gc-delete-realm="${item.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('') || this._empty('No identity realms', 5)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Short-lived service tokens</h3><p class="text-muted text-sm">The secret is stored only as SHA-256 and displayed once.</p></div></div><table class="data-table"><thead><tr><th>Name / principal</th><th>Prefix</th><th>Scopes</th><th>Expires</th><th></th></tr></thead><tbody>
      ${this._data.tokens.map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.principal)}</div></td><td class="mono">${Utils.escapeHtml(item.token_prefix)}…</td><td>${item.scopes.map(scope => `<span class="badge badge-secondary mono">${scope}</span>`).join(' ')}</td><td>${new Date(item.expires_at).toLocaleString()}</td><td>${item.revoked_at ? '<span class="badge badge-secondary">revoked</span>' : `<button class="action-btn" data-gc-rotate-token="${item.id}" title="Rotate"><i class="fas fa-rotate"></i></button><button class="action-btn danger" data-gc-revoke-token="${item.id}" title="Revoke"><i class="fas fa-trash"></i></button>`}</td></tr>`).join('') || this._empty('No service tokens', 5)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Workload identity trusts</h3><p class="text-muted text-sm">Signed OIDC, SPIFFE and cloud JWT assertions exchange once for a token of at most one hour.</p></div></div><table class="data-table"><thead><tr><th>Name</th><th>Kind</th><th>Issuer / audience</th><th>Subject</th><th>TTL</th><th></th></tr></thead><tbody>
      ${this._data.trusts.map(item => `<tr><td>${Utils.escapeHtml(item.name)}</td><td>${item.identity_kind}</td><td class="text-xs"><span class="mono">${Utils.escapeHtml(item.issuer)}</span><br>${Utils.escapeHtml(item.audience)}</td><td class="mono text-xs">${Utils.escapeHtml(item.subject_pattern)}</td><td>${item.token_ttl_seconds}s</td><td><button class="action-btn danger" data-gc-delete-trust="${item.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('') || this._empty('No workload trusts', 6)}</tbody></table></div>
      <div class="card" style="margin-top:12px;padding:15px"><strong>SCIM 2.0 endpoint</strong><div class="mono text-sm" style="margin-top:6px">${location.origin}/api/scim/v2</div><p class="text-muted text-sm">Issue a service token with scim.read and scim.write and configure it as an OAuth Bearer token in the identity provider.</p></div>`;
  },

  _blackouts() {
    return `${this._actions(`<button class="btn btn-primary btn-sm" id="gc-new-blackout"><i class="fas fa-plus"></i> Blackout window</button>`)}
      <div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Name</th><th>Action</th><th>Environment</th><th>Interval</th><th>Emergency</th><th></th></tr></thead><tbody>
      ${this._data.blackouts.map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.reason)}</div></td><td class="mono text-sm">${Utils.escapeHtml(item.action_pattern)}</td><td>${item.environment}</td><td>${new Date(item.starts_at).toLocaleString()}<br>${new Date(item.ends_at).toLocaleString()}</td><td>${item.allow_emergency_override ? 'ticket + reason' : 'blocked'}</td><td><button class="action-btn danger" data-gc-delete-blackout="${item.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('') || this._empty('No blackout windows', 6)}</tbody></table></div>`;
  },

  _lifecycle() {
    const badge = state => state === 'active' || state === 'complete' || state === 'completed' ? 'badge-success'
      : state === 'cleanup_pending' || state === 'pending' ? 'badge-warning' : 'badge-secondary';
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-lease-policy"><i class="fas fa-clock"></i> Lease policy</button>
      <button class="btn btn-secondary btn-sm" id="gc-new-lease"><i class="fas fa-hourglass-start"></i> New lease</button>
      <button class="btn btn-secondary btn-sm" id="gc-ownership"><i class="fas fa-user-tag"></i> Ownership</button>
      <button class="btn btn-secondary btn-sm" id="gc-sod-rule"><i class="fas fa-scale-balanced"></i> SoD rule</button>
      <button class="btn btn-secondary btn-sm" id="gc-review"><i class="fas fa-clipboard-check"></i> Access review</button>
      <button class="btn btn-primary btn-sm" id="gc-offboard"><i class="fas fa-file-export"></i> Export / offboard</button>`) }
      <div class="card" style="overflow:auto"><div class="card-header"><div><h3>Resource leases</h3><p class="text-muted text-sm">Expiry only flags cleanup; provider deletion always remains an explicit operator action.</p></div></div>
      <table class="data-table"><thead><tr><th>Resource</th><th>Holder / cleanup owner</th><th>Expires</th><th>Renewals</th><th>State</th><th></th></tr></thead><tbody>
      ${this._data.leases.map(item => `<tr><td><strong>${Utils.escapeHtml(item.display_name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.resource_type)} · ${Utils.escapeHtml(item.resource_key)}</div></td>
        <td>${Utils.escapeHtml(item.holder_username)}<div class="text-xs text-muted">cleanup: ${Utils.escapeHtml(item.cleanup_owner_username)}</div></td><td>${new Date(item.expires_at).toLocaleString()}</td><td>${item.renewal_count}</td>
        <td><span class="badge ${badge(item.state)}">${item.state}</span></td><td>${item.state === 'active' ? `<button class="action-btn" data-gc-renew-lease="${item.id}" title="Renew"><i class="fas fa-rotate"></i></button>` : ''}${['active','cleanup_pending'].includes(item.state) ? `<button class="action-btn success" data-gc-clean-lease="${item.id}" title="Attest cleanup"><i class="fas fa-check"></i></button>` : ''}</td></tr>`).join('') || this._empty('No resource leases', 6)}</tbody></table></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Separation of duties</h3></div><table class="data-table"><thead><tr><th>Rule</th><th>Principal</th><th>Roles</th><th>Severity</th></tr></thead><tbody>
        ${this._data.sod.map(item => `<tr><td>${Utils.escapeHtml(item.ruleName || item.name)}</td><td>${Utils.escapeHtml(item.username || String(item.user_id))}</td><td class="mono text-xs">${Utils.escapeHtml(item.left_role)} + ${Utils.escapeHtml(item.right_role)}</td><td><span class="badge badge-warning">${item.severity}</span></td></tr>`).join('') || this._empty('No conflicting effective roles', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Access review campaigns</h3></div><table class="data-table"><thead><tr><th>Campaign</th><th>Due</th><th>Progress</th><th>State</th><th></th></tr></thead><tbody>
        ${this._data.reviews.map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">${item.review_kind}</div></td><td>${new Date(item.due_at).toLocaleDateString()}</td><td>${Number(item.item_count || 0) - Number(item.pending_count || 0)}/${Number(item.item_count || 0)}</td><td><span class="badge ${badge(item.state)}">${item.state}</span></td><td><button class="action-btn" data-gc-open-review="${item.id}" title="Review"><i class="fas fa-eye"></i></button></td></tr>`).join('') || this._empty('No access review campaigns', 5)}</tbody></table></div>
      </div>`;
  },

  _metrics() {
    const resources = this._data.freshness.resources || [];
    const statusBadge = status => status === 'fresh' ? 'badge-success' : status === 'error' ? 'badge-danger' : 'badge-warning';
    return `${this._actions(`<button class="btn btn-primary btn-sm" id="gc-metrics-policy"><i class="fas fa-sliders"></i> Polling & cardinality policy</button>`) }
      <div class="card"><div class="card-header"><div><h3>Provider metric adapters</h3><p class="text-muted text-sm">Every accepted sample uses canonical fields, units and provenance. Unsupported counters stay absent instead of becoming zero.</p></div></div>
      <div style="padding:15px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">${this._data.lifecycleCatalog.adapters.map(adapter => `<div class="info-item"><div class="info-label">${Utils.escapeHtml(adapter.provider)}</div><div class="info-value text-sm">${Utils.escapeHtml(adapter.key)}</div><div class="text-xs text-muted">${Utils.escapeHtml(adapter.transport)}<br>${Utils.escapeHtml(adapter.coverage)}</div></div>`).join('')}</div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Freshness by VM resource</h3><p class="text-muted text-sm">Last sample lag, adapter errors and collection coverage are tracked independently per resource.</p></div></div>
      <table class="data-table"><thead><tr><th>Resource</th><th>Provider / adapter</th><th>Last sample</th><th>Lag</th><th>Samples accepted / dropped</th><th>Status</th></tr></thead><tbody>
      ${resources.map(item => `<tr><td class="mono text-sm">${Utils.escapeHtml(item.resource_key)}</td><td>${Utils.escapeHtml(item.provider)}<div class="mono text-xs">${Utils.escapeHtml(item.adapter)}</div></td><td>${item.last_sample_at ? new Date(item.last_sample_at).toLocaleString() : 'never'}${item.last_error ? `<div class="text-xs text-danger">${Utils.escapeHtml(item.last_error)}</div>` : ''}</td><td>${item.lagSeconds == null ? '—' : `${item.lagSeconds}s`}</td><td>${item.accepted_samples} / ${item.dropped_samples}</td><td><span class="badge ${statusBadge(item.status)}">${item.status}</span></td></tr>`).join('') || this._empty('No VM metrics have been ingested yet', 6)}</tbody></table></div>`;
  },

  _observability() {
    const contention = this._data.contention.rows || [];
    const storage = this._data.storagePerformance.rows || [];
    const network = this._data.networkPerformance.rows || [];
    const advanced = this._data.advancedObservability || {};
    const badge = status => status === 'normal' ? 'badge-success' : status === 'contended' || status === 'degraded' ? 'badge-warning' : 'badge-secondary';
    const ratio = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
    const rate = value => value == null ? '—' : `${Utils.formatBytes(value)}/s`;
    const signals = row => (row.signals || []).map(item => `<span class="badge badge-warning">${Utils.escapeHtml(item)}</span>`).join(' ') || '<span class="text-muted">none</span>';
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-performance-chart"><i class="fas fa-chart-line"></i> Performance chart</button>
      <button class="btn btn-secondary btn-sm" id="gc-event-ingest"><i class="fas fa-inbox"></i> Ingest event</button>
      <button class="btn btn-secondary btn-sm" id="gc-timeline"><i class="fas fa-timeline"></i> Correlation timeline</button>
      <button class="btn btn-secondary btn-sm" id="gc-topology-edge"><i class="fas fa-diagram-project"></i> Topology edge</button>
      <button class="btn btn-secondary btn-sm" id="gc-signal-rule"><i class="fas fa-bell"></i> Multi-signal rule</button>
      <button class="btn btn-secondary btn-sm" id="gc-baseline"><i class="fas fa-wave-square"></i> Dynamic baseline</button>
      <button class="btn btn-secondary btn-sm" id="gc-maintenance"><i class="fas fa-screwdriver-wrench"></i> Maintenance</button>
      <button class="btn btn-secondary btn-sm" id="gc-capacity-forecast"><i class="fas fa-chart-simple"></i> Capacity forecast</button>
      <button class="btn btn-secondary btn-sm" id="gc-runbook"><i class="fas fa-book"></i> Runbook</button>
      <button class="btn btn-secondary btn-sm" id="gc-observability-export"><i class="fas fa-share-nodes"></i> Export</button>
      <button class="btn btn-secondary btn-sm" id="gc-slo"><i class="fas fa-bullseye"></i> SLO</button>
      <button class="btn btn-secondary btn-sm" id="gc-privacy"><i class="fas fa-user-shield"></i> Privacy</button>
      <button class="btn btn-primary btn-sm" id="gc-evaluate-signals"><i class="fas fa-play"></i> Evaluate & suppress</button>`) }
      <div class="card"><div class="card-header"><div><h3>Unified event adapters and correlation</h3><p class="text-muted text-sm">Cursor/watch/webhook/poll observations are normalized locally, deduplicated and retained as evidence. No provider mutation is performed.</p></div></div>
      <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${this._data.observabilityCatalog.eventAdapters.map(item => `<span class="badge badge-secondary" title="${Utils.escapeHtml(item.transport)}">${Utils.escapeHtml(item.key)} · ${Utils.escapeHtml(item.cursorKind)}</span>`).join('')}</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Host contention</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>CPU / ready / steal</th><th>Signals</th><th>Neighbor</th></tr></thead><tbody>
        ${contention.map(row => `<tr><td class="mono">${Utils.escapeHtml(row.resourceKey)}<br><span class="badge ${badge(row.status)}">${row.status}</span></td><td>${ratio(row.cpuUtilizationRatio)} / ${ratio(row.cpuReadyRatio)} / ${ratio(row.cpuStealRatio)}</td><td>${signals(row)}</td><td class="mono text-xs">${Utils.escapeHtml(row.noisyNeighbor?.resourceKey || '—')}</td></tr>`).join('') || this._empty('No contention metrics', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Storage performance</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Read / write</th><th>Latency / queue</th><th>Signals</th></tr></thead><tbody>
        ${storage.map(row => `<tr><td class="mono">${Utils.escapeHtml(row.resourceKey)}<br><span class="badge ${badge(row.status)}">${row.status}</span></td><td>${rate(row.readBytesPerSecond)} / ${rate(row.writeBytesPerSecond)}<div class="text-xs text-muted">${row.readIops == null ? '—' : row.readIops.toFixed(1)} / ${row.writeIops == null ? '—' : row.writeIops.toFixed(1)} IOPS</div></td><td>${row.readLatencySeconds == null ? '—' : `${(row.readLatencySeconds * 1000).toFixed(1)} ms`} / ${row.queueDepth ?? '—'}</td><td>${signals(row)}</td></tr>`).join('') || this._empty('No storage metrics', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Network performance</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Receive / transmit</th><th>Drops / errors</th><th>Signals</th></tr></thead><tbody>
        ${network.map(row => `<tr><td class="mono">${Utils.escapeHtml(row.resourceKey)}<br><span class="badge ${badge(row.status)}">${row.status}</span></td><td>${rate(row.receiveBytesPerSecond)} / ${rate(row.transmitBytesPerSecond)}<div class="text-xs text-muted">flows: ${row.activeFlows ?? '—'}</div></td><td>${row.receiveDropsPerSecond == null ? '—' : row.receiveDropsPerSecond.toFixed(2)} / ${row.receiveErrorsPerSecond == null ? '—' : row.receiveErrorsPerSecond.toFixed(2)}</td><td>${signals(row)}</td></tr>`).join('') || this._empty('No network metrics', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Topology and multi-signal state</h3></div><div style="padding:15px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${this._stat('fa-circle-nodes', 'Nodes', this._data.topology.nodes.length)}${this._stat('fa-link', 'Edges', this._data.topology.edges.length)}${this._stat('fa-bell', 'Active alerts', (this._data.signalState.alerts || []).filter(item => item.state === 'active').length)}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><div><h3>Dynamic baseline</h3><p class="text-muted text-sm">Seasonal percentiles produce explainable, evidence-counted assessments.</p></div><button class="btn btn-sm btn-secondary" id="gc-evaluate-baselines">Evaluate</button></div><table class="data-table"><thead><tr><th>Policy</th><th>Metric</th><th>Seasonality</th><th>Latest</th></tr></thead><tbody>
        ${(advanced.baselinePolicies || []).map(policy => { const latest = (advanced.baselineAssessments || []).find(item => item.policy_id === policy.id); return `<tr><td>${Utils.escapeHtml(policy.name)}</td><td class="mono text-xs">${Utils.escapeHtml(policy.metric_key)}</td><td>${policy.seasonality}</td><td><span class="badge ${latest?.status === 'above_baseline' ? 'badge-warning' : 'badge-secondary'}">${latest?.status || 'not evaluated'}</span></td></tr>`; }).join('') || this._empty('No baseline policies', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto" data-section="Dependency & maintenance suppression"><div class="card-header"><div><h3>Dependency &amp; maintenance suppression</h3><p class="text-muted text-sm">Active alerts remain visible while duplicate downstream notifications are suppressed with evidence.</p></div><button class="btn btn-sm btn-secondary" id="gc-reconcile-suppressions">Reconcile</button></div><table class="data-table"><thead><tr><th>Kind</th><th>Resource</th><th>Reason</th></tr></thead><tbody>
        ${(advanced.suppressions || []).filter(item => item.active).map(item => `<tr><td><span class="badge badge-warning">${item.suppression_kind}</span></td><td class="mono text-xs">${Utils.escapeHtml(item.resource_type)}:${Utils.escapeHtml(item.resource_key)}</td><td>${Utils.escapeHtml(item.reason)}</td></tr>`).join('') || this._empty('No active suppressions', 3)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Capacity forecast</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Metric</th><th>Projected full</th><th>Confidence</th></tr></thead><tbody>
        ${(advanced.capacityForecasts || []).slice(0, 10).map(item => `<tr><td class="mono text-xs">${Utils.escapeHtml(item.resource_key)}</td><td class="mono text-xs">${Utils.escapeHtml(item.metric_key)}</td><td>${item.projected_full_at ? new Date(item.projected_full_at).toLocaleString() : 'not projected'}</td><td>${(Number(item.confidence) * 100).toFixed(0)}%</td></tr>`).join('') || this._empty('No capacity forecasts', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Triage assistant &amp; root-cause candidates</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Summary</th><th>Runbooks</th></tr></thead><tbody>
        ${(advanced.triageReports || []).slice(0, 10).map(item => `<tr><td class="mono text-xs">${Utils.escapeHtml(item.resource_type)}:${Utils.escapeHtml(item.resource_key)}</td><td>${Utils.escapeHtml(item.summary)}</td><td>${item.runbooks.map(runbook => `<a href="${Utils.escapeHtml(runbook.url)}" target="_blank" rel="noopener">${Utils.escapeHtml(runbook.title)}</a>`).join('<br>') || '—'}</td></tr>`).join('') || this._empty('Use the flask button on an event to create advisory triage', 3)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Runbook links</h3></div><table class="data-table"><thead><tr><th>Pattern</th><th>Minimum</th><th>Version</th><th>Link</th></tr></thead><tbody>
        ${(advanced.runbooks || []).map(item => `<tr><td class="mono text-xs">${Utils.escapeHtml(item.event_pattern)}</td><td>${item.minimum_severity}</td><td>${Utils.escapeHtml(item.version)}</td><td><a href="${Utils.escapeHtml(item.url)}" target="_blank" rel="noopener">${Utils.escapeHtml(item.title)}</a></td></tr>`).join('') || this._empty('No runbook mappings', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Observability export</h3></div><table class="data-table"><thead><tr><th>Target</th><th>Kind / region</th><th>Last delivery</th><th></th></tr></thead><tbody>
        ${(advanced.exportTargets || []).map(item => { const delivery = (advanced.exportDeliveries || []).find(row => row.target_id === item.id); return `<tr><td>${Utils.escapeHtml(item.name)}</td><td>${item.export_kind} / ${Utils.escapeHtml(item.region)}</td><td>${delivery?.status || 'never'}</td><td><button class="action-btn" data-gc-export-preview="${item.id}" title="Preview"><i class="fas fa-eye"></i></button><button class="action-btn success" data-gc-export-deliver="${item.id}" title="Deliver explicitly"><i class="fas fa-paper-plane"></i></button></td></tr>`; }).join('') || this._empty('No export targets', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>SLO availability</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Target</th><th>Availability</th><th>Status</th></tr></thead><tbody>
        ${(this._data.sloReports || []).map(item => `<tr><td class="mono text-xs">${Utils.escapeHtml(item.resourceKey)}</td><td>${item.targetRatio == null ? '—' : `${(item.targetRatio * 100).toFixed(3)}%`}</td><td>${item.availabilityRatio == null ? '—' : `${(item.availabilityRatio * 100).toFixed(3)}%`}</td><td><span class="badge ${item.status === 'met' ? 'badge-success' : item.status === 'breached' ? 'badge-danger' : 'badge-secondary'}">${item.status}</span></td></tr>`).join('') || this._empty('No SLO policies or availability evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Telemetry privacy</h3></div><table class="data-table"><thead><tr><th>Host</th><th>Sampling</th><th>Retention metric/event</th><th>Residency</th><th></th></tr></thead><tbody>
        ${(advanced.privacyPolicies || []).map(item => `<tr><td>${item.provider_host_id === 0 ? 'default' : item.provider_host_id}</td><td>${(item.sampling_ratio * 100).toFixed(0)}%</td><td>${item.metric_retention_days}d / ${item.event_retention_days}d</td><td>${Utils.escapeHtml(item.residency_region)}</td><td><button class="action-btn danger" data-gc-retention="${item.provider_host_id}" title="Preview retention purge"><i class="fas fa-eraser"></i></button></td></tr>`).join('') || this._empty('No telemetry privacy policies', 5)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Normalized event timeline</h3></div><table class="data-table"><thead><tr><th>Time</th><th>Event</th><th>Resource</th><th>Severity</th><th>Repeats</th><th></th></tr></thead><tbody>
      ${this._data.observedEvents.map(event => `<tr><td>${new Date(event.occurred_at).toLocaleString()}</td><td><strong>${Utils.escapeHtml(event.title)}</strong><div class="mono text-xs">${Utils.escapeHtml(event.event_type)} · ${Utils.escapeHtml(event.adapter)}</div></td><td class="mono text-xs">${Utils.escapeHtml(event.resource_type)}:${Utils.escapeHtml(event.resource_key)}</td><td><span class="badge ${event.severity === 'critical' || event.severity === 'high' ? 'badge-danger' : event.severity === 'warning' ? 'badge-warning' : 'badge-secondary'}">${event.severity}</span></td><td>${event.repeat_count}</td><td><button class="action-btn" data-gc-impact="${event.id}" title="Topology impact"><i class="fas fa-diagram-project"></i></button><button class="action-btn" data-gc-triage-event="${event.id}" title="Triage assistant"><i class="fas fa-flask"></i></button></td></tr>`).join('') || this._empty('No normalized events', 6)}</tbody></table></div>`;
  },

  _automation() {
    const data = this._data.infrastructureAutomation || {};
    const delivery = data.delivery || { capabilities: {}, resourceManifests: [], controllers: [], reconcileRuns: [], externalPlans: [], webhookTriggers: [] };
    const operations = data.operations || { capabilities: {}, schedules: [], scheduleRuns: [], approvals: [], dryRuns: [], secretBrokers: [], secretAccessEvents: [], workflowTemplates: [] };
    const engine = data.operationEngine || { states: {}, activeLocks: 0, idempotencyProtectedJobs: 0, nativeTaskJobs: 0 };
    const capabilities = [
      ['Durable jobs', 'persistentJobEngine'], ['Provider task bridge', 'providerTaskBridge'],
      ['Idempotency keys', 'idempotencyKeys'], ['Resource locks', 'resourceLocks'],
      ['Operation DAG', 'dependencyDag'], ['Compensation framework', 'compensationFramework'],
      ['Infrastructure change plans', 'changePlans'], ['Stale-plan rejection', 'stalePlanRejection'],
      ['VM manifest', 'vmManifest'], ['Host / fabric manifest', 'hostFabricManifest'],
    ];
    const deliveryCapabilities = [
      ['Storage / network manifest', 'storageNetworkManifest'], ['Live resource import', 'liveImport'],
      ['Declarative drift detection', 'declarativeDrift'], ['Manual GitOps reconcile', 'manualGitOpsReconcile'],
      ['Continuous GitOps reconcile', 'continuousGitOpsReconcile'], ['Pull-request preview', 'pullRequestPreview'],
      ['Terraform import helper', 'terraformImport'], ['Terraform run integration', 'terraformRunIntegration'],
      ['Ansible inventory export', 'ansibleInventory'], ['Webhook-triggered runbooks', 'webhookRunbooks'],
    ];
    return `${this._actions(`<button class="btn btn-secondary btn-sm" data-gc-manifest="VirtualMachine"><i class="fas fa-desktop"></i> VM manifest</button>
      <button class="btn btn-secondary btn-sm" data-gc-manifest="Host"><i class="fas fa-server"></i> Host manifest</button>
      <button class="btn btn-secondary btn-sm" data-gc-manifest="Fabric"><i class="fas fa-network-wired"></i> Fabric manifest</button>
      <button class="btn btn-secondary btn-sm" id="gc-infra-plan"><i class="fas fa-list-check"></i> Change plan</button>
      <button class="btn btn-primary btn-sm" id="gc-infra-workflow"><i class="fas fa-diagram-project"></i> Workflow DAG</button>`) }
      <div class="card"><div class="card-header"><div><h3>Automation capability map</h3><p class="text-muted text-sm">The manifest layer reuses the encrypted durable provider-operation engine; accepting a plan records reviewed intent and never schedules an arbitrary handler.</p></div></div>
      <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${capabilities.map(([label, key]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}</div></div>
      <div class="info-grid" style="margin-top:12px">
        ${this._stat('fa-gears', 'Queued / running jobs', Number(engine.states.queued || 0) + Number(engine.states.running || 0))}
        ${this._stat('fa-fingerprint', 'Idempotency-protected', engine.idempotencyProtectedJobs)}
        ${this._stat('fa-link', 'Native task bridges', engine.nativeTaskJobs)}
        ${this._stat('fa-lock', 'Active resource locks', engine.activeLocks)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Desired-state manifests</h3></div><table class="data-table"><thead><tr><th>Kind / name</th><th>Target</th><th>Revision</th><th>Ownership</th></tr></thead><tbody>
        ${(data.manifests || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.kind)}</div></td><td>${item.providerHostId || 'global'}<div class="mono text-xs">${Utils.escapeHtml(item.resourceId || 'create intent')}</div></td><td>${item.revision}<div class="mono text-xs">${item.documentHash.slice(0, 12)}</div></td><td>${item.authoritative ? '<span class="badge badge-warning">authoritative</span>' : '<span class="badge badge-secondary">bounded</span>'}</td></tr>`).join('') || this._empty('No infrastructure manifests', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Infrastructure change plans</h3></div><table class="data-table"><thead><tr><th>Plan</th><th>Changes</th><th>State / expiry</th><th></th></tr></thead><tbody>
        ${(data.plans || []).map(item => `<tr><td class="mono text-xs">#${item.id}<br>${item.planHash.slice(0, 12)}</td><td>+${item.summary.create} ~${item.summary.update} -${item.summary.delete}<div class="text-xs text-muted">${item.summary.blocked} blocked · ${item.summary.unchanged} unchanged</div></td><td><span class="badge ${item.status === 'accepted' ? 'badge-success' : item.status === 'stale' ? 'badge-danger' : 'badge-secondary'}">${item.status}</span><div class="text-xs text-muted">${new Date(item.expiresAt).toLocaleString()}</div></td><td>${item.status === 'planned' ? `<button class="action-btn" data-gc-revalidate-plan="${item.id}" title="Revalidate and accept"><i class="fas fa-shield-check"></i></button>` : ''}${item.status === 'accepted' ? `<button class="action-btn" data-gc-link-job="${item.id}" title="Link allowlisted durable operation"><i class="fas fa-link"></i></button>` : ''}</td></tr>`).join('') || this._empty('No change plans', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Workflow DAG &amp; compensation</h3></div><table class="data-table"><thead><tr><th>Workflow</th><th>Steps / stages</th><th>Hash</th><th></th></tr></thead><tbody>
        ${(data.workflows || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">v${Utils.escapeHtml(item.version)}</div></td><td>${item.steps.length} / ${new Set(item.steps.map(step => step.stage)).size}<div class="text-xs text-muted">${item.steps.filter(step => step.compensation).length} compensations</div></td><td class="mono text-xs">${item.definitionHash.slice(0, 12)}</td><td><button class="action-btn" data-gc-compensation="${item.id}" title="Preview reverse compensation"><i class="fas fa-rotate-left"></i></button></td></tr>`).join('') || this._empty('No workflow DAGs', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Plan → durable job evidence</h3></div><table class="data-table"><thead><tr><th>Plan / operation</th><th>Relation</th><th>State</th><th>Safety</th></tr></thead><tbody>
        ${(data.jobLinks || []).map(item => `<tr><td class="mono text-xs">#${item.planId}<br>${Utils.escapeHtml(item.operationId)}</td><td>${item.relation}${item.stepId ? ` · ${Utils.escapeHtml(item.stepId)}` : ''}</td><td>${item.state}${item.hasNativeTask ? `<div class="text-xs text-muted">native: ${Utils.escapeHtml(item.nativeTaskState || 'linked')}</div>` : ''}</td><td>${item.idempotencyProtected ? 'idempotent' : 'no key'} · ${item.lockScopes.length} locks</td></tr>`).join('') || this._empty('No accepted plans linked to durable jobs', 4)}</tbody></table></div>
      </div>
      ${this._actions(`<button class="btn btn-secondary btn-sm" data-gc-resource-manifest="StorageResource"><i class="fas fa-hard-drive"></i> Storage manifest</button>
        <button class="btn btn-secondary btn-sm" data-gc-resource-manifest="NetworkResource"><i class="fas fa-diagram-project"></i> Network manifest</button>
        <button class="btn btn-secondary btn-sm" id="gc-infra-import"><i class="fas fa-file-import"></i> Import live</button>
        <button class="btn btn-secondary btn-sm" id="gc-infra-reconcile"><i class="fas fa-code-compare"></i> Drift &amp; reconcile</button>
        <button class="btn btn-secondary btn-sm" id="gc-infra-controller"><i class="fas fa-arrows-rotate"></i> Controller</button>
        <button class="btn btn-secondary btn-sm" id="gc-infra-pr"><i class="fas fa-code-pull-request"></i> PR preview</button>
        <button class="btn btn-secondary btn-sm" id="gc-infra-terraform"><i class="fas fa-cubes"></i> Terraform plan</button>
        <button class="btn btn-secondary btn-sm" id="gc-infra-ansible"><i class="fas fa-download"></i> Ansible inventory</button>
        <button class="btn btn-primary btn-sm" id="gc-infra-webhook"><i class="fas fa-bolt"></i> Signed runbook hook</button>`) }
      <div class="card"><div class="card-header"><div><h3>Delivery &amp; GitOps safety map</h3><p class="text-muted text-sm">Continuous mode evaluates stored observations and pauses on conflict. Terraform authorization and PR preview never launch an external process or merge.</p></div></div>
      <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${deliveryCapabilities.map(([label, key]) => `<span class="badge ${delivery.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Owned storage / network intent</h3></div><table class="data-table"><thead><tr><th>Kind / name</th><th>Owner</th><th>Revision</th><th>Deletion</th></tr></thead><tbody>
        ${(delivery.resourceManifests || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.kind)}</div></td><td>${Utils.escapeHtml(item.owner)}<div class="text-xs text-muted">${item.ownershipMode}</div></td><td>${item.revision}<div class="mono text-xs">${item.documentHash.slice(0, 12)}</div></td><td>${item.deletionProtection ? '<span class="badge badge-success">protected</span>' : '<span class="badge badge-warning">explicit delete</span>'}</td></tr>`).join('') || this._empty('No storage or network manifests', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Reconcile controllers</h3></div><table class="data-table"><thead><tr><th>Controller / scope</th><th>Mode</th><th>State</th><th></th></tr></thead><tbody>
        ${(delivery.controllers || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.scopeType)}:${Utils.escapeHtml(item.scopeKey)}</div></td><td>${item.mode}<div class="text-xs text-muted">${item.intervalSeconds}s · ${item.enabled ? 'enabled' : 'disabled'}</div></td><td><span class="badge ${item.state === 'in_sync' ? 'badge-success' : ['paused','conflict','error'].includes(item.state) ? 'badge-danger' : 'badge-warning'}">${item.state}</span><div class="text-xs text-muted">${Utils.escapeHtml(item.pauseReason || '')}</div></td><td><button class="action-btn" data-gc-controller-run="${item.id}" title="Evaluate now"><i class="fas fa-play"></i></button>${['paused','conflict','error'].includes(item.state) ? `<button class="action-btn" data-gc-controller-resume="${item.id}" title="Resume explicitly"><i class="fas fa-rotate"></i></button>` : ''}</td></tr>`).join('') || this._empty('No reconcile controllers', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Manual reconcile evidence</h3></div><table class="data-table"><thead><tr><th>Run / commit</th><th>Summary</th><th>State</th><th></th></tr></thead><tbody>
        ${(delivery.reconcileRuns || []).map(item => `<tr><td class="mono text-xs">#${item.id}<br>${Utils.escapeHtml(item.commitSha || item.planHash.slice(0, 12))}</td><td>+${item.summary.create || 0} ~${item.summary.update || 0} -${item.summary.delete || 0}<div class="text-xs text-muted">${item.summary.blocked || 0} blocked</div></td><td><span class="badge ${item.status === 'applied' || item.status === 'in_sync' ? 'badge-success' : item.status === 'blocked' || item.status === 'conflict' ? 'badge-danger' : 'badge-secondary'}">${item.status}</span></td><td>${item.status === 'planned' ? `<button class="action-btn" data-gc-reconcile-approve="${item.id}" title="Approve reviewed hash"><i class="fas fa-check"></i></button>` : ''}${item.status === 'approved' ? `<button class="action-btn" data-gc-reconcile-apply="${item.id}" title="Attach durable operation evidence"><i class="fas fa-link"></i></button>` : ''}</td></tr>`).join('') || this._empty('No manual or continuous reconcile evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>PR / Terraform plan evidence</h3></div><table class="data-table"><thead><tr><th>Source / reference</th><th>Policy</th><th>Blast radius</th><th></th></tr></thead><tbody>
        ${(delivery.externalPlans || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.sourceKind)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.externalRef)}</div></td><td><span class="badge ${item.policy.passed ? 'badge-success' : 'badge-danger'}">${item.status}</span></td><td>${item.blastRadius.changedResources ?? item.blastRadius.changedPaths ?? 0} changed<div class="text-xs text-muted">risk: ${item.blastRadius.risk}</div></td><td>${['reviewed','blocked'].includes(item.status) ? `<button class="action-btn" data-gc-external-authorize="${item.id}" title="Record gated authorization"><i class="fas fa-shield-check"></i></button>` : ''}</td></tr>`).join('') || this._empty('No pull-request or Terraform evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Signed runbook triggers</h3></div><table class="data-table"><thead><tr><th>Name</th><th>Procedure</th><th>Events</th><th>Window</th></tr></thead><tbody>
        ${(delivery.webhookTriggers || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.tokenPrefix)}…</div></td><td>#${item.procedureId}</td><td>${item.events.map(event => `<span class="badge badge-secondary mono">${Utils.escapeHtml(event)}</span>`).join(' ')}</td><td>${item.timestampSkewSeconds}s · ${item.enabled ? 'enabled' : 'disabled'}</td></tr>`).join('') || this._empty('No signed runbook triggers', 4)}</tbody></table></div>
      </div>
      ${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-ops-schedule"><i class="fas fa-calendar-days"></i> Schedule</button>
        <button class="btn btn-secondary btn-sm" id="gc-ops-approval"><i class="fas fa-user-clock"></i> Timed approval</button>
        <button class="btn btn-secondary btn-sm" id="gc-ops-dry-run"><i class="fas fa-flask"></i> Provider dry-run</button>
        <button class="btn btn-secondary btn-sm" id="gc-ops-broker"><i class="fas fa-key"></i> Secret broker</button>
        <button class="btn btn-primary btn-sm" id="gc-ops-template"><i class="fas fa-book"></i> Workflow template</button>`) }
      <div class="card"><div class="card-header"><div><h3>Automation operations safety</h3><p class="text-muted text-sm">Calendar and approval timers create evidence only. Dry runs never fall back to apply, and broker probes expose fingerprints rather than secret material.</p></div></div>
        <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">
          ${[['Calendar schedules','calendarSchedules'],['Approval escalation','approvalEscalation'],['Provider dry-run','providerDryRunAdapters'],['JIT secret broker','secretBrokerJit'],['Curated templates','curatedWorkflowTemplates']].map(([label,key]) => `<span class="badge ${operations.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}
          <span class="badge badge-success"><i class="fas fa-shield" style="margin-right:4px"></i>No implicit apply</span>
        </div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Calendar-aware schedules</h3></div><table class="data-table"><thead><tr><th>Name / workflow</th><th>Cron / timezone</th><th>Calendar</th><th>State</th></tr></thead><tbody>
        ${(operations.schedules || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">workflow #${item.workflowId}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.cron)}<br>${Utils.escapeHtml(item.timezone)}</td><td>${item.holidays.length} holidays · ${item.blackoutWindows.length} blackouts</td><td><span class="badge ${item.enabled ? 'badge-success' : 'badge-secondary'}">${item.enabled ? 'enabled' : 'disabled'}</span></td></tr>`).join('') || this._empty('No automation schedules', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Timed approval evidence</h3></div><table class="data-table"><thead><tr><th>Action / target</th><th>Deadline</th><th>State</th><th></th></tr></thead><tbody>
        ${(operations.approvals || []).map(item => `<tr><td><strong class="mono text-xs">${Utils.escapeHtml(item.actionKey)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.targetType)}:${Utils.escapeHtml(item.targetId)}</div></td><td>${new Date(item.dueAt).toLocaleString()}<div class="text-xs text-muted">${item.escalationCount} escalations</div></td><td><span class="badge ${item.state === 'approved' ? 'badge-success' : ['expired','rejected'].includes(item.state) ? 'badge-danger' : 'badge-warning'}">${item.state}</span></td><td>${['pending','escalated'].includes(item.state) ? `<button class="action-btn success" data-gc-ops-approve="${item.id}" title="Approve reviewed hash"><i class="fas fa-check"></i></button><button class="action-btn danger" data-gc-ops-reject="${item.id}" title="Reject"><i class="fas fa-times"></i></button>` : ''}</td></tr>`).join('') || this._empty('No timed approvals', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Provider dry-run evidence</h3></div><table class="data-table"><thead><tr><th>Provider / action</th><th>Target</th><th>Status</th><th>Evidence</th></tr></thead><tbody>
        ${(operations.dryRuns || []).map(item => `<tr><td>${Utils.escapeHtml(item.providerType)}<div class="mono text-xs">${Utils.escapeHtml(item.actionKey)}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.targetRef)}</td><td><span class="badge ${item.status === 'valid' ? 'badge-success' : item.status === 'unsupported' ? 'badge-secondary' : 'badge-danger'}">${item.status}</span></td><td class="mono text-xs">${item.requestHash.slice(0, 12)}</td></tr>`).join('') || this._empty('No provider dry-run evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>JIT secret brokers &amp; templates</h3></div><table class="data-table"><thead><tr><th>Name</th><th>Kind</th><th>Policy</th><th></th></tr></thead><tbody>
        ${(operations.secretBrokers || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.secretReference)}</div></td><td>${Utils.escapeHtml(item.providerKind)}</td><td>${item.maxLeaseSeconds}s · ${item.allowedPurposes.length} purposes</td><td><button class="action-btn" data-gc-ops-probe="${item.id}" title="Probe without returning secret"><i class="fas fa-stethoscope"></i></button></td></tr>`).join('') || this._empty('No JIT secret brokers', 4)}</tbody></table>
        <div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap">${(operations.workflowTemplates || []).map(item => `<span class="badge badge-secondary">${Utils.escapeHtml(item.category)} · ${Utils.escapeHtml(item.slug)}@${Utils.escapeHtml(item.version)}</span>`).join('')}</div></div>
      </div>`;
  },

  _plugins() {
    const data = this._data.providerPlugins || { capabilities: {}, contract: {}, plugins: [], runs: [] };
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-plugin-consent"><i class="fas fa-user-shield"></i> Permission consent</button>
      <button class="btn btn-secondary btn-sm" id="gc-plugin-sandbox"><i class="fas fa-box"></i> Sandbox probe</button>
      <button class="btn btn-secondary btn-sm" id="gc-plugin-health"><i class="fas fa-heart-pulse"></i> Health metric</button>
      <button class="btn btn-primary btn-sm" id="gc-plugin-register"><i class="fas fa-signature"></i> Signed manifest</button>`) }
      <div class="info-grid">${this._stat('fa-puzzle-piece', 'Registered plugins', data.plugins.length)}${this._stat('fa-signature', 'Verified signatures', data.plugins.filter(item => item.signatureState === 'verified').length)}${this._stat('fa-toggle-on', 'Enabled', data.plugins.filter(item => item.enabled).length)}${this._stat('fa-box', 'Sandbox runs', data.runs.length)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Provider plugin trust boundary</h3><p class="text-muted text-sm">Ed25519 signs the canonical manifest. Every read/write/secret/network permission needs consent bound to that exact hash. The sandbox runs only a fixed JSON-RPC control-plane worker in a separate process and never loads plugin code or returns request payloads.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries({ signedManifest:'Signed manifest', outOfProcessSandbox:'Out-of-process RPC', permissionConsent:'Permission consent', compatibilityChecker:'Compatibility gate', healthTelemetry:'Payload-free health' }).map(([key,label]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-secondary mono">API ${Utils.escapeHtml(data.contract?.apiVersion || '—')} · core ${Utils.escapeHtml(data.contract?.coreVersion || '—')}</span></div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Signed provider plugins</h3></div><table class="data-table"><thead><tr><th>Plugin / manifest</th><th>Permissions</th><th>Compatibility</th><th>Health</th><th></th></tr></thead><tbody>${(data.plugins || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.pluginKey)} ${Utils.escapeHtml(item.version)}</strong><div class="mono text-xs">${item.manifestHash.slice(0, 12)} · Ed25519 ${item.signatureState}</div></td><td>${item.permissions.map(permission => `<span class="badge ${['secret','mutation','network'].includes(permission.risk) ? 'badge-warning' : 'badge-secondary'}">${Utils.escapeHtml(permission.key)} · ${permission.risk}</span>`).join(' ') || 'none'}</td><td><span class="badge ${item.compatibility.state === 'ready' ? 'badge-success' : 'badge-danger'}">${item.compatibility.state}</span><div class="text-xs text-muted">${item.compatibility.checks.filter(check => check.state === 'pass').length}/${item.compatibility.checks.length} checks · ${item.enabled ? 'enabled' : 'disabled'}</div></td><td>${item.health ? `<span class="badge ${item.health.state === 'healthy' ? 'badge-success' : 'badge-danger'}">${item.health.state}</span><div class="text-xs text-muted">${item.health.latencyMs} ms · ${(item.health.errorRate * 100).toFixed(1)}% errors · ${item.health.crashCount} crashes</div>` : '<span class="text-muted">unknown</span>'}</td><td><button class="action-btn" data-gc-plugin-check="${Utils.escapeHtml(item.pluginKey)}" title="Compatibility details"><i class="fas fa-list-check"></i></button><button class="action-btn ${item.enabled ? 'danger' : 'success'}" data-gc-plugin-enable="${Utils.escapeHtml(item.pluginKey)}" data-enabled="${item.enabled}" title="${item.enabled ? 'Disable' : 'Enable after all gates'}"><i class="fas fa-${item.enabled ? 'stop' : 'play'}"></i></button></td></tr>`).join('') || this._empty('No signed provider plugins', 5)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Sandbox evidence</h3></div><table class="data-table"><thead><tr><th>Plugin / method</th><th>Status</th><th>Boundary</th><th>Evidence</th></tr></thead><tbody>${(data.runs || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.pluginKey)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.method)}</div></td><td><span class="badge ${item.status === 'passed' ? 'badge-success' : 'badge-danger'}">${item.status}</span><div class="text-xs text-muted">${item.durationMs} ms</div></td><td>fixed worker · no plugin code<div class="text-xs text-muted">payload returned: ${item.payloadReturned ? 'yes' : 'no'} · network endpoint: none</div></td><td class="mono text-xs">${item.requestHash.slice(0, 12)}${item.responseHash ? ` / ${item.responseHash.slice(0, 12)}` : ''}</td></tr>`).join('') || this._empty('No sandbox probe evidence', 4)}</tbody></table></div>`;
  },

  _connectors() {
    const data = this._data.connectorMarketplace || { capabilities: {}, contract: {}, entries: [], summary: {} };
    const total = Object.values(data.summary || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const actions = [['marketplace','Signed entry'],['cmdb','CMDB sync'],['itsm','ITSM change'],['siem','SIEM event'],['secrets','Secret ref'],['ipam','IPAM / DNS'],['backup','Backup evidence'],['monitoring','Monitoring target'],['eventbus','Event publication'],['openapi','OpenAPI allowlist'],['prototype','OpenAPI prototype']]
      .map(([kind,label], index) => `<button class="btn ${index === 0 ? 'btn-primary' : 'btn-secondary'} btn-sm" data-gc-connector-action="${kind}"><i class="fas fa-${index === 0 ? 'signature' : 'file-code'}"></i> ${label}</button>`).join('');
    const capabilityLabels = { connectorMarketplaceRegistry: 'Signed registry', cmdbConnector: 'CMDB', itsmChangeConnector: 'ITSM', siemConnectorPack: 'SIEM', secretsManagerConnectors: 'Secret refs', ipamDnsConnectorPack: 'IPAM / DNS', backupVendorConnectorApi: 'Backup', monitoringConnectorPack: 'Monitoring', eventBusIntegration: 'Event bus', genericOpenApiConnector: 'OpenAPI' };
    return `${this._actions(actions)}
      <div class="info-grid">${this._stat('fa-store', 'Signed entries', data.entries.length)}${this._stat('fa-diagram-project', 'Recorded contracts', total)}${this._stat('fa-key', 'Secret values stored', 0)}${this._stat('fa-network-wired', 'Network calls started', 0)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Connector marketplace safety boundary</h3><p class="text-muted text-sm">Marketplace metadata is Ed25519-signed. Endpoints must match an exact HTTPS host signed into the manifest. Secret managers store references only; CMDB, IPAM/DNS, monitoring, event-bus and OpenAPI actions create allowlisted, hash-bound control-plane plans and do not send traffic in this surface.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(capabilityLabels).map(([key,label]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-secondary mono">schema ${Utils.escapeHtml(data.contract?.schemaVersion || '—')} · ${Utils.escapeHtml(data.contract?.endpointPolicy || 'fail closed')}</span></div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Curated connector entries</h3></div><table class="data-table"><thead><tr><th>Connector / publisher</th><th>Support</th><th>Domains</th><th>Products</th><th>Signed hosts / evidence</th></tr></thead><tbody>${(data.entries || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.connectorKey)}@${Utils.escapeHtml(item.version)} · ${Utils.escapeHtml(item.publisher)}</div></td><td><span class="badge ${item.supportLevel === 'official' ? 'badge-success' : item.supportLevel === 'partner' ? 'badge-warning' : 'badge-secondary'}">${Utils.escapeHtml(item.supportLevel)}</span></td><td>${item.domains.map(value => `<span class="badge badge-secondary">${Utils.escapeHtml(value)}</span>`).join(' ')}</td><td>${item.products.slice(0, 8).map(value => `<span class="badge badge-secondary">${Utils.escapeHtml(value)}</span>`).join(' ')}${item.products.length > 8 ? `<span class="text-xs text-muted"> +${item.products.length - 8}</span>` : ''}</td><td>${item.allowedHosts.map(Utils.escapeHtml).join(', ') || 'none'}<div class="mono text-xs">Ed25519 ${item.signatureState} · ${item.manifestHash.slice(0, 12)}</div></td></tr>`).join('') || this._empty('No signed connector entries. Register a reviewed manifest before creating an integration contract.', 5)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Integration contract ledger</h3></div><table class="data-table"><thead><tr><th>Domain</th><th>Records</th><th>Execution boundary</th></tr></thead><tbody>${Object.entries(data.summary || {}).map(([domain,count]) => `<tr><td><strong>${Utils.escapeHtml(domain)}</strong></td><td>${count}</td><td><span class="badge badge-success">planned / evidence only</span><div class="text-xs text-muted">0 implicit network calls or external mutations</div></td></tr>`).join('') || this._empty('No connector contracts recorded', 3)}</tbody></table></div>`;
  },

  _migrationFactory() {
    const data = this._data.migrationFactory || { capabilities: {}, safety: {}, summary: {}, assessments: [] };
    const actions = [['assessment','Assessment'],['conversion','Conversion'],['network','Network map'],['storage','Storage map'],['clone','Test clone'],['waves','Waves'],['cutover','Cutover plan'],['rollback','Rollback plan'],['report','Evidence report'],['xen','Legacy Xen']]
      .map(([kind,label], index) => `<button class="btn ${index === 0 ? 'btn-primary' : 'btn-secondary'} btn-sm" data-gc-migration-action="${kind}"><i class="fas fa-${index === 0 ? 'magnifying-glass-chart' : 'route'}"></i> ${label}</button>`).join('');
    const labels = { assessmentScanner: 'Assessment', sandboxedConversionContract: 'Conversion worker', networkMapper: 'Network map', storageMapper: 'Storage map', isolatedTestCloneEvidence: 'Test clone', wavePlanner: 'Waves', cutoverOrchestratorPlan: 'Cutover', rollbackOrchestratorPlan: 'Rollback', evidenceReport: 'Evidence report', legacyXenAssistant: 'Legacy Xen' };
    return `${this._actions(actions)}<div class="info-grid">${this._stat('fa-magnifying-glass-chart', 'Assessments', data.summary?.assessments || 0)}${this._stat('fa-layer-group', 'Wave plans', data.summary?.wavePlans || 0)}${this._stat('fa-shield-halved', 'Validated clones', data.summary?.testClones || 0)}${this._stat('fa-play', 'Provider mutations', data.safety?.providerMutationsStarted || 0)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Migration factory execution boundary</h3><p class="text-muted text-sm">Assessment, mapping and reports use bounded evidence. The fixed conversion subprocess receives only formats and checksums, no paths, network or disk access. Test-clone results are imported evidence; cutover and rollback are approval/confirmation-bound plans with no execute endpoint.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(labels).map(([key,label]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-ban" style="margin-right:4px"></i>0 implicit apply</span></div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Migration assessments</h3></div><table class="data-table"><thead><tr><th>ID</th><th>Source → target</th><th>State</th><th>Evidence</th><th>Created</th></tr></thead><tbody>${(data.assessments || []).map(item => `<tr><td>#${item.id}</td><td><strong>${Utils.escapeHtml(item.sourceProvider)}</strong> → <strong>${Utils.escapeHtml(item.targetProvider)}</strong></td><td><span class="badge ${item.state === 'ready' ? 'badge-success' : 'badge-danger'}">${item.state}</span></td><td class="mono text-xs">${item.assessmentHash.slice(0, 16)}</td><td>${new Date(item.createdAt).toLocaleString()}</td></tr>`).join('') || this._empty('No migration assessment evidence', 5)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Migration factory ledger</h3></div><table class="data-table"><thead><tr><th>Artifact</th><th>Records</th><th>Boundary</th></tr></thead><tbody>${Object.entries(data.summary || {}).map(([kind,count]) => `<tr><td><strong>${Utils.escapeHtml(kind)}</strong></td><td>${count}</td><td><span class="badge badge-success">hash-bound control plane</span><div class="text-xs text-muted">external execution requires a separately approved adapter</div></td></tr>`).join('') || this._empty('No migration factory records', 3)}</tbody></table></div>`;
  },

  _platformFoundation() {
    const data = this._data.platformFoundation || { capabilities: {}, safety: {}, summary: {}, events: [], sessions: [] };
    const labels = { commonEventModel: 'Common events', incrementalInventorySync: 'Delta inventory', resourceCollections: 'Collections', customMetadataFields: 'Typed metadata', resourceRelationshipGraph: 'Relationship graph', duplicateOrphanDetector: 'Hygiene scans', rateLimitBudgetManager: 'Rate budgets', linkedThinClonePlanner: 'Linked clone', guestCustomizationProfiles: 'Guest profiles', flavorOfferingMapper: 'Flavor mapping', imageLibraryAggregator: 'Image library', resumableImageImportReceipts: 'Resumable import' };
    const total = Object.values(data.summary || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    return `<div class="info-grid">${this._stat('fa-wave-square', 'Normalized events', data.summary?.events || 0)}${this._stat('fa-arrows-rotate', 'Inventory deltas', data.summary?.inventoryDeltas || 0)}${this._stat('fa-photo-film', 'Image observations', data.summary?.images || 0)}${this._stat('fa-database', 'Control-plane records', total)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Platform and content safety boundary</h3><p class="text-muted text-sm">Events, cursors, collections, metadata, relationships and image provenance use canonical bounded contracts. Clone and image-import workflows produce immutable plans or chunk receipts only; no image bytes are stored here and no provider mutation, cleanup, conversion or import is started implicitly.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(labels).map(([key,label]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-ban" style="margin-right:4px"></i>${data.safety?.providerMutationsStarted || 0} provider mutations</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Latest normalized events</h3></div><table class="data-table"><thead><tr><th>Provider</th><th>Event / resource</th><th>Severity</th><th>Evidence</th></tr></thead><tbody>${(data.events || []).map(item => `<tr><td>#${item.providerHostId}<div class="text-xs text-muted">${Utils.escapeHtml(item.providerType)}</div></td><td><strong>${Utils.escapeHtml(item.eventType)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.resourceKey || 'provider')}</div></td><td><span class="badge ${['error','critical'].includes(item.severity) ? 'badge-danger' : item.severity === 'warning' ? 'badge-warning' : 'badge-secondary'}">${item.severity}</span></td><td class="mono text-xs">${item.fingerprint.slice(0, 14)}<div>${new Date(item.occurredAt).toLocaleString()}</div></td></tr>`).join('') || this._empty('No normalized provider events', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Image import control plane</h3></div><table class="data-table"><thead><tr><th>Session / file</th><th>Format</th><th>Size</th><th>State / plan</th></tr></thead><tbody>${(data.sessions || []).map(item => `<tr><td>#${item.id}<div class="text-xs text-muted">${Utils.escapeHtml(item.fileName)}</div></td><td>${Utils.escapeHtml(item.inputFormat)} → ${Utils.escapeHtml(item.targetFormat)}</td><td>${Utils.formatBytes(item.totalBytes)}</td><td><span class="badge ${item.state === 'ready' ? 'badge-success' : item.state === 'blocked' ? 'badge-danger' : 'badge-secondary'}">${item.state}</span><div class="mono text-xs">${item.planHash ? item.planHash.slice(0, 14) : 'awaiting receipts'}</div></td></tr>`).join('') || this._empty('No image upload receipt sessions', 4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Contract ledger</h3></div><table class="data-table"><thead><tr><th>Artifact</th><th>Records</th><th>Execution boundary</th></tr></thead><tbody>${Object.entries(data.summary || {}).map(([kind,count]) => `<tr><td><strong>${Utils.escapeHtml(kind)}</strong></td><td>${count}</td><td><span class="badge badge-success">versioned / hash-bound</span><div class="text-xs text-muted">data-plane execution requires a separately approved adapter</div></td></tr>`).join('') || this._empty('No platform foundation records', 3)}</tbody></table></div>`;
  },

  _vmContentMobility() {
    const data = this._data.vmContentMobility || { capabilities: {}, safety: {}, summary: {}, templates: [], migrations: [] };
    const labels = { imageReplication:'Image replication',templateVersioning:'Template versions',templatePromotion:'Promotion',vmLeaseTtl:'VM leases',guestGracefulCommand:'Guest commands',multiProtocolConsole:'Console protocols',liveMigration:'Live migration',coldMigration:'Cold migration',storageLiveMigration:'Storage migration',crossPoolMigration:'Cross-pool',crossProviderMigration:'Cross-provider',migrationBandwidth:'Bandwidth',migrationQueue:'Fair queue',migrationAbortForceComplete:'Cancel / reconcile',migrationRollback:'Rollback plans' };
    const total=Object.values(data.summary||{}).reduce((sum,value)=>sum+Number(value||0),0);
    return `<div class="info-grid">${this._stat('fa-photo-film','Template versions',data.summary?.templateVersions||0)}${this._stat('fa-arrows-left-right','Migration plans',Number(data.summary?.liveMigrations||0)+Number(data.summary?.coldMigrations||0)+Number(data.summary?.storageMigrations||0))}${this._stat('fa-list-ol','Queue policies',data.summary?.queuePolicies||0)}${this._stat('fa-database','Control-plane records',total)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Content and mobility execution boundary</h3><p class="text-muted text-sm">Version, promotion, lease, mapping, queue and rollback records are immutable control-plane evidence. Same-provider live/cold/storage submission reuses the established durable vm.migrate engine; console sessions reuse the protected gateway. Cross-pool/provider, image replication, promotion and rollback expose no implicit executor.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(labels).map(([key,label])=>`<span class="badge ${data.capabilities?.[key]?'badge-success':'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-ban" style="margin-right:4px"></i>${data.safety?.providerMutationsStarted||0} implicit mutations</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Managed template versions</h3></div><table class="data-table"><thead><tr><th>Template</th><th>Version</th><th>Owner</th><th>Digest / state</th></tr></thead><tbody>${(data.templates||[]).map(item=>`<tr><td><strong>${Utils.escapeHtml(item.templateKey)}</strong></td><td class="mono">${Utils.escapeHtml(item.version)}</td><td>${Utils.escapeHtml(item.ownerRef)}</td><td class="mono text-xs">${item.digestSha256.slice(0,14)}<div><span class="badge ${item.deprecated?'badge-warning':'badge-success'}">${item.deprecated?'deprecated':'active'}</span></div></td></tr>`).join('')||this._empty('No managed template versions',4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Same-provider migration controls</h3></div><table class="data-table"><thead><tr><th>Mode / resource</th><th>Placement</th><th>State</th><th>Plan</th></tr></thead><tbody>${(data.migrations||[]).map(item=>`<tr><td><strong>${Utils.escapeHtml(item.mode)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.resourceKey)}</div></td><td>${Utils.escapeHtml(item.sourceRef)} → ${Utils.escapeHtml(item.targetRef)}</td><td><span class="badge ${item.state==='ready'?'badge-success':'badge-danger'}">${item.state}</span></td><td class="mono text-xs">${item.planHash.slice(0,14)}</td></tr>`).join('')||this._empty('No migration control plans',4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Content and mobility ledger</h3></div><table class="data-table"><thead><tr><th>Artifact</th><th>Records</th><th>Boundary</th></tr></thead><tbody>${Object.entries(data.summary||{}).map(([kind,count])=>`<tr><td><strong>${Utils.escapeHtml(kind)}</strong></td><td>${count}</td><td><span class="badge badge-success">hash-bound / audited</span><div class="text-xs text-muted">existing executor or separately approved adapter only</div></td></tr>`).join('')||this._empty('No content or mobility evidence',3)}</tbody></table></div>`;
  },

  _storageAdvanced() {
    const data=this._data.storageAdvanced||{capabilities:{},safety:{},summary:{},suiteHealth:[],objectStores:[]};
    const labels={diskFormatConversion:'Format conversion',storagePolicyInventory:'Policy inventory',storagePolicyAssignment:'Policy assignment',storageLatencyHeatmap:'Latency heatmap',storageMultipathHealth:'Multipath health',orphanDiskCleanup:'Orphan cleanup',snapshotConsolidation:'Snapshot consolidation',storageQosEditor:'QoS plans',storageTieringRecommendation:'Tiering recommendation',sharedDiskTopology:'Shared-disk topology',objectStorageRegistry:'Object storage',cephHealth:'Ceph health',longhornHealth:'Longhorn health',vsanS2dAosHealth:'vSAN / S2D / AOS',storageChangePlan:'Change planner'};
    const total=Object.values(data.summary||{}).reduce((sum,value)=>sum+Number(value||0),0);
    const healthBadge=state=>state==='healthy'?'badge-success':state==='degraded'?'badge-warning':state==='failed'||state==='unavailable'?'badge-danger':'badge-secondary';
    return `<div class="info-grid">${this._stat('fa-wave-square','Health observations',data.summary?.suiteHealth||0)}${this._stat('fa-cloud','Object stores',data.summary?.objectStores||0)}${this._stat('fa-list-check','Change plans',data.summary?.changePlans||0)}${this._stat('fa-database','Control-plane records',total)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Advanced storage execution boundary</h3><p class="text-muted text-sm">Format, policy, cleanup, QoS, tiering and change operations persist hash-bound plans only. Health and topology are imported read-only evidence. Snapshot consolidation and shared-disk topology reuse their established guarded provider flows; this surface starts no provider mutation, cleanup, probe or network call.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(labels).map(([key,label])=>`<span class="badge ${data.capabilities?.[key]?'badge-success':'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-ban" style="margin-right:4px"></i>${data.safety?.providerMutationsStarted||0} implicit mutations</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Storage suite health</h3></div><table class="data-table"><thead><tr><th>Suite / host</th><th>State</th><th>Components</th><th>Resync / evidence</th></tr></thead><tbody>${(data.suiteHealth||[]).map(item=>`<tr><td><strong>${Utils.escapeHtml(item.suite)}</strong><div class="text-xs text-muted">host #${item.providerHostId}</div></td><td><span class="badge ${healthBadge(item.summary?.state)}">${Utils.escapeHtml(item.summary?.state||'unknown')}</span><div class="text-xs text-muted">${item.summary?.usedPercent==null?'capacity unknown':`${item.summary.usedPercent}% used`}</div></td><td>${item.summary?.components||0}<div class="text-xs text-muted">${item.summary?.failed||0} failed · ${item.summary?.degraded||0} degraded · ${item.summary?.unknown||0} unknown</div></td><td>${Utils.formatBytes(item.summary?.resyncBytes||0)}<div class="mono text-xs">${item.observationHash.slice(0,14)}</div></td></tr>`).join('')||this._empty('No normalized Ceph, Longhorn, vSAN, S2D or AOS evidence',4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Object storage registry</h3></div><table class="data-table"><thead><tr><th>Endpoint</th><th>Provider / region</th><th>Health</th><th>Evidence</th></tr></thead><tbody>${(data.objectStores||[]).map(item=>`<tr><td><strong>${Utils.escapeHtml(item.endpointKey)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.origin)}</div></td><td>${Utils.escapeHtml(item.providerType)}<div class="text-xs text-muted">${Utils.escapeHtml(item.region||'global')}</div></td><td><span class="badge ${healthBadge(item.health?.state)}">${Utils.escapeHtml(item.health?.state||'unknown')}</span><div class="text-xs text-muted">policy ${Utils.escapeHtml(item.health?.policyState||'unknown')}</div></td><td class="mono text-xs">${item.registryHash.slice(0,14)}<div>no implicit probe</div></td></tr>`).join('')||this._empty('No object-storage endpoints registered',4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Advanced storage ledger</h3></div><table class="data-table"><thead><tr><th>Artifact</th><th>Records</th><th>Boundary</th></tr></thead><tbody>${Object.entries(data.summary||{}).map(([kind,count])=>`<tr><td><strong>${Utils.escapeHtml(kind)}</strong></td><td>${count}</td><td><span class="badge badge-success">bounded / hash-bound / audited</span><div class="text-xs text-muted">separately approved adapter or established guarded executor only</div></td></tr>`).join('')||this._empty('No advanced storage records',3)}</tbody></table></div>`;
  },

  _networkAdvanced() {
    const data=this._data.networkAdvanced||{capabilities:{},safety:{},summary:{},distributedFirewalls:[],flowBatches:[],dependencyMap:{},reachability:{},mtuDetector:{},bondHealth:{},loadBalancerInventory:{},publicIpPlans:{}};
    const labels={nicAttachWizard:'NIC attach',safeNicDetach:'Safe NIC detach',networkMappingProfiles:'Mapping profiles',vlanIntent:'VLAN intent',trunkQinqIntent:'Trunk / QinQ',vxlanIntent:'VXLAN intent',tenantVpcSubnetLifecycle:'VPC / subnet',ipamIntegration:'IPAM',dhcpReservation:'DHCP',dnsAutomation:'DNS',securityGroupInventory:'Security groups',securityGroupChangePlan:'SG change plan',distributedFirewallAdapters:'Distributed firewall',microsegmentationPolicy:'Microsegmentation',flowLogIngestion:'Flow logs',networkIntentValidation:'Intent validation',networkDependencyMap:'Dependency map',networkReachabilitySimulation:'Reachability simulation',networkMtuMismatch:'MTU mismatch',networkBondHealth:'Bond / LAG health',loadBalancerInventory:'Load balancers',publicIpLifecyclePlans:'Public IP plans'};
    const total=Object.values(data.summary||{}).reduce((sum,value)=>sum+Number(value||0),0);
    const dependency=data.dependencyMap||{}; const snapshot=dependency.latest||null; const dependencyEdges=(snapshot?.edges||[]).slice(0,200); const reachabilityAssessments=data.reachability?.assessments||[]; const mtuAssessments=data.mtuDetector?.assessments||[]; const bondObservations=data.bondHealth?.observations||[]; const loadBalancerObservations=data.loadBalancerInventory?.observations||[]; const publicIpPlans=data.publicIpPlans?.plans||[];
    return `${this._actions('<button class="btn btn-secondary btn-sm" id="gc-network-public-ip"><i class="fas fa-globe"></i> Plan public IP</button><button class="btn btn-secondary btn-sm" id="gc-network-lb"><i class="fas fa-scale-balanced"></i> Record LB inventory</button><button class="btn btn-secondary btn-sm" id="gc-network-bond"><i class="fas fa-link"></i> Record Bond/LAG health</button><button class="btn btn-secondary btn-sm" id="gc-network-mtu"><i class="fas fa-ruler-horizontal"></i> Assess MTU path</button><button class="btn btn-secondary btn-sm" id="gc-network-reachability"><i class="fas fa-route"></i> Simulate reachability</button><button class="btn btn-secondary btn-sm" id="gc-network-dependency-build"><i class="fas fa-project-diagram"></i> Rebuild dependency map</button><button class="btn btn-primary btn-sm" id="gc-network-intent"><i class="fas fa-clipboard-check"></i> Validate network intent</button>')}<div class="info-grid">${this._stat('fa-route','Reachability simulations',data.summary?.reachabilityAssessments||0)}${this._stat('fa-globe','Public IP plans',data.summary?.publicIpPlans||0)}${this._stat('fa-scale-balanced','LB observations',data.summary?.loadBalancerObservations||0)}${this._stat('fa-database','Control-plane records',total)}</div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Advanced network execution boundary</h3><p class="text-muted text-sm">NIC, segment, tenant, address, security-group and microsegmentation changes are immutable validation plans. Provider firewall and signed IPAM/DNS connector flows are referenced but never started here. Distributed policy and five-tuple flows are normalized imported evidence; no traffic, raw payload, provider mutation or external call is produced implicitly.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(labels).map(([key,label])=>`<span class="badge ${data.capabilities?.[key]?'badge-success':'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-ban" style="margin-right:4px"></i>${data.safety?.providerMutationsStarted||0} implicit mutations</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Distributed firewall evidence</h3></div><table class="data-table"><thead><tr><th>Provider / scope</th><th>State</th><th>Layers / groups / rules</th><th>Evidence</th></tr></thead><tbody>${(data.distributedFirewalls||[]).map(item=>`<tr><td><strong>${Utils.escapeHtml(item.providerType)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.scopeKey)} · host #${item.providerHostId}</div></td><td><span class="badge ${item.summary?.state==='observed'?'badge-success':'badge-secondary'}">${Utils.escapeHtml(item.summary?.state||'unknown')}</span></td><td>${item.summary?.layers||0} / ${item.summary?.groups||0} / ${item.summary?.rules||0}</td><td class="mono text-xs">${item.observationHash.slice(0,14)}<div>${new Date(item.observedAt).toLocaleString()}</div></td></tr>`).join('')||this._empty('No NSX, Flow, PVE, Neutron or OVN policy evidence',4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Normalized flow batches</h3></div><table class="data-table"><thead><tr><th>Source / host</th><th>Allow / deny</th><th>Traffic</th><th>Retention / evidence</th></tr></thead><tbody>${(data.flowBatches||[]).map(item=>`<tr><td><strong>${Utils.escapeHtml(item.source)}</strong><div class="text-xs text-muted">${item.providerHostId?`host #${item.providerHostId}`:'external evidence'}</div></td><td>${item.summary?.allowed||0} / ${item.summary?.denied||0}</td><td>${Utils.formatBytes(item.summary?.bytes||0)}<div class="text-xs text-muted">${item.summary?.packets||0} packets · no raw payload</div></td><td>${new Date(item.retentionUntil).toLocaleDateString()}<div class="mono text-xs">${item.batchHash.slice(0,14)}</div></td></tr>`).join('')||this._empty('No normalized flow evidence',4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Network intent validation</h3><p class="text-muted text-sm">Only a complete, conflict-free intent receives pass. Future executors must bind both immutable hashes.</p></div></div><table class="data-table"><thead><tr><th>Scope / version</th><th>Verdict</th><th>Coverage</th><th>Executor evidence</th></tr></thead><tbody>${(data.intentValidations||[]).map(item=>`<tr><td><strong class="mono">${Utils.escapeHtml(item.scopeKey)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.intentVersion)}</div></td><td><span class="badge ${item.verdict==='pass'?'badge-success':item.verdict==='fail'?'badge-danger':'badge-secondary'}">${Utils.escapeHtml(item.verdict)}</span><div class="text-xs text-muted">${item.summary?.failed||0} fail · ${item.summary?.unknown||0} unknown</div></td><td>${item.summary?.networks||0} networks<div class="text-xs text-muted">${item.summary?.cidrs||0} CIDRs · ${item.summary?.reservedCidrs||0} reserved</div></td><td class="mono text-xs">intent ${item.intentHash.slice(0,12)}<div>validation ${item.validationHash.slice(0,12)}</div><div>0 mutations</div></td></tr>`).join('')||this._empty('No network intent validations',4)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Network dependency map</h3><p class="text-muted text-sm">Declared relationships drive impact analysis. Flow-only candidates remain visible but are never promoted to causal dependencies.</p></div>${snapshot?`<div class="text-xs text-muted">Built ${new Date(snapshot.builtAt).toLocaleString()} · <span class="mono">${snapshot.snapshotHash.slice(0,14)}</span></div>`:''}</div><table class="data-table"><thead><tr><th>Upstream → downstream</th><th>Basis</th><th>Confidence / freshness</th><th>Evidence window</th></tr></thead><tbody>${dependencyEdges.map(edge=>`<tr><td><strong class="mono">${Utils.escapeHtml(edge.source)}</strong><div><i class="fas fa-arrow-down text-muted"></i></div><strong class="mono">${Utils.escapeHtml(edge.target)}</strong><div style="display:flex;gap:5px;margin-top:5px"><button class="btn btn-secondary btn-xs" data-gc-dependency-impact="${Utils.escapeHtml(edge.source)}" data-snapshot-id="${snapshot.id}">Impact</button><button class="btn btn-secondary btn-xs" data-gc-dependency-impact="${Utils.escapeHtml(edge.target)}" data-snapshot-id="${snapshot.id}">Dependencies</button></div></td><td><span class="badge ${edge.impactEligible?'badge-success':'badge-secondary'}">${edge.impactEligible?'declared':'observed candidate'}</span><div class="text-xs">${(edge.relationships||[]).map(value=>Utils.escapeHtml(value)).join(', ')}</div><div class="text-xs text-muted">${(edge.evidenceTypes||[]).map(value=>Utils.escapeHtml(value)).join(', ')}</div></td><td>${Math.round(Number(edge.confidence||0)*100)}%<div><span class="badge ${edge.freshness==='fresh'?'badge-success':'badge-warning'}">${Utils.escapeHtml(edge.freshness||'unknown')}</span></div><div class="text-xs text-muted">${Utils.escapeHtml(edge.causality||'unproven')}</div></td><td>${edge.firstSeenAt?new Date(edge.firstSeenAt).toLocaleString():'unknown'}<div class="text-xs text-muted">to ${edge.lastSeenAt?new Date(edge.lastSeenAt).toLocaleString():'unknown'}</div><div class="text-xs">${edge.evidence?.length||0} retained references</div></td></tr>`).join('')||this._empty('Build a snapshot after importing normalized address, DNS, flow or declared relationship evidence',4)}</tbody></table>${snapshot?.edges?.length>dependencyEdges.length?`<p class="text-muted text-sm" style="padding:12px">Showing the first ${dependencyEdges.length} of ${snapshot.edges.length} bounded edges.</p>`:''}</div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Reachability simulation (no active probe)</h3><p class="text-muted text-sm">Control-plane prediction from fresh route, policy, attachment, DNS and optional provider-simulation evidence. Active probes are not run; they require an approved allowlisted runner, verified source ownership and destination policy.</p></div></div><table class="data-table"><thead><tr><th>Source → destination</th><th>Verdict</th><th>Signals / flow</th><th>Boundary / evidence</th></tr></thead><tbody>${reachabilityAssessments.map(item=>`<tr><td><strong class="mono">${Utils.escapeHtml(item.source?.resourceKey||'unknown')}</strong><div class="text-xs">${Utils.escapeHtml(item.source?.address||'unknown')} → ${Utils.escapeHtml(item.destination?.address||item.destination?.hostname||'unknown')}</div><div class="text-xs text-muted">${Utils.escapeHtml(item.protocol)}${item.destinationPort?`/${item.destinationPort}`:''} · ${Utils.escapeHtml(item.scopeKey)}</div></td><td><span class="badge ${item.verdict==='pass'?'badge-success':item.verdict==='fail'?'badge-danger':'badge-secondary'}">${Utils.escapeHtml(item.verdict)}</span><div class="text-xs text-muted">${Utils.escapeHtml(item.summary?.interpretation||'insufficient_evidence')} · ${Utils.escapeHtml(item.summary?.confidence||'low')} confidence</div></td><td><div class="text-xs">route ${Utils.escapeHtml(item.evidence?.signals?.route?.state||'unknown')} · policy ${Utils.escapeHtml(item.evidence?.signals?.policy?.state||'unknown')} · attachment ${Utils.escapeHtml(item.evidence?.signals?.attachment?.state||'unknown')}</div><div class="text-xs text-muted">DNS ${Utils.escapeHtml(item.summary?.dnsState||'unknown')} · flow ${Utils.escapeHtml(item.summary?.flowState||'not_observed')}</div></td><td class="mono text-xs">${item.assessmentHash.slice(0,14)}<div class="text-muted">0 network calls / 0 mutations</div><div class="text-muted">predicted, not data-plane proof</div></td></tr>`).join('')||this._empty('No simulation-only reachability assessments',4)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Passive MTU path assessments</h3><p class="text-muted text-sm">Ordered configuration evidence only. Encapsulation overhead is cumulative; no packet, DF probe, guest command or remediation is started.</p></div></div><table class="data-table"><thead><tr><th>Source / observed</th><th>State / purpose</th><th>Paths / bottlenecks</th><th>Deficit / evidence</th></tr></thead><tbody>${mtuAssessments.map(item=>`<tr><td><strong>${Utils.escapeHtml(item.source)}</strong><div class="text-xs text-muted">${new Date(item.observedAt).toLocaleString()}</div><div class="text-xs ${item.summary?.evidenceExpired?'text-danger':'text-muted'}">${item.summary?.coverageComplete?'complete':'incomplete'} · ${item.summary?.evidenceExpired?'expired':'current'}</div></td><td><span class="badge ${item.summary?.state==='pass'?'badge-success':item.summary?.state==='fail'?'badge-danger':'badge-secondary'}">${Utils.escapeHtml(item.summary?.state||'unknown')}</span><div class="text-xs text-muted">workload ${item.summary?.purposes?.workload||0} · overlay ${item.summary?.purposes?.overlay||0}<br>storage ${item.summary?.purposes?.storage||0} · migration ${item.summary?.purposes?.live_migration||0}</div></td><td>${item.summary?.paths||0} paths<div class="text-xs text-muted">${item.summary?.pass||0} pass · ${item.summary?.fail||0} fail · ${item.summary?.unknown||0} unknown</div><div class="text-xs">${item.summary?.bottlenecks||0} MTU bottlenecks</div></td><td>${item.summary?.maxDeficitBytes||0} bytes max<div class="mono text-xs">${item.assessmentHash.slice(0,14)}</div><div class="text-xs text-muted">0 probes / 0 mutations</div></td></tr>`).join('')||this._empty('No normalized workload, overlay, storage or live-migration path evidence assessed',4)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Passive Bond / LAG health</h3><p class="text-muted text-sm">Normalized member/link/LACP/counter evidence. Link-up alone never implies active forwarding, and zero traffic is not labeled balanced.</p></div></div><table class="data-table"><thead><tr><th>Source / observed</th><th>State / coverage</th><th>Bonds / members</th><th>Imbalance / failover / evidence</th></tr></thead><tbody>${bondObservations.map(item=>`<tr><td><strong>${Utils.escapeHtml(item.source)}</strong><div class="text-xs text-muted">${new Date(item.observedAt).toLocaleString()}</div>${item.providerHostId?`<div class="text-xs">host #${item.providerHostId}</div>`:''}</td><td><span class="badge ${item.summary?.state==='pass'?'badge-success':item.summary?.state==='fail'?'badge-danger':item.summary?.state==='warning'?'badge-warning':'badge-secondary'}">${Utils.escapeHtml(item.summary?.state||'unknown')}</span><div class="text-xs ${item.summary?.evidenceExpired?'text-danger':'text-muted'}">${item.summary?.coverageComplete?'complete':'incomplete'} · ${item.summary?.evidenceExpired?'expired':'current'}</div><div class="text-xs">${item.summary?.fail||0} fail · ${item.summary?.warning||0} warning · ${item.summary?.unknown||0} unknown</div></td><td>${item.summary?.bonds||0} bonds<div class="text-xs text-muted">${item.summary?.activeMembers||0} / ${item.summary?.members||0} active members</div><div class="text-xs">${item.summary?.lacpPartnerMismatch||0} LACP mismatch</div></td><td>${item.summary?.imbalanced||0} imbalanced<div class="text-xs text-muted">${item.summary?.recentFailovers||0} recent failovers</div><div class="mono text-xs">${item.observationHash.slice(0,14)}</div><div class="text-xs text-muted">0 active failovers / 0 mutations</div></td></tr>`).join('')||this._empty('No normalized Bond, team or LAG health evidence',4)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>Load balancer inventory</h3><p class="text-muted text-sm">Imported VIP/listener/pool/member and provider-health evidence only. Canonical links are retained; native refs, raw health payloads and active probes are not accepted.</p></div></div><table class="data-table"><thead><tr><th>Provider / observed</th><th>State / coverage</th><th>VIP / topology</th><th>Member health / evidence</th></tr></thead><tbody>${loadBalancerObservations.map(item=>`<tr><td><strong>${Utils.escapeHtml(item.providerType)}</strong><div class="text-xs">${Utils.escapeHtml(item.source)}</div><div class="text-xs text-muted">${new Date(item.observedAt).toLocaleString()}</div></td><td><span class="badge ${item.summary?.state==='pass'?'badge-success':item.summary?.state==='fail'?'badge-danger':item.summary?.state==='warning'?'badge-warning':'badge-secondary'}">${Utils.escapeHtml(item.summary?.state||'unknown')}</span><div class="text-xs ${item.summary?.evidenceExpired?'text-danger':'text-muted'}">${item.summary?.coverageComplete?'complete':'incomplete'} · ${item.summary?.evidenceExpired?'expired':'current'}</div></td><td>${item.summary?.loadBalancers||0} load balancers<div class="text-xs text-muted">${item.summary?.vips||0} VIPs · ${item.summary?.listeners||0} listeners · ${item.summary?.pools||0} pools</div></td><td>${item.summary?.members||0} members<div class="text-xs text-muted">${item.summary?.healthyMembers||0} healthy · ${item.summary?.unhealthyMembers||0} unhealthy · ${item.summary?.unknownMembers||0} unknown</div><div class="mono text-xs">${item.observationHash.slice(0,14)}</div><div class="text-xs text-muted">0 health probes / 0 mutations</div></td></tr>`).join('')||this._empty('No normalized load-balancer evidence',4)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><div><h3>NAT / public IP lifecycle plans</h3><p class="text-muted text-sm">Hash-bound planning only. Ownership, quota, cost, conflict, version, mappings and dependencies are checked; provider/external apply is not exposed.</p></div></div><table class="data-table"><thead><tr><th>Action / address</th><th>State / blockers</th><th>Owner / quota</th><th>Target / cost / evidence</th></tr></thead><tbody>${publicIpPlans.map(item=>`<tr><td><strong>${Utils.escapeHtml(item.action)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.publicAddress||`${item.addressFamily} · provider allocated`)}</div><div class="text-xs text-muted">${Utils.escapeHtml(item.providerType)} · ${Utils.escapeHtml(item.scopeKey)}</div></td><td><span class="badge ${item.state==='ready'?'badge-success':'badge-danger'}">${Utils.escapeHtml(item.state)}</span><div class="text-xs text-muted">${(item.blockers||[]).map(value=>Utils.escapeHtml(value)).join(', ')||'no blockers'}</div></td><td>${Utils.escapeHtml(item.ownership?.ownerKey||'unknown')}<div class="text-xs text-muted">${Utils.escapeHtml(item.ownership?.tenantKey||'unknown')} · ${item.ownership?.managed?'managed':'external'}</div><div class="text-xs">quota ${item.quota?.used||0}+${item.quota?.requested||0}/${item.quota?.limit||0}</div></td><td>${item.target?`<span class="mono text-xs">${Utils.escapeHtml(item.target.privateAddress)}${item.target.privatePort?`:${item.target.privatePort}`:''}</span><div class="text-xs">${Utils.escapeHtml(item.target.resourceKey)}</div>`:'no mapping target'}<div class="text-xs text-muted">${Utils.escapeHtml(item.cost?.currency||'')} ${(Number(item.cost?.hourlyMicros||0)/1000000).toFixed(6)}/hour</div><div class="mono text-xs">${item.planHash.slice(0,14)}</div><div class="text-xs text-muted">0 apply / 0 mutations</div></td></tr>`).join('')||this._empty('No public-IP lifecycle plans',4)}</tbody></table></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Advanced network ledger</h3></div><table class="data-table"><thead><tr><th>Artifact</th><th>Records</th><th>Boundary</th></tr></thead><tbody>${Object.entries(data.summary||{}).map(([kind,count])=>`<tr><td><strong>${Utils.escapeHtml(kind)}</strong></td><td>${count}</td><td><span class="badge badge-success">bounded / hash-bound / audited</span><div class="text-xs text-muted">existing guarded executor or separately approved adapter only</div></td></tr>`).join('')||this._empty('No advanced network records',3)}</tbody></table></div>`;
  },

  async _networkIntentDialog() {
    const sample = { scopeKey: 'site:primary', intentVersion: '2026-07-30.1', inventoryComplete: true,
      requirements: { requireGateway: true, requireDns: true, requireVlan: true, requireVni: true },
      networks: [{ networkKey: 'network:production', fabricKey: 'fabric:primary', l2DomainKey: 'l2:production',
        cidrs: ['10.20.0.0/24', '2001:db8:20::/64'], gateways: ['10.20.0.1', '2001:db8:20::1'],
        dnsServers: ['10.20.0.53', '2001:db8:20::53'], vlanId: 120, vni: 50120,
        routes: [{ destination: '0.0.0.0/0', nextHop: '10.20.0.1', metric: 100 },
          { destination: '::/0', nextHop: '2001:db8:20::1', metric: 100 }],
        evidence: { source: 'provider:inventory', observedAt: new Date().toISOString(), complete: true, fresh: true } }],
      reservedCidrs: [{ cidr: '10.30.0.0/16', ownerKey: 'network:disaster-recovery', purpose: 'DR reservation' }] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Validation is local and immutable. Missing inventory/evidence produces unknown; this action cannot modify a provider or send traffic.</div><label for="gc-network-intent-json" class="form-label">Normalized network intent JSON</label><textarea id="gc-network-intent-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea>`,
      { title: 'Validate network intent', width: '980px', onSubmit: root => Api.validateNetworkIntent(JSON.parse(root.querySelector('#gc-network-intent-json').value)) });
    if (result) { Toast.success(`Network intent verdict: ${result.result?.verdict || result.verdict}`); await this.render(this._container); }
  },

  async _buildNetworkDependencyMap() {
    try {
      const response = await Api.buildNetworkDependencyMap({ scopeKey: 'global', freshnessHours: 24, maxEdges: 5000, includeDenied: false });
      const snapshot = response.result || response;
      Toast.success(`Dependency map: ${snapshot.summary?.nodes || 0} nodes, ${snapshot.summary?.edges || 0} edges${snapshot.duplicate ? ' (unchanged)' : ''}`);
      await this.render(this._container);
    } catch (error) { Toast.error(error.message); }
  },

  async _showNetworkDependencyImpact(snapshotId, resourceKey) {
    try {
      const result = await Api.getNetworkDependencyImpact(snapshotId, resourceKey, 5);
      const rows = (items, direction) => items.map(item => `<tr><td>${item.depth}</td><td><strong class="mono">${Utils.escapeHtml(item.resource?.id||'unknown')}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.resource?.displayName||item.resource?.kind||'')}</div></td><td class="text-xs">${Utils.escapeHtml(direction)} · ${(item.path||[]).flatMap(step=>step.relationships||[]).map(value=>Utils.escapeHtml(value)).join(' → ')}</td></tr>`).join('');
      const candidates = (result.observedCandidates||[]).map(edge => `<tr><td class="mono">${Utils.escapeHtml(edge.source)}</td><td class="mono">${Utils.escapeHtml(edge.target)}</td><td>${Math.round(Number(edge.confidence||0)*100)}% · ${Utils.escapeHtml(edge.freshness||'unknown')}</td></tr>`).join('');
      Modal.open(`<div class="modal-header"><h3>Dependency impact · ${Utils.escapeHtml(resourceKey)}</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><div class="alert alert-info text-sm">Declared edges only; traversal depth is capped at ${result.maxDepth}. Observed flow candidates are shown separately and excluded from impact.</div><h4>Upstream dependencies</h4><table class="data-table"><thead><tr><th>Depth</th><th>Resource</th><th>Path</th></tr></thead><tbody>${rows(result.upstream||[],'requires')||this._empty('No declared upstream dependencies',3)}</tbody></table><h4 style="margin-top:18px">Downstream impact</h4><table class="data-table"><thead><tr><th>Depth</th><th>Resource</th><th>Path</th></tr></thead><tbody>${rows(result.downstream||[],'impacts')||this._empty('No declared downstream impact',3)}</tbody></table><h4 style="margin-top:18px">Observed candidates (non-causal)</h4><table class="data-table"><thead><tr><th>Possible upstream</th><th>Possible downstream</th><th>Evidence</th></tr></thead><tbody>${candidates||this._empty('No adjacent observed candidates',3)}</tbody></table></div>`, { width: '1050px' });
      Modal._content.querySelector('#gc-close')?.addEventListener('click', () => Modal.close());
    } catch (error) { Toast.error(error.message); }
  },

  async _networkReachabilityDialog() {
    const now = new Date().toISOString(); const evidenceHash = '0'.repeat(64);
    const signal = state => ({ state, source: 'provider:normalized-export', evidenceHash, observedAt: now });
    const sample = { scopeKey: 'site:primary', mode: 'simulation', observedAt: now, freshnessMinutes: 60,
      source: { resourceKey: 'vm:web', address: '10.20.0.10', networkKey: 'network:frontend' },
      destination: { resourceKey: 'vm:api', address: '10.20.0.20', networkKey: 'network:backend' },
      protocol: 'tcp', destinationPort: 443, evidence: {
        route: signal('pass'), policy: signal('allow'), attachment: signal('present'),
        providerSimulation: signal('not_available'),
      } };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Simulation only: this action sends no packets and starts no provider task. A pass is a control-plane prediction, not a data-plane proof. Active probes are not run until an allowlisted runner, source ownership and destination policy are approved.</div><label for="gc-network-reachability-json" class="form-label">Normalized reachability evidence JSON</label><textarea id="gc-network-reachability-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(sample,null,2))}</textarea>`,
      { title: 'Simulate network reachability', width: '980px', onSubmit: root => Api.assessNetworkReachability(JSON.parse(root.querySelector('#gc-network-reachability-json').value)) });
    if (result) { const assessment=result.result||result; Toast.success(`Reachability: ${assessment.verdict||'unknown'} · ${assessment.summary?.interpretation||'insufficient evidence'}`); await this.render(this._container); }
  },

  async _networkMtuDialog() {
    const sample = { source: 'provider:normalized-export', providerHostId: null,
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString(),
      coverage: { complete: true, reason: 'all declared path segments observed' }, paths: [{
        pathKey: 'path:overlay-prod', purpose: 'overlay', sourceKey: 'vm:web', targetKey: 'vm:api',
        requiredPayloadMtu: 1500, requiresDf: true, dfState: 'preserved', segments: [
          { segmentKey: 'overlay:prod', kind: 'overlay', mtu: 1500, encapsulationOverheadBytes: 0, evidenceRef: 'network-posture:overlay-prod' },
          { segmentKey: 'underlay:prod', kind: 'underlay', mtu: 1550, encapsulationOverheadBytes: 50, evidenceRef: 'network-posture:underlay-prod' },
        ],
      }] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Passive analysis only. Supply ordered, normalized evidence; this action sends no traffic and does not change MTU or DF policy.</div><label for="gc-network-mtu-json" class="form-label">Normalized MTU path evidence JSON</label><textarea id="gc-network-mtu-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(sample,null,2))}</textarea>`,
      { title: 'Assess MTU path evidence', width: '980px', onSubmit: root => Api.assessNetworkMtu(JSON.parse(root.querySelector('#gc-network-mtu-json').value)) });
    if (result) { const assessment=result.result||result; Toast.success(`MTU assessment: ${assessment.summary?.state||'unknown'} · ${assessment.summary?.bottlenecks||0} bottlenecks`); await this.render(this._container); }
  },

  async _networkBondDialog() {
    const sample = { source: 'provider:bond-export', providerHostId: null,
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
      coverage: { complete: true, reason: 'all configured bond members observed' }, bonds: [{
        bondKey: 'bond:management', hostKey: 'host:primary', mode: 'active_backup', minActiveMembers: 1,
        intervalSeconds: 300, imbalanceThresholdPercent: 40,
        failover: { count: 0, lastAt: null, lastReason: null }, members: [
          { memberKey: 'nic:primary', adminState: 'up', linkState: 'up', role: 'active', speedMbps: 10000, duplex: 'full', lacpPartnerKey: null, rxBytesDelta: 1048576, txBytesDelta: 524288, errorDelta: 0, dropDelta: 0, flapCount: 0 },
          { memberKey: 'nic:standby', adminState: 'up', linkState: 'up', role: 'standby', speedMbps: 10000, duplex: 'full', lacpPartnerKey: null, rxBytesDelta: 0, txBytesDelta: 0, errorDelta: 0, dropDelta: 0, flapCount: 0 },
        ],
      }] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Passive evidence only. This action does not query or toggle a link, reconfigure a bond, or start failover.</div><label for="gc-network-bond-json" class="form-label">Normalized Bond/LAG health JSON</label><textarea id="gc-network-bond-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(sample,null,2))}</textarea>`,
      { title: 'Record Bond / LAG health', width: '980px', onSubmit: root => Api.recordNetworkBondHealth(JSON.parse(root.querySelector('#gc-network-bond-json').value)) });
    if (result) { const observation=result.result||result; Toast.success(`Bond/LAG health: ${observation.summary?.state||'unknown'} · ${observation.summary?.bonds||0} bonds`); await this.render(this._container); }
  },

  async _networkLoadBalancerDialog() {
    const sample = { source: 'provider:load-balancer-export', providerHostId: null, providerType: 'openstack',
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
      coverage: { complete: true, reason: 'all tenant load balancers observed' }, loadBalancers: [{
        loadBalancerKey: 'lb:frontend', name: 'Frontend', scopeKey: 'tenant:production', providerState: 'active',
        vipAddresses: ['10.20.0.5'], networkKeys: ['network:frontend'], resourceKeys: ['vm:web-a'],
        listeners: [{ listenerKey: 'listener:https', protocol: 'https', port: 443, defaultPoolKey: 'pool:web', tlsState: 'valid' }],
        pools: [{ poolKey: 'pool:web', protocol: 'https', algorithm: 'least_connections', members: [
          { memberKey: 'member:web-a', resourceKey: 'vm:web-a', address: '10.20.1.10', port: 8443, adminState: 'enabled', health: 'healthy', weight: 100 },
        ] }],
      }] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Imported evidence only. No provider call, active health probe, listener/pool/member or VIP mutation is started.</div><label for="gc-network-lb-json" class="form-label">Normalized load-balancer inventory JSON</label><textarea id="gc-network-lb-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(sample,null,2))}</textarea>`,
      { title: 'Record load balancer inventory', width: '980px', onSubmit: root => Api.recordNetworkLoadBalancerInventory(JSON.parse(root.querySelector('#gc-network-lb-json').value)) });
    if (result) { const observation=result.result||result; Toast.success(`Load balancers: ${observation.summary?.loadBalancers||0} · ${observation.summary?.state||'unknown'}`); await this.render(this._container); }
  },

  async _networkPublicIpDialog() {
    const evidenceHash = '0'.repeat(64); const sample = { scopeKey: 'tenant:production', providerType: 'openstack',
      action: 'allocate', addressFamily: 'ipv4', publicAddress: null, target: null,
      ownership: { tenantKey: 'tenant:production', ownerKey: 'team:platform', ownershipToken: 'ownership:public-ip-1', managed: true },
      quota: { limit: 10, used: 3, requested: 1 }, cost: { currency: 'EUR', hourlyMicros: 5000,
        source: 'rate-card:network', observedAt: new Date().toISOString() }, conflictState: 'clear',
      allocationState: 'absent', expectedVersion: null, mappingCount: 0, dependentResourceKeys: [],
      capability: { supported: true, reason: 'signed adapter capability evidence' },
      checks: [{ name: 'quota', state: 'pass', evidenceHash }, { name: 'conflict', state: 'pass', evidenceHash }] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Planning only. This action does not allocate, map, unmap or release an address and exposes no apply endpoint.</div><label for="gc-network-public-ip-json" class="form-label">Public-IP lifecycle plan JSON</label><textarea id="gc-network-public-ip-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(sample,null,2))}</textarea>`,
      { title: 'Plan NAT / public IP lifecycle', width: '980px', onSubmit: root => Api.planNetworkPublicIp(JSON.parse(root.querySelector('#gc-network-public-ip-json').value)) });
    if (result) { const plan=result.result||result; Toast.success(`Public IP ${plan.action}: ${plan.state}`); await this.render(this._container); }
  },

  _hardware() {
    const data = this._data.hardwarePerformance || { capabilities: {}, safety: {}, snapshots: [], policies: [] };
    const devices = this._data.hardwareDevices || { capabilities: {}, safety: {}, snapshots: [], allocations: [], metrics: [], reservations: [] };
    const advanced = this._data.hardwareAdvanced || { capabilities: {}, safety: {}, scans: [], benchmarks: [], regressions: [], profiles: [] };
    const workloads = (data.snapshots || []).flatMap(host => (host.hardware?.vms || []).map(vm => ({ ...vm, hostId: host.hostId, hostRef: host.hostRef })));
    const capabilityLabels = {
      hostHardwareInventory: 'Host inventory', hardwareCompatibilityTags: 'Compatibility tags', cpuFeatureBaseline: 'CPU baseline',
      cpuCompatibilityPolicyEditor: 'CPU policy editor', numaTopology: 'NUMA topology', vmNumaFit: 'VM NUMA fit',
      cpuPinningInventory: 'CPU pinning', realtimeWorkloadProfile: 'Real-time profile', hugepageCapacity: 'Hugepages', memoryOvercommit: 'Memory overcommit',
    };
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-advanced-scan"><i class="fas fa-list-check"></i> VM compatibility</button>
      <button class="btn btn-secondary btn-sm" id="gc-advanced-benchmark"><i class="fas fa-gauge-high"></i> Benchmark</button>
      <button class="btn btn-secondary btn-sm" id="gc-advanced-sample"><i class="fas fa-wave-square"></i> Workload sample</button>
      <button class="btn btn-secondary btn-sm" id="gc-advanced-regression"><i class="fas fa-arrow-trend-down"></i> Regression</button>
      <button class="btn btn-secondary btn-sm" id="gc-advanced-profile"><i class="fas fa-bullseye"></i> Performance profile</button>
      <button class="btn btn-secondary btn-sm" id="gc-device-allocation"><i class="fas fa-plug-circle-check"></i> Device allocation plan</button>
      <button class="btn btn-secondary btn-sm" id="gc-device-metrics"><i class="fas fa-chart-line"></i> GPU metrics</button>
      <button class="btn btn-secondary btn-sm" id="gc-device-reservation"><i class="fas fa-calendar-check"></i> Accelerator reservation</button>
      <button class="btn btn-secondary btn-sm" id="gc-device-snapshot"><i class="fas fa-file-circle-plus"></i> Device snapshot</button>
      <button class="btn btn-secondary btn-sm" id="gc-hardware-cluster"><i class="fas fa-table-cells"></i> Cluster analysis</button>
      <button class="btn btn-secondary btn-sm" id="gc-hardware-policy"><i class="fas fa-sliders"></i> CPU compatibility policy</button>
      <button class="btn btn-primary btn-sm" id="gc-hardware-snapshot"><i class="fas fa-file-import"></i> Record snapshot</button>`) }
      <div class="info-grid">
        ${this._stat('fa-server', 'Observed hosts', data.snapshots.length)}
        ${this._stat('fa-diagram-project', 'Clusters', new Set(data.snapshots.map(item => item.clusterRef)).size)}
        ${this._stat('fa-desktop', 'Placed workloads', workloads.length)}
        ${this._stat('fa-sliders', 'CPU policies', data.policies.length)}
      </div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Hardware evidence boundary</h3><p class="text-muted text-sm">Normalized provider/API/SSH/import evidence only. CPU policy edits create a hash-bound desired plan; this surface exposes no BIOS, EVC, pinning, hugepage or memory apply endpoint.</p></div></div>
        <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries(capabilityLabels).map(([key,label]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}
          <span class="badge badge-success"><i class="fas fa-shield" style="margin-right:4px"></i>${data.safety?.providerMutationsStarted || 0} provider mutations</span></div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Latest normalized host inventory</h3></div>
        <table class="data-table"><thead><tr><th>Host / cluster</th><th>CPU / NUMA</th><th>Memory</th><th>NIC/HBA/disk/GPU</th><th>Compatibility</th><th>Analysis</th></tr></thead><tbody>
        ${(data.snapshots || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.hostRef)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.providerType)} · ${Utils.escapeHtml(item.clusterRef)}</div><div class="mono text-xs">${item.evidenceHash.slice(0, 12)}</div></td>
          <td>${Utils.escapeHtml(item.hardware.cpu.vendor)} ${Utils.escapeHtml(item.hardware.cpu.model)}<div class="text-xs text-muted">${item.hardware.cpu.sockets} sockets · ${item.hardware.cpu.cores} cores · ${item.summary.numaNodes} NUMA</div></td>
          <td>${Utils.formatBytes(item.hardware.memory.totalBytes)}<div class="text-xs text-muted">active ${Utils.formatBytes(item.hardware.memory.activeBytes)} · reserved ${Utils.formatBytes(item.hardware.memory.reservedBytes)}</div></td>
          <td>${item.summary.nics}/${item.summary.hbas}/${item.summary.disks}/${item.summary.gpus}<div class="text-xs text-muted">${item.summary.vms} workloads</div></td>
          <td>${item.compatibilityTags.slice(0, 4).map(value => `<span class="badge badge-secondary mono">${Utils.escapeHtml(value)}</span>`).join(' ')}</td>
          <td><button class="action-btn" data-gc-hw-numa="${item.hostId}" title="NUMA topology"><i class="fas fa-diagram-project"></i></button><button class="action-btn" data-gc-hw-huge="${item.hostId}" title="Hugepage capacity"><i class="fas fa-table-cells-large"></i></button><button class="action-btn" data-gc-hw-memory="${item.hostId}" title="Memory overcommit"><i class="fas fa-memory"></i></button></td></tr>`).join('') || this._empty('No hardware observations. Record a bounded provider snapshot to begin.', 6)}</tbody></table></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>CPU compatibility policies</h3></div><table class="data-table"><thead><tr><th>Cluster</th><th>Mode / adapter</th><th>Baseline</th><th>State</th></tr></thead><tbody>${(data.policies || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.clusterRef)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.providerType)}</div></td><td>${Utils.escapeHtml(item.mode)}<div class="mono text-xs">${Utils.escapeHtml(item.changePlan.adapter)} · ${item.adapterState}</div></td><td>${item.baselineFeatures.length} features<div class="mono text-xs">${item.planHash.slice(0, 12)}</div></td><td><span class="badge ${item.state === 'ready' ? 'badge-success' : 'badge-danger'}">${item.state}</span><div class="text-xs text-muted">${item.blockers.length} blockers · no apply</div></td></tr>`).join('') || this._empty('No desired CPU compatibility policies', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Workload placement evidence</h3></div><table class="data-table"><thead><tr><th>Workload / host</th><th>CPU</th><th>Memory / hugepages</th><th>Checks</th></tr></thead><tbody>${workloads.map(vm => `<tr><td><strong>${Utils.escapeHtml(vm.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(vm.resourceKey)} · ${Utils.escapeHtml(vm.hostRef)}</div></td><td>${vm.vcpus} vCPU · ${vm.cpuPinning.length} pinned<div class="text-xs text-muted">${vm.dedicatedCpu ? 'dedicated' : 'shared'} · ${vm.latencySensitivity}</div></td><td>${Utils.formatBytes(vm.memoryBytes)}<div class="text-xs text-muted">${vm.hugepageSizeKb ? `${vm.hugepageSizeKb} KiB pages` : 'regular pages'} · balloon ${Utils.formatBytes(vm.balloonBytes)}</div></td><td><button class="action-btn" data-gc-hw-fit="${Utils.escapeHtml(vm.resourceKey)}" data-host-id="${vm.hostId}" title="NUMA fit"><i class="fas fa-puzzle-piece"></i></button><button class="action-btn" data-gc-hw-rt="${Utils.escapeHtml(vm.resourceKey)}" data-host-id="${vm.hostId}" title="Real-time profile"><i class="fas fa-stopwatch"></i></button></td></tr>`).join('') || this._empty('No workload placement evidence', 4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Devices &amp; accelerators evidence boundary</h3><p class="text-muted text-sm">PCI, SR-IOV, GPU/vGPU and USB observations are bounded and credential-free. Allocation and reservation actions persist conflict-checked control-plane plans only; provider attach/detach is deliberately unavailable.</p></div></div>
        <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries({ memoryTiering:'Memory tiering', pciInventory:'PCI inventory', pciPassthroughPlan:'PCI passthrough plan', sriovVfAllocator:'SR-IOV VF allocator', gpuInventory:'GPU inventory', gpuPassthroughPlan:'GPU plan', vgpuProfileAllocator:'vGPU profiles', gpuMetrics:'GPU metrics', acceleratorReservations:'Reservations', usbInventory:'USB inventory' }).map(([key,label]) => `<span class="badge ${devices.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}
          <span class="badge badge-success"><i class="fas fa-shield" style="margin-right:4px"></i>${devices.safety?.providerMutationsStarted || 0} provider mutations</span></div></div>
      <div class="card" style="margin-top:12px;overflow:auto"><div class="card-header"><h3>Latest device inventory</h3></div><table class="data-table"><thead><tr><th>Host / evidence</th><th>Memory tiers</th><th>PCI / VF</th><th>GPU / profiles</th><th>USB</th><th>Inspect</th></tr></thead><tbody>${(devices.snapshots || []).map(item => { const inventory = item.inventory || {}; const vfs = (inventory.pciDevices || []).filter(device => device.kind === 'vf').length; const profiles = (inventory.gpus || []).reduce((sum, gpu) => sum + (gpu.profiles || []).length, 0); return `<tr><td><strong>Host #${item.hostId}</strong><div class="mono text-xs">${item.evidenceHash.slice(0, 12)}</div><div class="text-xs text-muted">${new Date(item.observedAt).toLocaleString()}</div></td><td>${(inventory.memoryTiers || []).length}</td><td>${(inventory.pciDevices || []).length}<div class="text-xs text-muted">${vfs} virtual functions</div></td><td>${(inventory.gpus || []).length}<div class="text-xs text-muted">${profiles} profiles</div></td><td>${(inventory.usbDevices || []).length}</td><td>${['memory','pci','gpus','usb'].map(kind => `<button class="action-btn" data-gc-device-${kind}="${item.hostId}" title="${kind}"><i class="fas ${kind === 'memory' ? 'fa-layer-group' : kind === 'pci' ? 'fa-microchip' : kind === 'gpus' ? 'fa-display' : 'fa-usb'}"></i></button>`).join('')}</td></tr>`; }).join('') || this._empty('No device snapshots recorded', 6)}</tbody></table></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Device allocation plans</h3></div><table class="data-table"><thead><tr><th>Device / profile</th><th>Target</th><th>State</th><th></th></tr></thead><tbody>${(devices.allocations || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.deviceRef)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.kind)}${item.profileName ? ` · ${Utils.escapeHtml(item.profileName)}` : ''}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.targetResourceKey)}</td><td><span class="badge ${item.state === 'planned' ? 'badge-warning' : 'badge-secondary'}">${item.state}</span><div class="mono text-xs">${item.planHash.slice(0, 12)} · no apply</div></td><td>${item.state === 'planned' ? `<button class="action-btn danger" data-gc-device-release="${item.id}" title="Release control-plane plan"><i class="fas fa-xmark"></i></button>` : ''}</td></tr>`).join('') || this._empty('No allocation plans', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Accelerator reservations</h3></div><table class="data-table"><thead><tr><th>Device / tenant</th><th>Window</th><th>Purpose</th></tr></thead><tbody>${(devices.reservations || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.deviceRef)}</strong><div class="text-xs text-muted">${item.profileName ? Utils.escapeHtml(item.profileName) : 'full device'} · tenant #${item.tenantId}</div></td><td>${new Date(item.startsAt).toLocaleString()}<div class="text-xs text-muted">→ ${new Date(item.endsAt).toLocaleString()}</div></td><td>${Utils.escapeHtml(item.purpose)}<div class="text-xs text-muted">reservation only · no provider mutation</div></td></tr>`).join('') || this._empty('No active reservations', 3)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Latest accelerator telemetry</h3></div><table class="data-table"><thead><tr><th>GPU / resource</th><th>Utilization</th><th>Health</th></tr></thead><tbody>${(devices.metrics || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.deviceRef)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.resourceKey || 'unassigned')}</div></td><td>SM ${item.metrics.smPercent}% · memory ${item.metrics.memoryPercent}%<div class="text-xs text-muted">encoder ${item.metrics.encoderPercent}%</div></td><td>${item.metrics.eccErrors} ECC<div class="text-xs text-muted">${(item.metrics.throttleReasons || []).map(Utils.escapeHtml).join(', ') || 'no throttle reason'}</div></td></tr>`).join('') || this._empty('No accelerator metrics', 3)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Compatibility &amp; performance evidence</h3><p class="text-muted text-sm">Controlled baselines, colocated-workload correlation and before/after comparisons are advisory. Profiles define desired thresholds only; no migration, placement or configuration is started.</p></div></div><div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${Object.entries({ virtualHardwareCompatibility:'VM compatibility', benchmarkRegistry:'Benchmark registry', noisyNeighborCorrelation:'Noisy-neighbor correlation', performanceRegression:'Regression detection', workloadPerformanceProfiles:'Workload profiles' }).map(([key,label]) => `<span class="badge ${advanced.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-shield" style="margin-right:4px"></i>${advanced.safety?.providerMutationsStarted || 0} provider mutations</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Virtual hardware scans</h3></div><table class="data-table"><thead><tr><th>Workload / target</th><th>Checks</th><th>State</th></tr></thead><tbody>${(advanced.scans || []).map(item => `<tr><td><strong class="mono">${Utils.escapeHtml(item.resourceKey)}</strong><div class="text-xs text-muted">host #${item.sourceHostId} → #${item.targetHostId} · ${Utils.escapeHtml(item.targetProviderVersion)}</div></td><td>${item.checks.filter(check => check.state === 'pass').length}/${item.checks.length} pass</td><td><span class="badge ${item.state === 'compatible' ? 'badge-success' : item.state === 'warning' ? 'badge-warning' : 'badge-danger'}">${item.state}</span><div class="mono text-xs">${item.evidenceHash.slice(0, 12)} · no apply</div></td></tr>`).join('') || this._empty('No compatibility scans', 3)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Controlled benchmarks</h3></div><table class="data-table"><thead><tr><th>Suite / metric</th><th>Score</th><th>Hardware evidence</th></tr></thead><tbody>${(advanced.benchmarks || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.suite)} ${Utils.escapeHtml(item.suiteVersion)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.metric)} · ${item.direction} is better</div></td><td>${item.score} ${Utils.escapeHtml(item.unit)}</td><td>${Utils.escapeHtml(item.hardware.model)}<div class="mono text-xs">${item.evidenceHash.slice(0, 12)}</div></td></tr>`).join('') || this._empty('No controlled baselines', 3)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Regression assessments</h3></div><table class="data-table"><thead><tr><th>Change</th><th>Delta / regression</th><th>State</th></tr></thead><tbody>${(advanced.regressions || []).map(item => `<tr><td><strong class="mono">${Utils.escapeHtml(item.changeRef)}</strong><div class="text-xs text-muted">#${item.baselineBenchmarkId} → #${item.candidateBenchmarkId}</div></td><td>${item.deltaPercent}%<div class="text-xs text-muted">regression ${item.regressionPercent}% · threshold ${item.thresholdPercent}%</div></td><td><span class="badge ${item.state === 'pass' ? 'badge-success' : item.state === 'warning' ? 'badge-warning' : 'badge-danger'}">${item.state}</span></td></tr>`).join('') || this._empty('No before/after assessments', 3)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Workload performance profiles</h3></div><table class="data-table"><thead><tr><th>Workload</th><th>Preset</th><th>Evaluation</th></tr></thead><tbody>${(advanced.profiles || []).map(item => `<tr><td><strong class="mono">${Utils.escapeHtml(item.resourceKey)}</strong><div class="mono text-xs">${item.profileHash.slice(0, 12)}</div></td><td>${Utils.escapeHtml(item.preset)}<div class="text-xs text-muted">${Object.keys(item.thresholds).length} thresholds · desired only</div></td><td><button class="action-btn" data-gc-advanced-evaluate="${Utils.escapeHtml(item.resourceKey)}" title="Evaluate latest sample"><i class="fas fa-clipboard-check"></i></button><button class="action-btn" data-gc-advanced-neighbors="${Utils.escapeHtml(item.resourceKey)}" title="Correlate noisy neighbors"><i class="fas fa-people-arrows"></i></button></td></tr>`).join('') || this._empty('No workload profiles', 3)}</tbody></table></div>
      </div>`;
  },

  async _hardwareSnapshotDialog() {
    const sample = { hostId: 1, providerType: 'proxmox', clusterRef: 'cluster-a', hostRef: 'pve-a', model: 'Dell R760', generation: '16g',
      observedAt: new Date().toISOString(), source: { kind: 'api', adapter: 'proxmox.nodes', version: '8.x', coverage: ['cpu','numa','memory'] },
      cpu: { vendor: 'Intel', model: 'Xeon', sockets: 2, cores: 64, threads: 128, features: ['aes','avx2'], isolatedCpuIds: [0,1] },
      memory: { totalBytes: 274877906944, reservedBytes: 17179869184, activeBytes: 68719476736, balloonBytes: 0, swapUsedBytes: 0 },
      numaNodes: [{ id: 0, cpuIds: [0,1], memoryBytes: 137438953472, freeMemoryBytes: 68719476736, hugepages: [{ sizeKb: 2048, total: 1024, free: 900, reserved: 24 }] }],
      nics: [], hbas: [], disks: [], gpus: [], bmc: { vendor: 'Dell', model: 'iDRAC9', firmware: '7.x' }, vms: [] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Only bounded, credential-free observations are accepted. BMC network endpoints and raw provider payloads are intentionally excluded.</div><label for="gc-hw-json" class="form-label">Normalized snapshot JSON</label><textarea id="gc-hw-json" class="form-control mono" rows="20">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea>`,
      { title: 'Record hardware observation', width: '920px', onSubmit: c => this._submit(() => Api.recordHardwareSnapshot(JSON.parse(c.querySelector('#gc-hw-json').value))) });
    if (result) { Toast.success(result.duplicate ? 'Existing evidence reused' : 'Hardware snapshot recorded'); await this.render(this._container); }
  },
  _hardwareClusterOptions() { return [...new Set((this._data.hardwarePerformance?.snapshots || []).map(item => item.clusterRef))].map(value => `<option value="${Utils.escapeHtml(value)}">`).join(''); },
  async _hardwareClusterDialog() {
    const clusterRef = await Modal.form(`<label for="gc-hw-cluster" class="form-label">Cluster reference</label><input id="gc-hw-cluster" list="gc-hw-clusters" class="form-control"><datalist id="gc-hw-clusters">${this._hardwareClusterOptions()}</datalist>`,
      { title: 'Compatibility, CPU baseline and pinning', confirmText: 'Analyze', onSubmit: c => c.querySelector('#gc-hw-cluster').value.trim() });
    if (!clusterRef) return;
    try { const [compatibility, cpu, pinning] = await Promise.all([Api.getHardwareCompatibility(clusterRef), Api.getHardwareCpuBaseline(clusterRef), Api.getHardwareCpuPinning(clusterRef)]); this._showHardwareResult(`Cluster ${clusterRef}`, { compatibility, cpu, pinning }); } catch (error) { Toast.error(error.message); }
  },
  async _hardwarePolicyDialog() {
    const result = await Modal.form(`<label for="gc-hw-cluster" class="form-label">Cluster reference</label><input id="gc-hw-cluster" list="gc-hw-clusters" class="form-control"><datalist id="gc-hw-clusters">${this._hardwareClusterOptions()}</datalist><label for="gc-hw-mode" class="form-label">Desired mode</label><select id="gc-hw-mode" class="form-control"><option>cluster-baseline</option><option>host-passthrough</option><option>vendor-compatibility</option><option>custom</option></select><label for="gc-hw-features" class="form-label">Baseline features (comma-separated; blank uses cluster common set)</label><textarea id="gc-hw-features" rows="4" class="form-control mono"></textarea><div class="alert alert-warning text-sm" style="margin-top:12px">Save creates a desired plan and blockers only. No provider apply endpoint exists.</div>`,
      { title: 'CPU compatibility policy', width: '760px', onSubmit: c => { const clusterRef = c.querySelector('#gc-hw-cluster').value.trim(); return this._submit(() => Api.saveHardwareCpuPolicy(clusterRef, { mode: c.querySelector('#gc-hw-mode').value, baselineFeatures: c.querySelector('#gc-hw-features').value.split(',').map(value => value.trim()).filter(Boolean) })); } });
    if (result) { Toast.success(`Policy ${result.policy.state}; no provider mutation started`); await this.render(this._container); }
  },
  _showHardwareResult(title, result) {
    Modal.open(`<div class="modal-header"><h3>${Utils.escapeHtml(title)}</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><div class="alert alert-info text-sm">Evidence/analysis only · no provider mutation</div><pre class="mono text-xs" style="white-space:pre-wrap;max-height:65vh;overflow:auto">${Utils.escapeHtml(JSON.stringify(result, null, 2))}</pre></div>`, { width: '980px' });
    Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
  },
  async _hardwareHostAnalysis(kind, hostId) {
    try { const result = kind === 'numa' ? await Api.getHardwareNuma(hostId) : kind === 'hugepages' ? await Api.getHardwareHugepages(hostId) : await Api.getHardwareMemory(hostId); this._showHardwareResult(`${kind} · host ${hostId}`, result); } catch (error) { Toast.error(error.message); }
  },
  async _hardwareVmAnalysis(kind, resourceKey, hostId) {
    try { const result = kind === 'fit' ? await Api.getHardwareVmNumaFit(resourceKey, hostId) : await Api.getHardwareRealtimeProfile(resourceKey, hostId); this._showHardwareResult(`${kind === 'fit' ? 'NUMA fit' : 'Real-time profile'} · ${resourceKey}`, result); } catch (error) { Toast.error(error.message); }
  },
  async _deviceSnapshotDialog() {
    const sample = { hostId: 1, observedAt: new Date().toISOString(),
      memoryTiers: [{ kind: 'dram', capacityBytes: 274877906944, usedBytes: 68719476736, hitRatePercent: 99.5, workloadImpact: 'primary memory' }],
      pciDevices: [{ id: 'pci-gpu-0', address: '0000:65:00.0', vendor: 'NVIDIA', model: 'L40S', classCode: '0302', iommuGroup: 42, numaNode: 0, resetSupported: true, acsIsolated: true, kind: 'gpu', driver: 'vfio-pci', health: 'healthy' }],
      gpus: [{ id: 'gpu-0', pciRef: 'pci-gpu-0', vendor: 'NVIDIA', model: 'L40S', memoryBytes: 51539607552, driverVersion: '550.90', health: 'healthy', migCapable: true, profiles: [{ name: '1g.12gb', total: 4, available: 2, memoryBytes: 12884901888, licenseState: 'licensed' }] }],
      usbDevices: [{ id: 'usb-1-2', vendorId: '046d', productId: 'c534', vendor: 'Logitech', model: 'Receiver', busPath: '1-2', owner: 'workplace', mobility: 'remappable' }] };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Credential-shaped fields and payloads above 512 KiB are rejected. The snapshot is immutable evidence.</div><label for="gc-device-json" class="form-label">Normalized device snapshot JSON</label><textarea id="gc-device-json" class="form-control mono" rows="22">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea>`,
      { title: 'Record device and accelerator evidence', width: '960px', onSubmit: c => this._submit(() => Api.recordHardwareDeviceSnapshot(JSON.parse(c.querySelector('#gc-device-json').value))) });
    if (result) { Toast.success(result.snapshot.duplicate ? 'Existing device evidence reused' : 'Device snapshot recorded'); await this.render(this._container); }
  },
  async _deviceAllocationDialog() {
    const result = await Modal.form(`<div class="alert alert-warning text-sm">This creates a conflict-checked plan only. It cannot attach, detach or reconfigure a provider device.</div>
      <div class="form-row"><div class="form-group"><label>Host ID</label><input id="gc-da-host" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>Kind</label><select id="gc-da-kind" class="form-control"><option>pci</option><option>sriov_vf</option><option>gpu</option><option>vgpu</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Device reference (blank permits VF auto-selection)</label><input id="gc-da-device" class="form-control mono" value="gpu-0"></div><div class="form-group"><label>vGPU profile (vGPU only)</label><input id="gc-da-profile" class="form-control mono" placeholder="1g.12gb"></div></div>
      <div class="form-row"><div class="form-group"><label>Target resource key</label><input id="gc-da-target" class="form-control mono" value="ddr_vm_example"></div><div class="form-group"><label>Tenant ID (optional)</label><input id="gc-da-tenant" type="number" min="1" class="form-control"></div></div>`,
    { title: 'Plan device allocation', onSubmit: c => this._submit(() => Api.planHardwareDeviceAllocation({ hostId: Number(c.querySelector('#gc-da-host').value), kind: c.querySelector('#gc-da-kind').value, deviceRef: c.querySelector('#gc-da-device').value || undefined, profileName: c.querySelector('#gc-da-profile').value || undefined, targetResourceKey: c.querySelector('#gc-da-target').value, tenantId: c.querySelector('#gc-da-tenant').value ? Number(c.querySelector('#gc-da-tenant').value) : undefined })) });
    if (result) { Toast[result.allocation.state === 'planned' ? 'success' : 'warning'](`${result.allocation.state}: ${result.allocation.blockers.join(', ') || 'no provider mutation started'}`); await this.render(this._container); }
  },
  async _deviceMetricsDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Host ID</label><input id="gc-dm-host" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>GPU reference</label><input id="gc-dm-device" class="form-control mono" value="gpu-0"></div><div class="form-group"><label>Resource key (optional)</label><input id="gc-dm-resource" class="form-control mono"></div></div>
      <div class="form-row"><div class="form-group"><label>SM %</label><input id="gc-dm-sm" type="number" min="0" max="100" value="0" class="form-control"></div><div class="form-group"><label>Memory %</label><input id="gc-dm-memory" type="number" min="0" max="100" value="0" class="form-control"></div><div class="form-group"><label>Encoder %</label><input id="gc-dm-encoder" type="number" min="0" max="100" value="0" class="form-control"></div><div class="form-group"><label>ECC errors</label><input id="gc-dm-ecc" type="number" min="0" value="0" class="form-control"></div></div>
      <label for="gc-dm-throttle" class="form-label">Throttle reasons (comma-separated)</label><input id="gc-dm-throttle" class="form-control" placeholder="thermal, power">`,
    { title: 'Record accelerator metrics', onSubmit: c => this._submit(() => Api.recordHardwareAcceleratorMetrics({ hostId: Number(c.querySelector('#gc-dm-host').value), deviceRef: c.querySelector('#gc-dm-device').value, resourceKey: c.querySelector('#gc-dm-resource').value || undefined, observedAt: new Date().toISOString(), smPercent: Number(c.querySelector('#gc-dm-sm').value), memoryPercent: Number(c.querySelector('#gc-dm-memory').value), encoderPercent: Number(c.querySelector('#gc-dm-encoder').value), eccErrors: Number(c.querySelector('#gc-dm-ecc').value), throttleReasons: c.querySelector('#gc-dm-throttle').value.split(',').map(value => value.trim()).filter(Boolean) })) });
    if (result) { Toast.success(result.metric.duplicate ? 'Existing metric evidence reused' : 'Accelerator metrics recorded'); await this.render(this._container); }
  },
  async _deviceReservationDialog() {
    const starts = new Date(Date.now() + 3600000); const ends = new Date(starts.getTime() + 3600000);
    const result = await Modal.form(`<div class="alert alert-warning text-sm">Reservations are scheduling evidence only and do not reserve capacity in the provider.</div>
      <div class="form-row"><div class="form-group"><label>Host ID</label><input id="gc-dr-host" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>GPU reference</label><input id="gc-dr-device" class="form-control mono" value="gpu-0"></div><div class="form-group"><label>Profile (blank = full GPU)</label><input id="gc-dr-profile" class="form-control mono"></div><div class="form-group"><label>Tenant ID</label><input id="gc-dr-tenant" type="number" min="1" value="1" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Starts</label><input id="gc-dr-start" type="datetime-local" value="${starts.toISOString().slice(0, 16)}" class="form-control"></div><div class="form-group"><label>Ends</label><input id="gc-dr-end" type="datetime-local" value="${ends.toISOString().slice(0, 16)}" class="form-control"></div></div>
      <label for="gc-dr-purpose" class="form-label">Purpose</label><input id="gc-dr-purpose" class="form-control" value="Scheduled accelerator workload">`,
    { title: 'Create accelerator reservation', onSubmit: c => this._submit(() => Api.createHardwareAcceleratorReservation({ hostId: Number(c.querySelector('#gc-dr-host').value), deviceRef: c.querySelector('#gc-dr-device').value, profileName: c.querySelector('#gc-dr-profile').value || undefined, tenantId: Number(c.querySelector('#gc-dr-tenant').value), startsAt: new Date(c.querySelector('#gc-dr-start').value).toISOString(), endsAt: new Date(c.querySelector('#gc-dr-end').value).toISOString(), purpose: c.querySelector('#gc-dr-purpose').value })) });
    if (result) { Toast.success(result.reservation.duplicate ? 'Existing reservation reused' : 'Accelerator reservation created'); await this.render(this._container); }
  },
  async _deviceHostAnalysis(kind, hostId) {
    try { const calls = { memory: Api.getHardwareMemoryTiers, pci: Api.getHardwarePci, gpus: Api.getHardwareGpus, usb: Api.getHardwareUsb }; const result = await calls[kind].call(Api, hostId); this._showHardwareResult(`${kind} · host ${hostId}`, result); } catch (error) { Toast.error(error.message); }
  },
  async _releaseDeviceAllocation(id) {
    if (!await Modal.confirm('Release this control-plane allocation plan? No provider detach is performed.')) return;
    try { await Api.releaseHardwareDeviceAllocation(id); Toast.success('Allocation plan released; infrastructure was not mutated'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },
  async _advancedScanDialog() {
    const result = await Modal.form(`<div class="alert alert-info text-sm">Compares recorded VM evidence with a target host/provider version. The result cannot start migration or placement.</div><div class="form-row"><div class="form-group"><label>Resource key</label><input id="gc-ac-resource" class="form-control mono" value="ddr_vm_example"></div><div class="form-group"><label>Target host ID</label><input id="gc-ac-host" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>Target provider version</label><input id="gc-ac-version" class="form-control" value="8.2.0"></div></div><div class="form-row"><div class="form-group"><label>Minimum provider version (optional)</label><input id="gc-ac-min" class="form-control"></div><div class="form-group"><label>Required CPU features</label><input id="gc-ac-cpu" class="form-control" value="aes,avx2"></div></div>`,
      { title: 'Virtual hardware compatibility scan', onSubmit: c => this._submit(() => Api.scanVirtualHardwareCompatibility({ resourceKey: c.querySelector('#gc-ac-resource').value, targetHostId: Number(c.querySelector('#gc-ac-host').value), targetProviderVersion: c.querySelector('#gc-ac-version').value, minimumProviderVersion: c.querySelector('#gc-ac-min').value || undefined, requiredCpuFeatures: c.querySelector('#gc-ac-cpu').value.split(',').map(value => value.trim()).filter(Boolean) })) });
    if (result) { Toast[result.scan.state === 'compatible' ? 'success' : 'warning'](`Compatibility: ${result.scan.state}; no migration started`); await this.render(this._container); }
  },
  async _advancedBenchmarkDialog() {
    const result = await Modal.form(`<div class="alert alert-info text-sm">Only controlled, reproducible benchmark baselines are accepted. Run configuration must be credential-free.</div><div class="form-row"><div class="form-group"><label>Host ID</label><input id="gc-ab-host" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>Suite / version</label><input id="gc-ab-suite" class="form-control" value="fio"><input id="gc-ab-version" class="form-control" value="3.39"></div><div class="form-group"><label>Metric</label><input id="gc-ab-metric" class="form-control" value="random-read-iops"></div></div><div class="form-row"><div class="form-group"><label>Score</label><input id="gc-ab-score" type="number" min="0" step="any" value="1000" class="form-control"></div><div class="form-group"><label>Unit</label><input id="gc-ab-unit" class="form-control" value="iops"></div><div class="form-group"><label>Direction</label><select id="gc-ab-direction" class="form-control"><option>higher</option><option>lower</option></select></div></div><label for="gc-ab-config" class="form-label">Controlled run config JSON</label><textarea id="gc-ab-config" class="form-control mono" rows="4">{"blockSize":"4k","queueDepth":32}</textarea>`,
      { title: 'Record controlled benchmark', onSubmit: c => this._submit(() => Api.recordHardwareBenchmark({ hostId: Number(c.querySelector('#gc-ab-host').value), suite: c.querySelector('#gc-ab-suite').value, suiteVersion: c.querySelector('#gc-ab-version').value, metric: c.querySelector('#gc-ab-metric').value, score: Number(c.querySelector('#gc-ab-score').value), unit: c.querySelector('#gc-ab-unit').value, direction: c.querySelector('#gc-ab-direction').value, controlled: true, observedAt: new Date().toISOString(), runConfig: JSON.parse(c.querySelector('#gc-ab-config').value) })) });
    if (result) { Toast.success(result.benchmark.duplicate ? 'Existing baseline reused' : 'Controlled benchmark recorded'); await this.render(this._container); }
  },
  async _advancedSampleDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Host ID</label><input id="gc-as-host" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>Resource key</label><input id="gc-as-resource" class="form-control mono" value="ddr_vm_example"></div></div><div class="form-row">${[['cpu','CPU utilization %',0],['ready','CPU ready %',0],['latency','Storage latency ms',0],['queue','Storage queue',0],['memory','Memory pressure %',0],['network','Network latency ms',0],['gpu','GPU SM %','']].map(([id,label,value]) => `<div class="form-group"><label>${label}</label><input id="gc-as-${id}" type="number" min="0" step="any" value="${value}" class="form-control"></div>`).join('')}</div>`,
      { title: 'Record workload performance sample', width: '980px', onSubmit: c => this._submit(() => Api.recordWorkloadPerformanceSample({ hostId: Number(c.querySelector('#gc-as-host').value), resourceKey: c.querySelector('#gc-as-resource').value, observedAt: new Date().toISOString(), cpuUtilizationPercent: Number(c.querySelector('#gc-as-cpu').value), cpuReadyPercent: Number(c.querySelector('#gc-as-ready').value), storageLatencyMs: Number(c.querySelector('#gc-as-latency').value), storageQueueDepth: Number(c.querySelector('#gc-as-queue').value), memoryPressurePercent: Number(c.querySelector('#gc-as-memory').value), networkLatencyMs: Number(c.querySelector('#gc-as-network').value), gpuSmPercent: c.querySelector('#gc-as-gpu').value === '' ? undefined : Number(c.querySelector('#gc-as-gpu').value) })) });
    if (result) { Toast.success(result.sample.duplicate ? 'Existing sample reused' : 'Performance sample recorded'); await this.render(this._container); }
  },
  async _advancedRegressionDialog() {
    const benchmarks = this._data.hardwareAdvanced?.benchmarks || [];
    const options = benchmarks.map(item => `<option value="${item.id}">#${item.id} ${Utils.escapeHtml(item.suite)} · ${Utils.escapeHtml(item.metric)} · ${item.score} ${Utils.escapeHtml(item.unit)}</option>`).join('');
    const result = await Modal.form(`<div class="alert alert-info text-sm">The two baselines must use the same suite, metric, unit and direction. This stores an advisory before/after assessment only.</div><div class="form-row"><div class="form-group"><label>Baseline</label><select id="gc-ar-base" class="form-control">${options}</select></div><div class="form-group"><label>Candidate</label><select id="gc-ar-candidate" class="form-control">${options}</select></div></div><div class="form-row"><div class="form-group"><label>Change reference</label><input id="gc-ar-change" class="form-control mono" value="migration:change-1"></div><div class="form-group"><label>Regression threshold %</label><input id="gc-ar-threshold" type="number" min="0.1" max="100" value="5" class="form-control"></div></div>`,
      { title: 'Compare performance before/after change', onSubmit: c => this._submit(() => Api.compareHardwareBenchmarks({ baselineBenchmarkId: Number(c.querySelector('#gc-ar-base').value), candidateBenchmarkId: Number(c.querySelector('#gc-ar-candidate').value), changeRef: c.querySelector('#gc-ar-change').value, thresholdPercent: Number(c.querySelector('#gc-ar-threshold').value) })) });
    if (result) { Toast[result.assessment.state === 'pass' ? 'success' : 'warning'](`Assessment: ${result.assessment.state}, regression ${result.assessment.regressionPercent}%`); await this.render(this._container); }
  },
  async _advancedProfileDialog() {
    const result = await Modal.form(`<div class="alert alert-warning text-sm">Presets create desired thresholds only and never reconfigure a workload.</div><div class="form-row"><div class="form-group"><label>Resource key</label><input id="gc-ap-resource" class="form-control mono" value="ddr_vm_example"></div><div class="form-group"><label>Preset</label><select id="gc-ap-preset" class="form-control"><option>batch</option><option>database</option><option>vdi</option><option>latency</option><option>ai</option></select></div></div><label for="gc-ap-overrides" class="form-label">Threshold overrides JSON</label><textarea id="gc-ap-overrides" class="form-control mono" rows="4">{}</textarea>`,
      { title: 'Workload performance profile', onSubmit: c => this._submit(() => Api.saveWorkloadPerformanceProfile(c.querySelector('#gc-ap-resource').value, { preset: c.querySelector('#gc-ap-preset').value, overrides: JSON.parse(c.querySelector('#gc-ap-overrides').value) })) });
    if (result) { Toast.success('Desired performance profile saved; no provider mutation started'); await this.render(this._container); }
  },
  async _advancedAnalyze(kind, resourceKey) { try { const result = kind === 'evaluate' ? await Api.evaluateWorkloadPerformanceProfile(resourceKey) : await Api.getNoisyNeighbors(resourceKey); this._showHardwareResult(`${kind} · ${resourceKey}`, result); } catch (error) { Toast.error(error.message); } },
  async _pluginRegisterDialog() {
    const sample = { schemaVersion: '1.0', pluginKey: 'example-provider', name: 'Example provider', version: '1.0.0', apiVersion: '1.0', minCoreVersion: '8.0.0', maxCoreVersion: '9.0.0', permissions: ['inventory.read'], capabilities: ['inventory.vm'], entrypoint: { kind: 'declarative-rpc', protocol: 'json-stdio' } };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Sign the exact canonical manifest with an Ed25519 private key outside Docker Dash. Only the public key and detached signature are stored.</div><label for="gc-pr-manifest" class="form-label">Manifest JSON</label><textarea id="gc-pr-manifest" class="form-control mono" rows="12">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea><label for="gc-pr-public" class="form-label">Ed25519 public key PEM</label><textarea id="gc-pr-public" class="form-control mono" rows="5"></textarea><label for="gc-pr-signature" class="form-label">Detached signature (base64)</label><textarea id="gc-pr-signature" class="form-control mono" rows="3"></textarea>`,
      { title: 'Register signed provider plugin manifest', width: '940px', onSubmit: c => this._submit(() => Api.registerProviderPlugin({ manifest: JSON.parse(c.querySelector('#gc-pr-manifest').value), publicKeyPem: c.querySelector('#gc-pr-public').value, signatureBase64: c.querySelector('#gc-pr-signature').value })) });
    if (result) { Toast.success(`Manifest ${result.plugin.manifestHash.slice(0, 12)} verified; plugin remains disabled`); await this.render(this._container); }
  },
  _pluginOptions() { return (this._data.providerPlugins?.plugins || []).map(item => `<option value="${Utils.escapeHtml(item.pluginKey)}">${Utils.escapeHtml(item.pluginKey)} ${Utils.escapeHtml(item.version)}</option>`).join(''); },
  async _pluginConsentDialog() {
    const result = await Modal.form(`<div class="alert alert-warning text-sm">Consent is bound to the exact current manifest hash. Re-registering a manifest invalidates prior grants.</div><div class="form-row"><div class="form-group"><label>Plugin</label><select id="gc-pc-plugin" class="form-control">${this._pluginOptions()}</select></div><div class="form-group"><label>Permission</label><input id="gc-pc-permission" class="form-control mono" value="inventory.read"></div><div class="form-group"><label>Decision</label><select id="gc-pc-decision" class="form-control"><option>granted</option><option>denied</option></select></div></div><label for="gc-pc-reason" class="form-label">Reason</label><input id="gc-pc-reason" class="form-control" value="Reviewed against plugin purpose">`,
      { title: 'Provider plugin permission consent', onSubmit: c => { const key = c.querySelector('#gc-pc-plugin').value; const plugin = this._data.providerPlugins.plugins.find(item => item.pluginKey === key); return this._submit(() => Api.consentProviderPlugin(key, { manifestHash: plugin.manifestHash, permissionKey: c.querySelector('#gc-pc-permission').value, decision: c.querySelector('#gc-pc-decision').value, reason: c.querySelector('#gc-pc-reason').value })); } });
    if (result) { Toast.success(`Permission ${result.consent.decision}`); await this.render(this._container); }
  },
  async _pluginSandboxDialog() {
    const result = await Modal.form(`<div class="alert alert-info text-sm">The probe uses a fixed subprocess worker, does not load plugin code, invokes no plugin network endpoint and returns no request payload.</div><div class="form-row"><div class="form-group"><label>Plugin</label><select id="gc-ps-plugin" class="form-control">${this._pluginOptions()}</select></div><div class="form-group"><label>Method</label><select id="gc-ps-method" class="form-control"><option>health.check</option><option>capabilities.describe</option><option>inventory.normalize.probe</option></select></div></div><label for="gc-ps-payload" class="form-label">Bounded probe metadata JSON</label><textarea id="gc-ps-payload" class="form-control mono" rows="4">{}</textarea>`,
      { title: 'Run fixed RPC sandbox probe', onSubmit: c => this._submit(() => Api.probeProviderPluginSandbox(c.querySelector('#gc-ps-plugin').value, { method: c.querySelector('#gc-ps-method').value, payload: JSON.parse(c.querySelector('#gc-ps-payload').value) })) });
    if (result) { Toast.success(`Sandbox ${result.run.status} in ${result.run.durationMs} ms; payload returned: no`); await this.render(this._container); }
  },
  async _pluginHealthDialog() {
    const result = await Modal.form(`<div class="alert alert-info text-sm">Only aggregate counts and latency are stored; raw errors and payloads are not accepted.</div><div class="form-row"><div class="form-group"><label>Plugin</label><select id="gc-ph-plugin" class="form-control">${this._pluginOptions()}</select></div><div class="form-group"><label>Latency ms</label><input id="gc-ph-latency" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Requests</label><input id="gc-ph-requests" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Errors</label><input id="gc-ph-errors" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Crashes</label><input id="gc-ph-crashes" type="number" min="0" value="0" class="form-control"></div></div>`,
      { title: 'Record provider plugin health aggregate', onSubmit: c => this._submit(() => Api.recordProviderPluginHealth(c.querySelector('#gc-ph-plugin').value, { observedAt: new Date().toISOString(), latencyMs: Number(c.querySelector('#gc-ph-latency').value), requestCount: Number(c.querySelector('#gc-ph-requests').value), errorCount: Number(c.querySelector('#gc-ph-errors').value), crashCount: Number(c.querySelector('#gc-ph-crashes').value) })) });
    if (result) { Toast.success(`Plugin health: ${result.health.state}`); await this.render(this._container); }
  },
  async _pluginCheck(pluginKey) { try { this._showHardwareResult(`Plugin compatibility · ${pluginKey}`, await Api.getProviderPluginCompatibility(pluginKey)); } catch (error) { Toast.error(error.message); } },
  async _pluginToggle(pluginKey, enabled) { if (!await Modal.confirm(`${enabled ? 'Disable' : 'Enable'} ${pluginKey}? Enable is rejected until every signature, version, schema and consent check passes.`)) return; try { await Api.setProviderPluginEnabled(pluginKey, !enabled); Toast.success(`Plugin ${enabled ? 'disabled' : 'enabled'}`); await this.render(this._container); } catch (error) { Toast.error(error.message); } },
  async _connectorActionDialog(kind) {
    const now = new Date(); const start = new Date(now.getTime() - 60000).toISOString(); const end = new Date(now.getTime() + 3600000).toISOString(); const observed = now.toISOString();
    const samples = {
      marketplace: { manifest: { schemaVersion: '1.0', connectorKey: 'enterprise-connectors', name: 'Enterprise connector pack', version: '1.0.0', publisher: 'Example publisher', supportLevel: 'partner', domains: ['cmdb','itsm','siem','secrets','ipam_dns','backup','monitoring','event_bus','openapi'], products: ['netbox','servicenow','splunk','vault','infoblox','veeam','prometheus','kafka','generic_openapi'], allowedHosts: ['api.example.test','monitor.example.test'], docsUrl: 'https://docs.example.test/connectors' }, publicKeyPem: '', signatureBase64: '' },
      cmdb: { connectorKey: 'enterprise-connectors', product: 'netbox', direction: 'bidirectional', resourceType: 'vm', resourceRef: 'vm-42', ownershipRules: { owner: 'cmdb', powerState: 'docker-dash' }, changes: [{ field: 'owner', operation: 'set', owner: 'cmdb', valueHash: '0'.repeat(64) }], conflicts: [] },
      itsm: { connectorKey: 'enterprise-connectors', product: 'servicenow', ticketRef: 'CHG001', ticketUrl: 'https://itsm.example.test/change/CHG001', windowStart: start, windowEnd: end, approvalState: 'approved', evidenceLinks: ['https://evidence.example.test/change/CHG001'], evaluatedAt: observed },
      siem: { connectorKey: 'enterprise-connectors', product: 'splunk', eventType: 'vm.policy.denied', occurredAt: observed, severity: 'warning', resourceRef: 'vm-42', correlationId: 'change-42', attributes: { policy: 'production-guard', result: 'denied' } },
      secrets: { connectorKey: 'enterprise-connectors', product: 'vault', referenceUri: 'vault://kv/docker-dash/connector', purpose: 'connector_auth', scopes: ['inventory.read'] },
      ipam: { connectorKey: 'enterprise-connectors', product: 'infoblox', action: 'create', resourceRef: 'vm-42', recordType: 'A', address: '10.20.30.42', fqdn: 'vm42.example.test', ownershipToken: 'reservation-42', expectedVersion: 'etag-1' },
      backup: { connectorKey: 'enterprise-connectors', product: 'veeam', jobRef: 'job-42', workloadRef: 'vm-42', status: 'success', lastRunAt: observed, recoveryPoints: [{ id: 'rp-42', createdAt: observed, type: 'incremental', verified: true, sizeBytes: 0 }] },
      monitoring: { connectorKey: 'enterprise-connectors', product: 'prometheus', endpointOrigin: 'https://monitor.example.test', mode: 'pull', metricAllowlist: ['vm_cpu_usage'], labelAllowlist: ['host_id'] },
      eventbus: { connectorKey: 'enterprise-connectors', product: 'kafka', channel: 'docker-dash.events.v1', schemaRef: 'urn:docker-dash:event:1.0', event: { eventType: 'vm.changed', occurredAt: observed, subject: 'vm-42', data: { state: 'running' } } },
      openapi: { connectorKey: 'enterprise-connectors', operationKey: 'vm_read', endpointOrigin: 'https://api.example.test', method: 'GET', path: '/v1/vms', risk: 'read', allowedQuery: ['id'], allowedBody: [], responseSchemaHash: '0'.repeat(64) },
      prototype: { connectorKey: 'enterprise-connectors', operationKey: 'vm_read', query: { id: 'vm-42' }, body: {} },
    };
    const labels = { marketplace: 'Register signed marketplace entry', cmdb: 'CMDB ownership sync plan', itsm: 'ITSM change gate', siem: 'Normalized SIEM event', secrets: 'Secret manager reference', ipam: 'IPAM / DNS lifecycle plan', backup: 'Backup job visibility', monitoring: 'Monitoring target allowlist', eventbus: 'Schema-bound event publication', openapi: 'OpenAPI operation allowlist', prototype: 'OpenAPI request prototype' };
    const calls = {
      marketplace: value => Api.registerConnectorMarketplaceEntry(value),
      cmdb: value => { const { connectorKey, ...body } = value; return Api.planConnectorCmdbSync(connectorKey, body); },
      itsm: value => { const { connectorKey, ...body } = value; return Api.linkConnectorItsmChange(connectorKey, body); },
      siem: value => { const { connectorKey, ...body } = value; return Api.normalizeConnectorSiemEvent(connectorKey, body); },
      secrets: value => { const { connectorKey, ...body } = value; return Api.bindConnectorSecretReference(connectorKey, body); },
      ipam: value => { const { connectorKey, ...body } = value; return Api.planConnectorIpamDns(connectorKey, body); },
      backup: value => { const { connectorKey, ...body } = value; return Api.recordConnectorBackupObservation(connectorKey, body); },
      monitoring: value => { const { connectorKey, ...body } = value; return Api.saveConnectorMonitoringTarget(connectorKey, body); },
      eventbus: value => { const { connectorKey, ...body } = value; return Api.planConnectorEventPublication(connectorKey, body); },
      openapi: value => { const { connectorKey, ...body } = value; return Api.saveConnectorOpenApiOperation(connectorKey, body); },
      prototype: value => { const { connectorKey, operationKey, ...body } = value; return Api.prototypeConnectorOpenApiRequest(connectorKey, operationKey, body); },
    };
    const result = await Modal.form(`<div class="alert alert-info text-sm">No connector network request is performed by this control-plane batch. Metadata signatures, exact HTTPS hosts, ownership/version tokens and field allowlists are verified before the contract is stored.</div><label for="gc-connector-json" class="form-label">Contract JSON</label><textarea id="gc-connector-json" class="form-control mono" rows="22">${Utils.escapeHtml(JSON.stringify(samples[kind], null, 2))}</textarea>`,
      { title: labels[kind], width: '980px', onSubmit: c => this._submit(() => calls[kind](JSON.parse(c.querySelector('#gc-connector-json').value))) });
    if (result) { Toast.success(`${labels[kind]} recorded`); await this.render(this._container); }
  },
  async _migrationActionDialog(kind) {
    const samples = {
      assessment: { sourceProvider: 'vmware', targetProvider: 'proxmox', sourceInventory: { clusterRef: 'source-a', vms: [{ resourceKey: 'vm-app', name: 'Application', cpu: 2, memoryBytes: 4294967296, diskBytes: 53687091200, networks: ['prod'], diskFormats: ['vmdk'], devices: [], os: 'linux' }] }, dependencies: [], targetCandidates: [{ targetRef: 'pve-a', capacityScore: 90, compatibilityScore: 95, networkScore: 85, storageScore: 88, blockers: [] }] },
      conversion: { assessmentId: 1, inputFormat: 'vmdk', outputFormat: 'qcow2', inputChecksumSha256: '0'.repeat(64), expectedOutputChecksumSha256: '1'.repeat(64), normalizeGuest: false },
      network: { assessmentId: 1, mappings: [{ sourceNetwork: 'prod', targetNetwork: 'vmbr-prod', sourceVlan: 20, targetVlan: 20, sourceCidr: '10.20.0.0/24', targetCidr: '10.20.0.0/24', securityProfile: 'production', ipMode: 'preserve' }] },
      storage: { assessmentId: 1, mappings: [{ diskRef: 'disk-app', sizeBytes: 53687091200, targetDatastore: 'ceph-prod', targetPolicy: 'replicated-3', targetTier: 'ssd', availableBytes: 1099511627776, thinProvisioned: true }] },
      clone: { assessmentId: 1, networkMappingId: 1, storageMappingId: 1, targetRef: 'pve-a', isolationMode: 'isolated', checks: [{ name: 'boot', state: 'pass', evidenceHash: '2'.repeat(64) }, { name: 'app_health', state: 'pass', evidenceHash: '3'.repeat(64) }] },
      waves: { assessmentId: 1, maxConcurrent: 1, workloads: [{ resourceKey: 'vm-app', application: 'app', dependencies: [], downtimeMinutes: 10, windowRef: 'mw-1' }] },
      cutover: { assessmentId: 1, wavePlanId: 1, testCloneId: 1, targetRef: 'pve-a', approvalHash: '4'.repeat(64), confirmation: 'CUTOVER 1 pve-a' },
      rollback: { cutoverPlanId: 1, triggerReason: 'Post-boot validation failed', sourceNetworkRestorable: true, sourcePowerRestorable: true, targetCleanupSupported: true },
      report: { assessmentId: 1, conversionJobIds: [1], cutoverPlanId: 1, rollbackPlanId: 1, timings: { assessmentMs: 100, conversionMs: 1000 }, tests: { boot: 'pass', app: 'pass' }, approvals: { change: 'approved', fourEyes: true } },
      xen: { hostRef: 'xen-legacy-1', toolstack: 'xend', version: '4.2', vms: [{ vmRef: 'legacy-vm', configHash: '5'.repeat(64), diskFormats: ['vhd'], networkRefs: ['xenbr0'], passthroughDevices: [] }], targetCandidates: ['xcp-ng','xapi'] },
    };
    const labels = { assessment: 'Migration assessment', conversion: 'Sandboxed conversion contract', network: 'Network translation map', storage: 'Storage translation map', clone: 'Isolated test-clone evidence', waves: 'Dependency-aware wave plan', cutover: 'Guarded cutover plan', rollback: 'Rollback plan', report: 'Migration evidence report', xen: 'Legacy Xen assistant' };
    const calls = {
      assessment: value => Api.createMigrationAssessment(value),
      conversion: value => { const { assessmentId, ...body } = value; return Api.planMigrationConversion(assessmentId, body); },
      network: value => { const { assessmentId, ...body } = value; return Api.mapMigrationNetworks(assessmentId, body); },
      storage: value => { const { assessmentId, ...body } = value; return Api.mapMigrationStorage(assessmentId, body); },
      clone: value => { const { assessmentId, ...body } = value; return Api.recordMigrationTestClone(assessmentId, body); },
      waves: value => { const { assessmentId, ...body } = value; return Api.planMigrationWaves(assessmentId, body); },
      cutover: value => { const { assessmentId, ...body } = value; return Api.planMigrationCutover(assessmentId, body); },
      rollback: value => { const { cutoverPlanId, ...body } = value; return Api.planMigrationRollback(cutoverPlanId, body); },
      report: value => { const { assessmentId, ...body } = value; return Api.createMigrationEvidenceReport(assessmentId, body); },
      xen: value => Api.assessLegacyXenMigration(value),
    };
    const result = await Modal.form(`<div class="alert alert-warning text-sm">This surface records evidence and approved orchestration plans only. It cannot run qemu-img/virt-v2v, boot a clone, shut down a source, switch a network or execute cutover/rollback.</div><label for="gc-migration-json" class="form-label">Migration contract JSON</label><textarea id="gc-migration-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(samples[kind], null, 2))}</textarea>`,
      { title: labels[kind], width: '1000px', onSubmit: c => this._submit(() => calls[kind](JSON.parse(c.querySelector('#gc-migration-json').value))) });
    if (result) { Toast.success(`${labels[kind]} recorded; no provider mutation started`); await this.render(this._container); }
  },

  _finops() {
    const data = this._data.finopsFoundation || { capabilities: {}, ledger: [], costModels: [], allocationRules: [], allocations: [], ratingRuns: [], chargebackExports: [], budgets: [], latestShowback: null, summary: {} };
    const optimization = this._data.finopsOptimization || { capabilities: {}, budgetAlertPolicies: [], budgetAlerts: [], anomalyPolicies: [], costAnomalies: [], assessments: [], schedules: [], executions: [], reservations: [], consolidation: [], forecasts: [], placementScores: [], summary: {} };
    const sustainability = this._data.finopsSustainability || { capabilities: {}, telemetry: [], factors: [], recommendations: [], tcoScenarios: [], dashboard: {}, summary: {} };
    const latest = data.latestShowback; const currency = data.summary?.currency || 'USD';
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-finops-ledger"><i class="fas fa-list"></i> Usage entry</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-model"><i class="fas fa-calculator"></i> Cost model</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-rule"><i class="fas fa-tags"></i> Allocation rule</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-budget"><i class="fas fa-wallet"></i> Budget</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-alert-policy"><i class="fas fa-bell"></i> Budget alerts</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-anomaly-policy"><i class="fas fa-wave-square"></i> Anomaly policy</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-zombie"><i class="fas fa-ghost"></i> Zombie check</button>
      <button class="btn btn-secondary btn-sm" id="gc-finops-schedule"><i class="fas fa-clock"></i> Savings schedule</button>
      <button class="btn btn-primary btn-sm" id="gc-finops-rate"><i class="fas fa-chart-pie"></i> Rate showback</button>`) }
      <div class="info-grid">
        ${this._stat('fa-list-check', 'Ledger entries', data.summary?.ledgerEntries || 0)}
        ${this._stat('fa-calculator', 'Cost models', data.summary?.costModels || 0)}
        ${this._stat('fa-tags', 'Allocation coverage', `${Math.round((data.summary?.allocationCoverage || 0) * 100)}%`)}
        ${this._stat('fa-coins', 'Latest rated cost', `${currency} ${Number(data.summary?.latestRatedCost || 0).toFixed(2)}`)}
        ${this._stat('fa-triangle-exclamation', 'Over budget', data.summary?.overBudget || 0)}
        ${this._stat('fa-file-invoice-dollar', 'Billing transactions', data.summary?.billingTransactionsCreated || 0)}
      </div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>FinOps evidence boundary</h3><p class="text-muted text-sm">Rates are versioned, scoped and provenance-linked. Showback is explanatory; chargeback produces rated files for ERP import and never creates a billing transaction.</p></div></div>
        <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${[['Unified ledger','unifiedResourceLedger'],['Private cloud','privateCloudCostModel'],['License','providerLicenseCostModel'],['Storage','storageTierCostModel'],['Network/IP','networkPublicIpCostModel'],['GPU','gpuAcceleratorCostModel'],['Tag allocation','tagBasedAllocation'],['Showback','showbackDashboard'],['Chargeback export','chargebackExport'],['Budgets','budgets']].map(([label,key]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Allocation &amp; usage ledger</h3></div><table class="data-table"><thead><tr><th>Resource / interval</th><th>Allocated</th><th>Used</th><th>Allocation</th><th></th></tr></thead><tbody>${(data.ledger || []).map(item => { const allocation = (data.allocations || []).find(value => value.ledgerEntryId === item.id); return `<tr><td><strong>${Utils.escapeHtml(item.resourceType)} · ${Utils.escapeHtml(item.resourceRef)}</strong><div class="text-xs text-muted">${new Date(item.intervalStart).toLocaleDateString()} → ${new Date(item.intervalEnd).toLocaleDateString()}</div></td><td>${item.allocation.vCpu ?? 0} vCPU · ${item.allocation.ramGb ?? 0} GB<div class="text-xs text-muted">${item.allocation.logicalStorageGb ?? 0} GB logical · ${item.allocation.gpuDevices ?? 0} GPU</div></td><td>${item.usage.usedVcpu ?? '—'} vCPU · ${item.usage.usedRamGb ?? '—'} GB<div class="text-xs text-muted">${item.usage.egressGb ?? 0} GB egress · ${item.usage.gpuHours ?? 0} GPUh</div></td><td><span class="badge ${allocation?.state === 'allocated' ? 'badge-success' : allocation?.state === 'partial' ? 'badge-warning' : 'badge-secondary'}">${allocation?.state || 'unresolved'}</span></td><td><button class="action-btn" data-gc-finops-allocate="${item.id}" title="Resolve tag allocation"><i class="fas fa-tags"></i></button>${item.resourceType === 'vm' ? `<button class="action-btn" data-gc-finops-idle="${item.id}" title="Idle assessment"><i class="fas fa-moon"></i></button><button class="action-btn" data-gc-finops-oversized="${item.id}" title="Rightsize assessment"><i class="fas fa-compress"></i></button>` : ''}</td></tr>`; }).join('') || this._empty('No FinOps ledger observations', 5)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Versioned cost models</h3></div><table class="data-table"><thead><tr><th>Model</th><th>Scope</th><th>Window</th><th>Evidence</th></tr></thead><tbody>${(data.costModels || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.kind)} · v${Utils.escapeHtml(item.version)}</div></td><td>${Utils.escapeHtml(item.scopeRef)}<div class="text-xs text-muted">${item.currency} · ${item.confidence}</div></td><td>${new Date(item.effectiveFrom).toLocaleDateString()} → ${item.effectiveTo ? new Date(item.effectiveTo).toLocaleDateString() : 'open'}</td><td class="mono text-xs">${item.modelHash.slice(0, 12)}</td></tr>`).join('') || this._empty('No cost models', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Latest showback</h3></div>${latest ? `<table class="data-table"><thead><tr><th>Category</th><th>Cost</th><th>Confidence / provenance</th></tr></thead><tbody>${latest.lines.map(line => `<tr><td>${Utils.escapeHtml(line.category)}<div class="text-xs text-muted">${Utils.escapeHtml(line.dimensions.costCenter || 'unallocated')} · ${Utils.escapeHtml(line.dimensions.resourceRef)}</div></td><td class="mono">${line.currency} ${Number(line.amount).toFixed(4)}</td><td>${line.confidence}<div class="mono text-xs">${line.provenanceHash.slice(0, 12)}</div></td></tr>`).join('') || this._empty('Rating completed without line items', 3)}</tbody></table><div style="padding:12px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>Total: ${latest.currency} ${Number(latest.totalCost).toFixed(4)}</strong><div><button class="btn btn-secondary btn-sm" data-gc-finops-evaluate-alerts="${latest.id}"><i class="fas fa-bell"></i> Thresholds</button> <button class="btn btn-secondary btn-sm" data-gc-finops-evaluate-anomalies="${latest.id}"><i class="fas fa-wave-square"></i> Anomalies</button> <button class="btn btn-secondary btn-sm" data-gc-finops-export="${latest.id}" data-format="csv"><i class="fas fa-file-csv"></i> CSV</button> <button class="btn btn-secondary btn-sm" data-gc-finops-export="${latest.id}" data-format="json"><i class="fas fa-code"></i> JSON</button></div></div>` : '<div class="empty-state"><p>No showback rating run yet.</p></div>'}</div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Budgets &amp; allocation rules</h3></div><table class="data-table"><thead><tr><th>Name</th><th>Scope</th><th>Amount</th><th>Status</th></tr></thead><tbody>${(data.budgets || []).map(item => { const state = latest?.budgets?.find(value => value.id === item.id); return `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">${item.cadence}</div></td><td>${item.scopeType}${item.scopeValue ? `:${Utils.escapeHtml(item.scopeValue)}` : ''}</td><td>${item.currency} ${Number(item.amount).toFixed(2)}</td><td>${state ? `<span class="badge ${state.state === 'over' ? 'badge-danger' : 'badge-success'}">${state.utilizationPercent}%</span>` : '<span class="badge badge-secondary">not rated</span>'}</td></tr>`; }).join('') || this._empty('No budgets', 4)}</tbody></table><div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap">${(data.allocationRules || []).map(item => `<span class="badge badge-secondary" title="${Utils.escapeHtml(JSON.stringify(item.matchTags))}">${Utils.escapeHtml(item.name)} · p${item.priority}</span>`).join('') || '<span class="text-muted text-sm">No allocation rules</span>'}</div></div>
      </div>
      ${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-finops-reservation"><i class="fas fa-ticket"></i> Reserved capacity</button>
        <button class="btn btn-secondary btn-sm" id="gc-finops-consolidation"><i class="fas fa-server"></i> Consolidation</button>
        <button class="btn btn-secondary btn-sm" id="gc-finops-forecast"><i class="fas fa-arrow-trend-up"></i> Capacity forecast</button>
        <button class="btn btn-primary btn-sm" id="gc-finops-placement"><i class="fas fa-location-dot"></i> Placement score</button>`) }
      <div class="info-grid">
        ${this._stat('fa-bell', 'Queued budget alerts', optimization.summary?.queuedBudgetAlerts || 0)}
        ${this._stat('fa-wave-square', 'Cost anomalies', optimization.summary?.openAnomalies || 0)}
        ${this._stat('fa-lightbulb', 'Optimization candidates', optimization.summary?.optimizationCandidates || 0)}
        ${this._stat('fa-server', 'Blocked consolidations', optimization.summary?.blockedConsolidations || 0)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Budget &amp; anomaly evidence</h3></div><table class="data-table"><thead><tr><th>Signal</th><th>Scope</th><th>Observed</th><th>Evidence</th></tr></thead><tbody>${(optimization.budgetAlerts || []).map(item => `<tr><td><span class="badge ${item.severity === 'critical' ? 'badge-danger' : item.severity === 'warning' ? 'badge-warning' : 'badge-secondary'}">${item.signal} ${item.thresholdPercent}%</span></td><td>budget #${item.budgetId}</td><td>${item.observedPercent}%</td><td class="mono text-xs">${item.fingerprint.slice(0, 12)}</td></tr>`).join('')}${(optimization.costAnomalies || []).map(item => `<tr><td><span class="badge badge-warning">${item.direction}</span></td><td>policy #${item.policyId}</td><td>${item.deviationPercent}%<div class="text-xs text-muted">${item.baselineAmount} → ${item.currentAmount}</div></td><td>${item.confidence}<div class="mono text-xs">${item.fingerprint.slice(0, 12)}</div></td></tr>`).join('') || this._empty('No budget alerts or cost anomalies', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Optimization candidates</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Assessment</th><th>State</th><th>Confidence</th></tr></thead><tbody>${(optimization.assessments || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.resourceType)} · ${Utils.escapeHtml(item.resourceRef)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.owner || 'no owner')} · ${Utils.escapeHtml(item.criticality || 'unknown')}</div></td><td>${Utils.escapeHtml(item.type)}</td><td><span class="badge ${item.state.endsWith('_candidate') ? 'badge-warning' : item.state === 'protected' ? 'badge-success' : 'badge-secondary'}">${Utils.escapeHtml(item.state)}</span></td><td>${item.confidence}<div class="text-xs text-muted">0 implicit mutations</div></td></tr>`).join('') || this._empty('No optimization assessments', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Savings schedules</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Window</th><th>Mode</th><th></th></tr></thead><tbody>${(optimization.schedules || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.resourceRef)}</div></td><td>${item.offHoursStart}–${item.offHoursEnd}<div class="text-xs text-muted">${Utils.escapeHtml(item.timezone)} · ${item.weekdays.join(',')}</div></td><td><span class="badge ${item.mode === 'automate' ? 'badge-warning' : 'badge-secondary'}">${item.mode}</span></td><td><button class="action-btn" data-gc-finops-execute-schedule="${item.id}" title="Create recommendation / gated execution"><i class="fas fa-play"></i></button></td></tr>`).join('') || this._empty('No savings schedules', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Capacity &amp; placement scenarios</h3></div><table class="data-table"><thead><tr><th>Evidence</th><th>Scope / target</th><th>Result</th><th>Boundary</th></tr></thead><tbody>${(optimization.reservations || []).map(item => `<tr><td>reserved capacity</td><td>${Utils.escapeHtml(item.scopeRef)}</td><td>${Utils.escapeHtml(item.state)}</td><td>no purchase</td></tr>`).join('')}${(optimization.consolidation || []).map(item => `<tr><td>${Utils.escapeHtml(item.name)}</td><td>remove ${Utils.escapeHtml(item.removedHostRef)}</td><td><span class="badge ${item.state === 'safe' ? 'badge-success' : 'badge-danger'}">${item.state}</span></td><td>simulation only</td></tr>`).join('')}${(optimization.forecasts || []).map(item => `<tr><td>capacity forecast</td><td>${Utils.escapeHtml(item.scopeRef)}</td><td>${Utils.escapeHtml(item.recommendation)}</td><td>no purchase</td></tr>`).join('')}${(optimization.placementScores || []).map(item => `<tr><td>${Utils.escapeHtml(item.workloadRef)}</td><td>${Utils.escapeHtml(item.selectedTargetRef || 'no eligible target')}</td><td>${item.ranking.length} candidates</td><td>score only</td></tr>`).join('') || this._empty('No capacity or placement evidence', 4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-header"><div><h3>Energy, carbon &amp; TCO evidence</h3><p class="text-muted text-sm">Power data and carbon factors retain provenance. Carbon-aware and TCO results are recommendations only: no workload move, purchase or billing transaction is started.</p></div></div>
        <div style="padding:12px;display:flex;gap:7px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="gc-finops-power"><i class="fas fa-bolt"></i> Power sample</button>
          <button class="btn btn-secondary btn-sm" id="gc-finops-carbon-factor"><i class="fas fa-leaf"></i> Carbon factor</button>
          <button class="btn btn-secondary btn-sm" id="gc-finops-carbon-recommend"><i class="fas fa-calendar-check"></i> Carbon recommendation</button>
          <button class="btn btn-primary btn-sm" id="gc-finops-tco"><i class="fas fa-scale-balanced"></i> TCO comparison</button>
        </div></div>
      <div class="info-grid">
        ${this._stat('fa-bolt', 'Energy kWh', Number(sustainability.dashboard?.totalEnergyKwh || 0).toFixed(2))}
        ${this._stat('fa-server', 'Watt / VM', sustainability.dashboard?.wattPerVm == null ? '—' : Number(sustainability.dashboard.wattPerVm).toFixed(2))}
        ${this._stat('fa-leaf', 'kg CO₂e', Number(sustainability.dashboard?.emissionsKgCo2e || 0).toFixed(2))}
        ${this._stat('fa-chart-pie', 'Carbon coverage', `${Number(sustainability.dashboard?.carbonCoveragePercent || 0).toFixed(1)}%`)}
        ${this._stat('fa-moon', 'Idle waste kWh', Number(sustainability.dashboard?.idleHostWasteKwh || 0).toFixed(2))}
        ${this._stat('fa-scale-balanced', 'TCO scenarios', sustainability.summary?.tcoScenarios || 0)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Power &amp; carbon evidence</h3></div><table class="data-table"><thead><tr><th>Host / site</th><th>Interval</th><th>Energy</th><th>Efficiency</th></tr></thead><tbody>${(sustainability.telemetry || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.hostRef)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.siteRef)} · ${Utils.escapeHtml(item.sourceKind)}</div></td><td>${new Date(item.intervalStart).toLocaleString()}<div class="text-xs text-muted">→ ${new Date(item.intervalEnd).toLocaleString()}</div></td><td>${Number(item.energyKwh).toFixed(3)} kWh<div class="text-xs text-muted">${Number(item.averageWatts).toFixed(0)} W avg · ${Number(item.peakWatts).toFixed(0)} W peak</div></td><td>${item.vmCount ? Number(item.averageWatts / item.vmCount).toFixed(1) + ' W/VM' : '—'}<div class="text-xs text-muted">CPU ${item.cpuUtilizationPercent ?? '—'}%</div></td></tr>`).join('') || this._empty('No power telemetry evidence', 4)}</tbody></table>
          <div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap">${(sustainability.factors || []).map(item => `<span class="badge badge-secondary" title="${Utils.escapeHtml(item.methodology)}">${Utils.escapeHtml(item.siteRef)} · ${item.gramsCo2ePerKwh} gCO₂e/kWh</span>`).join('') || '<span class="text-muted text-sm">No carbon factors</span>'}</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Carbon &amp; TCO recommendations</h3></div><table class="data-table"><thead><tr><th>Kind</th><th>Scope</th><th>Recommendation</th><th>Boundary</th></tr></thead><tbody>${(sustainability.recommendations || []).map(item => `<tr><td>carbon-aware</td><td>${Utils.escapeHtml(item.workloadRef)}</td><td><span class="badge ${item.state === 'recommended' ? 'badge-success' : 'badge-danger'}">${item.state}</span><div class="text-xs text-muted">${item.selected ? `${Utils.escapeHtml(item.selected.siteRef)} · ${item.selected.estimatedKgCo2e} kg` : Utils.escapeHtml(item.blockers.join(', '))}</div></td><td>no scheduling</td></tr>`).join('')}${(sustainability.tcoScenarios || []).map(item => `<tr><td>TCO · ${item.horizonMonths}m</td><td>${Utils.escapeHtml(item.name)}</td><td><strong>${Utils.escapeHtml(item.selectedOption || '—')}</strong><div class="text-xs text-muted">${item.ranking[0] ? `${item.currency} ${Number(item.ranking[0].total).toFixed(2)}` : 'no option'}</div></td><td>no purchase/billing</td></tr>`).join('') || this._empty('No sustainability recommendations or TCO scenarios', 4)}</tbody></table></div>
      </div>`;
  },

  _updates() {
    const data = this._data.lifecycleUpdates || { capabilities: {}, inventory: [], supportRegistry: [], upgradePaths: [], catalog: [], prechecks: [], summary: {} };
    const ops = this._data.lifecycleMaintenance || { capabilities: {}, maintenancePlans: [], campaigns: [], livePatchEvidence: [], rebootSignals: [], firmwareCatalog: [], driverMatrix: [], certificates: [], reminderPolicies: [], reminders: [], summary: {} };
    const assurance = this._data.lifecycleAssurance || { capabilities: {}, renewals: [], entitlements: [], licensePolicies: [], licenseAlerts: [], snapshots: [], diffs: [], driftPolicies: [], profiles: [], mirrors: [], supportBundles: [], validationPacks: [], validationRuns: [], summary: {} };
    const supportBadge = state => state === 'supported' ? 'badge-success' : state === 'eol' ? 'badge-warning' : 'badge-danger';
    return `${this._actions(`<button class="btn btn-secondary btn-sm" id="gc-update-inventory"><i class="fas fa-boxes-stacked"></i> Record inventory</button>
      <button class="btn btn-secondary btn-sm" id="gc-update-support"><i class="fas fa-calendar-xmark"></i> Support lifecycle</button>
      <button class="btn btn-secondary btn-sm" id="gc-update-path"><i class="fas fa-route"></i> Upgrade path</button>
      <button class="btn btn-secondary btn-sm" id="gc-update-catalog"><i class="fas fa-download"></i> Ingest official catalog</button>
      <button class="btn btn-primary btn-sm" id="gc-update-precheck"><i class="fas fa-list-check"></i> Upgrade precheck</button>`) }
      <div class="info-grid">
        ${this._stat('fa-cubes-stacked', 'Inventory items', data.summary?.inventoryItems || 0)}
        ${this._stat('fa-clock-rotate-left', 'Stale inventory', data.summary?.staleInventory || 0)}
        ${this._stat('fa-triangle-exclamation', 'Unsupported lines', data.summary?.unsupportedVersions || 0)}
        ${this._stat('fa-circle-check', 'Ready prechecks', data.summary?.readyPrechecks || 0)}
      </div>
      <div class="card" style="margin-top:12px"><div class="card-header"><div><h3>Lifecycle readiness boundary</h3><p class="text-muted text-sm">Vendor evidence, supported hops and five-category prechecks are advisory. Docker Dash does not download packages or start an upgrade.</p></div></div>
        <div style="padding:15px;display:flex;gap:7px;flex-wrap:wrap">${[['Version/build inventory','versionBuildInventory'],['Support registry','supportLifecycleRegistry'],['Upgrade advisor','upgradePathAdvisor'],['Official catalog ingestion','officialUpdateCatalogIngestion'],['Upgrade prechecks','upgradePrecheckFramework']].map(([label,key]) => `<span class="badge ${data.capabilities?.[key] ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-check" style="margin-right:4px"></i>${label}</span>`).join('')}<span class="badge badge-success"><i class="fas fa-shield" style="margin-right:4px"></i>No automatic upgrade</span></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Version &amp; build inventory</h3></div><table class="data-table"><thead><tr><th>Component</th><th>Product</th><th>Version / build</th><th>Freshness</th><th></th></tr></thead><tbody>
        ${(data.inventory || []).map(item => `<tr><td>${Utils.escapeHtml(item.componentType)}<div class="text-xs text-muted">host ${item.providerHostId || 'global'}</div></td><td><strong>${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.product)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.source)}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.version)}<br>${Utils.escapeHtml(item.build || '—')}</td><td><span class="badge ${item.ageSeconds <= 86400 ? 'badge-success' : 'badge-warning'}">${Math.floor(item.ageSeconds / 3600)}h old</span></td><td><button class="action-btn" data-gc-update-advise="${item.id}" title="Upgrade path advisor"><i class="fas fa-route"></i></button></td></tr>`).join('') || this._empty('No version/build inventory', 5)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Support lifecycle registry</h3></div><table class="data-table"><thead><tr><th>Product / line</th><th>GA</th><th>EOL / EOS</th><th>State / target</th></tr></thead><tbody>
        ${(data.supportRegistry || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.product)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.versionLine)}</div></td><td>${item.gaDate || '—'}</td><td>${item.eolDate || '—'}<br>${item.eosDate || '—'}</td><td><span class="badge ${supportBadge(item.state)}">${item.state}</span><div class="mono text-xs">→ ${Utils.escapeHtml(item.recommendedTarget || 'not set')}</div></td></tr>`).join('') || this._empty('No support lifecycle evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Official update catalog</h3></div><table class="data-table"><thead><tr><th>Advisory</th><th>Product</th><th>Kind / target</th><th>Severity</th></tr></thead><tbody>
        ${(data.catalog || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.title)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.advisoryId)}</div></td><td>${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.product)}</td><td>${Utils.escapeHtml(item.updateKind)}<div class="mono text-xs">${Utils.escapeHtml(item.targetVersion || 'all')}</div></td><td><span class="badge ${['critical','high'].includes(item.severity) ? 'badge-danger' : item.severity === 'medium' ? 'badge-warning' : 'badge-secondary'}">${item.severity}</span></td></tr>`).join('') || this._empty('No official update catalog evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Upgrade precheck evidence</h3></div><table class="data-table"><thead><tr><th>Inventory / target</th><th>Checks</th><th>Expiry</th><th>Status</th></tr></thead><tbody>
        ${(data.prechecks || []).map(item => `<tr><td>#${item.inventoryId}<div class="mono text-xs">→ ${Utils.escapeHtml(item.targetVersion)}</div></td><td>${item.results.filter(result => result.passed).length}/${item.results.length}<div class="text-xs text-muted">health · capacity · backup · compatibility · space</div></td><td>${new Date(item.expiresAt).toLocaleString()}</td><td><span class="badge ${item.status === 'ready' && !item.stale ? 'badge-success' : 'badge-danger'}">${item.stale ? 'stale' : item.status}</span></td></tr>`).join('') || this._empty('No upgrade precheck evidence', 4)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-header"><div><h3>Maintenance &amp; compatibility operations</h3><p class="text-muted text-sm">Plans and campaigns are immutable, explicitly approved and advanced only with durable provider-operation evidence. Catalog and reminder actions never patch, reboot or renew implicitly.</p></div></div>
        <div style="padding:12px;display:flex;gap:7px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="gc-life-maint-plan"><i class="fas fa-calendar-days"></i> Maintenance plan</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-campaign"><i class="fas fa-layer-group"></i> Lifecycle campaign</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-live-patch"><i class="fas fa-bandage"></i> Live-patch evidence</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-reboot"><i class="fas fa-power-off"></i> Reboot signal</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-firmware"><i class="fas fa-microchip"></i> Firmware</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-driver"><i class="fas fa-puzzle-piece"></i> Driver matrix</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-certificate"><i class="fas fa-certificate"></i> Certificate owner</button>
          <button class="btn btn-secondary btn-sm" id="gc-life-reminder-policy"><i class="fas fa-bell"></i> Reminder policy</button>
          <button class="btn btn-primary btn-sm" id="gc-life-evaluate-reminders"><i class="fas fa-clock"></i> Evaluate reminders</button>
        </div>
        <div class="info-grid" style="padding:0 12px 12px">
          ${this._stat('fa-calendar-check', 'Planned windows', ops.summary?.plannedWindows || 0)}
          ${this._stat('fa-arrows-rotate', 'Active campaigns', ops.summary?.activeCampaigns || 0)}
          ${this._stat('fa-power-off', 'Reboots required', ops.summary?.rebootRequired || 0)}
          ${this._stat('fa-certificate', 'Expiring certificates', ops.summary?.expiringCertificates || 0)}
        </div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Maintenance windows</h3></div><table class="data-table"><thead><tr><th>Plan / scope</th><th>Window</th><th>Waves</th><th>State</th><th></th></tr></thead><tbody>
        ${(ops.maintenancePlans || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.scopeType)}:${Utils.escapeHtml(item.scopeKey)}</div></td><td>${new Date(item.startsAt).toLocaleString()}<div class="text-xs text-muted">${item.durationMinutes}m · ${Utils.escapeHtml(item.timezone)}</div></td><td>${item.waves.length}<div class="text-xs text-muted">${item.conflicts.length} conflicts</div></td><td><span class="badge ${item.state === 'approved' ? 'badge-success' : item.conflicts.length ? 'badge-danger' : 'badge-warning'}">${item.state}</span></td><td>${item.state === 'ready' ? `<button class="action-btn success" data-gc-life-approve-plan="${item.id}" title="Approve immutable plan"><i class="fas fa-check"></i></button>` : ''}</td></tr>`).join('') || this._empty('No maintenance plans', 5)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Staged lifecycle campaigns</h3></div><table class="data-table"><thead><tr><th>Campaign</th><th>Target</th><th>Stages</th><th>State</th><th></th></tr></thead><tbody>
        ${(ops.campaigns || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.kind)}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.targetVersion)}</td><td>${new Set(item.targets.map(target => target.stage)).size}<div class="text-xs text-muted">current ${item.currentStage}</div></td><td><span class="badge ${item.state === 'completed' ? 'badge-success' : ['paused','failed'].includes(item.state) ? 'badge-danger' : 'badge-warning'}">${item.state}</span></td><td>${item.state === 'ready' ? `<button class="action-btn success" data-gc-life-approve-campaign="${item.id}" title="Approve campaign"><i class="fas fa-check"></i></button>` : ['approved','running'].includes(item.state) ? `<button class="action-btn" data-gc-life-advance-campaign="${item.id}" title="Attach durable operation evidence"><i class="fas fa-forward-step"></i></button>` : ''}</td></tr>`).join('') || this._empty('No lifecycle campaigns', 5)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Live patch &amp; reboot evidence</h3></div><table class="data-table"><thead><tr><th>Target</th><th>Evidence</th><th>Operation</th><th>State</th></tr></thead><tbody>
        ${(ops.livePatchEvidence || []).map(item => `<tr><td>${Utils.escapeHtml(item.providerType)}<div class="mono text-xs">${Utils.escapeHtml(item.targetRef)}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.patchId)}<br>${item.requestHash.slice(0, 12)}</td><td class="mono text-xs">${Utils.escapeHtml(item.operationId || 'inventory only')}</td><td><span class="badge ${item.phase === 'verified' ? 'badge-success' : item.phase === 'failed' ? 'badge-danger' : 'badge-secondary'}">${item.phase}</span></td></tr>`).join('') || this._empty('No live-patch evidence', 4)}
        ${(ops.rebootSignals || []).map(item => `<tr><td>host ${item.providerHostId}<div class="mono text-xs">${Utils.escapeHtml(item.targetRef)}</div></td><td>${item.signals.length} independent signals</td><td class="text-muted text-xs">no implicit reboot</td><td><span class="badge ${item.requiredState === 'required' ? 'badge-danger' : item.requiredState === 'not_required' ? 'badge-success' : 'badge-warning'}">${item.requiredState}</span></td></tr>`).join('')}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Firmware &amp; driver compatibility</h3></div><table class="data-table"><thead><tr><th>Device</th><th>Component</th><th>Version</th><th>Status</th></tr></thead><tbody>
        ${(ops.firmwareCatalog || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.deviceModel)}</strong></td><td>${Utils.escapeHtml(item.componentType)}</td><td class="mono text-xs">${Utils.escapeHtml(item.firmwareVersion)}<div>driver ≥ ${Utils.escapeHtml(item.minimumDriverVersion || 'n/a')}</div></td><td><span class="badge ${item.severity === 'critical' ? 'badge-danger' : 'badge-secondary'}">${item.severity}</span></td></tr>`).join('')}
        ${(ops.driverMatrix || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.deviceModel)}</strong></td><td>${Utils.escapeHtml(item.driverName)}<div class="text-xs text-muted">host ${Utils.escapeHtml(item.hostRelease)}</div></td><td class="mono text-xs">${Utils.escapeHtml(item.driverVersion)} / fw ${Utils.escapeHtml(item.firmwareVersion)}</td><td><span class="badge ${item.status === 'supported' ? 'badge-success' : item.status === 'blocked' ? 'badge-danger' : 'badge-warning'}">${item.status}</span></td></tr>`).join('') || this._empty('No firmware or driver evidence', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto;grid-column:1/-1"><div class="card-header"><h3>Certificate ownership &amp; renewal reminders</h3></div><table class="data-table"><thead><tr><th>Certificate / resource</th><th>Owner</th><th>Expiry</th><th>Maintenance</th><th>Reminder</th></tr></thead><tbody>
        ${(ops.certificates || []).map(item => { const reminder = (ops.reminders || []).find(row => row.ownershipId === item.id); return `<tr><td><strong>${Utils.escapeHtml(item.name || item.inventoryKey)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.resourceType)}:${Utils.escapeHtml(item.resourceRef)}</div></td><td>${Utils.escapeHtml(item.owner)}</td><td>${item.notAfter ? new Date(item.notAfter).toLocaleString() : 'unknown'}<div class="text-xs text-muted">${item.daysRemaining == null ? 'no expiry evidence' : `${item.daysRemaining} days`}</div></td><td>${item.maintenancePlanId ? `plan #${item.maintenancePlanId}` : '<span class="text-muted">not assigned</span>'}</td><td>${reminder ? `<span class="badge ${['critical','expired'].includes(reminder.severity) ? 'badge-danger' : 'badge-warning'}">${reminder.severity}</span>` : '—'}</td></tr>`; }).join('') || this._empty('No certificate ownership inventory', 5)}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-header"><div><h3>Lifecycle assurance, content &amp; support</h3><p class="text-muted text-sm">Renewal, mirror, collection and validation use registered adapters only. Configuration and support evidence is bounded and secret-redacted; no missing adapter falls back to shell or provider mutation.</p></div></div>
        <div style="padding:12px;display:flex;gap:7px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="gc-assurance-renewal"><i class="fas fa-rotate"></i> Renewal plan</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-license"><i class="fas fa-file-contract"></i> Entitlement</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-license-policy"><i class="fas fa-bell"></i> License policy</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-license-evaluate"><i class="fas fa-chart-line"></i> Evaluate licenses</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-snapshot"><i class="fas fa-camera"></i> Config snapshot</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-diff"><i class="fas fa-code-compare"></i> Config diff</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-drift"><i class="fas fa-shield"></i> Drift policy</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-profile"><i class="fas fa-clipboard-check"></i> Host profile</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-mirror"><i class="fas fa-box-archive"></i> Air-gap mirror</button>
          <button class="btn btn-secondary btn-sm" id="gc-assurance-bundle"><i class="fas fa-life-ring"></i> Support bundle</button>
          <button class="btn btn-primary btn-sm" id="gc-assurance-validation"><i class="fas fa-vial-circle-check"></i> Validation pack</button>
        </div>
        <div class="info-grid" style="padding:0 12px 12px">
          ${this._stat('fa-triangle-exclamation', 'Renewal attention', assurance.summary?.renewalAttention || 0)}
          ${this._stat('fa-file-circle-exclamation', 'Open license alerts', assurance.summary?.openLicenseAlerts || 0)}
          ${this._stat('fa-camera', 'Config snapshots', assurance.summary?.configurationSnapshots || 0)}
          ${this._stat('fa-ban', 'Denied drift', assurance.summary?.deniedDrift || 0)}
          ${this._stat('fa-box-archive', 'Degraded mirrors', assurance.summary?.degradedMirrors || 0)}
          ${this._stat('fa-vial', 'Failed validations', assurance.summary?.failedValidations || 0)}
        </div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Certificate renewal jobs</h3></div><table class="data-table"><thead><tr><th>Job</th><th>Adapter</th><th>Evidence</th><th>State</th><th></th></tr></thead><tbody>${(assurance.renewals || []).map(item => `<tr><td>#${item.id}<div class="text-xs text-muted">ownership #${item.ownershipId}</div></td><td>${Utils.escapeHtml(item.adapterKey)}</td><td class="mono text-xs">${item.planHash.slice(0, 12)}<div>${Utils.escapeHtml(item.operationId || 'not executed')}</div></td><td><span class="badge ${item.state === 'succeeded' ? 'badge-success' : ['failed','rollback_required'].includes(item.state) ? 'badge-danger' : 'badge-warning'}">${item.state}</span></td><td>${item.state === 'ready' ? `<button class="action-btn success" data-gc-assurance-approve-renewal="${item.id}" title="Approve renewal"><i class="fas fa-check"></i></button>` : item.state === 'approved' ? `<button class="action-btn danger" data-gc-assurance-execute-renewal="${item.id}" title="Execute via registered adapter"><i class="fas fa-play"></i></button>` : ''}</td></tr>`).join('') || this._empty('No certificate renewal jobs', 5)}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>License entitlements &amp; alerts</h3></div><table class="data-table"><thead><tr><th>Product</th><th>Capacity</th><th>Assigned / used</th><th>Expiry</th><th></th></tr></thead><tbody>${(assurance.entitlements || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.product)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.edition)} · ${Utils.escapeHtml(item.entitlementReference)}</div></td><td>${item.capacity} ${Utils.escapeHtml(item.unit)}</td><td>${item.assignments.reduce((total, row) => total + row.assignedCapacity, 0)} / ${item.latestUsage?.usedCapacity ?? 'unknown'}</td><td>${item.expiresAt ? new Date(item.expiresAt).toLocaleDateString() : 'perpetual'}</td><td><button class="action-btn" data-gc-assurance-license-use="${item.id}" title="Assignment / usage"><i class="fas fa-chart-simple"></i></button></td></tr>`).join('') || this._empty('No license entitlements', 5)}</tbody></table><div style="padding:10px">${(assurance.licenseAlerts || []).slice(0, 8).map(item => `<span class="badge ${item.severity === 'critical' ? 'badge-danger' : 'badge-warning'}" title="${Utils.escapeHtml(item.message)}">${Utils.escapeHtml(item.type)}</span>`).join(' ') || '<span class="text-muted text-sm">No license alerts</span>'}</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Configuration snapshots, diff &amp; compliance</h3></div><table class="data-table"><thead><tr><th>Snapshot</th><th>Source</th><th>Digest</th><th>Redacted</th></tr></thead><tbody>${(assurance.snapshots || []).map(item => `<tr><td>#${item.id}<div class="mono text-xs">${Utils.escapeHtml(item.scopeRef)}</div></td><td>${Utils.escapeHtml(item.sourceKind)}</td><td class="mono text-xs">${item.configurationHash.slice(0, 12)}</td><td>${item.redactedPaths.length}</td></tr>`).join('') || this._empty('No configuration snapshots', 4)}</tbody></table><div style="padding:10px;display:flex;gap:6px;flex-wrap:wrap"><span class="badge badge-secondary">${assurance.diffs.length} diffs</span><span class="badge badge-secondary">${assurance.driftPolicies.length} drift policies</span><span class="badge badge-secondary">${assurance.profiles.length} profiles</span></div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Air-gap mirrors &amp; support bundles</h3></div><table class="data-table"><thead><tr><th>Name / site</th><th>Content</th><th>State</th><th></th></tr></thead><tbody>${(assurance.mirrors || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.siteRef)}</div></td><td>${item.artifacts.length} signed artifacts</td><td><span class="badge ${item.state === 'ready' ? 'badge-success' : 'badge-warning'}">${item.state}</span></td><td><button class="action-btn" data-gc-assurance-sync-mirror="${item.id}" title="Sync signed manifest"><i class="fas fa-arrows-rotate"></i></button></td></tr>`).join('')}${(assurance.supportBundles || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">expires ${new Date(item.expiresAt).toLocaleString()}</div></td><td>${item.targetRefs.length} nodes · ${Utils.formatBytes(item.byteSize)}</td><td><span class="badge ${item.state === 'ready' ? 'badge-success' : item.state === 'failed' ? 'badge-danger' : 'badge-warning'}">${item.state}</span></td><td class="mono text-xs">${item.checksumSha256?.slice(0, 12) || '—'}</td></tr>`).join('') || this._empty('No mirrors or support bundles', 4)}</tbody></table></div>
        <div class="card" style="overflow:auto;grid-column:1/-1"><div class="card-header"><h3>Post-upgrade validation packs</h3></div><table class="data-table"><thead><tr><th>Pack</th><th>Checks</th><th>Latest result</th><th>Boundary</th><th></th></tr></thead><tbody>${(assurance.validationPacks || []).map(item => { const run = (assurance.validationRuns || []).find(row => row.packId === item.id); return `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs">${Utils.escapeHtml(item.version)} · ${item.packHash.slice(0, 12)}</div></td><td>${item.checks.length}<div class="text-xs text-muted">${[...new Set(item.checks.map(check => check.category))].join(' · ')}</div></td><td>${run ? `<span class="badge ${run.state === 'passed' ? 'badge-success' : 'badge-danger'}">${run.state}</span>` : 'not run'}</td><td class="text-muted text-xs">verification only · 0 mutations</td><td><button class="action-btn" data-gc-assurance-run-validation="${item.id}" title="Run validation"><i class="fas fa-play"></i></button></td></tr>`; }).join('') || this._empty('No post-upgrade validation packs', 5)}</tbody></table></div>
      </div>`;
  },

  _bind() {
    this._container.querySelector('#gc-refresh')?.addEventListener('click', () => this.render(this._container));
    this._container.querySelectorAll('[data-gc-tab]').forEach(button => button.addEventListener('click', () => { this._tab = button.dataset.gcTab; this._paint(); }));
    this._container.querySelector('#gc-capacity-open')?.addEventListener('click', () => this._capacityDialog());
    this._container.querySelector('#gc-quota-request')?.addEventListener('click', () => this._quotaRequestDialog());
    this._container.querySelector('#gc-new-policy')?.addEventListener('click', () => this._policyDialog());
    this._container.querySelector('#gc-new-realm')?.addEventListener('click', () => this._realmDialog());
    this._container.querySelector('#gc-new-token')?.addEventListener('click', () => this._tokenDialog());
    this._container.querySelector('#gc-new-trust')?.addEventListener('click', () => this._trustDialog());
    this._container.querySelector('#gc-new-blackout')?.addEventListener('click', () => this._blackoutDialog());
    this._container.querySelector('#gc-lease-policy')?.addEventListener('click', () => this._leasePolicyDialog());
    this._container.querySelector('#gc-new-lease')?.addEventListener('click', () => this._leaseDialog());
    this._container.querySelector('#gc-ownership')?.addEventListener('click', () => this._ownershipDialog());
    this._container.querySelector('#gc-sod-rule')?.addEventListener('click', () => this._sodDialog());
    this._container.querySelector('#gc-review')?.addEventListener('click', () => this._reviewDialog());
    this._container.querySelector('#gc-offboard')?.addEventListener('click', () => this._offboardingDialog());
    this._container.querySelector('#gc-metrics-policy')?.addEventListener('click', () => this._metricsPolicyDialog());
    this._container.querySelector('#gc-hardware-snapshot')?.addEventListener('click', () => this._hardwareSnapshotDialog());
    this._container.querySelector('#gc-hardware-cluster')?.addEventListener('click', () => this._hardwareClusterDialog());
    this._container.querySelector('#gc-hardware-policy')?.addEventListener('click', () => this._hardwarePolicyDialog());
    this._container.querySelector('#gc-device-snapshot')?.addEventListener('click', () => this._deviceSnapshotDialog());
    this._container.querySelector('#gc-device-allocation')?.addEventListener('click', () => this._deviceAllocationDialog());
    this._container.querySelector('#gc-device-metrics')?.addEventListener('click', () => this._deviceMetricsDialog());
    this._container.querySelector('#gc-device-reservation')?.addEventListener('click', () => this._deviceReservationDialog());
    for (const kind of ['memory', 'pci', 'gpus', 'usb']) this._container.querySelectorAll(`[data-gc-device-${kind}]`).forEach(button => button.addEventListener('click', () => this._deviceHostAnalysis(kind, button.dataset[`gcDevice${kind[0].toUpperCase()}${kind.slice(1)}`])));
    this._container.querySelectorAll('[data-gc-device-release]').forEach(button => button.addEventListener('click', () => this._releaseDeviceAllocation(button.dataset.gcDeviceRelease)));
    this._container.querySelector('#gc-advanced-scan')?.addEventListener('click', () => this._advancedScanDialog());
    this._container.querySelector('#gc-advanced-benchmark')?.addEventListener('click', () => this._advancedBenchmarkDialog());
    this._container.querySelector('#gc-advanced-sample')?.addEventListener('click', () => this._advancedSampleDialog());
    this._container.querySelector('#gc-advanced-regression')?.addEventListener('click', () => this._advancedRegressionDialog());
    this._container.querySelector('#gc-advanced-profile')?.addEventListener('click', () => this._advancedProfileDialog());
    this._container.querySelector('#gc-network-intent')?.addEventListener('click', () => this._networkIntentDialog());
    this._container.querySelector('#gc-network-reachability')?.addEventListener('click', () => this._networkReachabilityDialog());
    this._container.querySelector('#gc-network-mtu')?.addEventListener('click', () => this._networkMtuDialog());
    this._container.querySelector('#gc-network-bond')?.addEventListener('click', () => this._networkBondDialog());
    this._container.querySelector('#gc-network-lb')?.addEventListener('click', () => this._networkLoadBalancerDialog());
    this._container.querySelector('#gc-network-public-ip')?.addEventListener('click', () => this._networkPublicIpDialog());
    this._container.querySelector('#gc-network-dependency-build')?.addEventListener('click', () => this._buildNetworkDependencyMap());
    this._container.querySelectorAll('[data-gc-dependency-impact]').forEach(button => button.addEventListener('click', () => this._showNetworkDependencyImpact(button.dataset.snapshotId, button.dataset.gcDependencyImpact)));
    for (const kind of ['evaluate', 'neighbors']) this._container.querySelectorAll(`[data-gc-advanced-${kind}]`).forEach(button => button.addEventListener('click', () => this._advancedAnalyze(kind, button.dataset[`gcAdvanced${kind[0].toUpperCase()}${kind.slice(1)}`])));
    this._container.querySelector('#gc-plugin-register')?.addEventListener('click', () => this._pluginRegisterDialog());
    this._container.querySelector('#gc-plugin-consent')?.addEventListener('click', () => this._pluginConsentDialog());
    this._container.querySelector('#gc-plugin-sandbox')?.addEventListener('click', () => this._pluginSandboxDialog());
    this._container.querySelector('#gc-plugin-health')?.addEventListener('click', () => this._pluginHealthDialog());
    this._container.querySelectorAll('[data-gc-plugin-check]').forEach(button => button.addEventListener('click', () => this._pluginCheck(button.dataset.gcPluginCheck)));
    this._container.querySelectorAll('[data-gc-plugin-enable]').forEach(button => button.addEventListener('click', () => this._pluginToggle(button.dataset.gcPluginEnable, button.dataset.enabled === 'true')));
    this._container.querySelectorAll('[data-gc-connector-action]').forEach(button => button.addEventListener('click', () => this._connectorActionDialog(button.dataset.gcConnectorAction)));
    this._container.querySelectorAll('[data-gc-migration-action]').forEach(button => button.addEventListener('click', () => this._migrationActionDialog(button.dataset.gcMigrationAction)));
    for (const kind of ['numa', 'huge', 'memory']) this._container.querySelectorAll(`[data-gc-hw-${kind}]`).forEach(button => button.addEventListener('click', () => this._hardwareHostAnalysis(kind === 'huge' ? 'hugepages' : kind, button.dataset[`gcHw${kind[0].toUpperCase()}${kind.slice(1)}`])));
    for (const kind of ['fit', 'rt']) this._container.querySelectorAll(`[data-gc-hw-${kind}]`).forEach(button => button.addEventListener('click', () => this._hardwareVmAnalysis(kind, button.dataset[`gcHw${kind[0].toUpperCase()}${kind.slice(1)}`], button.dataset.hostId)));
    this._container.querySelector('#gc-performance-chart')?.addEventListener('click', () => this._performanceDialog());
    this._container.querySelector('#gc-event-ingest')?.addEventListener('click', () => this._eventDialog());
    this._container.querySelector('#gc-timeline')?.addEventListener('click', () => this._timelineDialog());
    this._container.querySelector('#gc-topology-edge')?.addEventListener('click', () => this._topologyDialog());
    this._container.querySelector('#gc-signal-rule')?.addEventListener('click', () => this._signalRuleDialog());
    this._container.querySelector('#gc-baseline')?.addEventListener('click', () => this._baselineDialog());
    this._container.querySelector('#gc-maintenance')?.addEventListener('click', () => this._maintenanceDialog());
    this._container.querySelector('#gc-capacity-forecast')?.addEventListener('click', () => this._capacityForecastDialog());
    this._container.querySelector('#gc-runbook')?.addEventListener('click', () => this._runbookDialog());
    this._container.querySelector('#gc-observability-export')?.addEventListener('click', () => this._exportDialog());
    this._container.querySelector('#gc-slo')?.addEventListener('click', () => this._sloDialog());
    this._container.querySelector('#gc-privacy')?.addEventListener('click', () => this._privacyDialog());
    this._container.querySelector('#gc-evaluate-baselines')?.addEventListener('click', async () => {
      try { const result = await Api.evaluateVmDynamicBaselines(); Toast.success(`${result.assessments.length} baseline assessments saved`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    });
    this._container.querySelector('#gc-reconcile-suppressions')?.addEventListener('click', async () => {
      try { const result = await Api.reconcileVmAlertSuppressions(); Toast.success(`${result.active} active suppressions`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    });
    this._container.querySelector('#gc-evaluate-signals')?.addEventListener('click', async () => {
      try { const result = await Api.evaluateVmSignalRules(); Toast.success(`${result.triggered} alerts triggered, ${result.resolved} resolved`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    });
    this._container.querySelectorAll('[data-gc-impact]').forEach(button => button.addEventListener('click', () => this._impactDialog(button.dataset.gcImpact)));
    this._container.querySelectorAll('[data-gc-triage-event]').forEach(button => button.addEventListener('click', () => this._triageEvent(button.dataset.gcTriageEvent)));
    this._container.querySelectorAll('[data-gc-export-preview]').forEach(button => button.addEventListener('click', () => this._previewExport(button.dataset.gcExportPreview)));
    this._container.querySelectorAll('[data-gc-export-deliver]').forEach(button => button.addEventListener('click', () => this._deliverExport(button.dataset.gcExportDeliver)));
    this._container.querySelectorAll('[data-gc-retention]').forEach(button => button.addEventListener('click', () => this._retentionDialog(button.dataset.gcRetention)));
    this._container.querySelectorAll('[data-gc-manifest]').forEach(button => button.addEventListener('click', () => this._infrastructureManifestDialog(button.dataset.gcManifest)));
    this._container.querySelector('#gc-infra-plan')?.addEventListener('click', () => this._infrastructurePlanDialog());
    this._container.querySelector('#gc-infra-workflow')?.addEventListener('click', () => this._infrastructureWorkflowDialog());
    this._container.querySelectorAll('[data-gc-revalidate-plan]').forEach(button => button.addEventListener('click', () => this._revalidateInfrastructurePlan(button.dataset.gcRevalidatePlan)));
    this._container.querySelectorAll('[data-gc-link-job]').forEach(button => button.addEventListener('click', () => this._linkInfrastructureJob(button.dataset.gcLinkJob)));
    this._container.querySelectorAll('[data-gc-compensation]').forEach(button => button.addEventListener('click', () => this._infrastructureCompensationDialog(button.dataset.gcCompensation)));
    this._container.querySelectorAll('[data-gc-resource-manifest]').forEach(button => button.addEventListener('click', () => this._resourceManifestDialog(button.dataset.gcResourceManifest)));
    this._container.querySelector('#gc-infra-import')?.addEventListener('click', () => this._infrastructureImportDialog());
    this._container.querySelector('#gc-infra-reconcile')?.addEventListener('click', () => this._infrastructureReconcileDialog());
    this._container.querySelector('#gc-infra-controller')?.addEventListener('click', () => this._infrastructureControllerDialog());
    this._container.querySelector('#gc-infra-pr')?.addEventListener('click', () => this._infrastructurePrDialog());
    this._container.querySelector('#gc-infra-terraform')?.addEventListener('click', () => this._terraformPlanDialog());
    this._container.querySelector('#gc-infra-ansible')?.addEventListener('click', () => this._downloadAnsibleInventory());
    this._container.querySelector('#gc-infra-webhook')?.addEventListener('click', () => this._infrastructureWebhookDialog());
    this._container.querySelector('#gc-ops-schedule')?.addEventListener('click', () => this._automationScheduleDialog());
    this._container.querySelector('#gc-ops-approval')?.addEventListener('click', () => this._automationApprovalDialog());
    this._container.querySelector('#gc-ops-dry-run')?.addEventListener('click', () => this._automationDryRunDialog());
    this._container.querySelector('#gc-ops-broker')?.addEventListener('click', () => this._automationBrokerDialog());
    this._container.querySelector('#gc-ops-template')?.addEventListener('click', () => this._automationTemplateDialog());
    this._container.querySelectorAll('[data-gc-ops-probe]').forEach(button => button.addEventListener('click', () => this._probeAutomationBroker(button.dataset.gcOpsProbe)));
    for (const decision of ['approve', 'reject']) this._container.querySelectorAll(`[data-gc-ops-${decision}]`).forEach(button => button.addEventListener('click', () => this._decideAutomationApproval(button.dataset[`gcOps${decision[0].toUpperCase()}${decision.slice(1)}`], decision)));
    this._container.querySelector('#gc-update-inventory')?.addEventListener('click', () => this._lifecycleInventoryDialog());
    this._container.querySelector('#gc-update-support')?.addEventListener('click', () => this._lifecycleSupportDialog());
    this._container.querySelector('#gc-update-path')?.addEventListener('click', () => this._lifecyclePathDialog());
    this._container.querySelector('#gc-update-catalog')?.addEventListener('click', () => this._lifecycleCatalogDialog());
    this._container.querySelector('#gc-update-precheck')?.addEventListener('click', () => this._lifecyclePrecheckDialog());
    this._container.querySelectorAll('[data-gc-update-advise]').forEach(button => button.addEventListener('click', () => this._lifecycleAdvisorDialog(button.dataset.gcUpdateAdvise)));
    this._container.querySelector('#gc-life-maint-plan')?.addEventListener('click', () => this._lifecycleMaintenancePlanDialog());
    this._container.querySelector('#gc-life-campaign')?.addEventListener('click', () => this._lifecycleCampaignDialog());
    this._container.querySelector('#gc-life-live-patch')?.addEventListener('click', () => this._lifecycleLivePatchDialog());
    this._container.querySelector('#gc-life-reboot')?.addEventListener('click', () => this._lifecycleRebootDialog());
    this._container.querySelector('#gc-life-firmware')?.addEventListener('click', () => this._lifecycleFirmwareDialog());
    this._container.querySelector('#gc-life-driver')?.addEventListener('click', () => this._lifecycleDriverDialog());
    this._container.querySelector('#gc-life-certificate')?.addEventListener('click', () => this._lifecycleCertificateDialog());
    this._container.querySelector('#gc-life-reminder-policy')?.addEventListener('click', () => this._lifecycleReminderPolicyDialog());
    this._container.querySelector('#gc-life-evaluate-reminders')?.addEventListener('click', () => this._evaluateLifecycleReminders());
    this._container.querySelectorAll('[data-gc-life-approve-plan]').forEach(button => button.addEventListener('click', () => this._approveLifecycleMaintenancePlan(button.dataset.gcLifeApprovePlan)));
    this._container.querySelectorAll('[data-gc-life-approve-campaign]').forEach(button => button.addEventListener('click', () => this._approveLifecycleCampaign(button.dataset.gcLifeApproveCampaign)));
    this._container.querySelectorAll('[data-gc-life-advance-campaign]').forEach(button => button.addEventListener('click', () => this._advanceLifecycleCampaign(button.dataset.gcLifeAdvanceCampaign)));
    this._container.querySelector('#gc-assurance-renewal')?.addEventListener('click', () => this._assuranceRenewalDialog());
    this._container.querySelector('#gc-assurance-license')?.addEventListener('click', () => this._assuranceLicenseDialog());
    this._container.querySelector('#gc-assurance-license-policy')?.addEventListener('click', () => this._assuranceLicensePolicyDialog());
    this._container.querySelector('#gc-assurance-license-evaluate')?.addEventListener('click', () => this._evaluateLicenseAlerts());
    this._container.querySelector('#gc-assurance-snapshot')?.addEventListener('click', () => this._assuranceSnapshotDialog());
    this._container.querySelector('#gc-assurance-diff')?.addEventListener('click', () => this._assuranceDiffDialog());
    this._container.querySelector('#gc-assurance-drift')?.addEventListener('click', () => this._assuranceDriftDialog());
    this._container.querySelector('#gc-assurance-profile')?.addEventListener('click', () => this._assuranceProfileDialog());
    this._container.querySelector('#gc-assurance-mirror')?.addEventListener('click', () => this._assuranceMirrorDialog());
    this._container.querySelector('#gc-assurance-bundle')?.addEventListener('click', () => this._assuranceBundleDialog());
    this._container.querySelector('#gc-assurance-validation')?.addEventListener('click', () => this._assuranceValidationDialog());
    this._container.querySelectorAll('[data-gc-assurance-approve-renewal]').forEach(button => button.addEventListener('click', () => this._approveAssuranceRenewal(button.dataset.gcAssuranceApproveRenewal)));
    this._container.querySelectorAll('[data-gc-assurance-execute-renewal]').forEach(button => button.addEventListener('click', () => this._executeAssuranceRenewal(button.dataset.gcAssuranceExecuteRenewal)));
    this._container.querySelectorAll('[data-gc-assurance-license-use]').forEach(button => button.addEventListener('click', () => this._assuranceLicenseUsageDialog(button.dataset.gcAssuranceLicenseUse)));
    this._container.querySelectorAll('[data-gc-assurance-sync-mirror]').forEach(button => button.addEventListener('click', () => this._syncAssuranceMirror(button.dataset.gcAssuranceSyncMirror)));
    this._container.querySelectorAll('[data-gc-assurance-run-validation]').forEach(button => button.addEventListener('click', () => this._runAssuranceValidation(button.dataset.gcAssuranceRunValidation)));
    this._container.querySelector('#gc-finops-ledger')?.addEventListener('click', () => this._finopsLedgerDialog());
    this._container.querySelector('#gc-finops-model')?.addEventListener('click', () => this._finopsModelDialog());
    this._container.querySelector('#gc-finops-rule')?.addEventListener('click', () => this._finopsRuleDialog());
    this._container.querySelector('#gc-finops-budget')?.addEventListener('click', () => this._finopsBudgetDialog());
    this._container.querySelector('#gc-finops-rate')?.addEventListener('click', () => this._finopsRatingDialog());
    this._container.querySelector('#gc-finops-alert-policy')?.addEventListener('click', () => this._finopsAlertPolicyDialog());
    this._container.querySelector('#gc-finops-anomaly-policy')?.addEventListener('click', () => this._finopsAnomalyPolicyDialog());
    this._container.querySelector('#gc-finops-zombie')?.addEventListener('click', () => this._finopsZombieDialog());
    this._container.querySelector('#gc-finops-schedule')?.addEventListener('click', () => this._finopsScheduleDialog());
    this._container.querySelector('#gc-finops-reservation')?.addEventListener('click', () => this._finopsReservationDialog());
    this._container.querySelector('#gc-finops-consolidation')?.addEventListener('click', () => this._finopsConsolidationDialog());
    this._container.querySelector('#gc-finops-forecast')?.addEventListener('click', () => this._finopsForecastDialog());
    this._container.querySelector('#gc-finops-placement')?.addEventListener('click', () => this._finopsPlacementDialog());
    this._container.querySelector('#gc-finops-power')?.addEventListener('click', () => this._finopsPowerDialog());
    this._container.querySelector('#gc-finops-carbon-factor')?.addEventListener('click', () => this._finopsCarbonFactorDialog());
    this._container.querySelector('#gc-finops-carbon-recommend')?.addEventListener('click', () => this._finopsCarbonRecommendationDialog());
    this._container.querySelector('#gc-finops-tco')?.addEventListener('click', () => this._finopsTcoDialog());
    this._container.querySelectorAll('[data-gc-finops-allocate]').forEach(button => button.addEventListener('click', async () => {
      try { const result = await Api.resolveFinOpsAllocation(button.dataset.gcFinopsAllocate); Toast.success(`Allocation: ${result.allocation.state}`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    }));
    this._container.querySelectorAll('[data-gc-finops-export]').forEach(button => button.addEventListener('click', () => this._finopsExport(button.dataset.gcFinopsExport, button.dataset.format)));
    this._container.querySelectorAll('[data-gc-finops-idle]').forEach(button => button.addEventListener('click', () => this._finopsIdleDialog(button.dataset.gcFinopsIdle)));
    this._container.querySelectorAll('[data-gc-finops-oversized]').forEach(button => button.addEventListener('click', () => this._finopsOversizedDialog(button.dataset.gcFinopsOversized)));
    this._container.querySelectorAll('[data-gc-finops-evaluate-alerts]').forEach(button => button.addEventListener('click', async () => {
      try { const result = await Api.evaluateFinOpsBudgetAlerts(button.dataset.gcFinopsEvaluateAlerts); Toast.success(`${result.created} budget notifications queued`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    }));
    this._container.querySelectorAll('[data-gc-finops-evaluate-anomalies]').forEach(button => button.addEventListener('click', async () => {
      try { const result = await Api.evaluateFinOpsAnomalies(button.dataset.gcFinopsEvaluateAnomalies); Toast.success(`${result.created} cost anomalies recorded`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    }));
    this._container.querySelectorAll('[data-gc-finops-execute-schedule]').forEach(button => button.addEventListener('click', () => this._finopsExecuteScheduleDialog(button.dataset.gcFinopsExecuteSchedule)));
    this._container.querySelectorAll('[data-gc-controller-run]').forEach(button => button.addEventListener('click', async () => {
      try { await Api.runInfrastructureController(button.dataset.gcControllerRun); Toast.success('Controller evaluated; no provider mutation scheduled'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    }));
    this._container.querySelectorAll('[data-gc-controller-resume]').forEach(button => button.addEventListener('click', async () => {
      try { await Api.resumeInfrastructureController(button.dataset.gcControllerResume); Toast.success('Controller resumed explicitly'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    }));
    this._container.querySelectorAll('[data-gc-reconcile-approve]').forEach(button => button.addEventListener('click', () => this._approveInfrastructureReconcile(button.dataset.gcReconcileApprove)));
    this._container.querySelectorAll('[data-gc-reconcile-apply]').forEach(button => button.addEventListener('click', () => this._applyInfrastructureReconcile(button.dataset.gcReconcileApply)));
    this._container.querySelectorAll('[data-gc-external-authorize]').forEach(button => button.addEventListener('click', () => this._authorizeInfrastructureExternal(button.dataset.gcExternalAuthorize)));
    this._container.querySelectorAll('[data-gc-renew-lease]').forEach(button => button.addEventListener('click', () => this._renewLease(button.dataset.gcRenewLease)));
    this._container.querySelectorAll('[data-gc-clean-lease]').forEach(button => button.addEventListener('click', async () => {
      if (!await Modal.confirm('Attest that provider cleanup is complete?', { danger: true })) return;
      try { await Api.releaseResourceLease(button.dataset.gcCleanLease, true); Toast.success('Cleanup attested'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
    }));
    this._container.querySelectorAll('[data-gc-open-review]').forEach(button => button.addEventListener('click', () => this._openReview(button.dataset.gcOpenReview)));
    this._bindDelete('[data-gc-delete-policy]', id => Api.deleteApprovalPolicy(id));
    this._bindDelete('[data-gc-delete-realm]', id => Api.deleteIdentityRealm(id));
    this._bindDelete('[data-gc-revoke-token]', id => Api.revokeServiceToken(id));
    this._bindDelete('[data-gc-delete-trust]', id => Api.deleteWorkloadTrust(id));
    this._bindDelete('[data-gc-delete-blackout]', id => Api.deleteBlackout(id));
    this._container.querySelectorAll('[data-gc-rotate-token]').forEach(button => button.addEventListener('click', async () => {
      try { const result = await Api.rotateServiceToken(button.dataset.gcRotateToken, { ttlSeconds: 3600 }); this._showSecret(result.token.token); } catch (error) { Toast.error(error.message); }
    }));
    for (const decision of ['approve', 'reject']) this._container.querySelectorAll(`[data-gc-${decision}]`).forEach(button => button.addEventListener('click', () => this._decide(button.dataset[`gc${decision[0].toUpperCase()}${decision.slice(1)}`], decision)));
  },
  _bindDelete(selector, action) { this._container.querySelectorAll(selector).forEach(button => button.addEventListener('click', async () => {
    if (!await Modal.confirm('Confirm this irreversible control-plane change?', { danger: true })) return;
    try { await action(button.dataset[Object.keys(button.dataset)[0]]); Toast.success('Saved'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  })); },
  _projectOptions() { return this._data.projects.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join(''); },
  _userOptions() { return (this._data.subjects.users || []).map(item => `<option value="${item.id}">${Utils.escapeHtml(item.username)}</option>`).join(''); },
  async _submit(action) { try { return await action(); } catch (error) { Toast.error(error.message); throw error; } },

  async _leasePolicyDialog() {
    const result = await Modal.form(`<div class="form-group"><label>Project</label><select id="gc-project" class="form-control">${this._projectOptions()}</select></div>
      <div class="form-row"><div class="form-group"><label>Resource type</label><input id="gc-type" class="form-control" value="vm"></div><div class="form-group"><label>Maximum TTL (hours)</label><input id="gc-ttl" type="number" min="1" max="8760" value="24" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Renewal right</label><select id="gc-mode" class="form-control"><option value="holder">lease holder</option><option value="cleanup_owner">cleanup owner</option><option value="admin">global admin</option></select></div><div class="form-group"><label>Maximum renewals</label><input id="gc-renewals" type="number" min="0" max="10000" value="12" class="form-control"></div></div>
      <div class="form-group"><label>Cleanup owner</label><select id="gc-owner" class="form-control">${this._userOptions()}</select></div>`,
    { title: 'Resource lease policy', onSubmit: c => this._submit(() => Api.saveResourceLeasePolicy({ tenantId: Number(c.querySelector('#gc-project').value), resourceType: c.querySelector('#gc-type').value, maxTtlSeconds: Number(c.querySelector('#gc-ttl').value) * 3600, renewalMode: c.querySelector('#gc-mode').value, maxRenewals: Number(c.querySelector('#gc-renewals').value), cleanupOwnerUserId: Number(c.querySelector('#gc-owner').value) })) });
    if (result) { Toast.success('Lease policy saved'); await this.render(this._container); }
  },

  async _leaseDialog() {
    const projectId = await Modal.form(`<div class="form-group"><label>Project</label><select id="gc-project" class="form-control">${this._projectOptions()}</select></div>`,
      { title: 'Select project', confirmText: 'Continue', onSubmit: c => Number(c.querySelector('#gc-project').value) });
    if (!projectId) return;
    try {
      const { project } = await Api.getGovernanceProject(projectId);
      if (!project.resources.length) return Toast.warning('This project has no accounted resources');
      const local = date => new Date(date - new Date(date).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const result = await Modal.form(`<div class="form-group"><label>Resource</label><select id="gc-resource" class="form-control">${project.resources.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.displayName)} · ${Utils.escapeHtml(item.resourceType)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Lease holder</label><select id="gc-holder" class="form-control">${this._userOptions()}</select></div><div class="form-group"><label>Expires</label><input id="gc-expiry" type="datetime-local" value="${local(Date.now() + 3600000)}" class="form-control"></div>`,
      { title: 'Create resource lease', onSubmit: c => this._submit(() => Api.createResourceLease({ tenantId: projectId, resourceId: Number(c.querySelector('#gc-resource').value), holderUserId: Number(c.querySelector('#gc-holder').value), expiresAt: new Date(c.querySelector('#gc-expiry').value).toISOString() })) });
      if (result) { Toast.success('Lease created'); await this.render(this._container); }
    } catch (error) { Toast.error(error.message); }
  },

  async _renewLease(id) {
    const result = await Modal.form(`<div class="form-group"><label>Renewal TTL (minutes)</label><input id="gc-ttl" type="number" min="5" value="60" class="form-control"></div>`,
      { title: 'Renew resource lease', onSubmit: c => this._submit(() => Api.renewResourceLease(id, { ttlSeconds: Number(c.querySelector('#gc-ttl').value) * 60 })) });
    if (result) { Toast.success('Lease renewed'); await this.render(this._container); }
  },

  async _ownershipDialog() {
    const projectId = await Modal.form(`<div class="form-group"><label>Project</label><select id="gc-project" class="form-control">${this._projectOptions()}</select></div>`,
      { title: 'Ownership policy', confirmText: 'Continue', onSubmit: c => Number(c.querySelector('#gc-project').value) });
    if (!projectId) return;
    try {
      const [{ project }, state] = await Promise.all([Api.getGovernanceProject(projectId), Api.getProjectOwnershipPolicy(projectId)]);
      const policy = state.policy || {};
      const result = await Modal.form(`<div class="form-group"><label>Resource</label><select id="gc-resource" class="form-control"><option value="">Policy only</option>${project.resources.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.displayName)}</option>`).join('')}</select></div>
        <div class="form-row"><div class="form-group"><label>Owner</label><select id="gc-owner" class="form-control"><option value="">Not assigned</option>${this._userOptions()}</select></div><div class="form-group"><label>Environment</label><select id="gc-env" class="form-control"><option>production</option><option>nonproduction</option></select></div></div>
        <div class="form-row"><div class="form-group"><label>Service</label><input id="gc-service" class="form-control"></div><div class="form-group"><label>Cost center</label><input id="gc-cost" class="form-control"></div></div>
        <div class="card" style="padding:12px"><strong>Production completeness policy</strong><div style="display:flex;gap:15px;flex-wrap:wrap;margin-top:8px"><label><input id="gc-req-owner" type="checkbox" ${policy.require_owner !== 0 ? 'checked' : ''}> owner</label><label><input id="gc-req-service" type="checkbox" ${policy.require_service !== 0 ? 'checked' : ''}> service</label><label><input id="gc-req-cost" type="checkbox" ${policy.require_cost_center !== 0 ? 'checked' : ''}> cost center</label></div></div>`,
      { title: 'Production resource ownership', width: '760px', onSubmit: c => this._submit(async () => {
        await Api.saveProjectOwnershipPolicy(projectId, { requireOwner: c.querySelector('#gc-req-owner').checked, requireService: c.querySelector('#gc-req-service').checked, requireCostCenter: c.querySelector('#gc-req-cost').checked, enforceProduction: true, enabled: true });
        const resourceId = c.querySelector('#gc-resource').value;
        if (resourceId) return Api.saveResourceOwnership(resourceId, { tenantId: projectId, ownerUserId: c.querySelector('#gc-owner').value ? Number(c.querySelector('#gc-owner').value) : null, environment: c.querySelector('#gc-env').value, serviceName: c.querySelector('#gc-service').value || null, costCenter: c.querySelector('#gc-cost').value || null });
        return true;
      }) });
      if (result) { Toast.success('Ownership controls saved'); await this.render(this._container); }
    } catch (error) { Toast.error(error.message); }
  },

  async _sodDialog() {
    const roles = this._data.governanceCatalog.roles || [];
    const options = roles.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('');
    const result = await Modal.form(`<div class="form-group"><label>Rule name</label><input id="gc-name" class="form-control"></div><div class="form-row"><div class="form-group"><label>First conflicting role</label><select id="gc-left" class="form-control">${options}</select></div><div class="form-group"><label>Second conflicting role</label><select id="gc-right" class="form-control">${options}</select></div></div><div class="form-group"><label>Severity</label><select id="gc-severity" class="form-control"><option>medium</option><option selected>high</option><option>critical</option></select></div>`,
      { title: 'Separation-of-duties rule', onSubmit: c => this._submit(() => Api.createSeparationOfDutiesRule({ name: c.querySelector('#gc-name').value, leftRoleId: Number(c.querySelector('#gc-left').value), rightRoleId: Number(c.querySelector('#gc-right').value), severity: c.querySelector('#gc-severity').value })) });
    if (result) { Toast.success('SoD rule saved'); await this.render(this._container); }
  },

  async _reviewDialog() {
    const result = await Modal.form(`<div class="form-group"><label>Campaign name</label><input id="gc-name" class="form-control"></div><div class="form-group"><label>Project</label><select id="gc-project" class="form-control"><option value="">All projects</option>${this._projectOptions()}</select></div><div class="form-row"><div class="form-group"><label>Review</label><select id="gc-kind" class="form-control"><option value="all">roles + service accounts</option><option value="access">roles only</option><option value="service_accounts">service accounts only</option></select></div><div class="form-group"><label>Due in days</label><input id="gc-days" type="number" min="1" max="365" value="30" class="form-control"></div></div>`,
      { title: 'Access review campaign', onSubmit: c => this._submit(() => Api.createAccessReviewCampaign({ name: c.querySelector('#gc-name').value, tenantId: c.querySelector('#gc-project').value ? Number(c.querySelector('#gc-project').value) : null, reviewKind: c.querySelector('#gc-kind').value, dueAt: new Date(Date.now() + Number(c.querySelector('#gc-days').value) * 86400000).toISOString() })) });
    if (result) { Toast.success('Access review created'); await this.render(this._container); }
  },

  async _openReview(id) {
    try {
      const result = await Api.getAccessReviewCampaign(id); const campaign = result.campaign; const items = result.items || [];
      Modal.open(`<div class="modal-header"><h3>${Utils.escapeHtml(campaign?.name || 'Access review')}</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><table class="data-table"><thead><tr><th>Subject</th><th>Evidence</th><th>Decision</th><th></th></tr></thead><tbody>${items.map(item => `<tr><td><strong>${Utils.escapeHtml(item.subject_label)}</strong><div class="text-xs text-muted">${item.subject_type}</div></td><td class="mono text-xs">${Utils.escapeHtml(JSON.stringify(item.evidence || {}))}</td><td>${item.decision}</td><td>${item.decision === 'pending' ? `<button class="action-btn success" data-gc-review-keep="${item.id}" title="Keep"><i class="fas fa-check"></i></button><button class="action-btn danger" data-gc-review-revoke="${item.id}" title="Revoke"><i class="fas fa-user-minus"></i></button>` : ''}</td></tr>`).join('') || this._empty('No review items', 4)}</tbody></table><div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-primary btn-sm" id="gc-complete-review">Complete campaign</button></div></div>`, { width: '900px' });
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
      for (const decision of ['keep','revoke']) Modal._content.querySelectorAll(`[data-gc-review-${decision}]`).forEach(button => button.addEventListener('click', async () => { try { await Api.decideAccessReviewItem(id, button.dataset[`gcReview${decision[0].toUpperCase()}${decision.slice(1)}`], { decision }); Toast.success('Decision saved'); Modal.close(); await this.render(this._container); } catch (error) { Toast.error(error.message); } }));
      Modal._content.querySelector('#gc-complete-review').addEventListener('click', async () => { try { await Api.completeAccessReviewCampaign(id); Toast.success('Campaign completed'); Modal.close(); await this.render(this._container); } catch (error) { Toast.error(error.message); } });
    } catch (error) { Toast.error(error.message); }
  },

  async _offboardingDialog() {
    const projectId = await Modal.form(`<div class="form-group"><label>Project to export</label><select id="gc-project" class="form-control">${this._projectOptions()}</select></div><p class="text-muted text-sm">Export is always created first. Deletion remains blocked for the default or active project, active leases/reviews, incomplete ownership, or an expired export.</p>`,
      { title: 'Tenant portability and offboarding', confirmText: 'Create export', onSubmit: c => Number(c.querySelector('#gc-project').value) });
    if (!projectId) return;
    try {
      const result = await Api.exportGovernanceTenant(projectId); const exported = result.export;
      Modal.open(`<div class="modal-header"><h3>Tenant export ready</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><div class="form-group"><label>SHA-256</label><input class="form-control mono" readonly value="${exported.checksumSha256}"></div><p>${exported.byteSize.toLocaleString()} bytes · expires ${new Date(exported.expiresAt).toLocaleString()}</p><div style="display:flex;justify-content:flex-end"><button class="btn btn-danger" id="gc-plan-offboard">Evaluate offboarding</button></div></div>`);
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#gc-plan-offboard').addEventListener('click', async () => { try { const planned = (await Api.planGovernanceTenantOffboarding(projectId, exported.id)).request; Modal.close(); if (planned.state !== 'ready') return Modal.open(`<div class="modal-header"><h3>Offboarding blocked</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><ul>${planned.blockers.map(item => `<li><strong>${item.code}</strong> — ${Utils.escapeHtml(item.message || '')}</li>`).join('')}</ul></div>`), Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close()); const confirmation = await Modal.form(`<p class="text-danger">This permanently deletes the non-default tenant control-plane data. Provider resources are not deleted.</p><div class="form-group"><label>Type ${Utils.escapeHtml(planned.requiredConfirmation)}</label><input id="gc-confirm" class="form-control mono"></div><div class="form-group"><label>Confirm export SHA-256</label><input id="gc-checksum" class="form-control mono" value="${exported.checksumSha256}"></div>`, { title: 'Complete tenant offboarding', confirmText: 'Delete tenant', danger: true, onSubmit: c => ({ confirmation: c.querySelector('#gc-confirm').value, checksumSha256: c.querySelector('#gc-checksum').value }) }); if (confirmation) { await Api.completeGovernanceTenantOffboarding(planned.id, confirmation); Toast.success('Tenant offboarding completed'); await this.render(this._container); } } catch (error) { Toast.error(error.message); } });
    } catch (error) { Toast.error(error.message); }
  },

  async _metricsPolicyDialog() {
    const result = await Modal.form(`<div class="form-group"><label>Provider host ID (0 = defaults)</label><input id="gc-host" type="number" min="0" value="0" class="form-control"></div><div class="form-row"><div class="form-group"><label>Active interval (seconds)</label><input id="gc-active" type="number" min="10" value="30" class="form-control"></div><div class="form-group"><label>Idle interval (seconds)</label><input id="gc-idle" type="number" min="30" value="300" class="form-control"></div><div class="form-group"><label>Rate budget / minute</label><input id="gc-rate" type="number" min="1" value="120" class="form-control"></div></div><div class="form-row"><div class="form-group"><label>Resources / batch</label><input id="gc-resources" type="number" min="1" value="1000" class="form-control"></div><div class="form-group"><label>Metrics / resource</label><input id="gc-metrics" type="number" min="1" value="24" class="form-control"></div><div class="form-group"><label>Series / batch</label><input id="gc-series" type="number" min="1" value="5000" class="form-control"></div></div>`,
      { title: 'Adaptive polling and cardinality', width: '800px', onSubmit: c => this._submit(async () => { const hostId = Number(c.querySelector('#gc-host').value); await Api.saveVmMetricPollingPolicy(hostId, { activeIntervalSeconds: Number(c.querySelector('#gc-active').value), idleIntervalSeconds: Number(c.querySelector('#gc-idle').value), hiddenMultiplier: 4, rateBudgetPerMinute: Number(c.querySelector('#gc-rate').value), activityWindowSeconds: 300 }); return Api.saveVmMetricCardinalityPolicy(hostId, { maxResourcesPerBatch: Number(c.querySelector('#gc-resources').value), maxMetricsPerResource: Number(c.querySelector('#gc-metrics').value), maxLabelKeys: 8, maxLabelValueLength: 120, maxSeriesPerBatch: Number(c.querySelector('#gc-series').value) }); }) });
    if (result) { Toast.success('Metrics policies saved'); await this.render(this._container); }
  },

  async _capacityDialog() {
    const select = await Modal.form(`<div class="form-group"><label>Project</label><select id="gc-project" class="form-control">${this._projectOptions()}</select></div>`,
      { title: 'Project capacity', confirmText: 'Open', onSubmit: c => Number(c.querySelector('#gc-project').value) });
    if (!select) return;
    try {
      const state = await Api.getProjectCapacity(select);
      const rows = Object.entries(state.metrics).map(([metric, quota]) => `<tr><td class="mono">${metric}</td><td>${quota.usage.toLocaleString()}</td><td>${quota.softLimit ?? '∞'}</td><td>${quota.hardLimit ?? '∞'}</td><td>${quota.state}</td></tr>`).join('');
      const allocations = state.allocations.map(item => `<tr><td>${Utils.escapeHtml(item.resource_type)}<div class="mono text-xs">${Utils.escapeHtml(item.resource_key)}</div></td><td class="mono">${item.metric}</td><td>${item.amount.toLocaleString()}</td><td>${Utils.escapeHtml(item.profile || '—')}</td><td><button class="action-btn danger" data-gc-remove-allocation="${item.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('');
      Modal.open(`<div class="modal-header"><h3>Extended capacity</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><div style="display:flex;justify-content:flex-end;gap:7px;margin-bottom:12px"><button class="btn btn-secondary btn-sm" id="gc-set-capacity-quota"><i class="fas fa-gauge"></i> Set quota</button><button class="btn btn-primary btn-sm" id="gc-add-allocation"><i class="fas fa-plus"></i> Account allocation</button></div><table class="data-table"><thead><tr><th>Metric</th><th>Used</th><th>Soft</th><th>Hard</th><th>State</th></tr></thead><tbody>${rows}</tbody></table><h4 style="margin-top:18px">Allocations</h4><table class="data-table"><thead><tr><th>Resource</th><th>Metric</th><th>Amount</th><th>Profile</th><th></th></tr></thead><tbody>${allocations || this._empty('No allocations', 5)}</tbody></table><p class="text-muted text-sm" style="margin-top:12px">Every change is audited; provider resources are not modified.</p></div>`, { width: '950px' });
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#gc-set-capacity-quota').addEventListener('click', () => { Modal.close(); setTimeout(() => this._capacityQuotaForm(select), 220); });
      Modal._content.querySelector('#gc-add-allocation').addEventListener('click', () => { Modal.close(); setTimeout(() => this._capacityAllocationForm(select), 220); });
      Modal._content.querySelectorAll('[data-gc-remove-allocation]').forEach(button => button.addEventListener('click', async () => {
        try { await Api.removeProjectCapacity(select, button.dataset.gcRemoveAllocation); Toast.success('Allocation removed'); Modal.close(); await this.render(this._container); }
        catch (error) { Toast.error(error.message); }
      }));
    } catch (error) { Toast.error(error.message); }
  },
  async _capacityQuotaForm(projectId) {
    const result = await Modal.form(`<div class="form-group"><label>Metric</label><select id="gc-metric" class="form-control">${this._data.catalog.capacityMetrics.map(item => `<option>${item}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Soft limit (blank = unlimited)</label><input id="gc-soft" type="number" min="0" class="form-control"></div><div class="form-group"><label>Hard limit (blank = unlimited)</label><input id="gc-hard" type="number" min="0" class="form-control"></div></div>`, { title: 'Set extended quota', onSubmit: c => this._submit(() => {
      const metric = c.querySelector('#gc-metric').value;
      const value = id => c.querySelector(id).value === '' ? null : Number(c.querySelector(id).value);
      return Api.setProjectCapacityQuotas(projectId, { [metric]: { softLimit: value('#gc-soft'), hardLimit: value('#gc-hard') } });
    }) });
    if (result) { Toast.success('Quota saved'); await this.render(this._container); }
  },
  async _capacityAllocationForm(projectId) {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Metric</label><select id="gc-metric" class="form-control">${this._data.catalog.capacityMetrics.map(item => `<option>${item}</option>`).join('')}</select></div><div class="form-group"><label>Amount</label><input id="gc-amount" type="number" min="0" class="form-control"></div></div><div class="form-row"><div class="form-group"><label>Resource type</label><input id="gc-type" class="form-control" placeholder="vm, network, backup"></div><div class="form-group"><label>Resource key</label><input id="gc-key" class="form-control mono"></div></div><div class="form-group"><label>GPU/device profile (optional)</label><input id="gc-profile" class="form-control" placeholder="A10, MIG-1g.10gb"></div>`, { title: 'Account capacity allocation', onSubmit: c => this._submit(() => Api.assignProjectCapacity(projectId, { metric: c.querySelector('#gc-metric').value, amount: Number(c.querySelector('#gc-amount').value), resourceType: c.querySelector('#gc-type').value, resourceKey: c.querySelector('#gc-key').value, profile: c.querySelector('#gc-profile').value || null })) });
    if (result) { Toast.success('Allocation saved'); await this.render(this._container); }
  },
  async _quotaRequestDialog() {
    const result = await Modal.form(`<div class="form-group"><label>Project</label><select id="gc-project" class="form-control">${this._projectOptions()}</select></div>
      <div class="form-group"><label>Metric</label><select id="gc-metric" class="form-control">${this._data.catalog.capacityMetrics.map(item => `<option>${item}</option>`).join('')}</select></div>
      <div class="form-row"><div class="form-group"><label>Soft limit</label><input id="gc-soft" type="number" min="0" class="form-control"></div><div class="form-group"><label>Hard limit</label><input id="gc-hard" type="number" min="0" class="form-control"></div></div>
      <div class="form-group"><label>Duration (hours)</label><input id="gc-hours" type="number" min="1" max="720" value="24" class="form-control"></div><div class="form-group"><label>Business reason</label><textarea id="gc-reason" class="form-control" rows="3"></textarea></div>`,
      { title: 'Request temporary quota', onSubmit: c => this._submit(() => {
        const metric = c.querySelector('#gc-metric').value;
        return Api.requestQuota(Number(c.querySelector('#gc-project').value), {
          limits: { [metric]: { softLimit: Number(c.querySelector('#gc-soft').value), hardLimit: Number(c.querySelector('#gc-hard').value) } },
          durationSeconds: Number(c.querySelector('#gc-hours').value) * 3600,
          reason: c.querySelector('#gc-reason').value,
        });
      }) });
    if (result) { Toast.success('Approval request created'); await this.render(this._container); }
  },
  async _policyDialog() {
    const result = await Modal.form(`<div class="form-group"><label>Name</label><input id="gc-name" class="form-control"></div><div class="form-group"><label>Action pattern</label><input id="gc-action" class="form-control mono" value="POST /api/*"></div>
      <div class="form-row"><div class="form-group"><label>Environment</label><select id="gc-env" class="form-control"><option>any</option><option>production</option><option>nonproduction</option></select></div><div class="form-group"><label>Minimum risk (1–4)</label><input id="gc-risk" type="number" min="1" max="4" value="2" class="form-control"></div><div class="form-group"><label>Approvals</label><select id="gc-count" class="form-control"><option>1</option><option selected>2</option></select></div></div>`,
      { title: 'Approval policy', onSubmit: c => this._submit(() => Api.createApprovalPolicy({ name: c.querySelector('#gc-name').value, actionPattern: c.querySelector('#gc-action').value, environment: c.querySelector('#gc-env').value, minimumRisk: Number(c.querySelector('#gc-risk').value), approvalsRequired: Number(c.querySelector('#gc-count').value), requesterCannotApprove: true })) });
    if (result) await this.render(this._container);
  },
  async _decide(id, decision) {
    const result = await Modal.form(`<div class="form-group"><label>Decision comment</label><textarea id="gc-comment" class="form-control" rows="3"></textarea></div>`,
      { title: `${decision[0].toUpperCase()}${decision.slice(1)} request`, confirmText: decision, onSubmit: c => this._submit(() => Api.decideApprovalRequest(id, decision, c.querySelector('#gc-comment').value)) });
    if (result) await this.render(this._container);
  },
  async _realmDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-name" class="form-control"></div><div class="form-group"><label>Slug</label><input id="gc-slug" class="form-control"></div></div><div class="form-row"><div class="form-group"><label>Protocol</label><select id="gc-protocol" class="form-control"><option>oidc</option><option>saml</option></select></div><div class="form-group"><label>Domains (comma-separated)</label><input id="gc-domains" class="form-control" placeholder="example.com"></div></div><div class="form-group"><label>Broker/native login URL</label><input id="gc-login" class="form-control" value="/api/auth/oidc/login"></div><div class="form-group"><label>Issuer URL (OIDC)</label><input id="gc-issuer" class="form-control" placeholder="https://idp.example.com/"></div><div class="form-group"><label>Metadata URL (SAML)</label><input id="gc-metadata" class="form-control" placeholder="https://broker.example.com/saml/metadata"></div>`,
      { title: 'Federation realm', onSubmit: c => this._submit(() => Api.createIdentityRealm({ name: c.querySelector('#gc-name').value, slug: c.querySelector('#gc-slug').value, protocol: c.querySelector('#gc-protocol').value, domains: c.querySelector('#gc-domains').value.split(',').map(v => v.trim()).filter(Boolean), loginUrl: c.querySelector('#gc-login').value, issuerUrl: c.querySelector('#gc-issuer').value || null, metadataUrl: c.querySelector('#gc-metadata').value || null })) });
    if (result) await this.render(this._container);
  },
  _scopeChecks(prefix) { return this._data.catalog.serviceScopes.map(scope => `<label style="display:inline-flex;gap:5px;margin:5px 12px 5px 0"><input type="checkbox" data-${prefix}-scope value="${scope}"> <span class="mono text-sm">${scope}</span></label>`).join(''); },
  async _tokenDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-name" class="form-control"></div><div class="form-group"><label>Principal</label><input id="gc-principal" class="form-control" placeholder="ci:deploy"></div></div><div class="form-group"><label>TTL (minutes, max 1440)</label><input id="gc-ttl" type="number" min="1" max="1440" value="60" class="form-control"></div><div class="form-group"><label>Scopes</label><div>${this._scopeChecks('gc')}</div></div>`,
      { title: 'Issue short-lived token', onSubmit: c => this._submit(() => Api.issueServiceToken({ name: c.querySelector('#gc-name').value, principal: c.querySelector('#gc-principal').value, ttlSeconds: Number(c.querySelector('#gc-ttl').value) * 60, scopes: [...c.querySelectorAll('[data-gc-scope]:checked')].map(item => item.value) })) });
    if (result?.token?.token) this._showSecret(result.token.token);
  },
  _showSecret(secret) { Modal.open(`<div class="modal-header"><h3>Secret shown once</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><p class="text-muted">Copy it now. Only its SHA-256 hash is retained.</p><textarea class="form-control mono" rows="4" readonly>${Utils.escapeHtml(secret)}</textarea></div>`); Modal._content.querySelector('#gc-close').addEventListener('click', () => { Modal.close(); this.render(this._container); }); },
  async _trustDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-name" class="form-control"></div><div class="form-group"><label>Kind</label><select id="gc-kind" class="form-control">${this._data.catalog.workloadIdentityKinds.map(item => `<option>${item}</option>`).join('')}</select></div></div><div class="form-group"><label>Issuer</label><input id="gc-issuer" class="form-control"></div><div class="form-group"><label>Audience</label><input id="gc-audience" class="form-control"></div><div class="form-group"><label>Subject glob</label><input id="gc-subject" class="form-control mono" value="*"></div><div class="form-group"><label>Public JWKS JSON</label><textarea id="gc-jwks" class="form-control mono" rows="7" placeholder='{"keys":[...]}'></textarea></div><div class="form-group"><label>Scopes</label>${this._scopeChecks('gc')}</div>`,
      { title: 'Workload identity trust', width: '760px', onSubmit: c => this._submit(() => Api.createWorkloadTrust({ name: c.querySelector('#gc-name').value, identityKind: c.querySelector('#gc-kind').value, issuer: c.querySelector('#gc-issuer').value, audience: c.querySelector('#gc-audience').value, subjectPattern: c.querySelector('#gc-subject').value, jwks: JSON.parse(c.querySelector('#gc-jwks').value), scopes: [...c.querySelectorAll('[data-gc-scope]:checked')].map(item => item.value), tokenTtlSeconds: 900 })) });
    if (result) await this.render(this._container);
  },
  async _blackoutDialog() {
    const local = date => new Date(date - new Date(date).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const now = Date.now();
    const result = await Modal.form(`<div class="form-group"><label>Name</label><input id="gc-name" class="form-control"></div><div class="form-group"><label>Action pattern</label><input id="gc-action" class="form-control mono" value="* /api/*"></div><div class="form-row"><div class="form-group"><label>Starts</label><input id="gc-start" type="datetime-local" value="${local(now)}" class="form-control"></div><div class="form-group"><label>Ends</label><input id="gc-end" type="datetime-local" value="${local(now + 3600000)}" class="form-control"></div></div><div class="form-group"><label>Reason</label><textarea id="gc-reason" class="form-control" rows="3"></textarea></div><label><input id="gc-emergency" type="checkbox"> Allow audited emergency override for global admins (ticket + reason headers)</label>`,
      { title: 'Change blackout window', onSubmit: c => this._submit(() => Api.createBlackout({ name: c.querySelector('#gc-name').value, actionPattern: c.querySelector('#gc-action').value, environment: 'any', startsAt: new Date(c.querySelector('#gc-start').value).toISOString(), endsAt: new Date(c.querySelector('#gc-end').value).toISOString(), reason: c.querySelector('#gc-reason').value, allowEmergencyOverride: c.querySelector('#gc-emergency').checked })) });
    if (result) await this.render(this._container);
  },

  async _performanceDialog() {
    const resources = [...new Set((this._data.freshness.resources || []).map(item => item.resource_key))];
    if (!resources.length) return Toast.warning('Ingest VM metrics before opening a performance chart');
    const definitions = this._data.lifecycleCatalog.metrics || [];
    const query = await Modal.form(`<div class="form-row"><div class="form-group"><label>Resources (up to 10)</label><select id="gc-chart-resources" class="form-control" multiple size="7">${resources.map((item, index) => `<option ${index < 2 ? 'selected' : ''}>${Utils.escapeHtml(item)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Metrics (up to 12)</label><select id="gc-chart-metrics" class="form-control" multiple size="7">${definitions.map((item, index) => `<option value="${Utils.escapeHtml(item.metric_key)}" ${index === 0 ? 'selected' : ''}>${Utils.escapeHtml(item.metric_key)}</option>`).join('')}</select></div></div>
      <div class="form-group"><label>Range</label><select id="gc-chart-hours" class="form-control"><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option><option value="744">31 days</option></select></div>`,
    { title: 'VM performance comparison', confirmText: 'Draw chart', width: '760px', onSubmit: c => {
      const resourceKeys = [...c.querySelector('#gc-chart-resources').selectedOptions].map(item => item.value).slice(0, 10);
      const metricKeys = [...c.querySelector('#gc-chart-metrics').selectedOptions].map(item => item.value).slice(0, 12);
      if (!resourceKeys.length || !metricKeys.length) throw new Error('Select at least one resource and metric');
      return { resourceKeys: resourceKeys.join(','), metricKeys: metricKeys.join(','),
        from: new Date(Date.now() - Number(c.querySelector('#gc-chart-hours').value) * 3600000).toISOString() };
    } });
    if (!query) return;
    try {
      const chart = await Api.getVmPerformance(query);
      const labels = [...new Set(chart.series.flatMap(series => series.points.map(point => point.at)))].sort();
      const colors = ['#0ea5e9','#a855f7','#22c55e','#f59e0b','#ef4444','#14b8a6','#f97316','#6366f1','#84cc16','#ec4899'];
      const datasets = chart.series.map((series, index) => { const values = new Map(series.points.map(point => [point.at, point.value])); return {
        label: `${series.resourceKey} · ${series.metricKey}`, data: labels.map(label => values.has(label) ? values.get(label) : null),
        borderColor: colors[index % colors.length], backgroundColor: colors[index % colors.length], pointRadius: 1, tension: 0.2, spanGaps: true,
      }; });
      const annotations = chart.annotations.map(item => `<tr><td>${new Date(item.occurred_at).toLocaleString()}</td><td>${Utils.escapeHtml(item.title)}</td><td class="mono text-xs">${Utils.escapeHtml(item.resource_key)}</td><td>${item.repeat_count}</td></tr>`).join('');
      Modal.open(`<div class="modal-header"><h3>VM performance comparison</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><div style="height:390px"><canvas id="gc-performance-canvas"></canvas></div><h4 style="margin-top:18px">Event annotations</h4><table class="data-table"><thead><tr><th>Time</th><th>Event</th><th>Resource</th><th>Repeats</th></tr></thead><tbody>${annotations || this._empty('No events in this range', 4)}</tbody></table></div>`, { width: '1100px' });
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
      const canvas = Modal._content.querySelector('#gc-performance-canvas');
      new Chart(canvas, { type: 'line', data: { labels: labels.map(item => new Date(item).toLocaleString()), datasets },
        options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } } });
    } catch (error) { Toast.error(error.message); }
  },

  async _eventDialog() {
    const adapters = this._data.observabilityCatalog.eventAdapters;
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Adapter</label><select id="gc-event-adapter" class="form-control">${adapters.map(item => `<option value="${item.key}">${item.key}</option>`).join('')}</select></div><div class="form-group"><label>Native event ID (optional)</label><input id="gc-event-id" class="form-control mono"></div></div>
      <div class="form-row"><div class="form-group"><label>Resource type</label><input id="gc-event-resource-type" class="form-control" value="vm"></div><div class="form-group"><label>Resource key</label><input id="gc-event-resource-key" class="form-control mono"></div></div>
      <div class="form-row"><div class="form-group"><label>Event type</label><input id="gc-event-type" class="form-control mono" value="GuestAlert"></div><div class="form-group"><label>Category / severity</label><div style="display:flex;gap:6px"><select id="gc-event-category" class="form-control"><option>alert</option><option>state</option><option>task</option><option>config</option><option>lifecycle</option><option>fabric</option><option>security</option></select><select id="gc-event-severity" class="form-control"><option>info</option><option>warning</option><option>high</option><option>critical</option></select></div></div></div>
      <div class="form-group"><label>Title</label><input id="gc-event-title" class="form-control"></div><div class="form-group"><label>Message</label><textarea id="gc-event-message" class="form-control" rows="3"></textarea></div>`,
    { title: 'Ingest normalized event evidence', onSubmit: c => this._submit(() => Api.ingestVmObservabilityEvents({
      adapter: c.querySelector('#gc-event-adapter').value, events: [{ nativeEventId: c.querySelector('#gc-event-id').value || undefined,
        resourceType: c.querySelector('#gc-event-resource-type').value, resourceKey: c.querySelector('#gc-event-resource-key').value,
        eventType: c.querySelector('#gc-event-type').value, category: c.querySelector('#gc-event-category').value,
        severity: c.querySelector('#gc-event-severity').value, title: c.querySelector('#gc-event-title').value,
        message: c.querySelector('#gc-event-message').value || undefined, occurredAt: new Date().toISOString() }] })) });
    if (result) { Toast.success(`${result.inserted} inserted, ${result.duplicates} deduplicated`); await this.render(this._container); }
  },

  async _timelineDialog() {
    const resourceKey = await Modal.form(`<div class="form-group"><label>Resource key (blank = all)</label><input id="gc-timeline-resource" class="form-control mono"></div>`,
      { title: 'Correlation timeline', confirmText: 'Load', onSubmit: c => c.querySelector('#gc-timeline-resource').value.trim() });
    if (resourceKey === undefined || resourceKey === null) return;
    try {
      const timeline = await Api.getVmCorrelationTimeline({ hours: 24, ...(resourceKey ? { resourceKey } : {}) });
      const rows = timeline.items.map(item => `<tr><td>${new Date(item.time).toLocaleString()}</td><td><span class="badge badge-secondary">${Utils.escapeHtml(item.kind)}</span></td><td>${Utils.escapeHtml(item.title)}</td><td class="mono text-xs">${Utils.escapeHtml(item.resourceKey || '—')}</td><td>${Utils.escapeHtml(item.severity || 'info')}</td></tr>`).join('');
      Modal.open(`<div class="modal-header"><h3>24-hour correlation timeline</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><table class="data-table"><thead><tr><th>Time</th><th>Kind</th><th>Evidence</th><th>Resource</th><th>Severity</th></tr></thead><tbody>${rows || this._empty('No correlated evidence', 5)}</tbody></table></div>`, { width: '1050px' });
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
    } catch (error) { Toast.error(error.message); }
  },

  async _topologyDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Edges point from an upstream dependency to the resource it can impact.</p><div class="form-row"><div class="form-group"><label>From type</label><input id="gc-top-from-type" class="form-control" value="host"></div><div class="form-group"><label>From key</label><input id="gc-top-from-key" class="form-control mono"></div></div><div class="form-row"><div class="form-group"><label>To type</label><input id="gc-top-to-type" class="form-control" value="vm"></div><div class="form-group"><label>To key</label><input id="gc-top-to-key" class="form-control mono"></div></div><div class="form-group"><label>Relation</label><input id="gc-top-relation" class="form-control" value="runs"></div>`,
    { title: 'Fabric topology edge', onSubmit: c => this._submit(() => Api.saveVmObservabilityTopologyEdge({
      fromType: c.querySelector('#gc-top-from-type').value, fromKey: c.querySelector('#gc-top-from-key').value,
      toType: c.querySelector('#gc-top-to-type').value, toKey: c.querySelector('#gc-top-to-key').value,
      relation: c.querySelector('#gc-top-relation').value, evidence: { source: 'operator' } })) });
    if (result) { Toast.success('Topology edge saved'); await this.render(this._container); }
  },

  async _impactDialog(eventId) {
    try {
      const result = await Api.getVmTopologyImpact(eventId);
      const rows = result.impacted.map(item => `<tr><td>${item.depth}</td><td class="mono">${Utils.escapeHtml(item.type)}:${Utils.escapeHtml(item.key)}</td><td>${Utils.escapeHtml(item.relation)}</td></tr>`).join('');
      Modal.open(`<div class="modal-header"><h3>Fabric impact · ${Utils.escapeHtml(result.event.title)}</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><table class="data-table"><thead><tr><th>Depth</th><th>Impacted resource</th><th>Dependency</th></tr></thead><tbody>${rows || this._empty('No downstream dependencies', 3)}</tbody></table></div>`);
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
    } catch (error) { Toast.error(error.message); }
  },

  async _signalRuleDialog() {
    const definitions = this._data.lifecycleCatalog.metrics || [];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-signal-name" class="form-control"></div><div class="form-group"><label>Severity</label><select id="gc-signal-severity" class="form-control"><option>warning</option><option>high</option><option>critical</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Metric</label><select id="gc-signal-metric" class="form-control">${definitions.map(item => `<option>${Utils.escapeHtml(item.metric_key)}</option>`).join('')}</select></div><div class="form-group"><label>Operator / threshold</label><div style="display:flex;gap:6px"><select id="gc-signal-op" class="form-control"><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option></select><input id="gc-signal-threshold" type="number" step="any" value="0.8" class="form-control"></div></div></div>
      <div class="form-row"><div class="form-group"><label>Event type</label><input id="gc-signal-event" class="form-control mono" value="VmRestarted"></div><div class="form-group"><label>Sustained duration (seconds)</label><input id="gc-signal-duration" type="number" min="0" max="604800" value="60" class="form-control"></div></div>`,
    { title: 'Create metric + event rule', onSubmit: c => this._submit(() => Api.createVmSignalRule({
      name: c.querySelector('#gc-signal-name').value, severity: c.querySelector('#gc-signal-severity').value,
      durationSeconds: Number(c.querySelector('#gc-signal-duration').value), matchMode: 'all', conditions: [
        { type: 'metric', metricKey: c.querySelector('#gc-signal-metric').value, aggregate: 'latest',
          operator: c.querySelector('#gc-signal-op').value, threshold: Number(c.querySelector('#gc-signal-threshold').value), windowSeconds: 300 },
        { type: 'event', eventTypes: [c.querySelector('#gc-signal-event').value], withinSeconds: 300 },
      ] })) });
    if (result) { Toast.success('Multi-signal rule saved'); await this.render(this._container); }
  },

  async _baselineDialog() {
    const definitions = this._data.lifecycleCatalog.metrics || [];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-base-name" class="form-control" value="Seasonal utilization"></div><div class="form-group"><label>Metric</label><select id="gc-base-metric" class="form-control">${definitions.map(item => `<option>${Utils.escapeHtml(item.metric_key)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-group"><label>Resource key (blank = every VM)</label><input id="gc-base-resource" class="form-control mono"></div><div class="form-group"><label>Seasonality</label><select id="gc-base-season" class="form-control"><option value="hour_of_day">hour of day</option><option value="day_of_week">day of week</option><option value="none">none</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Window days</label><input id="gc-base-window" type="number" min="2" max="90" value="14" class="form-control"></div><div class="form-group"><label>Minimum samples</label><input id="gc-base-samples" type="number" min="4" value="20" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Percentile</label><input id="gc-base-percentile" type="number" min="0.5" max="0.999" step="0.001" value="0.95" class="form-control"></div><div class="form-group"><label>Deviation multiplier</label><input id="gc-base-multiplier" type="number" min="1" step="0.1" value="1.5" class="form-control"></div></div>`,
    { title: 'Dynamic baseline policy', onSubmit: c => this._submit(() => Api.createVmDynamicBaseline({
      name: c.querySelector('#gc-base-name').value, metricKey: c.querySelector('#gc-base-metric').value,
      resourceType: 'vm', resourceKey: c.querySelector('#gc-base-resource').value || undefined,
      seasonality: c.querySelector('#gc-base-season').value, windowDays: Number(c.querySelector('#gc-base-window').value),
      minimumSamples: Number(c.querySelector('#gc-base-samples').value), percentile: Number(c.querySelector('#gc-base-percentile').value),
      deviationMultiplier: Number(c.querySelector('#gc-base-multiplier').value),
    })) });
    if (result) { Toast.success('Dynamic baseline saved'); await this.render(this._container); }
  },

  async _maintenanceDialog() {
    const local = date => new Date(date - new Date(date).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const now = Date.now();
    const result = await Modal.form(`<div class="form-group"><label>Name</label><input id="gc-maint-name" class="form-control" value="Planned maintenance"></div>
      <div class="form-row"><div class="form-group"><label>Scope type</label><input id="gc-maint-type" class="form-control" value="vm"></div><div class="form-group"><label>Scope key (* = all)</label><input id="gc-maint-key" class="form-control mono" value="*"></div></div>
      <div class="form-row"><div class="form-group"><label>Starts</label><input id="gc-maint-start" type="datetime-local" class="form-control" value="${local(now)}"></div><div class="form-group"><label>Ends</label><input id="gc-maint-end" type="datetime-local" class="form-control" value="${local(now + 3600000)}"></div></div>
      <div class="form-group"><label>Reason</label><textarea id="gc-maint-reason" class="form-control" rows="3"></textarea></div>`,
    { title: 'Maintenance-aware alerting', onSubmit: c => this._submit(() => Api.createVmObservabilityMaintenance({
      name: c.querySelector('#gc-maint-name').value, scopeType: c.querySelector('#gc-maint-type').value,
      scopeKey: c.querySelector('#gc-maint-key').value, startsAt: new Date(c.querySelector('#gc-maint-start').value).toISOString(),
      endsAt: new Date(c.querySelector('#gc-maint-end').value).toISOString(), reason: c.querySelector('#gc-maint-reason').value,
    })) });
    if (result) { Toast.success('Maintenance window saved'); await this.render(this._container); }
  },

  async _capacityForecastDialog() {
    const resources = [...new Set((this._data.freshness.resources || []).map(item => item.resource_key))];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Resource</label><input id="gc-forecast-resource" list="gc-forecast-resources" class="form-control mono"><datalist id="gc-forecast-resources">${resources.map(item => `<option value="${Utils.escapeHtml(item)}">`).join('')}</datalist></div><div class="form-group"><label>Metric</label><select id="gc-forecast-metric" class="form-control"><option>disk.used_bytes</option><option>memory.used_bytes</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Window days</label><input id="gc-forecast-window" type="number" min="2" max="90" value="30" class="form-control"></div><div class="form-group"><label>Capacity override (optional)</label><input id="gc-forecast-capacity" type="number" min="0" class="form-control"></div></div>`,
    { title: 'Capacity forecast', onSubmit: c => this._submit(() => Api.createVmCapacityForecast({ resourceType: 'vm',
      resourceKey: c.querySelector('#gc-forecast-resource').value, metricKey: c.querySelector('#gc-forecast-metric').value,
      windowDays: Number(c.querySelector('#gc-forecast-window').value),
      ...(c.querySelector('#gc-forecast-capacity').value ? { capacityValue: Number(c.querySelector('#gc-forecast-capacity').value) } : {}),
    })) });
    if (result) { Toast.success(`Forecast: ${result.forecast.status}`); await this.render(this._container); }
  },

  async _runbookDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-runbook-name" class="form-control"></div><div class="form-group"><label>Version</label><input id="gc-runbook-version" class="form-control" value="1.0"></div></div>
      <div class="form-row"><div class="form-group"><label>Event regex</label><input id="gc-runbook-pattern" class="form-control mono" value="restart|failure"></div><div class="form-group"><label>Resource type (optional)</label><input id="gc-runbook-type" class="form-control" value="vm"></div></div>
      <div class="form-row"><div class="form-group"><label>Minimum severity</label><select id="gc-runbook-severity" class="form-control"><option>info</option><option selected>warning</option><option>high</option><option>critical</option></select></div><div class="form-group"><label>Link title</label><input id="gc-runbook-title" class="form-control"></div></div>
      <div class="form-group"><label>Internal path or HTTPS URL</label><input id="gc-runbook-url" class="form-control" value="/docs/features/observability"></div>`,
    { title: 'Recommended runbook link', onSubmit: c => this._submit(() => Api.createVmRunbookMapping({ name: c.querySelector('#gc-runbook-name').value,
      eventPattern: c.querySelector('#gc-runbook-pattern').value, resourceType: c.querySelector('#gc-runbook-type').value || undefined,
      minimumSeverity: c.querySelector('#gc-runbook-severity').value, title: c.querySelector('#gc-runbook-title').value,
      url: c.querySelector('#gc-runbook-url').value, version: c.querySelector('#gc-runbook-version').value,
    })) });
    if (result) { Toast.success('Runbook mapping saved'); await this.render(this._container); }
  },

  async _exportDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-export-name" class="form-control"></div><div class="form-group"><label>Kind</label><select id="gc-export-kind" class="form-control"><option value="webhook">webhook JSON</option><option value="otlp_http">OTLP HTTP JSON</option><option value="syslog_udp">syslog UDP</option><option value="prometheus">Prometheus pull</option></select></div></div>
      <div class="form-group"><label>Endpoint (blank for Prometheus pull)</label><input id="gc-export-endpoint" class="form-control" placeholder="https://collector.example.com/v1/metrics"></div>
      <div class="form-row"><div class="form-group"><label>Residency region</label><input id="gc-export-region" class="form-control" value="local"></div><div class="form-group"><label>Provider host IDs (comma-separated)</label><input id="gc-export-hosts" class="form-control mono" placeholder="0, 7"></div></div>
      <label><input id="gc-export-private" type="checkbox"> Explicitly allow private-network destination</label>`,
    { title: 'Observability export target', onSubmit: c => this._submit(() => Api.createVmObservabilityExport({
      name: c.querySelector('#gc-export-name').value, exportKind: c.querySelector('#gc-export-kind').value,
      endpoint: c.querySelector('#gc-export-endpoint').value || undefined, region: c.querySelector('#gc-export-region').value,
      allowPrivateNetwork: c.querySelector('#gc-export-private').checked, filters: { providerHostIds: c.querySelector('#gc-export-hosts').value
        .split(',').map(item => item.trim()).filter(Boolean).map(Number) },
    })) });
    if (result) { Toast.success('Export target saved; no data was sent'); await this.render(this._container); }
  },

  async _privacyDialog() {
    const hostId = await Modal.form('<div class="form-group"><label>Provider host ID (0 = default)</label><input id="gc-privacy-host" type="number" min="0" value="0" class="form-control"></div>',
      { title: 'Select telemetry scope', confirmText: 'Load policy', onSubmit: c => Number(c.querySelector('#gc-privacy-host').value) });
    if (hostId == null) return;
    try {
      const { policy } = await Api.getVmTelemetryPrivacy(hostId);
      const result = await Modal.form(`<div class="form-group"><label>Redacted label keys (comma-separated)</label><input id="gc-privacy-labels" class="form-control mono" value="${Utils.escapeHtml((policy.redactedLabelKeys || []).join(', '))}"></div>
        <div class="form-row"><div class="form-group"><label>Sampling ratio</label><input id="gc-privacy-sampling" type="number" min="0.01" max="1" step="0.01" value="${policy.sampling_ratio}" class="form-control"></div><div class="form-group"><label>Residency region</label><input id="gc-privacy-region" class="form-control" value="${Utils.escapeHtml(policy.residency_region)}"></div></div>
        <div class="form-row"><div class="form-group"><label>Metric retention days</label><input id="gc-privacy-metric-days" type="number" min="1" max="3650" value="${policy.metric_retention_days}" class="form-control"></div><div class="form-group"><label>Event retention days</label><input id="gc-privacy-event-days" type="number" min="1" max="3650" value="${policy.event_retention_days}" class="form-control"></div></div>
        <label style="display:block"><input id="gc-privacy-message" type="checkbox" ${policy.redact_event_message ? 'checked' : ''}> Redact normalized event messages</label>
        <label style="display:block;margin-top:8px"><input id="gc-privacy-raw" type="checkbox" ${policy.redact_raw_payload ? 'checked' : ''}> Redact raw event payloads</label>`,
      { title: `Telemetry privacy · host ${hostId}`, onSubmit: c => this._submit(() => Api.saveVmTelemetryPrivacy(hostId, {
        redactedLabelKeys: c.querySelector('#gc-privacy-labels').value.split(',').map(item => item.trim()).filter(Boolean),
        samplingRatio: Number(c.querySelector('#gc-privacy-sampling').value), residencyRegion: c.querySelector('#gc-privacy-region').value,
        metricRetentionDays: Number(c.querySelector('#gc-privacy-metric-days').value), eventRetentionDays: Number(c.querySelector('#gc-privacy-event-days').value),
        redactEventMessage: c.querySelector('#gc-privacy-message').checked, redactRawPayload: c.querySelector('#gc-privacy-raw').checked,
      })) });
      if (result) { Toast.success('Telemetry privacy policy saved'); await this.render(this._container); }
    } catch (error) { Toast.error(error.message); }
  },

  async _sloDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-slo-name" class="form-control" value="VM availability"></div><div class="form-group"><label>Resource key</label><input id="gc-slo-resource" class="form-control mono"></div></div>
      <div class="form-row"><div class="form-group"><label>Target ratio</label><input id="gc-slo-target" type="number" min="0.5" max="0.99999" step="0.0001" value="0.999" class="form-control"></div><div class="form-group"><label>Window days</label><input id="gc-slo-days" type="number" min="1" max="365" value="30" class="form-control"></div></div>
      <label><input id="gc-slo-maintenance" type="checkbox" checked> Exclude approved maintenance</label>`,
    { title: 'SLO availability policy', onSubmit: c => this._submit(() => Api.saveVmSlo({ name: c.querySelector('#gc-slo-name').value,
      resourceType: 'vm', resourceKey: c.querySelector('#gc-slo-resource').value, targetRatio: Number(c.querySelector('#gc-slo-target').value),
      windowDays: Number(c.querySelector('#gc-slo-days').value), excludeMaintenance: c.querySelector('#gc-slo-maintenance').checked,
    })) });
    if (result) { Toast.success('SLO policy saved'); await this.render(this._container); }
  },

  async _triageEvent(eventId) {
    try {
      const { report } = await Api.createVmIncidentTriage({ eventId: Number(eventId) });
      const candidates = report.candidates.map(item => `<tr><td>${item.rank}</td><td>${Utils.escapeHtml(item.title)}</td><td class="mono text-xs">${Utils.escapeHtml(item.resourceType)}:${Utils.escapeHtml(item.resourceKey)}</td><td>${(item.score * 100).toFixed(1)}%</td><td>${item.reasons.map(Utils.escapeHtml).join(', ')}</td></tr>`).join('');
      Modal.open(`<div class="modal-header"><h3>Triage assistant</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><p>${Utils.escapeHtml(report.summary)}</p><table class="data-table"><thead><tr><th>Rank</th><th>Candidate</th><th>Resource</th><th>Score</th><th>Evidence</th></tr></thead><tbody>${candidates}</tbody></table><p class="text-muted text-sm" style="margin-top:12px">Candidate ranking is advisory and does not claim causality.</p></div>`, { width: '1000px' });
      Modal._content.querySelector('#gc-close').addEventListener('click', () => { Modal.close(); this.render(this._container); });
    } catch (error) { Toast.error(error.message); }
  },

  async _previewExport(id) {
    try {
      const result = await Api.previewVmObservabilityExport(id);
      Modal.open(`<div class="modal-header"><h3>Export preview · ${Utils.escapeHtml(result.target.name)}</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><p>${result.eventCount} events · ${result.sampleCount} samples · ${Utils.formatBytes(result.byteSize)} · SHA-256 <span class="mono">${result.checksumSha256}</span></p><textarea class="form-control mono" rows="18" readonly>${Utils.escapeHtml(result.preview)}</textarea></div>`, { width: '1000px' });
      Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
    } catch (error) { Toast.error(error.message); }
  },

  async _deliverExport(id) {
    if (!await Modal.confirm('Send this bounded, redacted payload to the configured target now?')) return;
    try { const { delivery } = await Api.deliverVmObservabilityExport(id); Toast.success(`Export ${delivery.status}; ${Utils.formatBytes(delivery.byteSize)}`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _retentionDialog(hostId) {
    try {
      const plan = await Api.getVmTelemetryRetentionPlan(hostId);
      const confirmation = await Modal.form(`<p>This will permanently delete <strong>${plan.metricSamples}</strong> metric samples before ${new Date(plan.metricBefore).toLocaleString()} and <strong>${plan.events}</strong> events before ${new Date(plan.eventBefore).toLocaleString()}.</p><div class="form-group"><label>Type ${plan.confirmation}</label><input id="gc-retention-confirm" class="form-control mono"></div>`,
        { title: `Retention purge · host ${hostId}`, confirmText: 'Delete expired telemetry', danger: true,
          onSubmit: c => c.querySelector('#gc-retention-confirm').value });
      if (!confirmation) return;
      const result = await Api.applyVmTelemetryRetention(hostId, { confirmation });
      Toast.success(`${result.deletedMetricSamples} metrics and ${result.deletedEvents} events deleted`); await this.render(this._container);
    } catch (error) { Toast.error(error.message); }
  },

  _manifestTemplate(kind) {
    const base = { apiVersion: 'docker-dash.io/v1alpha1', kind, metadata: { name: `${kind.toLowerCase()}-intent`, providerHostId: 0, authoritative: false } };
    if (kind === 'VirtualMachine') return { ...base, spec: { hardware: { cpuCount: 2, memoryBytes: 4294967296 },
      image: { imageRef: 'ubuntu:24.04' }, networks: [{ networkRef: 'default', model: 'virtio', connected: true }],
      storage: [{ name: 'root', sizeBytes: 42949672960, storageRef: 'default', boot: true }], policies: [], tags: {}, desiredPowerState: 'unchanged' } };
    if (kind === 'Host') return { ...base, spec: { maintenanceMode: 'normal', tags: {}, policies: [], fabricRefs: [] } };
    return { ...base, spec: { maintenanceMode: 'normal', tags: {}, policies: [], memberRefs: [] } };
  },

  async _infrastructureManifestDialog(kind) {
    const template = JSON.stringify(this._manifestTemplate(kind), null, 2);
    const result = await Modal.form(`<p class="text-muted text-sm">Secret-free desired state only. Validation and hashing happen before persistence; this action performs no provider mutation.</p>
      <div class="form-group"><label>${Utils.escapeHtml(kind)} manifest JSON</label><textarea id="gc-infra-manifest-json" class="form-control mono" rows="22">${Utils.escapeHtml(template)}</textarea></div>
      <div class="form-group"><label>Resource versions JSON</label><textarea id="gc-infra-manifest-versions" class="form-control mono" rows="3">{}</textarea></div>`,
    { title: `${kind} manifest`, width: '920px', confirmText: 'Validate & save', onSubmit: c => this._submit(async () => {
      const document = JSON.parse(c.querySelector('#gc-infra-manifest-json').value);
      const resourceVersions = JSON.parse(c.querySelector('#gc-infra-manifest-versions').value);
      await Api.validateInfrastructureManifest(document);
      return Api.saveInfrastructureManifest({ document, resourceVersions });
    }) });
    if (result) { Toast.success(`Manifest revision ${result.manifest.revision} saved`); await this.render(this._container); }
  },

  async _infrastructurePlanDialog() {
    const manifests = this._data.infrastructureAutomation?.manifests || [];
    if (!manifests.length) return Toast.warning('Save a VM, host or fabric manifest first');
    const selectedId = await Modal.form(`<div class="form-group"><label>Manifest</label><select id="gc-infra-plan-manifest" class="form-control">${manifests.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.kind)} · ${Utils.escapeHtml(item.name)} · r${item.revision}</option>`).join('')}</select></div>`,
      { title: 'Select infrastructure intent', confirmText: 'Continue', onSubmit: c => Number(c.querySelector('#gc-infra-plan-manifest').value) });
    if (!selectedId) return;
    const selected = manifests.find(item => item.id === selectedId);
    if (!selected) return Toast.error('Selected manifest is no longer available');
    const result = await Modal.form(`<p class="text-muted text-sm">Planning against ${Utils.escapeHtml(selected.kind)} · ${Utils.escapeHtml(selected.name)} · revision ${selected.revision}.</p>
      <div class="form-group"><label>Current live state JSON</label><textarea id="gc-infra-live" class="form-control mono" rows="18">${Utils.escapeHtml(JSON.stringify(selected.document.spec, null, 2))}</textarea></div>
      <div class="form-group"><label>Current resource versions JSON</label><textarea id="gc-infra-versions" class="form-control mono" rows="3">${Utils.escapeHtml(JSON.stringify(selected.resourceVersions || {}, null, 2))}</textarea></div>
      <div class="form-group"><label>Plan TTL (minutes)</label><input id="gc-infra-ttl" type="number" min="5" max="1440" value="30" class="form-control"></div>`,
    { title: 'Infrastructure change plan', width: '920px', confirmText: 'Create immutable plan', onSubmit: c => this._submit(() => Api.createInfrastructurePlan(
      selectedId, { liveState: JSON.parse(c.querySelector('#gc-infra-live').value),
        resourceVersions: JSON.parse(c.querySelector('#gc-infra-versions').value), ttlMinutes: Number(c.querySelector('#gc-infra-ttl').value) })) });
    if (result) { Toast.success(`Plan ${result.plan.planHash.slice(0, 12)} created`); await this.render(this._container); }
  },

  async _infrastructureWorkflowDialog() {
    const sample = [{ id: 'prepare', stage: 1, needs: [], actionKey: 'vm.prepare', lockScopes: ['resource:vm'],
      compensation: { actionKey: 'vm.cleanup', strategy: 'best_effort', input: {} } },
    { id: 'apply', stage: 2, needs: ['prepare'], actionKey: 'vm.apply', lockScopes: ['resource:vm'],
      compensation: { actionKey: 'vm.restore', strategy: 'required', input: { checkpoint: 'pre-change' } } },
    { id: 'verify', stage: 3, needs: ['apply'], actionKey: 'vm.verify', lockScopes: [] }];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-infra-wf-name" class="form-control" value="vm-change"></div><div class="form-group"><label>Version</label><input id="gc-infra-wf-version" class="form-control" value="1.0"></div></div>
      <div class="form-group"><label>Description</label><input id="gc-infra-wf-description" class="form-control" value="Staged VM change with reverse compensation"></div>
      <div class="form-group"><label>Steps JSON</label><textarea id="gc-infra-wf-steps" class="form-control mono" rows="22">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea></div>`,
    { title: 'Operation dependency DAG', width: '920px', onSubmit: c => this._submit(() => Api.createInfrastructureWorkflow({
      name: c.querySelector('#gc-infra-wf-name').value, version: c.querySelector('#gc-infra-wf-version').value,
      description: c.querySelector('#gc-infra-wf-description').value, steps: JSON.parse(c.querySelector('#gc-infra-wf-steps').value),
    })) });
    if (result) { Toast.success('Workflow DAG validated and saved'); await this.render(this._container); }
  },

  async _revalidateInfrastructurePlan(planId) {
    const result = await Modal.form(`<p class="text-muted text-sm">Supply fresh live state and native resource versions. Any hash, version, manifest revision or expiry change rejects this plan as stale.</p>
      <div class="form-group"><label>Fresh live state JSON</label><textarea id="gc-infra-revalidate-live" class="form-control mono" rows="16">{}</textarea></div>
      <div class="form-group"><label>Fresh resource versions JSON</label><textarea id="gc-infra-revalidate-versions" class="form-control mono" rows="3">{}</textarea></div>`,
    { title: `Stale-plan rejection · #${planId}`, width: '900px', confirmText: 'Revalidate & accept intent', onSubmit: c => this._submit(() => Api.revalidateInfrastructurePlan(planId, {
      liveState: JSON.parse(c.querySelector('#gc-infra-revalidate-live').value), resourceVersions: JSON.parse(c.querySelector('#gc-infra-revalidate-versions').value),
    })) });
    if (result) { Toast.success('Plan accepted; no provider mutation was scheduled'); await this.render(this._container); }
  },

  async _linkInfrastructureJob(planId) {
    const result = await Modal.form(`<p class="text-muted text-sm">Only an existing allowlisted provider operation can be linked. Encrypted request and native task references remain hidden.</p>
      <div class="form-group"><label>Operation ID</label><input id="gc-infra-operation" class="form-control mono" placeholder="op_…"></div>
      <div class="form-row"><div class="form-group"><label>Relation</label><select id="gc-infra-relation" class="form-control"><option>executes</option><option>verifies</option><option>compensates</option></select></div><div class="form-group"><label>Workflow step ID (optional)</label><input id="gc-infra-step" class="form-control mono"></div></div>`,
    { title: `Provider task bridge · plan #${planId}`, onSubmit: c => this._submit(() => Api.linkInfrastructurePlanJob(planId, {
      operationId: c.querySelector('#gc-infra-operation').value, relation: c.querySelector('#gc-infra-relation').value,
      stepId: c.querySelector('#gc-infra-step').value || undefined,
    })) });
    if (result) { Toast.success(`Durable job linked (${result.link.state})`); await this.render(this._container); }
  },

  async _infrastructureCompensationDialog(workflowId) {
    const workflow = (this._data.infrastructureAutomation?.workflows || []).find(item => item.id === Number(workflowId));
    const result = await Modal.form(`<p class="text-muted text-sm">Select completed steps. The preview orders declared compensations in reverse stage/definition order and performs no action.</p>
      <div class="form-group"><label>Completed step IDs (comma-separated)</label><input id="gc-infra-completed" class="form-control mono" value="${Utils.escapeHtml((workflow?.steps || []).map(step => step.id).join(', '))}"></div>`,
    { title: 'Compensation framework preview', confirmText: 'Build preview', onSubmit: c => this._submit(() => Api.previewInfrastructureCompensation(workflowId,
      c.querySelector('#gc-infra-completed').value.split(',').map(item => item.trim()).filter(Boolean))) });
    if (!result) return;
    const actions = result.plan.actions.map(item => `<tr><td>${Utils.escapeHtml(item.stepId)}</td><td class="mono">${Utils.escapeHtml(item.actionKey)}</td><td>${item.strategy}</td><td>${item.lockScopes.map(value => Utils.escapeHtml(value)).join(', ') || '—'}</td></tr>`).join('');
    Modal.open(`<div class="modal-header"><h3>Reverse compensation preview</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><table class="data-table"><thead><tr><th>Step</th><th>Compensation</th><th>Strategy</th><th>Locks</th></tr></thead><tbody>${actions || this._empty('No automatic compensations declared', 4)}</tbody></table><p class="text-muted text-sm" style="margin-top:12px">${result.plan.providerMutationsScheduled} provider mutations scheduled.</p></div>`);
    Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
  },

  _resourceManifestTemplate(kind) {
    const metadata = { name: kind === 'StorageResource' ? 'fast-storage' : 'prod-network', providerHostId: 0,
      ownership: { mode: 'managed', owner: 'platform-team', deletionProtection: true } };
    if (kind === 'StorageResource') return { apiVersion: 'docker-dash.io/v1alpha1', kind, metadata,
      spec: { storageType: 'datastore', capacityBytes: 1099511627776, classRef: 'default', shared: true,
        policies: [], tags: {}, deletionPolicy: 'retain' } };
    return { apiVersion: 'docker-dash.io/v1alpha1', kind, metadata,
      spec: { networkType: 'vlan', cidrs: ['10.20.0.0/24'], vlanId: 120, mtu: 1500,
        policies: [], tags: {}, deletionPolicy: 'retain' } };
  },

  async _resourceManifestDialog(kind) {
    const template = JSON.stringify(this._resourceManifestTemplate(kind), null, 2);
    const result = await Modal.form(`<p class="text-muted text-sm">Deletion requires managed ownership, deletionPolicy=delete and deletionProtection=false. Secret fields are rejected.</p>
      <div class="form-group"><label>${Utils.escapeHtml(kind)} JSON</label><textarea id="gc-resource-manifest" class="form-control mono" rows="22">${Utils.escapeHtml(template)}</textarea></div>
      <div class="form-group"><label>Resource versions JSON</label><textarea id="gc-resource-versions" class="form-control mono" rows="3">{}</textarea></div>`,
    { title: `${kind} intent`, width: '920px', confirmText: 'Validate & save', onSubmit: c => this._submit(() => Api.saveInfrastructureResourceManifest({
      document: JSON.parse(c.querySelector('#gc-resource-manifest').value),
      resourceVersions: JSON.parse(c.querySelector('#gc-resource-versions').value),
    })) });
    if (result) { Toast.success(`Resource manifest revision ${result.manifest.revision} saved`); await this.render(this._container); }
  },

  _allInfrastructureManifests() {
    const core = (this._data.infrastructureAutomation?.manifests || []).map(item => ({ ...item, source: 'core' }));
    const resources = (this._data.infrastructureAutomation?.delivery?.resourceManifests || []).map(item => ({ ...item, source: 'resource' }));
    return [...core, ...resources];
  },

  async _selectInfrastructureManifest(title) {
    const manifests = this._allInfrastructureManifests();
    if (!manifests.length) { Toast.warning('Save an infrastructure manifest first'); return null; }
    const selection = await Modal.form(`<div class="form-group"><label>Manifest</label><select id="gc-delivery-manifest" class="form-control">${manifests.map(item => `<option value="${item.source}:${item.id}">${Utils.escapeHtml(item.kind)} · ${Utils.escapeHtml(item.name)} · r${item.revision}</option>`).join('')}</select></div>`,
      { title, confirmText: 'Continue', onSubmit: c => c.querySelector('#gc-delivery-manifest').value });
    if (!selection) return null;
    const [source, rawId] = selection.split(':');
    return manifests.find(item => item.source === source && item.id === Number(rawId)) || null;
  },

  async _infrastructureImportDialog() {
    const template = JSON.stringify(this._manifestTemplate('Host'), null, 2);
    const result = await Modal.form(`<p class="text-muted text-sm">Paste a caller-observed resource using the canonical VM, host, fabric, storage or network schema. Import normalizes and exports; it does not persist.</p>
      <div class="form-group"><label>Observed resource JSON</label><textarea id="gc-import-document" class="form-control mono" rows="22">${Utils.escapeHtml(template)}</textarea></div>
      <div class="form-group"><label>Native resource versions JSON</label><textarea id="gc-import-versions" class="form-control mono" rows="3">{}</textarea></div>`,
    { title: 'Import live resource to manifest', width: '920px', confirmText: 'Normalize preview', onSubmit: c => this._submit(() => Api.importInfrastructureResource({
      document: JSON.parse(c.querySelector('#gc-import-document').value), resourceVersions: JSON.parse(c.querySelector('#gc-import-versions').value),
    })) });
    if (!result) return;
    Modal.open(`<div class="modal-header"><h3>Deterministic secret-free import</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><p class="mono text-xs">SHA-256 ${result.documentHash}</p><textarea class="form-control mono" rows="24" readonly>${Utils.escapeHtml(result.yaml)}</textarea><p class="text-muted text-sm">Persisted: no · provider queries: none.</p></div>`, { width: '920px' });
    Modal._content.querySelector('#gc-close').addEventListener('click', () => Modal.close());
  },

  async _infrastructureReconcileDialog() {
    const manifest = await this._selectInfrastructureManifest('Select drift target'); if (!manifest) return;
    const result = await Modal.form(`<p class="text-muted text-sm">Creates immutable diff and commit evidence only. Provider changes must already exist as allowlisted durable operations.</p>
      <div class="form-group"><label>Observed live state JSON</label><textarea id="gc-reconcile-live" class="form-control mono" rows="18">${Utils.escapeHtml(JSON.stringify(manifest.document.spec, null, 2))}</textarea></div>
      <div class="form-row"><div class="form-group"><label>Resource versions JSON</label><textarea id="gc-reconcile-versions" class="form-control mono" rows="3">${Utils.escapeHtml(JSON.stringify(manifest.resourceVersions || {}, null, 2))}</textarea></div><div class="form-group"><label>Git commit SHA (optional)</label><input id="gc-reconcile-commit" class="form-control mono"></div></div>`,
    { title: 'Declarative drift & manual GitOps reconcile', width: '920px', confirmText: 'Create plan evidence', onSubmit: c => this._submit(() => Api.createInfrastructureReconcile({
      manifestSource: manifest.source, manifestId: manifest.id, liveState: JSON.parse(c.querySelector('#gc-reconcile-live').value),
      resourceVersions: JSON.parse(c.querySelector('#gc-reconcile-versions').value), commitSha: c.querySelector('#gc-reconcile-commit').value || undefined,
    })) });
    if (result) { Toast.success(`Reconcile evidence is ${result.run.status}`); await this.render(this._container); }
  },

  async _approveInfrastructureReconcile(runId) {
    const run = (this._data.infrastructureAutomation?.delivery?.reconcileRuns || []).find(item => item.id === Number(runId));
    if (!run) return Toast.error('Reconcile run is no longer available');
    const manifest = this._allInfrastructureManifests().find(item => item.source === run.manifestSource && item.id === run.manifestId);
    if (!manifest) return Toast.error('The reconcile manifest is no longer available');
    const confirmation = await Modal.form(`<p>Approve reviewed plan <span class="mono">${run.planHash}</span>.</p>
      <div class="form-group"><label>Fresh live state JSON</label><textarea id="gc-reconcile-fresh" class="form-control mono" rows="16">${Utils.escapeHtml(JSON.stringify(run.evidence.observedState || manifest.document.spec, null, 2))}</textarea></div>
      <div class="form-group"><label>Fresh resource versions JSON</label><textarea id="gc-reconcile-fresh-versions" class="form-control mono" rows="3">${Utils.escapeHtml(JSON.stringify(run.resourceVersions || {}, null, 2))}</textarea></div>
      <div class="form-group"><label>Deletion confirmation (only when deletes exist)</label><input id="gc-reconcile-confirm" class="form-control mono" placeholder="DELETE kind name"></div>`,
    { title: `Approve reconcile #${run.id}`, width: '900px', confirmText: 'Revalidate & approve', onSubmit: c => ({
      confirmation: c.querySelector('#gc-reconcile-confirm').value, liveState: JSON.parse(c.querySelector('#gc-reconcile-fresh').value),
      resourceVersions: JSON.parse(c.querySelector('#gc-reconcile-fresh-versions').value),
    }) });
    if (confirmation === null || confirmation === undefined) return;
    try { await Api.approveInfrastructureReconcile(run.id, { planHash: run.planHash, ...confirmation }); Toast.success('Fresh evidence matches; reconcile approved'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _applyInfrastructureReconcile(runId) {
    const run = (this._data.infrastructureAutomation?.delivery?.reconcileRuns || []).find(item => item.id === Number(runId));
    const result = await Modal.form(`<p class="text-muted text-sm">Attach existing durable operations. This does not start or replay a provider command.</p>
      <div class="form-group"><label>Operation IDs (comma-separated)</label><input id="gc-reconcile-operations" class="form-control mono" placeholder="op_…"></div>`,
    { title: `Apply evidence · #${runId}`, confirmText: 'Attach evidence', onSubmit: c => this._submit(() => Api.applyInfrastructureReconcile(runId, {
      planHash: run.planHash, operationIds: c.querySelector('#gc-reconcile-operations').value.split(',').map(value => value.trim()).filter(Boolean),
    })) });
    if (result) { Toast.success(`Reconcile state: ${result.run.status}`); await this.render(this._container); }
  },

  async _infrastructureControllerDialog() {
    const manifest = await this._selectInfrastructureManifest('Controller manifest'); if (!manifest) return;
    const result = await Modal.form(`<p class="text-muted text-sm">Continuous mode evaluates stored observations on schedule and pauses on conflict; it never starts provider mutations.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-controller-name" class="form-control" value="${Utils.escapeHtml(manifest.name)}-drift"></div><div class="form-group"><label>Scope key</label><input id="gc-controller-scope" class="form-control mono" value="${manifest.source}:${manifest.id}"></div></div>
      <div class="form-row"><div class="form-group"><label>Mode</label><select id="gc-controller-mode" class="form-control"><option>observe</option><option>continuous</option></select></div><div class="form-group"><label>Interval seconds</label><input id="gc-controller-interval" type="number" min="60" max="86400" value="900" class="form-control"></div></div>
      <div class="form-group"><label><input id="gc-controller-enabled" type="checkbox"> Enable scheduled evaluation</label></div>
      <div class="form-group"><label>Initial observed live state JSON</label><textarea id="gc-controller-live" class="form-control mono" rows="16">${Utils.escapeHtml(JSON.stringify(manifest.document.spec, null, 2))}</textarea></div>`,
    { title: 'Scoped reconcile controller', width: '900px', onSubmit: c => this._submit(() => Api.createInfrastructureController({
      name: c.querySelector('#gc-controller-name').value, manifestSource: manifest.source, manifestId: manifest.id,
      scopeType: manifest.kind === 'fabric' ? 'fabric' : manifest.kind === 'host' ? 'host' : 'resource', scopeKey: c.querySelector('#gc-controller-scope').value,
      mode: c.querySelector('#gc-controller-mode').value, intervalSeconds: Number(c.querySelector('#gc-controller-interval').value),
      enabled: c.querySelector('#gc-controller-enabled').checked, liveState: JSON.parse(c.querySelector('#gc-controller-live').value),
    })) });
    if (result) { Toast.success('Conflict-pausing controller saved'); await this.render(this._container); }
  },

  async _infrastructurePrDialog() {
    const manifest = await this._selectInfrastructureManifest('Pull-request preview target'); if (!manifest) return;
    const result = await Modal.form(`<div class="form-group"><label>Pull-request reference</label><input id="gc-pr-ref" class="form-control mono" value="github/pr/1"></div>
      <div class="form-group"><label>Observed live state JSON</label><textarea id="gc-pr-live" class="form-control mono" rows="16">${Utils.escapeHtml(JSON.stringify(manifest.document.spec, null, 2))}</textarea></div>
      <div class="form-row"><div class="form-group"><label>Currency</label><input id="gc-pr-currency" class="form-control" value="EUR"></div><div class="form-group"><label>Monthly rates JSON (optional)</label><input id="gc-pr-rates" class="form-control mono" value="{}"></div></div>`,
    { title: 'Pull-request infrastructure preview', width: '900px', onSubmit: c => this._submit(() => Api.previewInfrastructurePullRequest({
      externalRef: c.querySelector('#gc-pr-ref').value, manifestSource: manifest.source, manifestId: manifest.id,
      liveState: JSON.parse(c.querySelector('#gc-pr-live').value), currency: c.querySelector('#gc-pr-currency').value,
      monthlyRates: JSON.parse(c.querySelector('#gc-pr-rates').value),
    })) });
    if (result) { Toast.success(`PR preview ${result.preview.status}; no merge or provider action started`); await this.render(this._container); }
  },

  async _terraformPlanDialog() {
    const sample = { format_version: '1.2', terraform_version: '1.9.0', resource_changes: [
      { address: 'proxmox_vm_qemu.example', type: 'proxmox_vm_qemu', change: { actions: ['update'], before_sensitive: {}, after_sensitive: {} } },
    ] };
    const result = await Modal.form(`<p class="text-muted text-sm">Only addresses, types, actions and sensitivity flags are retained. Before/after values are discarded.</p>
      <div class="form-group"><label>Run reference</label><input id="gc-tf-ref" class="form-control mono" value="terraform/run-1"></div>
      <div class="form-group"><label>Terraform plan JSON</label><textarea id="gc-tf-plan" class="form-control mono" rows="22">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea></div>`,
    { title: 'Terraform run integration', width: '920px', confirmText: 'Ingest redacted evidence', onSubmit: c => this._submit(() => Api.ingestTerraformPlan({
      externalRef: c.querySelector('#gc-tf-ref').value, plan: JSON.parse(c.querySelector('#gc-tf-plan').value),
    })) });
    if (result) { Toast.success(`Terraform plan ${result.plan.status}; no Terraform process started`); await this.render(this._container); }
  },

  async _authorizeInfrastructureExternal(planId) {
    const plan = (this._data.infrastructureAutomation?.delivery?.externalPlans || []).find(item => item.id === Number(planId));
    if (!plan) return Toast.error('External plan is no longer available');
    const phrase = plan.sourceKind === 'terraform' ? `AUTHORIZE TERRAFORM ${plan.id}` : `APPROVE PREVIEW ${plan.id}`;
    const result = await Modal.form(`<p>This records authorization only; Docker Dash will not execute Terraform or merge a pull request.</p>
      <div class="form-group"><label>Type ${phrase}</label><input id="gc-external-confirm" class="form-control mono"></div>
      <div class="form-group"><label><input id="gc-external-override" type="checkbox"> Explicitly override blocked policy findings</label></div>`,
    { title: 'Gated external authorization', danger: true, onSubmit: c => this._submit(() => Api.authorizeInfrastructureExternalPlan(plan.id, {
      confirmation: c.querySelector('#gc-external-confirm').value, allowPolicyOverride: c.querySelector('#gc-external-override').checked,
    })) });
    if (result) { Toast.success('Authorization recorded; external execution was not started'); await this.render(this._container); }
  },

  async _downloadAnsibleInventory() {
    try {
      const result = await Api.getAnsibleInfrastructureInventory(); const blob = new Blob([result.yaml], { type: 'application/yaml' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'docker-dash-inventory.yaml'; link.click(); URL.revokeObjectURL(url);
      Toast.success('Secret-free Ansible inventory exported');
    } catch (error) { Toast.error(error.message); }
  },

  async _infrastructureWebhookDialog() {
    let procedureRows;
    try { procedureRows = await Api.getProcedures(); } catch (error) { return Toast.error(error.message); }
    if (!procedureRows.length) return Toast.warning('Create an active procedure first');
    const result = await Modal.form(`<p class="text-muted text-sm">The token and HMAC secret are shown once. Requests require timestamp, nonce, allowlisted event and SHA-256 signature.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-hook-name" class="form-control" value="incident-hook"></div><div class="form-group"><label>Procedure</label><select id="gc-hook-procedure" class="form-control">${procedureRows.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-group"><label>Events (comma-separated)</label><input id="gc-hook-events" class="form-control mono" value="incident.opened"></div><div class="form-group"><label>Timestamp window seconds</label><input id="gc-hook-window" type="number" min="30" max="900" value="300" class="form-control"></div></div>`,
    { title: 'Signed webhook-triggered runbook', onSubmit: c => this._submit(() => Api.createInfrastructureWebhookTrigger({
      name: c.querySelector('#gc-hook-name').value, procedureId: Number(c.querySelector('#gc-hook-procedure').value),
      events: c.querySelector('#gc-hook-events').value.split(',').map(value => value.trim()).filter(Boolean),
      timestampSkewSeconds: Number(c.querySelector('#gc-hook-window').value),
    })) });
    if (!result) return;
    Modal.open(`<div class="modal-header"><h3>Save webhook credentials now</h3><button class="modal-close-btn" id="gc-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><p>Endpoint</p><input class="form-control mono" readonly value="${Utils.escapeHtml(`${location.origin}/api/automation/webhooks/${result.token}`)}"><p style="margin-top:12px">HMAC secret</p><input class="form-control mono" readonly value="${Utils.escapeHtml(result.secret)}"><p class="text-muted text-sm">Signature input: timestamp.nonce.event.raw-body. These values will not be shown again.</p></div>`, { width: '850px' });
    Modal._content.querySelector('#gc-close').addEventListener('click', () => { Modal.close(); this.render(this._container); });
  },

  async _automationScheduleDialog() {
    const workflows = this._data.infrastructureAutomation?.workflows || [];
    if (!workflows.length) return Toast.warning('Create or instantiate a workflow first');
    const result = await Modal.form(`<p class="text-muted text-sm">A matching minute creates ready/suppressed evidence only; it does not execute the workflow.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-schedule-name" class="form-control" value="maintenance-calendar"></div><div class="form-group"><label>Workflow</label><select id="gc-schedule-workflow" class="form-control">${workflows.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)} @ ${Utils.escapeHtml(item.version)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-group"><label>Five-field cron</label><input id="gc-schedule-cron" class="form-control mono" value="0 2 * * 1-5"></div><div class="form-group"><label>IANA timezone</label><input id="gc-schedule-zone" class="form-control mono" value="Europe/Bucharest"></div></div>
      <div class="form-group"><label>Holiday dates JSON</label><textarea id="gc-schedule-holidays" class="form-control mono" rows="3">[]</textarea></div>
      <div class="form-group"><label>Blackout windows JSON</label><textarea id="gc-schedule-blackouts" class="form-control mono" rows="5">[{"name":"night-freeze","weekdays":[0,6],"start":"00:00","end":"23:59"}]</textarea></div>
      <label><input type="checkbox" id="gc-schedule-enabled"> Enable schedule</label>`,
    { title: 'Calendar-aware workflow schedule', width: '900px', onSubmit: c => this._submit(() => Api.createInfrastructureSchedule({
      name: c.querySelector('#gc-schedule-name').value, workflowId: Number(c.querySelector('#gc-schedule-workflow').value),
      cron: c.querySelector('#gc-schedule-cron').value, timezone: c.querySelector('#gc-schedule-zone').value,
      holidays: JSON.parse(c.querySelector('#gc-schedule-holidays').value), blackoutWindows: JSON.parse(c.querySelector('#gc-schedule-blackouts').value),
      enabled: c.querySelector('#gc-schedule-enabled').checked,
    })) });
    if (result) { Toast.success('Schedule saved; no workflow execution started'); await this.render(this._container); }
  },

  async _automationApprovalDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Expiry can reassign or escalate, but approval never starts apply implicitly.</p>
      <div class="form-row"><div class="form-group"><label>Action key</label><input id="gc-op-approval-action" class="form-control mono" value="host.maintenance"></div><div class="form-group"><label>Target type / ID</label><input id="gc-op-approval-target" class="form-control mono" value="host:7"></div></div>
      <div class="form-group"><label>Reviewed payload JSON</label><textarea id="gc-op-approval-payload" class="form-control mono" rows="6">{"mode":"maintenance"}</textarea></div>
      <div class="form-row"><div class="form-group"><label>Due minutes</label><input id="gc-op-approval-due" type="number" min="1" value="60" class="form-control"></div><div class="form-group"><label>Escalation user</label><select id="gc-op-approval-escalation" class="form-control"><option value="">None (expire)</option>${this._userOptions()}</select></div></div>`,
    { title: 'Timed automation approval', width: '800px', onSubmit: c => { const [targetType, ...target] = c.querySelector('#gc-op-approval-target').value.split(':'); return this._submit(() => Api.createInfrastructureApproval({
      actionKey: c.querySelector('#gc-op-approval-action').value, targetType, targetId: target.join(':'),
      payload: JSON.parse(c.querySelector('#gc-op-approval-payload').value), dueMinutes: Number(c.querySelector('#gc-op-approval-due').value),
      escalationUserId: Number(c.querySelector('#gc-op-approval-escalation').value) || undefined,
    })); } });
    if (result) { Toast.success('Timed approval saved; apply remains separate'); await this.render(this._container); }
  },

  async _decideAutomationApproval(id, decision) {
    const item = this._data.infrastructureAutomation?.operations?.approvals?.find(row => row.id === Number(id));
    if (!item) return Toast.error('Approval evidence is no longer available');
    if (!await Modal.confirm(`${decision === 'approve' ? 'Approve' : 'Reject'} reviewed payload ${item.payloadHash.slice(0, 12)}? This does not start apply.`, { danger: decision === 'reject' })) return;
    try { await Api.decideInfrastructureApproval(item.id, { decision: decision === 'approve' ? 'approved' : 'rejected', payloadHash: item.payloadHash }); Toast.success('Decision recorded; no apply started'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _automationDryRunDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">If no native validate/simulate adapter exists, the result is explicitly unsupported.</p>
      <div class="form-row"><div class="form-group"><label>Provider type</label><input id="gc-dry-provider" class="form-control" value="proxmox"></div><div class="form-group"><label>Adapter</label><input id="gc-dry-adapter" class="form-control" value="native"></div></div>
      <div class="form-row"><div class="form-group"><label>Action key</label><input id="gc-dry-action" class="form-control mono" value="vm.resize"></div><div class="form-group"><label>Target reference</label><input id="gc-dry-target" class="form-control mono" value="vm-101"></div></div>
      <div class="form-group"><label>Secret-free request JSON</label><textarea id="gc-dry-request" class="form-control mono" rows="8">{"cpu":4,"memoryBytes":8589934592}</textarea></div>`,
    { title: 'Provider validate / simulate', width: '850px', onSubmit: c => this._submit(() => Api.createInfrastructureDryRun({
      providerType: c.querySelector('#gc-dry-provider').value, adapterKey: c.querySelector('#gc-dry-adapter').value,
      actionKey: c.querySelector('#gc-dry-action').value, targetRef: c.querySelector('#gc-dry-target').value,
      request: JSON.parse(c.querySelector('#gc-dry-request').value),
    })) });
    if (result) { Toast.success(`Dry-run evidence: ${result.evidence.status}; provider mutation not started`); await this.render(this._container); }
  },

  async _automationBrokerDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Only a provider reference is stored. Environment references must start with DD_BROKER_SECRET_.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-broker-name" class="form-control" value="automation-secret"></div><div class="form-group"><label>Provider</label><select id="gc-broker-kind" class="form-control"><option value="environment">Environment</option><option value="vault">Vault</option><option value="aws_secrets_manager">AWS Secrets Manager</option><option value="azure_key_vault">Azure Key Vault</option></select></div></div>
      <div class="form-group"><label>Secret reference (never the value)</label><input id="gc-broker-reference" class="form-control mono" value="DD_BROKER_SECRET_AUTOMATION"></div>
      <div class="form-row"><div class="form-group"><label>Allowed purposes</label><input id="gc-broker-purposes" class="form-control mono" value="backup.execute"></div><div class="form-group"><label>Maximum lease seconds</label><input id="gc-broker-ttl" type="number" min="1" max="300" value="60" class="form-control"></div></div>`,
    { title: 'JIT automation secret broker', width: '850px', onSubmit: c => this._submit(() => Api.createInfrastructureSecretBroker({
      name: c.querySelector('#gc-broker-name').value, providerKind: c.querySelector('#gc-broker-kind').value,
      secretReference: c.querySelector('#gc-broker-reference').value,
      allowedPurposes: c.querySelector('#gc-broker-purposes').value.split(',').map(value => value.trim()).filter(Boolean),
      maxLeaseSeconds: Number(c.querySelector('#gc-broker-ttl').value),
    })) });
    if (result) { Toast.success('Secret reference policy saved; no secret value stored'); await this.render(this._container); }
  },

  async _probeAutomationBroker(id) {
    const broker = this._data.infrastructureAutomation?.operations?.secretBrokers?.find(item => item.id === Number(id));
    if (!broker) return Toast.error('Secret broker is no longer available');
    const purpose = broker.allowedPurposes[0];
    try { const result = await Api.probeInfrastructureSecretBroker(id, purpose); Toast.success(`Available until ${new Date(result.expiresAt).toLocaleTimeString()} · fingerprint ${result.fingerprint}`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _automationTemplateDialog() {
    const templates = this._data.infrastructureAutomation?.operations?.workflowTemplates || [];
    if (!templates.length) return Toast.warning('No curated templates are available');
    const chosen = await Modal.form(`<div class="form-group"><label>Curated template</label><select id="gc-template-id" class="form-control">${templates.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.category)} · ${Utils.escapeHtml(item.slug)}@${Utils.escapeHtml(item.version)}</option>`).join('')}</select></div>`,
      { title: 'Choose workflow template', confirmText: 'Continue', onSubmit: c => Number(c.querySelector('#gc-template-id').value) });
    if (!chosen) return; const template = templates.find(item => item.id === chosen);
    const defaults = Object.fromEntries(template.parameters.map(parameter => [parameter, parameter.endsWith('Id') ? '7' : 'target']));
    const result = await Modal.form(`<p>${Utils.escapeHtml(template.description)}</p><div class="form-row"><div class="form-group"><label>Workflow name</label><input id="gc-template-name" class="form-control" value="${Utils.escapeHtml(template.slug)}-${Date.now()}"></div><div class="form-group"><label>Version</label><input id="gc-template-version" class="form-control" value="${Utils.escapeHtml(template.version)}"></div></div><div class="form-group"><label>Parameters JSON</label><textarea id="gc-template-params" class="form-control mono" rows="8">${Utils.escapeHtml(JSON.stringify(defaults, null, 2))}</textarea></div>`,
    { title: `Instantiate ${template.slug}`, width: '800px', onSubmit: c => this._submit(() => Api.instantiateInfrastructureTemplate(template.id, {
      name: c.querySelector('#gc-template-name').value, version: c.querySelector('#gc-template-version').value,
      parameters: JSON.parse(c.querySelector('#gc-template-params').value),
    })) });
    if (result) { Toast.success('Curated workflow instantiated; execution not started'); await this.render(this._container); }
  },

  async _lifecycleInventoryDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Component type</label><select id="gc-life-component" class="form-control"><option value="host">Host</option><option value="control_plane">Control plane</option><option value="tool">Tool</option><option value="firmware">Firmware</option></select></div><div class="form-group"><label>Provider host ID (0 = global)</label><input id="gc-life-host" type="number" min="0" value="0" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-life-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Product</label><input id="gc-life-product" class="form-control" value="Hypervisor"></div></div>
      <div class="form-row"><div class="form-group"><label>Version</label><input id="gc-life-version" class="form-control mono" value="1.0.0"></div><div class="form-group"><label>Build</label><input id="gc-life-build" class="form-control mono" value="build-1"></div></div>
      <div class="form-group"><label>Evidence source</label><input id="gc-life-source" class="form-control mono" value="provider-api"></div>`,
    { title: 'Record version & build evidence', width: '800px', onSubmit: c => this._submit(() => Api.recordLifecycleInventory({
      componentType: c.querySelector('#gc-life-component').value, providerHostId: Number(c.querySelector('#gc-life-host').value),
      vendor: c.querySelector('#gc-life-vendor').value, product: c.querySelector('#gc-life-product').value,
      version: c.querySelector('#gc-life-version').value, build: c.querySelector('#gc-life-build').value,
      source: c.querySelector('#gc-life-source').value, observedAt: new Date().toISOString(), evidence: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success('Version/build evidence recorded'); await this.render(this._container); }
  },

  async _lifecycleSupportDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-support-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Product</label><input id="gc-support-product" class="form-control" value="Hypervisor"></div><div class="form-group"><label>Version line</label><input id="gc-support-line" class="form-control mono" value="1"></div></div>
      <div class="form-row"><div class="form-group"><label>GA date</label><input id="gc-support-ga" type="date" class="form-control"></div><div class="form-group"><label>EOL date</label><input id="gc-support-eol" type="date" class="form-control"></div><div class="form-group"><label>EOS date</label><input id="gc-support-eos" type="date" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Recommended target</label><input id="gc-support-target" class="form-control mono" value="2.0"></div><div class="form-group"><label>Official HTTPS source</label><input id="gc-support-url" class="form-control mono" value="https://vendor.example/support"></div></div>`,
    { title: 'Support lifecycle evidence', width: '900px', onSubmit: c => this._submit(() => Api.saveLifecycleSupport({
      vendor: c.querySelector('#gc-support-vendor').value, product: c.querySelector('#gc-support-product').value,
      versionLine: c.querySelector('#gc-support-line').value, gaDate: c.querySelector('#gc-support-ga').value || undefined,
      eolDate: c.querySelector('#gc-support-eol').value || undefined, eosDate: c.querySelector('#gc-support-eos').value || undefined,
      recommendedTarget: c.querySelector('#gc-support-target').value, sourceUrl: c.querySelector('#gc-support-url').value,
      retrievedAt: new Date().toISOString(),
    })) });
    if (result) { Toast.success('Support lifecycle registry updated'); await this.render(this._container); }
  },

  async _lifecyclePathDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-path-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Product</label><input id="gc-path-product" class="form-control" value="Hypervisor"></div></div>
      <div class="form-row"><div class="form-group"><label>From version</label><input id="gc-path-from" class="form-control mono" value="1.0"></div><div class="form-group"><label>To version</label><input id="gc-path-to" class="form-control mono" value="2.0"></div></div>
      <div class="form-group"><label>Supported hops (comma-separated)</label><input id="gc-path-hops" class="form-control mono" value="1.0,1.5,2.0"></div>
      <div class="form-group"><label>Prerequisites (one per line)</label><textarea id="gc-path-prereq" class="form-control" rows="3">Verified backup</textarea></div>
      <div class="form-group"><label>Known blockers (one per line)</label><textarea id="gc-path-blockers" class="form-control" rows="3"></textarea></div>
      <div class="form-group"><label>Official HTTPS source</label><input id="gc-path-url" class="form-control mono" value="https://vendor.example/upgrade"></div>`,
    { title: 'Vendor-supported upgrade path', width: '850px', onSubmit: c => this._submit(() => Api.saveLifecycleUpgradePath({
      vendor: c.querySelector('#gc-path-vendor').value, product: c.querySelector('#gc-path-product').value,
      fromVersion: c.querySelector('#gc-path-from').value, toVersion: c.querySelector('#gc-path-to').value,
      supportedHops: c.querySelector('#gc-path-hops').value.split(',').map(value => value.trim()).filter(Boolean),
      prerequisites: c.querySelector('#gc-path-prereq').value.split('\n').map(value => value.trim()).filter(Boolean),
      blockers: c.querySelector('#gc-path-blockers').value.split('\n').map(value => value.trim()).filter(Boolean),
      sourceUrl: c.querySelector('#gc-path-url').value,
    })) });
    if (result) { Toast.success('Upgrade path evidence saved'); await this.render(this._container); }
  },

  async _lifecycleCatalogDialog() {
    const sample = [{ advisoryId: 'ADV-2026-001', title: 'Vendor update bundle', updateKind: 'bundle', targetVersion: '2.0', severity: 'high', publishedAt: new Date().toISOString(), metadata: {} }];
    const result = await Modal.form(`<p class="text-muted text-sm">Only evidence labelled official_vendor is accepted. Ingestion does not download or install packages.</p>
      <div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-catalog-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Product</label><input id="gc-catalog-product" class="form-control" value="Hypervisor"></div></div>
      <div class="form-group"><label>Official HTTPS feed URL</label><input id="gc-catalog-url" class="form-control mono" value="https://vendor.example/advisories"></div>
      <div class="form-group"><label>Normalized catalog items JSON</label><textarea id="gc-catalog-items" class="form-control mono" rows="14">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea></div>`,
    { title: 'Ingest official update catalog', width: '900px', onSubmit: c => this._submit(() => Api.ingestLifecycleUpdateCatalog({
      vendor: c.querySelector('#gc-catalog-vendor').value, product: c.querySelector('#gc-catalog-product').value,
      sourceKind: 'official_vendor', sourceUrl: c.querySelector('#gc-catalog-url').value,
      items: JSON.parse(c.querySelector('#gc-catalog-items').value),
    })) });
    if (result) { Toast.success(`${result.created} created, ${result.updated} updated; no packages installed`); await this.render(this._container); }
  },

  async _lifecyclePrecheckDialog() {
    const inventory = this._data.lifecycleUpdates?.inventory || [];
    if (!inventory.length) return Toast.warning('Record version inventory first');
    const evidence = { health: { status: 'healthy' }, capacity: { headroomPercent: 30, requiredHeadroomPercent: 20 },
      backup: { verified: true, ageHours: 2 }, compatibility: { compatible: true },
      freeSpace: { availableBytes: 21474836480, requiredBytes: 10737418240 } };
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Inventory item</label><select id="gc-precheck-inventory" class="form-control">${inventory.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.product)} ${Utils.escapeHtml(item.version)}</option>`).join('')}</select></div><div class="form-group"><label>Target version</label><input id="gc-precheck-target" class="form-control mono"></div></div>
      <div class="form-group"><label>Fresh precheck evidence JSON</label><textarea id="gc-precheck-evidence" class="form-control mono" rows="16">${Utils.escapeHtml(JSON.stringify(evidence, null, 2))}</textarea></div>`,
    { title: 'Non-mutating upgrade precheck', width: '900px', onSubmit: c => this._submit(() => Api.runLifecycleUpgradePrecheck({
      inventoryId: Number(c.querySelector('#gc-precheck-inventory').value), targetVersion: c.querySelector('#gc-precheck-target').value,
      evidence: JSON.parse(c.querySelector('#gc-precheck-evidence').value),
    })) });
    if (result) { Toast.success(`Upgrade precheck: ${result.precheck.status}; upgrade not started`); await this.render(this._container); }
  },

  async _lifecycleAdvisorDialog(id) {
    const target = await Modal.form('<div class="form-group"><label>Target version</label><input id="gc-advisor-target" class="form-control mono"></div>',
      { title: 'Upgrade path advisor', confirmText: 'Evaluate', onSubmit: c => c.querySelector('#gc-advisor-target').value });
    if (!target) return;
    try {
      const result = await Api.getLifecycleUpgradeAdvice(id, target);
      Modal.open(`<div class="modal-header"><h3>Upgrade advice · ${Utils.escapeHtml(result.status)}</h3><button class="modal-close-btn" id="gc-close-advisor"><i class="fas fa-times"></i></button></div><div class="modal-body"><p class="text-muted">Advisory only; upgrade was not started.</p><pre class="code-block">${Utils.escapeHtml(JSON.stringify(result, null, 2))}</pre></div>`, { width: '920px' });
      Modal._content.querySelector('#gc-close-advisor').addEventListener('click', () => Modal.close());
    } catch (error) { Toast.error(error.message); }
  },

  async _lifecycleMaintenancePlanDialog() {
    const starts = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    const targets = [{ ref: 'node-a', providerHostId: 1, owner: 'platform', availabilityGroup: 'rack-a',
      evacuationRequired: true, evacuable: true, estimatedMinutes: 30 }];
    const result = await Modal.form(`<p class="text-muted text-sm">The planner separates availability groups and owners into bounded waves and validates evacuation capacity. Saving does not touch a provider.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-lm-name" class="form-control" value="cluster-maintenance-${Date.now()}"></div><div class="form-group"><label>Scope</label><div style="display:flex;gap:6px"><select id="gc-lm-scope-type" class="form-control"><option>cluster</option><option>host</option><option>site</option><option>fleet</option></select><input id="gc-lm-scope-key" class="form-control mono" value="cluster-a"></div></div></div>
      <div class="form-row"><div class="form-group"><label>Start</label><input id="gc-lm-start" type="datetime-local" class="form-control" value="${starts}"></div><div class="form-group"><label>IANA timezone</label><input id="gc-lm-timezone" class="form-control mono" value="Europe/Bucharest"></div></div>
      <div class="form-row"><div class="form-group"><label>Duration (minutes)</label><input id="gc-lm-duration" type="number" min="15" value="180" class="form-control"></div><div class="form-group"><label>Wave / max per owner</label><div style="display:flex;gap:6px"><input id="gc-lm-wave" type="number" min="1" value="1" class="form-control"><input id="gc-lm-owner" type="number" min="1" value="1" class="form-control"></div></div></div>
      <div class="form-row"><div class="form-group"><label>Evacuation destinations</label><input id="gc-lm-destinations" class="form-control mono" value="cluster-b"></div><label style="align-self:center"><input id="gc-lm-capacity" type="checkbox" checked> Evacuation capacity verified</label></div>
      <div class="form-group"><label>Targets JSON</label><textarea id="gc-lm-targets" class="form-control mono" rows="10">${Utils.escapeHtml(JSON.stringify(targets, null, 2))}</textarea></div>`,
    { title: 'Maintenance window planner', width: '950px', onSubmit: c => this._submit(() => Api.createLifecycleMaintenancePlan({
      name: c.querySelector('#gc-lm-name').value, scopeType: c.querySelector('#gc-lm-scope-type').value,
      scopeKey: c.querySelector('#gc-lm-scope-key').value, startsAt: new Date(c.querySelector('#gc-lm-start').value).toISOString(),
      timezone: c.querySelector('#gc-lm-timezone').value, durationMinutes: Number(c.querySelector('#gc-lm-duration').value),
      waveSize: Number(c.querySelector('#gc-lm-wave').value), maxConcurrentPerOwner: Number(c.querySelector('#gc-lm-owner').value),
      evacuation: { capacityVerified: c.querySelector('#gc-lm-capacity').checked,
        destinationRefs: c.querySelector('#gc-lm-destinations').value.split(',').map(value => value.trim()).filter(Boolean) },
      targets: JSON.parse(c.querySelector('#gc-lm-targets').value),
    })) });
    if (result) { Toast.success(`${result.waves.length} waves planned; ${result.providerMutationsStarted} provider mutations`); await this.render(this._container); }
  },

  async _approveLifecycleMaintenancePlan(id) {
    const plan = (this._data.lifecycleMaintenance?.maintenancePlans || []).find(item => item.id === Number(id));
    if (!plan) return Toast.error('Maintenance plan is no longer available');
    const body = await Modal.form(`<p>Review plan hash <span class="mono">${plan.planHash}</span>, ${plan.waves.length} waves and ${plan.conflicts.length} conflicts.</p><div class="form-group"><label>Type APPROVE MAINTENANCE ${plan.id}</label><input id="gc-lm-confirm" class="form-control mono" autocomplete="off"></div>`,
      { title: 'Approve immutable maintenance plan', confirmText: 'Approve', onSubmit: c => ({ planHash: plan.planHash, confirmation: c.querySelector('#gc-lm-confirm').value }) });
    if (!body) return;
    try { await Api.approveLifecycleMaintenancePlan(plan.id, body); Toast.success('Maintenance plan approved; no provider action started'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _lifecycleCampaignDialog() {
    const targets = [{ ref: 'node-a', providerHostId: 1, owner: 'platform', availabilityGroup: 'rack-a', currentVersion: '1.0',
      precheck: { healthReady: true, compatible: true, haReady: true, evacuationReady: true, guestResponsive: true },
      protection: { backupVerified: true } }];
    const result = await Modal.form(`<p class="text-muted text-sm">Each target must pass the gates for its campaign kind. Execution remains separate and must produce a durable provider-operation ID.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-lc-name" class="form-control" value="rolling-upgrade-${Date.now()}"></div><div class="form-group"><label>Kind</label><select id="gc-lc-kind" class="form-control"><option value="rolling_cluster">cluster rolling upgrade</option><option value="guest_tools">guest tools</option><option value="vm_hardware">VM hardware version</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Target version</label><input id="gc-lc-version" class="form-control mono" value="2.0"></div><div class="form-group"><label>Wave size</label><input id="gc-lc-wave" type="number" min="1" value="1" class="form-control"></div><div class="form-group"><label>Approved maintenance plan (optional)</label><input id="gc-lc-plan" type="number" min="1" class="form-control"></div></div>
      <div class="form-group"><label>Targets and precheck evidence JSON</label><textarea id="gc-lc-targets" class="form-control mono" rows="15">${Utils.escapeHtml(JSON.stringify(targets, null, 2))}</textarea></div>`,
    { title: 'Staged lifecycle campaign', width: '950px', onSubmit: c => this._submit(() => Api.createLifecycleCampaign({
      name: c.querySelector('#gc-lc-name').value, kind: c.querySelector('#gc-lc-kind').value,
      targetVersion: c.querySelector('#gc-lc-version').value, waveSize: Number(c.querySelector('#gc-lc-wave').value),
      maintenancePlanId: Number(c.querySelector('#gc-lc-plan').value) || undefined,
      rollbackPolicy: { mode: 'pause' }, targets: JSON.parse(c.querySelector('#gc-lc-targets').value),
    })) });
    if (result) { Toast.success(`Campaign ${result.campaign.state}; ${result.campaign.providerOperationsCreated} provider operations created`); await this.render(this._container); }
  },

  async _approveLifecycleCampaign(id) {
    const campaign = (this._data.lifecycleMaintenance?.campaigns || []).find(item => item.id === Number(id));
    if (!campaign) return Toast.error('Campaign is no longer available');
    const body = await Modal.form(`<p>Review ${campaign.targets.length} targets and hash <span class="mono">${campaign.planHash}</span>.</p><div class="form-group"><label>Type APPROVE CAMPAIGN ${campaign.id}</label><input id="gc-lc-confirm" class="form-control mono" autocomplete="off"></div>`,
      { title: 'Approve lifecycle campaign', confirmText: 'Approve', onSubmit: c => ({ planHash: campaign.planHash, confirmation: c.querySelector('#gc-lc-confirm').value }) });
    if (!body) return;
    try { await Api.approveLifecycleCampaign(campaign.id, body); Toast.success('Campaign approved; provider execution remains separate'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _advanceLifecycleCampaign(id) {
    const campaign = (this._data.lifecycleMaintenance?.campaigns || []).find(item => item.id === Number(id));
    const stage = Math.min(...campaign.targets.filter(item => !['verified','skipped'].includes(item.state)).map(item => item.stage));
    const targets = campaign.targets.filter(item => item.stage === stage && !['verified','skipped'].includes(item.state));
    const result = await Modal.form(`<p class="text-muted text-sm">Attach evidence from an already completed durable operation. A failed operation or verification pauses the campaign.</p>
      <div class="form-group"><label>Current-stage target</label><select id="gc-lc-target" class="form-control">${targets.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.targetRef)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Durable operation ID</label><input id="gc-lc-operation" class="form-control mono" placeholder="op_..."></div>
      <div class="form-group"><label>Post-verification JSON</label><textarea id="gc-lc-verification" class="form-control mono" rows="7">{"passed":true,"health":"green"}</textarea></div>`,
    { title: `Advance campaign stage ${stage}`, onSubmit: c => this._submit(() => Api.advanceLifecycleCampaign(campaign.id, {
      targetId: Number(c.querySelector('#gc-lc-target').value), operationId: c.querySelector('#gc-lc-operation').value,
      verification: JSON.parse(c.querySelector('#gc-lc-verification').value),
    })) });
    if (result) { Toast.success(`Campaign is ${result.campaign.state}`); await this.render(this._container); }
  },

  async _lifecycleLivePatchDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Inventory is safe without approval. Apply/verify requires a matching approved live_patch.apply request, durable operation and typed confirmation. Unsupported providers remain explicit.</p>
      <div class="form-row"><div class="form-group"><label>Provider type</label><input id="gc-lp-provider" class="form-control" value="linux"></div><div class="form-group"><label>Host ID</label><input id="gc-lp-host" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Phase</label><select id="gc-lp-phase" class="form-control"><option>inventory</option><option>apply</option><option>verify</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Target reference</label><input id="gc-lp-target" class="form-control mono" value="node-a"></div><div class="form-group"><label>Patch ID</label><input id="gc-lp-patch" class="form-control mono" value="LP-1"></div></div>
      <div class="form-row"><div class="form-group"><label>Approval ID (apply/verify)</label><input id="gc-lp-approval" type="number" min="1" class="form-control"></div><div class="form-group"><label>Operation ID (apply/verify)</label><input id="gc-lp-operation" class="form-control mono"></div></div>
      <div class="form-group"><label>Typed confirmation (APPLY LIVE PATCH &lt;patch&gt; &lt;target&gt;)</label><input id="gc-lp-confirm" class="form-control mono"></div>
      <div class="form-group"><label>Adapter request JSON</label><textarea id="gc-lp-request" class="form-control mono" rows="6">{}</textarea></div>`,
    { title: 'Live-patch adapter evidence', width: '900px', onSubmit: c => this._submit(() => Api.recordLifecycleLivePatch({
      providerType: c.querySelector('#gc-lp-provider').value, providerHostId: Number(c.querySelector('#gc-lp-host').value),
      phase: c.querySelector('#gc-lp-phase').value, targetRef: c.querySelector('#gc-lp-target').value,
      patchId: c.querySelector('#gc-lp-patch').value, approvalId: Number(c.querySelector('#gc-lp-approval').value) || undefined,
      operationId: c.querySelector('#gc-lp-operation').value || undefined, confirmation: c.querySelector('#gc-lp-confirm').value || undefined,
      request: JSON.parse(c.querySelector('#gc-lp-request').value),
    })) });
    if (result) { Toast.success(`Live-patch evidence: ${result.evidence.phase}; no implicit reboot`); await this.render(this._container); }
  },

  async _lifecycleRebootDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Host ID</label><input id="gc-lr-host" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Target</label><input id="gc-lr-target" class="form-control mono" value="node-a"></div></div>
      <div class="form-row"><div class="form-group"><label>Source</label><select id="gc-lr-source" class="form-control"><option>kernel</option><option>hypervisor</option><option>toolstack</option><option>vendor</option></select></div><div class="form-group"><label>Signal key</label><input id="gc-lr-key" class="form-control mono" value="pending-update"></div><div class="form-group"><label>State</label><select id="gc-lr-state" class="form-control"><option>required</option><option>not_required</option><option>unknown</option></select></div></div>
      <div class="form-group"><label>Guidance</label><textarea id="gc-lr-guidance" class="form-control" rows="3">Schedule reboot inside an approved maintenance window.</textarea></div>`,
    { title: 'Reboot-required signal', onSubmit: c => this._submit(() => Api.recordLifecycleRebootSignal({
      providerHostId: Number(c.querySelector('#gc-lr-host').value), targetRef: c.querySelector('#gc-lr-target').value,
      signalSource: c.querySelector('#gc-lr-source').value, signalKey: c.querySelector('#gc-lr-key').value,
      requiredState: c.querySelector('#gc-lr-state').value, guidance: c.querySelector('#gc-lr-guidance').value,
      observedAt: new Date().toISOString(), evidence: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success(`Aggregate reboot state: ${result.status.requiredState}; reboot not scheduled`); await this.render(this._container); }
  },

  async _lifecycleFirmwareDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-lf-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Device model</label><input id="gc-lf-device" class="form-control" value="Device-1"></div><div class="form-group"><label>Component</label><select id="gc-lf-component" class="form-control"><option>bios</option><option>bmc</option><option>nic</option><option>storage</option><option>gpu</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Firmware version</label><input id="gc-lf-version" class="form-control mono" value="1.0"></div><div class="form-group"><label>Minimum driver</label><input id="gc-lf-driver" class="form-control mono"></div><div class="form-group"><label>Severity</label><select id="gc-lf-severity" class="form-control"><option>info</option><option>recommended</option><option>critical</option></select></div></div>
      <div class="form-group"><label>Compatible host releases</label><input id="gc-lf-releases" class="form-control mono" value="8.0"></div><div class="form-group"><label>Official HTTPS source</label><input id="gc-lf-source" class="form-control mono" value="https://vendor.example/firmware"></div>`,
    { title: 'Firmware compatibility catalog', onSubmit: c => this._submit(() => Api.saveLifecycleFirmware({
      vendor: c.querySelector('#gc-lf-vendor').value, deviceModel: c.querySelector('#gc-lf-device').value,
      componentType: c.querySelector('#gc-lf-component').value, firmwareVersion: c.querySelector('#gc-lf-version').value,
      minimumDriverVersion: c.querySelector('#gc-lf-driver').value || undefined, severity: c.querySelector('#gc-lf-severity').value,
      compatibleHostReleases: c.querySelector('#gc-lf-releases').value.split(',').map(value => value.trim()).filter(Boolean),
      sourceUrl: c.querySelector('#gc-lf-source').value, publishedAt: new Date().toISOString(), metadata: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success('Firmware compatibility evidence saved'); await this.render(this._container); }
  },

  async _lifecycleDriverDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-ld-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Device model</label><input id="gc-ld-device" class="form-control" value="Device-1"></div><div class="form-group"><label>Driver name</label><input id="gc-ld-name" class="form-control" value="driver"></div></div>
      <div class="form-row"><div class="form-group"><label>Driver version</label><input id="gc-ld-version" class="form-control mono" value="1.0"></div><div class="form-group"><label>Firmware version</label><input id="gc-ld-firmware" class="form-control mono" value="1.0"></div><div class="form-group"><label>Host release</label><input id="gc-ld-host-release" class="form-control mono" value="8.0"></div></div>
      <div class="form-row"><div class="form-group"><label>Status</label><select id="gc-ld-status" class="form-control"><option>supported</option><option>deprecated</option><option>blocked</option></select></div><div class="form-group"><label>Official HTTPS source</label><input id="gc-ld-source" class="form-control mono" value="https://vendor.example/driver-matrix"></div></div>`,
    { title: 'Driver compatibility matrix', onSubmit: c => this._submit(async () => { const body = {
      vendor: c.querySelector('#gc-ld-vendor').value, deviceModel: c.querySelector('#gc-ld-device').value,
      driverName: c.querySelector('#gc-ld-name').value, driverVersion: c.querySelector('#gc-ld-version').value,
      firmwareVersion: c.querySelector('#gc-ld-firmware').value, hostRelease: c.querySelector('#gc-ld-host-release').value,
      status: c.querySelector('#gc-ld-status').value, sourceUrl: c.querySelector('#gc-ld-source').value,
    }; await Api.saveLifecycleDriverCompatibility(body); return Api.checkLifecycleDriverCompatibility(body); }) });
    if (result) { Toast.success(`Driver compatibility: ${result.status}; remediation not scheduled`); await this.render(this._container); }
  },

  async _lifecycleCertificateDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Link an existing tracked certificate when available; ownership can also be registered before discovery completes.</p>
      <div class="form-row"><div class="form-group"><label>Tracked certificate ID</label><input id="gc-lcert-id" type="number" min="1" class="form-control"></div><div class="form-group"><label>Inventory key</label><input id="gc-lcert-key" class="form-control mono" value="tls/service"></div><div class="form-group"><label>Environment</label><select id="gc-lcert-env" class="form-control"><option>production</option><option>nonproduction</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Resource type</label><select id="gc-lcert-type" class="form-control"><option>endpoint</option><option>service</option><option>host</option></select></div><div class="form-group"><label>Resource reference</label><input id="gc-lcert-ref" class="form-control mono" value="service-api"></div><div class="form-group"><label>HTTPS endpoint</label><input id="gc-lcert-endpoint" class="form-control mono" value="https://service.example.com"></div></div>
      <div class="form-row"><div class="form-group"><label>Owner</label><input id="gc-lcert-owner" class="form-control" value="platform"></div><div class="form-group"><label>Escalation admin ID</label><input id="gc-lcert-escalation" type="number" min="1" class="form-control"></div><div class="form-group"><label>Maintenance plan ID</label><input id="gc-lcert-plan" type="number" min="1" class="form-control"></div></div>`,
    { title: 'Certificate ownership inventory', width: '920px', onSubmit: c => this._submit(() => Api.saveLifecycleCertificateOwnership({
      certificateId: Number(c.querySelector('#gc-lcert-id').value) || undefined, inventoryKey: c.querySelector('#gc-lcert-key').value,
      resourceType: c.querySelector('#gc-lcert-type').value, resourceRef: c.querySelector('#gc-lcert-ref').value,
      endpoint: c.querySelector('#gc-lcert-endpoint').value || undefined, owner: c.querySelector('#gc-lcert-owner').value,
      escalationUserId: Number(c.querySelector('#gc-lcert-escalation').value) || undefined,
      maintenancePlanId: Number(c.querySelector('#gc-lcert-plan').value) || undefined,
      environment: c.querySelector('#gc-lcert-env').value,
    })) });
    if (result) { Toast.success('Certificate ownership saved'); await this.render(this._container); }
  },

  async _lifecycleReminderPolicyDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-lrp-name" class="form-control" value="certificate-expiry-${Date.now()}"></div><div class="form-group"><label>Environment</label><select id="gc-lrp-env" class="form-control"><option>all</option><option>production</option><option>nonproduction</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Threshold days</label><input id="gc-lrp-days" class="form-control mono" value="90,30,14,7,1,0"></div><div class="form-group"><label>Escalation admin ID</label><input id="gc-lrp-escalation" type="number" min="1" class="form-control"></div></div>
      <label><input id="gc-lrp-maintenance" type="checkbox" checked> Require maintenance-plan dependency before renewal</label>`,
    { title: 'Certificate renewal reminders', onSubmit: c => this._submit(() => Api.createLifecycleCertificateReminderPolicy({
      name: c.querySelector('#gc-lrp-name').value, environment: c.querySelector('#gc-lrp-env').value,
      thresholdDays: c.querySelector('#gc-lrp-days').value.split(',').map(value => Number(value.trim())),
      escalationUserId: Number(c.querySelector('#gc-lrp-escalation').value) || undefined,
      requireMaintenanceWindow: c.querySelector('#gc-lrp-maintenance').checked,
    })) });
    if (result) { Toast.success('Certificate reminder policy saved'); await this.render(this._container); }
  },

  async _evaluateLifecycleReminders() {
    try { const result = await Api.evaluateLifecycleCertificateReminders();
      Toast.success(`${result.created} reminders created; ${result.renewalsStarted} renewals started`); await this.render(this._container);
    } catch (error) { Toast.error(error.message); }
  },

  async _finopsLedgerDialog() {
    const intervalEnd = new Date(); const intervalStart = new Date(intervalEnd.getTime() - 30 * 86400000);
    const result = await Modal.form(`<p class="text-muted text-sm">This writes one immutable observation. Allocated and used values stay separate and the source evidence must be secret-free.</p>
      <div class="form-row"><div class="form-group"><label>Resource type</label><input id="gc-fl-type" class="form-control" value="vm"></div><div class="form-group"><label>Resource reference</label><input id="gc-fl-ref" class="form-control mono" value="provider/vm-100"></div><div class="form-group"><label>Provider / site</label><input id="gc-fl-provider" class="form-control mono" value="provider-a"><input id="gc-fl-site" class="form-control mono" value="site-a" style="margin-top:6px"></div></div>
      <div class="form-row"><div class="form-group"><label>Interval start</label><input id="gc-fl-start" type="datetime-local" class="form-control" value="${intervalStart.toISOString().slice(0, 16)}"></div><div class="form-group"><label>Interval end</label><input id="gc-fl-end" type="datetime-local" class="form-control" value="${intervalEnd.toISOString().slice(0, 16)}"></div></div>
      <div class="form-row"><div class="form-group"><label>Allocation JSON</label><textarea id="gc-fl-allocation" class="form-control mono" rows="9">{"vCpu":4,"ramGb":16,"logicalStorageGb":200,"gpuDevices":0,"publicIps":1}</textarea></div><div class="form-group"><label>Usage JSON</label><textarea id="gc-fl-usage" class="form-control mono" rows="9">{"usedVcpu":1.5,"usedRamGb":8,"peakVcpu":2.5,"peakRamGb":10,"uptimeHours":720,"transferGb":100,"egressGb":10,"publicIpHours":730}</textarea></div></div>
      <div class="form-row"><div class="form-group"><label>Tags JSON</label><textarea id="gc-fl-tags" class="form-control mono" rows="5">{"business-unit":"platform","app":"docker-dash","env":"production","cost-center":"IT-PLATFORM"}</textarea></div><div class="form-group"><label>Source evidence JSON</label><textarea id="gc-fl-evidence" class="form-control mono" rows="5">{"source":"provider-metering","coverage":"complete"}</textarea></div></div>`,
    { title: 'FinOps resource ledger observation', width: '980px', onSubmit: c => this._submit(() => Api.recordFinOpsLedger({
      resourceType: c.querySelector('#gc-fl-type').value, resourceRef: c.querySelector('#gc-fl-ref').value,
      providerRef: c.querySelector('#gc-fl-provider').value || undefined, siteRef: c.querySelector('#gc-fl-site').value || undefined,
      intervalStart: new Date(c.querySelector('#gc-fl-start').value).toISOString(), intervalEnd: new Date(c.querySelector('#gc-fl-end').value).toISOString(),
      allocation: JSON.parse(c.querySelector('#gc-fl-allocation').value), usage: JSON.parse(c.querySelector('#gc-fl-usage').value),
      tags: JSON.parse(c.querySelector('#gc-fl-tags').value), evidence: JSON.parse(c.querySelector('#gc-fl-evidence').value),
    })) });
    if (result) { Toast.success(result.entry.duplicate ? 'Identical ledger evidence already exists' : 'Immutable ledger evidence recorded'); await this.render(this._container); }
  },

  async _finopsModelDialog() {
    const from = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)); const to = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 0, 1));
    const sample = { monthlyCosts: { hardware: 5000, software: 1500, facility: 800, energy: 1200, personnel: 3000 },
      capacity: { vCpu: 512, ramGb: 2048 }, weights: { vCpu: 0.5, ramGb: 0.5 } };
    const result = await Modal.form(`<p class="text-muted text-sm">Choose one kind and provide its parameters: private cloud monthlyCosts/capacity/weights; provider_license metric/unitCost/billingPeriod; storage or network rates; GPU profiles.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fm-name" class="form-control" value="private-cloud-${Date.now()}"></div><div class="form-group"><label>Version</label><input id="gc-fm-version" class="form-control mono" value="1.0"></div><div class="form-group"><label>Kind</label><select id="gc-fm-kind" class="form-control"><option value="private_cloud">private_cloud</option><option value="provider_license">provider_license</option><option value="storage">storage</option><option value="network">network</option><option value="gpu">gpu</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Scope</label><input id="gc-fm-scope" class="form-control mono" value="*"></div><div class="form-group"><label>Currency</label><input id="gc-fm-currency" class="form-control" value="EUR"></div><div class="form-group"><label>Confidence</label><select id="gc-fm-confidence" class="form-control"><option>actual</option><option>contracted</option><option selected>estimated</option><option>allocated</option></select></div></div>
      <div class="form-group"><label>Parameters JSON</label><textarea id="gc-fm-parameters" class="form-control mono" rows="13">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea></div>
      <div class="form-row"><div class="form-group"><label>Source URL</label><input id="gc-fm-source" class="form-control mono" value="https://finance.example/cost-model"></div><div class="form-group"><label>Effective from</label><input id="gc-fm-from" type="datetime-local" class="form-control" value="${from.toISOString().slice(0, 16)}"></div><div class="form-group"><label>Effective to</label><input id="gc-fm-to" type="datetime-local" class="form-control" value="${to.toISOString().slice(0, 16)}"></div></div>`,
    { title: 'Versioned FinOps cost model', width: '950px', onSubmit: c => this._submit(() => Api.createFinOpsCostModel({
      name: c.querySelector('#gc-fm-name').value, version: c.querySelector('#gc-fm-version').value,
      kind: c.querySelector('#gc-fm-kind').value, scopeRef: c.querySelector('#gc-fm-scope').value,
      currency: c.querySelector('#gc-fm-currency').value.toUpperCase(), confidence: c.querySelector('#gc-fm-confidence').value,
      parameters: JSON.parse(c.querySelector('#gc-fm-parameters').value), sourceUrl: c.querySelector('#gc-fm-source').value,
      effectiveFrom: new Date(c.querySelector('#gc-fm-from').value).toISOString(),
      effectiveTo: c.querySelector('#gc-fm-to').value ? new Date(c.querySelector('#gc-fm-to').value).toISOString() : undefined,
    })) });
    if (result) { Toast.success(result.model.duplicate ? 'Identical cost model already exists' : 'Cost model version saved'); await this.render(this._container); }
  },

  async _finopsRuleDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Higher priority rules fill dimensions first. Values may contain <code>*</code>; no provider tags are changed.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fr-name" class="form-control" value="production-app"></div><div class="form-group"><label>Priority</label><input id="gc-fr-priority" type="number" min="0" max="10000" value="100" class="form-control"></div></div>
      <div class="form-group"><label>Match tags JSON</label><textarea id="gc-fr-match" class="form-control mono" rows="6">{"env":"production","app":"*"}</textarea></div>
      <div class="form-group"><label>Business dimensions JSON</label><textarea id="gc-fr-dimensions" class="form-control mono" rows="7">{"businessUnit":"platform","application":"docker-dash","environment":"production","costCenter":"IT-PLATFORM"}</textarea></div>`,
    { title: 'Tag-based cost allocation rule', onSubmit: c => this._submit(() => Api.saveFinOpsAllocationRule({
      name: c.querySelector('#gc-fr-name').value, priority: Number(c.querySelector('#gc-fr-priority').value),
      matchTags: JSON.parse(c.querySelector('#gc-fr-match').value), dimensions: JSON.parse(c.querySelector('#gc-fr-dimensions').value), active: true,
    })) });
    if (result) { Toast.success('Allocation rule saved; provider resources unchanged'); await this.render(this._container); }
  },

  async _finopsBudgetDialog() {
    const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fb-name" class="form-control" value="Platform monthly"></div><div class="form-group"><label>Cadence</label><select id="gc-fb-cadence" class="form-control"><option>monthly</option><option>quarterly</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Scope type</label><select id="gc-fb-scope" class="form-control"><option>global</option><option>cost_center</option><option>business_unit</option><option>application</option><option>environment</option><option>project</option><option>site</option></select></div><div class="form-group"><label>Scope value (blank for global)</label><input id="gc-fb-value" class="form-control" value=""></div></div>
      <div class="form-row"><div class="form-group"><label>Amount</label><input id="gc-fb-amount" type="number" min="0.01" step="0.01" value="10000" class="form-control"></div><div class="form-group"><label>Currency</label><input id="gc-fb-currency" class="form-control" value="EUR"></div><div class="form-group"><label>Effective from</label><input id="gc-fb-from" type="datetime-local" class="form-control" value="${from.toISOString().slice(0, 16)}"></div></div>`,
    { title: 'Scoped FinOps budget', onSubmit: c => this._submit(() => Api.createFinOpsBudget({
      name: c.querySelector('#gc-fb-name').value, cadence: c.querySelector('#gc-fb-cadence').value,
      scopeType: c.querySelector('#gc-fb-scope').value, scopeValue: c.querySelector('#gc-fb-value').value || undefined,
      amount: Number(c.querySelector('#gc-fb-amount').value), currency: c.querySelector('#gc-fb-currency').value.toUpperCase(),
      effectiveFrom: new Date(c.querySelector('#gc-fb-from').value).toISOString(), active: true,
    })) });
    if (result) { Toast.success('Budget saved; configure threshold notifications from Budget alerts'); await this.render(this._container); }
  },

  async _finopsRatingDialog() {
    const models = this._data.finopsFoundation?.costModels || []; if (!models.length) return Toast.error('Create at least one cost model first');
    const entries = this._data.finopsFoundation?.ledger || []; const earliest = entries.length ? new Date(Math.min(...entries.map(item => new Date(item.intervalStart)))) : new Date(Date.now() - 30 * 86400000);
    const latest = entries.length ? new Date(Math.max(...entries.map(item => new Date(item.intervalEnd)))) : new Date();
    const result = await Modal.form(`<p class="text-muted text-sm">Only ledger intervals fully contained in the selected period are rated. Every selected model must cover the whole period and use the same currency.</p>
      <div class="form-row"><div class="form-group"><label>Period start</label><input id="gc-frr-start" type="datetime-local" class="form-control" value="${earliest.toISOString().slice(0, 16)}"></div><div class="form-group"><label>Period end</label><input id="gc-frr-end" type="datetime-local" class="form-control" value="${latest.toISOString().slice(0, 16)}"></div></div>
      <div class="form-group"><label>Cost model versions</label><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;margin-top:8px">${models.map(item => `<label class="card" style="padding:10px"><input type="checkbox" data-finops-model-id="${item.id}" checked> <strong>${Utils.escapeHtml(item.name)}</strong><div class="text-xs text-muted">${item.kind} · ${item.currency} · ${item.confidence}</div></label>`).join('')}</div></div>`,
    { title: 'Create immutable showback rating', width: '900px', onSubmit: c => this._submit(() => Api.createFinOpsRatingRun({
      periodStart: new Date(c.querySelector('#gc-frr-start').value).toISOString(), periodEnd: new Date(c.querySelector('#gc-frr-end').value).toISOString(),
      costModelIds: [...c.querySelectorAll('[data-finops-model-id]:checked')].map(input => Number(input.dataset.finopsModelId)),
    })) });
    if (result) { Toast.success(`Showback ${result.run.currency} ${Number(result.run.totalCost).toFixed(4)}; billing transactions: 0`); await this.render(this._container); }
  },

  async _finopsExport(runId, format) {
    try {
      const result = await Api.createFinOpsChargebackExport(runId, { format });
      const blob = new Blob([result.content], { type: result.export.metadata.contentType }); const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = result.export.metadata.filename; link.click(); URL.revokeObjectURL(url);
      Toast.success(`${result.export.rowCount} rated rows exported; no billing transaction created`); await this.render(this._container);
    } catch (error) { Toast.error(error.message); }
  },

  async _finopsAlertPolicyDialog() {
    const budgets = this._data.finopsFoundation?.budgets || [];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fap-name" class="form-control" value="budget-thresholds"></div><div class="form-group"><label>Budget</label><select id="gc-fap-budget" class="form-control"><option value="">All budgets</option>${budgets.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-group"><label>Thresholds (%)</label><input id="gc-fap-thresholds" class="form-control mono" value="50,80,100"></div><div class="form-group"><label>Channels</label><input id="gc-fap-channels" class="form-control mono" value="in_app"></div></div><label><input id="gc-fap-forecast" type="checkbox" checked> Queue forecast threshold notifications</label>`,
    { title: 'Budget threshold policy', onSubmit: c => this._submit(() => Api.saveFinOpsBudgetAlertPolicy({
      name: c.querySelector('#gc-fap-name').value, budgetId: Number(c.querySelector('#gc-fap-budget').value) || undefined,
      thresholds: c.querySelector('#gc-fap-thresholds').value.split(',').map(Number),
      channels: c.querySelector('#gc-fap-channels').value.split(',').map(value => value.trim()).filter(Boolean),
      forecastEnabled: c.querySelector('#gc-fap-forecast').checked, active: true,
    })) });
    if (result) { Toast.success('Budget alert policy saved'); await this.render(this._container); }
  },

  async _finopsAnomalyPolicyDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fan-name" class="form-control" value="unexpected-spend"></div><div class="form-group"><label>Scope</label><select id="gc-fan-scope" class="form-control"><option>global</option><option>category</option><option>cost_center</option></select></div><div class="form-group"><label>Scope value</label><input id="gc-fan-value" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Baseline runs</label><input id="gc-fan-runs" type="number" min="2" max="24" value="6" class="form-control"></div><div class="form-group"><label>Minimum deviation %</label><input id="gc-fan-deviation" type="number" min="1" value="30" class="form-control"></div><div class="form-group"><label>Minimum amount</label><input id="gc-fan-amount" type="number" min="0" value="10" class="form-control"></div></div>`,
    { title: 'Cost anomaly policy', onSubmit: c => this._submit(() => Api.saveFinOpsAnomalyPolicy({
      name: c.querySelector('#gc-fan-name').value, scopeType: c.querySelector('#gc-fan-scope').value,
      scopeValue: c.querySelector('#gc-fan-value').value || undefined, baselineRuns: Number(c.querySelector('#gc-fan-runs').value),
      minimumDeviationPercent: Number(c.querySelector('#gc-fan-deviation').value), minimumAmount: Number(c.querySelector('#gc-fan-amount').value), active: true,
    })) });
    if (result) { Toast.success('Cost anomaly policy saved'); await this.render(this._container); }
  },

  async _finopsIdleDialog(ledgerId) {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Data coverage %</label><input id="gc-fid-coverage" type="number" min="0" max="100" value="95" class="form-control"></div><div class="form-group"><label>Minimum uptime hours</label><input id="gc-fid-uptime" type="number" min="0" value="168" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>CPU threshold %</label><input id="gc-fid-cpu" type="number" min="0" max="100" value="10" class="form-control"></div><div class="form-group"><label>RAM threshold %</label><input id="gc-fid-ram" type="number" min="0" max="100" value="20" class="form-control"></div><div class="form-group"><label>Criticality override</label><input id="gc-fid-criticality" class="form-control" placeholder="use tag"></div></div>`,
    { title: 'Idle VM assessment', onSubmit: c => this._submit(() => Api.assessFinOpsIdleVm(ledgerId, {
      dataCoveragePercent: Number(c.querySelector('#gc-fid-coverage').value), minimumUptimeHours: Number(c.querySelector('#gc-fid-uptime').value),
      cpuThresholdPercent: Number(c.querySelector('#gc-fid-cpu').value), ramThresholdPercent: Number(c.querySelector('#gc-fid-ram').value),
      criticality: c.querySelector('#gc-fid-criticality').value || undefined,
    })) });
    if (result) { Toast.success(`Idle assessment: ${result.assessment.state}; auto-stop false`); await this.render(this._container); }
  },

  async _finopsOversizedDialog(ledgerId) {
    const result = await Modal.form(`<p class="text-muted text-sm">Peak CPU/RAM values must exist in the ledger. Recommendations never resize the VM.</p><div class="form-row"><div class="form-group"><label>Coverage %</label><input id="gc-fov-coverage" type="number" min="0" max="100" value="95" class="form-control"></div><div class="form-group"><label>Observation days</label><input id="gc-fov-days" type="number" min="1" value="30" class="form-control"></div><div class="form-group"><label>Peak headroom %</label><input id="gc-fov-headroom" type="number" min="0" value="30" class="form-control"></div><div class="form-group"><label>Min reduction %</label><input id="gc-fov-reduction" type="number" min="0" max="100" value="20" class="form-control"></div></div>`,
    { title: 'Oversized VM assessment', onSubmit: c => this._submit(() => Api.assessFinOpsOversizedVm(ledgerId, {
      dataCoveragePercent: Number(c.querySelector('#gc-fov-coverage').value), observationDays: Number(c.querySelector('#gc-fov-days').value),
      headroomPercent: Number(c.querySelector('#gc-fov-headroom').value), minimumReductionPercent: Number(c.querySelector('#gc-fov-reduction').value),
    })) });
    if (result) { Toast.success(`Rightsize assessment: ${result.assessment.state}; provider unchanged`); await this.render(this._container); }
  },

  async _finopsZombieDialog() {
    const lastUsed = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 16);
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Type</label><select id="gc-fzr-type" class="form-control"><option>disk</option><option>snapshot</option><option>ip</option><option>template</option><option>backup</option></select></div><div class="form-group"><label>Resource reference</label><input id="gc-fzr-ref" class="form-control mono" value="resource-old"></div><div class="form-group"><label>Owner</label><input id="gc-fzr-owner" class="form-control" value="platform"></div></div>
      <div class="form-row"><div class="form-group"><label>Last used</label><input id="gc-fzr-last" type="datetime-local" class="form-control" value="${lastUsed}"></div><div class="form-group"><label>Stale after days</label><input id="gc-fzr-days" type="number" min="1" value="30" class="form-control"></div></div><label><input id="gc-fzr-attached" type="checkbox"> Attached</label> <label style="margin-left:16px"><input id="gc-fzr-protected" type="checkbox"> Protected</label>`,
    { title: 'Zombie resource assessment', onSubmit: c => this._submit(() => Api.assessFinOpsZombie({
      resourceType: c.querySelector('#gc-fzr-type').value, resourceRef: c.querySelector('#gc-fzr-ref').value,
      owner: c.querySelector('#gc-fzr-owner').value || undefined, lastUsedAt: new Date(c.querySelector('#gc-fzr-last').value).toISOString(),
      observedAt: new Date().toISOString(), staleDays: Number(c.querySelector('#gc-fzr-days').value),
      attached: c.querySelector('#gc-fzr-attached').checked, protected: c.querySelector('#gc-fzr-protected').checked,
      evidence: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success(`Zombie assessment: ${result.assessment.state}; auto-delete false`); await this.render(this._container); }
  },

  async _finopsScheduleDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Recommend mode never mutates. Automate mode still needs a hash-bound approval, durable operation, typed phrase and registered adapter.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fss-name" class="form-control" value="off-hours-${Date.now()}"></div><div class="form-group"><label>Resource</label><input id="gc-fss-ref" class="form-control mono" value="provider/vm-100"></div><div class="form-group"><label>Owner</label><input id="gc-fss-owner" class="form-control" value="platform"></div></div>
      <div class="form-row"><div class="form-group"><label>Timezone</label><input id="gc-fss-zone" class="form-control" value="Europe/Bucharest"></div><div class="form-group"><label>Weekdays (1-7)</label><input id="gc-fss-days" class="form-control mono" value="1,2,3,4,5"></div><div class="form-group"><label>Off-hours</label><input id="gc-fss-start" class="form-control" value="20:00"><input id="gc-fss-end" class="form-control" value="07:00" style="margin-top:6px"></div></div>
      <div class="form-row"><div class="form-group"><label>Mode</label><select id="gc-fss-mode" class="form-control"><option>recommend</option><option>automate</option></select></div><div class="form-group"><label>Adapter key</label><input id="gc-fss-adapter" class="form-control mono" value="provider"></div></div>`,
    { title: 'Schedule-based savings policy', onSubmit: c => this._submit(() => Api.saveFinOpsSavingsSchedule({
      name: c.querySelector('#gc-fss-name').value, resourceRef: c.querySelector('#gc-fss-ref').value, owner: c.querySelector('#gc-fss-owner').value,
      timezone: c.querySelector('#gc-fss-zone').value, weekdays: c.querySelector('#gc-fss-days').value.split(',').map(Number),
      offHoursStart: c.querySelector('#gc-fss-start').value, offHoursEnd: c.querySelector('#gc-fss-end').value,
      mode: c.querySelector('#gc-fss-mode').value, adapterKey: c.querySelector('#gc-fss-adapter').value, active: true,
    })) });
    if (result) { Toast.success(`Savings schedule saved in ${result.schedule.mode} mode`); await this.render(this._container); }
  },

  async _finopsExecuteScheduleDialog(id) {
    const schedule = (this._data.finopsOptimization?.schedules || []).find(item => item.id === Number(id)); if (!schedule) return;
    const result = await Modal.form(`<p class="text-muted text-sm">For recommend mode, credentials below are ignored. Automate requires action-specific approval hash and durable operation.</p>
      <div class="form-row"><div class="form-group"><label>Action</label><select id="gc-fse-action" class="form-control"><option>stop</option><option>start</option></select></div><div class="form-group"><label>Scheduled at</label><input id="gc-fse-at" type="datetime-local" class="form-control" value="${new Date().toISOString().slice(0, 16)}"></div></div>
      <div class="form-row"><div class="form-group"><label>Approval ID</label><input id="gc-fse-approval" type="number" min="1" class="form-control"></div><div class="form-group"><label>Durable operation ID</label><input id="gc-fse-operation" class="form-control mono" placeholder="op_..."></div></div>
      <div class="form-group"><label>Type EXECUTE SAVINGS ${schedule.id}</label><input id="gc-fse-confirm" class="form-control mono"></div>`,
    { title: `Savings execution · ${schedule.mode}`, danger: schedule.mode === 'automate', onSubmit: c => this._submit(() => Api.executeFinOpsSavingsSchedule(schedule.id, {
      action: c.querySelector('#gc-fse-action').value, scheduledAt: new Date(c.querySelector('#gc-fse-at').value).toISOString(),
      approvalId: Number(c.querySelector('#gc-fse-approval').value) || undefined, operationId: c.querySelector('#gc-fse-operation').value || undefined,
      confirmation: c.querySelector('#gc-fse-confirm').value,
    })) });
    if (result) { Toast.success(`Savings execution state: ${result.execution.state}`); await this.render(this._container); }
  },

  async _finopsReservationDialog() {
    const options = [{ name: 'new-host', type: 'on_prem', capacity: { vCpu: 64, ramGb: 512 }, monthlyCost: 1200, termMonths: 36 },
      { name: 'cloud-commitment', type: 'cloud_commitment', capacity: { vCpu: 32, ramGb: 128 }, monthlyCost: 700, termMonths: 12 }];
    const result = await Modal.form(`<div class="form-group"><label>Scope</label><input id="gc-frc-scope" class="form-control mono" value="cluster-a"></div>
      <div class="form-row"><div class="form-group"><label>Current capacity JSON</label><textarea id="gc-frc-current" class="form-control mono" rows="4">{"vCpu":100,"ramGb":500}</textarea></div><div class="form-group"><label>Peak demand JSON</label><textarea id="gc-frc-peak" class="form-control mono" rows="4">{"vCpu":90,"ramGb":400}</textarea></div><div class="form-group"><label>Forecast demand JSON</label><textarea id="gc-frc-forecast" class="form-control mono" rows="4">{"vCpu":110,"ramGb":450}</textarea></div></div>
      <div class="form-group"><label>Purchase/commitment options JSON</label><textarea id="gc-frc-options" class="form-control mono" rows="12">${Utils.escapeHtml(JSON.stringify(options, null, 2))}</textarea></div>`,
    { title: 'Reserved capacity recommendation', width: '950px', onSubmit: c => this._submit(() => Api.recommendFinOpsReservedCapacity({
      scopeRef: c.querySelector('#gc-frc-scope').value, currentCapacity: JSON.parse(c.querySelector('#gc-frc-current').value),
      peakDemand: JSON.parse(c.querySelector('#gc-frc-peak').value), forecastDemand: JSON.parse(c.querySelector('#gc-frc-forecast').value),
      headroomPercent: 20, options: JSON.parse(c.querySelector('#gc-frc-options').value),
    })) });
    if (result) { Toast.success(`Capacity recommendation: ${result.recommendation.state}; no purchase started`); await this.render(this._container); }
  },

  async _finopsConsolidationDialog() {
    const hosts = ['host-a','host-b','host-c'].map(ref => ({ ref, capacity: { vCpu: 64, ramGb: 256 }, demand: { vCpu: 12, ramGb: 48 }, haEligible: true }));
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-fcs-name" class="form-control" value="remove-host-a"></div><div class="form-group"><label>Removed host</label><input id="gc-fcs-remove" class="form-control mono" value="host-a"></div></div>
      <div class="form-group"><label>Host capacity/demand JSON</label><textarea id="gc-fcs-hosts" class="form-control mono" rows="16">${Utils.escapeHtml(JSON.stringify(hosts, null, 2))}</textarea></div>`,
    { title: 'N+1 consolidation scenario', width: '900px', onSubmit: c => this._submit(() => Api.simulateFinOpsConsolidation({
      name: c.querySelector('#gc-fcs-name').value, removedHostRef: c.querySelector('#gc-fcs-remove').value,
      hosts: JSON.parse(c.querySelector('#gc-fcs-hosts').value), failureToleranceHosts: 1, maximumUtilizationPercent: 80,
    })) });
    if (result) { Toast.success(`Consolidation scenario: ${result.scenario.state}; provider unchanged`); await this.render(this._container); }
  },

  async _finopsForecastDialog() {
    const observations = [0,30,60].map((day, index) => ({ timestamp: new Date(Date.now() - (60 - day) * 86400000).toISOString(),
      vCpu: 40 + index * 10, ramGb: 160 + index * 30, storageGb: 500 + index * 100 }));
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Scope</label><input id="gc-fcf-scope" class="form-control mono" value="cluster-a"></div><div class="form-group"><label>Horizon days</label><input id="gc-fcf-days" type="number" min="1" max="1095" value="365" class="form-control"></div><div class="form-group"><label>Failure reserve %</label><input id="gc-fcf-reserve" type="number" min="0" max="90" value="20" class="form-control"></div></div>
      <div class="form-group"><label>Current capacity JSON</label><input id="gc-fcf-capacity" class="form-control mono" value='{"vCpu":128,"ramGb":512,"storageGb":2000}'></div>
      <div class="form-group"><label>Observations JSON</label><textarea id="gc-fcf-observations" class="form-control mono" rows="15">${Utils.escapeHtml(JSON.stringify(observations, null, 2))}</textarea></div>`,
    { title: 'Capacity purchase forecast', width: '900px', onSubmit: c => this._submit(() => Api.forecastFinOpsCapacity({
      scopeRef: c.querySelector('#gc-fcf-scope').value, horizonDays: Number(c.querySelector('#gc-fcf-days').value),
      failureReservePercent: Number(c.querySelector('#gc-fcf-reserve').value), currentCapacity: JSON.parse(c.querySelector('#gc-fcf-capacity').value),
      observations: JSON.parse(c.querySelector('#gc-fcf-observations').value),
    })) });
    if (result) { Toast.success(`Capacity forecast: ${result.forecast.recommendation}; no purchase started`); await this.render(this._container); }
  },

  async _finopsPlacementDialog() {
    const candidates = [{ targetRef: 'cluster-a', scores: { cost: 80, performance: 90, resilience: 95, compliance: 100 } },
      { targetRef: 'cluster-b', scores: { cost: 100, performance: 80, resilience: 80, compliance: 60 } }];
    const result = await Modal.form(`<div class="form-group"><label>Workload</label><input id="gc-fps-workload" class="form-control mono" value="vm-workload"></div>
      <div class="form-row"><div class="form-group"><label>Weights JSON</label><input id="gc-fps-weights" class="form-control mono" value='{"cost":40,"performance":20,"resilience":20,"compliance":20}'></div><div class="form-group"><label>Minimum compliance</label><input id="gc-fps-compliance" type="number" min="0" max="100" value="70" class="form-control"></div></div>
      <div class="form-group"><label>Candidates JSON</label><textarea id="gc-fps-candidates" class="form-control mono" rows="14">${Utils.escapeHtml(JSON.stringify(candidates, null, 2))}</textarea></div>`,
    { title: 'Workload placement cost score', width: '900px', onSubmit: c => this._submit(() => Api.scoreFinOpsPlacement({
      workloadRef: c.querySelector('#gc-fps-workload').value, weights: JSON.parse(c.querySelector('#gc-fps-weights').value),
      minimumComplianceScore: Number(c.querySelector('#gc-fps-compliance').value), candidates: JSON.parse(c.querySelector('#gc-fps-candidates').value),
    })) });
    if (result) { Toast.success(`Placement recommendation: ${result.score.selectedTargetRef || 'no eligible target'}; no placement started`); await this.render(this._container); }
  },

  async _finopsPowerDialog() {
    const end = new Date(); const start = new Date(end.getTime() - 3600000);
    const result = await Modal.form(`<p class="text-muted text-sm">Normalize a BMC, vendor or meter observation. Energy is calculated from average watts when no meter kWh is supplied.</p>
      <div class="form-row"><div class="form-group"><label>Host reference</label><input id="gc-fep-host" class="form-control mono" value="host-a"></div><div class="form-group"><label>Site</label><input id="gc-fep-site" class="form-control mono" value="site-a"></div><div class="form-group"><label>Source</label><select id="gc-fep-source" class="form-control"><option>bmc</option><option>vendor</option><option>meter</option><option>manual</option><option>import</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Start</label><input id="gc-fep-start" type="datetime-local" class="form-control" value="${start.toISOString().slice(0, 16)}"></div><div class="form-group"><label>End</label><input id="gc-fep-end" type="datetime-local" class="form-control" value="${end.toISOString().slice(0, 16)}"></div></div>
      <div class="form-row"><div class="form-group"><label>Average watts</label><input id="gc-fep-avg" type="number" min="0" value="500" class="form-control"></div><div class="form-group"><label>Peak watts</label><input id="gc-fep-peak" type="number" min="0" value="800" class="form-control"></div><div class="form-group"><label>CPU utilization %</label><input id="gc-fep-cpu" type="number" min="0" max="100" value="20" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>VM count</label><input id="gc-fep-vms" type="number" min="0" value="10" class="form-control"></div><div class="form-group"><label>Workload count</label><input id="gc-fep-workloads" type="number" min="0" value="10" class="form-control"></div></div>`,
    { title: 'Power / energy telemetry evidence', width: '900px', onSubmit: c => this._submit(() => Api.recordFinOpsPowerTelemetry({
      hostRef: c.querySelector('#gc-fep-host').value, siteRef: c.querySelector('#gc-fep-site').value,
      intervalStart: new Date(c.querySelector('#gc-fep-start').value).toISOString(),
      intervalEnd: new Date(c.querySelector('#gc-fep-end').value).toISOString(),
      averageWatts: Number(c.querySelector('#gc-fep-avg').value), peakWatts: Number(c.querySelector('#gc-fep-peak').value),
      cpuUtilizationPercent: Number(c.querySelector('#gc-fep-cpu').value), vmCount: Number(c.querySelector('#gc-fep-vms').value),
      workloadCount: Number(c.querySelector('#gc-fep-workloads').value), sourceKind: c.querySelector('#gc-fep-source').value,
      provenance: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success(`Power evidence recorded: ${result.sample.energyKwh} kWh`); await this.render(this._container); }
  },

  async _finopsCarbonFactorDialog() {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Site</label><input id="gc-fcfactor-site" class="form-control mono" value="site-a"></div><div class="form-group"><label>Region</label><input id="gc-fcfactor-region" class="form-control" value="EU-RO"></div><div class="form-group"><label>gCO₂e / kWh</label><input id="gc-fcfactor-value" type="number" min="0" value="250" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>Effective from</label><input id="gc-fcfactor-from" type="datetime-local" class="form-control" value="${new Date().toISOString().slice(0, 16)}"></div><div class="form-group"><label>Effective to (optional)</label><input id="gc-fcfactor-to" type="datetime-local" class="form-control"></div></div>
      <div class="form-group"><label>Methodology</label><input id="gc-fcfactor-method" class="form-control" value="Location-based grid intensity"></div><div class="form-group"><label>Credential-free HTTPS source</label><input id="gc-fcfactor-url" class="form-control mono" value="https://carbon.example/factors"></div>`,
    { title: 'Carbon intensity factor', width: '850px', onSubmit: c => this._submit(() => Api.saveFinOpsCarbonFactor({
      siteRef: c.querySelector('#gc-fcfactor-site').value, region: c.querySelector('#gc-fcfactor-region').value,
      gramsCo2ePerKwh: Number(c.querySelector('#gc-fcfactor-value').value),
      effectiveFrom: new Date(c.querySelector('#gc-fcfactor-from').value).toISOString(),
      effectiveTo: c.querySelector('#gc-fcfactor-to').value ? new Date(c.querySelector('#gc-fcfactor-to').value).toISOString() : undefined,
      methodology: c.querySelector('#gc-fcfactor-method').value, sourceUrl: c.querySelector('#gc-fcfactor-url').value,
      provenance: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success('Carbon factor saved with provenance'); await this.render(this._container); }
  },

  async _finopsCarbonRecommendationDialog() {
    const now = new Date(); const candidateTime = new Date(now.getTime() + 3600000).toISOString();
    const candidates = [{ siteRef: 'site-a', startAt: candidateTime, available: true, latencyMs: 10, residencyTags: ['eu'] },
      { siteRef: 'site-b', startAt: candidateTime, available: true, latencyMs: 20, residencyTags: ['eu'] }];
    const result = await Modal.form(`<p class="text-muted text-sm">Candidates violating capacity, SLA, latency or data residency are excluded. The result never schedules or migrates a workload.</p>
      <div class="form-row"><div class="form-group"><label>Workload</label><input id="gc-fcr-workload" class="form-control mono" value="batch-workload"></div><div class="form-group"><label>Current site</label><input id="gc-fcr-site" class="form-control mono" value="site-a"></div><div class="form-group"><label>Expected energy kWh</label><input id="gc-fcr-energy" type="number" min="0" value="10" class="form-control"></div></div>
      <div class="form-group"><label>Constraints JSON</label><textarea id="gc-fcr-constraints" class="form-control mono" rows="6">${Utils.escapeHtml(JSON.stringify({ allowedSites: ['site-a','site-b'], requiredResidency: 'eu', latestStartAt: new Date(now.getTime() + 4 * 3600000).toISOString(), maxLatencyMs: 50 }, null, 2))}</textarea></div>
      <div class="form-group"><label>Candidate site/time evidence JSON</label><textarea id="gc-fcr-candidates" class="form-control mono" rows="12">${Utils.escapeHtml(JSON.stringify(candidates, null, 2))}</textarea></div>`,
    { title: 'Carbon-aware scheduling recommendation', width: '950px', onSubmit: c => this._submit(() => Api.recommendFinOpsCarbonSchedule({
      workloadRef: c.querySelector('#gc-fcr-workload').value, energyKwh: Number(c.querySelector('#gc-fcr-energy').value),
      currentSiteRef: c.querySelector('#gc-fcr-site').value, currentStartAt: now.toISOString(),
      constraints: JSON.parse(c.querySelector('#gc-fcr-constraints').value), candidates: JSON.parse(c.querySelector('#gc-fcr-candidates').value),
    })) });
    if (result) { Toast.success(`Carbon recommendation: ${result.recommendation.state}; no scheduling started`); await this.render(this._container); }
  },

  async _finopsTcoDialog() {
    const options = [{ name: 'on-prem', capex: 50000, migrationOneTime: 5000, residualValue: 5000,
      monthlyCosts: { hardware: 500, software: 500, facility: 300, energy: 400, support: 300 }, riskContingencyPercent: 10 },
    { name: 'cloud', capex: 0, migrationOneTime: 8000, monthlyCosts: { provider: 3500, network: 400, support: 200 },
      discountRateAnnual: 0.05, annualEscalationPercent: 3 }];
    const result = await Modal.form(`<p class="text-muted text-sm">The comparator includes CAPEX, recurring hardware/provider/licensing/energy costs, migration, residual value, discount and risk. It cannot create billing or purchase transactions.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-ftco-name" class="form-control" value="onprem-vs-cloud-${Date.now()}"></div><div class="form-group"><label>Horizon months</label><input id="gc-ftco-horizon" type="number" min="1" max="120" value="36" class="form-control"></div><div class="form-group"><label>Currency</label><input id="gc-ftco-currency" class="form-control mono" value="EUR"></div></div>
      <div class="form-group"><label>Options and assumptions JSON</label><textarea id="gc-ftco-options" class="form-control mono" rows="18">${Utils.escapeHtml(JSON.stringify(options, null, 2))}</textarea></div>`,
    { title: 'TCO scenario comparator', width: '950px', onSubmit: c => this._submit(() => Api.compareFinOpsTco({
      name: c.querySelector('#gc-ftco-name').value, horizonMonths: Number(c.querySelector('#gc-ftco-horizon').value),
      currency: c.querySelector('#gc-ftco-currency').value, options: JSON.parse(c.querySelector('#gc-ftco-options').value),
    })) });
    if (result) { Toast.success(`Lowest modeled TCO: ${result.scenario.selectedOption}; no purchase or billing started`); await this.render(this._container); }
  },

  async _assuranceRenewalDialog() {
    const certificates = (this._data.lifecycleMaintenance?.certificates || []).filter(item => item.certificateId);
    if (!certificates.length) return Toast.warning('Link a tracked certificate to ownership before planning renewal');
    const result = await Modal.form(`<p class="text-muted text-sm">A missing adapter is saved as unsupported. A ready plan still needs hash approval and a separate certificate.renew approval before execution.</p>
      <div class="form-group"><label>Certificate ownership</label><select id="gc-ar-owner" class="form-control">${certificates.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.inventoryKey)} · ${Utils.escapeHtml(item.owner)}</option>`).join('')}</select></div>
      <div class="form-row"><div class="form-group"><label>Adapter key</label><input id="gc-ar-adapter" class="form-control mono" value="acme"></div><div class="form-group"><label>Approved maintenance plan ID (optional)</label><input id="gc-ar-plan" type="number" min="1" class="form-control"></div></div>
      <label><input id="gc-ar-rollback" type="checkbox" checked> Roll back automatically if post-renewal verification fails</label>`,
    { title: 'Certificate renewal plan', onSubmit: c => this._submit(() => Api.planCertificateRenewal({
      ownershipId: Number(c.querySelector('#gc-ar-owner').value), adapterKey: c.querySelector('#gc-ar-adapter').value,
      maintenancePlanId: Number(c.querySelector('#gc-ar-plan').value) || undefined,
      rollbackOnFailure: c.querySelector('#gc-ar-rollback').checked,
    })) });
    if (result) { Toast.success(`Renewal plan is ${result.job.state}; apply not started`); await this.render(this._container); }
  },

  async _approveAssuranceRenewal(id) {
    const job = (this._data.lifecycleAssurance?.renewals || []).find(item => item.id === Number(id));
    const body = await Modal.form(`<p>Review immutable plan hash <span class="mono">${job.planHash}</span>.</p><div class="form-group"><label>Type APPROVE RENEWAL ${job.id}</label><input id="gc-ar-confirm" class="form-control mono" autocomplete="off"></div>`,
      { title: 'Approve certificate renewal', confirmText: 'Approve', onSubmit: c => ({ planHash: job.planHash, confirmation: c.querySelector('#gc-ar-confirm').value }) });
    if (!body) return; try { await Api.approveCertificateRenewal(job.id, body); Toast.success('Renewal approved; execution remains separate'); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _executeAssuranceRenewal(id) {
    const job = (this._data.lifecycleAssurance?.renewals || []).find(item => item.id === Number(id));
    const result = await Modal.form(`<p class="text-danger text-sm">This calls the registered renewal adapter. Verification runs immediately and the approved rollback policy is enforced on failure.</p>
      <div class="form-row"><div class="form-group"><label>certificate.renew approval ID</label><input id="gc-ar-approval" type="number" min="1" class="form-control"></div><div class="form-group"><label>Durable operation ID</label><input id="gc-ar-operation" class="form-control mono" placeholder="op_..."></div></div>
      <div class="form-group"><label>Type EXECUTE RENEWAL ${job.id}</label><input id="gc-ar-execute" class="form-control mono" autocomplete="off"></div>
      <div class="form-group"><label>Secret-free adapter request JSON</label><textarea id="gc-ar-request" class="form-control mono" rows="6">{}</textarea></div>`,
    { title: 'Execute approved renewal', danger: true, onSubmit: c => this._submit(() => Api.executeCertificateRenewal(job.id, {
      approvalId: Number(c.querySelector('#gc-ar-approval').value), operationId: c.querySelector('#gc-ar-operation').value,
      confirmation: c.querySelector('#gc-ar-execute').value, request: JSON.parse(c.querySelector('#gc-ar-request').value),
    })) });
    if (result) { Toast.success(`Renewal finished in state ${result.job.state}`); await this.render(this._container); }
  },

  async _assuranceLicenseDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">Store an opaque contract/reference, never a license key.</p>
      <div class="form-row"><div class="form-group"><label>Vendor</label><input id="gc-al-vendor" class="form-control" value="Vendor"></div><div class="form-group"><label>Product</label><input id="gc-al-product" class="form-control" value="Platform"></div><div class="form-group"><label>Edition</label><input id="gc-al-edition" class="form-control" value="Enterprise"></div></div>
      <div class="form-row"><div class="form-group"><label>Entitlement reference</label><input id="gc-al-reference" class="form-control mono" value="contract-${Date.now()}"></div><div class="form-group"><label>Metric</label><select id="gc-al-metric" class="form-control"><option>host</option><option>socket</option><option>core</option><option>vm</option><option>capacity</option><option>subscription</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Capacity</label><input id="gc-al-capacity" type="number" min="0" value="1" class="form-control"></div><div class="form-group"><label>Unit</label><input id="gc-al-unit" class="form-control" value="hosts"></div><div class="form-group"><label>Expiry (optional)</label><input id="gc-al-expiry" type="date" class="form-control"></div></div>
      <div class="form-group"><label>Official HTTPS source</label><input id="gc-al-source" class="form-control mono" value="https://vendor.example/entitlement"></div>`,
    { title: 'License entitlement inventory', width: '900px', onSubmit: c => this._submit(() => Api.saveLicenseEntitlement({
      vendor: c.querySelector('#gc-al-vendor').value, product: c.querySelector('#gc-al-product').value,
      edition: c.querySelector('#gc-al-edition').value, entitlementReference: c.querySelector('#gc-al-reference').value,
      metric: c.querySelector('#gc-al-metric').value, capacity: Number(c.querySelector('#gc-al-capacity').value),
      unit: c.querySelector('#gc-al-unit').value, expiresAt: c.querySelector('#gc-al-expiry').value || undefined,
      sourceUrl: c.querySelector('#gc-al-source').value, metadata: { enteredVia: 'governance-ui' },
    })) });
    if (result) { Toast.success('License entitlement saved without a license key'); await this.render(this._container); }
  },

  async _assuranceLicenseUsageDialog(id) {
    const item = (this._data.lifecycleAssurance?.entitlements || []).find(row => row.id === Number(id));
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Resource type</label><input id="gc-alu-type" class="form-control" value="cluster"></div><div class="form-group"><label>Resource reference</label><input id="gc-alu-ref" class="form-control mono" value="cluster-a"></div><div class="form-group"><label>Owner</label><input id="gc-alu-owner" class="form-control" value="platform"></div></div>
      <div class="form-row"><div class="form-group"><label>Assigned ${Utils.escapeHtml(item.unit)}</label><input id="gc-alu-assigned" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Observed usage</label><input id="gc-alu-used" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Environment</label><select id="gc-alu-env" class="form-control"><option>production</option><option>nonproduction</option></select></div></div>`,
    { title: `Assignment and usage · ${item.product}`, onSubmit: c => this._submit(async () => {
      const assignedCapacity = Number(c.querySelector('#gc-alu-assigned').value);
      await Api.assignLicenseEntitlement(item.id, { resourceType: c.querySelector('#gc-alu-type').value,
        resourceRef: c.querySelector('#gc-alu-ref').value, owner: c.querySelector('#gc-alu-owner').value,
        environment: c.querySelector('#gc-alu-env').value, assignedCapacity });
      return Api.recordLicenseUsage(item.id, { assignedCapacity, usedCapacity: Number(c.querySelector('#gc-alu-used').value),
        observedAt: new Date().toISOString(), evidence: { enteredVia: 'governance-ui' } });
    }) });
    if (result) { Toast.success('License assignment and usage evidence saved'); await this.render(this._container); }
  },

  async _assuranceLicensePolicyDialog() {
    const entitlements = this._data.lifecycleAssurance?.entitlements || [];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-alp-name" class="form-control" value="license-alerts-${Date.now()}"></div><div class="form-group"><label>Entitlement</label><select id="gc-alp-id" class="form-control"><option value="">All entitlements</option>${entitlements.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.vendor)} ${Utils.escapeHtml(item.product)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-group"><label>Over threshold %</label><input id="gc-alp-over" type="number" min="1" value="100" class="form-control"></div><div class="form-group"><label>Under threshold %</label><input id="gc-alp-under" type="number" min="0" max="100" value="20" class="form-control"></div><div class="form-group"><label>Expiry days</label><input id="gc-alp-expiry" type="number" min="0" value="60" class="form-control"></div><div class="form-group"><label>Forecast days</label><input id="gc-alp-forecast" type="number" min="1" value="30" class="form-control"></div></div>`,
    { title: 'License usage alert policy', onSubmit: c => this._submit(() => Api.createLicenseAlertPolicy({
      name: c.querySelector('#gc-alp-name').value, entitlementId: Number(c.querySelector('#gc-alp-id').value) || undefined,
      overPercent: Number(c.querySelector('#gc-alp-over').value), underPercent: Number(c.querySelector('#gc-alp-under').value),
      expiryDays: Number(c.querySelector('#gc-alp-expiry').value), forecastDays: Number(c.querySelector('#gc-alp-forecast').value),
    })) });
    if (result) { Toast.success('License alert policy saved'); await this.render(this._container); }
  },

  async _evaluateLicenseAlerts() {
    try { const result = await Api.evaluateLicenseAlerts(); Toast.success(`${result.created} alerts created; ${result.licenseChangesApplied} license changes`); await this.render(this._container); } catch (error) { Toast.error(error.message); }
  },

  async _assuranceSnapshotDialog() {
    const sample = { service: { enabled: true, endpoint: 'https://service.example.com', apiToken: 'will-be-redacted' }, network: { mtu: 1500 } };
    const result = await Modal.form(`<p class="text-muted text-sm">Secret-shaped fields are replaced with [REDACTED] before hashing or persistence.</p>
      <div class="form-row"><div class="form-group"><label>Provider host ID</label><input id="gc-acs-host" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Scope reference</label><input id="gc-acs-scope" class="form-control mono" value="host.node-a"></div><div class="form-group"><label>Source</label><select id="gc-acs-source" class="form-control"><option>actual</option><option>desired</option><option>imported</option></select></div></div>
      <div class="form-group"><label>Configuration JSON</label><textarea id="gc-acs-document" class="form-control mono" rows="15">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea></div>`,
    { title: 'Secret-redacted host configuration snapshot', width: '900px', onSubmit: c => this._submit(() => Api.createConfigurationSnapshot({
      providerHostId: Number(c.querySelector('#gc-acs-host').value), scopeRef: c.querySelector('#gc-acs-scope').value,
      sourceKind: c.querySelector('#gc-acs-source').value, configuration: JSON.parse(c.querySelector('#gc-acs-document').value),
      observedAt: new Date().toISOString(),
    })) });
    if (result) { Toast.success(`${result.snapshot.redactedPaths.length} sensitive paths redacted`); await this.render(this._container); }
  },

  async _assuranceDiffDialog() {
    const snapshots = this._data.lifecycleAssurance?.snapshots || []; if (snapshots.length < 2) return Toast.warning('Record at least two matching-scope snapshots');
    const options = snapshots.map(item => `<option value="${item.id}">#${item.id} · ${Utils.escapeHtml(item.scopeRef)} · ${item.sourceKind}</option>`).join('');
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>From snapshot</label><select id="gc-acd-from" class="form-control">${options}</select></div><div class="form-group"><label>To snapshot</label><select id="gc-acd-to" class="form-control">${options}</select></div></div>`,
      { title: 'Human-readable configuration diff', onSubmit: c => this._submit(() => Api.createConfigurationDiff({ fromSnapshotId: Number(c.querySelector('#gc-acd-from').value), toSnapshotId: Number(c.querySelector('#gc-acd-to').value) })) });
    if (result) { Toast.success(`${result.diff.changes.length} configuration changes; remediation not started`); await this.render(this._container); }
  },

  async _assuranceDriftDialog() {
    const diffs = this._data.lifecycleAssurance?.diffs || []; const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-adp-name" class="form-control" value="host-drift-${Date.now()}"></div><div class="form-group"><label>Host ID</label><input id="gc-adp-host" type="number" min="0" value="0" class="form-control"></div><div class="form-group"><label>Scope pattern</label><input id="gc-adp-scope" class="form-control mono" value="host.*"></div></div>
      <div class="form-row"><div class="form-group"><label>Owner</label><input id="gc-adp-owner" class="form-control" value="platform"></div><div class="form-group"><label>Evaluate diff (optional)</label><select id="gc-adp-diff" class="form-control"><option value="">Save only</option>${diffs.map(item => `<option value="${item.id}">diff #${item.id} · ${item.changes.length} changes</option>`).join('')}</select></div></div>
      <div class="form-group"><label>Rules JSON</label><textarea id="gc-adp-rules" class="form-control mono" rows="8">{"allowed":["owner.*"],"denied":["network.*"],"ignored":["telemetry.*"]}</textarea></div>`,
    { title: 'Configuration drift policy', onSubmit: c => this._submit(async () => { const saved = await Api.createDriftPolicy({
      name: c.querySelector('#gc-adp-name').value, providerHostId: Number(c.querySelector('#gc-adp-host').value),
      scopePattern: c.querySelector('#gc-adp-scope').value, owner: c.querySelector('#gc-adp-owner').value,
      rules: JSON.parse(c.querySelector('#gc-adp-rules').value),
    }); const diffId = Number(c.querySelector('#gc-adp-diff').value); return diffId ? Api.evaluateDriftPolicy(saved.policy.id, diffId) : saved; }) });
    if (result) { Toast.success(result.assessment ? `Drift state: ${result.assessment.state}; remediation not started` : 'Drift policy saved'); await this.render(this._container); }
  },

  async _assuranceProfileDialog() {
    const snapshots = this._data.lifecycleAssurance?.snapshots || [];
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-ahp-name" class="form-control" value="production-host"></div><div class="form-group"><label>Version</label><input id="gc-ahp-version" class="form-control mono" value="1.0"></div><div class="form-group"><label>Scope pattern</label><input id="gc-ahp-scope" class="form-control mono" value="host.*"></div></div>
      <div class="form-row"><div class="form-group"><label>Severity</label><select id="gc-ahp-severity" class="form-control"><option>info</option><option selected>warning</option><option>critical</option></select></div><div class="form-group"><label>Assess snapshot (optional)</label><select id="gc-ahp-snapshot" class="form-control"><option value="">Save only</option>${snapshots.map(item => `<option value="${item.id}">#${item.id} · ${Utils.escapeHtml(item.scopeRef)}</option>`).join('')}</select></div></div>
      <div class="form-group"><label>Expected path/value baseline JSON</label><textarea id="gc-ahp-baseline" class="form-control mono" rows="10">{"service.enabled":true,"network.mtu":1500}</textarea></div>`,
    { title: 'Host profile compliance', onSubmit: c => this._submit(async () => { const saved = await Api.createHostProfile({
      name: c.querySelector('#gc-ahp-name').value, version: c.querySelector('#gc-ahp-version').value,
      scopePattern: c.querySelector('#gc-ahp-scope').value, severity: c.querySelector('#gc-ahp-severity').value,
      baseline: JSON.parse(c.querySelector('#gc-ahp-baseline').value),
    }); const snapshotId = Number(c.querySelector('#gc-ahp-snapshot').value); return snapshotId ? Api.assessHostProfile(saved.profile.id, snapshotId) : saved; }) });
    if (result) { Toast.success(result.assessment ? `Profile state: ${result.assessment.state}; remediation not started` : 'Host profile saved'); await this.render(this._container); }
  },

  async _assuranceMirrorDialog() {
    const result = await Modal.form(`<p class="text-muted text-sm">The root is an adapter-owned reference. Only artifacts signed by listed trust identities can enter the inventory.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-aam-name" class="form-control" value="site-mirror-${Date.now()}"></div><div class="form-group"><label>Site reference</label><input id="gc-aam-site" class="form-control mono" value="site-a"></div><div class="form-group"><label>Adapter</label><input id="gc-aam-adapter" class="form-control mono" value="filesystem"></div></div>
      <div class="form-row"><div class="form-group"><label>Root reference</label><input id="gc-aam-root" class="form-control mono" value="/mirror/site-a"></div><div class="form-group"><label>Maximum bytes</label><input id="gc-aam-bytes" type="number" min="1" value="10737418240" class="form-control"></div></div>
      <div class="form-group"><label>Trusted signature identities</label><input id="gc-aam-trust" class="form-control mono" value="vendor-signing"></div>`,
    { title: 'Air-gap content mirror', onSubmit: c => this._submit(() => Api.createAirgapMirror({
      name: c.querySelector('#gc-aam-name').value, siteRef: c.querySelector('#gc-aam-site').value,
      adapterKey: c.querySelector('#gc-aam-adapter').value, rootReference: c.querySelector('#gc-aam-root').value,
      maxBytes: Number(c.querySelector('#gc-aam-bytes').value),
      trustRoots: c.querySelector('#gc-aam-trust').value.split(',').map(value => value.trim()).filter(Boolean),
    })) });
    if (result) { Toast.success('Air-gap mirror definition saved'); await this.render(this._container); }
  },

  async _syncAssuranceMirror(id) {
    const sample = [{ kind: 'package', name: 'hypervisor', version: '1.0', digest: '0'.repeat(64),
      signatureIdentity: 'vendor-signing', sourceUrl: 'https://vendor.example/package' }];
    const result = await Modal.form(`<p class="text-muted text-sm">The adapter must return the exact requested digest plus a trusted verified signature. No direct URL fallback exists.</p><div class="form-group"><label>Artifact manifest JSON</label><textarea id="gc-aam-artifacts" class="form-control mono" rows="15">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea></div>`,
      { title: 'Sync signed air-gap content', onSubmit: c => this._submit(() => Api.syncAirgapMirror(id, { artifacts: JSON.parse(c.querySelector('#gc-aam-artifacts').value) })) });
    if (result) { Toast.success(`Mirror run ${result.state}: ${result.artifactsAdded} signed artifacts, ${result.unsignedArtifactsAccepted || 0} unsigned`); await this.render(this._container); }
  },

  async _assuranceBundleDialog() {
    const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16);
    const result = await Modal.form(`<p class="text-muted text-sm">Collectors are allowlisted adapters. Returned evidence is bounded, secret-redacted, checksummed and automatically expires.</p>
      <div class="form-row"><div class="form-group"><label>Name</label><input id="gc-asb-name" class="form-control" value="support-${Date.now()}"></div><div class="form-group"><label>Collector adapter</label><input id="gc-asb-adapter" class="form-control mono" value="native"></div><div class="form-group"><label>Expires</label><input id="gc-asb-expiry" type="datetime-local" class="form-control" value="${expires}"></div></div>
      <div class="form-group"><label>Target references</label><input id="gc-asb-targets" class="form-control mono" value="node-a,node-b"></div><div class="form-group"><label>Sections</label><input id="gc-asb-sections" class="form-control mono" value="logs,configuration,metrics,tasks,events"></div>`,
    { title: 'Multi-node support bundle', onSubmit: c => this._submit(() => Api.collectLifecycleSupportBundle({
      name: c.querySelector('#gc-asb-name').value, adapterKey: c.querySelector('#gc-asb-adapter').value,
      expiresAt: new Date(c.querySelector('#gc-asb-expiry').value).toISOString(), maxNodeBytes: 10485760,
      targetRefs: c.querySelector('#gc-asb-targets').value.split(',').map(value => value.trim()).filter(Boolean),
      sections: c.querySelector('#gc-asb-sections').value.split(',').map(value => value.trim()).filter(Boolean),
    })) });
    if (result) { Toast.success(`Support bundle ${result.bundle.state}; secrets returned: ${result.bundle.secretsReturned || false}`); await this.render(this._container); }
  },

  async _assuranceValidationDialog() {
    const checks = ['api','ha','migration','storage','network','vm'].map(category => ({ key: `${category}-smoke`, category, adapterKey: 'native', required: true, config: {} }));
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Name</label><input id="gc-apv-name" class="form-control" value="post-upgrade"></div><div class="form-group"><label>Version</label><input id="gc-apv-version" class="form-control mono" value="1.0"></div></div>
      <div class="form-group"><label>Validation checks JSON</label><textarea id="gc-apv-checks" class="form-control mono" rows="18">${Utils.escapeHtml(JSON.stringify(checks, null, 2))}</textarea></div>`,
    { title: 'Post-upgrade validation pack', width: '900px', onSubmit: c => this._submit(() => Api.createPostUpgradeValidationPack({
      name: c.querySelector('#gc-apv-name').value, version: c.querySelector('#gc-apv-version').value,
      checks: JSON.parse(c.querySelector('#gc-apv-checks').value),
    })) });
    if (result) { Toast.success('Validation pack saved; no checks started'); await this.render(this._container); }
  },

  async _runAssuranceValidation(id) {
    const result = await Modal.form(`<div class="form-row"><div class="form-group"><label>Target reference</label><input id="gc-apv-target" class="form-control mono" value="cluster-a"></div><div class="form-group"><label>Completed lifecycle campaign ID (optional)</label><input id="gc-apv-campaign" type="number" min="1" class="form-control"></div></div>
      <div class="form-group"><label>Secret-free validation context JSON</label><textarea id="gc-apv-context" class="form-control mono" rows="8">{}</textarea></div>`,
    { title: 'Run post-upgrade validation', onSubmit: c => this._submit(() => Api.runPostUpgradeValidationPack(id, {
      targetRef: c.querySelector('#gc-apv-target').value, campaignId: Number(c.querySelector('#gc-apv-campaign').value) || undefined,
      context: JSON.parse(c.querySelector('#gc-apv-context').value),
    })) });
    if (result) { Toast.success(`Validation ${result.run.state}; ${result.run.providerMutationsStarted} provider mutations`); await this.render(this._container); }
  },
};
