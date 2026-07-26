/* Provider-neutral policy planning plus independently gated durable execution. */
'use strict';

const BackupPoliciesPage = {
  _container: null, _hosts: [], _hostId: null, _repositories: [], _workloads: [],
  _policies: [], _runs: [], _executions: [], _editing: null, _executionFeature: false,

  _isAdmin() { return App.user?.role === 'admin' || App.user?.roles?.includes('admin'); },
  _escape(value) { return Utils.escapeHtml(value === null || value === undefined ? '' : String(value)); },
  _date(value) { return value ? Utils.timeAgo(value) : 'never'; },

  _policyHtml(policy) {
    const scope = policy.scope || {}; const retention = policy.retention || {};
    const selected = scope.includeAll ? 'all current workloads'
      : `${(scope.workloadIds || []).length} explicit + smart selectors`;
    return `<article class="card" style="padding:14px" data-policy-card="${this._escape(policy.id)}">
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:start;flex-wrap:wrap">
        <div><h3 style="margin:0">${this._escape(policy.name)}</h3>
          <div class="text-muted text-sm">${this._escape(policy.description || 'No description')}</div></div>
        <div><span class="badge ${policy.enabled ? 'badge-success' : 'badge-secondary'}">${policy.enabled ? 'planning scheduled' : 'planning disabled'}</span>
          <span class="badge ${policy.execution?.mode && policy.execution.mode !== 'disabled' ? 'badge-warning' : 'badge-info'}">execution ${this._escape(policy.execution?.mode || 'disabled')}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:12px">
        <div><span class="text-muted text-sm">Schedule</span><br>${this._escape(policy.schedule?.frequency)} · ${this._escape(policy.schedule?.timezone)}</div>
        <div><span class="text-muted text-sm">Scope</span><br>${this._escape(selected)}</div>
        <div><span class="text-muted text-sm">GFS</span><br>L${Number(retention.keepLast || 0)} D${Number(retention.daily || 0)} W${Number(retention.weekly || 0)} M${Number(retention.monthly || 0)} Y${Number(retention.yearly || 0)}</div>
        <div><span class="text-muted text-sm">Last plan</span><br><span class="badge ${policy.lastPlanStatus === 'blocked' ? 'badge-danger' : policy.lastPlanStatus === 'planned' ? 'badge-success' : 'badge-secondary'}">${this._escape(policy.lastPlanStatus || 'none')}</span> ${this._escape(this._date(policy.lastPlanAt))}</div>
      </div>
      ${this._isAdmin() ? `<div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-sm btn-secondary" data-policy-edit="${this._escape(policy.id)}"><i class="fas fa-pen"></i> Edit</button>
        <button class="btn btn-sm btn-primary" data-policy-plan="${this._escape(policy.id)}"><i class="fas fa-list-check"></i> Plan now</button>
        ${this._executionFeature ? `<button class="btn btn-sm btn-warning" data-policy-authorize="manual" data-policy-id="${this._escape(policy.id)}"><i class="fas fa-key"></i> Authorize manual</button>
        <button class="btn btn-sm btn-warning" data-policy-authorize="scheduled" data-policy-id="${this._escape(policy.id)}"><i class="fas fa-clock"></i> Authorize scheduled</button>
        ${policy.execution?.mode !== 'disabled' ? `<button class="btn btn-sm btn-danger" data-policy-execute="${this._escape(policy.id)}"><i class="fas fa-database"></i> Run backup</button>
          <button class="btn btn-sm btn-secondary" data-policy-authorize="disabled" data-policy-id="${this._escape(policy.id)}">Disable execution</button>` : ''}` : ''}
        <button class="btn btn-sm btn-danger" data-policy-delete="${this._escape(policy.id)}"><i class="fas fa-trash"></i> Delete</button>
      </div>` : ''}</article>`;
  },

  _policiesHtml() {
    if (!this._policies.length) return '<div class="empty-msg">No backup policy is defined for this endpoint.</div>';
    return `<div style="display:grid;gap:10px">${this._policies.map(policy => this._policyHtml(policy)).join('')}</div>`;
  },

  _runsHtml() {
    if (!this._runs.length) return '<div class="empty-msg">No plan evidence has been recorded yet.</div>';
    const rows = this._runs.slice(0, 20).map(run => `<tr><td>${this._escape(run.createdAt)}</td>
      <td>${this._escape(this._policies.find(policy => policy.id === run.policyId)?.name || run.policyId)}</td>
      <td>${this._escape(run.trigger)}</td><td><span class="badge ${run.state === 'planned' ? 'badge-success' : 'badge-danger'}">${this._escape(run.state)}</span></td>
      <td><code title="${this._escape(run.planHash)}">${this._escape(String(run.planHash || '').slice(0, 12))}</code></td>
      <td>${Number(run.plan?.summary?.selectedWorkloads || run.plan?.scope?.selectedCount || 0)}</td></tr>`).join('');
    return `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Recorded</th><th>Policy</th><th>Trigger</th><th>State</th><th>Plan hash</th><th>VMs</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _executionsHtml() {
    if (!this._executionFeature) return '<div class="alert alert-info">Backup execution is disabled by the release gate. Planning remains available.</div>';
    if (!this._executions.length) return '<div class="empty-msg">No provider backup execution has been recorded.</div>';
    const rows = this._executions.slice(0, 20).map(execution => `<tr><td>${this._escape(execution.createdAt)}</td>
      <td>${this._escape(this._policies.find(policy => policy.id === execution.policyId)?.name || execution.policyId)}</td>
      <td>${this._escape(execution.trigger)}</td><td><span class="badge ${execution.state === 'succeeded' ? 'badge-success' : ['failed', 'unknown'].includes(execution.state) ? 'badge-danger' : 'badge-warning'}">${this._escape(execution.state)}</span></td>
      <td>${Number(execution.summary?.succeeded || 0)}/${Number(execution.summary?.total || 0)}</td>
      <td>${Number(execution.summary?.verificationPending || 0)}</td><td><strong>blocked</strong></td>
      <td>${this._isAdmin() && ['queued', 'running', 'verification_pending'].includes(execution.state)
        ? `<button class="btn btn-sm btn-danger" data-execution-cancel="${this._escape(execution.id)}">Cancel</button>` : ''}</td></tr>`).join('');
    return `<div id="backup-execution-list" class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Started</th><th>Policy</th><th>Trigger</th><th>State</th><th>Succeeded</th><th>Verification pending</th><th>Retention mutation</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _editorHtml() {
    if (!this._isAdmin()) return '<div class="alert alert-info">Viewers can inspect policy and plan evidence. Authoring requires administrator access.</div>';
    const repositories = this._repositories.map(item => `<option value="${this._escape(item.id)}">${this._escape(item.displayName)} · ${this._escape(item.repositoryType)}</option>`).join('');
    const workloads = this._workloads.map(item => `<option value="${this._escape(item.id)}">${this._escape(item.displayName)} · ${this._escape(item.status?.powerState || 'unknown')}</option>`).join('');
    const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
    return `<div class="card" style="padding:16px"><div style="display:flex;justify-content:space-between"><h2 id="backup-editor-title">New backup policy</h2><button id="backup-reset" class="btn btn-sm btn-secondary">Reset</button></div>
      <div class="alert alert-info"><strong>Saving or planning never starts a backup.</strong> Proxmox execution has a separate release gate, typed per-policy authorization, live revalidation and an idempotent durable operation. Retention deletion remains blocked.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px">
        <label>Name<input id="bp-name" maxlength="120" class="form-control" value="Production GFS"></label>
        <label>Repository<select id="bp-repository" class="form-control">${repositories}</select></label>
        <label>Frequency<select id="bp-frequency" class="form-control"><option>daily</option><option>hourly</option><option>weekly</option><option>monthly</option></select></label>
        <label>Timezone<input id="bp-timezone" maxlength="80" class="form-control" value="${this._escape(browserZone)}"></label>
        <label>Hour<input id="bp-hour" type="number" min="0" max="23" class="form-control" value="2"></label>
        <label>Minute<select id="bp-minute" class="form-control"><option>0</option><option selected>15</option><option>30</option><option>45</option></select></label>
        <label>Weekday (0 Sun–6 Sat)<input id="bp-weekday" type="number" min="0" max="6" class="form-control" value="0"></label>
        <label>Day of month (1–28)<input id="bp-monthday" type="number" min="1" max="28" class="form-control" value="1"></label>
      </div>
      <h3>Workload scope</h3><label><input id="bp-all" type="checkbox" checked> Include all stable workloads</label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:8px">
        <label>Explicit workloads<select id="bp-workloads" class="form-control" multiple size="5">${workloads}</select></label>
        <div><label>Label key<input id="bp-label-key" maxlength="64" class="form-control" placeholder="environment"></label>
          <label>Label value<input id="bp-label-value" maxlength="240" class="form-control" placeholder="production"></label></div>
        <label>Exclude workloads<select id="bp-exclusions" class="form-control" multiple size="5">${workloads}</select></label>
      </div>
      <h3>Retention and protection intent</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
        <label>Keep last<input id="bp-keep-last" type="number" min="0" max="1000" class="form-control" value="3"></label>
        <label>Hourly<input id="bp-hourly" type="number" min="0" max="744" class="form-control" value="0"></label>
        <label>Daily<input id="bp-daily" type="number" min="0" max="3660" class="form-control" value="7"></label>
        <label>Weekly<input id="bp-weekly" type="number" min="0" max="520" class="form-control" value="4"></label>
        <label>Monthly<input id="bp-monthly" type="number" min="0" max="240" class="form-control" value="12"></label>
        <label>Yearly<input id="bp-yearly" type="number" min="0" max="100" class="form-control" value="3"></label>
        <label>Consistency<select id="bp-consistency" class="form-control"><option value="crash">crash</option><option value="filesystem">filesystem</option><option value="application">application</option></select></label>
        <label>Fallback<select id="bp-fallback" class="form-control"><option value="fail">fail closed</option><option value="crash">crash</option><option value="filesystem">filesystem</option></select></label>
        <label>Encryption<select id="bp-encryption" class="form-control"><option>none</option><option>preferred</option><option>required</option></select></label>
        <label>Key reference (never key material)<input id="bp-key-ref" maxlength="120" class="form-control" placeholder="vault-key-alias"></label>
        <label>Immutability<select id="bp-immutability" class="form-control"><option>none</option><option>preferred</option><option>required</option></select></label>
        <label>Minimum lock days<input id="bp-lock-days" type="number" min="0" max="36500" class="form-control" value="0"></label>
        <label>Max concurrent<input id="bp-concurrency" type="number" min="1" max="32" class="form-control" value="1"></label>
        <label>Bandwidth Mbps<input id="bp-bandwidth" type="number" min="1" max="100000" class="form-control" placeholder="unlimited"></label>
      </div>
      <div style="display:flex;gap:14px;align-items:center;margin-top:12px;flex-wrap:wrap">
        <label><input id="bp-enabled" type="checkbox"> Schedule plan generation</label>
        <label><input id="bp-verify" type="checkbox" checked> Verify after backup (execution intent)</label>
        <button id="bp-preflight" class="btn btn-secondary"><i class="fas fa-clipboard-check"></i> Preflight</button>
        <button id="bp-save" class="btn btn-primary"><i class="fas fa-save"></i> Save policy</button>
      </div><div id="bp-preflight-result" style="margin-top:12px"></div></div>`;
  },

  _number(id) { return Number(this._container.querySelector(`#${id}`)?.value); },
  _selected(id) { return [...(this._container.querySelector(`#${id}`)?.selectedOptions || [])].map(option => option.value); },
  _payload() {
    const key = this._container.querySelector('#bp-label-key')?.value.trim();
    const value = this._container.querySelector('#bp-label-value')?.value.trim();
    const bandwidth = this._container.querySelector('#bp-bandwidth')?.value;
    return {
      ...(this._editing ? { id: this._editing } : {}),
      name: this._container.querySelector('#bp-name')?.value,
      repositoryId: this._container.querySelector('#bp-repository')?.value,
      enabled: this._container.querySelector('#bp-enabled')?.checked === true, mode: 'plan_only',
      schedule: { frequency: this._container.querySelector('#bp-frequency')?.value,
        timezone: this._container.querySelector('#bp-timezone')?.value, hour: this._number('bp-hour'),
        minute: this._number('bp-minute'), weekday: this._number('bp-weekday'), dayOfMonth: this._number('bp-monthday') },
      scope: { includeAll: this._container.querySelector('#bp-all')?.checked === true,
        workloadIds: this._selected('bp-workloads'), selectors: { match: 'all', labels: key && value ? { [key]: value } : {}, powerStates: [] },
        exclusions: { workloadIds: this._selected('bp-exclusions'), labels: {}, diskSelectors: [] } },
      consistency: { requested: this._container.querySelector('#bp-consistency')?.value,
        fallback: this._container.querySelector('#bp-fallback')?.value, guestToolsRequired: false },
      retention: { keepLast: this._number('bp-keep-last'), hourly: this._number('bp-hourly'),
        daily: this._number('bp-daily'), weekly: this._number('bp-weekly'), monthly: this._number('bp-monthly'),
        yearly: this._number('bp-yearly'), weekStartsOn: 1 },
      protection: { encryption: { mode: this._container.querySelector('#bp-encryption')?.value,
        keyReference: this._container.querySelector('#bp-key-ref')?.value || null },
      immutability: { mode: this._container.querySelector('#bp-immutability')?.value,
        minimumLockDays: this._number('bp-lock-days') } },
      controls: { maxConcurrent: this._number('bp-concurrency'),
        bandwidthLimitMbps: bandwidth ? Number(bandwidth) : null, window: null },
      verification: { afterBackup: this._container.querySelector('#bp-verify')?.checked === true,
        maximumUnverifiedHours: 24, restoreDrillRequired: false },
    };
  },

  _preflightHtml(plan) {
    const findings = (plan.findings || []).map(item => `<li><span class="badge ${item.severity === 'blocker' ? 'badge-danger' : 'badge-warning'}">${this._escape(item.severity)}</span> <strong>${this._escape(item.code)}</strong> — ${this._escape(item.message)}</li>`).join('');
    return `<div class="alert ${plan.allowed ? 'alert-success' : 'alert-warning'}"><strong>${plan.allowed ? 'Plan is admissible' : 'Plan is blocked'}</strong> · ${Number(plan.summary?.selectedWorkloads || 0)} workloads · ${Number(plan.summary?.retentionCandidates || 0)} portable retention candidates<br><code>${this._escape(plan.planHash)}</code>${findings ? `<ul style="margin:8px 0 0 18px">${findings}</ul>` : ''}</div>`;
  },

  async _preflight() {
    const target = this._container.querySelector('#bp-preflight-result');
    target.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Reading live repository and workload evidence…</div>';
    try { const plan = await Api.preflightProviderBackupPolicy(this._hostId, this._payload()); target.innerHTML = this._preflightHtml(plan); return plan; }
    catch (err) { target.innerHTML = `<div class="alert alert-danger">${this._escape(err.message)}</div>`; throw err; }
  },

  async _save() {
    try {
      const result = await Api.saveProviderBackupPolicy(this._hostId, this._payload());
      Toast.success(result.created ? 'Backup policy created' : 'Backup policy updated');
      this._editing = null; await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _set(id, value) { const element = this._container.querySelector(`#${id}`); if (element && value !== undefined && value !== null) element.value = value; },
  _check(id, value) { const element = this._container.querySelector(`#${id}`); if (element) element.checked = value === true; },
  _selectMany(id, values) { const wanted = new Set(values || []); this._container.querySelectorAll(`#${id} option`).forEach(option => { option.selected = wanted.has(option.value); }); },
  _edit(policyId) {
    const policy = this._policies.find(item => item.id === policyId); if (!policy) return;
    this._editing = policy.id; this._container.querySelector('#backup-editor-title').textContent = `Edit ${policy.name}`;
    this._set('bp-name', policy.name); this._set('bp-repository', policy.repositoryId);
    this._set('bp-frequency', policy.schedule.frequency); this._set('bp-timezone', policy.schedule.timezone);
    this._set('bp-hour', policy.schedule.hour); this._set('bp-minute', policy.schedule.minute);
    this._set('bp-weekday', policy.schedule.weekday); this._set('bp-monthday', policy.schedule.dayOfMonth);
    this._check('bp-all', policy.scope.includeAll); this._selectMany('bp-workloads', policy.scope.workloadIds);
    this._selectMany('bp-exclusions', policy.scope.exclusions?.workloadIds);
    const firstLabel = Object.entries(policy.scope.selectors?.labels || {})[0] || ['', ''];
    this._set('bp-label-key', firstLabel[0]); this._set('bp-label-value', firstLabel[1]);
    for (const key of ['keepLast', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']) this._set(`bp-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, policy.retention[key]);
    this._set('bp-consistency', policy.consistency.requested); this._set('bp-fallback', policy.consistency.fallback);
    this._set('bp-encryption', policy.protection.encryption.mode); this._set('bp-key-ref', policy.protection.encryption.keyReference || '');
    this._set('bp-immutability', policy.protection.immutability.mode); this._set('bp-lock-days', policy.protection.immutability.minimumLockDays);
    this._set('bp-concurrency', policy.controls.maxConcurrent); this._set('bp-bandwidth', policy.controls.bandwidthLimitMbps || '');
    this._check('bp-enabled', policy.enabled); this._check('bp-verify', policy.verification.afterBackup);
    this._container.querySelector('#backup-editor-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async _plan(policyId) {
    try { const result = await Api.planProviderBackupPolicy(this._hostId, policyId); Toast.success(`Plan recorded: ${result.run.state}`); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  async _authorize(policyId, mode) {
    const policy = this._policies.find(item => item.id === policyId); if (!policy) return;
    let confirmName = '';
    if (mode !== 'disabled') {
      confirmName = window.prompt(`Type the exact policy name to authorize ${mode} provider backup execution:\n${policy.name}`) || '';
      if (confirmName !== policy.name) { Toast.error('Exact policy-name confirmation is required'); return; }
    }
    try {
      await Api.authorizeProviderBackupExecution(this._hostId, policy.id, { mode, confirmName });
      Toast.success(mode === 'disabled' ? 'Backup execution disabled' : `${mode} backup execution authorized`);
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _execute(policyId) {
    const policy = this._policies.find(item => item.id === policyId); if (!policy) return;
    const confirmName = window.prompt(`This will submit real provider backup tasks. Type the exact policy name:\n${policy.name}`) || '';
    if (confirmName !== policy.name) { Toast.error('Exact policy-name confirmation is required'); return; }
    const idempotencyKey = `ui-backup-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
    try {
      const result = await Api.executeProviderBackupPolicy(this._hostId, policy.id, { confirmName }, idempotencyKey);
      Toast.success(`Backup execution ${result.execution.state}`); await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _cancelExecution(executionId) {
    const execution = this._executions.find(item => item.id === executionId); if (!execution) return;
    const policy = this._policies.find(item => item.id === execution.policyId); if (!policy) return;
    const confirmName = window.prompt(`Cancel queued/running backup tasks. Completed provider backups are retained. Type the exact policy name:\n${policy.name}`) || '';
    if (confirmName !== policy.name) { Toast.error('Exact policy-name confirmation is required'); return; }
    try { await Api.cancelProviderBackupExecution(this._hostId, execution.id, { confirmName }); Toast.success('Backup cancellation requested'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  async _delete(policyId) {
    const policy = this._policies.find(item => item.id === policyId);
    if (!policy || !window.confirm(`Delete backup policy "${policy.name}"? Historical plans remain auditable.`)) return;
    try { await Api.deleteProviderBackupPolicy(this._hostId, policyId); Toast.success('Backup policy deleted'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  _wire() {
    this._container.querySelector('#bp-preflight')?.addEventListener('click', () => this._preflight().catch(() => {}));
    this._container.querySelector('#bp-save')?.addEventListener('click', () => this._save());
    this._container.querySelector('#backup-reset')?.addEventListener('click', () => { this._editing = null; this._load(); });
    this._container.querySelector('#backup-policy-list')?.addEventListener('click', event => {
      const edit = event.target.closest('[data-policy-edit]'); const plan = event.target.closest('[data-policy-plan]');
      const authorize = event.target.closest('[data-policy-authorize]'); const execute = event.target.closest('[data-policy-execute]');
      const remove = event.target.closest('[data-policy-delete]');
      if (edit) this._edit(edit.dataset.policyEdit); else if (plan) this._plan(plan.dataset.policyPlan);
      else if (authorize) this._authorize(authorize.dataset.policyId, authorize.dataset.policyAuthorize);
      else if (execute) this._execute(execute.dataset.policyExecute); else if (remove) this._delete(remove.dataset.policyDelete);
    });
    this._container.querySelector('#backup-execution-list')?.addEventListener('click', event => {
      const cancel = event.target.closest('[data-execution-cancel]');
      if (cancel) this._cancelExecution(cancel.dataset.executionCancel);
    });
  },

  async _load() {
    const content = this._container.querySelector('#backup-content');
    if (!this._hostId) { content.innerHTML = '<div class="empty-msg">Add a Proxmox VE or Xen Orchestra endpoint first.</div>'; return; }
    content.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Reading live backup evidence and policies…</div>';
    try {
      const [recovery, workloads, policies, runs] = await Promise.all([
        Api.getProviderRecoveryPoints(this._hostId, { limit: 500 }), Api.getProviderVMs(this._hostId, 500),
        Api.getProviderBackupPolicies(this._hostId, 100), Api.getProviderBackupPolicyRuns(this._hostId, '', 50),
      ]);
      this._repositories = recovery.repositories || []; this._workloads = workloads.items || [];
      this._policies = policies.items || []; this._runs = runs.items || [];
      this._executionFeature = policies.executionFeatureEnabled === true;
      this._executions = this._executionFeature
        ? (await Api.getProviderBackupExecutions(this._hostId, '', 50)).items || [] : [];
      content.innerHTML = `${this._editorHtml()}<section style="margin-top:20px"><h2>Policies</h2><div id="backup-policy-list">${this._policiesHtml()}</div></section>
        <section style="margin-top:20px"><h2>Recorded plan evidence</h2>${this._runsHtml()}</section>
        <section style="margin-top:20px"><h2>Durable backup executions</h2>${this._executionsHtml()}</section>`;
      this._wire();
    } catch (err) { content.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${this._escape(err.message)}</div>`; }
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'xen'].includes(host.daemonType)); } catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-calendar-check"></i> Backup Policies</h1>
      <div class="text-muted text-sm">Portable scope, schedule, GFS and protection intent with immutable plan evidence</div></div>
      <select id="backup-host" class="form-control" aria-label="Virtualization endpoint">${this._hosts.map(host => `<option value="${Number(host.id)}">${this._escape(host.name)} · ${this._escape(host.daemonType)}</option>`).join('')}</select></div>
      <div class="alert alert-warning"><strong>Snapshots are not backups.</strong> Policy plans target provider-reported backup repositories. Unknown capability evidence fails closed for required encryption or immutability.</div>
      <div id="backup-content"></div>`;
    container.querySelector('#backup-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); this._editing = null; this._load(); });
    await this._load();
  },

  destroy() { this._container = null; this._repositories = []; this._workloads = []; this._policies = []; this._runs = []; this._executions = []; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = BackupPoliciesPage;
