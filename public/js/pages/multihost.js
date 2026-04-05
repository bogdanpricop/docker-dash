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

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-network-wired" style="color:var(--accent)"></i> Multi-Host Overview</h2>
        <div class="page-actions">
          <div class="tabs" style="margin:0">
            <button class="tab ${this._tab === 'host' ? 'active' : ''}" data-mh-tab="host">
              <i class="fas fa-server" style="margin-right:4px"></i>By Host
            </button>
            <button class="tab ${this._tab === 'stack' ? 'active' : ''}" data-mh-tab="stack">
              <i class="fas fa-layer-group" style="margin-right:4px"></i>By Stack
            </button>
          </div>
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
      });
    });

    container.querySelector('#mh-refresh').addEventListener('click', () => this._load());

    await this._load();
    this._refreshTimer = setInterval(() => this._load(), 15000);
  },

  async _load() {
    try {
      this._data = await Api.getMultiHostOverview();
      this._renderStats();
      this._renderContent();
    } catch (err) {
      const el = document.getElementById('mh-content');
      if (el) el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderStats() {
    const el = document.getElementById('mh-stats');
    if (!el || !this._data) return;
    const { totals } = this._data;
    const stopped = totals.containers - totals.running;

    el.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-icon blue"><i class="fas fa-server"></i></div>
          <div class="stat-body">
            <div class="stat-value">${totals.hosts} <span style="font-size:13px;color:var(--text-muted);font-weight:400">/ ${totals.healthyHosts} online</span></div>
            <div class="stat-label">Hosts</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon purple"><i class="fas fa-cube"></i></div>
          <div class="stat-body">
            <div class="stat-value">${totals.containers}</div>
            <div class="stat-label">Total Containers</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon green"><i class="fas fa-play-circle"></i></div>
          <div class="stat-body">
            <div class="stat-value">${totals.running}</div>
            <div class="stat-label">Running</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon red"><i class="fas fa-stop-circle"></i></div>
          <div class="stat-body">
            <div class="stat-value">${stopped}</div>
            <div class="stat-label">Stopped</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon volumes"><i class="fas fa-layer-group"></i></div>
          <div class="stat-body">
            <div class="stat-value">${totals.images}</div>
            <div class="stat-label">Total Images</div>
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

    if (!this._data.hosts.length) {
      el.innerHTML = '<div class="empty-msg">No hosts configured.</div>';
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
          </span>
        </div>
        <div class="card-body" style="padding:12px 16px">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">
            ${host.info.os ? `<i class="fas fa-linux" style="margin-right:4px"></i>${Utils.escapeHtml(host.info.os)}` : ''}
            ${host.info.dockerVersion ? `&nbsp;&nbsp;<i class="fab fa-docker" style="margin-right:4px"></i>Docker ${Utils.escapeHtml(host.info.dockerVersion)}` : ''}
            ${host.info.cpus ? `&nbsp;&nbsp;<i class="fas fa-microchip" style="margin-right:4px"></i>${host.info.cpus} CPUs` : ''}
            ${host.info.memTotal ? `&nbsp;&nbsp;<i class="fas fa-memory" style="margin-right:4px"></i>${Utils.formatBytes(host.info.memTotal)} RAM` : ''}
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
          <div class="card-header" style="display:flex;align-items:center;gap:10px;cursor:pointer"
               data-mh-stack-toggle="${Utils.escapeHtml(key)}">
            <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="font-size:12px;color:var(--text-muted)"></i>
            <i class="fas fa-layer-group" style="color:var(--accent)"></i>
            <strong>${label}</strong>
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

  destroy() {
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  },
};

window.MultiHostPage = MultiHostPage;
