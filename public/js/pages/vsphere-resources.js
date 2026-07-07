/* ═══════════════════════════════════════════════════
   pages/vsphere-resources.js — VMware vSphere / ESXi
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.13-alpha.1 — card-forward vSphere / ESXi page (inspired by the SOS
// ESXi Monitor). Read-only. Tabs: Overview / VMs / Datastores / Network /
// Services / Trends. Gated in the sidebar via data-fleet-daemon="vsphere".
// All data comes from the hand-rolled stdlib-https SOAP client — no deps.

const VSphereResourcesPage = {
  _tab: 'overview',
  _hostId: null,      // resolved vSphere host id (NOT the global selection)
  _hosts: [],         // all registered vSphere hosts

  async render(container) {
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
    // Prefer the globally-selected host if it's a vSphere host.
    const globalId = Api.getHostId();
    if (this._hosts.some(h => h.id === globalId)) this._hostId = globalId;
    else if (!this._hostId || !this._hosts.some(h => h.id === this._hostId)) this._hostId = this._hosts[0].id;

    const hostSelector = this._hosts.length > 1
      ? `<select id="vs-host" class="form-control" style="width:auto;display:inline-block;margin-right:8px">
           ${this._hosts.map(h => `<option value="${h.id}"${h.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(h.name)}</option>`).join('')}
         </select>`
      : `<span class="text-muted" style="margin-right:8px">${Utils.escapeHtml(this._hosts[0].name)}</span>`;

    const tabs = [
      ['overview', 'Overview'], ['vms', 'VMs'], ['datastores', 'Datastores'],
      ['network', 'Network'], ['services', 'Services'], ['trends', 'Trends'],
    ];
    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-server"></i> VMware vSphere / ESXi <span class="badge badge-warning">alpha</span></h1>
        <div>
          ${hostSelector}
          <button class="btn btn-sm btn-secondary" id="vs-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div class="tabs" style="margin-bottom:16px">
        ${tabs.map(([id, label]) => `<button class="tab ${id === this._tab ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}
      </div>
      <div id="vs-tab-container">Loading...</div>
    `;
    const hostSel = container.querySelector('#vs-host');
    if (hostSel) hostSel.addEventListener('change', (e) => { this._hostId = parseInt(e.target.value, 10); this._load(); });
    container.querySelector('#vs-refresh').addEventListener('click', () => this._load());
    container.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._tab = e.target.getAttribute('data-tab');
        container.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === e.target));
        this._load();
      });
    });
    await this._load();
  },

  async _load() {
    const el = document.getElementById('vs-tab-container');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading ${Utils.escapeHtml(this._tab)}...</div>`;
    try {
      switch (this._tab) {
        case 'overview':   await this._renderOverview(el); break;
        case 'vms':        this._renderVMs(el, await Api.getVSphereVMs(this._hostId)); break;
        case 'datastores': this._renderDatastores(el, await Api.getVSphereDatastores(this._hostId)); break;
        case 'network':    this._renderNetworks(el, await Api.getVSphereNetworks(this._hostId)); break;
        case 'services':   this._renderServices(el, await Api.getVSphereServices(this._hostId)); break;
        case 'trends':     this._renderTrends(el, await Api.getVSphereHistory(this._hostId, 500)); break;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error loading ${Utils.escapeHtml(this._tab)}: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // ─── Overview (cards) ───────────────────────────────────────
  async _renderOverview(el) {
    const [info, hosts, vms, datastores, hostInfo, security] = await Promise.all([
      Api.getVSphereInfo(this._hostId).catch(() => ({})),
      Api.getVSphereHosts(this._hostId).catch(() => []),
      Api.getVSphereVMs(this._hostId).catch(() => []),
      Api.getVSphereDatastores(this._hostId).catch(() => []),
      Api.getVSphereHostInfo(this._hostId).catch(() => null),
      Api.getVSphereVersionCheck(this._hostId).catch(() => ({ hosts: [] })),
    ]);

    const vmRunning = vms.filter(v => v.powerState === 'poweredOn').length;
    const dsCap = datastores.reduce((s, d) => s + (d.capacityBytes || 0), 0);
    const dsFree = datastores.reduce((s, d) => s + (d.freeSpaceBytes || 0), 0);
    const dsUsedGB = ((dsCap - dsFree) / (1024 ** 3)).toFixed(0);
    const dsCapGB = (dsCap / (1024 ** 3)).toFixed(0);
    const maxUptime = hosts.length ? Math.max(...hosts.map(h => h.uptimeSeconds || 0)) : 0;

    const stat = (icon, label, value, sub) => `
      <div class="card" style="padding:16px;flex:1;min-width:160px">
        <div style="color:var(--text-dim);font-size:12px;text-transform:uppercase;letter-spacing:.5px"><i class="fas ${icon}"></i> ${label}</div>
        <div style="font-size:28px;font-weight:700;margin-top:6px">${value}</div>
        ${sub ? `<div style="font-size:12px;color:var(--text-dim);margin-top:2px">${sub}</div>` : ''}
      </div>`;

    const statsRow = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      ${stat('fa-server', 'ESXi Hosts', hosts.length, Utils.escapeHtml(info.productFullName || 'vSphere'))}
      ${stat('fa-desktop', 'Virtual Machines', `${vmRunning}<span style="font-size:16px;color:var(--text-dim)">/${vms.length}</span>`, 'running / total')}
      ${stat('fa-hdd', 'Storage', `${dsUsedGB}<span style="font-size:16px;color:var(--text-dim)"> / ${dsCapGB} GiB</span>`, `${datastores.length} datastore(s)`)}
      ${stat('fa-clock', 'Uptime', this._fmtUptime(maxUptime), 'longest host')}
    </div>`;

    // Per-host gauge cards (CPU% + Mem% bars).
    const gaugeCards = hosts.map(h => `
      <div class="card" style="padding:16px;flex:1;min-width:280px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong>${Utils.escapeHtml(h.name)}</strong>
          <span class="badge" style="background:${h.connectionState === 'connected' ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)'};color:#fff;font-size:10px">${Utils.escapeHtml(h.connectionState || '?')}</span>
        </div>
        <div style="margin-bottom:10px">${this._gauge('CPU', h.cpuPercent, `${h.cpuUsageMHz || 0} / ${h.cpuTotalMHz || 0} MHz`)}</div>
        <div style="margin-bottom:10px">${this._gauge('Memory', h.memoryPercent, `${(h.memoryUsageMB / 1024).toFixed(1)} / ${(h.memoryTotalMB / 1024).toFixed(0)} GiB`)}</div>
        <div style="font-size:12px;color:var(--text-dim);display:flex;justify-content:space-between">
          <span>${h.cpuCores || '?'}c / ${h.cpuThreads || '?'}t · ESXi ${Utils.escapeHtml(h.productVersion || '?')}</span>
          <span>${this._fmtUptime(h.uptimeSeconds)}</span>
        </div>
      </div>`).join('');

    el.innerHTML = statsRow
      + `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">${gaugeCards}</div>`
      + this._renderHostDetailsCard(info, hostInfo)
      + ((security.hosts || []).filter(h => h.check).map(h => this._renderSecurityCard(h)).join(''));
  },

  _renderHostDetailsCard(info, hi) {
    const row = (label, val) => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text-dim)">${label}</span><span style="text-align:right">${val && String(val) !== 'null' ? Utils.escapeHtml(String(val)) : '—'}</span></div>`;
    hi = hi || {};
    const left = [
      row('Product', info.productFullName || info.productName),
      row('Version', `${info.version || '?'} (build ${info.build || '?'})`),
      row('API', info.apiVersion),
      row('Vendor', hi.vendor),
      row('Model', hi.model),
      row('Serial', hi.serialNumber),
    ].join('');
    const right = [
      row('Hostname', hi.hostName ? `${hi.hostName}${hi.domainName ? '.' + hi.domainName : ''}` : null),
      row('DNS', (hi.dnsServers || []).join(', ')),
      row('NTP', (hi.ntpServers || []).join(', ')),
      row('BIOS', hi.biosVersion ? `${hi.biosVersion}${hi.biosReleaseDate ? ' (' + String(hi.biosReleaseDate).slice(0, 10) + ')' : ''}` : null),
      row('Boot time', hi.bootTime ? new Date(hi.bootTime).toLocaleString() : null),
      row('License', hi.license ? `${hi.license.name || ''} ${hi.license.key || ''}`.trim() : null),
    ].join('');
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-header"><i class="fas fa-info-circle" style="margin-right:6px"></i><strong>Host Details</strong></div>
      <div class="card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:0 32px">
        <div>${left}</div><div>${right}</div>
      </div></div>`;
  },

  // ─── Version & Security card ─────────────────────────────────
  _renderSecurityCard(h) {
    const c = h.check;
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
            — ${Utils.escapeHtml(h.hostName)} · ESXi ${Utils.escapeHtml(h.version || '?')} (build ${Utils.escapeHtml(h.build || '?')})</div>
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
      </div>`;
  },

  // ─── VMs (table) ────────────────────────────────────────────
  _renderVMs(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-desktop" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>No VMs.</div>`;
      return;
    }
    const rows = list.map(vm => {
      const powerColor = vm.powerState === 'poweredOn' ? 'var(--green)' : vm.powerState === 'poweredOff' ? 'var(--text-dim)' : 'var(--yellow)';
      const on = vm.powerState === 'poweredOn';
      const toolsColor = vm.toolsStatus === 'toolsOk' ? 'var(--green)'
        : (vm.toolsStatus && vm.toolsStatus.startsWith('toolsOld')) ? 'var(--yellow)' : 'var(--text-dim)';
      return `<tr>
        <td><strong>${Utils.escapeHtml(vm.name || '—')}</strong></td>
        <td style="color:${powerColor}">${Utils.escapeHtml((vm.powerState || '—').replace('powered', ''))}</td>
        <td>${Utils.escapeHtml(vm.guestOS || '—')}</td>
        <td>${Utils.escapeHtml(vm.ipAddress || '—')}</td>
        <td style="color:${toolsColor};font-size:11px">${Utils.escapeHtml((vm.toolsStatus || '—').replace(/^tools/, ''))}</td>
        <td>${vm.numCPU || '—'}${on && vm.cpuUsageMHz ? ` <span style="color:var(--text-dim);font-size:10px">(${vm.cpuUsageMHz} MHz)</span>` : ''}</td>
        <td>${vm.memoryMB ? (vm.memoryMB / 1024).toFixed(1) + ' GiB' : '—'}${on && vm.memoryUsageMB ? ` <span style="color:var(--text-dim);font-size:10px">(${(vm.memoryUsageMB / 1024).toFixed(1)} used)</span>` : ''}</td>
        <td>${vm.storageCommittedBytes ? (vm.storageCommittedBytes / (1024 ** 3)).toFixed(1) + ' GiB' : '—'}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Power</th><th>Guest OS</th><th>IP</th><th>Tools</th><th>vCPU</th><th>Memory</th><th>Storage</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  // ─── Datastores (cards) ─────────────────────────────────────
  _renderDatastores(el, list) {
    if (!list || !list.length) { el.innerHTML = `<div class="empty-msg">No datastores.</div>`; return; }
    el.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">` + list.map(d => {
      const cap = d.capacityBytes || 0, free = d.freeSpaceBytes || 0, used = cap - free;
      const pct = cap > 0 ? Math.round(100 * used / cap) : 0;
      const color = pct > 90 ? 'var(--red,#ef4444)' : pct > 75 ? 'var(--yellow,#eab308)' : 'var(--green,#22c55e)';
      const statusChip = d.maintenanceMode && d.maintenanceMode !== 'normal'
        ? `<span class="badge" style="background:var(--yellow);color:#fff;font-size:10px">${Utils.escapeHtml(d.maintenanceMode)}</span>`
        : (d.accessible ? '' : `<span class="badge" style="background:var(--red);color:#fff;font-size:10px">inaccessible</span>`);
      return `<div class="card" style="padding:16px;flex:1;min-width:260px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${Utils.escapeHtml(d.name || '—')}</strong>
          <span style="font-size:11px;color:var(--text-dim)">${Utils.escapeHtml(d.type || '')}</span>
        </div>
        <div style="height:10px;background:var(--surface3,#e5e7eb);border-radius:5px;overflow:hidden;margin-bottom:6px">
          <div style="height:100%;width:${Math.min(100, pct)}%;background:${color}"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span style="color:${color};font-weight:600">${pct}% used</span>
          <span style="color:var(--text-dim)">${(used / (1024 ** 3)).toFixed(0)} / ${(cap / (1024 ** 3)).toFixed(0)} GiB</span>
        </div>
        ${statusChip ? `<div style="margin-top:8px">${statusChip}</div>` : ''}
      </div>`;
    }).join('') + `</div>`;
  },

  // ─── Network (table) ────────────────────────────────────────
  _renderNetworks(el, list) {
    if (!list || !list.length) { el.innerHTML = `<div class="empty-msg">No networks.</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr><th>Name</th><th>Accessible</th></tr></thead><tbody>${
      list.map(n => `<tr><td><strong>${Utils.escapeHtml(n.name || '—')}</strong></td>
        <td>${n.accessible ? '✓' : '<span style="color:var(--red)">✗</span>'}</td></tr>`).join('')
    }</tbody></table>`;
  },

  // ─── Services (table) ───────────────────────────────────────
  _renderServices(el, list) {
    if (!list || !list.length) { el.innerHTML = `<div class="empty-msg">No services (or read denied on this host).</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Service</th><th>Key</th><th>Running</th><th>Startup policy</th>
    </tr></thead><tbody>${list.map(s => `<tr>
      <td><strong>${Utils.escapeHtml(s.label || s.key || '—')}</strong></td>
      <td><code style="font-size:11px">${Utils.escapeHtml(s.key || '—')}</code></td>
      <td style="color:${s.running ? 'var(--green)' : 'var(--text-dim)'}">${s.running ? 'running' : 'stopped'}</td>
      <td>${Utils.escapeHtml(s.policy || '—')}</td>
    </tr>`).join('')}</tbody></table>`;
  },

  // ─── Trends (inline SVG sparkline — no chart lib) ───────────
  _renderTrends(el, history) {
    if (!history || history.length < 2) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-chart-area" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>
        Not enough history yet. The poller records a snapshot every few minutes — check back later.</div>`;
      return;
    }
    const W = 800, H = 240, PAD = 30;
    const n = history.length;
    const x = (i) => PAD + (i / (n - 1)) * (W - 2 * PAD);
    const y = (pct) => PAD + (1 - (Math.max(0, Math.min(100, pct || 0)) / 100)) * (H - 2 * PAD);
    const line = (key, color) => {
      const pts = history.map((s, i) => `${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" />`;
    };
    const gridY = [0, 25, 50, 75, 100].map(p => `
      <line x1="${PAD}" y1="${y(p)}" x2="${W - PAD}" y2="${y(p)}" stroke="var(--border,#e5e7eb)" stroke-width="1" />
      <text x="4" y="${y(p) + 4}" font-size="10" fill="var(--text-dim,#888)">${p}%</text>`).join('');
    const first = history[0].captured_at, last = history[n - 1].captured_at;
    el.innerHTML = `
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>CPU &amp; Memory — last ${n} snapshots</strong>
          <span style="font-size:12px"><span style="color:#ef4444">■</span> CPU% &nbsp; <span style="color:#3b82f6">■</span> Memory%</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:280px">
          ${gridY}
          ${line('cpu_pct', '#ef4444')}
          ${line('mem_pct', '#3b82f6')}
        </svg>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-top:4px">
          <span>${first ? new Date(first).toLocaleString() : ''}</span>
          <span>${last ? new Date(last).toLocaleString() : ''}</span>
        </div>
      </div>`;
  },

  // ─── helpers ────────────────────────────────────────────────
  _gauge(label, pct, sub) {
    const has = pct !== null && pct !== undefined;
    const color = !has ? 'var(--text-dim)' : pct > 90 ? 'var(--red,#ef4444)' : pct > 75 ? 'var(--yellow,#eab308)' : 'var(--green,#22c55e)';
    return `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span style="color:var(--text-dim)">${label}</span><span style="color:${color};font-weight:600">${has ? pct + '%' : '—'}</span></div>
      <div style="height:8px;background:var(--surface3,#e5e7eb);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${has ? Math.min(100, pct) : 0}%;background:${color}"></div></div>
      ${sub ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">${Utils.escapeHtml(sub)}</div>` : ''}`;
  },

  _fmtUptime(sec) {
    if (!sec || sec <= 0) return '—';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },
};
