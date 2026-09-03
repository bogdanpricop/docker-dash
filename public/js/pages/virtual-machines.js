/* Common provider VM inventory and detail shell. */
'use strict';

const VirtualMachinesPage = {
  _hosts: [],
  _hostId: null,
  _shell: null,
  _selected: new Set(),
  _views: [],
  _activeViewId: null,
  _viewState: null,

  _powerActions: Object.freeze([
    { action: 'start', label: 'Start', icon: 'fa-play' },
    { action: 'shutdown', label: 'Shut down', icon: 'fa-power-off' },
    { action: 'reboot', label: 'Reboot', icon: 'fa-redo' },
    { action: 'forceShutdown', label: 'Force off', icon: 'fa-stop', force: true },
    { action: 'forceReboot', label: 'Force reboot', icon: 'fa-sync', force: true },
  ]),

  _parseRoute(value) {
    const parts = String(value || '').split('/').filter(Boolean);
    const hostId = Number(parts[0]);
    const resourceId = parts[1] || null;
    const tab = parts[2] || null;
    if (!Number.isInteger(hostId) || hostId <= 0 || !/^ddr_vm_[a-f0-9]{26}$/.test(resourceId || '')) return null;
    return { hostId, resourceId, tab };
  },

  _blockerSummary(action) {
    return (action?.blockers || []).map(blocker => blocker.reason).filter(Boolean).join(' · ') || 'Action is unavailable';
  },

  _providerLabel(type) {
    return { proxmox: 'Proxmox VE', vsphere: 'VMware vSphere / ESXi', xen: 'Xen / XCP-ng' }[type] || type;
  },

  _providerRoute(type) {
    return { proxmox: '#/proxmox-resources', vsphere: '#/vsphere-resources', xen: '#/xen-resources' }[type] || '#/hosts';
  },

  _idempotencyKey(prefix = 'vm-power') {
    const random = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
  },

  async _withCriticalAuthorization(submit) {
    try { return await submit(null); }
    catch (err) {
      if (err?.body?.code !== 'CRITICAL_OPERATION_JIT_REQUIRED') throw err;
      const details = err.body.details || {};
      const authorization = await Modal.form(`<div class="alert alert-warning"><strong>Scoped elevation required.</strong> Request and claim the exact permission from Provider Security, or use an active break-glass envelope. The token is sent once in a protected header and is never added to the operation body.</div>
        <label class="form-label" for="critical-operation-permission">Permission</label>
        <input id="critical-operation-permission" class="form-control mono" readonly value="${Utils.escapeHtml(details.permissionKey || 'provider critical operation')}">
        <label class="form-label" for="critical-operation-scope" style="margin-top:10px">Organization or provider scope ID</label>
        <input id="critical-operation-scope" class="form-control" type="number" min="1" value="${Number(details.scopeId) > 0 ? Number(details.scopeId) : 1}">
        <label class="form-label" for="critical-operation-grant" style="margin-top:10px">JIT or break-glass token</label>
        <input id="critical-operation-grant" class="form-control mono" maxlength="64" autocomplete="off" spellcheck="false">`, {
        title: 'Authorize critical provider operation', submitLabel: 'Authorize and retry',
        danger: true, width: '650px',
        onSubmit: root => ({
          scopeId: Number(root.querySelector('#critical-operation-scope').value),
          grantToken: root.querySelector('#critical-operation-grant').value.trim(),
        }),
      });
      return authorization ? submit(authorization) : null;
    }
  },

  _powerLabel(action) {
    return this._powerActions.find(item => item.action === action)?.label || action;
  },

  _defaultViewState() {
    return {
      providerHostId: null,
      query: '',
      powerState: 'all',
      columns: ['name', 'powerState', 'cpu', 'memory', 'ipAddress', 'observedAt'],
      sort: { field: 'name', direction: 'asc' },
    };
  },

  _stateFromView(view) {
    const fallback = this._defaultViewState();
    if (!view) return fallback;
    return {
      providerHostId: view.providerHostId || null,
      query: view.filters?.query || '',
      powerState: view.filters?.powerState || 'all',
      columns: Array.isArray(view.columns) && view.columns.includes('name') ? [...view.columns] : fallback.columns,
      sort: view.sort?.field && view.sort?.direction ? { ...view.sort } : fallback.sort,
    };
  },

  _viewPayload(name, isDefault, version) {
    const state = this._viewState || this._defaultViewState();
    return {
      name,
      resourceType: 'virtual-machines',
      providerHostId: state.providerHostId || null,
      filters: { query: state.query || '', powerState: state.powerState || 'all' },
      columns: [...state.columns],
      sort: { ...state.sort },
      isDefault: Boolean(isDefault),
      ...(version ? { version } : {}),
    };
  },

  _inventorySortValue(vm, field) {
    if (field === 'name') return String(vm.displayName || '').toLowerCase();
    if (field === 'powerState') return String(vm.status?.powerState || 'unknown').toLowerCase();
    if (field === 'cpu') return vm.spec?.cpuCount ?? null;
    if (field === 'memory') return vm.spec?.memoryBytes ?? null;
    if (field === 'ipAddress') return String(vm.status?.ipAddress || '').toLowerCase();
    if (field === 'observedAt') return Number.isFinite(Date.parse(vm.observedAt)) ? Date.parse(vm.observedAt) : null;
    return null;
  },

  _sortInventory(items, sort = { field: 'name', direction: 'asc' }) {
    const direction = sort.direction === 'desc' ? -1 : 1;
    return [...items].sort((left, right) => {
      const a = this._inventorySortValue(left, sort.field);
      const b = this._inventorySortValue(right, sort.field);
      if (a === b) return String(left.displayName || '').localeCompare(String(right.displayName || ''));
      if (a === null || a === '') return 1;
      if (b === null || b === '') return -1;
      return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * direction;
    });
  },

  _syncViewStateFromControls() {
    if (!this._viewState) this._viewState = this._defaultViewState();
    this._viewState.providerHostId = this._hostId;
    this._viewState.query = document.getElementById('common-vm-search')?.value || '';
    this._viewState.powerState = document.getElementById('common-vm-state')?.value || 'all';
    this._viewState.sort = {
      field: document.getElementById('common-vm-sort')?.value || 'name',
      direction: document.getElementById('common-vm-sort-direction')?.value || 'asc',
    };
    const checked = [...document.querySelectorAll('[data-vm-column]:checked')].map(input => input.dataset.vmColumn);
    this._viewState.columns = checked.includes('name') ? checked : ['name', ...checked];
  },

  async _reloadInventoryViews() {
    const response = await Api.getProviderInventoryViews('virtual-machines');
    this._views = response.views || [];
  },

  async _saveInventoryView(mode, container) {
    this._syncViewStateFromControls();
    const current = this._views.find(view => view.id === this._activeViewId);
    try {
      if (mode === 'create') {
        const input = await Modal.form(`
          <label class="form-label" for="common-vm-view-name">View name</label>
          <input id="common-vm-view-name" class="form-control" maxlength="80" autocomplete="off" placeholder="Production VMs">
          <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input id="common-vm-view-default" type="checkbox"> Use as my default VM view</label>`, {
          title: 'Save inventory view', submitLabel: 'Save view',
          onSubmit: root => {
            const name = root.querySelector('#common-vm-view-name').value.trim();
            if (!name) { Toast.error('View name is required'); return false; }
            return { name, isDefault: root.querySelector('#common-vm-view-default').checked };
          },
        });
        if (!input) return;
        const result = await Api.createProviderInventoryView(this._viewPayload(input.name, input.isDefault));
        this._activeViewId = result.view.id;
        Toast.success(`Saved inventory view ${result.view.name}`);
      } else {
        if (!current) return Toast.warning('Select a saved view first');
        const result = await Api.updateProviderInventoryView(current.id,
          this._viewPayload(current.name, current.isDefault, current.version));
        this._activeViewId = result.view.id;
        Toast.success(`Updated inventory view ${result.view.name}`);
      }
      await this._reloadInventoryViews();
      await this._renderHome(container);
    } catch (error) { Toast.error(error.message); }
  },

  async _setDefaultInventoryView(container) {
    this._syncViewStateFromControls();
    const current = this._views.find(view => view.id === this._activeViewId);
    if (!current) return Toast.warning('Select a saved view first');
    try {
      const result = await Api.updateProviderInventoryView(current.id,
        this._viewPayload(current.name, true, current.version));
      this._activeViewId = result.view.id;
      await this._reloadInventoryViews();
      Toast.success(`${result.view.name} is now the default VM view`);
      await this._renderHome(container);
    } catch (error) { Toast.error(error.message); }
  },

  async _deleteInventoryView(container) {
    const current = this._views.find(view => view.id === this._activeViewId);
    if (!current) return Toast.warning('Select a saved view first');
    const confirmed = await Modal.confirm(`Delete the personal inventory view “${Utils.escapeHtml(current.name)}”?`, {
      title: 'Delete inventory view', confirmText: 'Delete view', danger: true, html: true,
    });
    if (!confirmed) return;
    try {
      await Api.deleteProviderInventoryView(current.id);
      this._activeViewId = null;
      this._viewState = this._defaultViewState();
      await this._reloadInventoryViews();
      Toast.success(`Deleted inventory view ${current.name}`);
      await this._renderHome(container);
    } catch (error) { Toast.error(error.message); }
  },

  _preflightHtml(plans) {
    const blockers = plans.flatMap(plan => (plan.blockers || []).map(item => ({ ...item, vm: plan.resource?.displayName })));
    const warnings = plans.flatMap(plan => (plan.warnings || []).map(item => ({ ...item, vm: plan.resource?.displayName })));
    return `<div class="text-sm">
      ${blockers.length ? `<div class="alert alert-danger" style="margin-bottom:12px"><strong>Operation blocked</strong><ul style="margin:8px 0 0 18px">${blockers.map(item => `<li>${Utils.escapeHtml(item.vm || 'VM')}: ${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="card" style="padding:12px;margin-bottom:${warnings.length ? '12px' : '0'}">
        ${plans.map(plan => `<div style="display:flex;justify-content:space-between;gap:12px;margin:4px 0"><strong>${Utils.escapeHtml(plan.resource.displayName)}</strong><span>${Utils.escapeHtml(plan.currentPowerState)} → ${Utils.escapeHtml(plan.expectedPowerState)}</span></div>`).join('')}
      </div>
      ${warnings.length ? `<div class="alert alert-warning"><strong>Warnings</strong><ul style="margin:8px 0 0 18px">${warnings.map(item => `<li>${Utils.escapeHtml(item.vm || 'VM')}: ${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  },

  async _showBlockedPreflight(plans, action) {
    await Modal.confirm(this._preflightHtml(plans), {
      title: `${this._powerLabel(action)} preflight`, confirmText: 'Close', html: true, width: '620px',
    });
  },

  async _confirmBulkForce(plans, action) {
    const fields = plans.map((plan, index) => `<label class="form-label" for="bulk-force-${index}">${Utils.escapeHtml(plan.resource.displayName)}</label>
      <input class="form-control bulk-force-name" id="bulk-force-${index}" data-expected="${Utils.escapeHtml(plan.resource.displayName)}" autocomplete="off" placeholder="Type the exact VM name" style="margin-bottom:10px">`).join('');
    const result = await Modal.form(`${this._preflightHtml(plans)}<div style="margin-top:14px"><p class="text-sm" style="color:var(--yellow)">Type every exact VM name to authorize this forced operation.</p>${fields}</div>`, {
      title: `${this._powerLabel(action)} ${plans.length} VM(s)`, submitLabel: 'Authorize forced operation', width: '680px',
      onSubmit: root => {
        const inputs = [...root.querySelectorAll('.bulk-force-name')];
        if (inputs.some(input => input.value !== input.dataset.expected)) {
          Toast.error('Every VM name must match exactly');
          return false;
        }
        return Object.fromEntries(inputs.map((input, index) => [plans[index].resource.id, input.value]));
      },
    });
    return result;
  },

  async _runPower(hostId, vm, action) {
    try {
      const plan = await Api.preflightProviderVMPower(hostId, vm.id, action);
      if (!plan.allowed) return this._showBlockedPreflight([plan], action);
      const confirmed = await Modal.confirm(this._preflightHtml([plan]), {
        title: `${this._powerLabel(action)} ${vm.displayName}`,
        confirmText: this._powerLabel(action), danger: plan.confirmation?.mode === 'typed_name',
        typeToConfirm: plan.confirmation?.mode === 'typed_name' ? plan.confirmation.expected : null,
        html: true, width: '620px',
      });
      if (!confirmed) return;
      const idempotencyKey = this._idempotencyKey();
      const body = {
        action, planHash: plan.planHash, confirm: true,
        ...(plan.confirmation?.mode === 'typed_name' ? { confirmName: plan.confirmation.expected } : {}),
      };
      const result = await this._withCriticalAuthorization(authorization =>
        Api.submitProviderVMPower(hostId, vm.id, body, idempotencyKey, authorization));
      if (!result) return;
      Toast.success(`${this._powerLabel(action)} queued for ${vm.displayName}`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
  },

  async _runBulkPower(action) {
    const resourceIds = [...this._selected];
    if (!resourceIds.length) return;
    try {
      const preflight = await Api.preflightProviderVMPowerBulk(this._hostId, resourceIds, action);
      if (!preflight.allowed) return this._showBlockedPreflight(preflight.plans, action);
      const force = preflight.plans.some(plan => plan.confirmation?.mode === 'typed_name');
      let confirmNames = null;
      if (force) confirmNames = await this._confirmBulkForce(preflight.plans, action);
      else {
        const confirmed = await Modal.confirm(this._preflightHtml(preflight.plans), {
          title: `${this._powerLabel(action)} ${preflight.count} VM(s)`, confirmText: this._powerLabel(action),
          html: true, width: '680px',
        });
        if (!confirmed) return;
      }
      if (force && !confirmNames) return;
      const idempotencyKey = this._idempotencyKey('vm-power-bulk');
      const body = {
        resourceIds, action, confirm: true,
        plans: Object.fromEntries(preflight.plans.map(plan => [plan.resource.id, plan.planHash])),
        ...(confirmNames ? { confirmNames } : {}),
      };
      const result = await this._withCriticalAuthorization(authorization =>
        Api.submitProviderVMPowerBulk(this._hostId, body, idempotencyKey, authorization));
      if (!result) return;
      this._selected.clear();
      Toast.success(`${result.count} VM power operation(s) queued`);
      location.hash = '#/activity';
    } catch (err) { Toast.error(err.message); }
  },

  async _editActionSchedule(host, vm, existing = null) {
    const value = existing || {
      name: 'weekday-start', action: 'start', cron: '0 7 * * 1-5', timezone: 'Europe/Bucharest',
      dstPolicy: 'first', mode: 'dry_run', enabled: false, failureThreshold: 3,
      holidays: [], blackoutWindows: [], snapshot: { consistency: 'crash', namePrefix: 'dd-scheduled', description: '' },
      environment: 'production', scopeId: null,
    };
    const result = await Modal.form(`<div class="alert alert-info text-sm">Five-field cron is evaluated in the selected IANA timezone. New schedules are disabled dry-runs; execute mode always reuses live provider preflight.</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px">
        <label class="form-label">Name<input id="vm-action-schedule-name" class="form-control" maxlength="80" value="${Utils.escapeHtml(value.name)}"></label>
        <label class="form-label">Action<select id="vm-action-schedule-action" class="form-control">${[['start','Start'],['stop','Stop (guest shutdown)'],['reboot','Reboot'],['snapshot','Create snapshot']].map(([key,label]) => `<option value="${key}"${value.action === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="form-label">Cron<input id="vm-action-schedule-cron" class="form-control" maxlength="100" value="${Utils.escapeHtml(value.cron)}" placeholder="0 7 * * 1-5"></label>
        <label class="form-label">IANA timezone<input id="vm-action-schedule-timezone" class="form-control" maxlength="100" value="${Utils.escapeHtml(value.timezone)}" placeholder="Europe/Bucharest"></label>
        <label class="form-label">DST ambiguity<select id="vm-action-schedule-dst" class="form-control"><option value="first"${value.dstPolicy === 'first' ? ' selected' : ''}>First occurrence</option><option value="second"${value.dstPolicy === 'second' ? ' selected' : ''}>Second occurrence</option><option value="skip"${value.dstPolicy === 'skip' ? ' selected' : ''}>Skip ambiguous minute</option></select></label>
        <label class="form-label">Mode<select id="vm-action-schedule-mode" class="form-control"><option value="dry_run"${value.mode === 'dry_run' ? ' selected' : ''}>Dry run</option><option value="execute"${value.mode === 'execute' ? ' selected' : ''}>Execute</option></select></label>
        <label class="form-label">Environment<select id="vm-action-schedule-environment" class="form-control"><option value="production"${value.environment === 'production' ? ' selected' : ''}>Production</option><option value="nonproduction"${value.environment === 'nonproduction' ? ' selected' : ''}>Non-production</option></select></label>
        <label class="form-label">Disable after failures<input id="vm-action-schedule-failures" class="form-control" type="number" min="1" max="20" value="${value.failureThreshold}"></label>
        <label class="form-label" style="grid-column:1/-1">Holiday dates (comma-separated)<input id="vm-action-schedule-holidays" class="form-control" value="${Utils.escapeHtml((value.holidays || []).join(', '))}" placeholder="2026-12-25, 2027-01-01"></label>
        <label class="form-label">Snapshot prefix<input id="vm-action-schedule-prefix" class="form-control" maxlength="48" value="${Utils.escapeHtml(value.snapshot?.namePrefix || 'dd-scheduled')}"></label>
        <label class="form-label">Snapshot consistency<select id="vm-action-schedule-consistency" class="form-control"><option value="crash"${value.snapshot?.consistency === 'crash' ? ' selected' : ''}>Crash</option><option value="quiesced"${value.snapshot?.consistency === 'quiesced' ? ' selected' : ''}>Quiesced</option></select></label>
        <label class="form-label" style="grid-column:1/-1">Recurring blackout windows (JSON array)<textarea id="vm-action-schedule-blackouts" class="form-control" rows="4" spellcheck="false">${Utils.escapeHtml(JSON.stringify(value.blackoutWindows || [], null, 2))}</textarea></label>
        <label class="form-label" style="display:flex;align-items:center;gap:8px"><input id="vm-action-schedule-enabled" type="checkbox" ${value.enabled ? 'checked' : ''}> Enabled</label>
      </div>
      <div class="alert alert-warning text-sm" style="margin-top:12px">Stop is a graceful guest shutdown, never forced power-off. Scheduled snapshots do not imply backup or retention.</div>`, {
      title: `${existing ? 'Edit' : 'Create'} VM action schedule`, submitLabel: existing ? 'Save schedule' : 'Create schedule', width: '760px',
      onSubmit: root => {
        let blackoutWindows;
        try { blackoutWindows = JSON.parse(root.querySelector('#vm-action-schedule-blackouts').value || '[]'); }
        catch { Toast.error('Blackout windows must be valid JSON'); return false; }
        if (!Array.isArray(blackoutWindows)) { Toast.error('Blackout windows must be a JSON array'); return false; }
        return {
          ...(existing ? { version: existing.version } : {}),
          name: root.querySelector('#vm-action-schedule-name').value.trim(),
          action: root.querySelector('#vm-action-schedule-action').value,
          cron: root.querySelector('#vm-action-schedule-cron').value.trim(),
          timezone: root.querySelector('#vm-action-schedule-timezone').value.trim(),
          dstPolicy: root.querySelector('#vm-action-schedule-dst').value,
          mode: root.querySelector('#vm-action-schedule-mode').value,
          environment: root.querySelector('#vm-action-schedule-environment').value,
          failureThreshold: Number(root.querySelector('#vm-action-schedule-failures').value),
          enabled: root.querySelector('#vm-action-schedule-enabled').checked,
          holidays: root.querySelector('#vm-action-schedule-holidays').value.split(',').map(item => item.trim()).filter(Boolean),
          blackoutWindows,
          snapshot: { namePrefix: root.querySelector('#vm-action-schedule-prefix').value.trim(),
            consistency: root.querySelector('#vm-action-schedule-consistency').value },
        };
      },
    });
    if (!result) return false;
    if (result.enabled && result.mode === 'execute') {
      const confirmed = await Modal.confirm(`Authorize scheduled ${Utils.escapeHtml(result.action)} operations for <strong>${Utils.escapeHtml(vm.displayName)}</strong>? Provider preflight and blackout checks still run for every slot.`, {
        title: 'Authorize scheduled execution', confirmText: 'Enable execution', danger: true,
        typeToConfirm: vm.displayName, html: true,
      });
      if (!confirmed) return false;
      result.confirm = true; result.confirmName = vm.displayName;
    }
    try {
      if (existing) await Api.updateProviderVMActionSchedule(host.id, vm.id, existing.id, result);
      else await Api.createProviderVMActionSchedule(host.id, vm.id, result);
      Toast.success(`Action schedule ${existing ? 'updated' : 'created'}`); return true;
    } catch (error) { Toast.error(error.message); return false; }
  },

  async _showActionScheduleRuns(host, vm, schedule) {
    try {
      const history = await Api.getProviderVMActionScheduleRuns(host.id, vm.id, schedule.id, 50);
      const rows = (history.items || []).map(run => `<tr><td>${Utils.escapeHtml(Utils.formatDate(run.scheduledFor))}<div class="text-muted text-sm">${Utils.escapeHtml(run.localTime)} ${Utils.escapeHtml(schedule.timezone)}</div></td>
        <td>${Utils.escapeHtml(run.trigger)}</td><td><span class="badge ${Utils.statusBadgeClass(run.state)}">${Utils.escapeHtml(run.state)}</span><div class="text-muted text-sm">${Utils.escapeHtml(run.decision)}</div></td>
        <td>${run.reason ? `<code>${Utils.escapeHtml(run.reason.code)}</code><div class="text-muted text-sm">${Utils.escapeHtml(run.reason.message)}</div>` : '—'}</td>
        <td>${run.operationId ? `<a href="#/activity/${Utils.escapeHtml(run.operationId)}"><code>${Utils.escapeHtml(run.operationId)}</code></a>` : '—'}</td></tr>`).join('');
      await Modal.confirm(`<div style="overflow:auto"><table class="data-table"><thead><tr><th>Scheduled / local</th><th>Trigger</th><th>Outcome</th><th>Reason</th><th>Operation</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="text-muted">No run evidence yet.</td></tr>'}</tbody></table></div>`, {
        title: `${schedule.name} history`, confirmText: 'Close', html: true, width: '900px',
      });
    } catch (error) { Toast.error(error.message); }
  },

  async _loadActionSchedules(root, host, vm) {
    if (!root) return;
    root.innerHTML = '<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin"></i> Loading action schedules…</div>';
    try {
      const envelope = await Api.getProviderVMActionSchedules(host.id, vm.id);
      const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
      const rows = (envelope.items || []).map(schedule => `<tr><td><strong>${Utils.escapeHtml(schedule.name)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(schedule.cron)} · ${Utils.escapeHtml(schedule.timezone)} · DST ${Utils.escapeHtml(schedule.dstPolicy)}</div></td>
        <td>${Utils.escapeHtml(schedule.action)}</td><td><span class="badge ${schedule.enabled ? (schedule.mode === 'execute' ? 'badge-warning' : 'badge-info') : 'badge-secondary'}">${schedule.enabled ? Utils.escapeHtml(schedule.mode) : 'disabled'}</span></td>
        <td>${schedule.consecutiveFailures}/${schedule.failureThreshold}</td><td>${schedule.lastRunStatus ? `<span class="badge ${Utils.statusBadgeClass(schedule.lastRunStatus)}">${Utils.escapeHtml(schedule.lastRunStatus)}</span>` : '—'}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm btn-secondary" data-action-schedule-history="${schedule.id}">History</button>${admin ? `<button class="btn btn-sm btn-secondary" data-action-schedule-run="${schedule.id}">Run now</button><button class="btn btn-sm btn-secondary" data-action-schedule-edit="${schedule.id}">Edit</button><button class="btn btn-sm btn-danger" data-action-schedule-delete="${schedule.id}">Delete</button>` : ''}</td></tr>`).join('');
      root.innerHTML = `<div class="card" style="padding:16px;margin-top:16px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><h3 style="margin:0"><i class="fas fa-clock"></i> Scheduled VM actions</h3><div class="text-muted text-sm">Durable local-time cron · DST policy · blackout-aware provider preflight</div></div>${admin ? '<button class="btn btn-sm btn-primary" id="vm-action-schedule-create"><i class="fas fa-plus"></i> Add schedule</button>' : ''}</div>
        ${!envelope.automation.executeEnabled ? '<div class="alert alert-warning text-sm" style="margin-top:12px">Execute automation is disabled by release policy. Dry-run schedules and previews remain available.</div>' : ''}
        <div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Schedule</th><th>Action</th><th>Mode</th><th>Failures</th><th>Last outcome</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="text-muted">No action schedules configured.</td></tr>'}</tbody></table></div></div>`;
      const reload = () => this._loadActionSchedules(root, host, vm);
      root.querySelector('#vm-action-schedule-create')?.addEventListener('click', async () => { if (await this._editActionSchedule(host, vm)) reload(); });
      root.querySelectorAll('[data-action-schedule-history]').forEach(button => button.addEventListener('click', () => {
        const schedule = envelope.items.find(item => item.id === button.dataset.actionScheduleHistory);
        if (schedule) this._showActionScheduleRuns(host, vm, schedule);
      }));
      root.querySelectorAll('[data-action-schedule-edit]').forEach(button => button.addEventListener('click', async () => {
        const schedule = envelope.items.find(item => item.id === button.dataset.actionScheduleEdit);
        if (schedule && await this._editActionSchedule(host, vm, schedule)) reload();
      }));
      root.querySelectorAll('[data-action-schedule-run]').forEach(button => button.addEventListener('click', async () => {
        const schedule = envelope.items.find(item => item.id === button.dataset.actionScheduleRun); if (!schedule) return;
        const execute = schedule.mode === 'execute';
        const confirmed = await Modal.confirm(execute ? `Run ${Utils.escapeHtml(schedule.action)} now?` : 'Record a live dry-run preview now?', {
          title: `Run ${schedule.name}`, confirmText: execute ? 'Run schedule' : 'Run dry-run', danger: execute,
          typeToConfirm: execute ? vm.displayName : null,
        });
        if (!confirmed) return;
        try {
          const result = await Api.runProviderVMActionSchedule(host.id, vm.id, schedule.id,
            execute ? { confirm: true, confirmName: vm.displayName } : {});
          Toast.success(`Schedule run ${result.run?.state || 'recorded'}`);
          if (result.run?.operationId) location.hash = `#/activity/${result.run.operationId}`; else reload();
        } catch (error) { Toast.error(error.message); }
      }));
      root.querySelectorAll('[data-action-schedule-delete]').forEach(button => button.addEventListener('click', async () => {
        const schedule = envelope.items.find(item => item.id === button.dataset.actionScheduleDelete); if (!schedule) return;
        const confirmed = await Modal.confirm(`Delete schedule ${Utils.escapeHtml(schedule.name)}? Run evidence is retained until the schedule record is purged.`, {
          title: 'Delete VM action schedule', confirmText: 'Delete schedule', danger: true,
        });
        if (!confirmed) return;
        try { await Api.deleteProviderVMActionSchedule(host.id, vm.id, schedule.id); Toast.success('Action schedule deleted'); reload(); }
        catch (error) { Toast.error(error.message); }
      }));
    } catch (error) { root.innerHTML = `<div class="alert alert-danger text-sm">${Utils.escapeHtml(error.message)}</div>`; }
  },

  _snapshotPlanHtml(plan) {
    const blockers = plan.blockers || [];
    const warnings = plan.warnings || [];
    return `<div class="text-sm">
      <div class="alert alert-warning" style="margin-bottom:12px"><strong>Snapshot is not backup</strong><div>${Utils.escapeHtml(plan.protection?.warning || 'A snapshot shares the provider storage failure domain.')}</div></div>
      ${blockers.length ? `<div class="alert alert-danger"><strong>Operation blocked</strong><ul style="margin:8px 0 0 18px">${blockers.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="card" style="padding:12px;margin-top:12px">
        <div><strong>VM:</strong> ${Utils.escapeHtml(plan.vm.displayName)}</div>
        <div><strong>Action:</strong> ${Utils.escapeHtml(plan.action)}</div>
        <div><strong>Snapshot:</strong> ${Utils.escapeHtml(plan.snapshot?.name || plan.name || '—')}</div>
        ${plan.consistency ? `<div><strong>Consistency:</strong> ${Utils.escapeHtml(plan.consistency)}</div>` : ''}
      </div>
      ${warnings.filter(item => item.type !== 'NOT_A_BACKUP').length ? `<ul style="margin:12px 0 0 18px">${warnings.filter(item => item.type !== 'NOT_A_BACKUP').map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul>` : ''}
    </div>`;
  },

  async _runSnapshotCreate(host, vm) {
    const input = await Modal.form(`
      <label class="form-label" for="vm-snapshot-name">Portable snapshot name</label>
      <input id="vm-snapshot-name" class="form-control" maxlength="80" placeholder="before-upgrade" autocomplete="off">
      <label class="form-label" for="vm-snapshot-description" style="margin-top:12px">Description</label>
      <textarea id="vm-snapshot-description" class="form-control" maxlength="1000" rows="3"></textarea>
      <label class="form-label" for="vm-snapshot-consistency" style="margin-top:12px">Consistency</label>
      <select id="vm-snapshot-consistency" class="form-control"><option value="crash">Crash-consistent</option><option value="quiesced">Quiesced (requires provider + guest tools)</option></select>
      <div class="alert alert-warning text-sm" style="margin-top:14px">This snapshot stays in the provider storage failure domain. It is not an independent backup.</div>`, {
      title: `Create snapshot · ${vm.displayName}`, submitLabel: 'Review preflight',
      onSubmit: root => {
        const name = root.querySelector('#vm-snapshot-name').value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
          Toast.error('Use 1-80 letters, numbers, dot, underscore or hyphen'); return false;
        }
        return { name, description: root.querySelector('#vm-snapshot-description').value.trim(), consistency: root.querySelector('#vm-snapshot-consistency').value };
      },
    });
    if (!input) return;
    try {
      const plan = await Api.preflightProviderVMSnapshotCreate(host.id, vm.id, input);
      if (!plan.allowed) {
        await Modal.confirm(this._snapshotPlanHtml(plan), { title: 'Snapshot preflight', confirmText: 'Close', html: true, width: '640px' });
        return;
      }
      const confirmed = await Modal.confirm(this._snapshotPlanHtml(plan), {
        title: `Create snapshot ${plan.name}`, confirmText: 'Create snapshot', html: true, width: '640px',
      });
      if (!confirmed) return;
      const result = await Api.submitProviderVMSnapshotCreate(host.id, vm.id, {
        ...input, planHash: plan.planHash, confirm: true,
      }, this._idempotencyKey('vm-snapshot-create'));
      Toast.success(`Snapshot ${plan.name} queued`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
  },

  async _runSnapshotAction(host, vm, snapshot, action) {
    try {
      const plan = await Api.preflightProviderVMSnapshotAction(host.id, vm.id, snapshot.id, action);
      if (!plan.allowed) {
        await Modal.confirm(this._snapshotPlanHtml(plan), { title: 'Snapshot preflight', confirmText: 'Close', html: true, width: '640px' });
        return;
      }
      const confirmed = await Modal.confirm(this._snapshotPlanHtml(plan), {
        title: `${action === 'revert' ? 'Revert to' : 'Delete'} ${snapshot.name}`,
        confirmText: action === 'revert' ? 'Revert VM' : 'Delete snapshot', danger: true,
        typeToConfirm: plan.confirmation.expected, html: true, width: '640px',
      });
      if (!confirmed) return;
      const idempotencyKey = this._idempotencyKey(`vm-snapshot-${action}`);
      const body = {
        planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      };
      const result = await this._withCriticalAuthorization(authorization =>
        Api.submitProviderVMSnapshotAction(host.id, vm.id, snapshot.id, action,
          body, idempotencyKey, authorization));
      if (!result) return;
      Toast.success(`Snapshot ${action} queued`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
  },

  async _runSnapshotConsolidation(host, vm) {
    try {
      const plan = await Api.preflightProviderVMSnapshotConsolidation(host.id, vm.id);
      if (!plan.allowed) {
        await Modal.confirm(this._snapshotPlanHtml(plan), { title: 'Snapshot consolidation preflight', confirmText: 'Close', html: true, width: '640px' });
        return;
      }
      const confirmed = await Modal.confirm(this._snapshotPlanHtml(plan), {
        title: `Consolidate snapshot disks · ${vm.displayName}`, confirmText: 'Consolidate disks', danger: true,
        typeToConfirm: plan.confirmation.expected, html: true, width: '640px',
      });
      if (!confirmed) return;
      const result = await Api.submitProviderVMSnapshotConsolidation(host.id, vm.id, {
        planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      }, this._idempotencyKey('vm-snapshot-consolidate'));
      Toast.success('Snapshot disk consolidation queued');
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
  },

  _snapshotPolicyDraft(root) {
    return {
      enabled: root.querySelector('#snapshot-policy-enabled').checked,
      mode: root.querySelector('#snapshot-policy-mode').value,
      frequency: root.querySelector('#snapshot-policy-frequency').value,
      minute: Number(root.querySelector('#snapshot-policy-minute').value),
      hour: Number(root.querySelector('#snapshot-policy-hour').value),
      weekday: Number(root.querySelector('#snapshot-policy-weekday').value),
      consistency: root.querySelector('#snapshot-policy-consistency').value,
      namePrefix: root.querySelector('#snapshot-policy-prefix').value.trim(),
      description: root.querySelector('#snapshot-policy-description').value.trim(),
      retainCount: Number(root.querySelector('#snapshot-policy-retain').value),
      maxAgeDays: root.querySelector('#snapshot-policy-age').value === '' ? null : Number(root.querySelector('#snapshot-policy-age').value),
      maxDeletesPerRun: Number(root.querySelector('#snapshot-policy-deletes').value),
    };
  },

  _snapshotPolicyPlanHtml(plan) {
    return `<div class="text-sm">
      <div class="alert alert-warning"><strong>Retention is not backup.</strong> ${Utils.escapeHtml(plan.protection?.warning || '')}</div>
      <div class="card" style="padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
        <div><strong>Next snapshot</strong><br>${Utils.escapeHtml(plan.create.name)}</div>
        <div><strong>Consistency</strong><br>${Utils.escapeHtml(plan.create.consistency)}</div>
        <div><strong>Managed snapshots</strong><br>${plan.retention.managedCount}</div>
        <div><strong>Delete candidates</strong><br>${plan.retention.candidates.length}</div>
      </div>
      ${plan.retention.candidates.length ? `<div style="margin-top:12px"><strong>Leaf snapshots eligible after create succeeds</strong><ul style="margin:6px 0 0 18px">${plan.retention.candidates.map(item => `<li>${Utils.escapeHtml(item.name)} · ${Utils.escapeHtml(item.createdAt || 'unknown')}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  },

  async _loadSnapshotPolicy(root, host, vm) {
    if (!root) return;
    root.innerHTML = '<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin"></i> Loading snapshot policy…</div>';
    try {
      const [envelope, history] = await Promise.all([
        Api.getProviderVMSnapshotPolicy(host.id, vm.id),
        Api.getProviderVMSnapshotPolicyRuns(host.id, vm.id, 10),
      ]);
      const policy = envelope.policy;
      const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
      const value = policy || {
        enabled: false, mode: 'dry_run', consistency: 'crash', namePrefix: 'dd-auto', description: '',
        retainCount: 3, maxAgeDays: 3, maxDeletesPerRun: 2,
        schedule: { frequency: 'daily', minute: 15, hour: 2, weekday: 0, timezone: 'UTC' },
      };
      const runRows = (history.items || []).slice(0, 5).map(run => `<tr><td>${Utils.escapeHtml(run.createdAt)}</td><td>${Utils.escapeHtml(run.trigger)}</td><td><span class="badge ${Utils.statusBadgeClass(run.state)}">${Utils.escapeHtml(run.state)}</span></td><td>${run.currentOperationId ? `<a href="#/activity/${run.currentOperationId}"><code>${Utils.escapeHtml(run.currentOperationId)}</code></a>` : '—'}</td></tr>`).join('');
      root.innerHTML = `<div class="card" style="padding:16px;margin-top:16px">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><strong><i class="fas fa-calendar-alt"></i> Snapshot policy</strong><div class="text-muted text-sm">Portable UTC schedule · managed-prefix retention · durable child operations</div></div>
        <span class="badge ${value.enabled ? 'badge-success' : 'badge-secondary'}">${value.enabled ? Utils.escapeHtml(value.mode) : 'disabled'}</span></div>
        ${!envelope.automation.executeEnabled ? '<div class="alert alert-warning text-sm" style="margin-top:12px">Execute automation is disabled by release policy. Dry-run preview remains available.</div>' : ''}
        ${admin ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-top:14px">
          <label class="form-label">Enabled<label class="toggle" style="display:block;margin-top:7px"><input type="checkbox" id="snapshot-policy-enabled" ${value.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label></label>
          <label class="form-label">Mode<select class="form-control" id="snapshot-policy-mode"><option value="dry_run"${value.mode === 'dry_run' ? ' selected' : ''}>Dry run</option><option value="execute"${value.mode === 'execute' ? ' selected' : ''}>Execute</option></select></label>
          <label class="form-label">Frequency<select class="form-control" id="snapshot-policy-frequency"><option value="hourly"${value.schedule.frequency === 'hourly' ? ' selected' : ''}>Hourly</option><option value="daily"${value.schedule.frequency === 'daily' ? ' selected' : ''}>Daily</option><option value="weekly"${value.schedule.frequency === 'weekly' ? ' selected' : ''}>Weekly</option></select></label>
          <label class="form-label">Minute (UTC)<select class="form-control" id="snapshot-policy-minute">${[0, 15, 30, 45].map(item => `<option value="${item}"${value.schedule.minute === item ? ' selected' : ''}>:${String(item).padStart(2, '0')}</option>`).join('')}</select></label>
          <label class="form-label">Hour (UTC)<input class="form-control" id="snapshot-policy-hour" type="number" min="0" max="23" value="${value.schedule.hour}"></label>
          <label class="form-label">Weekday<select class="form-control" id="snapshot-policy-weekday">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((item, index) => `<option value="${index}"${value.schedule.weekday === index ? ' selected' : ''}>${item}</option>`).join('')}</select></label>
          <label class="form-label">Consistency<select class="form-control" id="snapshot-policy-consistency"><option value="crash"${value.consistency === 'crash' ? ' selected' : ''}>Crash</option><option value="quiesced"${value.consistency === 'quiesced' ? ' selected' : ''}>Quiesced</option></select></label>
          <label class="form-label">Managed prefix<input class="form-control" id="snapshot-policy-prefix" maxlength="48" value="${Utils.escapeHtml(value.namePrefix)}"></label>
          <label class="form-label">Retain newest<input class="form-control" id="snapshot-policy-retain" type="number" min="1" max="32" value="${value.retainCount}"></label>
          <label class="form-label">Max age days<input class="form-control" id="snapshot-policy-age" type="number" min="1" max="3650" value="${value.maxAgeDays ?? ''}" placeholder="disabled"></label>
          <label class="form-label">Max deletes/run<input class="form-control" id="snapshot-policy-deletes" type="number" min="1" max="20" value="${value.maxDeletesPerRun}"></label>
          <label class="form-label" style="grid-column:1/-1">Description<input class="form-control" id="snapshot-policy-description" maxlength="500" value="${Utils.escapeHtml(value.description || '')}"></label>
        </div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn btn-sm btn-primary" id="snapshot-policy-save"><i class="fas fa-save"></i> Save policy</button><button class="btn btn-sm btn-secondary" id="snapshot-policy-preview"><i class="fas fa-eye"></i> Preview</button>${policy ? '<button class="btn btn-sm btn-secondary" id="snapshot-policy-run"><i class="fas fa-play"></i> Run now</button><button class="btn btn-sm btn-danger" id="snapshot-policy-delete"><i class="fas fa-trash"></i> Delete</button>' : ''}</div>` : `<div class="text-sm" style="margin-top:12px">${policy ? `${Utils.escapeHtml(value.schedule.cron)} UTC · keep ${value.retainCount} · prefix ${Utils.escapeHtml(value.namePrefix)}` : 'No policy configured.'}</div>`}
        ${runRows ? `<div style="overflow:auto;margin-top:14px"><table class="data-table"><thead><tr><th>Created</th><th>Trigger</th><th>State</th><th>Operation</th></tr></thead><tbody>${runRows}</tbody></table></div>` : ''}
      </div>`;
      if (!admin) return;
      const draft = () => this._snapshotPolicyDraft(root);
      root.querySelector('#snapshot-policy-preview').addEventListener('click', async () => {
        try {
          const plan = await Api.previewProviderVMSnapshotPolicy(host.id, vm.id, draft());
          await Modal.confirm(this._snapshotPolicyPlanHtml(plan), { title: 'Snapshot policy preview', confirmText: 'Close', html: true, width: '680px' });
        } catch (err) { Toast.error(err.message); }
      });
      root.querySelector('#snapshot-policy-save').addEventListener('click', async () => {
        try {
          const body = draft();
          if (body.enabled && body.mode === 'execute') {
            const confirmed = await Modal.confirm('Enable automatic snapshot create and managed-prefix leaf deletion?', {
              title: 'Authorize snapshot automation', confirmText: 'Enable automation', danger: true, typeToConfirm: vm.displayName,
            });
            if (!confirmed) return;
            body.confirm = true; body.confirmName = vm.displayName;
          }
          await Api.saveProviderVMSnapshotPolicy(host.id, vm.id, body);
          Toast.success('Snapshot policy saved'); await this._loadSnapshotPolicy(root, host, vm);
        } catch (err) { Toast.error(err.message); }
      });
      root.querySelector('#snapshot-policy-run')?.addEventListener('click', async () => {
        try {
          const execute = value.mode === 'execute';
          const confirmed = await Modal.confirm(execute ? 'Run the snapshot policy now?' : 'Record a live dry-run preview now?', {
            title: 'Run snapshot policy', confirmText: execute ? 'Run policy' : 'Run dry-run', danger: execute,
            typeToConfirm: execute ? vm.displayName : null,
          });
          if (!confirmed) return;
          const result = await Api.runProviderVMSnapshotPolicy(host.id, vm.id, {
            confirm: execute, ...(execute ? { confirmName: vm.displayName } : {}),
          });
          Toast.success(`Policy run ${result.run.state}`);
          if (result.run.currentOperationId) location.hash = `#/activity/${result.run.currentOperationId}`;
          else await this._loadSnapshotPolicy(root, host, vm);
        } catch (err) { Toast.error(err.message); }
      });
      root.querySelector('#snapshot-policy-delete')?.addEventListener('click', async () => {
        const confirmed = await Modal.confirm('Delete this policy? Existing snapshots and operation history are not modified.', {
          title: 'Delete snapshot policy', confirmText: 'Delete policy', danger: true,
        });
        if (!confirmed) return;
        try { await Api.deleteProviderVMSnapshotPolicy(host.id, vm.id); Toast.success('Snapshot policy deleted'); await this._loadSnapshotPolicy(root, host, vm); }
        catch (err) { Toast.error(err.message); }
      });
    } catch (err) {
      root.innerHTML = `<div class="alert alert-danger text-sm">${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _mountSnapshots(panel, section, host, vm) {
    if (!section.available) {
      panel.innerHTML = `<div class="empty-msg"><i class="fas fa-ban"></i>${Utils.escapeHtml(section.reason || 'Snapshots unavailable')}</div>`;
      return;
    }
    const items = section.items || [];
    panel.innerHTML = `<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-sm btn-primary" id="common-snapshot-create"><i class="fas fa-camera"></i> Create snapshot</button>
      ${section.providerState?.consolidationNeeded ? '<button class="btn btn-sm btn-warning" id="common-snapshot-consolidate"><i class="fas fa-layer-group"></i> Consolidate disks</button>' : ''}
      <button class="btn btn-sm btn-secondary" id="common-snapshot-refresh"><i class="fas fa-sync"></i> Refresh</button>
    </div>
    <div class="alert alert-warning text-sm"><strong>Snapshots are not backups.</strong> They share the VM/provider storage failure domain.</div>
    ${items.length ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Name</th><th>Created</th><th>Consistency</th><th>Integrity</th><th>Children</th><th>Actions</th></tr></thead><tbody>${items.map(item => `<tr>
      <td><strong>${Utils.escapeHtml(item.name)}</strong>${item.isCurrent ? ' <span class="badge badge-info">current</span>' : ''}</td>
      <td>${Utils.escapeHtml(item.createdAt ? Utils.formatDate(item.createdAt) : '—')}</td><td>${Utils.escapeHtml(item.consistency)}</td>
      <td><span class="badge ${item.integrity?.state === 'valid' ? 'badge-success' : 'badge-warning'}">${Utils.escapeHtml(item.integrity?.state || 'unknown')}</span></td>
      <td>${item.childCount || 0}</td><td style="display:flex;gap:6px"><button class="btn btn-sm btn-secondary" data-snapshot-action="revert" data-snapshot-id="${item.id}">Revert</button><button class="btn btn-sm btn-danger" data-snapshot-action="delete" data-snapshot-id="${item.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-msg"><i class="fas fa-camera"></i>No snapshots are currently visible.</div>'}
    <div id="common-snapshot-policy"></div>`;
    panel.querySelector('#common-snapshot-create').addEventListener('click', () => this._runSnapshotCreate(host, vm));
    panel.querySelector('#common-snapshot-consolidate')?.addEventListener('click', () => this._runSnapshotConsolidation(host, vm));
    panel.querySelector('#common-snapshot-refresh').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        const inventory = await Api.getProviderVMSnapshots(host.id, vm.id);
        this._mountSnapshots(panel, { available: true, items: inventory.items, providerState: inventory.providerState }, host, vm);
      } catch (err) { Toast.error(err.message); event.currentTarget.disabled = false; }
    });
    panel.querySelectorAll('[data-snapshot-action]').forEach(button => button.addEventListener('click', () => {
      const snapshot = items.find(item => item.id === button.dataset.snapshotId);
      if (snapshot) this._runSnapshotAction(host, vm, snapshot, button.dataset.snapshotAction);
    }));
    this._loadSnapshotPolicy(panel.querySelector('#common-snapshot-policy'), host, vm);
  },

  _maintenanceRunHtml(run) {
    const counts = run.counts || {};
    const items = (run.items || []).map(item => `<tr>
      <td>${Utils.escapeHtml(item.vm.displayName)}</td><td>${Utils.escapeHtml(item.target?.displayName || 'Deferred')}</td>
      <td>${Utils.escapeHtml(item.mode || '—')}</td><td><span class="badge ${Utils.statusBadgeClass(item.state)}">${Utils.escapeHtml(item.state)}</span></td>
      <td>${item.operationId ? `<a href="#/activity/${Utils.escapeHtml(item.operationId)}"><code>${Utils.escapeHtml(item.operationId)}</code></a>` : '—'}</td>
    </tr>`).join('');
    return `<div class="text-sm"><div class="card" style="padding:12px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px">
      <div><strong>Host</strong><br>${Utils.escapeHtml(run.sourceHost.displayName)}</div>
      <div><strong>Goal / state</strong><br>${Utils.escapeHtml(run.goal)} · <span class="badge ${Utils.statusBadgeClass(run.state)}">${Utils.escapeHtml(run.state)}</span></div>
      <div><strong>Wave size</strong><br>${Utils.escapeHtml(run.waveSize)}</div>
      <div><strong>Succeeded</strong><br>${Utils.escapeHtml(counts.succeeded || 0)}</div>
      <div><strong>Active</strong><br>${Utils.escapeHtml(counts.submitted || 0)}</div>
      <div><strong>Attention</strong><br>${Utils.escapeHtml((counts.deferred || 0) + (counts.failed || 0) + (counts.unknown || 0))}</div></div>
      ${run.error ? `<div class="alert alert-warning" style="margin-top:12px">${Utils.escapeHtml(run.error.message || run.error.code)}</div>` : ''}
      ${items ? `<div class="card" style="overflow:auto;margin-top:12px;max-height:360px"><table class="data-table"><thead><tr><th>VM</th><th>Target</th><th>Mode</th><th>State</th><th>Operation</th></tr></thead><tbody>${items}</tbody></table></div>` : ''}
      <div class="text-muted" style="margin-top:10px">Pause, cancel and exit never move completed migrations back.</div></div>`;
  },

  _maintenancePlanHtml(plan) {
    const items = (plan.items || []).map(item => `<tr>
      <td>${Utils.escapeHtml(item.vm.displayName)}<div class="text-muted text-sm">${Utils.escapeHtml(item.vm.powerState)}</div></td>
      <td>${Utils.escapeHtml(item.target?.displayName || 'No safe target')}</td><td>${Utils.escapeHtml(item.mode || '—')}</td>
      <td><span class="badge ${item.state === 'ready' ? 'badge-success' : 'badge-warning'}">${Utils.escapeHtml(item.state)}</span></td>
      <td>${Utils.escapeHtml(item.blockers?.[0]?.reason || 'Ready')}</td></tr>`).join('');
    return `<div class="text-sm">
      ${plan.blockers?.length ? `<div class="alert alert-danger"><strong>Plan blocked</strong><ul style="margin:8px 0 0 18px">${plan.blockers.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      ${plan.warnings?.length ? `<div class="alert alert-warning">${plan.warnings.map(item => `<div>${Utils.escapeHtml(item.reason)}</div>`).join('')}</div>` : ''}
      <div class="card" style="padding:12px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px">
        <div><strong>Source</strong><br>${Utils.escapeHtml(plan.sourceHost.displayName)}</div><div><strong>Goal</strong><br>${Utils.escapeHtml(plan.goal)}</div>
        <div><strong>Wave size</strong><br>${Utils.escapeHtml(plan.waveSize)}</div><div><strong>Workloads</strong><br>${Utils.escapeHtml(plan.itemCount)}</div>
        <div><strong>Ready</strong><br>${Utils.escapeHtml(plan.readyCount)}</div><div><strong>Deferred</strong><br>${Utils.escapeHtml(plan.deferredCount)}</div></div>
      ${items ? `<div class="card" style="overflow:auto;margin-top:12px;max-height:390px"><table class="data-table"><thead><tr><th>VM</th><th>Target</th><th>Mode</th><th>State</th><th>Evidence</th></tr></thead><tbody>${items}</tbody></table></div>` : '<div class="empty-msg"><i class="fas fa-check-circle"></i>The host is already empty.</div>'}
      <div class="alert alert-info" style="margin-top:12px">Preview does not reserve capacity. Every migration is revalidated and live inventory must prove the source is empty.</div></div>`;
  },

  async _planHostMaintenance(host) {
    try {
      const envelope = await Api.getProviderHosts(host.id, 64);
      if (!envelope.items?.length) return Toast.error('No provider hosts are visible');
      const input = await Modal.form(`<label class="form-label" for="maintenance-source">Source host</label>
        <select id="maintenance-source" class="form-control">${envelope.items.map(item => `<option value="${Utils.escapeHtml(item.id)}">${Utils.escapeHtml(item.displayName)} · ${Utils.escapeHtml(item.status?.powerState || 'unknown')}</option>`).join('')}</select>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px">
          <label class="form-label">Goal<select id="maintenance-goal" class="form-control"><option value="drain">Drain and reserve</option><option value="enter">Enter native maintenance</option></select></label>
          <label class="form-label">Wave size<input id="maintenance-wave" class="form-control" type="number" min="1" max="10" value="2"></label>
          <label class="form-label">Blocked workloads<select id="maintenance-policy" class="form-control"><option value="block">Block submission</option><option value="defer">Migrate ready, then pause</option></select></label></div>
        <div class="alert alert-warning text-sm" style="margin-top:14px">Submission can live-migrate production workloads and requires the exact host name.</div>`, {
        title: `Plan host maintenance · ${host.name}`, submitLabel: 'Generate plan', width: '720px',
        onSubmit: root => ({ sourceHostId: root.querySelector('#maintenance-source').value,
          goal: root.querySelector('#maintenance-goal').value, waveSize: Number(root.querySelector('#maintenance-wave').value),
          nonMigratablePolicy: root.querySelector('#maintenance-policy').value }),
      });
      if (!input) return;
      const plan = await Api.preflightProviderHostMaintenance(host.id, input);
      if (!plan.allowed) {
        await Modal.confirm(this._maintenancePlanHtml(plan), { title: 'Host maintenance preflight', confirmText: 'Close', html: true, width: '860px' }); return;
      }
      const confirmed = await Modal.confirm(this._maintenancePlanHtml(plan), {
        title: `Authorize ${plan.goal} · ${plan.sourceHost.displayName}`, confirmText: 'Start maintenance run',
        danger: true, typeToConfirm: plan.confirmation.expected, html: true, width: '860px',
      });
      if (!confirmed) return;
      const result = await Api.startProviderHostMaintenance(host.id, { ...input, planHash: plan.planHash,
        confirm: true, confirmName: plan.confirmation.expected }, this._idempotencyKey('host-maintenance'));
      Toast.success(`Maintenance run ${result.run.id} started`);
      await Modal.confirm(this._maintenanceRunHtml(result.run), { title: 'Host maintenance run', confirmText: 'Close', html: true, width: '860px' });
    } catch (err) { Toast.error(err.message); }
  },

  async _manageHostMaintenance(host) {
    try {
      const envelope = await Api.getProviderHostMaintenanceRuns(host.id, 50);
      if (!envelope.items?.length) {
        await Modal.confirm('<div class="empty-msg"><i class="fas fa-tools"></i>No host maintenance runs are recorded for this endpoint.</div>', { title: 'Host maintenance runs', confirmText: 'Close', html: true }); return;
      }
      const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
      const actionOptions = admin
        ? '<option value="view">View / refresh</option><option value="pause">Pause</option><option value="resume">Resume</option><option value="reconcile">Reconcile unknown native task</option><option value="cancel">Cancel remaining work</option><option value="exit">Exit and release reservation</option>'
        : '<option value="view">View / refresh</option>';
      const selected = await Modal.form(`<label class="form-label" for="maintenance-run">Run</label>
        <select id="maintenance-run" class="form-control">${envelope.items.map(run => `<option value="${Utils.escapeHtml(run.id)}">${Utils.escapeHtml(run.sourceHost.displayName)} · ${Utils.escapeHtml(run.goal)} · ${Utils.escapeHtml(run.state)} · ${Utils.escapeHtml(run.id)}</option>`).join('')}</select>
        <label class="form-label" style="margin-top:12px" for="maintenance-action">Action</label>
        <select id="maintenance-action" class="form-control">${actionOptions}</select>
        <div class="text-muted text-sm" style="margin-top:12px">Invalid transitions are rejected server-side. Cancel does not roll migrations back.</div>`, {
        title: `Host maintenance runs · ${host.name}`, submitLabel: 'Continue', width: '720px',
        onSubmit: root => ({ runId: root.querySelector('#maintenance-run').value, action: root.querySelector('#maintenance-action').value }),
      });
      if (!selected) return;
      let run;
      if (selected.action === 'view') run = await Api.getProviderHostMaintenanceRun(host.id, selected.runId);
      else {
        const ok = await Modal.confirm(selected.action === 'cancel' ? 'Cancel remaining migrations? Completed migrations stay on their targets.'
          : selected.action === 'exit' ? 'Exit maintenance and release the host reservation?'
            : `${selected.action[0].toUpperCase()}${selected.action.slice(1)} this run?`, {
          title: `${selected.action} maintenance run`, confirmText: selected.action, danger: ['cancel', 'exit'].includes(selected.action),
        });
        if (!ok) return;
        run = (await Api.controlProviderHostMaintenance(host.id, selected.runId, selected.action)).run;
      }
      await Modal.confirm(this._maintenanceRunHtml(run), { title: 'Host maintenance run', confirmText: 'Close', html: true, width: '860px' });
    } catch (err) { Toast.error(err.message); }
  },

  async render(container, params = {}) {
    this.destroy();
    try {
      this._hosts = ((await Api.getHosts()) || [])
        .filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType));
    } catch { this._hosts = []; }
    const route = this._parseRoute(params.id);
    if (route) return this._renderDetail(container, route);
    try { await this._reloadInventoryViews(); } catch { this._views = []; }
    const defaultView = this._views.find(view => view.isDefault) || null;
    this._activeViewId = defaultView?.id || null;
    this._viewState = this._stateFromView(defaultView);
    if (this._viewState.providerHostId && !this._hosts.some(host => host.id === this._viewState.providerHostId)) {
      this._viewState.providerHostId = null;
    }
    return this._renderHome(container);
  },

  async _renderHome(container) {
    if (!this._hosts.length) {
      container.innerHTML = `<div class="page-header"><h1><i class="fas fa-desktop"></i> ${i18n.t('nav.virtual-machines')}</h1></div>
        <div class="empty-msg"><i class="fas fa-desktop"></i>No supported virtualization endpoint is available.<br>
        Add Proxmox, vSphere, or Xen from <a href="#/hosts">Hosts</a>.</div>`;
      return;
    }
    this._selected.clear();
    const selected = this._viewState?.providerHostId || Api.getHostId();
    if (this._hosts.some(host => host.id === selected)) this._hostId = selected;
    if (!this._hosts.some(host => host.id === this._hostId)) this._hostId = this._hosts[0].id;
    if (!this._viewState) this._viewState = this._defaultViewState();
    this._viewState.providerHostId = this._hostId;
    const host = this._hosts.find(item => item.id === this._hostId);
    const activeView = this._views.find(view => view.id === this._activeViewId) || null;
    const columns = new Set(this._viewState.columns || this._defaultViewState().columns);
    container.innerHTML = `
      <div class="page-header">
        <div><h1><i class="fas fa-desktop"></i> ${i18n.t('nav.virtual-machines')}</h1>
          <div class="text-muted text-sm">Unified, provider-neutral inventory</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="common-vm-host" class="form-control" style="width:auto">
            ${this._hosts.map(item => `<option value="${item.id}"${item.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(item.name)} · ${Utils.escapeHtml(this._providerLabel(item.daemonType))}</option>`).join('')}
          </select>
          <a class="btn btn-sm btn-secondary" href="${this._providerRoute(host.daemonType)}"><i class="fas fa-external-link-alt"></i> Provider view</a>
          <button class="btn btn-sm btn-secondary" id="common-host-maintenance-runs"><i class="fas fa-tools"></i> Maintenance runs</button>
          ${App.user?.role === 'admin' || (App.user?.roles || []).includes('admin') ? '<button class="btn btn-sm btn-secondary" id="common-host-maintenance-plan"><i class="fas fa-server"></i> Plan maintenance</button>' : ''}
          <a class="btn btn-sm btn-secondary" href="#/activity"><i class="fas fa-tasks"></i> Activity</a>
          <button class="btn btn-sm btn-secondary" id="common-vm-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div class="card" style="padding:12px;margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="common-vm-view" class="form-control" style="width:auto;max-width:260px" aria-label="Saved inventory view">
          <option value="">Built-in view</option>
          ${this._views.map(view => `<option value="${view.id}"${view.id === this._activeViewId ? ' selected' : ''}>${Utils.escapeHtml(view.name)}${view.isDefault ? ' · default' : ''}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-secondary" id="common-vm-view-save"><i class="fas fa-bookmark"></i> Save as</button>
        <button class="btn btn-sm btn-secondary" id="common-vm-view-update"${activeView ? '' : ' disabled'}><i class="fas fa-save"></i> Update</button>
        <button class="btn btn-sm btn-secondary" id="common-vm-view-default"${activeView || this._activeViewId ? '' : ' disabled'}><i class="fas fa-star"></i> Set default</button>
        <button class="btn btn-sm btn-danger" id="common-vm-view-delete"${activeView ? '' : ' disabled'}><i class="fas fa-trash"></i> Delete</button>
      </div>
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <input id="common-vm-search" class="form-control" style="max-width:320px" placeholder="Filter virtual machines" value="${Utils.escapeHtml(this._viewState.query || '')}">
        <select id="common-vm-state" class="form-control" style="width:auto">
          ${[['all','All power states'],['running','Running'],['stopped','Stopped'],['paused','Paused / suspended'],['unknown','Unknown']].map(([value,label]) => `<option value="${value}"${this._viewState.powerState === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select id="common-vm-sort" class="form-control" style="width:auto" aria-label="Sort field">
          ${[['name','Name'],['powerState','Power state'],['cpu','CPU'],['memory','Memory'],['ipAddress','IP address'],['observedAt','Observed time']].map(([value,label]) => `<option value="${value}"${this._viewState.sort.field === value ? ' selected' : ''}>Sort: ${label}</option>`).join('')}
        </select>
        <select id="common-vm-sort-direction" class="form-control" style="width:auto" aria-label="Sort direction"><option value="asc"${this._viewState.sort.direction === 'asc' ? ' selected' : ''}>Ascending</option><option value="desc"${this._viewState.sort.direction === 'desc' ? ' selected' : ''}>Descending</option></select>
        <details><summary class="btn btn-sm btn-secondary" style="cursor:pointer">Columns</summary><div class="card" style="position:absolute;z-index:20;padding:10px;display:grid;gap:7px;margin-top:5px">
          ${[['name','Name'],['powerState','Power state'],['cpu','CPU'],['memory','Memory'],['ipAddress','IP address'],['observedAt','Observed time']].map(([value,label]) => `<label style="display:flex;gap:7px;white-space:nowrap"><input type="checkbox" data-vm-column="${value}"${columns.has(value) ? ' checked' : ''}${value === 'name' ? ' disabled' : ''}> ${label}</label>`).join('')}
        </div></details>
        <span class="text-muted text-sm" id="common-vm-count"></span>
      </div>
      <div class="card hidden" id="common-vm-bulk" style="padding:12px;margin-bottom:16px;gap:8px;align-items:center;flex-wrap:wrap">
        <strong id="common-vm-selected-count"></strong>
        ${this._powerActions.map(item => `<button class="btn btn-sm ${item.force ? 'btn-danger' : 'btn-secondary'}" data-vm-bulk-action="${item.action}"><i class="fas ${item.icon}"></i> ${Utils.escapeHtml(item.label)}</button>`).join('')}
        <button class="btn btn-sm btn-secondary" id="common-vm-clear-selection">Clear selection</button>
      </div>
      <div id="common-vm-content"><div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading inventory…</div></div>`;
    container.querySelector('#common-vm-host').addEventListener('change', event => {
      this._syncViewStateFromControls(); this._hostId = Number(event.target.value); this._viewState.providerHostId = this._hostId; Api.setHost(this._hostId); this._renderHome(container);
    });
    container.querySelector('#common-vm-view').addEventListener('change', event => {
      const view = this._views.find(item => item.id === Number(event.target.value)) || null;
      this._activeViewId = view?.id || null;
      this._viewState = this._stateFromView(view);
      if (!this._hosts.some(item => item.id === this._viewState.providerHostId)) this._viewState.providerHostId = this._hostId;
      this._renderHome(container);
    });
    container.querySelector('#common-vm-view-save').addEventListener('click', () => this._saveInventoryView('create', container));
    container.querySelector('#common-vm-view-update').addEventListener('click', () => this._saveInventoryView('update', container));
    container.querySelector('#common-vm-view-default').addEventListener('click', () => this._setDefaultInventoryView(container));
    container.querySelector('#common-vm-view-delete').addEventListener('click', () => this._deleteInventoryView(container));
    container.querySelector('#common-vm-refresh').addEventListener('click', () => this._loadInventory());
    container.querySelector('#common-host-maintenance-plan')?.addEventListener('click', () => this._planHostMaintenance(host));
    container.querySelector('#common-host-maintenance-runs')?.addEventListener('click', () => this._manageHostMaintenance(host));
    container.querySelector('#common-vm-search').addEventListener('input', () => { this._syncViewStateFromControls(); this._renderInventory(); });
    container.querySelector('#common-vm-state').addEventListener('change', () => { this._syncViewStateFromControls(); this._renderInventory(); });
    container.querySelector('#common-vm-sort').addEventListener('change', () => { this._syncViewStateFromControls(); this._renderInventory(); });
    container.querySelector('#common-vm-sort-direction').addEventListener('change', () => { this._syncViewStateFromControls(); this._renderInventory(); });
    container.querySelectorAll('[data-vm-column]').forEach(input => input.addEventListener('change', () => { this._syncViewStateFromControls(); this._renderInventory(); }));
    container.querySelectorAll('[data-vm-bulk-action]').forEach(button => button.addEventListener('click', () => this._runBulkPower(button.dataset.vmBulkAction)));
    container.querySelector('#common-vm-clear-selection').addEventListener('click', () => { this._selected.clear(); this._renderInventory(); });
    await this._loadInventory();
  },

  async _loadInventory() {
    const target = document.getElementById('common-vm-content');
    if (!target) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading inventory…</div>';
    try {
      const envelope = await Api.getProviderVMs(this._hostId, 500);
      this._inventory = envelope.items || [];
      this._renderInventory();
    } catch (err) {
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderInventory() {
    const target = document.getElementById('common-vm-content');
    if (!target) return;
    const query = (document.getElementById('common-vm-search')?.value || '').trim().toLowerCase();
    const stateFilter = document.getElementById('common-vm-state')?.value || 'all';
    const items = this._sortInventory((this._inventory || []).filter(vm => {
      const state = vm.status?.powerState || 'unknown';
      const stateMatches = stateFilter === 'all' || state === stateFilter
        || (stateFilter === 'paused' && state === 'suspended');
      return stateMatches && (!query || `${vm.displayName} ${vm.spec?.guestOS || ''} ${vm.status?.ipAddress || ''}`.toLowerCase().includes(query));
    }), this._viewState?.sort);
    const columns = new Set(this._viewState?.columns || this._defaultViewState().columns);
    const count = document.getElementById('common-vm-count');
    if (count) count.textContent = `${items.length} of ${(this._inventory || []).length} VM(s)`;
    if (!items.length) {
      target.innerHTML = '<div class="empty-msg"><i class="fas fa-search"></i>No virtual machines match the current filters.</div>';
      return;
    }
    target.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px">${items.map(vm => {
      const state = vm.status?.powerState || 'unknown';
      return `<div class="card" style="padding:16px;position:relative">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
          <label style="display:flex;gap:9px;align-items:flex-start;min-width:0"><input type="checkbox" data-vm-select="${vm.id}" ${this._selected.has(vm.id) ? 'checked' : ''} aria-label="Select ${Utils.escapeHtml(vm.displayName)}">
            <a href="#/virtual-machines/${this._hostId}/${vm.id}" style="text-decoration:none;color:inherit;overflow-wrap:anywhere"><strong><i class="fas fa-desktop" style="color:var(--accent);margin-right:7px"></i>${Utils.escapeHtml(vm.displayName)}</strong></a></label>
          ${columns.has('powerState') ? `<span class="badge ${Utils.statusBadgeClass(state)}">${Utils.escapeHtml(state)}</span>` : ''}
        </div>
        ${columns.size > (columns.has('name') ? 1 : 0) + (columns.has('powerState') ? 1 : 0) ? `<div class="text-muted text-sm" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:7px">
          ${columns.has('cpu') ? `<span><i class="fas fa-microchip"></i> ${vm.spec?.cpuCount ?? '—'} vCPU</span>` : ''}
          ${columns.has('memory') ? `<span><i class="fas fa-memory"></i> ${vm.spec?.memoryBytes != null ? Utils.formatBytes(vm.spec.memoryBytes) : '—'}</span>` : ''}
          ${columns.has('ipAddress') ? `<span><i class="fas fa-network-wired"></i> ${Utils.escapeHtml(vm.status?.ipAddress || 'No IP')}</span>` : ''}
          ${columns.has('observedAt') ? `<span><i class="fas fa-clock"></i> ${Utils.escapeHtml(Utils.timeAgo(vm.observedAt))}</span>` : ''}
        </div>` : ''}
        <div style="margin-top:12px;display:flex;gap:7px"><a class="btn btn-sm btn-secondary" href="#/virtual-machines/${this._hostId}/${vm.id}">Open details</a><button class="btn btn-sm btn-secondary" data-vm-basket="${vm.id}" title="Add to persistent selection basket"><i class="fas fa-basket-shopping"></i> Basket</button></div>
      </div>`;
    }).join('')}</div>`;
    target.querySelectorAll('[data-vm-select]').forEach(input => input.addEventListener('change', () => {
      if (input.checked) this._selected.add(input.dataset.vmSelect); else this._selected.delete(input.dataset.vmSelect);
      this._updateBulkToolbar();
    }));
    target.querySelectorAll('[data-vm-basket]').forEach(button => button.addEventListener('click', async () => {
      const vm = items.find(item => item.id === button.dataset.vmBasket);
      if (!vm) return;
      try { await SelectionBasket.add('virtual-machine', this._hostId, vm.id, vm.displayName, { providerType: this._hosts.find(host => host.id === this._hostId)?.daemonType || null }); }
      catch (error) { Toast.error(error.message); }
    }));
    this._updateBulkToolbar();
  },

  _updateBulkToolbar() {
    const toolbar = document.getElementById('common-vm-bulk');
    const count = document.getElementById('common-vm-selected-count');
    if (!toolbar || !count) return;
    count.textContent = `${this._selected.size} selected`;
    toolbar.classList.toggle('hidden', this._selected.size === 0);
    toolbar.style.display = this._selected.size ? 'flex' : '';
  },

  async _renderDetail(container, route) {
    const host = this._hosts.find(item => item.id === route.hostId);
    if (!host) {
      container.innerHTML = '<div class="empty-msg is-error"><i class="fas fa-lock"></i>Virtual machine endpoint is unavailable or not permitted.</div>';
      return;
    }
    container.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading virtual machine…</div>';
    try {
      const detail = await Api.getProviderVMDetail(route.hostId, route.resourceId, false);
      detail.experienceActions = await Api.getExperienceActionAvailability(
        route.hostId, 'virtualMachine', detail.resource?.status?.powerState || ''
      ).catch(() => null);
      this._mountDetail(container, detail, host);
    } catch (err) {
      container.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}
        <div style="margin-top:12px"><a class="btn btn-sm btn-secondary" href="#/virtual-machines"><i class="fas fa-arrow-left"></i> Back to inventory</a></div></div>`;
    }
  },

  _mountDetail(container, detail, host) {
    if (this._shell) this._shell.destroy();
    this._shell = null;
    container.innerHTML = '';
    const vm = detail.resource;
    const unavailable = section => `<div class="empty-msg"><i class="fas fa-ban"></i>${Utils.escapeHtml(section.reason || 'Unavailable')}
      ${section.capability ? `<div class="text-muted text-sm" style="margin-top:8px">Capability: <code>${Utils.escapeHtml(section.capability)}</code></div>` : ''}</div>`;
    const definition = (label, value) => `<div><div class="text-muted text-sm">${Utils.escapeHtml(label)}</div><div style="overflow-wrap:anywhere">${Utils.escapeHtml(value == null || value === '' ? '—' : value)}</div></div>`;
    const dataGrid = values => `<div class="card" style="padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px">${values.join('')}</div>`;
    const listSection = section => section.available && section.items?.length
      ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>ID</th><th>Action</th><th>State</th><th>Progress</th><th>Updated</th></tr></thead><tbody>${section.items.map(item => `<tr>
        <td><a href="#/activity/${item.id}"><code>${Utils.escapeHtml(item.id)}</code></a></td><td>${Utils.escapeHtml(item.action || item.type || '—')}</td>
        <td><span class="badge ${Utils.statusBadgeClass(item.state)}">${Utils.escapeHtml(item.state)}</span></td><td>${item.progress ?? 0}%</td><td>${Utils.escapeHtml(Utils.timeAgo(item.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`
      : (section.available ? '<div class="empty-msg"><i class="fas fa-check-circle"></i>No activity recorded for this VM.</div>' : unavailable(section));
    const evidence = value => value === true ? 'Supported' : value === false ? 'Unsupported' : 'Unknown';
    const sectionWarnings = section => (section.data?.warnings || []).length
      ? `<div class="alert alert-warning" style="margin-bottom:12px">${section.data.warnings.map(item => `<div>${Utils.escapeHtml(item)}</div>`).join('')}</div>` : '';
    const disksSection = section => {
      if (!section.available) return unavailable(section);
      if (!section.items?.length) return '<div class="empty-msg"><i class="fas fa-hdd"></i>No disks are configured for this VM.</div>';
      const summary = section.data || {};
      return `${dataGrid([definition('Disks', summary.diskCount), definition('Connected', summary.connectedDiskCount),
        definition('Total capacity', summary.totalDiskCapacityBytes == null ? null : Utils.formatBytes(summary.totalDiskCapacityBytes)),
        definition('Allocated', summary.totalDiskAllocatedBytes == null ? null : Utils.formatBytes(summary.totalDiskAllocatedBytes))])}
        ${sectionWarnings(section)}<div class="card" style="overflow:auto"><table class="data-table"><thead><tr>
        <th>Device</th><th>Backing</th><th>Capacity</th><th>Allocated</th><th>Provisioning</th><th>Attachment</th><th>Hot-plug</th>
      </tr></thead><tbody>${section.items.map(item => `<tr>
        <td><strong>${Utils.escapeHtml(item.label || item.device || 'Disk')}</strong><div class="text-muted text-sm">${Utils.escapeHtml([item.bus, item.unit].filter(value => value != null).join(' · ') || item.type || '—')}</div></td>
        <td>${Utils.escapeHtml(item.backing?.storageName || item.backing?.storageId || '—')}<div class="text-muted text-sm">${Utils.escapeHtml(item.backing?.path || item.backing?.type || '')}</div></td>
        <td>${item.capacityBytes == null ? '—' : Utils.escapeHtml(Utils.formatBytes(item.capacityBytes))}</td>
        <td>${item.allocatedBytes == null ? '—' : Utils.escapeHtml(Utils.formatBytes(item.allocatedBytes))}</td>
        <td>${Utils.escapeHtml(item.provisioning || 'unknown')}</td>
        <td>${Utils.escapeHtml(item.attachment?.connected === true ? 'Connected' : item.attachment?.connected === false ? 'Disconnected' : item.status || 'Unknown')}</td>
        <td title="Hot-unplug: ${Utils.escapeHtml(evidence(item.capabilities?.hotUnplug))}">${Utils.escapeHtml(evidence(item.capabilities?.hotPlug))}</td>
      </tr>`).join('')}</tbody></table></div>`;
    };
    const networkSection = section => {
      if (!section.available) return unavailable(section);
      if (!section.items?.length) return '<div class="empty-msg"><i class="fas fa-network-wired"></i>No network interfaces are configured for this VM.</div>';
      const summary = section.data || {};
      return `${dataGrid([definition('Interfaces', summary.nicCount), definition('Connected', summary.connectedNicCount)])}
        ${sectionWarnings(section)}<div class="card" style="overflow:auto"><table class="data-table"><thead><tr>
        <th>Interface</th><th>MAC / model</th><th>Network</th><th>Addresses</th><th>Link</th><th>Hot-plug</th>
      </tr></thead><tbody>${section.items.map(item => `<tr>
        <td><strong>${Utils.escapeHtml(item.label || item.device || 'NIC')}</strong><div class="text-muted text-sm">MTU ${Utils.escapeHtml(item.mtu ?? '—')}</div></td>
        <td><code>${Utils.escapeHtml(item.macAddress || '—')}</code><div class="text-muted text-sm">${Utils.escapeHtml(item.model || '—')}</div></td>
        <td>${Utils.escapeHtml(item.network?.name || item.network?.bridge || item.network?.id || '—')}<div class="text-muted text-sm">${item.network?.vlanId == null ? '' : `VLAN ${Utils.escapeHtml(item.network.vlanId)}`}</div></td>
        <td>${(item.addresses || []).length ? item.addresses.map(address => `<div><code>${Utils.escapeHtml(address.address)}</code> <span class="text-muted text-sm">${Utils.escapeHtml(address.source || '')}</span></div>`).join('') : '—'}</td>
        <td>${Utils.escapeHtml(item.attachment?.connected === true ? 'Connected' : item.attachment?.connected === false ? 'Disconnected' : item.status || 'Unknown')}</td>
        <td title="Disconnect: ${Utils.escapeHtml(evidence(item.capabilities?.connectDisconnect))}">${Utils.escapeHtml(evidence(item.capabilities?.hotPlug))}</td>
      </tr>`).join('')}</tbody></table></div>`;
    };
    const tabs = [
      { key: 'overview', label: 'Overview', icon: 'fa-info-circle', render: panel => {
        const value = detail.sections.overview.data;
        panel.innerHTML = dataGrid([
          definition('Provider', this._providerLabel(value.provider?.type)), definition('Power state', value.powerState),
          definition('Health', value.health), definition('IP address', value.ipAddress), definition('Guest OS', value.guestOS),
          definition('Guest hostname', value.guestHostname), definition('Owner', value.ownership?.owner), definition('Service', value.ownership?.service),
          definition('Cost center', value.ownership?.costCenter), definition('Pager', value.ownership?.pager), definition('Runbook', value.ownership?.runbook),
          definition('Observed', Utils.formatDate(value.observedAt)),
        ]);
      } },
      { key: 'actions', label: 'Actions', icon: 'fa-bolt', render: panel => {
        const decisions = detail.experienceActions?.decisions || detail.actions || [];
        panel.innerHTML = `<div class="card" style="padding:16px"><h3 style="margin-top:0">Action availability</h3>
          <div class="text-muted text-sm" style="margin-bottom:12px">Capability, policy, resource state and endpoint permission are evaluated separately.</div>
          <div style="display:grid;gap:10px">${decisions.map(decision => {
            const explanation = DetailShell._pure.actionExplanation(decision);
            return `<div style="display:flex;justify-content:space-between;gap:16px;padding:10px;background:var(--surface2);border-radius:var(--radius)">
              <strong>${Utils.escapeHtml(decision.label || decision.action)}</strong>
              <span class="${decision.available ? 'text-success' : 'text-muted'}" title="${Utils.escapeHtml(explanation)}">${decision.available ? 'Available' : Utils.escapeHtml(explanation)}</span></div>`;
          }).join('') || '<div class="empty-msg">No actions are exposed by this provider.</div>'}</div></div><div id="common-vm-action-schedules"></div>`;
        this._loadActionSchedules(panel.querySelector('#common-vm-action-schedules'), host, vm);
      } },
      { key: 'hardware', label: 'Hardware', icon: 'fa-microchip', render: panel => {
        const value = detail.sections.hardware.data;
        panel.innerHTML = dataGrid([
          definition('vCPU', value.cpuCount), definition('Memory', value.memoryBytes == null ? null : Utils.formatBytes(value.memoryBytes)),
          definition('CPU usage', value.cpuUsageMHz == null ? null : `${value.cpuUsageMHz} MHz`),
          definition('Memory usage', value.memoryUsageBytes == null ? null : Utils.formatBytes(value.memoryUsageBytes)),
          definition('Hardware version', value.hardwareVersion), definition('Guest tools', value.toolsStatus), definition('Tools version', value.toolsVersion),
        ]);
      } },
      { key: 'disks', label: 'Disks', icon: 'fa-hdd', render: panel => { this._mountDisks(panel, detail.sections.disks, host, vm); } },
      { key: 'network', label: 'Network', icon: 'fa-network-wired', render: panel => {
        this._mountNics(panel, detail.sections.network, host, vm, networkSection);
      } },
      { key: 'migration', label: 'Migration', icon: 'fa-exchange-alt', render: panel => { this._mountMigrationPreflight(panel, host, vm); } },
      { key: 'events', label: 'Events', icon: 'fa-stream', render: panel => { panel.innerHTML = unavailable(detail.sections.events); } },
      { key: 'snapshots', label: 'Snapshots', icon: 'fa-camera', render: panel => { this._mountSnapshots(panel, detail.sections.snapshots, host, vm); } },
      { key: 'tasks', label: 'Tasks', icon: 'fa-tasks', render: panel => { panel.innerHTML = listSection(detail.sections.tasks); } },
      { key: 'audit', label: 'Audit', icon: 'fa-history', render: panel => {
        panel.innerHTML = `<div class="empty-msg"><i class="fas fa-shield-alt"></i>Immutable action evidence is retained in Activity Center and the audit log.
          <div style="margin-top:12px"><a class="btn btn-sm btn-secondary" href="#/activity">Open resource tasks</a> <a class="btn btn-sm btn-secondary" href="#/audit">Open audit log</a></div></div>`;
      } },
    ];
    this._shell = DetailShell.create({
      resourceKey: 'virtual-machines', id: `${host.id}/${vm.id}`, hashRouting: true,
      defaultTab: 'overview', tabs, standardTabs: true,
      header: {
        icon: 'fa-desktop', title: vm.displayName,
        subtitle: `${this._providerLabel(host.daemonType)} · ${host.name} · ${vm.id}`,
        statusPill: { text: vm.status?.powerState || 'unknown', cls: Utils.statusBadgeClass(vm.status?.powerState) },
        actions: target => {
          const actionButtons = detail.actions.map(action => `<button class="btn btn-sm ${action.action?.startsWith('force') ? 'btn-danger' : 'btn-secondary'}" data-vm-action="${Utils.escapeHtml(action.action || '')}" ${action.available ? '' : 'disabled'} title="${Utils.escapeHtml(action.available ? `${action.label} ${vm.displayName}` : this._blockerSummary(action))}">${Utils.escapeHtml(action.label)}</button>`).join('');
          const consoleEvidence = detail.capabilities?.features?.['vm.console'];
          const consoleAvailable = ['supported', 'conditional'].includes(consoleEvidence?.state);
          const canRefresh = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
          target.innerHTML = `${actionButtons}${consoleAvailable ? '<button class="btn btn-sm btn-secondary" id="common-vm-console"><i class="fas fa-desktop"></i> Console</button>' : ''}<a class="btn btn-sm btn-secondary" href="#/activity"><i class="fas fa-tasks"></i> Activity</a>
            <a class="btn btn-sm btn-secondary" href="${this._providerRoute(host.daemonType)}"><i class="fas fa-external-link-alt"></i> Provider</a>
            ${canRefresh ? '<button class="btn btn-sm btn-secondary" id="common-vm-detail-refresh"><i class="fas fa-sync"></i> Refresh</button>' : ''}
            <a class="btn btn-sm btn-secondary" href="#/virtual-machines"><i class="fas fa-arrow-left"></i> Back</a>`;
          target.querySelector('#common-vm-detail-refresh')?.addEventListener('click', async event => {
            event.currentTarget.disabled = true;
            try { this._mountDetail(container, await Api.getProviderVMDetail(host.id, vm.id, true), host); }
            catch (err) { Toast.error(err.message); event.currentTarget.disabled = false; }
          });
          target.querySelectorAll('[data-vm-action]').forEach(button => button.addEventListener('click', () => this._runPower(host.id, vm, button.dataset.vmAction)));
          target.querySelector('#common-vm-console')?.addEventListener('click', event => this._openConsole(host.id, vm, event.currentTarget));
        },
      },
      metaStrip: target => {
        const stale = detail.freshness.state === 'stale';
        target.innerHTML = `<span class="badge ${stale ? 'badge-warning' : 'badge-success'}">${Utils.escapeHtml(detail.freshness.state)}</span>
          Observed ${Utils.escapeHtml(Utils.timeAgo(detail.freshness.observedAt))}${detail.freshness.refreshError ? ` · ${Utils.escapeHtml(detail.freshness.refreshError.message)}` : ''}`;
      },
    });
    this._shell.mount(container);
  },

  _diskPlanHtml(plan) {
    const blockers = plan.blockers || [];
    const warnings = plan.warnings || [];
    return `<div class="text-sm">
      ${blockers.length ? `<div class="alert alert-danger" style="margin-bottom:12px"><strong>Operation blocked</strong><ul style="margin:8px 0 0 18px">${blockers.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="card" style="padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
        <div><strong>VM</strong><br>${Utils.escapeHtml(plan.vm?.displayName || '—')}</div>
        <div><strong>Action</strong><br>${Utils.escapeHtml(plan.action || '—')}</div>
        <div><strong>Disk</strong><br>${Utils.escapeHtml(plan.disk?.label || plan.request?.label || 'New disk')}</div>
        <div><strong>Capacity</strong><br>${plan.request?.sizeBytes ? Utils.escapeHtml(Utils.formatBytes(plan.request.sizeBytes)) : Utils.escapeHtml(Utils.formatBytes(plan.disk?.capacityBytes || 0))}</div>
        <div><strong>Storage</strong><br>${Utils.escapeHtml(plan.storage?.displayName || plan.disk?.backing?.storageName || 'Retained backing')}</div>
        <div><strong>Safety</strong><br>${plan.action === 'detach' ? 'Backing retained' : plan.action === 'resize' ? 'Grow only; guest expansion required' : 'Post-read verified'}</div>
      </div>
      ${warnings.length ? `<div class="alert alert-warning" style="margin-top:12px"><strong>Warnings</strong><ul style="margin:8px 0 0 18px">${warnings.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  },

  async _mountDisks(panel, fallbackSection, host, vm) {
    panel.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading live disk lifecycle state…</div>';
    try {
      const data = await Api.getProviderVMDisks(host.id, vm.id);
      if (!panel.isConnected) return;
      const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
      const canMutate = admin && data.release?.lifecycleEnabled === true;
      const evidence = value => value === true ? 'Supported' : value === false ? 'Unsupported' : 'Unknown';
      const rows = (data.disks || []).map(item => `<tr>
        <td><strong>${Utils.escapeHtml(item.label || item.device || 'Disk')}</strong><div class="text-muted text-sm">${Utils.escapeHtml([item.bus, item.unit].filter(value => value != null).join(' · ') || item.type || '—')}</div></td>
        <td>${Utils.escapeHtml(item.backing?.storageName || item.backing?.storageId || '—')}<div class="text-muted text-sm">${Utils.escapeHtml(item.backing?.type || '')}</div></td>
        <td>${item.capacityBytes == null ? '—' : Utils.escapeHtml(Utils.formatBytes(item.capacityBytes))}</td>
        <td>${Utils.escapeHtml(item.provisioning || 'unknown')}</td>
        <td><span class="badge ${item.ownership?.managed ? 'badge-success' : 'badge-secondary'}">${item.ownership?.managed ? 'Docker Dash managed' : 'Provider existing'}</span></td>
        <td title="Online resize: ${Utils.escapeHtml(evidence(item.capabilities?.onlineResize))}; hot-unplug: ${Utils.escapeHtml(evidence(item.capabilities?.hotUnplug))}">
          ${admin ? `<button class="btn btn-xs btn-secondary" data-disk-action="resize" data-disk-id="${Utils.escapeHtml(item.id)}" ${canMutate ? '' : 'disabled'}>Grow</button>
          <button class="btn btn-xs btn-secondary" data-disk-action="move" data-disk-id="${Utils.escapeHtml(item.id)}" ${canMutate ? '' : 'disabled'}>Move</button>
          <button class="btn btn-xs btn-danger" data-disk-action="detach" data-disk-id="${Utils.escapeHtml(item.id)}" ${canMutate ? '' : 'disabled'}>Detach</button>` : 'View only'}
        </td>
      </tr>`).join('');
      const managedDetached = (data.managedVolumes || []).filter(item => item.state === 'detached');
      panel.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px">
        <div><strong>${data.disks?.length || 0} disk(s)</strong><div class="text-muted text-sm">Detach always retains data. Shrink is never allowed.</div></div>
        ${admin ? `<button class="btn btn-sm btn-primary" id="provider-disk-create" ${canMutate ? '' : 'disabled'} title="${canMutate ? 'Create and attach a managed disk' : 'DD_PROVIDER_VM_DISK_LIFECYCLE is disabled'}"><i class="fas fa-plus"></i> Create disk</button>` : ''}
      </div>
      ${!rows ? '<div class="empty-msg"><i class="fas fa-hdd"></i>No disks are configured for this VM.</div>' : `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Device</th><th>Backing</th><th>Capacity</th><th>Provisioning</th><th>Ownership</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`}
      ${managedDetached.length ? `<div class="card" style="padding:14px;margin-top:12px"><strong>${managedDetached.length} managed detached volume(s)</strong><div class="text-muted text-sm" style="margin:5px 0 10px">Permanent deletion is separately gated and requires a recent verified recovery point.</div>
        ${managedDetached.map(item => `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:7px 0;border-top:1px solid var(--border)"><span><strong>${Utils.escapeHtml(item.label)}</strong> · ${Utils.escapeHtml(Utils.formatBytes(item.capacityBytes))}</span>${admin ? `<button class="btn btn-xs btn-danger" data-volume-delete="${Utils.escapeHtml(item.id)}" ${data.release?.deleteEnabled ? '' : 'disabled'} title="${data.release?.deleteEnabled ? 'Review permanent deletion' : 'DD_PROVIDER_VM_DISK_DELETE is disabled'}">Delete backing</button>` : ''}</div>`).join('')}</div>` : ''}`;
      panel.querySelector('#provider-disk-create')?.addEventListener('click', () => this._createDisk(host, vm, panel));
      panel.querySelectorAll('[data-disk-action]').forEach(button => button.addEventListener('click', () => {
        const disk = (data.disks || []).find(item => item.id === button.dataset.diskId);
        if (disk) this._runDiskAction(host, vm, disk, button.dataset.diskAction, panel);
      }));
      panel.querySelectorAll('[data-volume-delete]').forEach(button => button.addEventListener('click', () => {
        const volume = managedDetached.find(item => item.id === button.dataset.volumeDelete);
        if (volume) this._deleteManagedVolume(host, vm, volume, panel);
      }));
    } catch (err) {
      if (fallbackSection?.available) panel.innerHTML = `<div class="alert alert-warning">Live lifecycle controls are unavailable: ${Utils.escapeHtml(err.message)}</div>`;
      else panel.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _createDisk(host, vm, panel) {
    try {
      const storages = (await Api.getProviderStorages(host.id, 500)).items || [];
      const available = storages.filter(item => item.status?.accessible !== false);
      if (!available.length) return Toast.warning('No accessible target storage is available');
      const input = await Modal.form(`<label class="form-label" for="disk-label">Label</label><input id="disk-label" class="form-control" maxlength="160" value="data-disk">
        <label class="form-label" for="disk-size" style="margin-top:12px">Capacity (GiB)</label><input id="disk-size" class="form-control" type="number" min="1" step="1" value="10">
        <label class="form-label" for="disk-storage" style="margin-top:12px">Target storage</label><select id="disk-storage" class="form-control">${available.map(item => `<option value="${Utils.escapeHtml(item.id)}">${Utils.escapeHtml(item.displayName)}${item.status?.freeBytes != null ? ` · ${Utils.escapeHtml(Utils.formatBytes(item.status.freeBytes))} free` : ''}</option>`).join('')}</select>`, {
        title: `Create managed disk · ${vm.displayName}`, submitLabel: 'Review preflight', width: '620px',
        onSubmit: root => ({ label: root.querySelector('#disk-label').value.trim(),
          sizeBytes: Number(root.querySelector('#disk-size').value) * 1024 ** 3,
          targetStorageId: root.querySelector('#disk-storage').value }),
      });
      if (!input) return;
      const plan = await Api.preflightProviderVMDiskCreate(host.id, vm.id, input);
      if (!plan.allowed) return Modal.confirm(this._diskPlanHtml(plan), { title: 'Disk create preflight', confirmText: 'Close', html: true, width: '680px' });
      const confirmed = await Modal.confirm(this._diskPlanHtml(plan), { title: `Create disk · ${vm.displayName}`,
        confirmText: 'Queue create', typeToConfirm: plan.confirmation.expected, html: true, width: '680px' });
      if (!confirmed) return;
      const result = await Api.submitProviderVMDiskCreate(host.id, vm.id, { ...input,
        planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      }, this._idempotencyKey('vm-disk-create'));
      Toast.success(`Disk create queued for ${vm.displayName}`); location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); if (panel?.isConnected) this._mountDisks(panel, {}, host, vm); }
  },

  async _runDiskAction(host, vm, disk, action, panel) {
    try {
      let input = { action };
      if (action === 'resize') {
        const currentGiB = Math.ceil(Number(disk.capacityBytes || 0) / 1024 ** 3);
        const value = await Modal.form(`<label class="form-label" for="disk-new-size">New capacity (GiB; must be greater than ${currentGiB})</label><input id="disk-new-size" class="form-control" type="number" min="${currentGiB + 1}" step="1" value="${currentGiB + 1}">`, {
          title: `Grow ${disk.label || 'disk'}`, submitLabel: 'Review preflight',
          onSubmit: root => Number(root.querySelector('#disk-new-size').value) * 1024 ** 3,
        });
        if (!value) return; input.sizeBytes = value;
      } else if (action === 'move') {
        const storages = (await Api.getProviderStorages(host.id, 500)).items || [];
        const value = await Modal.form(`<label class="form-label" for="disk-move-storage">Target storage</label><select id="disk-move-storage" class="form-control">${storages.filter(item => item.status?.accessible !== false).map(item => `<option value="${Utils.escapeHtml(item.id)}">${Utils.escapeHtml(item.displayName)}</option>`).join('')}</select>`, {
          title: `Move ${disk.label || 'disk'}`, submitLabel: 'Review preflight',
          onSubmit: root => root.querySelector('#disk-move-storage').value,
        });
        if (!value) return; input.targetStorageId = value;
      }
      const plan = await Api.preflightProviderVMDiskAction(host.id, vm.id, disk.id, input);
      if (!plan.allowed) return Modal.confirm(this._diskPlanHtml(plan), { title: `Disk ${action} preflight`, confirmText: 'Close', html: true, width: '680px' });
      const confirmed = await Modal.confirm(this._diskPlanHtml(plan), { title: `${action} · ${vm.displayName}`,
        confirmText: `Queue ${action}`, danger: action === 'detach', typeToConfirm: plan.confirmation.expected,
        html: true, width: '680px' });
      if (!confirmed) return;
      const result = await Api.submitProviderVMDiskAction(host.id, vm.id, disk.id, { ...input,
        planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      }, this._idempotencyKey(`vm-disk-${action}`));
      Toast.success(`Disk ${action} queued for ${vm.displayName}`); location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); if (panel?.isConnected) this._mountDisks(panel, {}, host, vm); }
  },

  async _deleteManagedVolume(host, vm, volume, panel) {
    try {
      const plan = await Api.preflightProviderManagedVolumeDelete(host.id, volume.id);
      if (!plan.allowed) return Modal.confirm(this._diskPlanHtml(plan), {
        title: 'Managed-volume delete preflight', confirmText: 'Close', html: true, width: '680px',
      });
      const confirmed = await Modal.confirm(this._diskPlanHtml(plan), {
        title: `Permanently delete ${volume.label}`, confirmText: 'Delete backing', danger: true,
        typeToConfirm: plan.confirmation.expected, html: true, width: '680px',
      });
      if (!confirmed) return;
      const result = await Api.submitProviderManagedVolumeDelete(host.id, volume.id, {
        planHash: plan.planHash, confirm: true, confirmPhrase: plan.confirmation.expected,
      }, this._idempotencyKey('managed-volume-delete'));
      Toast.success(`Managed-volume deletion queued for ${vm.displayName}`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); if (panel?.isConnected) this._mountDisks(panel, {}, host, vm); }
  },

  _nicPlanHtml(plan) {
    const blockers = plan.blockers || [];
    const warnings = plan.warnings || [];
    return `<div class="text-sm">
      ${blockers.length ? `<div class="alert alert-danger"><strong>NIC link operation blocked</strong><ul style="margin:8px 0 0 18px">${blockers.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="card" style="padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
        <div><strong>VM</strong><br>${Utils.escapeHtml(plan.vm?.displayName || '—')}</div>
        <div><strong>Interface</strong><br>${Utils.escapeHtml(plan.nic?.label || '—')}</div>
        <div><strong>Action</strong><br>${Utils.escapeHtml(plan.action || '—')}</div>
        <div><strong>Network</strong><br>${Utils.escapeHtml(plan.nic?.network?.name || plan.nic?.network?.bridge || plan.nic?.network?.id || '—')}</div>
        <div><strong>Current / desired</strong><br>${Utils.escapeHtml(String(plan.nic?.currentConnected))} → ${Utils.escapeHtml(String(plan.expectedConnected))}</div>
        <div><strong>Safety declaration</strong><br>${Utils.escapeHtml(plan.safety?.state || 'not required')}</div>
      </div>
      ${warnings.length ? `<div class="alert alert-warning" style="margin-top:12px"><strong>Warnings</strong><ul style="margin:8px 0 0 18px">${warnings.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="alert alert-info" style="margin-top:12px">Only the link state is changed. This workflow cannot attach, detach, delete or remap the NIC. Rollback is never automatic and requires a fresh preflight.</div>
    </div>`;
  },

  async _mountNics(panel, fallbackSection, host, vm, fallbackRenderer) {
    panel.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading live NIC link state…</div>';
    try {
      const data = await Api.getProviderVMNics(host.id, vm.id);
      if (!panel.isConnected) return;
      const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
      const canMutate = admin && data.release?.enabled === true;
      const rows = (data.nics || []).map(nic => {
        const connected = nic.attachment?.connected;
        const action = connected === true ? 'disconnect' : connected === false ? 'connect' : '';
        const safetyState = nic.safety?.state || 'missing';
        const safetyClass = nic.safety?.valid ? 'badge-success'
          : ['expired', 'hardware_changed', 'unsafe'].includes(safetyState) ? 'badge-warning' : 'badge-secondary';
        const actionable = canMutate && action && nic.capabilities?.connectDisconnect === true;
        return `<tr>
          <td><strong>${Utils.escapeHtml(nic.label || nic.device || 'NIC')}</strong><div class="text-muted text-sm">MTU ${Utils.escapeHtml(nic.mtu ?? '—')}</div></td>
          <td><code>${Utils.escapeHtml(nic.macAddress || '—')}</code><div class="text-muted text-sm">${Utils.escapeHtml(nic.model || '—')}</div></td>
          <td>${Utils.escapeHtml(nic.network?.name || nic.network?.bridge || nic.network?.id || '—')}<div class="text-muted text-sm">${nic.network?.vlanId == null ? '' : `VLAN ${Utils.escapeHtml(nic.network.vlanId)}`}</div></td>
          <td><span class="badge ${connected === true ? 'badge-success' : connected === false ? 'badge-secondary' : 'badge-warning'}">${connected === true ? 'connected' : connected === false ? 'disconnected' : 'unknown'}</span></td>
          <td><span class="badge ${safetyClass}" title="${Utils.escapeHtml(nic.safety?.reason || 'No current declaration')}">${Utils.escapeHtml(safetyState)}</span>${nic.safety?.expiresAt ? `<div class="text-muted text-sm">${Utils.escapeHtml(Utils.timeAgo(nic.safety.expiresAt))}</div>` : ''}</td>
          <td>${admin ? `<button class="btn btn-xs btn-secondary" data-nic-safety="${Utils.escapeHtml(nic.id)}">Declare safety</button>
            <button class="btn btn-xs ${action === 'disconnect' ? 'btn-danger' : 'btn-primary'}" data-nic-link="${Utils.escapeHtml(nic.id)}" data-nic-action="${Utils.escapeHtml(action)}" ${actionable ? '' : 'disabled'} title="${Utils.escapeHtml(actionable ? `Review ${action} preflight` : data.release?.enabled ? 'Provider capability or link state is unknown' : `${data.release?.flag || 'Provider flag'} is disabled`)}">${Utils.escapeHtml(action || 'Unavailable')}</button>` : 'View only'}</td>
        </tr>`;
      }).join('');
      panel.innerHTML = `<div class="alert alert-info" style="margin-bottom:12px"><strong>Link-only control.</strong> Disconnect is fail-closed on last NIC, management role, boot dependency, guest dependency, policy and provider evidence.</div>
        ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Interface</th><th>MAC / model</th><th>Network</th><th>Link</th><th>Safety</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty-msg"><i class="fas fa-network-wired"></i>No network interfaces are configured for this VM.</div>'}`;
      panel.querySelectorAll('[data-nic-safety]').forEach(button => button.addEventListener('click', () => {
        const nic = (data.nics || []).find(item => item.id === button.dataset.nicSafety);
        if (nic) this._declareNicSafety(host, vm, nic, panel);
      }));
      panel.querySelectorAll('[data-nic-link]').forEach(button => button.addEventListener('click', () => {
        const nic = (data.nics || []).find(item => item.id === button.dataset.nicLink);
        if (nic && button.dataset.nicAction) this._runNicLink(host, vm, nic, button.dataset.nicAction, panel);
      }));
    } catch (err) {
      if (fallbackSection?.available && typeof fallbackRenderer === 'function') {
        panel.innerHTML = `<div class="alert alert-warning">Live NIC controls are unavailable: ${Utils.escapeHtml(err.message)}</div>${fallbackRenderer(fallbackSection)}`;
      } else panel.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _declareNicSafety(host, vm, nic, panel) {
    try {
      const input = await Modal.form(`<div class="alert alert-warning text-sm">This is a time-limited operator declaration, not provider-discovered truth. Select each value explicitly after checking the workload and runbook.</div>
        <label class="form-label" for="nic-management">Management role</label><select id="nic-management" class="form-control"><option value="">Select…</option><option value="non_management">Not a management NIC</option><option value="management">Management NIC</option></select>
        <label class="form-label" for="nic-boot" style="margin-top:12px">Boot dependency</label><select id="nic-boot" class="form-control"><option value="">Select…</option><option value="not_required">Not required for boot</option><option value="required">Required for boot</option></select>
        <label class="form-label" for="nic-guest" style="margin-top:12px">Guest/service dependency</label><select id="nic-guest" class="form-control"><option value="">Select…</option><option value="not_required">No known dependency</option><option value="required">Required by guest/service</option></select>
        <label class="form-label" for="nic-valid" style="margin-top:12px">Validity (hours)</label><input id="nic-valid" class="form-control" type="number" min="1" max="4" value="1">
        <label class="form-label" for="nic-reason" style="margin-top:12px">Evidence / change reason</label><textarea id="nic-reason" class="form-control" minlength="8" maxlength="500" rows="3"></textarea>`, {
        title: `NIC safety · ${nic.label || nic.device || 'interface'}`, submitLabel: 'Save declaration', width: '650px',
        onSubmit: root => ({
          managementRole: root.querySelector('#nic-management').value,
          bootDependency: root.querySelector('#nic-boot').value,
          guestDependency: root.querySelector('#nic-guest').value,
          validForHours: Number(root.querySelector('#nic-valid').value),
          reason: root.querySelector('#nic-reason').value.trim(),
        }),
      });
      if (!input) return;
      const result = await Api.declareProviderVMNicSafety(host.id, vm.id, nic.id, input);
      Toast.success(`NIC safety declaration saved (${result.safety.state})`);
      if (panel?.isConnected) this._mountNics(panel, {}, host, vm);
    } catch (err) { Toast.error(err.message); }
  },

  async _runNicLink(host, vm, nic, action, panel) {
    try {
      const plan = await Api.preflightProviderVMNicLink(host.id, vm.id, nic.id, action);
      if (!plan.allowed) return Modal.confirm(this._nicPlanHtml(plan), {
        title: `NIC ${action} preflight`, confirmText: 'Close', html: true, width: '700px',
      });
      const confirmed = await Modal.confirm(this._nicPlanHtml(plan), {
        title: `${action} ${nic.label || 'NIC'} · ${vm.displayName}`, confirmText: `Queue ${action}`,
        danger: action === 'disconnect', typeToConfirm: plan.confirmation.expected, html: true, width: '700px',
      });
      if (!confirmed) return;
      const result = await Api.submitProviderVMNicLink(host.id, vm.id, nic.id, {
        action, planHash: plan.planHash, confirm: true, confirmText: plan.confirmation.expected,
      }, this._idempotencyKey(`vm-nic-${action}`));
      Toast.success(`NIC ${action} queued for ${vm.displayName}`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); if (panel?.isConnected) this._mountNics(panel, {}, host, vm); }
  },

  async _mountMigrationPreflight(panel, host, vm) {
    panel.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Evaluating migration targets…</div>';
    try {
      const result = await Api.getProviderVMMigrationPreflight(host.id, vm.id);
      if (!panel.isConnected) return;
      const statusClass = state => ({ ready: 'badge-success', blocked: 'badge-danger', unknown: 'badge-warning' }[state] || 'badge-secondary');
      const duration = estimate => {
        const value = estimate?.durationSeconds;
        return value ? `${value.min}-${value.max}s` : '—';
      };
      const modeCell = (candidate, mode) => {
        const value = candidate.modes?.[mode] || { state: 'unknown' };
        const reasons = [...(value.blockers || []), ...(value.warnings || [])].map(item => item.reason).filter(Boolean).join(' · ');
        return `<span class="badge ${statusClass(value.state)}" title="${Utils.escapeHtml(reasons || value.estimate?.methodology || '')}">${Utils.escapeHtml(value.state)}</span>
          <div class="text-muted text-sm" style="margin-top:5px">${Utils.escapeHtml(duration(value.estimate))}</div>
          ${result.scope?.executionEnabled && value.state === 'ready'
            ? `<button class="btn btn-xs btn-secondary" style="margin-top:6px" data-migrate-target="${Utils.escapeHtml(candidate.target.id)}" data-migrate-mode="${Utils.escapeHtml(mode)}">Review</button>` : ''}`;
      };
      const capabilities = Object.entries(result.capabilityMatrix || {}).map(([mode, evidence]) =>
        `<span class="badge ${evidence.state === 'supported' ? 'badge-success' : evidence.state === 'conditional' ? 'badge-warning' : 'badge-secondary'}" title="${Utils.escapeHtml(evidence.reason || '')}">${Utils.escapeHtml(mode)}: ${Utils.escapeHtml(evidence.state || 'unknown')}</span>`).join(' ');
      const warnings = (result.warnings || []).length
        ? `<div class="alert alert-warning" style="margin-bottom:12px">${result.warnings.map(item => `<div>${Utils.escapeHtml(item)}</div>`).join('')}</div>` : '';
      const rows = (result.candidates || []).map(candidate => {
        const checks = (candidate.checks || []).map(check => `${check.key}: ${check.state}`).join(' · ');
        return `<tr>
          <td><strong>${Utils.escapeHtml(candidate.target.displayName)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(candidate.target.status?.powerState || 'unknown')}</div></td>
          <td><strong>${Utils.escapeHtml(candidate.score)}</strong><div class="text-muted text-sm">${candidate.eligible ? 'eligible' : 'not eligible'}</div></td>
          <td>${modeCell(candidate, 'live')}</td><td>${modeCell(candidate, 'cold')}</td><td>${modeCell(candidate, 'storage')}</td>
          <td class="text-sm" title="${Utils.escapeHtml(checks)}">${Utils.escapeHtml(checks || 'No provider evidence')}</td>
        </tr>`;
      }).join('');
      panel.innerHTML = `<div class="alert alert-info" style="margin-bottom:12px"><strong>${result.scope?.executionEnabled ? 'Execution-gated evidence.' : 'Read-only evidence.'}</strong> This preflight does not reserve resources${result.scope?.executionEnabled ? '; every migration is revalidated before submission.' : ' and native migration is disabled by the release flag.'}</div>
        ${warnings}<div class="card" style="padding:14px;margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <strong>Provider capabilities</strong>${capabilities || '<span class="text-muted">No capability evidence</span>'}
          <span class="text-muted text-sm" style="margin-left:auto">Plan ${Utils.escapeHtml(String(result.planHash || '').slice(0, 12))}</span>
        </div>
        ${(result.candidates || []).length ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr>
          <th>Target host</th><th>Score</th><th>Live</th><th>Cold</th><th>Storage</th><th>Checks</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty-msg"><i class="fas fa-server"></i>No migration target hosts are visible in this provider endpoint.</div>'}`;
      panel.querySelectorAll('[data-migrate-target]').forEach(button => button.addEventListener('click', () =>
        this._runMigration(host, vm, button.dataset.migrateTarget, button.dataset.migrateMode)));
    } catch (err) {
      if (!panel.isConnected) return;
      panel.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _migrationPlanHtml(plan) {
    const blockers = plan.blockers || [];
    const warnings = plan.warnings || [];
    const estimate = plan.selectedMode?.estimate;
    return `<div class="text-sm">
      ${blockers.length ? `<div class="alert alert-danger"><strong>Migration blocked</strong><ul style="margin:8px 0 0 18px">${blockers.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="card" style="padding:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
        <div><strong>VM</strong><br>${Utils.escapeHtml(plan.vm.displayName)}</div>
        <div><strong>Mode</strong><br>${Utils.escapeHtml(plan.mode)}</div>
        <div><strong>Target</strong><br>${Utils.escapeHtml(plan.target.displayName)}</div>
        <div><strong>Storage</strong><br>${Utils.escapeHtml(plan.targetStorage?.displayName || 'Provider/default mapping')}</div>
        <div><strong>Duration estimate</strong><br>${estimate ? `${Utils.escapeHtml(estimate.durationSeconds.min)}-${Utils.escapeHtml(estimate.durationSeconds.max)}s` : '—'}</div>
        <div><strong>Expected power</strong><br>${Utils.escapeHtml(plan.expectedPowerState || 'unknown')}</div>
      </div>
      ${warnings.length ? `<div class="alert alert-warning" style="margin-top:12px"><strong>Warnings</strong><ul style="margin:8px 0 0 18px">${warnings.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  },

  async _runMigration(host, vm, targetId, mode) {
    try {
      let selection = { targetId, mode };
      let plan = await Api.preflightProviderVMMigration(host.id, vm.id, selection);
      if (mode === 'storage' && !plan.targetStorage && (plan.storageOptions || []).length
        && (plan.blockers || []).some(item => item.type === 'TARGET_STORAGE_REQUIRED')) {
        const selected = await Modal.form(`<label class="form-label" for="migration-storage">Target datastore</label>
          <select id="migration-storage" class="form-control">${plan.storageOptions.map(item =>
            `<option value="${Utils.escapeHtml(item.id)}">${Utils.escapeHtml(item.displayName)}${item.freeBytes ? ` · ${Utils.escapeHtml(Utils.formatBytes(item.freeBytes))} free` : ''}</option>`).join('')}</select>`, {
          title: `Storage migration · ${vm.displayName}`, submitLabel: 'Review preflight',
          onSubmit: root => root.querySelector('#migration-storage').value,
        });
        if (!selected) return;
        selection = { ...selection, targetStorageId: selected };
        plan = await Api.preflightProviderVMMigration(host.id, vm.id, selection);
      }
      if (!plan.allowed) {
        await Modal.confirm(this._migrationPlanHtml(plan), {
          title: 'Migration preflight', confirmText: 'Close', html: true, width: '680px',
        });
        return;
      }
      const confirmed = await Modal.confirm(this._migrationPlanHtml(plan), {
        title: `Migrate ${vm.displayName}`, confirmText: 'Queue migration', danger: true,
        typeToConfirm: plan.confirmation.expected, html: true, width: '680px',
      });
      if (!confirmed) return;
      const idempotencyKey = this._idempotencyKey('vm-migrate');
      const body = {
        ...selection, planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      };
      const result = await this._withCriticalAuthorization(authorization =>
        Api.submitProviderVMMigration(host.id, vm.id, body, idempotencyKey, authorization));
      if (!result) return;
      Toast.success(`Migration queued for ${vm.displayName}`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
  },

  async _openConsole(hostId, vm, button) {
    button.disabled = true;
    const popup = window.open('', '_blank');
    if (popup) {
      popup.opener = null;
      popup.document.title = 'Opening VM console…';
      popup.document.body.textContent = 'Authorizing protected VM console…';
    }
    try {
      const preflight = await Api.preflightProviderVMConsole(hostId, vm.id);
      if (!preflight.ready) {
        popup?.close();
        Toast.warning((preflight.blockers || []).map(item => item.reason).join(' · ') || 'VM console is unavailable');
        return;
      }
      const launch = await Api.launchProviderVMConsole(hostId, vm.id);
      const target = new URL(launch.launchUrl, location.origin);
      if (target.origin !== location.origin || target.pathname !== '/vm-console.html') throw new Error('Invalid console launch URL');
      if (popup) popup.location.replace(target.href);
      else window.open(target.href, '_blank', 'noopener,noreferrer');
    } catch (err) {
      popup?.close();
      Toast.error(err.message);
    } finally { button.disabled = false; }
  },

  destroy() {
    if (this._shell) this._shell.destroy();
    this._shell = null;
    this._inventory = [];
    this._selected.clear();
    this._views = [];
    this._activeViewId = null;
    this._viewState = null;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = VirtualMachinesPage;
