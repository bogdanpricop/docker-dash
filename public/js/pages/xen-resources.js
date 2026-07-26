/* ═══════════════════════════════════════════════════
   pages/xen-resources.js — Xen / XCP-ng / XenServer
   ═══════════════════════════════════════════════════ */
'use strict';

const XenResourcesPage = {
  _tab: 'overview',
  _hostId: null,
  _hosts: [],
  _capabilities: {},
  _info: {},

  _isAdmin() {
    return App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
  },

  async render(container) {
    try {
      this._hosts = (await Api.getHosts()).filter(host => host.daemonType === 'xen');
    } catch { this._hosts = []; }

    if (!this._hosts.length) {
      container.innerHTML = `<div class="page-header"><h1><i class="fas fa-cloud"></i> Xen / XCP-ng / XenServer</h1></div>
        <div class="empty-msg"><i class="fas fa-cloud" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>
          No Xen endpoint registered. Add Xen Orchestra, XAPI, or raw libxl from <a href="#/hosts">Hosts → Non-Docker host</a>.</div>`;
      return;
    }

    const selected = Api.getHostId();
    if (this._hosts.some(host => host.id === selected)) this._hostId = selected;
    else if (!this._hosts.some(host => host.id === this._hostId)) this._hostId = this._hosts[0].id;

    const selector = this._hosts.length > 1
      ? `<select id="xen-host-selector" class="form-control" style="width:auto;display:inline-block">${this._hosts.map(host =>
        `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)}</option>`).join('')}</select>`
      : `<span class="text-muted">${Utils.escapeHtml(this._hosts[0].name)}</span>`;
    const tabs = [['overview', 'Overview'], ['vms', 'VMs'], ['hosts', 'Hosts'], ['storage', 'Storage'],
      ['networks', 'Networks'], ['tasks', 'Tasks']];

    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-cloud"></i> Xen / XCP-ng / XenServer</h1>
        <div style="display:flex;gap:8px;align-items:center">${selector}
          <button class="btn btn-sm btn-secondary" id="xen-reconnect"><i class="fas fa-plug"></i> Reconnect</button>
          <button class="btn btn-sm btn-secondary" id="xen-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div class="tabs" style="margin-bottom:16px">${tabs.map(([id, label]) =>
        `<button class="tab ${id === this._tab ? 'active' : ''}" data-xen-tab="${id}">${label}</button>`).join('')}</div>
      <div id="xen-content"><div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading…</div></div>`;

    container.querySelector('#xen-host-selector')?.addEventListener('change', event => {
      this._hostId = Number(event.target.value);
      this._load();
    });
    container.querySelector('#xen-refresh').addEventListener('click', () => this._load());
    container.querySelector('#xen-reconnect').addEventListener('click', () => this._reconnect());
    container.querySelectorAll('[data-xen-tab]').forEach(button => button.addEventListener('click', () => {
      this._tab = button.dataset.xenTab;
      container.querySelectorAll('[data-xen-tab]').forEach(item => item.classList.toggle('active', item === button));
      this._load();
    }));
    await this._load();
  },

  async _load() {
    const el = document.getElementById('xen-content');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading ${Utils.escapeHtml(this._tab)}…</div>`;
    try {
      [this._info, this._capabilities] = await Promise.all([
        Api.getXenInfo(this._hostId), Api.getXenCapabilities(this._hostId),
      ]);
      switch (this._tab) {
        case 'overview': await this._renderOverview(el); break;
        case 'vms': this._renderVMs(el, await Api.getXenVMs(this._hostId)); break;
        case 'hosts': this._renderHosts(el, await Api.getXenHosts(this._hostId)); break;
        case 'storage': this._renderStorage(el, await Api.getXenStorages(this._hostId)); break;
        case 'networks': this._renderNetworks(el, await Api.getXenNetworks(this._hostId)); break;
        case 'tasks': this._renderTasks(el, await Api.getXenTasks(this._hostId)); break;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle" style="color:var(--red);font-size:28px;display:block;margin-bottom:8px"></i>
        ${Utils.escapeHtml(err.message)}<div style="margin-top:12px"><button class="btn btn-sm btn-primary" id="xen-error-reconnect"><i class="fas fa-plug"></i> Reconnect</button></div></div>`;
      el.querySelector('#xen-error-reconnect')?.addEventListener('click', () => this._reconnect());
    }
  },

  async _reconnect() {
    const buttons = document.querySelectorAll('#xen-reconnect, #xen-error-reconnect');
    buttons.forEach(button => { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reconnecting…'; });
    try { await Api.reconnectXen(this._hostId); Toast.success('Xen connection re-established'); }
    catch (err) { Toast.error(err.message); }
    await this._load();
  },

  _stat(icon, label, value, sub = '') {
    return `<div class="card" style="padding:16px;flex:1;min-width:160px"><div style="color:var(--text-dim);font-size:12px;text-transform:uppercase;letter-spacing:.5px"><i class="fas ${icon}"></i> ${Utils.escapeHtml(label)}</div>
      <div style="font-size:28px;font-weight:700;margin-top:6px">${value}</div>${sub ? `<div style="font-size:12px;color:var(--text-dim);margin-top:2px">${sub}</div>` : ''}</div>`;
  },

  async _renderOverview(el) {
    const [vms, hosts, pools, storages, networks, tasks] = await Promise.all([
      Api.getXenVMs(this._hostId).catch(() => []), Api.getXenHosts(this._hostId).catch(() => []),
      Api.getXenPools(this._hostId).catch(() => []), Api.getXenStorages(this._hostId).catch(() => []),
      Api.getXenNetworks(this._hostId).catch(() => []), Api.getXenTasks(this._hostId).catch(() => []),
    ]);
    const running = vms.filter(vm => /running|poweredon/i.test(vm.powerState || '')).length;
    const totalStorage = storages.reduce((sum, storage) => sum + (storage.totalBytes || 0), 0);
    const usedStorage = storages.reduce((sum, storage) => sum + (storage.usedBytes || 0), 0);
    const providerLabels = { xo: 'Xen Orchestra REST', xapi: `XAPI ${(this._capabilities.protocol || '').toUpperCase()}`, raw: 'Raw xl/libxl over SSH' };
    const enabled = Object.entries(this._capabilities).filter(([, value]) => value === true).map(([key]) => key);
    el.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        ${this._stat('fa-desktop', 'Virtual machines', `${running}<span style="font-size:16px;color:var(--text-dim)">/${vms.length}</span>`, 'running / total')}
        ${this._stat('fa-server', 'Xen hosts', hosts.length, `${pools.length} pool(s)`)}
        ${this._stat('fa-hdd', 'Storage repositories', storages.length, totalStorage ? `${Utils.formatBytes(usedStorage)} / ${Utils.formatBytes(totalStorage)}` : 'not exposed')}
        ${this._stat('fa-network-wired', 'Networks', networks.length, `${tasks.filter(task => /pending|running/i.test(task.status || '')).length} active task(s)`)}
      </div>
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div><div style="font-size:12px;color:var(--text-dim);text-transform:uppercase">Management plane</div><strong>${Utils.escapeHtml(providerLabels[this._info.provider] || this._info.provider || 'Xen')}</strong></div>
          <div><div style="font-size:12px;color:var(--text-dim);text-transform:uppercase">Product</div><strong>${Utils.escapeHtml(this._info.product || 'Xen')}</strong></div>
          <div><div style="font-size:12px;color:var(--text-dim);text-transform:uppercase">Version</div><strong>${Utils.escapeHtml(this._info.version || this._info.apiVersion || 'detected at runtime')}</strong></div>
          <div><div style="font-size:12px;color:var(--text-dim);text-transform:uppercase">Endpoint host</div><strong>${Utils.escapeHtml(this._info.hostname || '—')}</strong></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:6px;flex-wrap:wrap">${enabled.map(capability => `<span class="badge badge-info">${Utils.escapeHtml(capability)}</span>`).join('')}</div>
      </div>`;
  },

  _table(headers, rows, emptyText) {
    if (!rows.length) return `<div class="empty-msg">${Utils.escapeHtml(emptyText)}</div>`;
    return `<div class="card" style="overflow:auto"><table class="table"><thead><tr>${headers.map(header => `<th>${Utils.escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  },

  _renderVMs(el, vms) {
    const admin = this._isAdmin();
    const actions = admin && this._capabilities.powerActions;
    const supported = new Set(this._capabilities.vmActions || []);
    el.innerHTML = this._table(['VM', 'State', 'vCPU', 'Memory', 'Address', 'Actions'], vms.map(vm => {
      const state = String(vm.powerState || 'Unknown');
      const lower = state.toLowerCase();
      const vmSupported = Array.isArray(vm.allowedActions) ? new Set(vm.allowedActions) : supported;
      const buttons = [];
      if (actions && vmSupported.has('start') && /halted|stopped|shutdown/.test(lower)) buttons.push(['start', 'fa-play', false]);
      if (actions && /running|poweredon/.test(lower)) {
        if (vmSupported.has('shutdown')) buttons.push(['shutdown', 'fa-stop', false]);
        if (vmSupported.has('reboot')) buttons.push(['reboot', 'fa-redo', false]);
        if (vmSupported.has('suspend')) buttons.push(['suspend', 'fa-pause', false]);
        else if (vmSupported.has('pause')) buttons.push(['pause', 'fa-pause', false]);
        if (vmSupported.has('forceShutdown')) buttons.push(['forceShutdown', 'fa-power-off', true]);
      }
      if (actions && vmSupported.has('resume') && lower.includes('suspend')) buttons.push(['resume', 'fa-play', false]);
      if (actions && vmSupported.has('unpause') && lower.includes('paused')) buttons.push(['unpause', 'fa-play', false]);
      const actionHtml = buttons.map(([action, icon, danger]) => `<button class="btn btn-xs ${danger ? 'btn-danger' : 'btn-secondary'} xen-vm-action" data-vm="${Utils.escapeHtml(vm.id)}" data-name="${Utils.escapeHtml(vm.name)}" data-action="${action}"><i class="fas ${icon}"></i> ${Utils.escapeHtml(action)}</button>`).join(' ');
      const snapshots = admin && this._capabilities.snapshots && (!Array.isArray(vm.allowedActions) || vmSupported.has('snapshot')) ? `<button class="btn btn-xs btn-secondary xen-snapshots" data-vm="${Utils.escapeHtml(vm.id)}" data-name="${Utils.escapeHtml(vm.name)}"><i class="fas fa-camera"></i> Snapshots</button>` : '';
      const color = /running|poweredon/.test(lower) ? 'var(--green)' : /halted|stopped|shutdown/.test(lower) ? 'var(--text-dim)' : 'var(--yellow)';
      return `<tr><td><strong>${Utils.escapeHtml(vm.name || vm.id)}</strong><div class="text-muted" style="font-size:10px">${Utils.escapeHtml(vm.uuid || vm.id)}</div></td>
        <td style="color:${color}">${Utils.escapeHtml(state)}</td><td>${vm.cpus || '—'}</td><td>${vm.memoryBytes ? Utils.formatBytes(vm.memoryBytes) : '—'}</td>
        <td>${Utils.escapeHtml(vm.ipAddress || '—')}</td><td style="white-space:nowrap">${actionHtml} ${snapshots}</td></tr>`;
    }), 'No virtual machines exposed by this endpoint.');
    el.querySelectorAll('.xen-vm-action').forEach(button => button.addEventListener('click', () => this._runVMAction(button)));
    el.querySelectorAll('.xen-snapshots').forEach(button => button.addEventListener('click', () => this._openSnapshots(button.dataset.vm, button.dataset.name)));
  },

  async _runVMAction(button) {
    const { vm, name, action } = button.dataset;
    const force = action.startsWith('force');
    const ok = await Modal.confirm(`${action} virtual machine “${name}”?${force ? ' This bypasses guest shutdown and may cause data loss.' : ''}`, {
      danger: force || action === 'shutdown', confirmText: action, typeToConfirm: force ? name : undefined,
    });
    if (!ok) return;
    button.disabled = true;
    try {
      const result = await Api.xenVMAction(this._hostId, vm, action, force);
      const task = result?.result?.taskId || result?.result?.taskRef
        || (typeof result?.result === 'string' ? result.result : null);
      Toast.success(`${action} submitted${task ? ` (task ${task})` : ''}`);
      await this._load();
    } catch (err) { Toast.error(err.message); button.disabled = false; }
  },

  async _openSnapshots(vmId, vmName) {
    try {
      const snapshots = await Api.getXenSnapshots(this._hostId, vmId);
      Modal.open(`<div class="modal-header"><h3><i class="fas fa-camera"></i> Snapshots — ${Utils.escapeHtml(vmName)}</h3><button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button></div>
        <div class="modal-body"><div style="display:flex;gap:8px;margin-bottom:14px"><input id="xen-snapshot-name" class="form-control" maxlength="80" placeholder="Snapshot name"><button class="btn btn-primary" id="xen-snapshot-create"><i class="fas fa-plus"></i> Create</button></div>
          ${this._table(['Snapshot', 'Created', 'Actions'], snapshots.map(snapshot => `<tr><td><strong>${Utils.escapeHtml(snapshot.name || snapshot.id)}</strong><div class="text-muted" style="font-size:10px">${Utils.escapeHtml(snapshot.id)}</div></td><td>${Utils.escapeHtml(snapshot.createdAt || '—')}</td><td>
            <button class="btn btn-xs btn-warning xen-snapshot-revert" data-id="${Utils.escapeHtml(snapshot.id)}" data-name="${Utils.escapeHtml(snapshot.name || snapshot.id)}"><i class="fas fa-history"></i> Revert</button>
            <button class="btn btn-xs btn-danger xen-snapshot-delete" data-id="${Utils.escapeHtml(snapshot.id)}" data-name="${Utils.escapeHtml(snapshot.name || snapshot.id)}"><i class="fas fa-trash"></i></button></td></tr>`), 'No snapshots.')}
        </div><div class="modal-footer"><button class="btn btn-secondary" id="modal-ok">Close</button></div>`, { width: '820px' });
      Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#xen-snapshot-create').addEventListener('click', async () => {
        const name = Modal._content.querySelector('#xen-snapshot-name').value.trim();
        if (!name) return Toast.error('Snapshot name is required');
        try { await Api.createXenSnapshot(this._hostId, vmId, name); Toast.success('Snapshot task submitted'); Modal.close(); await this._load(); }
        catch (err) { Toast.error(err.message); }
      });
      Modal._content.querySelectorAll('.xen-snapshot-revert').forEach(button => button.addEventListener('click', async () => {
        const ok = await Modal.confirm(`Revert VM to snapshot “${button.dataset.name}”? Current state may be lost.`, { danger: true, confirmText: 'Revert', typeToConfirm: button.dataset.name });
        if (!ok) return;
        try { await Api.revertXenSnapshot(this._hostId, button.dataset.id); Toast.success('Snapshot revert submitted'); await this._load(); }
        catch (err) { Toast.error(err.message); }
      }));
      Modal._content.querySelectorAll('.xen-snapshot-delete').forEach(button => button.addEventListener('click', async () => {
        const ok = await Modal.confirm(`Delete snapshot “${button.dataset.name}”?`, { danger: true, confirmText: 'Delete' });
        if (!ok) return;
        try { await Api.deleteXenSnapshot(this._hostId, button.dataset.id); Toast.success('Snapshot deletion submitted'); await this._load(); }
        catch (err) { Toast.error(err.message); }
      }));
    } catch (err) { Toast.error(err.message); }
  },

  _renderHosts(el, hosts) {
    el.innerHTML = this._table(['Host', 'Address', 'State', 'CPU', 'Memory', 'Version'], hosts.map(host =>
      `<tr><td><strong>${Utils.escapeHtml(host.name || host.id)}</strong></td><td>${Utils.escapeHtml(host.address || '—')}</td><td>${Utils.escapeHtml(host.powerState || '—')}</td>
      <td>${host.cpus || '—'}</td><td>${host.memoryBytes ? Utils.formatBytes(host.memoryBytes) : '—'}</td><td>${Utils.escapeHtml(host.version || host.product || '—')}</td></tr>`), 'No Xen hosts exposed.');
  },

  _renderStorage(el, storages) {
    el.innerHTML = this._table(['Storage repository', 'Type', 'Used', 'Capacity', 'Shared', 'Attached'], storages.map(storage =>
      `<tr><td><strong>${Utils.escapeHtml(storage.name || storage.id)}</strong></td><td>${Utils.escapeHtml(storage.type || '—')}</td><td>${storage.usedBytes ? Utils.formatBytes(storage.usedBytes) : '—'}</td>
      <td>${storage.totalBytes ? Utils.formatBytes(storage.totalBytes) : '—'}</td><td>${storage.shared ? 'Yes' : 'No'}</td><td>${storage.attached === false ? 'No' : 'Yes'}</td></tr>`), 'Storage is not exposed by this provider.');
  },

  _renderNetworks(el, networks) {
    el.innerHTML = this._table(['Network', 'Bridge', 'MTU', 'Managed', 'UUID'], networks.map(network =>
      `<tr><td><strong>${Utils.escapeHtml(network.name || network.id)}</strong></td><td>${Utils.escapeHtml(network.bridge || '—')}</td><td>${network.mtu || '—'}</td>
      <td>${network.managed === false ? 'No' : 'Yes'}</td><td class="text-muted">${Utils.escapeHtml(network.uuid || network.id)}</td></tr>`), 'Networks are not exposed by this provider.');
  },

  _renderTasks(el, tasks) {
    const sorted = [...tasks].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    el.innerHTML = this._table(['Task', 'Status', 'Progress', 'Started', 'Result / Error', 'Actions'], sorted.map(task => {
      const progress = Math.round((Number(task.progress) || 0) * 100);
      const color = /success|complete/i.test(task.status || '') ? 'var(--green)' : /fail|cancel/i.test(task.status || '') ? 'var(--red)' : 'var(--yellow)';
      const canDelete = this._isAdmin() && this._capabilities.taskCleanup && !/pending|running/i.test(task.status || '');
      const detail = typeof (task.error || task.result) === 'object' ? JSON.stringify(task.error || task.result) : String(task.error || task.result || '—');
      return `<tr><td><strong>${Utils.escapeHtml(task.name || task.id)}</strong><div class="text-muted" style="font-size:10px">${Utils.escapeHtml(task.id)}</div></td>
        <td style="color:${color}">${Utils.escapeHtml(task.status || '—')}</td><td>${progress}%</td><td>${Utils.escapeHtml(task.startedAt || '—')}</td><td>${Utils.escapeHtml(detail)}</td>
        <td>${canDelete ? `<button class="btn btn-xs btn-danger xen-task-delete" data-id="${Utils.escapeHtml(task.id)}"><i class="fas fa-trash"></i></button>` : '—'}</td></tr>`;
    }), 'No asynchronous tasks exposed by this provider.');
    el.querySelectorAll('.xen-task-delete').forEach(button => button.addEventListener('click', async () => {
      const ok = await Modal.confirm('Delete this completed XAPI task record?', { danger: true, confirmText: 'Delete task' });
      if (!ok) return;
      try { await Api.deleteXenTask(this._hostId, button.dataset.id); Toast.success('Task record deleted'); await this._load(); }
      catch (err) { Toast.error(err.message); }
    }));
  },
};

window.XenResourcesPage = XenResourcesPage;
