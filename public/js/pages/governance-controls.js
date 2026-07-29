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
        advancedObservability, sloReports, infrastructureAutomation, lifecycleUpdates] = await Promise.all([
        Api.getGovernanceControlsCatalog(), Api.listGovernanceProjects(), Api.listApprovalRequests(),
        Api.listApprovalPolicies(), Api.listBlackouts(), Api.listIdentityRealms(), Api.listServiceTokens(), Api.listWorkloadTrusts(),
        Api.getGovernanceCatalog(), Api.getGovernanceSubjects(), Api.getGovernanceLifecycleCatalog(), Api.listResourceLeases(),
        Api.getSeparationOfDutiesReport(), Api.listAccessReviewCampaigns(), Api.getVmMetricFreshness(),
        Api.getVmObservabilityCatalog(), Api.getVmPerformanceDashboard('contention'), Api.getVmPerformanceDashboard('storage'),
        Api.getVmPerformanceDashboard('network'), Api.listVmObservabilityEvents({ limit: 100 }), Api.getVmSignalRules(),
        Api.getVmObservabilityTopology(),
        Api.getVmObservabilityAdvanced(), Api.getVmSloReports(), Api.getInfrastructureAutomation(), Api.getLifecycleUpdates(),
      ]);
      this._data = { catalog, projects: projects.projects || [], approvals: approvals.requests || [],
        policies: policies.policies || [], blackouts: blackouts.windows || [], realms: realms.realms || [],
        tokens: tokens.tokens || [], trusts: trusts.trusts || [], governanceCatalog, subjects,
        lifecycleCatalog, leases: leases.leases || [], sod: sod.findings || [], reviews: reviews.campaigns || [], freshness,
        observabilityCatalog, contention, storagePerformance, networkPerformance, observedEvents: observedEvents.events || [],
        signalState, topology, advancedObservability, sloReports: sloReports.reports || [], infrastructureAutomation, lifecycleUpdates };
      this._paint();
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><i class="fas fa-shield-halved"></i><h3>Identity &amp; Policy Governance</h3><p>${Utils.escapeHtml(error.message)}</p></div>`;
    }
  },

  _paint() {
    const pending = this._data.approvals.filter(item => item.state === 'pending').length;
    this._container.innerHTML = `<div class="page-header"><div><h1 class="page-title"><i class="fas fa-shield-halved" style="color:var(--accent);margin-right:10px"></i>Identity &amp; Policy Governance</h1>
      <p class="page-subtitle">Capacity limits, federated identities, short-lived credentials, approvals and change freezes.</p></div>
      <button class="btn btn-secondary" id="gc-refresh"><i class="fas fa-rotate"></i> Refresh</button></div>
      <div class="info-grid">
        ${this._stat('fa-gauge-high', 'Extended metrics', this._data.catalog.capacityMetrics.length)}
        ${this._stat('fa-hourglass-half', 'Pending approvals', pending)}
        ${this._stat('fa-right-to-bracket', 'Identity realms', this._data.realms.length)}
        ${this._stat('fa-clock', 'Cleanup pending', this._data.leases.filter(item => item.state === 'cleanup_pending').length)}
      </div>
      <div class="tabs" role="tablist">
        ${this._tabButton('capacity', 'fa-gauge-high', 'Capacity')}
        ${this._tabButton('approvals', 'fa-user-check', 'Approvals')}
        ${this._tabButton('identity', 'fa-id-card', 'Identity & tokens')}
        ${this._tabButton('blackouts', 'fa-ban', 'Blackouts')}
        ${this._tabButton('lifecycle', 'fa-arrows-rotate', 'Lifecycle')}
        ${this._tabButton('metrics', 'fa-chart-line', 'VM metrics')}
        ${this._tabButton('observability', 'fa-wave-square', 'Observability')}
        ${this._tabButton('automation', 'fa-code-branch', 'Automation & IaC')}
        ${this._tabButton('updates', 'fa-arrow-up-from-bracket', 'Lifecycle & updates')}
      </div><div id="gc-content">${this._content()}</div>`;
    this._bind();
  },
  _stat(icon, label, value) { return `<div class="info-item"><div class="info-label"><i class="fas ${icon}" style="margin-right:5px"></i>${label}</div><div class="info-value">${value}</div></div>`; },
  _tabButton(tab, icon, label) { return `<button class="tab-btn ${this._tab === tab ? 'active' : ''}" data-gc-tab="${tab}"><i class="fas ${icon}"></i> ${label}</button>`; },
  _content() {
    if (this._tab === 'approvals') return this._approvals();
    if (this._tab === 'identity') return this._identity();
    if (this._tab === 'blackouts') return this._blackouts();
    if (this._tab === 'lifecycle') return this._lifecycle();
    if (this._tab === 'metrics') return this._metrics();
    if (this._tab === 'observability') return this._observability();
    if (this._tab === 'automation') return this._automation();
    if (this._tab === 'updates') return this._updates();
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

  _updates() {
    const data = this._data.lifecycleUpdates || { capabilities: {}, inventory: [], supportRegistry: [], upgradePaths: [], catalog: [], prechecks: [], summary: {} };
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
};
