/* ═══════════════════════════════════════════════════
   pages/multihost.js — Multi-Host Overview
   ESXi/vCenter-style unified view of all Docker hosts
   ═══════════════════════════════════════════════════ */
'use strict';

const MultiHostPage = {
  _data: null,
  _tab: 'host', // 'host' | 'stack'
  _refreshTimer: null,
  _collapsed: {}, // track collapsed stack groups: key = "hostId:stackName" or "stack:stackName"
  _searchFilter: '', // current search string
  _hostView: 'tabs', // 'list' | 'tabs' — Tab View is the default per user request 2026-04-20
  _groupFilter: 'all',
  _groups: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-network-wired" style="color:var(--accent)"></i> Multi-Host Overview</h2>
        <div class="page-actions">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" id="mh-search" placeholder="Filter hosts, stacks, containers...">
          </div>
          <div class="tabs" style="margin:0">
            <button class="tab ${this._tab === 'host' ? 'active' : ''}" data-mh-tab="host">
              <i class="fas fa-server" style="margin-right:4px"></i>By Host
            </button>
            <span id="mh-host-view-toggle" style="display:${this._tab === 'host' ? 'flex' : 'none'};gap:2px;align-items:center;margin:0 2px">
              <button class="btn-icon view-toggle ${this._hostView === 'list' ? 'active' : ''}" data-host-view="list" title="List view" style="width:28px;height:28px;font-size:12px"><i class="fas fa-bars"></i></button>
              <button class="btn-icon view-toggle ${this._hostView === 'tabs' ? 'active' : ''}" data-host-view="tabs" title="Tab view" style="width:28px;height:28px;font-size:12px"><i class="fas fa-folder"></i></button>
            </span>
            <button class="tab ${this._tab === 'stack' ? 'active' : ''}" data-mh-tab="stack">
              <i class="fas fa-layer-group" style="margin-right:4px"></i>By Stack
            </button>
          </div>
          <button class="btn-icon view-toggle" id="mh-collapse" title="Collapse all"><i class="fas fa-compress-alt"></i></button>
          <button class="btn-icon view-toggle" id="mh-expand" title="Expand all"><i class="fas fa-expand-alt"></i></button>
          <button class="btn btn-sm btn-secondary" id="mh-refresh" title="Refresh"><i class="fas fa-sync-alt"></i></button>
          ${App.user?.role === 'admin' ? '<button class="btn btn-sm btn-primary" id="mh-bulk"><i class="fas fa-layer-group"></i> Bulk actions</button>' : ''}
          <button class="prune-help-btn" id="mh-guide" title="Actions guide" style="background:var(--accent);color:#fff;border-color:var(--accent)">i</button>
        </div>
      </div>
      <div id="mh-group-filters" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>
      <div id="mh-stats" style="margin-bottom:16px"></div>
      <div id="mh-content"><div class="text-muted" style="padding:20px"><i class="fas fa-spinner fa-spin"></i> Loading hosts...</div></div>
    `;

    container.querySelectorAll('[data-mh-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._tab = btn.dataset.mhTab;
        container.querySelectorAll('[data-mh-tab]').forEach(b => {
          b.classList.toggle('active', b.dataset.mhTab === this._tab);
        });
        // Show/hide host view toggle based on active tab
        const toggle = document.getElementById('mh-host-view-toggle');
        if (toggle) toggle.style.display = this._tab === 'host' ? 'flex' : 'none';
        this._renderContent();
        this._applySearch(this._searchFilter);
      });
    });

    // Host view toggle (list vs tabs)
    container.querySelectorAll('[data-host-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._hostView = btn.dataset.hostView;
        container.querySelectorAll('[data-host-view]').forEach(b => b.classList.toggle('active', b.dataset.hostView === this._hostView));
        this._renderContent();
        this._applySearch(this._searchFilter);
      });
    });

    container.querySelector('#mh-refresh').addEventListener('click', () => this._load());
    container.querySelector('#mh-bulk')?.addEventListener('click', () => this._showBulkActions());
    container.querySelector('#mh-guide')?.addEventListener('click', () => this._showGuide());

    container.querySelector('#mh-collapse').addEventListener('click', () => {
      document.querySelectorAll('[data-mh-stack-toggle]').forEach(btn => {
        const key = btn.dataset.mhStackToggle;
        this._collapsed[key] = true;
        const body = document.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);
        if (body) body.style.display = 'none';
        const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
        if (icon) icon.className = 'fas fa-chevron-right';
      });
      document.querySelectorAll('[data-mh-stack-host-toggle]').forEach(btn => {
        const key = btn.dataset.mhStackHostToggle;
        this._collapsed[key] = true;
        const body = document.querySelector(`[data-mh-stack-host-body="${CSS.escape(key)}"]`);
        if (body) body.style.display = 'none';
        const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
        if (icon) icon.className = 'fas fa-chevron-right';
      });
    });

    container.querySelector('#mh-expand').addEventListener('click', () => {
      document.querySelectorAll('[data-mh-stack-toggle]').forEach(btn => {
        const key = btn.dataset.mhStackToggle;
        this._collapsed[key] = false;
        const body = document.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);
        if (body) body.style.display = '';
        const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
        if (icon) icon.className = 'fas fa-chevron-down';
      });
      document.querySelectorAll('[data-mh-stack-host-toggle]').forEach(btn => {
        const key = btn.dataset.mhStackHostToggle;
        this._collapsed[key] = false;
        const body = document.querySelector(`[data-mh-stack-host-body="${CSS.escape(key)}"]`);
        if (body) body.style.display = '';
        const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
        if (icon) icon.className = 'fas fa-chevron-down';
      });
    });

    container.querySelector('#mh-search').addEventListener('input',
      Utils.debounce(e => {
        this._searchFilter = (e.target.value || '').toLowerCase().trim();
        this._applySearch(this._searchFilter);
      }, 200));

    await this._load();
    this._refreshTimer = setInterval(() => this._load(), 15000);
  },

  async _load() {
    try {
      [this._data, this._groups] = await Promise.all([
        Api.getMultiHostOverview(), Api.listHostGroups().catch(() => []),
      ]);
      this._renderGroupFilters();
      this._renderStats();
      this._loadRecommendations();
      this._renderContent();
      this._applySearch(this._searchFilter);
    } catch (err) {
      const el = document.getElementById('mh-content');
      if (el) el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _loadRecommendations() {
    try {
      const data = await Api.get('/recommendations/balancing');
      const recs = data.recommendations || [];
      const statsEl = document.getElementById('mh-stats');
      if (!statsEl) return;

      // Remove existing recommendations
      document.getElementById('mh-recommendations')?.remove();

      if (recs.length === 0 || (recs.length === 1 && recs[0].type === 'balanced')) return;

      const recDiv = document.createElement('div');
      recDiv.id = 'mh-recommendations';
      recDiv.style.cssText = 'margin-bottom:16px';
      recDiv.innerHTML = `
        <div class="card">
          <div class="card-header" style="display:flex;align-items:center;gap:8px">
            <i class="fas fa-balance-scale" style="color:var(--yellow)"></i>
            <h3 style="margin:0">Balancing Recommendations</h3>
          </div>
          <div class="card-body" style="padding:10px 14px">
            ${recs.map(r => {
              const icon = r.severity === 'critical' ? 'fa-exclamation-circle' : r.severity === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
              const color = r.severity === 'critical' ? 'var(--red)' : r.severity === 'warning' ? 'var(--yellow)' : 'var(--accent)';
              return `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                <i class="fas ${icon}" style="color:${color};margin-top:2px"></i>
                <span style="font-size:13px">${Utils.escapeHtml(r.message)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      `;
      statsEl.after(recDiv);
    } catch { /* recommendations not available */ }
  },

  _renderStats() {
    const el = document.getElementById('mh-stats');
    if (!el || !this._data) return;
    const hosts = this._filteredHosts();
    const totals = {
      hosts: hosts.length,
      healthyHosts: hosts.filter(host => host.healthy).length,
      containers: hosts.reduce((sum, host) => sum + host.counts.total, 0),
      running: hosts.reduce((sum, host) => sum + host.counts.running, 0),
      images: hosts.reduce((sum, host) => sum + host.counts.images, 0),
    };
    const stopped = totals.containers - totals.running;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
        <div class="stat-card" style="padding:10px 12px">
          <div class="stat-icon blue" style="width:32px;height:32px;font-size:14px"><i class="fas fa-server"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:20px">${totals.hosts} <span style="font-size:11px;color:var(--text-muted);font-weight:400">/ ${totals.healthyHosts} online</span></div>
            <div class="stat-label" style="font-size:11px">Hosts</div>
          </div>
        </div>
        <div class="stat-card" style="padding:10px 12px">
          <div class="stat-icon purple" style="width:32px;height:32px;font-size:14px"><i class="fas fa-cube"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:20px">${totals.containers}</div>
            <div class="stat-label" style="font-size:11px">Total Containers</div>
          </div>
        </div>
        <div class="stat-card" style="padding:10px 12px">
          <div class="stat-icon green" style="width:32px;height:32px;font-size:14px"><i class="fas fa-play-circle"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:20px">${totals.running}</div>
            <div class="stat-label" style="font-size:11px">Running</div>
          </div>
        </div>
        <div class="stat-card" style="padding:10px 12px">
          <div class="stat-icon red" style="width:32px;height:32px;font-size:14px"><i class="fas fa-stop-circle"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:20px">${stopped}</div>
            <div class="stat-label" style="font-size:11px">Stopped</div>
          </div>
        </div>
        <div class="stat-card" style="padding:10px 12px">
          <div class="stat-icon volumes" style="width:32px;height:32px;font-size:14px"><i class="fas fa-layer-group"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:20px">${totals.images}</div>
            <div class="stat-label" style="font-size:11px">Total Images</div>
          </div>
        </div>
      </div>
    `;
  },

  _renderContent() {
    if (!this._data) return;
    if (this._tab === 'host') {
      this._renderByHost();
    } else {
      this._renderByStack();
    }
  },

  // ─── By Host view ────────────────────────────────

  _renderByHost() {
    const el = document.getElementById('mh-content');
    if (!el) return;

    const hosts = this._filteredHosts();
    if (!hosts.length) {
      el.innerHTML = '<div class="empty-msg">No hosts match this group.</div>';
      return;
    }

    // Tab view: show host tabs at top, render one host at a time
    if (this._hostView === 'tabs') {
      this._renderByHostTabs(el);
      return;
    }

    el.innerHTML = hosts.map(host => this._renderHostCard(host)).join('');

    // Attach stack toggle events
    el.querySelectorAll('[data-mh-stack-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mhStackToggle;
        this._collapsed[key] = !this._collapsed[key];
        const body = el.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);
        if (body) {
          body.style.display = this._collapsed[key] ? 'none' : '';
          const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
          if (icon) {
            icon.className = this._collapsed[key] ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
          }
        }
      });
    });

    // Reconnect an offline host card
    el.querySelectorAll('.mh-reconnect-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const hostId = parseInt(btn.dataset.hostId, 10);
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reconnecting…';
        if (btn.dataset.daemon === 'vsphere') { try { await Api.reconnectVSphere(hostId); } catch { /* reload surfaces errors */ } }
        if (btn.dataset.daemon === 'xen') { try { await Api.reconnectXen(hostId); } catch { /* reload surfaces errors */ } }
        await this._load();
      });
    });

    // Container click — switch host context and navigate
    el.querySelectorAll('[data-mh-container]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const hostId = parseInt(link.dataset.mhHostId);
        const cid = link.dataset.mhContainer;
        Api.setHost(hostId);
        App.navigate('/containers/' + cid);
      });
    });

    // Stack click — switch host context and navigate
    el.querySelectorAll('[data-mh-stack-nav]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const hostId = parseInt(link.dataset.mhHostId);
        Api.setHost(hostId);
        App.navigate('/containers');
      });
    });

    // Drain host button
    el.querySelectorAll('.mh-drain-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const hostId = btn.dataset.hostId;
        const ok = await Modal.confirm('Put this host in maintenance mode? All non-system containers will be stopped.', { danger: true, confirmText: 'Drain Host' });
        if (!ok) return;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Draining...';
        try {
          const result = await Api.drainHost(hostId);
          Toast.success(`Host drained: ${result.totalStopped} containers stopped`);
          await this._load();
        } catch (err) { Toast.error(err.message); btn.disabled = false; btn.innerHTML = '<i class="fas fa-pause"></i> Drain'; }
      });
    });

    // Activate host button
    el.querySelectorAll('.mh-activate-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const hostId = btn.dataset.hostId;
        try {
          await Api.activateHost(hostId);
          Toast.success('Host activated');
          await this._load();
        } catch (err) { Toast.error(err.message); }
      });
    });
  },

  _renderHostCard(host) {
    if (!host.healthy) {
      return `
        <div class="card" style="margin-bottom:16px;border:1px solid var(--red)">
          <div class="card-header" style="background:rgba(var(--red-rgb,220,53,69),0.1);display:flex;align-items:center;gap:10px">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--red);flex-shrink:0"></span>
            <strong>${Utils.escapeHtml(host.name)}</strong>
            ${this._envBadge(host.environment)}
            <span class="badge badge-stopped" style="margin-left:auto">Offline</span>
          </div>
          <div class="card-body" style="color:var(--text-muted);padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span><i class="fas fa-exclamation-triangle" style="color:var(--red);margin-right:6px"></i>
            ${host.nonDocker && host.nonDocker.error ? Utils.escapeHtml(host.nonDocker.error) : 'Host is unreachable or offline.'}</span>
            <button class="btn btn-xs btn-primary mh-reconnect-btn" data-host-id="${host.id}" data-daemon="${Utils.escapeHtml(host.daemonType || 'docker')}" style="margin-left:auto"><i class="fas fa-sync-alt"></i> Reconnect</button>
          </div>
        </div>
      `;
    }

    const cpuPct = Math.min(100, Math.round(host.stats.cpu || 0));
    const memPct = host.stats.memoryLimit > 0
      ? Math.min(100, Math.round((host.stats.memory / host.stats.memoryLimit) * 100))
      : 0;

    // Group containers by stack
    const stackMap = {};
    for (const c of host.containers) {
      const s = c.stack || '_standalone';
      if (!stackMap[s]) stackMap[s] = [];
      stackMap[s].push(c);
    }

    const stackNames = Object.keys(stackMap).sort((a, b) => {
      if (a === '_standalone') return 1;
      if (b === '_standalone') return -1;
      return a.localeCompare(b);
    });

    const stacksHtml = stackNames.map(stackName => {
      const containers = stackMap[stackName];
      const key = `h${host.id}:${stackName}`;
      const isCollapsed = !!this._collapsed[key];
      const label = stackName === '_standalone' ? 'Standalone' : Utils.escapeHtml(stackName);
      const dots = this._healthDots(containers);

      const containersHtml = containers.map(c => {
        const stateClass = this._stateClass(c.state);
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer"
               data-mh-container="${Utils.escapeHtml(c.id || '')}"
               data-mh-host-id="${host.id}"
               title="Navigate to container ${Utils.escapeHtml(c.name)}">
            <span class="badge ${stateClass}" style="min-width:64px;text-align:center">${Utils.escapeHtml(c.state || 'unknown')}</span>
            <span style="font-weight:500;color:var(--text)">${Utils.escapeHtml(c.name)}</span>
            <span class="text-muted" style="font-size:11px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${Utils.escapeHtml(c.image || '')}</span>
          </div>
        `;
      }).join('');

      return `
        <div style="margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface2);border-radius:4px;cursor:pointer"
               data-mh-stack-toggle="${Utils.escapeHtml(key)}"
               data-mh-stack-nav
               data-mh-host-id="${host.id}">
            <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="font-size:11px;color:var(--text-muted)"></i>
            <i class="fas fa-layer-group" style="font-size:12px;color:var(--accent-dim,var(--accent))"></i>
            <span style="font-weight:500">${label}</span>
            <span class="text-muted" style="font-size:11px">${containers.length} container${containers.length !== 1 ? 's' : ''}</span>
            <span style="margin-left:auto;display:flex;gap:4px;align-items:center">${dots}</span>
          </div>
          <div data-mh-stack-body="${Utils.escapeHtml(key)}"
               style="padding-left:16px;${isCollapsed ? 'display:none' : ''}">
            ${containersHtml}
          </div>
        </div>
      `;
    }).join('');

    const cpuColor = cpuPct > 80 ? 'var(--red)' : cpuPct > 60 ? 'var(--yellow)' : 'var(--green)';
    const memColor = memPct > 80 ? 'var(--red)' : memPct > 60 ? 'var(--yellow)' : 'var(--accent)';

    const isDraining = host.environment === 'maintenance';
    const drainBtn = host.id > 0 ? (isDraining
      ? `<button class="btn btn-sm btn-secondary mh-activate-btn" data-host-id="${host.id}" style="margin-left:8px;font-size:11px"><i class="fas fa-play"></i> Activate</button>`
      : `<button class="btn btn-sm btn-warning mh-drain-btn" data-host-id="${host.id}" style="margin-left:8px;font-size:11px"><i class="fas fa-pause"></i> Drain</button>`
    ) : '';

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--green);flex-shrink:0"></span>
          <strong style="font-size:15px">${Utils.escapeHtml(host.info.hostname || host.name)}</strong>
          ${Utils.escapeHtml(host.name) !== Utils.escapeHtml(host.info.hostname || host.name)
            ? `<span class="text-muted" style="font-size:11px">(${Utils.escapeHtml(host.name)})</span>` : ''}
          ${this._envBadge(host.environment)}
          ${(host.groups || []).map(group => `<span class="badge" style="font-size:9px">${Utils.escapeHtml(group.name)}</span>`).join('')}
          <span class="text-muted" style="font-size:11px">
            <i class="fas fa-plug" style="margin-right:3px"></i>${Utils.escapeHtml(host.connectionType || '')}
          </span>
          <span style="margin-left:auto;display:flex;gap:12px;align-items:center">
            <span class="text-muted" style="font-size:11px">
              <i class="fas fa-cube" style="margin-right:3px"></i>
              <strong style="color:var(--green)">${host.counts.running}</strong> running
              ${host.counts.stopped > 0 ? `, <strong style="color:var(--red)">${host.counts.stopped}</strong> stopped` : ''}
            </span>
            ${drainBtn}
          </span>
        </div>
        <div class="card-body" style="padding:12px 16px">
          ${(host.info.platform && host.info.platform.platform !== 'linux') || host.info.cloud ? `
          <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px">
            ${host.info.platform && host.info.platform.platform !== 'linux' ? `
            <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:12px;background:${host.info.platform.color || 'var(--text-dim)'}22;border:1px solid ${host.info.platform.color || 'var(--text-dim)'}66;font-size:11px;font-weight:600" title="${Utils.escapeHtml(host.info.platform.notes || '')}">
              <i class="${Utils.escapeHtml(host.info.platform.iconClass || 'fab fa-linux')}" style="color:${host.info.platform.color || 'var(--text-dim)'}"></i>
              ${Utils.escapeHtml(host.info.platform.label)}${host.info.platform.version ? ` <span style="color:var(--text-dim);font-weight:400">${Utils.escapeHtml(host.info.platform.version)}</span>` : ''}
              ${host.info.platform.category === 'nas' ? '<span style="padding:1px 5px;background:rgba(0,0,0,0.2);border-radius:3px;font-size:9px;margin-left:2px">NAS</span>' : ''}
            </span>` : ''}
            ${host.info.cloud ? `
            <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:12px;background:${host.info.cloud.color || 'var(--text-dim)'}22;border:1px solid ${host.info.cloud.color || 'var(--text-dim)'}66;font-size:11px;font-weight:600" title="${Utils.escapeHtml((host.info.cloud.raw && host.info.cloud.raw.sys_vendor ? 'DMI sys_vendor: ' + host.info.cloud.raw.sys_vendor : ''))}">
              <i class="${Utils.escapeHtml(host.info.cloud.iconClass || 'fas fa-cloud')}" style="color:${host.info.cloud.color || 'var(--text-dim)'}"></i>
              ${Utils.escapeHtml(host.info.cloud.label)}
              ${host.info.cloud.vendor !== 'baremetal' ? '<span style="padding:1px 5px;background:rgba(0,0,0,0.2);border-radius:3px;font-size:9px;margin-left:2px">' + (['vmware','virtualbox','kvm','xen','parallels'].includes(host.info.cloud.vendor) ? 'VM' : 'CLOUD') + '</span>' : ''}
            </span>` : ''}
          </div>` : ''}
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">
            ${host.info.os ? `<i class="fab fa-linux" style="margin-right:4px"></i>${Utils.escapeHtml(host.info.os)}` : ''}
            ${host.info.dockerVersion ? `&nbsp;&nbsp;<i class="fab fa-docker" style="margin-right:4px"></i>Docker ${Utils.escapeHtml(host.info.dockerVersion)}` : ''}
            ${host.info.cpus ? `&nbsp;&nbsp;<i class="fas fa-microchip" style="margin-right:4px"></i>${host.info.cpus} CPUs` : ''}
            ${host.info.memTotal ? `&nbsp;&nbsp;<i class="fas fa-memory" style="margin-right:4px"></i>${Utils.formatBytes(host.info.memTotal)} RAM` : ''}
            ${host.info.kernelVersion ? `&nbsp;&nbsp;<i class="fas fa-code" style="margin-right:4px"></i>Kernel ${Utils.escapeHtml(host.info.kernelVersion)}` : ''}
            ${host.info.storageDriver ? `&nbsp;&nbsp;<i class="fas fa-hdd" style="margin-right:4px"></i>${Utils.escapeHtml(host.info.storageDriver)}` : ''}
            ${host.counts.images ? `&nbsp;&nbsp;<i class="fas fa-layer-group" style="margin-right:4px"></i>${host.counts.images} images` : ''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;max-width:400px">
            <div>
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">CPU ${cpuPct}%</div>
              <div style="background:var(--surface2);border-radius:4px;height:6px;overflow:hidden">
                <div style="width:${cpuPct}%;height:100%;background:${cpuColor};transition:width 0.3s"></div>
              </div>
            </div>
            <div>
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">
                RAM ${memPct}%${host.stats.memoryLimit > 0 ? ` (${Utils.formatBytes(host.stats.memory)} / ${Utils.formatBytes(host.stats.memoryLimit)})` : ''}
              </div>
              <div style="background:var(--surface2);border-radius:4px;height:6px;overflow:hidden">
                <div style="width:${memPct}%;height:100%;background:${memColor};transition:width 0.3s"></div>
              </div>
            </div>
          </div>
          ${stacksHtml || '<div class="text-muted" style="font-size:12px">No containers.</div>'}
        </div>
      </div>
    `;
  },

  // ─── By Host — Tab View ──────────────────────────

  _renderByHostTabs(el) {
    const hosts = this._filteredHosts();
    if (!this._activeHostTab || !hosts.find(h => h.id === this._activeHostTab)) {
      this._activeHostTab = hosts[0]?.id;
    }

    const tabsHtml = hosts.map(h => {
      const isActive = h.id === this._activeHostTab;
      const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${h.healthy ? 'var(--green)' : 'var(--red)'};margin-right:5px"></span>`;
      // v8.9.11-alpha.4 — show a daemon-appropriate count on the tab
      // instead of the Docker (running/total) when the host is not Docker.
      let countLabel;
      if (h.daemonType && h.daemonType !== 'docker' && h.daemonType !== 'podman' && h.nonDocker && h.nonDocker.resources) {
        const res = h.nonDocker.resources;
        if (h.daemonType === 'vsphere') countLabel = `${res.vmsRunning || 0}/${res.vms || 0} VMs`;
        else if (h.daemonType === 'xen') countLabel = `${res.vmsRunning || 0}/${res.vms || 0} VMs`;
        else if (h.daemonType === 'incus' || h.daemonType === 'lxd') countLabel = `${res.instancesRunning || 0}/${res.instances || 0} inst`;
        else if (h.daemonType === 'proxmox') countLabel = `${res.vms || 0} VM · ${res.lxc || 0} LXC`;
        else if (h.daemonType === 'kubernetes') countLabel = `${res.podsRunning || 0}/${res.pods || 0} pods`;
        else if (h.daemonType === 'nomad') countLabel = `${res.running || 0}/${res.jobs || 0} jobs`;
        else countLabel = h.daemonType;
      } else {
        countLabel = `${h.counts.running}/${h.counts.total}`;
      }
      return `<button class="tab ${isActive ? 'active' : ''}" data-host-tab="${h.id}" style="font-size:12px;padding:6px 14px">
        ${dot}${Utils.escapeHtml(h.name)}
        <span style="font-size:10px;color:var(--text-dim);margin-left:4px">(${Utils.escapeHtml(countLabel)})</span>
      </button>`;
    }).join('');

    el.innerHTML = `
      <div class="tabs" style="margin-bottom:12px;flex-wrap:wrap">${tabsHtml}</div>
      <div id="mh-host-tab-content"></div>
    `;

    // Wire tab clicks
    el.querySelectorAll('[data-host-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activeHostTab = parseInt(btn.dataset.hostTab) || btn.dataset.hostTab;
        el.querySelectorAll('[data-host-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._renderSingleHost(el.querySelector('#mh-host-tab-content'));
      });
    });

    this._renderSingleHost(el.querySelector('#mh-host-tab-content'));
  },

  // v8.9.11-alpha.4 — render the tab body for a non-Docker daemon
  // host (vsphere, incus, lxd, proxmox, kubernetes, nomad). Shows an
  // info card + count stat cards + a small preview list + a
  // "Manage in dedicated page" link.
  _renderNonDockerHost(el, host) {
    const nd = host.nonDocker || {};
    const daemonType = host.daemonType;
    const daemonName = nd.daemonName || daemonType;
    const productLine = [nd.productFullName, nd.version && `v${nd.version}`, nd.apiVersion && `API ${nd.apiVersion}`]
      .filter(Boolean).map(Utils.escapeHtml).join(' · ') || Utils.escapeHtml(daemonName);

    const pageMap = {
      vsphere: { route: '#/vsphere-resources', icon: 'fa-server', label: 'Open vSphere page' },
      xen: { route: '#/xen-resources', icon: 'fa-cloud', label: 'Open Xen page' },
      incus: { route: '#/incus-instances', icon: 'fa-cubes', label: 'Open Incus page' },
      lxd: { route: '#/incus-instances', icon: 'fa-cubes', label: 'Open LXD page' },
      proxmox: { route: '#/proxmox-resources', icon: 'fa-server', label: 'Open Proxmox page' },
      kubernetes: { route: '#/kubernetes-resources', icon: 'fa-dharmachakra', label: 'Open Kubernetes page' },
      nomad: { route: '#/nomad-jobs', icon: 'fa-tasks', label: 'Open Nomad page' },
    };
    const target = pageMap[daemonType] || { route: '#/hosts', icon: 'fa-server', label: 'Open Hosts' };

    const r = nd.resources || {};
    const stat = (icon, label, value, sub) => `
      <div class="card" style="padding:14px;flex:1;min-width:150px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-dim);font-size:12px;text-transform:uppercase;letter-spacing:.5px">
          <i class="fas ${icon}"></i> ${Utils.escapeHtml(label)}
        </div>
        <div style="font-size:28px;font-weight:700;margin-top:6px">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">${sub}</div>` : ''}
      </div>
    `;

    let stats = '';
    let preview = '';

    switch (daemonType) {
      case 'xen':
        stats = [
          stat('fa-desktop', 'VMs', r.vms || 0, `${r.vmsRunning || 0} running · ${r.vmsStopped || 0} off`),
          stat('fa-server', 'Xen hosts', r.xenHosts || 0, `${r.pools || 0} pool(s)`),
          stat('fa-hdd', 'Storage repositories', r.storages || 0,
            r.capacityGiB ? `${r.usedGiB || 0} / ${r.capacityGiB} GiB used` : null),
        ].join('');
        if ((r.topVMs || []).length) {
          preview = `<table class="table"><thead><tr><th>VM</th><th>Power</th><th>IP</th><th>vCPU</th><th>Memory</th></tr></thead><tbody>${r.topVMs.map(vm => {
            const color = /running|poweredon/i.test(vm.powerState || '') ? 'var(--green)' : 'var(--text-dim)';
            return `<tr><td><strong>${Utils.escapeHtml(vm.name || '')}</strong></td><td style="color:${color}">${Utils.escapeHtml(vm.powerState || '—')}</td>
              <td>${Utils.escapeHtml(vm.ipAddress || '—')}</td><td>${vm.cpu || '—'}</td><td>${vm.memoryGiB ? `${vm.memoryGiB} GiB` : '—'}</td></tr>`;
          }).join('')}</tbody></table>`;
        }
        break;
      case 'vsphere':
        stats = [
          stat('fa-desktop', 'VMs', r.vms || 0, `${r.vmsRunning || 0} running · ${r.vmsStopped || 0} off`),
          stat('fa-server', 'ESXi hosts', r.esxiHosts || 0, null),
          stat('fa-hdd', 'Datastores', r.datastores || 0,
            r.capacityGiB ? `${r.freeGiB} / ${r.capacityGiB} GiB free` : null),
        ].join('');
        if ((r.topVMs || []).length) {
          preview = `<table class="table"><thead><tr>
              <th>VM</th><th>Power</th><th>Guest OS</th><th>vCPU</th><th>Memory</th>
            </tr></thead><tbody>${r.topVMs.map(v => {
              const c = v.powerState === 'poweredOn' ? 'var(--green)' : 'var(--text-dim)';
              return `<tr>
                <td><strong>${Utils.escapeHtml(v.name || '')}</strong></td>
                <td style="color:${c}">${Utils.escapeHtml(v.powerState || '—')}</td>
                <td>${Utils.escapeHtml(v.guestOS || '—')}</td>
                <td>${v.cpu || '—'}</td>
                <td>${v.memoryGiB ? v.memoryGiB + ' GiB' : '—'}</td>
              </tr>`;
            }).join('')}</tbody></table>`;
        }
        break;
      case 'incus':
      case 'lxd':
        stats = [
          stat('fa-cube', 'Instances', r.instances || 0,
            `${r.instancesRunning || 0} running · ${r.instancesStopped || 0} off`),
        ].join('');
        if ((r.topInstances || []).length) {
          preview = `<table class="table"><thead><tr>
              <th>Name</th><th>Status</th><th>Type</th>
            </tr></thead><tbody>${r.topInstances.map(i => {
              const c = i.status === 'Running' ? 'var(--green)' : 'var(--text-dim)';
              return `<tr>
                <td><strong>${Utils.escapeHtml(i.name || '')}</strong></td>
                <td style="color:${c}">${Utils.escapeHtml(i.status || '—')}</td>
                <td>${Utils.escapeHtml(i.type || '—')}</td>
              </tr>`;
            }).join('')}</tbody></table>`;
        }
        break;
      case 'proxmox':
        stats = [
          stat('fa-server', 'Nodes', r.nodes || 0, null),
          stat('fa-desktop', 'VMs', r.vms || 0, `${r.vmsRunning || 0} running`),
          stat('fa-cube', 'LXC', r.lxc || 0, `${r.lxcRunning || 0} running`),
        ].join('');
        if ((r.topVMs || []).length) {
          preview = `<table class="table"><thead><tr>
              <th>VM</th><th>Status</th><th>Node</th><th>VMID</th>
            </tr></thead><tbody>${r.topVMs.map(v => {
              const c = v.status === 'running' ? 'var(--green)' : 'var(--text-dim)';
              return `<tr>
                <td><strong>${Utils.escapeHtml(v.name || '')}</strong></td>
                <td style="color:${c}">${Utils.escapeHtml(v.status || '—')}</td>
                <td>${Utils.escapeHtml(v.node || '—')}</td>
                <td>${Utils.escapeHtml(String(v.vmid || '—'))}</td>
              </tr>`;
            }).join('')}</tbody></table>`;
        }
        break;
      case 'kubernetes':
        stats = [
          stat('fa-cube', 'Namespaces', r.namespaces || 0, null),
          stat('fa-microchip', 'Nodes', r.nodes || 0, null),
          stat('fa-boxes', 'Deployments', r.deployments || 0, null),
          stat('fa-box', 'Pods', r.pods || 0, `${r.podsRunning || 0} running`),
        ].join('');
        if ((r.topDeployments || []).length) {
          preview = `<table class="table"><thead><tr>
              <th>Namespace</th><th>Deployment</th><th>Ready</th>
            </tr></thead><tbody>${r.topDeployments.map(d => `<tr>
              <td>${Utils.escapeHtml(d.namespace || '—')}</td>
              <td><strong>${Utils.escapeHtml(d.name || '—')}</strong></td>
              <td>${Utils.escapeHtml(d.ready || '—')}</td>
            </tr>`).join('')}</tbody></table>`;
        }
        break;
      case 'nomad':
        stats = [
          stat('fa-tasks', 'Jobs', r.jobs || 0, `${r.running || 0} running`),
          stat('fa-microchip', 'Nodes', r.nodes || 0, null),
          stat('fa-cube', 'Allocations', r.allocations || 0, `${r.allocsRunning || 0} running`),
        ].join('');
        if ((r.topJobs || []).length) {
          preview = `<table class="table"><thead><tr>
              <th>Job</th><th>Status</th><th>Type</th>
            </tr></thead><tbody>${r.topJobs.map(j => {
              const c = j.status === 'running' ? 'var(--green)' : 'var(--text-dim)';
              return `<tr>
                <td><strong>${Utils.escapeHtml(j.name || '')}</strong></td>
                <td style="color:${c}">${Utils.escapeHtml(j.status || '—')}</td>
                <td>${Utils.escapeHtml(j.type || '—')}</td>
              </tr>`;
            }).join('')}</tbody></table>`;
        }
        break;
      default:
        stats = `<div class="text-muted" style="padding:12px">Non-Docker host — no summary available for daemon type "${Utils.escapeHtml(daemonType)}".</div>`;
    }

    el.innerHTML = `
      <div class="card" style="padding:14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim)">
            <i class="fas ${target.icon}" style="margin-right:6px"></i>${Utils.escapeHtml(daemonName)}
          </div>
          <div style="font-size:14px;margin-top:4px">${productLine}</div>
        </div>
        <a href="${target.route}" class="btn btn-sm btn-secondary">
          <i class="fas fa-external-link-alt"></i> ${Utils.escapeHtml(target.label)}
        </a>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        ${stats}
      </div>

      ${preview ? `<div class="card" style="padding:0;overflow:hidden">
        <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px">
          Preview <span style="color:var(--text)">(first 8)</span>
        </div>
        ${preview}
      </div>` : ''}
    `;
  },

  _renderSingleHost(el) {
    if (!el) return;
    const host = this._filteredHosts().find(h => h.id === this._activeHostTab);
    if (!host) { el.innerHTML = '<div class="text-muted">Host not found</div>'; return; }

    if (!host.healthy) {
      const isVsphere = host.daemonType === 'vsphere';
      const isXen = host.daemonType === 'xen';
      el.innerHTML = `<div class="card" style="border:1px solid var(--red);border-left:4px solid var(--red);padding:20px;text-align:center">
        <i class="fas fa-exclamation-triangle" style="font-size:32px;color:var(--red);margin-bottom:12px"></i>
        <h3 style="color:var(--red)">Host Offline</h3>
        <p class="text-muted">Cannot reach ${Utils.escapeHtml(host.name)}.</p>
        ${host.nonDocker && host.nonDocker.error ? `<p style="color:var(--red);font-size:12px;margin-top:8px">${Utils.escapeHtml(host.nonDocker.error)}</p>` : ''}
        <button class="btn btn-sm btn-primary" id="mh-reconnect" style="margin-top:14px"><i class="fas fa-sync-alt"></i> Reconnect</button>
      </div>`;
      const rc = el.querySelector('#mh-reconnect');
      if (rc) rc.addEventListener('click', async () => {
        rc.disabled = true;
        rc.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reconnecting…';
        // For vSphere, force-drop the (likely dead) cached client first so the
        // overview re-login lands on a fresh connection; then refresh the page.
        if (isVsphere) { try { await Api.reconnectVSphere(host.id); } catch { /* the reload will surface any error */ } }
        if (isXen) { try { await Api.reconnectXen(host.id); } catch { /* the reload will surface any error */ } }
        await this._load();
      });
      return;
    }

    // v8.9.11-alpha.4 — non-Docker daemon host: render a summary card
    // with counts + a quick preview + link to the dedicated page.
    if (host.daemonType && host.daemonType !== 'docker' && host.daemonType !== 'podman') {
      this._renderNonDockerHost(el, host);
      return;
    }

    // Resource bars
    const cpuPct = Math.min(100, Math.round(host.stats.cpu));
    const memPct = host.stats.memoryLimit > 0 ? Math.min(100, Math.round((host.stats.memory / host.stats.memoryLimit) * 100)) : 0;
    const cpuColor = cpuPct > 80 ? 'var(--red)' : cpuPct > 50 ? 'var(--yellow)' : 'var(--green)';
    const memColor = memPct > 80 ? 'var(--red)' : memPct > 50 ? 'var(--yellow)' : 'var(--accent)';

    // Group containers by stack
    const stacks = {};
    host.containers.forEach(c => {
      const s = c.stack || '_standalone';
      if (!stacks[s]) stacks[s] = [];
      stacks[s].push(c);
    });
    const stackNames = Object.keys(stacks).sort((a, b) => a === '_standalone' ? 1 : b === '_standalone' ? -1 : a.localeCompare(b));

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="card" style="padding:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <i class="fas fa-microchip" style="color:var(--accent)"></i>
            <span style="font-weight:600">CPU</span>
            <span style="margin-left:auto;font-weight:700;color:${cpuColor}">${cpuPct}%</span>
          </div>
          <div style="height:8px;background:var(--surface3);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${cpuPct}%;background:${cpuColor};border-radius:4px;transition:width 0.5s"></div>
          </div>
        </div>
        <div class="card" style="padding:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <i class="fas fa-memory" style="color:var(--accent)"></i>
            <span style="font-weight:600">RAM</span>
            <span style="margin-left:auto;font-weight:700;color:${memColor}">${memPct}% (${Utils.formatBytes(host.stats.memory)} / ${Utils.formatBytes(host.stats.memoryLimit)})</span>
          </div>
          <div style="height:8px;background:var(--surface3);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${memPct}%;background:${memColor};border-radius:4px;transition:width 0.5s"></div>
          </div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:12px">
        ${host.info.os ? `<i class="fab fa-linux" style="margin-right:4px"></i>${Utils.escapeHtml(host.info.os)}` : ''}
        ${host.info.dockerVersion ? `&nbsp;&nbsp;<i class="fab fa-docker" style="margin-right:4px"></i>Docker ${Utils.escapeHtml(host.info.dockerVersion)}` : ''}
        ${host.info.cpus ? `&nbsp;&nbsp;<i class="fas fa-microchip" style="margin-right:4px"></i>${host.info.cpus} CPUs` : ''}
        ${host.info.memTotal ? `&nbsp;&nbsp;<i class="fas fa-memory" style="margin-right:4px"></i>${Utils.formatBytes(host.info.memTotal)} RAM` : ''}
        ${host.info.kernelVersion ? `&nbsp;&nbsp;<i class="fas fa-code" style="margin-right:4px"></i>${Utils.escapeHtml(host.info.kernelVersion)}` : ''}
      </div>
      ${stackNames.map(stackName => {
        const containers = stacks[stackName];
        const label = stackName === '_standalone' ? 'Standalone' : Utils.escapeHtml(stackName);
        const dots = this._healthDots(containers);
        return `
          <div class="card" style="margin-bottom:8px">
            <div class="card-header" style="display:flex;align-items:center;gap:8px;padding:8px 14px;justify-content:flex-start;text-align:left;cursor:pointer" data-mh-stack-toggle="tab:${host.id}:${stackName}">
              <i class="fas ${this._collapsed['tab:' + host.id + ':' + stackName] ? 'fa-chevron-right' : 'fa-chevron-down'}" style="font-size:11px;color:var(--text-dim)"></i>
              <i class="fas fa-layer-group" style="color:var(--accent);font-size:11px"></i>
              <strong style="font-size:12px">${label}</strong>
              <span class="text-muted" style="font-size:11px">${containers.length} container${containers.length !== 1 ? 's' : ''}</span>
              <span style="margin-left:auto;display:flex;gap:3px">${dots}</span>
            </div>
            <div data-mh-stack-body="tab:${host.id}:${stackName}" style="${this._collapsed['tab:' + host.id + ':' + stackName] ? 'display:none' : ''}">
              <div class="card-body" style="padding:6px 14px">
                ${containers.map(c => `
                  <div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px"
                       data-mh-container="${Utils.escapeHtml(c.id || '')}" data-mh-host-id="${host.id}">
                    <span class="badge ${this._stateClass(c.state)}" style="min-width:56px;text-align:center;font-size:10px">${Utils.escapeHtml(c.state || 'unknown')}</span>
                    <span style="font-weight:500">${Utils.escapeHtml(c.name)}</span>
                    <span class="text-muted" style="font-size:11px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${Utils.escapeHtml(c.image || '')}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>`;
      }).join('')}
    `;

    // Wire stack toggles
    el.querySelectorAll('[data-mh-stack-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mhStackToggle;
        this._collapsed[key] = !this._collapsed[key];
        const body = el.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);
        if (body) body.style.display = this._collapsed[key] ? 'none' : '';
        const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
        if (icon) icon.className = `fas ${this._collapsed[key] ? 'fa-chevron-right' : 'fa-chevron-down'}`;
      });
    });

    // Wire container clicks
    el.querySelectorAll('[data-mh-container]').forEach(item => {
      item.addEventListener('click', () => {
        const hostId = parseInt(item.dataset.mhHostId) || 0;
        Api.setHost(hostId);
        App.navigate(`/containers/${item.dataset.mhContainer}`);
      });
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface3)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
    });
  },

  // ─── By Stack view ───────────────────────────────

  _renderByStack() {
    const el = document.getElementById('mh-content');
    if (!el || !this._data) return;

    // Build a map: stackName → [{host, containers}]
    const stackMap = {};
    for (const host of this._filteredHosts()) {
      if (!host.healthy) continue;
      for (const c of host.containers) {
        const s = c.stack || '_standalone';
        if (!stackMap[s]) stackMap[s] = [];
        let entry = stackMap[s].find(e => e.host.id === host.id);
        if (!entry) {
          entry = { host, containers: [] };
          stackMap[s].push(entry);
        }
        entry.containers.push(c);
      }
    }

    const stackNames = Object.keys(stackMap).sort((a, b) => {
      if (a === '_standalone') return 1;
      if (b === '_standalone') return -1;
      return a.localeCompare(b);
    });

    if (!stackNames.length) {
      el.innerHTML = '<div class="empty-msg">No containers found across hosts.</div>';
      return;
    }

    el.innerHTML = stackNames.map(stackName => {
      const entries = stackMap[stackName];
      const label = stackName === '_standalone' ? 'Standalone' : Utils.escapeHtml(stackName);
      const totalContainers = entries.reduce((s, e) => s + e.containers.length, 0);
      const key = `stack:${stackName}`;
      const isCollapsed = !!this._collapsed[key];

      const hostsHtml = entries.map(({ host, containers }) => {
        const hostKey = `stack:${stackName}:h${host.id}`;
        const isHostCollapsed = !!this._collapsed[hostKey];
        const dots = this._healthDots(containers);

        const containersHtml = containers.map(c => {
          const stateClass = this._stateClass(c.state);
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer"
                 data-mh-container="${Utils.escapeHtml(c.id || '')}"
                 data-mh-host-id="${host.id}"
                 title="Navigate to container">
              <span class="badge ${stateClass}" style="min-width:64px;text-align:center">${Utils.escapeHtml(c.state || 'unknown')}</span>
              <span style="font-weight:500">${Utils.escapeHtml(c.name)}</span>
              <span class="text-muted" style="font-size:11px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${Utils.escapeHtml(c.image || '')}</span>
            </div>
          `;
        }).join('');

        return `
          <div style="margin-bottom:6px;padding-left:12px;border-left:2px solid var(--surface2)">
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--surface2);border-radius:4px;cursor:pointer"
                 data-mh-stack-host-toggle="${Utils.escapeHtml(hostKey)}">
              <i class="fas ${isHostCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="font-size:11px;color:var(--text-muted)"></i>
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${host.healthy ? 'var(--green)' : 'var(--red)'}"></span>
              <span style="font-weight:500">${Utils.escapeHtml(host.name)}</span>
              ${this._envBadge(host.environment)}
              <span class="text-muted" style="font-size:11px">${containers.length} container${containers.length !== 1 ? 's' : ''}</span>
              <span style="margin-left:auto;display:flex;gap:4px;align-items:center">${dots}</span>
            </div>
            <div data-mh-stack-host-body="${Utils.escapeHtml(hostKey)}"
                 style="padding-left:12px;${isHostCollapsed ? 'display:none' : ''}">
              ${containersHtml}
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header" style="display:flex;align-items:center;gap:10px;cursor:pointer;justify-content:flex-start;text-align:left"
               data-mh-stack-toggle="${Utils.escapeHtml(key)}">
            <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="font-size:12px;color:var(--text-muted)"></i>
            <i class="fas fa-layer-group" style="color:var(--accent)"></i>
            <strong style="text-align:left">${label}</strong>
            <span class="text-muted" style="font-size:12px">${entries.length} host${entries.length !== 1 ? 's' : ''} · ${totalContainers} container${totalContainers !== 1 ? 's' : ''}</span>
          </div>
          <div data-mh-stack-body="${Utils.escapeHtml(key)}"
               style="${isCollapsed ? 'display:none' : ''}">
            <div class="card-body" style="padding:12px 16px">
              ${hostsHtml}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Stack-level collapse toggles
    el.querySelectorAll('[data-mh-stack-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mhStackToggle;
        this._collapsed[key] = !this._collapsed[key];
        const body = el.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);
        if (body) {
          body.style.display = this._collapsed[key] ? 'none' : '';
          const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
          if (icon) icon.className = this._collapsed[key] ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
        }
      });
    });

    // Host-level collapse toggles within stack view
    el.querySelectorAll('[data-mh-stack-host-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mhStackHostToggle;
        this._collapsed[key] = !this._collapsed[key];
        const body = el.querySelector(`[data-mh-stack-host-body="${CSS.escape(key)}"]`);
        if (body) {
          body.style.display = this._collapsed[key] ? 'none' : '';
          const icon = btn.querySelector('i.fa-chevron-down, i.fa-chevron-right');
          if (icon) icon.className = this._collapsed[key] ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
        }
      });
    });

    // Container click handlers
    el.querySelectorAll('[data-mh-container]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const hostId = parseInt(link.dataset.mhHostId);
        const cid = link.dataset.mhContainer;
        Api.setHost(hostId);
        App.navigate('/containers/' + cid);
      });
    });
  },

  // ─── Helpers ─────────────────────────────────────

  _filteredHosts() {
    const hosts = this._data?.hosts || [];
    if (this._groupFilter === 'all') return hosts;
    const groupId = Number(this._groupFilter);
    return hosts.filter(host => (host.groups || []).some(group => Number(group.id) === groupId));
  },

  _renderGroupFilters() {
    const el = document.getElementById('mh-group-filters');
    if (!el) return;
    const visibleIds = new Set((this._data?.hosts || []).map(host => host.id));
    const groups = (this._groups || []).filter(group =>
      (group.member_host_ids || []).some(id => visibleIds.has(id))
    );
    if (this._groupFilter !== 'all'
      && !groups.some(group => Number(group.id) === Number(this._groupFilter))) {
      this._groupFilter = 'all';
    }
    if (!groups.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<button class="btn btn-xs ${this._groupFilter === 'all' ? 'btn-primary' : 'btn-secondary'}" data-mh-group="all">All hosts</button>${groups.map(group => {
      const active = Number(this._groupFilter) === Number(group.id);
      return `<button class="btn btn-xs ${active ? 'btn-primary' : 'btn-secondary'}" data-mh-group="${group.id}"><i class="fas ${Utils.escapeHtml(group.icon || 'fa-server')}" style="margin-right:4px"></i>${Utils.escapeHtml(group.name)}</button>`;
    }).join('')}`;
    el.querySelectorAll('[data-mh-group]').forEach(button => button.addEventListener('click', () => {
      this._groupFilter = button.dataset.mhGroup;
      this._renderGroupFilters();
      this._renderStats();
      this._renderContent();
      this._applySearch(this._searchFilter);
    }));
  },

  async _showBulkActions() {
    const hosts = (this._data?.hosts || []).filter(host =>
      ['docker', 'podman'].includes(host.daemonType || 'docker')
    );
    if (!hosts.length) return Toast.warning('No Docker/Podman hosts are available');
    const selection = await Modal.form(`
      <div class="form-group"><label>Action</label><select id="mh-bulk-action" class="form-control"><option value="restart">Restart running containers</option><option value="prune">Prune unused resources (preserve volumes)</option></select></div>
      <div class="form-group"><label>Target hosts</label><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:7px;max-height:300px;overflow:auto;border:1px solid var(--border);padding:10px;border-radius:6px">
        ${hosts.map(host => `<label style="display:flex;align-items:center;gap:7px"><input type="checkbox" data-mh-bulk-host value="${host.id}" ${host.healthy ? 'checked' : ''}><span class="host-tree-status ${host.healthy ? 'online' : 'offline'}"></span>${Utils.escapeHtml(host.name)} <span class="text-xs text-muted">${Utils.escapeHtml(host.environment || '')}</span></label>`).join('')}
      </div></div>
      <div class="alert alert-warning"><i class="fas fa-triangle-exclamation"></i> Docker Dash and docker-dash-caddy are excluded from bulk restart. Prune never removes volumes.</div>`, {
      title: 'Fleet bulk action', width: '660px',
      onSubmit: content => {
        const hostIds = [...content.querySelectorAll('[data-mh-bulk-host]:checked')].map(input => Number(input.value));
        if (!hostIds.length) { Toast.warning('Select at least one host'); return false; }
        return { action: content.querySelector('#mh-bulk-action').value, hostIds };
      },
    });
    if (!selection) return;
    try {
      const preview = await Api.previewFleetBulk(selection.action, selection.hostIds);
      const rows = preview.hosts.map(host => `<tr><td>${Utils.escapeHtml(host.host_name)}</td><td><span class="badge ${host.status === 'ready' ? 'badge-running' : 'badge-stopped'}">${Utils.escapeHtml(host.status)}</span></td><td>${host.error ? Utils.escapeHtml(host.error) : Utils.escapeHtml(host.detail || '')}</td></tr>`).join('');
      const confirmed = await Modal.confirm(`<p style="margin-bottom:10px">Review every target before execution:</p><table class="data-table"><thead><tr><th>Host</th><th>Status</th><th>Impact</th></tr></thead><tbody>${rows}</tbody></table>`, {
        title: selection.action === 'prune' ? 'Confirm fleet prune' : 'Confirm fleet restart',
        confirmText: selection.action === 'prune' ? 'Prune fleet' : 'Restart containers',
        danger: true, html: true, typeToConfirm: selection.action === 'prune' ? 'PRUNE' : undefined,
      });
      if (!confirmed) return;
      Toast.info(`Running ${selection.action} on ${selection.hostIds.length} host(s)…`);
      const result = await Api.runFleetBulk(selection.action, selection.hostIds);
      Modal.open(`<div class="modal-header"><h3>Fleet ${Utils.escapeHtml(selection.action)} — ${Utils.escapeHtml(result.status)}</h3><button class="modal-close-btn" id="mh-bulk-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><table class="data-table"><thead><tr><th>Host</th><th>Status</th><th>Result</th></tr></thead><tbody>${result.hosts.map(host => `<tr><td>${Utils.escapeHtml(host.host_name)}</td><td><span class="badge ${host.status === 'success' ? 'badge-running' : host.status === 'partial' ? 'badge-warning' : 'badge-stopped'}">${Utils.escapeHtml(host.status)}</span></td><td>${host.error ? Utils.escapeHtml(host.error) : selection.action === 'prune' ? Utils.formatBytes(host.reclaimed_bytes || 0) + ' reclaimed' : `${host.affected || 0} restarted${host.failures ? `, ${host.failures} failed` : ''}`}</td></tr>`).join('')}</tbody></table></div>`, { width: '700px' });
      Modal._content.querySelector('#mh-bulk-close').addEventListener('click', () => Modal.close());
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _envBadge(env) {
    if (!env || env === 'production') return '';
    if (env === 'maintenance') return '<span class="badge" style="background:rgba(248,81,73,0.15);color:var(--red);font-size:9px">MAINTENANCE</span>';
    const colors = {
      development: 'var(--yellow)',
      staging: 'var(--accent)',
      testing: 'var(--purple,#9b59b6)',
    };
    const color = colors[env] || 'var(--text-muted)';
    return `<span style="font-size:10px;padding:2px 6px;border-radius:10px;background:${color}20;color:${color};border:1px solid ${color}40;font-weight:600;text-transform:uppercase">${Utils.escapeHtml(env)}</span>`;
  },

  _healthDots(containers) {
    const running = containers.filter(c => c.state === 'running').length;
    const stopped = containers.filter(c => c.state === 'exited' || c.state === 'stopped').length;
    const other = containers.length - running - stopped;
    let dots = '';
    if (running > 0) dots += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green)" title="${running} running"></span>`;
    if (stopped > 0) dots += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red)" title="${stopped} stopped"></span>`;
    if (other > 0) dots += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--yellow)" title="${other} other"></span>`;
    return dots;
  },

  _stateClass(state) {
    if (typeof Utils.statusBadgeClass === 'function') return Utils.statusBadgeClass(state);
    if (state === 'running') return 'badge-running';
    if (state === 'exited' || state === 'stopped') return 'badge-stopped';
    return 'badge-paused';
  },

  // ─── Search / Filter ─────────────────────────────

  _applySearch(q) {
    if (!q) {
      // No filter — show everything
      document.querySelectorAll('#mh-content .card, #mh-content [data-mh-host-card]').forEach(el => {
        el.style.display = '';
      });
      document.querySelectorAll('#mh-content [data-mh-container]').forEach(el => {
        el.style.display = '';
      });
      document.querySelectorAll('#mh-content [data-mh-stack-body]').forEach(el => {
        // restore collapse state
        const key = el.dataset.mhStackBody;
        if (key && this._collapsed[key]) el.style.display = 'none';
        else el.style.display = '';
      });
      return;
    }

    if (this._tab === 'host') {
      // Each host is a .card at the top level of #mh-content
      const hostCards = document.querySelectorAll('#mh-content > .card');
      hostCards.forEach(card => {
        // hostname text is in the card-header strong
        const hostNameEl = card.querySelector('.card-header strong');
        const hostName = (hostNameEl ? hostNameEl.textContent : '').toLowerCase();
        let hostMatches = hostName.includes(q);

        // For each stack group inside this host card
        const stackGroups = card.querySelectorAll('[data-mh-stack-toggle]');
        let anyStackVisible = false;
        stackGroups.forEach(stackToggle => {
          const key = stackToggle.dataset.mhStackToggle;
          const stackLabelEl = stackToggle.querySelector('span[style*="font-weight"]') || stackToggle.querySelector('span');
          const stackName = (stackLabelEl ? stackLabelEl.textContent : '').toLowerCase();
          const body = card.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);

          // Check containers within this stack
          let anyContainerVisible = false;
          if (body) {
            body.querySelectorAll('[data-mh-container]').forEach(c => {
              const nameEl = c.querySelector('span[style*="font-weight"]');
              const imgEl = c.querySelector('.text-muted');
              const cName = (nameEl ? nameEl.textContent : '').toLowerCase();
              const cImg = (imgEl ? imgEl.textContent : '').toLowerCase();
              const visible = hostMatches || stackName.includes(q) || cName.includes(q) || cImg.includes(q);
              c.style.display = visible ? '' : 'none';
              if (visible) anyContainerVisible = true;
            });
          }

          const stackVisible = hostMatches || stackName.includes(q) || anyContainerVisible;
          if (stackVisible) {
            // Show stack toggle row
            stackToggle.style.display = '';
            // Expand the stack body so matches are visible
            if (body) body.style.display = '';
            anyStackVisible = true;
          } else {
            stackToggle.style.display = 'none';
            if (body) body.style.display = 'none';
          }
        });

        card.style.display = (hostMatches || anyStackVisible) ? '' : 'none';
      });
    } else {
      // By Stack tab — each stack is a .card
      const stackCards = document.querySelectorAll('#mh-content > .card');
      stackCards.forEach(card => {
        const headerEl = card.querySelector('.card-header strong');
        const stackName = (headerEl ? headerEl.textContent : '').toLowerCase();

        let anyVisible = false;
        card.querySelectorAll('[data-mh-stack-host-toggle]').forEach(hostToggle => {
          const hostKey = hostToggle.dataset.mhStackHostToggle;
          const hostNameEl = hostToggle.querySelector('span[style*="font-weight"]');
          const hostName = (hostNameEl ? hostNameEl.textContent : '').toLowerCase();
          const body = card.querySelector(`[data-mh-stack-host-body="${CSS.escape(hostKey)}"]`);

          let anyContainerVisible = false;
          if (body) {
            body.querySelectorAll('[data-mh-container]').forEach(c => {
              const nameEl = c.querySelector('span[style*="font-weight"]');
              const imgEl = c.querySelector('.text-muted');
              const cName = (nameEl ? nameEl.textContent : '').toLowerCase();
              const cImg = (imgEl ? imgEl.textContent : '').toLowerCase();
              const visible = stackName.includes(q) || hostName.includes(q) || cName.includes(q) || cImg.includes(q);
              c.style.display = visible ? '' : 'none';
              if (visible) anyContainerVisible = true;
            });
          }

          const hostVisible = stackName.includes(q) || hostName.includes(q) || anyContainerVisible;
          hostToggle.style.display = hostVisible ? '' : 'none';
          if (body) body.style.display = hostVisible ? '' : 'none';
          if (hostVisible) anyVisible = true;
        });

        // If this card has no sub-host-toggles (edge case), check stack name alone
        if (!card.querySelectorAll('[data-mh-stack-host-toggle]').length) {
          anyVisible = stackName.includes(q);
        }

        card.style.display = anyVisible ? '' : 'none';
        // Expand stack body when filter is active
        const key = card.querySelector('[data-mh-stack-toggle]')?.dataset.mhStackToggle;
        if (key) {
          const body = card.querySelector(`[data-mh-stack-body="${CSS.escape(key)}"]`);
          if (body && anyVisible) body.style.display = '';
        }
      });
    }
  },

  _showGuide() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10500;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:600px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.5)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border)">
          <h3 style="margin:0"><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i>Multi-Host Overview Guide</h3>
          <button id="mh-guide-close" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:18px"><i class="fas fa-times"></i></button>
        </div>
        <div style="padding:20px;font-size:13px;line-height:1.7;color:var(--text)">

          <h4 style="color:var(--accent);margin:0 0 8px"><i class="fas fa-server" style="margin-right:6px"></i>Tabs</h4>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:16px">
            <strong>By Host</strong><span>View all hosts as cards with their stacks and containers grouped inside</span>
            <strong>By Stack</strong><span>View all stacks grouped across hosts — see which hosts run each stack</span>
          </div>

          <h4 style="color:var(--accent);margin:0 0 8px"><i class="fas fa-eye" style="margin-right:6px"></i>Host View Modes</h4>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:16px">
            <span><i class="fas fa-bars"></i> List</span><span>All hosts stacked vertically on one page</span>
            <span><i class="fas fa-folder"></i> Tabs</span><span>One host at a time with tab navigation — shows detailed CPU/RAM bars and system info</span>
          </div>

          <h4 style="color:var(--accent);margin:0 0 8px"><i class="fas fa-tools" style="margin-right:6px"></i>Toolbar Buttons</h4>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:16px">
            <span><i class="fas fa-compress-alt"></i> Collapse</span><span>Collapse all stack groups</span>
            <span><i class="fas fa-expand-alt"></i> Expand</span><span>Expand all stack groups</span>
            <span><i class="fas fa-sync-alt"></i> Refresh</span><span>Reload data from all hosts</span>
            <span><i class="fas fa-search"></i> Search</span><span>Filter by host name, stack name, container name, or image</span>
          </div>

          <h4 style="color:var(--accent);margin:0 0 8px"><i class="fas fa-heartbeat" style="margin-right:6px"></i>Health Indicators</h4>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:16px">
            <span style="color:var(--green)">● Green dot</span><span>Host online / container running</span>
            <span style="color:var(--red)">● Red dot</span><span>Host offline / container stopped</span>
            <span style="color:var(--yellow)">● Yellow dot</span><span>Container in non-standard state (paused, restarting)</span>
            <span>CPU/RAM bars</span><span>Color-coded: green (&lt;50%), yellow (50-80%), red (&gt;80%)</span>
          </div>

          <h4 style="color:var(--accent);margin:0 0 8px"><i class="fas fa-mouse-pointer" style="margin-right:6px"></i>Actions</h4>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:16px">
            <strong>Click container</strong><span>Switch to that host and navigate to container detail</span>
            <strong>Drain button</strong><span>Stop all non-system containers on a host (maintenance mode)</span>
            <strong>Activate button</strong><span>Restore host from maintenance mode to production</span>
          </div>

          <h4 style="color:var(--accent);margin:0 0 8px"><i class="fas fa-chart-bar" style="margin-right:6px"></i>Stat Cards</h4>
          <p style="margin:0">The top bar shows aggregates across all hosts: total hosts (with online count), total containers, running, stopped, and total images. Data refreshes automatically every 15 seconds.</p>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#mh-guide-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  },

  destroy() {
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  },
};

window.MultiHostPage = MultiHostPage;
