/* Common provider VM inventory and detail shell. */
'use strict';

const VirtualMachinesPage = {
  _hosts: [],
  _hostId: null,
  _shell: null,
  _selected: new Set(),

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

  _powerLabel(action) {
    return this._powerActions.find(item => item.action === action)?.label || action;
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
      const result = await Api.submitProviderVMPower(hostId, vm.id, {
        action, planHash: plan.planHash, confirm: true,
        ...(plan.confirmation?.mode === 'typed_name' ? { confirmName: plan.confirmation.expected } : {}),
      }, this._idempotencyKey());
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
      const result = await Api.submitProviderVMPowerBulk(this._hostId, {
        resourceIds, action, confirm: true,
        plans: Object.fromEntries(preflight.plans.map(plan => [plan.resource.id, plan.planHash])),
        ...(confirmNames ? { confirmNames } : {}),
      }, this._idempotencyKey('vm-power-bulk'));
      this._selected.clear();
      Toast.success(`${result.count} VM power operation(s) queued`);
      location.hash = '#/activity';
    } catch (err) { Toast.error(err.message); }
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
      const result = await Api.submitProviderVMSnapshotAction(host.id, vm.id, snapshot.id, action, {
        planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      }, this._idempotencyKey(`vm-snapshot-${action}`));
      Toast.success(`Snapshot ${action} queued`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
  },

  _mountSnapshots(panel, section, host, vm) {
    if (!section.available) {
      panel.innerHTML = `<div class="empty-msg"><i class="fas fa-ban"></i>${Utils.escapeHtml(section.reason || 'Snapshots unavailable')}</div>`;
      return;
    }
    const items = section.items || [];
    panel.innerHTML = `<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-sm btn-primary" id="common-snapshot-create"><i class="fas fa-camera"></i> Create snapshot</button>
      <button class="btn btn-sm btn-secondary" id="common-snapshot-refresh"><i class="fas fa-sync"></i> Refresh</button>
    </div>
    <div class="alert alert-warning text-sm"><strong>Snapshots are not backups.</strong> They share the VM/provider storage failure domain.</div>
    ${items.length ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Name</th><th>Created</th><th>Consistency</th><th>Integrity</th><th>Children</th><th>Actions</th></tr></thead><tbody>${items.map(item => `<tr>
      <td><strong>${Utils.escapeHtml(item.name)}</strong>${item.isCurrent ? ' <span class="badge badge-info">current</span>' : ''}</td>
      <td>${Utils.escapeHtml(item.createdAt ? Utils.formatDate(item.createdAt) : '—')}</td><td>${Utils.escapeHtml(item.consistency)}</td>
      <td><span class="badge ${item.integrity?.state === 'valid' ? 'badge-success' : 'badge-warning'}">${Utils.escapeHtml(item.integrity?.state || 'unknown')}</span></td>
      <td>${item.childCount || 0}</td><td style="display:flex;gap:6px"><button class="btn btn-sm btn-secondary" data-snapshot-action="revert" data-snapshot-id="${item.id}">Revert</button><button class="btn btn-sm btn-danger" data-snapshot-action="delete" data-snapshot-id="${item.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-msg"><i class="fas fa-camera"></i>No snapshots are currently visible.</div>'}`;
    panel.querySelector('#common-snapshot-create').addEventListener('click', () => this._runSnapshotCreate(host, vm));
    panel.querySelector('#common-snapshot-refresh').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        const inventory = await Api.getProviderVMSnapshots(host.id, vm.id);
        this._mountSnapshots(panel, { available: true, items: inventory.items }, host, vm);
      } catch (err) { Toast.error(err.message); event.currentTarget.disabled = false; }
    });
    panel.querySelectorAll('[data-snapshot-action]').forEach(button => button.addEventListener('click', () => {
      const snapshot = items.find(item => item.id === button.dataset.snapshotId);
      if (snapshot) this._runSnapshotAction(host, vm, snapshot, button.dataset.snapshotAction);
    }));
  },

  async render(container, params = {}) {
    this.destroy();
    try {
      this._hosts = ((await Api.getHosts()) || [])
        .filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType));
    } catch { this._hosts = []; }
    const route = this._parseRoute(params.id);
    if (route) return this._renderDetail(container, route);
    return this._renderHome(container);
  },

  async _renderHome(container) {
    if (!this._hosts.length) {
      container.innerHTML = `<div class="page-header"><h1><i class="fas fa-desktop"></i> Virtual Machines</h1></div>
        <div class="empty-msg"><i class="fas fa-desktop"></i>No supported virtualization endpoint is available.<br>
        Add Proxmox, vSphere, or Xen from <a href="#/hosts">Hosts</a>.</div>`;
      return;
    }
    this._selected.clear();
    const selected = Api.getHostId();
    if (this._hosts.some(host => host.id === selected)) this._hostId = selected;
    if (!this._hosts.some(host => host.id === this._hostId)) this._hostId = this._hosts[0].id;
    const host = this._hosts.find(item => item.id === this._hostId);
    container.innerHTML = `
      <div class="page-header">
        <div><h1><i class="fas fa-desktop"></i> Virtual Machines</h1>
          <div class="text-muted text-sm">Unified, provider-neutral inventory</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="common-vm-host" class="form-control" style="width:auto">
            ${this._hosts.map(item => `<option value="${item.id}"${item.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(item.name)} · ${Utils.escapeHtml(this._providerLabel(item.daemonType))}</option>`).join('')}
          </select>
          <a class="btn btn-sm btn-secondary" href="${this._providerRoute(host.daemonType)}"><i class="fas fa-external-link-alt"></i> Provider view</a>
          <a class="btn btn-sm btn-secondary" href="#/activity"><i class="fas fa-tasks"></i> Activity</a>
          <button class="btn btn-sm btn-secondary" id="common-vm-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <input id="common-vm-search" class="form-control" style="max-width:360px" placeholder="Filter virtual machines">
        <select id="common-vm-state" class="form-control" style="width:auto">
          <option value="all">All power states</option><option value="running">Running</option>
          <option value="stopped">Stopped</option><option value="paused">Paused / suspended</option>
          <option value="unknown">Unknown</option>
        </select>
        <span class="text-muted text-sm" id="common-vm-count"></span>
      </div>
      <div class="card hidden" id="common-vm-bulk" style="padding:12px;margin-bottom:16px;gap:8px;align-items:center;flex-wrap:wrap">
        <strong id="common-vm-selected-count"></strong>
        ${this._powerActions.map(item => `<button class="btn btn-sm ${item.force ? 'btn-danger' : 'btn-secondary'}" data-vm-bulk-action="${item.action}"><i class="fas ${item.icon}"></i> ${Utils.escapeHtml(item.label)}</button>`).join('')}
        <button class="btn btn-sm btn-secondary" id="common-vm-clear-selection">Clear selection</button>
      </div>
      <div id="common-vm-content"><div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading inventory…</div></div>`;
    container.querySelector('#common-vm-host').addEventListener('change', event => {
      this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._renderHome(container);
    });
    container.querySelector('#common-vm-refresh').addEventListener('click', () => this._loadInventory());
    container.querySelector('#common-vm-search').addEventListener('input', () => this._renderInventory());
    container.querySelector('#common-vm-state').addEventListener('change', () => this._renderInventory());
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
    const items = (this._inventory || []).filter(vm => {
      const state = vm.status?.powerState || 'unknown';
      const stateMatches = stateFilter === 'all' || state === stateFilter
        || (stateFilter === 'paused' && state === 'suspended');
      return stateMatches && (!query || `${vm.displayName} ${vm.spec?.guestOS || ''} ${vm.status?.ipAddress || ''}`.toLowerCase().includes(query));
    });
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
          <span class="badge ${Utils.statusBadgeClass(state)}">${Utils.escapeHtml(state)}</span>
        </div>
        <div class="text-muted text-sm" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:7px">
          <span><i class="fas fa-microchip"></i> ${vm.spec?.cpuCount ?? '—'} vCPU</span>
          <span><i class="fas fa-memory"></i> ${vm.spec?.memoryBytes != null ? Utils.formatBytes(vm.spec.memoryBytes) : '—'}</span>
          <span><i class="fas fa-network-wired"></i> ${Utils.escapeHtml(vm.status?.ipAddress || 'No IP')}</span>
          <span><i class="fas fa-clock"></i> ${Utils.escapeHtml(Utils.timeAgo(vm.observedAt))}</span>
        </div>
        <div style="margin-top:12px"><a class="btn btn-sm btn-secondary" href="#/virtual-machines/${this._hostId}/${vm.id}">Open details</a></div>
      </div>`;
    }).join('')}</div>`;
    target.querySelectorAll('[data-vm-select]').forEach(input => input.addEventListener('change', () => {
      if (input.checked) this._selected.add(input.dataset.vmSelect); else this._selected.delete(input.dataset.vmSelect);
      this._updateBulkToolbar();
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
      { key: 'hardware', label: 'Hardware', icon: 'fa-microchip', render: panel => {
        const value = detail.sections.hardware.data;
        panel.innerHTML = dataGrid([
          definition('vCPU', value.cpuCount), definition('Memory', value.memoryBytes == null ? null : Utils.formatBytes(value.memoryBytes)),
          definition('CPU usage', value.cpuUsageMHz == null ? null : `${value.cpuUsageMHz} MHz`),
          definition('Memory usage', value.memoryUsageBytes == null ? null : Utils.formatBytes(value.memoryUsageBytes)),
          definition('Hardware version', value.hardwareVersion), definition('Guest tools', value.toolsStatus), definition('Tools version', value.toolsVersion),
        ]);
      } },
      ...[['disks', 'Disks', 'fa-hdd'], ['network', 'Network', 'fa-network-wired'], ['events', 'Events', 'fa-stream']]
        .map(([key, label, icon]) => ({ key, label, icon, render: panel => { panel.innerHTML = unavailable(detail.sections[key]); } })),
      { key: 'snapshots', label: 'Snapshots', icon: 'fa-camera', render: panel => { this._mountSnapshots(panel, detail.sections.snapshots, host, vm); } },
      { key: 'tasks', label: 'Tasks', icon: 'fa-tasks', render: panel => { panel.innerHTML = listSection(detail.sections.tasks); } },
    ];
    this._shell = DetailShell.create({
      resourceKey: 'virtual-machines', id: `${host.id}/${vm.id}`, hashRouting: true,
      defaultTab: 'overview', tabs,
      header: {
        icon: 'fa-desktop', title: vm.displayName,
        subtitle: `${this._providerLabel(host.daemonType)} · ${host.name} · ${vm.id}`,
        statusPill: { text: vm.status?.powerState || 'unknown', cls: Utils.statusBadgeClass(vm.status?.powerState) },
        actions: target => {
          const actionButtons = detail.actions.map(action => `<button class="btn btn-sm ${action.action?.startsWith('force') ? 'btn-danger' : 'btn-secondary'}" data-vm-action="${Utils.escapeHtml(action.action || '')}" ${action.available ? '' : 'disabled'} title="${Utils.escapeHtml(action.available ? `${action.label} ${vm.displayName}` : this._blockerSummary(action))}">${Utils.escapeHtml(action.label)}</button>`).join('');
          const canRefresh = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
          target.innerHTML = `${actionButtons}<a class="btn btn-sm btn-secondary" href="#/activity"><i class="fas fa-tasks"></i> Activity</a>
            <a class="btn btn-sm btn-secondary" href="${this._providerRoute(host.daemonType)}"><i class="fas fa-external-link-alt"></i> Provider</a>
            ${canRefresh ? '<button class="btn btn-sm btn-secondary" id="common-vm-detail-refresh"><i class="fas fa-sync"></i> Refresh</button>' : ''}
            <a class="btn btn-sm btn-secondary" href="#/virtual-machines"><i class="fas fa-arrow-left"></i> Back</a>`;
          target.querySelector('#common-vm-detail-refresh')?.addEventListener('click', async event => {
            event.currentTarget.disabled = true;
            try { this._mountDetail(container, await Api.getProviderVMDetail(host.id, vm.id, true), host); }
            catch (err) { Toast.error(err.message); event.currentTarget.disabled = false; }
          });
          target.querySelectorAll('[data-vm-action]').forEach(button => button.addEventListener('click', () => this._runPower(host.id, vm, button.dataset.vmAction)));
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

  destroy() {
    if (this._shell) this._shell.destroy();
    this._shell = null;
    this._inventory = [];
    this._selected.clear();
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = VirtualMachinesPage;
