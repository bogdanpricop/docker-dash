/* Provider-neutral DR posture, deterministic runbook planning and non-mutating rehearsals. */
'use strict';

const DisasterRecoveryPage = {
  _container: null, _hosts: [], _hostId: null, _overview: null, _groups: [],
  _replications: [], _runs: [], _workloads: [], _nodes: [], _storages: [], _editing: null,

  _isAdmin() { return App.user?.role === 'admin' || App.user?.roles?.includes('admin'); },
  _escape(value) { return Utils.escapeHtml(value === null || value === undefined ? '' : String(value)); },
  _state(value) { return String(value || 'unknown').replaceAll('_', ' '); },
  _badge(value) {
    return ({ met: 'badge-success', healthy: 'badge-success', succeeded: 'badge-success',
      breached: 'badge-warning', never_tested: 'badge-warning', blocked: 'badge-danger',
      failed: 'badge-danger', unknown: 'badge-secondary', unsupported: 'badge-secondary',
      conditional: 'badge-info', supported: 'badge-success' })[value] || 'badge-secondary';
  },
  _duration(value) {
    if (!Number.isFinite(Number(value))) return 'unknown';
    const seconds = Math.max(0, Number(value));
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 36000 ? 1 : 0)}h`;
    return `${(seconds / 86400).toFixed(seconds < 864000 ? 1 : 0)}d`;
  },

  _summaryHtml() {
    const counts = this._overview?.counts || {};
    const capability = this._overview?.replication?.capability || {};
    return `<div class="stats-grid" style="margin:14px 0">
      <div class="stat-card"><div class="stat-value">${Number(this._overview?.count || 0)}</div><div class="stat-label">Protection groups</div></div>
      <div class="stat-card"><div class="stat-value">${Number(counts.met || 0)}</div><div class="stat-label">Objectives met</div></div>
      <div class="stat-card"><div class="stat-value">${Number(counts.breached || 0) + Number(counts.failed || 0)}</div><div class="stat-label">Breached / failed</div></div>
      <div class="stat-card"><div class="stat-value">${Number(counts.never_tested || 0) + Number(counts.unknown || 0)}</div><div class="stat-label">Untested / unknown</div></div>
      <div class="stat-card"><div class="stat-value">${Number(this._overview?.replication?.count || 0)}</div><div class="stat-label">Observed replications</div></div>
    </div><div class="alert alert-info"><strong>Replication evidence:</strong>
      <span class="badge ${this._badge(capability.state)}">${this._escape(this._state(capability.state))}</span>
      ${this._escape(capability.reason || 'Provider capability evidence is available.')}</div>`;
  },

  _groupsHtml() {
    if (!this._overview?.items?.length) return '<div class="empty-msg">No DR protection group is defined for this endpoint.</div>';
    return `<div id="dr-group-list" style="display:grid;gap:12px">${this._overview.items.map(item => {
      const group = item.group || {};
      return `<article class="card" style="padding:15px">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:start;flex-wrap:wrap">
          <div><h3 style="margin:0">${this._escape(group.name)}</h3><div class="text-muted text-sm">
            ${this._escape(this._state(group.strategy))} · revision ${Number(group.revision || 0)} · ${Number(group.members?.length || 0)} workloads</div></div>
          <div><span class="badge ${group.enabled ? 'badge-success' : 'badge-secondary'}">${group.enabled ? 'authorized' : 'disabled'}</span>
            <span class="badge ${this._badge(item.compliance)}">${this._escape(this._state(item.compliance))}</span></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-top:12px">
          <div><span class="text-muted text-sm">RPO target / observed</span><br>${this._duration(group.rpoTargetSeconds)} / ${this._duration(item.rpoMaxSeconds)}</div>
          <div><span class="text-muted text-sm">RTO target / measured</span><br>${this._duration(group.rtoTargetSeconds)} / ${this._duration(item.rtoMaxSeconds)}</div>
          <div><span class="text-muted text-sm">Findings</span><br>${Number(item.blockerCount || 0)} blockers · ${Number(item.warningCount || 0)} warnings</div>
          <div><span class="text-muted text-sm">Latest rehearsal</span><br>${item.lastRun ? `<span class="badge ${this._badge(item.lastRun.state)}">${this._escape(item.lastRun.state)}</span> ${this._escape(Utils.timeAgo(item.lastRun.completedAt || item.lastRun.createdAt))}` : 'never'}</div>
        </div>${this._isAdmin() ? `<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:12px">
          <button class="btn btn-sm btn-secondary" data-dr-edit="${this._escape(group.id)}"><i class="fas fa-pen"></i> Edit</button>
          <button class="btn btn-sm btn-secondary" data-dr-plan="${this._escape(group.id)}"><i class="fas fa-list-check"></i> Review real plan</button>
          <button class="btn btn-sm btn-primary" data-dr-rehearse="${this._escape(group.id)}"><i class="fas fa-vial"></i> Record rehearsal</button>
          <button class="btn btn-sm btn-danger" data-dr-delete="${this._escape(group.id)}"><i class="fas fa-trash"></i> Delete</button>
        </div>` : ''}</article>`;
    }).join('')}</div>`;
  },

  _replicationsHtml() {
    if (!this._replications.length) return '<div class="empty-msg">No provider-native replication job can be observed on this endpoint.</div>';
    const rows = this._replications.map(item => `<tr><td>${this._escape(item.workloadName)}</td>
      <td><span class="badge ${this._badge(item.health)}">${this._escape(item.health)}</span></td>
      <td>${this._escape(item.mode)} · ${this._escape(item.scope)}</td><td>${this._escape(item.schedule || 'provider default')}</td>
      <td>${this._duration(item.rpoAgeSeconds)}</td><td>${this._escape(item.lastSyncAt ? Utils.timeAgo(item.lastSyncAt) : 'unknown')}</td></tr>`).join('');
    return `<div style="overflow:auto" class="card"><table class="data-table"><thead><tr><th>Workload</th><th>Health</th><th>Mode / scope</th><th>Schedule</th><th>RPO age</th><th>Last sync</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _runsHtml() {
    if (!this._runs.length) return '<div class="empty-msg">No immutable DR rehearsal evidence has been recorded.</div>';
    const rows = this._runs.map(run => `<tr><td>${this._escape(Utils.timeAgo(run.completedAt || run.createdAt))}</td>
      <td>${this._escape(this._groups.find(group => group.id === run.groupId)?.name || run.groupId)}</td>
      <td>${this._escape(this._state(run.mode))}</td><td><span class="badge ${this._badge(run.state)}">${this._escape(run.state)}</span></td>
      <td><span class="badge ${this._badge(run.compliance)}">${this._escape(this._state(run.compliance))}</span></td>
      <td>${this._duration(run.rpoMaxSeconds)} / ${this._duration(run.rtoMaxSeconds)}</td>
      <td><code title="${this._escape(run.evidenceHash)}">${this._escape(String(run.evidenceHash || '').slice(0, 12))}</code></td></tr>`).join('');
    return `<div style="overflow:auto" class="card"><table class="data-table"><thead><tr><th>Recorded</th><th>Group</th><th>Mode</th><th>State</th><th>Compliance</th><th>RPO / RTO</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _editorHtml() {
    if (!this._isAdmin()) return '<div class="alert alert-info">Viewers can inspect DR evidence. Protection-group authoring and rehearsals require administrator access.</div>';
    const group = this._groups.find(item => item.id === this._editing) || {};
    const memberMap = new Map((group.members || []).map(item => [item.vmId, item]));
    const option = (item, selected) => `<option value="${this._escape(item.id)}" ${item.id === selected ? 'selected' : ''}>${this._escape(item.displayName)}</option>`;
    const workloadRows = this._workloads.map((vm, index) => {
      const member = memberMap.get(vm.id); const dependencies = (member?.dependsOn || []).join(',');
      return `<tr data-dr-vm="${this._escape(vm.id)}"><td><input type="checkbox" class="dr-vm-selected" ${member ? 'checked' : ''}></td>
        <td><strong>${this._escape(vm.displayName)}</strong><div class="text-muted text-sm">${this._escape(vm.status?.powerState || 'unknown')}</div></td>
        <td><input class="form-control dr-boot-stage" type="number" min="1" max="20" value="${Number(member?.bootStage || Math.min(index + 1, 20))}"></td>
        <td><input class="form-control dr-dependencies" maxlength="240" value="${this._escape(dependencies)}" placeholder="canonical VM IDs, comma separated"></td>
        <td><select class="form-control dr-source"><option value="backup" ${member?.recoverySource !== 'replication' ? 'selected' : ''}>verified backup</option><option value="replication" ${member?.recoverySource === 'replication' ? 'selected' : ''}>replication</option></select></td></tr>`;
    }).join('');
    return `<section class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:8px"><h2 style="margin-top:0">${group.id ? 'Edit' : 'New'} protection group</h2>
      <button id="dr-reset" class="btn btn-sm btn-secondary">Reset</button></div>
      <div class="alert alert-info"><strong>Authoring does not execute provider changes.</strong> Enabling requires a typed authorization; every real failover, failback and test plan remains fail-closed in this release.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px">
        <label>Name<input id="dr-name" maxlength="100" class="form-control" value="${this._escape(group.name || 'Production DR')}"></label>
        <label>Strategy<select id="dr-strategy" class="form-control"><option value="backup_restore" ${group.strategy !== 'provider_replication' && group.strategy !== 'hybrid' ? 'selected' : ''}>backup restore</option><option value="provider_replication" ${group.strategy === 'provider_replication' ? 'selected' : ''}>provider replication</option><option value="hybrid" ${group.strategy === 'hybrid' ? 'selected' : ''}>hybrid</option></select></label>
        <label>Recovery endpoint<select id="dr-recovery-host" class="form-control">${this._hosts.map(host => option({ id: Number(host.id), displayName: `${host.name} · ${host.daemonType}` }, Number(group.recoveryHostId || this._hostId))).join('')}</select></label>
        <label>RPO target (seconds)<input id="dr-rpo" type="number" min="60" max="31536000" class="form-control" value="${Number(group.rpoTargetSeconds || 86400)}"></label>
        <label>RTO target (seconds)<input id="dr-rto" type="number" min="30" max="86400" class="form-control" value="${Number(group.rtoTargetSeconds || 3600)}"></label>
        <label>Recovery node<select id="dr-node" class="form-control"><option value="">automatic</option>${this._nodes.map(item => option(item, group.placement?.nodeId)).join('')}</select></label>
        <label>Recovery storage<select id="dr-storage" class="form-control"><option value="">automatic</option>${this._storages.map(item => option(item, group.placement?.storageId)).join('')}</select></label>
        <label>Service owner<input id="dr-owner" maxlength="120" class="form-control" value="${this._escape(group.contacts?.owner || '')}"></label>
        <label>Incident channel<input id="dr-channel" maxlength="160" class="form-control" value="${this._escape(group.contacts?.incidentChannel || '')}"></label>
      </div><h3>Dependency graph</h3><p class="text-muted text-sm">Dependencies must reference selected canonical VM IDs and cannot point to a later boot stage.</p>
      <div style="overflow:auto;max-height:330px"><table class="data-table"><thead><tr><th>Use</th><th>Workload</th><th>Boot stage</th><th>Depends on</th><th>Recovery evidence</th></tr></thead><tbody>${workloadRows}</tbody></table></div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px"><label><input id="dr-enabled" type="checkbox" ${group.enabled ? 'checked' : ''}> Enable group</label>
        <button id="dr-save" class="btn btn-primary"><i class="fas fa-save"></i> Save group</button></div>
      <div id="dr-action-result" style="margin-top:12px"></div></section>`;
  },

  _payload() {
    const name = this._container.querySelector('#dr-name')?.value.trim();
    const enabled = this._container.querySelector('#dr-enabled')?.checked === true;
    const existing = this._groups.find(item => item.id === this._editing);
    const members = [...this._container.querySelectorAll('[data-dr-vm]')].filter(row => row.querySelector('.dr-vm-selected')?.checked)
      .map(row => ({ vmId: row.dataset.drVm, bootStage: Number(row.querySelector('.dr-boot-stage')?.value),
        dependsOn: String(row.querySelector('.dr-dependencies')?.value || '').split(',').map(value => value.trim()).filter(Boolean),
        recoverySource: row.querySelector('.dr-source')?.value }));
    return { ...(this._editing ? { id: this._editing } : {}), name, enabled,
      ...(enabled ? { authorization: `AUTHORIZE DR ${name}` } : {}),
      recoveryHostId: Number(this._container.querySelector('#dr-recovery-host')?.value),
      strategy: this._container.querySelector('#dr-strategy')?.value,
      rpoTargetSeconds: Number(this._container.querySelector('#dr-rpo')?.value),
      rtoTargetSeconds: Number(this._container.querySelector('#dr-rto')?.value),
      placement: Number(this._container.querySelector('#dr-recovery-host')?.value) === Number(this._hostId)
        ? { nodeId: this._container.querySelector('#dr-node')?.value || null,
          storageId: this._container.querySelector('#dr-storage')?.value || null }
        : (existing?.placement || {}),
      networkMappings: existing?.networkMappings || [], members,
      contacts: { owner: this._container.querySelector('#dr-owner')?.value,
        incidentChannel: this._container.querySelector('#dr-channel')?.value } };
  },

  _planHtml(plan) {
    const findings = [...(plan.blockers || []), ...(plan.warnings || [])];
    return `<div class="alert ${plan.allowed ? 'alert-success' : 'alert-warning'}"><strong>${plan.executionType === 'rehearsal' ? 'Rehearsal' : 'Real'} plan ${plan.allowed ? 'admissible' : 'blocked'}</strong>
      · ${Number(plan.steps?.length || 0)} deterministic steps<br><code>${this._escape(plan.planHash)}</code>
      ${findings.length ? `<ul style="margin:8px 0 0 18px">${findings.map(item => `<li><strong>${this._escape(item.code)}</strong> — ${this._escape(item.reason)}</li>`).join('')}</ul>` : ''}</div>`;
  },

  async _save() {
    try { const result = await Api.saveProviderDrProtectionGroup(this._hostId, this._payload());
      Toast.success(result.created ? 'Protection group created' : 'Protection group updated'); this._editing = null; await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _delete(groupId) {
    const group = this._groups.find(item => item.id === groupId);
    if (!group || !await Modal.confirm(`Delete protection group “${group.name}”? Historical rehearsal evidence remains.`, { danger: true, confirmText: 'Delete' })) return;
    try { await Api.deleteProviderDrProtectionGroup(this._hostId, groupId); Toast.success('Protection group deleted'); this._editing = null; await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _plan(groupId, executionType = 'real') {
    const mode = this._container.querySelector('#dr-mode')?.value || 'test';
    const incidentReason = this._container.querySelector('#dr-incident-reason')?.value.trim() || undefined;
    const target = this._container.querySelector('#dr-action-result');
    try { const plan = await Api.preflightProviderDrRunbook(this._hostId, groupId, { mode, executionType, incidentReason });
      if (target) target.innerHTML = this._planHtml(plan); return plan; }
    catch (err) { Toast.error(err.message); return null; }
  },
  async _rehearse(groupId) {
    const plan = await this._plan(groupId, 'rehearsal'); if (!plan) return;
    const expected = `REHEARSE ${plan.group.name}`;
    const confirmationText = window.prompt(`This records evidence only; no provider mutation will run. Type ${expected}`) || '';
    if (confirmationText !== expected) { Toast.error('Rehearsal confirmation did not match'); return; }
    try { const result = await Api.rehearseProviderDrRunbook(this._hostId, groupId, {
      mode: plan.mode, planHash: plan.planHash, confirm: true, confirmationText,
    }); Toast.success(`Rehearsal recorded: ${result.run.state}`); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  _wire() {
    this._container.querySelector('#dr-save')?.addEventListener('click', () => this._save());
    this._container.querySelector('#dr-reset')?.addEventListener('click', () => { this._editing = null; this._load(); });
    this._container.querySelector('#dr-group-list')?.addEventListener('click', event => {
      const edit = event.target.closest('[data-dr-edit]'); const plan = event.target.closest('[data-dr-plan]');
      const rehearse = event.target.closest('[data-dr-rehearse]'); const remove = event.target.closest('[data-dr-delete]');
      if (edit) { this._editing = edit.dataset.drEdit; this._renderContent(); }
      else if (plan) this._plan(plan.dataset.drPlan); else if (rehearse) this._rehearse(rehearse.dataset.drRehearse);
      else if (remove) this._delete(remove.dataset.drDelete);
    });
  },
  _renderContent() {
    const content = this._container?.querySelector('#dr-content'); if (!content) return;
    content.innerHTML = `${this._summaryHtml()}${this._editorHtml()}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2>Protection posture</h2>
        ${this._isAdmin() ? '<div style="display:flex;gap:8px;flex-wrap:wrap"><label>Runbook mode <select id="dr-mode" class="form-control"><option value="test">isolated test</option><option value="planned_failover">planned failover</option><option value="unplanned_failover">unplanned failover</option><option value="failback">failback</option></select></label><label>Incident reason (unplanned only)<input id="dr-incident-reason" maxlength="500" class="form-control" placeholder="bounded incident declaration"></label></div>' : ''}</div>
      ${this._groupsHtml()}<h2 style="margin-top:24px">Provider replication inventory</h2>${this._replicationsHtml()}
      <h2 style="margin-top:24px">Immutable rehearsal history</h2>${this._runsHtml()}`;
    this._wire();
  },
  async _load() {
    const content = this._container?.querySelector('#dr-content');
    if (!content) return;
    if (!this._hostId) { content.innerHTML = '<div class="empty-msg">Add a Proxmox VE, vSphere or Xen endpoint first.</div>'; return; }
    content.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting DR evidence and durable rehearsals…</div>';
    try {
      const [overview, groups, replications, runs, workloads, nodes, storages] = await Promise.all([
        Api.getProviderDrOverview(this._hostId), Api.getProviderDrProtectionGroups(this._hostId, 100),
        Api.getProviderDrReplications(this._hostId).catch(() => ({ items: [] })),
        Api.getProviderDrRuns(this._hostId, { limit: 50 }), Api.getProviderVMs(this._hostId, 500),
        Api.getProviderHosts(this._hostId, 64), Api.getProviderStorages(this._hostId, 500),
      ]);
      this._overview = overview; this._groups = groups.items || []; this._replications = replications.items || [];
      this._runs = runs.items || []; this._workloads = workloads.items || []; this._nodes = nodes.items || [];
      this._storages = storages.items || []; this._renderContent();
    } catch (err) { content.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${this._escape(err.message)}</div>`; }
  },
  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); } catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-house-medical-circle-check"></i> Disaster Recovery</h1>
      <div class="text-muted text-sm">Protection groups, RPO/RTO evidence, deterministic runbooks and non-mutating rehearsals</div></div>
      <select id="dr-host" class="form-control" aria-label="Virtualization endpoint">${this._hosts.map(host => `<option value="${Number(host.id)}">${this._escape(host.name)} · ${this._escape(host.daemonType)}</option>`).join('')}</select></div>
      <div class="alert alert-warning"><strong>No automatic failover is authorized.</strong> Real provider mutations require a future provider-specific transport with fencing, isolated networking, native task evidence and reprotection.</div><div id="dr-content"></div>`;
    container.querySelector('#dr-host')?.addEventListener('change', event => {
      this._hostId = Number(event.target.value); this._editing = null; this._load();
    });
    await this._load();
  },
  destroy() { this._container = null; this._overview = null; this._groups = []; this._replications = [];
    this._runs = []; this._workloads = []; this._nodes = []; this._storages = []; this._editing = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = DisasterRecoveryPage;
