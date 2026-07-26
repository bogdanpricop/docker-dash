/* Provider-neutral placement advisory and approved HA/affinity mutation workflows. */
'use strict';

const PlacementAdvisorPage = {
  _hosts: [], _hostId: null, _vms: [], _providerHosts: [], _clusters: [], _rules: [], _lastAdvisory: null, _container: null,

  _isAdmin() { return App.user?.role === 'admin' || App.user?.roles?.includes('admin'); },
  _badge(state) {
    return ({ compliant: 'badge-success', fresh: 'badge-success', high: 'badge-success',
      violated: 'badge-danger', blocked: 'badge-danger', low: 'badge-danger',
      unknown: 'badge-secondary', unsupported: 'badge-secondary', disabled: 'badge-secondary',
      stale: 'badge-warning', expired: 'badge-warning', medium: 'badge-warning', conditional: 'badge-info' })[state] || 'badge-info';
  },
  _label(value) { return String(value || 'unknown').replaceAll('_', ' '); },
  _number(value, suffix = '') { return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100) / 100}${suffix}` : '—'; },

  _affinityHtml(data) {
    const rules = data.rules || [];
    this._rules = rules;
    const rows = rules.map(rule => `<tr><td>${Utils.escapeHtml(rule.name)}</td>
      <td>${Utils.escapeHtml(this._label(rule.kind))}</td>
      <td><span class="badge ${rule.mandatory ? 'badge-danger' : 'badge-info'}">${rule.mandatory ? 'mandatory' : 'preference'}</span></td>
      <td><span class="badge ${this._badge(rule.compliance?.state)}">${Utils.escapeHtml(this._label(rule.compliance?.state))}</span><div class="text-muted text-sm">${Utils.escapeHtml(rule.compliance?.reason || '')}</div></td>
      <td>${Number(rule.virtualMachineIds?.length || 0)} VM · ${Number(rule.hostIds?.length || 0)} host</td>
      ${this._isAdmin() ? `<td><button class="btn btn-sm btn-secondary placement-rule-edit" data-rule-id="${Utils.escapeHtml(rule.id)}"><i class="fas fa-pen"></i> Edit</button>
      <button class="btn btn-sm btn-danger placement-rule-delete" data-rule-id="${Utils.escapeHtml(rule.id)}" data-rule-name="${Utils.escapeHtml(rule.name)}"><i class="fas fa-trash"></i> Delete</button></td>` : ''}</tr>`).join('');
    return `<div class="card" style="padding:14px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong>Affinity policy</strong>
      <div class="text-muted text-sm">${Utils.escapeHtml(data.provider?.type || 'provider')} · observed ${Utils.escapeHtml(Utils.timeAgo(data.observedAt))}</div></div>
      <div><span class="badge ${this._badge(data.capability?.state)}">${Utils.escapeHtml(this._label(data.capability?.state))}</span>
      <span class="badge ${this._badge(data.freshness?.state)}">${Utils.escapeHtml(this._label(data.freshness?.state))}</span></div></div></div>
      ${(data.limitations || []).length ? `<div class="alert alert-info"><ul>${data.limitations.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Rule</th><th>Kind</th><th>Strength</th><th>Compliance</th><th>Mapped scope</th>${this._isAdmin() ? '<th>Mutation</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-msg">No portable affinity rules were reported. Capacity recommendations can still be available.</div>'}`;
  },

  _recommendationHtml(data) {
    const rows = (data.candidates || []).map(item => `<tr><td>${Utils.escapeHtml(item.target?.displayName || item.target?.id)}</td>
      <td><strong>${this._number(item.score, '/100')}</strong><div class="text-muted text-sm">${this._number(item.evidenceCoveragePercent, '%')} coverage</div></td>
      <td><span class="badge ${this._badge(item.confidence)}">${Utils.escapeHtml(item.confidence)}</span></td>
      <td>${(item.readyModes || []).map(mode => `<span class="badge badge-success">${Utils.escapeHtml(mode)}</span>`).join(' ') || '—'}</td>
      <td>${item.blockers?.length ? `<ul>${item.blockers.map(blocker => `<li>${Utils.escapeHtml(blocker.reason)}</li>`).join('')}</ul>` : (item.eligible ? '<span class="badge badge-success">eligible</span>' : '<span class="badge badge-secondary">unknown</span>')}</td></tr>`).join('');
    return `<div class="card" style="padding:14px;margin:16px 0"><strong>${Utils.escapeHtml(data.vm?.displayName || 'VM')}</strong>
      <div class="text-muted text-sm">Read-only recommendation · plan <code>${Utils.escapeHtml(String(data.planHash || '').slice(0, 12))}</code></div></div>
      ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Target</th><th>Score</th><th>Confidence</th><th>Ready modes</th><th>Decision evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-msg">No alternate placement target is visible in this endpoint boundary.</div>'}`;
  },

  _planHtml(plan) {
    const rows = (plan.moves || []).map(move => `<tr><td>${Utils.escapeHtml(move.vm?.displayName || move.vm?.id)}</td>
      <td><code>${Utils.escapeHtml(String(move.sourceHostId || '').slice(0, 18))}…</code></td><td><code>${Utils.escapeHtml(String(move.targetHostId || '').slice(0, 18))}…</code></td>
      <td>${Utils.escapeHtml(move.mode || 'unknown')}</td><td>${this._number(move.score, '/100')}</td><td>${this._number(move.projectedTargetMemoryUtilizationPercent, '%')}</td></tr>`).join('');
    return `<div class="alert alert-info"><strong>Approval boundary.</strong> This advisory cannot execute until it is re-planned and approved by a different administrator. It expires ${Utils.escapeHtml(Utils.timeAgo(plan.expiresAt))}.</div>
      <div class="text-muted text-sm" style="margin-bottom:10px">Plan <code>${Utils.escapeHtml(String(plan.planHash || '').slice(0, 12))}</code> · ${Number(plan.skipped?.length || 0)} skipped workload(s)</div>
      ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>VM</th><th>Source</th><th>Target</th><th>Mode</th><th>Score</th><th>Projected target memory</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${this._isAdmin() ? '<button id="placement-request-rebalance" class="btn btn-primary" style="margin-top:12px"><i class="fas fa-user-check"></i> Request four-eyes apply</button>' : ''}`
      : '<div class="empty-msg">No safe move was proposed for the current thresholds and evidence.</div>'}`;
  },

  _changesHtml(data) {
    const rows = (data.items || []).map(change => {
      const controls = [];
      if (change.permissions?.canApprove) controls.push(`<button class="btn btn-sm btn-primary placement-change-action" data-id="${change.id}" data-action="approve">Approve</button>`);
      if (change.permissions?.canReject) controls.push(`<button class="btn btn-sm btn-secondary placement-change-action" data-id="${change.id}" data-action="reject">Reject</button>`);
      if (change.permissions?.canPause) controls.push(`<button class="btn btn-sm btn-secondary placement-change-action" data-id="${change.id}" data-action="pause">Pause</button>`);
      if (change.permissions?.canResume) controls.push(`<button class="btn btn-sm btn-primary placement-change-action" data-id="${change.id}" data-action="resume">Resume</button>`);
      if (change.permissions?.canCancel) controls.push(`<button class="btn btn-sm btn-danger placement-change-action" data-id="${change.id}" data-action="cancel">Cancel</button>`);
      if (change.permissions?.canRollback) controls.push(`<button class="btn btn-sm btn-secondary placement-change-action" data-id="${change.id}" data-action="rollback">Plan rollback</button>`);
      return `<tr><td><code>${Utils.escapeHtml(change.id.slice(0, 14))}</code><div class="text-muted text-sm">${Utils.escapeHtml(change.resource?.displayName || '')}</div></td>
        <td>${Utils.escapeHtml(this._label(change.changeKind))}</td><td>${Utils.escapeHtml(change.action)}</td>
        <td><span class="badge ${this._badge(change.state)}">${Utils.escapeHtml(this._label(change.state))}</span>
        ${change.counts?.submitted ? `<div class="text-muted text-sm">${change.counts.succeeded}/${change.items.length} moves</div>` : ''}</td>
        <td>${controls.join(' ') || '—'}</td></tr>`;
    }).join('');
    return rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Request</th><th>Kind</th><th>Action</th><th>State</th><th>Controls</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-msg">No placement change requests exist for this endpoint.</div>';
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-balance-scale"></i> Placement Advisor</h1>
      <div class="text-muted text-sm">Affinity-aware planning with four-eyes approval, durable execution, auto-pause and semantic rollback</div></div>
      <select id="placement-host" class="form-control" aria-label="Virtualization endpoint">${this._hosts.map(host => `<option value="${Number(host.id)}">${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select></div>
      <div id="placement-affinity"></div><section class="card" style="padding:14px;margin-top:18px"><h2 style="margin-top:0">VM recommendation</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><select id="placement-vm" class="form-control" aria-label="Virtual machine"></select>
      <button id="placement-recommend" class="btn btn-primary"><i class="fas fa-search"></i> Evaluate targets</button></div><div id="placement-recommendation"></div></section>
      ${this._isAdmin() ? `<section class="card" style="padding:14px;margin-top:18px"><h2 style="margin-top:0">Approved placement mutations</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button id="placement-edit-ha" class="btn btn-secondary"><i class="fas fa-heartbeat"></i> Edit VM HA policy</button>
      <button id="placement-create-rule" class="btn btn-secondary"><i class="fas fa-link"></i> Create affinity rule</button></div></section>
      <section class="card" style="padding:14px;margin-top:18px"><h2 style="margin-top:0">Cluster rebalance advisory</h2>
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><label>Source threshold %<input id="placement-source-threshold" class="form-control" type="number" min="70" max="95" value="85"></label>
      <label>Target ceiling %<input id="placement-target-threshold" class="form-control" type="number" min="50" max="94" value="75"></label>
      <button id="placement-plan" class="btn btn-secondary"><i class="fas fa-project-diagram"></i> Generate dry-run</button></div><div id="placement-plan-result"></div></section>
      <section class="card" style="padding:14px;margin-top:18px"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Change control</h2>
      <button id="placement-refresh-changes" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button></div><div id="placement-changes" style="margin-top:12px"></div></section>` : ''}`;
    container.querySelector('#placement-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); this._load(); });
    container.querySelector('#placement-recommend')?.addEventListener('click', () => this._recommend());
    container.querySelector('#placement-plan')?.addEventListener('click', () => this._plan());
    container.querySelector('#placement-edit-ha')?.addEventListener('click', () => this._editHa());
    container.querySelector('#placement-create-rule')?.addEventListener('click', () => this._createRule());
    container.querySelector('#placement-refresh-changes')?.addEventListener('click', () => this._loadChanges());
    await this._load();
  },

  async _load() {
    const affinity = this._container?.querySelector('#placement-affinity');
    const vmSelect = this._container?.querySelector('#placement-vm');
    if (!affinity || !vmSelect) return;
    if (!this._hostId) { affinity.innerHTML = '<div class="empty-msg">Add a Proxmox, vSphere or Xen endpoint to inspect placement evidence.</div>'; return; }
    affinity.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting placement policy…</div>';
    try {
      const [policy, inventory, providerHosts, clusters] = await Promise.all([
        Api.getProviderAffinity(this._hostId), Api.getProviderVMs(this._hostId, 500),
        Api.getProviderHosts(this._hostId, 64).catch(() => ({ items: [] })),
        Api.getProviderClusters(this._hostId, 64).catch(() => ({ items: [] })),
      ]);
      this._vms = inventory.items || [];
      this._providerHosts = providerHosts.items || [];
      this._clusters = clusters.items || [];
      affinity.innerHTML = this._affinityHtml(policy);
      affinity.querySelectorAll('.placement-rule-edit').forEach(button => button.addEventListener('click', () => this._editRule(button.dataset.ruleId)));
      affinity.querySelectorAll('.placement-rule-delete').forEach(button => button.addEventListener('click', () => this._deleteRule(button.dataset.ruleId, button.dataset.ruleName)));
      vmSelect.innerHTML = this._vms.map(vm => `<option value="${Utils.escapeHtml(vm.id)}">${Utils.escapeHtml(vm.displayName)}</option>`).join('');
    } catch (err) { affinity.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; vmSelect.innerHTML = ''; }
    if (this._isAdmin()) await this._loadChanges();
  },

  async _recommend() {
    const target = this._container?.querySelector('#placement-recommendation');
    const vmId = this._container?.querySelector('#placement-vm')?.value;
    if (!target || !/^ddr_vm_[a-f0-9]{26}$/.test(String(vmId || ''))) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Evaluating targets…</div>';
    try { target.innerHTML = this._recommendationHtml(await Api.getProviderPlacementRecommendations(this._hostId, vmId)); }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; }
  },

  async _plan() {
    const target = this._container?.querySelector('#placement-plan-result');
    if (!target) return;
    const body = { sourceThresholdPercent: Number(this._container.querySelector('#placement-source-threshold').value),
      targetThresholdPercent: Number(this._container.querySelector('#placement-target-threshold').value) };
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Generating bounded dry-run…</div>';
    try {
      this._lastAdvisory = await Api.planProviderRebalance(this._hostId, body);
      target.innerHTML = this._planHtml(this._lastAdvisory);
      target.querySelector('#placement-request-rebalance')?.addEventListener('click', () => this._requestRebalance());
    }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; }
  },

  async _requestChange(request, rollbackOf = null) {
    let plan;
    try { plan = await Api.preflightProviderPlacementChange(this._hostId, request); }
    catch (err) { Toast.error(err.message); return; }
    if (!plan.allowed) { Toast.error(plan.blockers?.[0]?.reason || 'Change is blocked'); return; }
    const diff = (plan.diff || []).map(item => `<li><code>${Utils.escapeHtml(item.path)}</code>: ${Utils.escapeHtml(JSON.stringify(item.before))} → ${Utils.escapeHtml(JSON.stringify(item.after))}</li>`).join('');
    const result = await Modal.form(`<div class="alert alert-warning"><strong>Four-eyes workflow.</strong> This creates a pending request; another administrator must approve it.</div>
      <div class="form-group"><label>Semantic diff</label><ul class="text-sm">${diff}</ul></div>
      ${rollbackOf ? `<div class="text-muted text-sm">Rollback of <code>${Utils.escapeHtml(rollbackOf)}</code></div>` : ''}
      <div class="form-group"><label>Type <strong>${Utils.escapeHtml(plan.confirmation.expected)}</strong> to confirm</label>
      <input id="placement-change-confirm" class="form-control" autocomplete="off"></div>`, {
      title: 'Request placement change', width: '680px', submitLabel: 'Request approval',
      onSubmit: content => {
        const confirmName = content.querySelector('#placement-change-confirm').value;
        if (confirmName !== plan.confirmation.expected) { Toast.error('Exact confirmation does not match'); return false; }
        return { confirmName };
      },
    });
    if (!result) return;
    try {
      const key = `placement-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await Api.requestProviderPlacementChange(this._hostId, { ...request, planHash: plan.planHash,
        confirm: true, confirmName: result.confirmName }, key);
      Toast.success('Approval request created'); await this._loadChanges();
    } catch (err) { Toast.error(err.message); }
  },

  async _requestRebalance() {
    if (!this._lastAdvisory) return;
    const sourceThresholdPercent = Number(this._container.querySelector('#placement-source-threshold').value);
    const targetThresholdPercent = Number(this._container.querySelector('#placement-target-threshold').value);
    await this._requestChange({ changeKind: 'rebalance_apply', advisoryPlanHash: this._lastAdvisory.planHash,
      sourceThresholdPercent, targetThresholdPercent, maxMoves: Math.max(1, this._lastAdvisory.moves.length), waveSize: 2 });
  },

  async _editHa() {
    const provider = this._hosts.find(host => Number(host.id) === Number(this._hostId))?.daemonType;
    const result = await Modal.form(`<div class="form-group"><label>Virtual machine</label><select id="placement-ha-vm" class="form-control">${this._vms.map(vm => `<option value="${Utils.escapeHtml(vm.id)}">${Utils.escapeHtml(vm.displayName)}</option>`).join('')}</select></div>
      ${provider === 'vsphere' ? `<div class="form-group"><label>Cluster</label><select id="placement-ha-cluster" class="form-control">${this._clusters.map(item => `<option value="${Utils.escapeHtml(item.id)}">${Utils.escapeHtml(item.displayName)}</option>`).join('')}</select></div>` : ''}
      <div class="form-group"><label>Restart policy</label><select id="placement-ha-policy" class="form-control"><option value="guaranteed">Guaranteed</option><option value="best_effort">Best effort</option><option value="disabled">Disabled</option></select></div>
      ${provider === 'proxmox' ? '<div style="display:flex;gap:8px"><label>Max restarts<input id="placement-ha-restarts" class="form-control" type="number" min="0" max="20" value="1"></label><label>Max relocations<input id="placement-ha-relocations" class="form-control" type="number" min="0" max="20" value="1"></label></div>' : ''}
      ${provider === 'vsphere' ? '<div class="form-group"><label>Restart priority</label><select id="placement-ha-priority" class="form-control"><option>default</option><option>lowest</option><option>low</option><option>medium</option><option>high</option><option>highest</option></select></div>' : ''}
      ${provider === 'xen' ? '<div style="display:flex;gap:8px"><label>Start order<input id="placement-ha-order" class="form-control" type="number" min="0" value="0"></label><label>Start delay seconds<input id="placement-ha-delay" class="form-control" type="number" min="0" value="0"></label></div>' : ''}`, {
      title: 'Edit VM HA policy', submitLabel: 'Review diff', onSubmit: content => ({
        vmId: content.querySelector('#placement-ha-vm').value,
        clusterId: content.querySelector('#placement-ha-cluster')?.value || null,
        restartPolicy: content.querySelector('#placement-ha-policy').value,
        restartPriority: content.querySelector('#placement-ha-priority')?.value,
        maxRestarts: content.querySelector('#placement-ha-restarts')?.value,
        maxRelocations: content.querySelector('#placement-ha-relocations')?.value,
        startOrder: content.querySelector('#placement-ha-order')?.value,
        startDelaySeconds: content.querySelector('#placement-ha-delay')?.value,
      }),
    });
    if (!result) return;
    const policy = Object.fromEntries(Object.entries(result).filter(([key, value]) => !['vmId', 'clusterId'].includes(key) && value !== undefined));
    await this._requestChange({ changeKind: 'ha_policy', vmId: result.vmId,
      ...(result.clusterId ? { clusterId: result.clusterId } : {}), policy });
  },

  async _createRule() {
    const provider = this._hosts.find(host => Number(host.id) === Number(this._hostId))?.daemonType;
    const result = await Modal.form(`<div class="form-group"><label>Rule name</label><input id="placement-rule-name" class="form-control" maxlength="80"></div>
      <div class="form-group"><label>Kind</label><select id="placement-rule-kind" class="form-control">${provider === 'xen' ? '<option value="vm_vm_anti_affinity">VM anti-affinity</option>' : '<option value="vm_vm_anti_affinity">VM anti-affinity</option><option value="vm_vm_affinity">VM affinity</option>'}</select></div>
      <div class="form-group"><label>VM members (select at least two)</label><select id="placement-rule-vms" class="form-control" multiple size="8">${this._vms.map(vm => `<option value="${Utils.escapeHtml(vm.id)}">${Utils.escapeHtml(vm.displayName)}</option>`).join('')}</select></div>
      ${provider === 'vsphere' ? `<div class="form-group"><label>Cluster</label><select id="placement-rule-cluster" class="form-control">${this._clusters.map(item => `<option value="${Utils.escapeHtml(item.id)}">${Utils.escapeHtml(item.displayName)}</option>`).join('')}</select></div>` : ''}`, {
      title: 'Create affinity rule', submitLabel: 'Review diff', onSubmit: content => ({
        name: content.querySelector('#placement-rule-name').value.trim(), kind: content.querySelector('#placement-rule-kind').value,
        vmIds: [...content.querySelector('#placement-rule-vms').selectedOptions].map(item => item.value),
        clusterId: content.querySelector('#placement-rule-cluster')?.value || null,
      }),
    });
    if (!result) return;
    await this._requestChange({ changeKind: 'affinity_rule', action: 'create', rule: { ...result, hostIds: [], enabled: true, mandatory: false } });
  },

  async _editRule(ruleId) {
    const current = this._rules.find(rule => rule.id === ruleId);
    if (!current) return;
    const provider = this._hosts.find(host => Number(host.id) === Number(this._hostId))?.daemonType;
    const vmIds = new Set(current.virtualMachineIds || []);
    const result = await Modal.form(`<div class="form-group"><label>Rule name</label><input id="placement-rule-name" class="form-control" maxlength="80" value="${Utils.escapeHtml(current.name)}" ${provider === 'xen' ? 'readonly' : ''}></div>
      <div class="form-group"><label>Kind</label><input class="form-control" value="${Utils.escapeHtml(this._label(current.kind))}" disabled></div>
      <div class="form-group"><label>VM members</label><select id="placement-rule-vms" class="form-control" multiple size="8">${this._vms.map(vm => `<option value="${Utils.escapeHtml(vm.id)}" ${vmIds.has(vm.id) ? 'selected' : ''}>${Utils.escapeHtml(vm.displayName)}</option>`).join('')}</select></div>
      <label><input id="placement-rule-enabled" type="checkbox" ${current.enabled !== false ? 'checked' : ''} ${provider === 'xen' ? 'disabled' : ''}> Enabled</label>
      <label style="margin-left:12px"><input id="placement-rule-mandatory" type="checkbox" ${current.mandatory ? 'checked' : ''} ${provider === 'xen' ? 'disabled' : ''}> Mandatory</label>
      ${provider === 'xen' ? '<div class="text-muted text-sm">XAPI groups remain enabled advisory preferences; this workflow changes membership only.</div>' : ''}`, {
      title: 'Edit affinity rule', submitLabel: 'Review diff', onSubmit: content => ({
        name: content.querySelector('#placement-rule-name').value.trim(), kind: current.kind,
        vmIds: [...content.querySelector('#placement-rule-vms').selectedOptions].map(item => item.value),
        hostIds: current.hostIds || [], clusterId: current.clusterId || null,
        enabled: content.querySelector('#placement-rule-enabled').checked,
        mandatory: content.querySelector('#placement-rule-mandatory').checked,
      }),
    });
    if (result) await this._requestChange({ changeKind: 'affinity_rule', action: 'update', ruleId, rule: result });
  },

  async _deleteRule(ruleId, ruleName) {
    const ok = await Modal.confirm(`Create an approval request to delete ${ruleName}?`, { danger: true, confirmText: 'Review deletion' });
    if (ok) await this._requestChange({ changeKind: 'affinity_rule', action: 'delete', ruleId });
  },

  async _loadChanges() {
    const target = this._container?.querySelector('#placement-changes');
    if (!target || !this._hostId) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading change control…</div>';
    try {
      const data = await Api.getProviderPlacementChanges(this._hostId, 50);
      target.innerHTML = this._changesHtml(data);
      target.querySelectorAll('.placement-change-action').forEach(button => button.addEventListener('click', () => this._changeAction(button.dataset.id, button.dataset.action)));
    } catch (err) { target.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; }
  },

  async _changeAction(id, action) {
    try {
      if (action === 'approve') {
        const ok = await Modal.confirm('Approve this live provider change? The requester must be a different administrator.', { confirmText: 'Approve' });
        if (!ok) return; await Api.approveProviderPlacementChange(this._hostId, id, 'Approved from Placement Advisor');
      } else if (action === 'reject') {
        const result = await Modal.form('<div class="form-group"><label>Rejection reason</label><textarea id="placement-reject-reason" class="form-control" required></textarea></div>',
          { title: 'Reject placement change', submitLabel: 'Reject', onSubmit: content => ({ reason: content.querySelector('#placement-reject-reason').value.trim() }) });
        if (!result?.reason) return; await Api.rejectProviderPlacementChange(this._hostId, id, result.reason);
      } else if (action === 'rollback') {
        const rollback = await Api.planProviderPlacementRollback(this._hostId, id, {});
        await this._requestChange(rollback.request, id); return;
      } else {
        const ok = await Modal.confirm(`${action} this rebalance? Completed migrations are not automatically reversed.`, { danger: action === 'cancel', confirmText: action });
        if (!ok) return; await Api.controlProviderPlacementChange(this._hostId, id, action);
      }
      Toast.success(`Placement change ${action} accepted`); await this._loadChanges();
    } catch (err) { Toast.error(err.message); }
  },

  destroy() { this._container = null; this._vms = []; this._providerHosts = []; this._clusters = []; this._rules = []; this._lastAdvisory = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PlacementAdvisorPage;
