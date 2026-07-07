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
      <div id="vs-security-panel"></div>
      <div class="tabs" style="margin-bottom:12px">
        <button class="tab active" data-tab="vms">VMs</button>
        <button class="tab" data-tab="hosts">ESXi Hosts</button>
        <button class="tab" data-tab="datastores">Datastores</button>
      </div>
      <div id="vs-tab-container">Loading...</div>
    `;
    const hostSel = container.querySelector('#vs-host');
    if (hostSel) hostSel.addEventListener('change', (e) => {
      this._hostId = parseInt(e.target.value, 10);
      this._loadInfo();
      this._loadSecurity();
      this._load();
    });
    container.querySelector('#vs-refresh').addEventListener('click', () => { this._loadInfo(); this._loadSecurity(); this._load(); });
    container.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._tab = e.target.getAttribute('data-tab');
        container.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === e.target));
        this._load();
      });
    });
    await this._loadInfo();
    this._loadSecurity();
    await this._load();
  },

  // v8.9.12-alpha.1 — Version & Security card (ported from SOS ESXi Monitor).
  async _loadSecurity() {
    const el = document.getElementById('vs-security-panel');
    if (!el) return;
    try {
      const data = await Api.getVSphereVersionCheck(this._hostId);
      const hosts = (data && data.hosts) || [];
      const withCheck = hosts.filter(h => h.check);
      if (!withCheck.length) { el.innerHTML = ''; return; }
      el.innerHTML = withCheck.map(h => this._renderSecurityCard(h)).join('');
    } catch { el.innerHTML = ''; }
  },

  _renderSecurityCard(h) {
    const c = h.check;
    // Status badge
    let badge, badgeColor;
    if (c.isEndOfLife) { badge = 'End of Life'; badgeColor = 'var(--red, #ef4444)'; }
    else if (!c.isUpToDate) { badge = 'Updates available'; badgeColor = 'var(--yellow, #eab308)'; }
    else { badge = 'Up to date'; badgeColor = 'var(--green, #22c55e)'; }
    const cveRows = (c.applicableCVEs || []).map(cve => {
      const sevColor = cve.severity === 'CRITICAL' ? 'var(--red, #ef4444)'
        : cve.severity === 'HIGH' ? 'var(--yellow, #eab308)' : 'var(--text-dim)';
      return `<tr>
        <td><code style="font-size:11px">${Utils.escapeHtml(cve.id)}</code></td>
        <td style="color:${sevColor};font-weight:600">${Utils.escapeHtml(cve.severity)} ${cve.cvssScore}</td>
        <td>${Utils.escapeHtml(cve.title)}</td>
        <td><code style="font-size:11px">${Utils.escapeHtml(cve.fixedInPatch || '—')}</code></td>
        <td>${Utils.escapeHtml(cve.advisory || '—')}</td>
      </tr>`;
    }).join('');
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div><i class="fas fa-shield-alt" style="margin-right:6px"></i><strong>Version &amp; Security</strong>
            ${Utils.escapeHtml(h.hostName)} — ESXi ${Utils.escapeHtml(h.version || '?')} (build ${Utils.escapeHtml(h.build || '?')})</div>
          <span class="badge" style="background:${badgeColor};color:#fff">${badge}</span>
        </div>
        <div class="card-body">
          <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:10px">
            <div><strong>Latest patch:</strong> ${Utils.escapeHtml(c.latestPatch)} ${c.latestBuild !== 'Unknown' ? `(build ${Utils.escapeHtml(c.latestBuild)})` : ''}</div>
            <div><strong>End of support:</strong> ${Utils.escapeHtml(c.endOfGeneralSupport)}${c.daysUntilEndOfSupport ? ` (${c.daysUntilEndOfSupport} days)` : ''}</div>
            <div><strong>CVEs:</strong> <span style="color:var(--red)">${c.criticalCVECount} critical</span> · <span style="color:var(--yellow)">${c.highCVECount} high</span></div>
          </div>
          ${(c.recommendations || []).map(r => `<div class="alert ${c.isEndOfLife ? 'alert-danger' : 'alert-warning'}" style="margin:4px 0;padding:8px 12px;font-size:13px"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(r)}</div>`).join('')}
          ${cveRows ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px">Known CVEs affecting this version (${(c.applicableCVEs || []).length})</summary>
            <table class="table" style="margin-top:8px"><thead><tr>
              <th>CVE</th><th>Severity</th><th>Title</th><th>Fixed in</th><th>Advisory</th>
            </tr></thead><tbody>${cveRows}</tbody></table></details>` : ''}
        </div>
      </div>
    `;
  },

  // Format an uptime in seconds as "Nd Nh" / "Nh Nm".
  _fmtUptime(sec) {
    if (!sec || sec <= 0) return '—';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },

  // Small inline percentage bar.
  _bar(pct) {
    if (pct === null || pct === undefined) return '—';
    const color = pct > 90 ? 'var(--red,#ef4444)' : pct > 75 ? 'var(--yellow,#eab308)' : 'var(--green,#22c55e)';
    return `<div style="display:flex;align-items:center;gap:6px">
      <div style="flex:0 0 60px;height:6px;background:var(--surface3,#e5e7eb);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${Math.min(100, pct)}%;background:${color}"></div></div>
      <span style="font-size:11px;color:${color}">${pct}%</span></div>`;
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
      const on = vm.powerState === 'poweredOn';
      const toolsColor = vm.toolsStatus === 'toolsOk' ? 'green'
        : (vm.toolsStatus && vm.toolsStatus.startsWith('toolsOld')) ? 'yellow' : 'var(--text-dim)';
      return `<tr>
        <td><strong>${Utils.escapeHtml(vm.name || '—')}</strong></td>
        <td style="color:${powerColor}">${Utils.escapeHtml(vm.powerState || '—')}</td>
        <td>${Utils.escapeHtml(vm.guestOS || '—')}</td>
        <td>${Utils.escapeHtml(vm.ipAddress || '—')}</td>
        <td style="color:${toolsColor};font-size:11px">${Utils.escapeHtml((vm.toolsStatus || '—').replace(/^tools/, ''))}</td>
        <td>${vm.numCPU || '—'}${on && vm.cpuUsageMHz ? ` <span style="color:var(--text-dim);font-size:10px">(${vm.cpuUsageMHz} MHz)</span>` : ''}</td>
        <td>${vm.memoryMB ? Utils.escapeHtml(String((vm.memoryMB / 1024).toFixed(1))) + ' GiB' : '—'}${on && vm.memoryUsageMB ? ` <span style="color:var(--text-dim);font-size:10px">(${(vm.memoryUsageMB / 1024).toFixed(1)} used)</span>` : ''}</td>
        <td>${vm.storageCommittedBytes ? Utils.escapeHtml(String((vm.storageCommittedBytes / (1024**3)).toFixed(1))) + ' GiB' : '—'}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Power</th><th>Guest OS</th><th>IP</th><th>Tools</th><th>vCPU</th><th>Memory</th><th>Storage</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderHosts(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No ESXi hosts.</div>`;
      return;
    }
    const rows = list.map(h => {
      const connColor = h.connectionState === 'connected' ? 'green' : 'red';
      const memGB = h.memoryBytes ? (h.memoryBytes / (1024**3)).toFixed(0) + ' GiB' : '—';
      return `<tr>
        <td><strong>${Utils.escapeHtml(h.name || '—')}</strong></td>
        <td style="color:${connColor}">${Utils.escapeHtml(h.connectionState || '—')}</td>
        <td>${this._bar(h.cpuPercent)}</td>
        <td>${this._bar(h.memoryPercent)}</td>
        <td>${this._fmtUptime(h.uptimeSeconds)}</td>
        <td>${Utils.escapeHtml(h.model || '—')}</td>
        <td>${h.cpuCores || '—'}c${h.cpuThreads ? '/' + h.cpuThreads + 't' : ''}</td>
        <td>${memGB}</td>
        <td>${Utils.escapeHtml(h.productVersion || '—')}${h.build ? ` <span style="color:var(--text-dim);font-size:10px">(${Utils.escapeHtml(h.build)})</span>` : ''}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Model</th><th>CPU cores</th><th>RAM</th><th>Version</th>
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
        <td>${this._bar(pct)}</td>
        <td>${d.maintenanceMode && d.maintenanceMode !== 'normal' ? `<span style="color:var(--yellow)">${Utils.escapeHtml(d.maintenanceMode)}</span>` : (d.accessible ? '✓' : '<span style="color:var(--red)">✗</span>')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Type</th><th>Capacity</th><th>Free</th><th>Used</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },
};
