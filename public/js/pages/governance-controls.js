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
        governanceCatalog, subjects, lifecycleCatalog, leases, sod, reviews, freshness] = await Promise.all([
        Api.getGovernanceControlsCatalog(), Api.listGovernanceProjects(), Api.listApprovalRequests(),
        Api.listApprovalPolicies(), Api.listBlackouts(), Api.listIdentityRealms(), Api.listServiceTokens(), Api.listWorkloadTrusts(),
        Api.getGovernanceCatalog(), Api.getGovernanceSubjects(), Api.getGovernanceLifecycleCatalog(), Api.listResourceLeases(),
        Api.getSeparationOfDutiesReport(), Api.listAccessReviewCampaigns(), Api.getVmMetricFreshness(),
      ]);
      this._data = { catalog, projects: projects.projects || [], approvals: approvals.requests || [],
        policies: policies.policies || [], blackouts: blackouts.windows || [], realms: realms.realms || [],
        tokens: tokens.tokens || [], trusts: trusts.trusts || [], governanceCatalog, subjects,
        lifecycleCatalog, leases: leases.leases || [], sod: sod.findings || [], reviews: reviews.campaigns || [], freshness };
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
};
