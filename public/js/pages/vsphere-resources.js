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
  _vmFilter: 'all',   // all | running | stopped
  _svcFilter: 'all',  // all | running | stopped
  _vmsCache: [],
  _servicesCache: [],

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
        case 'datastores': {
          const [ds, vms] = await Promise.all([
            Api.getVSphereDatastores(this._hostId),
            Api.getVSphereVMs(this._hostId).catch(() => []),
          ]);
          this._renderDatastores(el, ds, vms);
          break;
        }
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

  // ─── VMs (elegant cards + running/stopped filter) ───────────
  _renderVMs(el, list) {
    if (list) this._vmsCache = list;
    list = this._vmsCache || [];
    if (!list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-desktop" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>No VMs.</div>`;
      return;
    }
    const running = list.filter(v => v.powerState === 'poweredOn').length;
    const stopped = list.length - running;
    const filtered = list.filter(v =>
      this._vmFilter === 'all' ? true :
      this._vmFilter === 'running' ? v.powerState === 'poweredOn' : v.powerState !== 'poweredOn');
    const sorted = [...filtered].sort((a, b) =>
      (b.powerState === 'poweredOn') - (a.powerState === 'poweredOn') || String(a.name).localeCompare(String(b.name)));

    const cards = sorted.map(vm => {
      const on = vm.powerState === 'poweredOn';
      const powerBadge = on
        ? `<span class="badge badge-running"><span class="badge-dot"></span>On</span>`
        : vm.powerState === 'poweredOff'
          ? `<span class="badge badge-dead"><span class="badge-dot"></span>Off</span>`
          : `<span class="badge badge-warning"><span class="badge-dot"></span>${Utils.escapeHtml((vm.powerState || '?').replace('powered', ''))}</span>`;
      const memPct = (on && vm.memoryMB) ? Math.min(100, Math.round((vm.memoryUsageMB / vm.memoryMB) * 100)) : null;
      const kv = (label, val) => `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px">
        <span style="color:var(--text-dim)">${label}</span><span style="text-align:right">${val}</span></div>`;
      return `<div class="card" style="padding:14px;flex:1 1 300px;min-width:280px;max-width:420px;opacity:${on ? '1' : '0.75'}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            <i class="${this._osIcon(vm.guestOS)}" style="font-size:20px;color:var(--text-dim);flex:0 0 auto"></i>
            <div style="min-width:0">
              <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(vm.name || '—')}</div>
              <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(vm.guestOS || '')}</div>
            </div>
          </div>
          ${powerBadge}
        </div>
        ${kv('IP', vm.ipAddress ? `<code style="font-size:11px">${Utils.escapeHtml(vm.ipAddress)}</code>` : '—')}
        ${kv('Tools', this._toolsBadge(vm.toolsStatus))}
        ${kv('CPU', `${vm.numCPU || '?'} vCPU${on && vm.cpuUsageMHz ? ` <span style="color:var(--text-dim)">· ${vm.cpuUsageMHz} MHz</span>` : ''}`)}
        <div style="padding:3px 0;font-size:12px">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Memory</span>
            <span>${vm.memoryMB ? (vm.memoryMB / 1024).toFixed(vm.memoryMB >= 1024 ? 0 : 1) + ' GiB' : '—'}</span></div>
          ${memPct !== null ? this._miniBar(memPct, 999) : ''}
        </div>
        ${kv('Storage', vm.storageCommittedBytes ? (vm.storageCommittedBytes / (1024 ** 3)).toFixed(1) + ' GiB' : '—')}
      </div>`;
    }).join('');

    el.innerHTML = this._filterBar('vm', { all: list.length, running, stopped })
      + `<div style="display:flex;gap:12px;flex-wrap:wrap">${cards || '<div class="empty-msg">No VMs match this filter.</div>'}</div>`;
    this._wireFilterBar(el, 'vm', () => this._renderVMs(el, null));
  },

  // Segmented All / Running (n) / Stopped (n) filter control.
  _filterBar(kind, counts) {
    const cur = kind === 'vm' ? this._vmFilter : this._svcFilter;
    const btn = (val, label) => `<button class="tab ${cur === val ? 'active' : ''}" data-filter="${val}" style="padding:5px 14px">${label}</button>`;
    return `<div class="tabs" data-filterbar="${kind}" style="margin-bottom:14px">
      ${btn('all', `All <span style="color:var(--text-dim)">${counts.all}</span>`)}
      ${btn('running', `Running <span style="color:var(--green)">${counts.running}</span>`)}
      ${btn('stopped', `Stopped <span style="color:var(--text-dim)">${counts.stopped}</span>`)}
    </div>`;
  },

  _wireFilterBar(el, kind, rerender) {
    el.querySelector(`[data-filterbar="${kind}"]`)?.querySelectorAll('[data-filter]').forEach(b => {
      b.addEventListener('click', () => {
        const v = b.getAttribute('data-filter');
        if (kind === 'vm') this._vmFilter = v; else this._svcFilter = v;
        rerender();
      });
    });
  },

  _toolsBadge(status) {
    if (!status) return '<span class="text-muted">—</span>';
    if (status === 'toolsOk') return `<span class="badge badge-running">OK</span>`;
    if (status.startsWith('toolsOld')) return `<span class="badge badge-warning">Outdated</span>`;
    if (status === 'toolsNotRunning') return `<span class="badge badge-dead">Not running</span>`;
    return `<span class="badge badge-dead">Not installed</span>`;
  },

  _osIcon(guestOS) {
    const s = (guestOS || '').toLowerCase();
    if (s.includes('windows')) return 'fab fa-windows';
    if (s.includes('ubuntu')) return 'fab fa-ubuntu';
    if (s.includes('debian')) return 'fab fa-debian';
    if (s.includes('red hat') || s.includes('rhel') || s.includes('centos') || s.includes('rocky') || s.includes('alma')) return 'fab fa-redhat';
    if (s.includes('suse')) return 'fab fa-suse';
    if (s.includes('linux')) return 'fab fa-linux';
    if (s.includes('freebsd') || s.includes('bsd')) return 'fab fa-freebsd';
    return 'fas fa-desktop';
  },

  _miniBar(pct, width = 70) {
    const color = pct > 90 ? 'var(--red,#ef4444)' : pct > 75 ? 'var(--yellow,#eab308)' : 'var(--green,#22c55e)';
    const track = width >= 999 ? 'flex:1' : `flex:0 0 ${width}px`;
    return `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
      <div style="${track};height:5px;background:var(--surface3,#e5e7eb);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${Math.min(100, pct)}%;background:${color}"></div></div>
      <span style="font-size:10px;color:var(--text-dim)">${pct}%</span></div>`;
  },

  // ─── Datastores (usage breakdown: VMs vs other vs free) ─────
  _renderDatastores(el, list, vms) {
    if (!list || !list.length) { el.innerHTML = `<div class="empty-msg">No datastores.</div>`; return; }
    vms = vms || [];
    // Attribute committed VM bytes to each datastore MoRef.
    const vmBytesByDs = {};
    for (const vm of vms) {
      for (const u of (vm.datastoreUsage || [])) {
        vmBytesByDs[u.datastore] = (vmBytesByDs[u.datastore] || 0) + (u.committed || 0);
      }
    }
    const GiB = (b) => (b / (1024 ** 3));
    const fmt = (b) => GiB(b) >= 1024 ? (GiB(b) / 1024).toFixed(1) + ' TiB' : GiB(b).toFixed(0) + ' GiB';

    // Cluster summary.
    const totCap = list.reduce((s, d) => s + (d.capacityBytes || 0), 0);
    const totFree = list.reduce((s, d) => s + (d.freeSpaceBytes || 0), 0);
    const totUsed = totCap - totFree;
    const totVM = list.reduce((s, d) => s + Math.min(vmBytesByDs[d.moref] || 0, (d.capacityBytes || 0) - (d.freeSpaceBytes || 0)), 0);
    const totOther = Math.max(0, totUsed - totVM);
    const summary = `
      <div class="card" style="padding:16px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong><i class="fas fa-hdd" style="margin-right:6px"></i>Storage usage — ${list.length} datastore(s)</strong>
          <span style="font-size:12px;color:var(--text-dim)">${fmt(totUsed)} of ${fmt(totCap)} used</span>
        </div>
        ${this._stackBar(totVM, totOther, totFree, totCap)}
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:10px;font-size:12px">
          ${this._legend('#3b82f6', 'Virtual machines', fmt(totVM))}
          ${this._legend('#9ca3af', 'Other (snapshots, ISOs, logs, swap)', fmt(totOther))}
          ${this._legend('var(--surface3,#e5e7eb)', 'Free', fmt(totFree))}
        </div>
      </div>`;

    const cards = list.map(d => {
      const cap = d.capacityBytes || 0, free = d.freeSpaceBytes || 0, used = cap - free;
      const vmB = Math.min(vmBytesByDs[d.moref] || 0, used);
      const otherB = Math.max(0, used - vmB);
      const pct = cap > 0 ? Math.round(100 * used / cap) : 0;
      const statusChip = d.maintenanceMode && d.maintenanceMode !== 'normal'
        ? `<span class="badge badge-warning" style="font-size:10px">${Utils.escapeHtml(d.maintenanceMode)}</span>`
        : (d.accessible ? '' : `<span class="badge badge-dead" style="font-size:10px">inaccessible</span>`);
      return `<div class="card" style="padding:16px;flex:1 1 300px;min-width:280px;max-width:460px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px">
          <div style="min-width:0"><strong>${Utils.escapeHtml(d.name || '—')}</strong>
            <span style="font-size:11px;color:var(--text-dim);margin-left:6px">${Utils.escapeHtml(d.type || '')}</span></div>
          <div style="display:flex;gap:6px;align-items:center;flex:0 0 auto">
            ${statusChip}
            <button class="btn btn-xs btn-secondary" data-ds-browse="${Utils.escapeHtml(d.name)}" title="Browse files"><i class="fas fa-folder-open"></i></button>
          </div>
        </div>
        ${this._stackBar(vmB, otherB, free, cap)}
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-top:8px">
          <span style="font-weight:600;color:${pct > 90 ? 'var(--red)' : pct > 75 ? 'var(--yellow)' : 'var(--green)'}">${pct}% used</span>
          <span style="color:var(--text-dim)">${fmt(used)} / ${fmt(cap)}</span>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11px">
          ${this._legend('#3b82f6', 'VMs', fmt(vmB))}
          ${this._legend('#9ca3af', 'Other', fmt(otherB))}
          ${this._legend('var(--surface3,#e5e7eb)', 'Free', fmt(free))}
        </div>
      </div>`;
    }).join('');
    el.innerHTML = summary + `<div style="display:flex;gap:12px;flex-wrap:wrap">${cards}</div>`;
    el.querySelectorAll('[data-ds-browse]').forEach(b =>
      b.addEventListener('click', () => this._openDatastoreBrowser(b.getAttribute('data-ds-browse'))));
  },

  // ─── v8.9.14-alpha.1 — Datastore file browser modal ─────────
  _openDatastoreBrowser(dsName) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="width:760px;max-width:95vw;height:600px;max-height:90vh;display:flex;flex-direction:column">
        <div class="modal-header">
          <h3><i class="fas fa-folder-open"></i> Datastore: ${Utils.escapeHtml(dsName)}</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div id="dsb-breadcrumbs" style="font-size:13px;display:flex;gap:4px;flex-wrap:wrap;align-items:center"></div>
          ${this._isAdmin() ? `<div><input type="file" id="dsb-file" style="display:none">
            <button class="btn btn-sm btn-secondary" id="dsb-upload"><i class="fas fa-upload"></i> Upload here</button></div>` : ''}
        </div>
        <div class="modal-body" style="flex:1;overflow:auto;padding:0"><div id="dsb-list"></div></div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    this._dsbState = { dsName, path: '' };
    // Upload wiring (admin only).
    const fileInput = modal.querySelector('#dsb-file');
    const uploadBtn = modal.querySelector('#dsb-upload');
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f) return;
        const dest = (this._dsbState.path ? this._dsbState.path + '/' : '') + f.name;
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading ${Utils.escapeHtml(f.name)}…`;
        try {
          await Api.uploadVSphereDatastoreFile(this._hostId, dsName, dest, f);
          Toast.success(`Uploaded ${f.name}`);
          this._loadDatastorePath(modal, dsName, this._dsbState.path);
        } catch (err) { Toast.error(err.message); }
        finally { uploadBtn.disabled = false; uploadBtn.innerHTML = `<i class="fas fa-upload"></i> Upload here`; fileInput.value = ''; }
      });
    }
    this._loadDatastorePath(modal, dsName, '');
  },

  _isAdmin() {
    return !!(window.App && App.user && App.user.role === 'admin');
  },

  async _loadDatastorePath(modal, dsName, path) {
    this._dsbState = { dsName, path };
    const admin = this._isAdmin();
    const listEl = modal.querySelector('#dsb-list');
    const crumbEl = modal.querySelector('#dsb-breadcrumbs');
    listEl.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    // Breadcrumbs
    const parts = path ? path.split('/').filter(Boolean) : [];
    const crumbs = [`<a href="#" data-dsb-path="" style="color:var(--accent)">${Utils.escapeHtml(dsName)}</a>`];
    let acc = '';
    for (const p of parts) { acc += (acc ? '/' : '') + p; crumbs.push(`<span style="color:var(--text-dim)">/</span><a href="#" data-dsb-path="${Utils.escapeHtml(acc)}" style="color:var(--accent)">${Utils.escapeHtml(p)}</a>`); }
    crumbEl.innerHTML = crumbs.join(' ');
    crumbEl.querySelectorAll('[data-dsb-path]').forEach(a => a.addEventListener('click', (e) => {
      e.preventDefault(); this._loadDatastorePath(modal, dsName, a.getAttribute('data-dsb-path'));
    }));

    try {
      const data = await Api.browseVSphereDatastore(this._hostId, dsName, path);
      const entries = data.entries || [];
      if (!entries.length) { listEl.innerHTML = `<div class="empty-msg">Empty folder.</div>`; return; }
      const delBtn = (childPath, isFolder) => admin
        ? `<button class="btn btn-xs btn-danger" data-del="${Utils.escapeHtml(childPath)}" data-folder="${isFolder ? 1 : 0}" title="Delete"><i class="fas fa-trash"></i></button>`
        : '';
      const rows = entries.map(en => {
        const childPath = path ? `${path}/${en.name}` : en.name;
        if (en.isFolder) {
          return `<tr>
            <td class="dsb-open" data-folder="${Utils.escapeHtml(childPath)}" style="cursor:pointer"><i class="fas fa-folder" style="color:var(--yellow);margin-right:8px"></i>${Utils.escapeHtml(en.name)}</td>
            <td></td><td>${en.modified ? new Date(en.modified).toLocaleString() : ''}</td><td style="text-align:right">${delBtn(childPath, true)}</td></tr>`;
        }
        const dlUrl = Api.vsphereDatastoreDownloadUrl(this._hostId, dsName, childPath);
        return `<tr>
          <td><i class="${this._fileIcon(en.name)}" style="color:var(--text-dim);margin-right:8px"></i>${Utils.escapeHtml(en.name)}</td>
          <td style="text-align:right;white-space:nowrap">${en.fileSize != null ? this._fmtBytes(en.fileSize) : ''}</td>
          <td style="white-space:nowrap">${en.modified ? new Date(en.modified).toLocaleString() : ''}</td>
          <td style="text-align:right;white-space:nowrap"><a class="btn btn-xs btn-secondary" href="${dlUrl}" title="Download"><i class="fas fa-download"></i></a> ${delBtn(childPath, false)}</td>
        </tr>`;
      }).join('');
      listEl.innerHTML = `<table class="table" style="margin:0"><thead><tr>
        <th>Name</th><th style="text-align:right">Size</th><th>Modified</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`;
      listEl.querySelectorAll('.dsb-open').forEach(r => r.addEventListener('click', () =>
        this._loadDatastorePath(modal, dsName, r.getAttribute('data-folder'))));
      listEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const target = b.getAttribute('data-del');
        if (!confirm(`Delete "${target}" from ${dsName}?\n\nThis is permanent.`)) return;
        try {
          await Api.deleteVSphereDatastoreFile(this._hostId, dsName, target);
          Toast.success('Deleted');
          this._loadDatastorePath(modal, dsName, path);
        } catch (err) { Toast.error(err.message); }
      }));
    } catch (err) {
      listEl.innerHTML = `<div class="empty-msg">Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _fmtBytes(b) {
    if (b == null) return '';
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GiB';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MiB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KiB';
    return b + ' B';
  },

  _fileIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.endsWith('.iso')) return 'fas fa-compact-disc';
    if (n.endsWith('.vmdk')) return 'fas fa-hdd';
    if (n.endsWith('.vmx') || n.endsWith('.vmsd') || n.endsWith('.vmxf')) return 'fas fa-file-code';
    if (n.endsWith('.log')) return 'fas fa-file-alt';
    if (n.endsWith('.nvram')) return 'fas fa-microchip';
    if (n.endsWith('.vswp')) return 'fas fa-exchange-alt';
    return 'fas fa-file';
  },

  // Stacked bar: VMs (blue) + other (gray) + free (track), scaled to total.
  _stackBar(vm, other, free, total) {
    if (!total) return '';
    const p = (b) => (100 * b / total).toFixed(2);
    return `<div style="display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--surface3,#e5e7eb)">
      <div style="width:${p(vm)}%;background:#3b82f6" title="VMs"></div>
      <div style="width:${p(other)}%;background:#9ca3af" title="Other"></div>
    </div>`;
  },

  _legend(color, label, value) {
    return `<span style="display:inline-flex;align-items:center;gap:6px">
      <span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block"></span>
      <span style="color:var(--text-dim)">${Utils.escapeHtml(label)}</span>
      <strong>${Utils.escapeHtml(value)}</strong></span>`;
  },

  // ─── Network (table) ────────────────────────────────────────
  _renderNetworks(el, list) {
    if (!list || !list.length) { el.innerHTML = `<div class="empty-msg">No networks.</div>`; return; }
    el.innerHTML = `<table class="table"><thead><tr><th>Name</th><th>Accessible</th></tr></thead><tbody>${
      list.map(n => `<tr><td><strong>${Utils.escapeHtml(n.name || '—')}</strong></td>
        <td>${n.accessible ? '✓' : '<span style="color:var(--red)">✗</span>'}</td></tr>`).join('')
    }</tbody></table>`;
  },

  // ─── Services (auto-arranging cards + running/stopped filter) ─
  _renderServices(el, list) {
    if (list) this._servicesCache = list;
    list = this._servicesCache || [];
    if (!list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-cogs" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>No services (or read denied on this host).</div>`;
      return;
    }
    const running = list.filter(s => s.running).length;
    const stopped = list.length - running;
    const filtered = list.filter(s =>
      this._svcFilter === 'all' ? true : this._svcFilter === 'running' ? s.running : !s.running);
    const sorted = [...filtered].sort((a, b) => (b.running - a.running) || String(a.label || a.key).localeCompare(String(b.label || b.key)));
    const policyLabel = (p) =>
      (p === 'on' || p === 'automatic') ? `<span class="badge badge-info">Automatic</span>`
      : p === 'off' ? `<span class="badge badge-dead">Disabled</span>`
      : `<span class="text-muted" style="font-size:11px">${Utils.escapeHtml(p || 'manual')}</span>`;

    const cards = sorted.map(s => `
      <div class="card" style="padding:14px;flex:1 1 240px;min-width:220px;max-width:340px;display:flex;flex-direction:column;gap:10px;border-left:3px solid ${s.running ? 'var(--green,#22c55e)' : 'var(--border,#d1d5db)'}">
        <div style="display:flex;align-items:center;gap:10px">
          <i class="${this._serviceIcon(s.key)}" style="font-size:18px;color:var(--text-dim)"></i>
          <div style="min-width:0">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(s.label || s.key || '—')}</div>
            <div style="font-size:11px;color:var(--text-dim)"><code>${Utils.escapeHtml(s.key || '')}</code>${s.required ? ' · required' : ''}</div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          ${s.running
            ? `<span class="badge badge-running"><span class="badge-dot"></span>Running</span>`
            : `<span class="badge badge-dead"><span class="badge-dot"></span>Stopped</span>`}
          ${policyLabel(s.policy)}
        </div>
        ${this._isAdmin() ? `<div style="display:flex;gap:6px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:8px">
          ${s.running
            ? `<button class="btn btn-xs btn-secondary" data-svc="stop" data-key="${Utils.escapeHtml(s.key)}" title="Stop"><i class="fas fa-stop"></i></button>
               <button class="btn btn-xs btn-secondary" data-svc="restart" data-key="${Utils.escapeHtml(s.key)}" title="Restart"><i class="fas fa-redo"></i></button>`
            : `<button class="btn btn-xs btn-secondary" data-svc="start" data-key="${Utils.escapeHtml(s.key)}" title="Start"><i class="fas fa-play"></i></button>`}
        </div>` : ''}
      </div>`).join('');

    el.innerHTML = this._filterBar('svc', { all: list.length, running, stopped })
      + `<div style="display:flex;gap:12px;flex-wrap:wrap">${cards || '<div class="empty-msg">No services match this filter.</div>'}</div>`;
    this._wireFilterBar(el, 'svc', () => this._renderServices(el, null));
    el.querySelectorAll('[data-svc]').forEach(b => b.addEventListener('click', async () => {
      const action = b.getAttribute('data-svc'), key = b.getAttribute('data-key');
      if ((action === 'stop') && key === 'TSM-SSH' && !confirm('Stop the SSH service? You may lose SSH access to this host.')) return;
      b.disabled = true;
      try {
        await Api.vsphereServiceAction(this._hostId, action, key);
        Toast.success(`Service ${key}: ${action} ok`);
        this._renderServices(el, await Api.getVSphereServices(this._hostId));
      } catch (err) { Toast.error(err.message); b.disabled = false; }
    }));
  },

  _serviceIcon(key) {
    const k = (key || '').toLowerCase();
    if (k.includes('ssh') || k === 'tsm-ssh') return 'fas fa-terminal';
    if (k.includes('ntp')) return 'fas fa-clock';
    if (k.includes('shell') || k === 'tsm') return 'fas fa-terminal';
    if (k.includes('snmp')) return 'fas fa-network-wired';
    if (k.includes('firewall') || k.includes('esxi-firewall')) return 'fas fa-fire';
    if (k.includes('slp')) return 'fas fa-server';
    if (k.includes('dcui')) return 'fas fa-desktop';
    if (k.includes('syslog')) return 'fas fa-file-alt';
    return 'fas fa-cog';
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
