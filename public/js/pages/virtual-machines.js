/* Common provider VM inventory and detail shell. */
'use strict';

const VirtualMachinesPage = {
  _hosts: [],
  _hostId: null,
  _shell: null,

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
      <div id="common-vm-content"><div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading inventory…</div></div>`;
    container.querySelector('#common-vm-host').addEventListener('change', event => {
      this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._renderHome(container);
    });
    container.querySelector('#common-vm-refresh').addEventListener('click', () => this._loadInventory());
    container.querySelector('#common-vm-search').addEventListener('input', () => this._renderInventory());
    container.querySelector('#common-vm-state').addEventListener('change', () => this._renderInventory());
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
      return `<a class="card" href="#/virtual-machines/${this._hostId}/${vm.id}" style="padding:16px;text-decoration:none;color:inherit">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
          <strong style="overflow-wrap:anywhere"><i class="fas fa-desktop" style="color:var(--accent);margin-right:7px"></i>${Utils.escapeHtml(vm.displayName)}</strong>
          <span class="badge ${Utils.statusBadgeClass(state)}">${Utils.escapeHtml(state)}</span>
        </div>
        <div class="text-muted text-sm" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:7px">
          <span><i class="fas fa-microchip"></i> ${vm.spec?.cpuCount ?? '—'} vCPU</span>
          <span><i class="fas fa-memory"></i> ${vm.spec?.memoryBytes != null ? Utils.formatBytes(vm.spec.memoryBytes) : '—'}</span>
          <span><i class="fas fa-network-wired"></i> ${Utils.escapeHtml(vm.status?.ipAddress || 'No IP')}</span>
          <span><i class="fas fa-clock"></i> ${Utils.escapeHtml(Utils.timeAgo(vm.observedAt))}</span>
        </div>
      </a>`;
    }).join('')}</div>`;
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
      ...[['disks', 'Disks', 'fa-hdd'], ['network', 'Network', 'fa-network-wired'], ['snapshots', 'Snapshots', 'fa-camera'], ['events', 'Events', 'fa-stream']]
        .map(([key, label, icon]) => ({ key, label, icon, render: panel => { panel.innerHTML = unavailable(detail.sections[key]); } })),
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
          const actionButtons = detail.actions.map(action => `<button class="btn btn-sm btn-secondary" disabled title="${Utils.escapeHtml(this._blockerSummary(action))}">${Utils.escapeHtml(action.label)}</button>`).join('');
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
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = VirtualMachinesPage;
