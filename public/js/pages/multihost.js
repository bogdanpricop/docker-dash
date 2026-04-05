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
  _hostView: 'list', // 'list' | 'tabs'

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
            <button class="tab ${this._tab === 'stack' ? 'active' : ''}" data-mh-tab="stack">
              <i class="fas fa-layer-group" style="margin-right:4px"></i>By Stack
            </button>
          </div>
          <button class="btn-icon view-toggle" id="mh-collapse" title="Collapse all"><i class="fas fa-compress-alt"></i></button>
          <button class="btn-icon view-toggle" id="mh-expand" title="Expand all"><i class="fas fa-expand-alt"></i></button>
          <button class="btn btn-sm btn-secondary" id="mh-refresh" title="Refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="mh-stats" style="margin-bottom:16px"></div>
      <div id="mh-content"><div class="text-muted" style="padding:20px"><i class="fas fa-spinner fa-spin"></i> Loading hosts...</div></div>
    `;

    container.querySelectorAll('[data-mh-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._tab = btn.dataset.mhTab;
        container.querySelectorAll('[data-mh-tab]').forEach(b => {
          b.classList.toggle('active', b.dataset.mhTab === this._tab);
        });
        this._renderContent();
        this._applySearch(this._searchFilter);
      });
    });

    container.querySelector('#mh-refresh').addEventListener('click', () => this._load());

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
      this._data = await Api.getMultiHostOverview();
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
    const { totals } = this._data;
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
      <div id="mh-host-view-toggle" style="display:flex;gap:4px;margin-top:10px">
        <button class="btn-icon view-toggle ${this._hostView === 'list' ? 'active' : ''}" data-host-view="list" title="List view — all hosts stacked">
          <i class="fas fa-bars"></i>
        </button>
        <button class="btn-icon view-toggle ${this._hostView === 'tabs' ? 'active' : ''}" data-host-view="tabs" title="Tab view — one host at a time">
          <i class="fas fa-folder"></i>
        </button>
      </div>
    `;

    el.querySelectorAll('[data-host-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._hostView = btn.dataset.hostView;
        el.querySelectorAll('[data-host-view]').forEach(b => b.classList.toggle('active', b.dataset.hostView === this._hostView));
        this._renderContent();
        this._applySearch(this._searchFilter);
      });
    });
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

    if (!this._data.hosts.length) {
      el.innerHTML = '<div class="empty-msg">No hosts configured.</div>';
      return;
    }

    // Tab view: show host tabs at top, render one host at a time
    if (this._hostView === 'tabs') {
      this._renderByHostTabs(el);
      return;
    }

    el.innerHTML = this._data.hosts.map(host => this._renderHostCard(host)).join('');

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
          <div class="card-body" style="color:var(--text-muted);padding:12px 16px">
            <i class="fas fa-exclamation-triangle" style="color:var(--red);margin-right:6px"></i>
            Host is unreachable or offline.
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
    const hosts = this._data.hosts;
    if (!this._activeHostTab || !hosts.find(h => h.id === this._activeHostTab)) {
      this._activeHostTab = hosts[0]?.id;
    }

    const tabsHtml = hosts.map(h => {
      const isActive = h.id === this._activeHostTab;
      const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${h.healthy ? 'var(--green)' : 'var(--red)'};margin-right:5px"></span>`;
      return `<button class="tab ${isActive ? 'active' : ''}" data-host-tab="${h.id}" style="font-size:12px;padding:6px 14px">
        ${dot}${Utils.escapeHtml(h.name)}
        <span style="font-size:10px;color:var(--text-dim);margin-left:4px">(${h.counts.running}/${h.counts.total})</span>
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

  _renderSingleHost(el) {
    if (!el) return;
    const host = this._data.hosts.find(h => h.id === this._activeHostTab);
    if (!host) { el.innerHTML = '<div class="text-muted">Host not found</div>'; return; }

    if (!host.healthy) {
      el.innerHTML = `<div class="card" style="border:1px solid var(--red);border-left:4px solid var(--red);padding:20px;text-align:center">
        <i class="fas fa-exclamation-triangle" style="font-size:32px;color:var(--red);margin-bottom:12px"></i>
        <h3 style="color:var(--red)">Host Offline</h3>
        <p class="text-muted">Cannot reach ${Utils.escapeHtml(host.name)}.</p>
      </div>`;
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
    for (const host of this._data.hosts) {
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

  destroy() {
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  },
};

window.MultiHostPage = MultiHostPage;
