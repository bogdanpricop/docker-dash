/* ═══════════════════════════════════════════════════
   pages/vsphere-resources.js — VMware vSphere / ESXi
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.11-alpha.1 — vSphere / ESXi read-only page. 3 tabs (VMs, Hosts,
// Datastores). Info card with product name + version + API version.
// Gated in the sidebar via data-fleet-daemon="vsphere".

const VSphereResourcesPage = {
  _tab: 'vms',
  _hostId: null,      // resolved vSphere host id (NOT the global selection)
  _hosts: [],         // all registered vSphere hosts

  async render(container) {
    // v8.9.11-alpha.9 — resolve the vSphere host(s) from the fleet, not the
    // globally-selected host. A Docker host being selected must not leak into
    // /vsphere calls.
    try {
      const allHosts = await Api.getHosts();
      this._hosts = (allHosts || []).filter(h => h.daemonType === 'vsphere');
    } catch { this._hosts = []; }

    if (!this._hosts.length) {
      container.innerHTML = `
        <div class="page-header">
          <h1><i class="fas fa-server"></i> VMware vSphere / ESXi <span class="badge badge-warning">alpha</span></h1>
        </div>
        <div class="empty-msg"><i class="fas fa-server" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>
          No vSphere / ESXi host registered. Add one from
          <a href="#/hosts">Hosts → Non-Docker host</a>.</div>`;
      return;
    }
    // Keep a prior selection if still valid, else default to the first host.
    if (!this._hostId || !this._hosts.some(h => h.id === this._hostId)) {
      this._hostId = this._hosts[0].id;
    }

    const hostSelector = this._hosts.length > 1
      ? `<select id="vs-host" class="form-control" style="width:auto;display:inline-block;margin-right:8px">
           ${this._hosts.map(h => `<option value="${h.id}"${h.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(h.name)}</option>`).join('')}
         </select>`
      : `<span class="text-muted" style="margin-right:8px">${Utils.escapeHtml(this._hosts[0].name)}</span>`;

    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-server"></i> VMware vSphere / ESXi <span class="badge badge-warning">alpha</span></h1>
        <div>
          ${hostSelector}
          <button class="btn btn-sm btn-secondary" id="vs-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div id="vs-info-panel"></div>
      <div class="tabs" style="margin-bottom:12px">
        <button class="tab-btn active" data-tab="vms">VMs</button>
        <button class="tab-btn" data-tab="hosts">ESXi Hosts</button>
        <button class="tab-btn" data-tab="datastores">Datastores</button>
      </div>
      <div id="vs-tab-container">Loading...</div>
    `;
    const hostSel = container.querySelector('#vs-host');
    if (hostSel) hostSel.addEventListener('change', (e) => {
      this._hostId = parseInt(e.target.value, 10);
      this._loadInfo();
      this._load();
    });
    container.querySelector('#vs-refresh').addEventListener('click', () => { this._loadInfo(); this._load(); });
    container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._tab = e.target.getAttribute('data-tab');
        container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === e.target));
        this._load();
      });
    });
    await this._loadInfo();
    await this._load();
  },

  async _loadInfo() {
    const el = document.getElementById('vs-info-panel');
    if (!el) return;
    try {
      const info = await Api.getVSphereInfo(this._hostId);
      el.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
            <div><strong>Product:</strong> ${Utils.escapeHtml(info.productFullName || info.productName || '—')}</div>
            <div><strong>Version:</strong> ${Utils.escapeHtml(info.version || '—')}</div>
            <div><strong>API:</strong> ${Utils.escapeHtml(info.apiVersion || '—')}</div>
            <div><strong>Build:</strong> ${Utils.escapeHtml(info.build || '—')}</div>
          </div>
        </div>
      `;
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">vSphere connect error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _load() {
    const el = document.getElementById('vs-tab-container');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading ${Utils.escapeHtml(this._tab)}...</div>`;
    try {
      let rows;
      switch (this._tab) {
        case 'vms':
          rows = await Api.getVSphereVMs(this._hostId);
          this._renderVMs(el, rows);
          break;
        case 'hosts':
          rows = await Api.getVSphereHosts(this._hostId);
          this._renderHosts(el, rows);
          break;
        case 'datastores':
          rows = await Api.getVSphereDatastores(this._hostId);
          this._renderDatastores(el, rows);
          break;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error loading ${Utils.escapeHtml(this._tab)}: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderVMs(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-desktop" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px"></i>No VMs.</div>`;
      return;
    }
    const rows = list.map(vm => {
      const powerColor = vm.powerState === 'poweredOn' ? 'green' :
                        vm.powerState === 'poweredOff' ? 'gray' : 'yellow';
      return `<tr>
        <td><strong>${Utils.escapeHtml(vm.name || '—')}</strong></td>
        <td style="color:${powerColor}">${Utils.escapeHtml(vm.powerState || '—')}</td>
        <td>${Utils.escapeHtml(vm.guestOS || '—')}</td>
        <td>${vm.numCPU || '—'}</td>
        <td>${vm.memoryMB ? Utils.escapeHtml(String((vm.memoryMB / 1024).toFixed(1))) + ' GiB' : '—'}</td>
        <td><code style="font-size:10px">${Utils.escapeHtml(vm.uuid || vm.moref || '—')}</code></td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Power</th><th>Guest OS</th><th>vCPU</th><th>Memory</th><th>UUID</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderHosts(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No ESXi hosts.</div>`;
      return;
    }
    const rows = list.map(h => {
      const connColor = h.connectionState === 'connected' ? 'green' : 'red';
      const memGB = h.memoryBytes ? (h.memoryBytes / (1024**3)).toFixed(1) + ' GiB' : '—';
      return `<tr>
        <td><strong>${Utils.escapeHtml(h.name || '—')}</strong></td>
        <td style="color:${connColor}">${Utils.escapeHtml(h.connectionState || '—')}</td>
        <td>${Utils.escapeHtml(h.model || '—')}</td>
        <td>${h.cpuCores || '—'}</td>
        <td>${h.cpuMHz ? Utils.escapeHtml(String(h.cpuMHz)) + ' MHz' : '—'}</td>
        <td>${memGB}</td>
        <td>${Utils.escapeHtml(h.version || '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Status</th><th>Model</th><th>Cores</th><th>CPU</th><th>Memory</th><th>Version</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderDatastores(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No datastores.</div>`;
      return;
    }
    const rows = list.map(d => {
      const cap = d.capacityBytes || 0;
      const free = d.freeSpaceBytes || 0;
      const used = cap - free;
      const pct = cap > 0 ? Math.round(100 * used / cap) : 0;
      const pctColor = pct > 90 ? 'red' : pct > 75 ? 'yellow' : 'green';
      return `<tr>
        <td><strong>${Utils.escapeHtml(d.name || '—')}</strong></td>
        <td>${Utils.escapeHtml(d.type || '—')}</td>
        <td>${cap ? Utils.escapeHtml(String((cap / (1024**3)).toFixed(1))) + ' GiB' : '—'}</td>
        <td>${free ? Utils.escapeHtml(String((free / (1024**3)).toFixed(1))) + ' GiB' : '—'}</td>
        <td style="color:${pctColor}">${pct}%</td>
        <td>${d.accessible ? '✓' : '✗'}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Type</th><th>Capacity</th><th>Free</th><th>Used</th><th>Accessible</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },
};
