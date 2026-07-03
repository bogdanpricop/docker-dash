/* ═══════════════════════════════════════════════════
   pages/proxmox-resources.js — Proxmox VE resources
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.1-alpha.1 — Sprint 4 (Proxmox VE) READ-ONLY overview.
//
// Positioning: docker-dash is NOT a Proxmox UI replacement (Proxmox
// ships its own excellent UI). This page's value is showing VMs +
// LXCs + storages + backups alongside your Docker hosts in one
// dashboard — for operators running mixed infrastructure.
//
// Actions (start/stop/snapshot/backup) land in alpha.2 after
// real-world verification.

const ProxmoxResourcesPage = {
  _tab: 'vms',

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-server"></i> Proxmox VE (alpha)</h1>
        <button class="btn btn-sm btn-secondary" id="pve-refresh"><i class="fas fa-sync"></i> Refresh</button>
      </div>
      <div id="pve-info-panel"></div>
      <div class="tabs">
        <button class="tab active" data-tab="vms"><i class="fas fa-desktop" style="margin-right:4px"></i>VMs</button>
        <button class="tab" data-tab="lxc"><i class="fas fa-box" style="margin-right:4px"></i>LXC</button>
        <button class="tab" data-tab="nodes"><i class="fas fa-server" style="margin-right:4px"></i>Nodes</button>
        <button class="tab" data-tab="storages"><i class="fas fa-database" style="margin-right:4px"></i>Storages</button>
        <button class="tab" data-tab="backups"><i class="fas fa-archive" style="margin-right:4px"></i>Backups</button>
      </div>
      <div id="pve-content">Loading...</div>
    `;
    container.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        this._renderTab();
      });
    });
    container.querySelector('#pve-refresh').addEventListener('click', () => this._renderTab());
    await this._loadInfoPanel();
    await this._renderTab();
  },

  async _loadInfoPanel() {
    try {
      const info = await Api.getProxmoxInfo();
      const el = document.getElementById('pve-info-panel');
      if (el && info) {
        el.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
              <div><strong>Proxmox VE:</strong> ${Utils.escapeHtml(info.version || '—')}</div>
              <div><strong>Release:</strong> ${Utils.escapeHtml(info.release || '—')}</div>
              <div><strong>Repo ID:</strong> ${Utils.escapeHtml(info.repoid || '—')}</div>
            </div>
          </div>
        `;
      }
    } catch { /* info panel is best-effort */ }
  },

  async _renderTab() {
    const el = document.getElementById('pve-content');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;
    try {
      if (this._tab === 'vms')      await this._renderVMs(el);
      else if (this._tab === 'lxc')      await this._renderLXC(el);
      else if (this._tab === 'nodes')    await this._renderNodes(el);
      else if (this._tab === 'storages') await this._renderStorages(el);
      else if (this._tab === 'backups')  await this._renderBackups(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _statusBadge(status) {
    const color = status === 'running' ? 'green' : status === 'stopped' ? 'red' : 'yellow';
    return `<span class="badge badge-${color}">${Utils.escapeHtml(status || '—')}</span>`;
  },

  _memoryUsage(vm) {
    if (!vm.mem || !vm.maxmem) return '—';
    const pct = Math.round((vm.mem / vm.maxmem) * 100);
    return `${Utils.formatBytes(vm.mem)} / ${Utils.formatBytes(vm.maxmem)} (${pct}%)`;
  },

  _cpuUsage(vm) {
    if (vm.cpu == null || vm.maxcpu == null) return '—';
    return `${(vm.cpu * 100).toFixed(1)}% of ${vm.maxcpu} cores`;
  },

  async _renderVMs(el) {
    const vms = await Api.getProxmoxVMs();
    if (!vms.length) {
      el.innerHTML = `<div class="empty-msg">No VMs on this cluster.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>VMID</th><th>Name</th><th>Node</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime</th></tr>
          </thead>
          <tbody>
            ${vms.map(v => `
              <tr>
                <td><strong>${Utils.escapeHtml(String(v.vmid))}</strong></td>
                <td>${Utils.escapeHtml(v.name || '—')}</td>
                <td>${Utils.escapeHtml(v.node || '—')}</td>
                <td>${this._statusBadge(v.status)}</td>
                <td>${this._cpuUsage(v)}</td>
                <td>${this._memoryUsage(v)}</td>
                <td>${v.uptime ? Utils.formatDuration(v.uptime) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div></div>
    `;
  },

  async _renderLXC(el) {
    const lxc = await Api.getProxmoxLXC();
    if (!lxc.length) {
      el.innerHTML = `<div class="empty-msg">No LXC containers on this cluster.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>CTID</th><th>Name</th><th>Node</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime</th></tr>
          </thead>
          <tbody>
            ${lxc.map(c => `
              <tr>
                <td><strong>${Utils.escapeHtml(String(c.vmid))}</strong></td>
                <td>${Utils.escapeHtml(c.name || '—')}</td>
                <td>${Utils.escapeHtml(c.node || '—')}</td>
                <td>${this._statusBadge(c.status)}</td>
                <td>${this._cpuUsage(c)}</td>
                <td>${this._memoryUsage(c)}</td>
                <td>${c.uptime ? Utils.formatDuration(c.uptime) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div></div>
    `;
  },

  async _renderNodes(el) {
    const nodes = await Api.getProxmoxNodes();
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>Node</th><th>Status</th><th>Uptime</th><th>CPU</th><th>Memory</th></tr>
          </thead>
          <tbody>
            ${nodes.map(n => `
              <tr>
                <td><strong>${Utils.escapeHtml(n.node || '—')}</strong></td>
                <td>${this._statusBadge(n.status)}</td>
                <td>${n.uptime ? Utils.formatDuration(n.uptime) : '—'}</td>
                <td>${n.cpu != null ? `${(n.cpu * 100).toFixed(1)}% of ${n.maxcpu || '—'}` : '—'}</td>
                <td>${n.mem && n.maxmem ? `${Utils.formatBytes(n.mem)} / ${Utils.formatBytes(n.maxmem)}` : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div></div>
    `;
  },

  async _renderStorages(el) {
    const storages = await Api.getProxmoxStorages();
    if (!storages.length) {
      el.innerHTML = `<div class="empty-msg">No storages found.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>Storage</th><th>Node</th><th>Type</th><th>Content</th><th>Used / Total</th></tr>
          </thead>
          <tbody>
            ${storages.map(s => {
              const usedPct = s.disk && s.maxdisk ? Math.round((s.disk / s.maxdisk) * 100) : null;
              return `
                <tr>
                  <td><strong>${Utils.escapeHtml(s.storage || s.id || '—')}</strong></td>
                  <td>${Utils.escapeHtml(s.node || '—')}</td>
                  <td>${Utils.escapeHtml(s.plugintype || s.type || '—')}</td>
                  <td>${Utils.escapeHtml(s.content || '—')}</td>
                  <td>${s.disk && s.maxdisk ? `${Utils.formatBytes(s.disk)} / ${Utils.formatBytes(s.maxdisk)} (${usedPct}%)` : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div></div>
    `;
  },

  async _renderBackups(el) {
    const backups = await Api.getProxmoxBackups();
    if (!backups.length) {
      el.innerHTML = `<div class="empty-msg">No backups found across configured storages.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>File</th><th>VMID</th><th>Node</th><th>Storage</th><th>Size</th><th>Created</th></tr>
          </thead>
          <tbody>
            ${backups.slice(0, 200).map(b => `
              <tr>
                <td><code style="font-size:11px">${Utils.escapeHtml(b.volid || '—')}</code></td>
                <td>${b.vmid || '—'}</td>
                <td>${Utils.escapeHtml(b.node || '—')}</td>
                <td>${Utils.escapeHtml(b.storage || '—')}</td>
                <td>${b.size ? Utils.formatBytes(b.size) : '—'}</td>
                <td>${b.ctime ? Utils.formatDate(b.ctime * 1000) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div></div>
      ${backups.length > 200 ? `<p class="text-dim text-sm" style="text-align:center;padding:8px">Showing 200 most recent of ${backups.length} backups</p>` : ''}
    `;
  },

  destroy() {},
};

window.ProxmoxResourcesPage = ProxmoxResourcesPage;
