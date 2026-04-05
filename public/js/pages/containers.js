/* ═══════════════════════════════════════════════════
   pages/containers.js — Containers Management
   ═══════════════════════════════════════════════════ */
'use strict';

const ContainersPage = {
  _table: null,
  _refreshTimer: null,
  _view: 'list', // list | detail
  _detailId: null,
  _logStream: null,
  _statsChart: null,
  _metaMap: {},
  _selectedIds: new Set(),
  _kbRow: -1,        // keyboard-focused row index
  _kbRows: [],       // live NodeList cache for keyboard nav
  _boundKbHandler: null,

  async render(container, params = {}) {
    if (params.id) {
      this._view = 'detail';
      this._detailId = params.id;
      await this._renderDetail(container);
    } else {
      this._view = 'list';
      await this._renderList(container);
    }
  },

  // ═══════════════════════════════════════════════
  // LIST VIEW — Grouped by application (stack)
  // ═══════════════════════════════════════════════
  _collapsed: {},
  _filter: '',
  _stateFilter: '',
  _layout: '1col', // '1col' | '2col'

  async _renderList(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-cube"></i> ${i18n.t('pages.containers.title')}</h2>
        <div class="page-actions">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" id="container-search" placeholder="${i18n.t('pages.containers.filterPlaceholder')}">
          </div>
          <label class="toggle-label">
            <input type="checkbox" id="show-all" checked> ${i18n.t('pages.containers.showStopped')}
          </label>
          <div class="view-toggles">
            <button class="btn-icon view-toggle ${this._layout === '1col' ? 'active' : ''}" id="layout-1col" title="${i18n.t('pages.containers.singleColumn')}">
              <i class="fas fa-bars"></i>
            </button>
            <button class="btn-icon view-toggle ${this._layout === '2col' ? 'active' : ''}" id="layout-2col" title="${i18n.t('pages.containers.twoColumns')}">
              <i class="fas fa-th-large"></i>
            </button>
            <span class="toggle-divider"></span>
            <button class="btn-icon view-toggle" id="collapse-all" title="${i18n.t('pages.containers.collapseAll')}">
              <i class="fas fa-compress-alt"></i>
            </button>
            <button class="btn-icon view-toggle" id="expand-all" title="${i18n.t('pages.containers.expandAll')}">
              <i class="fas fa-expand-alt"></i>
            </button>
            <span class="toggle-divider" id="split-view-divider" style="${document.documentElement.getAttribute('data-uimode') === 'enterprise' ? '' : 'display:none'}"></span>
            <button class="btn-icon view-toggle" id="split-view-toggle" title="Split view (Enterprise)" style="${document.documentElement.getAttribute('data-uimode') === 'enterprise' ? '' : 'display:none'}">
              <i class="fas fa-columns"></i>
            </button>
          </div>
          <button class="btn btn-sm btn-primary" id="container-create">
            <i class="fas fa-plus"></i> ${i18n.t('common.new')}
          </button>
          <button class="btn btn-sm btn-warning" id="container-sandbox" title="Launch a sandboxed container with resource limits and network isolation">
            <i class="fas fa-flask"></i> Sandbox
          </button>
          <button class="btn btn-sm btn-secondary" id="container-templates">
            <i class="fas fa-th"></i> ${i18n.t('pages.containers.templates')}
          </button>
          <button class="btn btn-sm btn-secondary" id="container-github-compose" title="Generate docker-compose from a GitHub repository using AI">
            <i class="fab fa-github"></i> From GitHub
          </button>
          <button class="btn btn-sm btn-secondary" id="container-stack-wizard" title="Create a new stack with step-by-step wizard">
            <i class="fas fa-magic"></i> Stack Wizard
          </button>
          <button class="btn btn-sm btn-secondary" id="container-groups" title="Manage groups">
            <i class="fas fa-folder"></i> Groups
          </button>
          <button class="prune-help-btn" id="containers-help" title="${i18n.t('pages.containers.helpTooltip')}">?</button>
          <button class="prune-help-btn" id="containers-guide" title="Actions guide" style="background:var(--accent);color:#fff;border-color:var(--accent)">i</button>
          <button class="btn btn-sm btn-secondary" id="containers-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div id="container-filter-bar" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <div id="container-filter-presets" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-xs filter-preset active" data-filter-preset="">All</button>
          <button class="btn btn-xs filter-preset" data-filter-preset="running">Running</button>
          <button class="btn btn-xs filter-preset" data-filter-preset="stopped">Stopped</button>
          <button class="btn btn-xs filter-preset" data-filter-preset="unhealthy">Unhealthy</button>
          <button class="btn btn-xs filter-preset" data-filter-preset="sandbox">Sandbox</button>
          <button class="btn btn-xs" id="save-filter-btn" style="color:var(--accent)"><i class="fas fa-plus"></i> Save</button>
        </div>
        <div id="container-summary-inline" style="margin-left:auto;display:flex;align-items:center;gap:0"></div>
      </div>
      <div id="container-groups-section"></div>
      <div id="containers-grouped" class="${this._layout === '2col' ? 'stacks-grid-2col' : ''}"></div>
    `;

    container.querySelector('#container-search').addEventListener('input',
      Utils.debounce(e => { this._filter = (e.target.value || '').toLowerCase(); this._renderGrouped(); }, 200));
    container.querySelector('#show-all').addEventListener('change', () => this._loadList());
    container.querySelector('#containers-refresh').addEventListener('click', () => this._loadList());
    container.querySelector('#container-create').addEventListener('click', () => this._createContainerDialog());
    container.querySelector('#container-sandbox').addEventListener('click', () => this._sandboxDialog());
    container.querySelector('#container-templates').addEventListener('click', () => this._templatesDialog());
    container.querySelector('#container-groups').addEventListener('click', () => this._manageGroupsDialog());
    container.querySelector('#containers-help').addEventListener('click', () => this._showHelp());
    container.querySelector('#containers-guide').addEventListener('click', () => this._showActionsGuide());
    container.querySelector('#container-github-compose').addEventListener('click', () => this._githubComposeDialog());
    container.querySelector('#container-stack-wizard').addEventListener('click', () => this._createStackWizard());

    // Save Filter button
    container.querySelector('#save-filter-btn')?.addEventListener('click', async () => {
      const currentSearch = this._filter || '';
      const currentState = this._stateFilter || '';
      if (!currentSearch && !currentState) { Toast.warning('Apply a filter first before saving'); return; }

      const label = prompt('Name this filter preset:', `${currentState || 'custom'}${currentSearch ? ' \u2014 ' + currentSearch : ''}`);
      if (!label) return;

      const saved = JSON.parse(localStorage.getItem('dd-saved-filters') || '[]');
      saved.push({ label, search: currentSearch, state: currentState });
      localStorage.setItem('dd-saved-filters', JSON.stringify(saved));
      this._renderSavedFilters(container);
      Toast.success(`Filter "${label}" saved`);
    });

    // Layout toggles
    container.querySelector('#layout-1col').addEventListener('click', () => {
      this._layout = '1col';
      container.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
      container.querySelector('#layout-1col').classList.add('active');
      const el = document.getElementById('containers-grouped');
      if (el) { el.classList.remove('stacks-grid-2col'); }
    });
    container.querySelector('#layout-2col').addEventListener('click', () => {
      this._layout = '2col';
      container.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
      container.querySelector('#layout-2col').classList.add('active');
      const el = document.getElementById('containers-grouped');
      if (el) { el.classList.add('stacks-grid-2col'); }
    });

    // Collapse / Expand all
    container.querySelector('#collapse-all').addEventListener('click', () => {
      document.querySelectorAll('.stack-group').forEach(g => {
        g.classList.add('collapsed');
        const stack = g.querySelector('.stack-header')?.dataset.stack;
        if (stack) this._collapsed[stack] = true;
      });
    });
    container.querySelector('#expand-all').addEventListener('click', () => {
      document.querySelectorAll('.stack-group').forEach(g => {
        g.classList.remove('collapsed');
        const stack = g.querySelector('.stack-header')?.dataset.stack;
        if (stack) this._collapsed[stack] = false;
      });
    });

    // Split view toggle (Enterprise only)
    this._splitView = false;
    container.querySelector('#split-view-toggle')?.addEventListener('click', () => {
      this._splitView = !this._splitView;
      container.querySelector('#split-view-toggle')?.classList.toggle('active', this._splitView);
      const panel = document.getElementById('split-detail-panel');
      if (this._splitView) {
        if (!panel) {
          const p = document.createElement('div');
          p.id = 'split-detail-panel';
          p.style.cssText = 'border-top:2px solid var(--border);margin-top:12px;padding-top:12px;max-height:40vh;overflow-y:auto;display:none';
          document.getElementById('containers-grouped')?.after(p);
        }
      } else {
        if (panel) panel.remove();
      }
    });

    // Filter preset buttons
    container.querySelectorAll('[data-filter-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('[data-filter-preset]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._stateFilter = btn.dataset.filterPreset;
        this._renderGrouped();
      });
    });

    // Render any previously saved filter presets from localStorage
    this._renderSavedFilters(container);

    // Keyboard navigation
    this._kbRow = -1;
    this._boundKbHandler = this._onKeyNav.bind(this);
    document.addEventListener('keydown', this._boundKbHandler);

    // Sandbox expiry notifications
    this._sandboxExpiredHandler = WS.on('sandbox:expired', (msg) => {
      const d = msg.data || {};
      Toast.warning(`Sandbox "${d.name}" expired and was removed`);
      this._loadList();
    });

    await this._loadList();
    this._refreshTimer = setInterval(() => this._loadList(), 10000);
    this._startStatsPolling();
    this._loadSparklines();
  },

  _onKeyNav(e) {
    // Ignore if focus is inside an input/textarea/select
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (this._view !== 'list') return;

    this._kbRows = Array.from(document.querySelectorAll('#containers-grouped tr[data-cid]'));
    if (!this._kbRows.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._kbRow = Math.min(this._kbRow + 1, this._kbRows.length - 1);
      this._highlightKbRow();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._kbRow = Math.max(this._kbRow - 1, 0);
      this._highlightKbRow();
    } else if (this._kbRow >= 0) {
      const row = this._kbRows[this._kbRow];
      const cid = row?.dataset.cid;
      if (!cid) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        App.navigate(`/containers/${cid}`);
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        const btn = row.querySelector('[data-action="restart"]');
        if (btn) { btn.click(); Toast.info('Restarting…'); }
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        const stopBtn = row.querySelector('[data-action="stop"]');
        const startBtn = row.querySelector('[data-action="start"]');
        if (stopBtn) { stopBtn.click(); Toast.info('Stopping…'); }
        else if (startBtn) { startBtn.click(); Toast.info('Starting…'); }
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        App.navigate(`/containers/${cid}`);
        // Switch to logs tab after navigation (slight delay for render)
        setTimeout(() => {
          document.querySelector('[data-tab="logs"]')?.click();
        }, 300);
      }
    }
  },

  _highlightKbRow() {
    this._kbRows.forEach((r, i) => {
      r.classList.toggle('row-kb-focus', i === this._kbRow);
    });
    const focused = this._kbRows[this._kbRow];
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  },

  async _loadList() {
    try {
      const showAll = document.getElementById('show-all')?.checked ?? true;
      const [containers, metaMap, userGroups, myPerms] = await Promise.all([
        Api.getContainers(showAll),
        Api.getAllContainerMeta().catch(() => ({})),
        Api.getGroups().catch(() => []),
        Api.getMyPermissions().catch(() => ({ permissions: [] })),
      ]);
      this._containers = containers;
      this._lastContainers = containers;
      this._metaMap = metaMap || {};
      this._userGroups = userGroups || [];
      // Build stack permission map for visual indicators
      this._stackPerms = {};
      for (const p of (myPerms.permissions || [])) {
        this._stackPerms[p.stack_name] = p.permission;
      }
      this._renderGrouped();
      this._renderUserGroups();
    } catch (err) {
      Toast.error(i18n.t('pages.containers.loadFailed', { message: err.message }));
    }
  },

  _getVersion(row) {
    const img = row.image || '';
    const parts = img.split(':');
    const tag = parts.length > 1 ? parts[parts.length - 1] : '';
    if (tag && /^[v\d]/.test(tag) && tag !== 'latest') return tag;
    return tag || '—';
  },

  _renderGrouped() {
    const el = document.getElementById('containers-grouped');
    if (!el) return;

    // Preserve layout class on re-render
    if (this._layout === '2col') el.classList.add('stacks-grid-2col');
    else el.classList.remove('stacks-grid-2col');

    let containers = this._containers || [];

    if (this._filter) {
      containers = containers.filter(c => {
        const meta = this._metaMap?.[c.name] || {};
        const searchable = [
          c.name, c.image, c.state, c.stack,
          c.labels?.['com.docker.compose.project'],
          c.labels?.['com.docker.compose.service'],
          Utils.formatPorts(c.ports),
          meta.app_name, meta.description, meta.category, meta.owner
        ].filter(Boolean).join(' ').toLowerCase();
        return searchable.includes(this._filter);
      });
    }

    if (containers.length === 0 && !this._stateFilter) {
      el.innerHTML = `<div class="table-empty">${i18n.t('pages.containers.noContainers')}</div>`;
      return;
    }

    // Health summary bar (computed from filtered-by-text containers, before state filter)
    const total = containers.length;
    const running = containers.filter(c => c.state === 'running').length;
    const stopped = containers.filter(c => c.state === 'exited').length;
    const other = total - running - stopped;
    const _getScore = (c) => {
      const s = c.status || '';
      const hm = s.match(/\((healthy|unhealthy|health: starting)\)/i);
      const hs = hm ? hm[1].replace('health: ', '') : undefined;
      const em = s.match(/Exited \((\d+)\)/);
      const ec = em ? parseInt(em[1], 10) : 0;
      return Utils.containerHealthScore({ state: c.state, exitCode: ec, health: hs, restartCount: 0, cpuPercent: 0, memPercent: 0, imageAge: 0, vulnCount: 0 });
    };
    const needsAttention = containers.filter(c => _getScore(c) < 80).length;

    // Apply state filter (after computing summary counts)
    if (this._stateFilter === 'running') containers = containers.filter(c => c.state === 'running');
    else if (this._stateFilter === 'exited') containers = containers.filter(c => c.state === 'exited');
    else if (this._stateFilter === 'stopped') containers = containers.filter(c => c.state !== 'running');
    else if (this._stateFilter === 'unhealthy') containers = containers.filter(c => (c.status || '').toLowerCase().includes('unhealthy'));
    else if (this._stateFilter === 'sandbox') containers = containers.filter(c => c.labels?.['docker-dash.sandbox'] === 'true');
    else if (this._stateFilter === 'other') containers = containers.filter(c => c.state !== 'running' && c.state !== 'exited');
    else if (this._stateFilter === 'attention') containers = containers.filter(c => _getScore(c) < 80);

    const activeFilter = this._stateFilter || '';
    // Render summary stats into the inline container (right side of filter bar)
    const summaryInline = document.getElementById('container-summary-inline');
    if (summaryInline) {
      summaryInline.innerHTML = `
        <span class="summary-item" style="font-size:11px"><i class="fas fa-cube"></i> <strong>${total}</strong></span>
        <span class="summary-sep" style="font-size:11px">|</span>
        <span class="summary-item summary-filter ${activeFilter === 'running' ? 'active' : ''} text-green" data-state-filter="running" style="font-size:11px;cursor:pointer"><i class="fas fa-play"></i> ${running}</span>
        <span class="summary-sep" style="font-size:11px">|</span>
        <span class="summary-item summary-filter ${activeFilter === 'exited' ? 'active' : ''} text-muted" data-state-filter="exited" style="font-size:11px;cursor:pointer"><i class="fas fa-stop"></i> ${stopped}</span>
        ${other > 0 ? `<span class="summary-sep" style="font-size:11px">|</span><span class="summary-item summary-filter ${activeFilter === 'other' ? 'active' : ''} text-yellow" data-state-filter="other" style="font-size:11px;cursor:pointer"><i class="fas fa-exclamation-triangle"></i> ${other}</span>` : ''}
        ${needsAttention > 0 ? `<span class="summary-sep" style="font-size:11px">|</span><span class="summary-item summary-filter ${activeFilter === 'attention' ? 'active' : ''} text-orange" data-state-filter="attention" style="font-size:11px;cursor:pointer"><i class="fas fa-heartbeat"></i> ${needsAttention}</span>` : ''}
      `;
      summaryInline.querySelectorAll('[data-state-filter]').forEach(item => {
        item.addEventListener('click', () => {
          const f = item.dataset.stateFilter;
          this._stateFilter = this._stateFilter === f ? '' : f;
          this._renderGrouped();
        });
      });
    }
    const summaryHtml = '';

    const groups = {};
    containers.forEach(c => {
      const stack = c.stack || c.labels?.['com.docker.compose.project'] || '_standalone';
      if (!groups[stack]) groups[stack] = [];
      groups[stack].push(c);
    });

    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === '_standalone') return 1;
      if (b === '_standalone') return -1;
      return a.localeCompare(b);
    });

    el.innerHTML = summaryHtml + sortedKeys.map(stack => {
      const items = groups[stack];
      const isStandalone = stack === '_standalone';
      const collapsed = this._collapsed[stack] || false;
      const running = items.filter(c => c.state === 'running').length;
      const total = items.length;
      const allRunning = running === total;
      const stackPerm = this._stackPerms?.[stack];
      const hasRestriction = stackPerm && stackPerm !== 'admin';
      const permLabel = stackPerm === 'view' ? 'View Only' : stackPerm === 'operate' ? 'Operate' : stackPerm === 'none' ? 'Hidden' : '';

      return `
        <div class="stack-group ${collapsed ? 'collapsed' : ''}">
          <div class="stack-header" data-stack="${Utils.escapeHtml(stack)}">
            <div class="stack-header-left">
              <i class="fas fa-chevron-down stack-chevron"></i>
              <i class="fas ${isStandalone ? 'fa-cube' : 'fa-layer-group'} stack-icon"></i>
              <span class="stack-name">${isStandalone ? i18n.t('pages.containers.standalone') : Utils.escapeHtml(stack)}</span>
              <span class="stack-count">${total}</span>
              ${hasRestriction ? `<span class="badge badge-warning" style="font-size:9px;margin-left:6px" title="Your permission: ${permLabel}"><i class="fas fa-lock" style="margin-right:3px"></i>${permLabel}</span>` : ''}
            </div>
            <div class="stack-header-right">
              <span class="stack-status ${allRunning ? 'all-running' : ''}">
                <i class="fas fa-circle"></i> ${running}/${total}
              </span>
              <div class="stack-actions" data-stop-propagation style="display:flex;align-items:center;gap:2px">
                <button class="action-btn" data-stack-sec="vuln" data-stack="${Utils.escapeHtml(stack)}" title="Security scan — scan all images in this stack" style="color:var(--yellow,#ffc107)"><i class="fas fa-search-plus"></i></button>
                <button class="action-btn" data-stack-sec="cis" data-stack="${Utils.escapeHtml(stack)}" title="CIS Benchmark — check containers in this stack" style="color:var(--green,#4ade80)"><i class="fas fa-clipboard-check"></i></button>
                ${!isStandalone ? `<span class="toggle-divider" style="margin:0 2px;width:1px;height:16px;background:var(--border)"></span>` : ''}
              </div>
              ${!isStandalone ? `
              <div class="stack-actions" data-stop-propagation>
                ${running < total ? `<button class="action-btn" data-stack-action="start" data-stack="${Utils.escapeHtml(stack)}" title="${i18n.t('pages.containers.startAll')}"><i class="fas fa-play"></i></button>` : ''}
                ${running > 0 ? `<button class="action-btn" data-stack-action="restart" data-stack="${Utils.escapeHtml(stack)}" title="${i18n.t('pages.containers.restartAll')}"><i class="fas fa-redo"></i></button>` : ''}
                ${running > 0 ? `<button class="action-btn" data-stack-action="stop" data-stack="${Utils.escapeHtml(stack)}" title="${i18n.t('pages.containers.stopAll')}"><i class="fas fa-stop"></i></button>` : ''}
                <span class="toggle-divider" style="margin:0 2px"></span>
                <button class="action-btn" data-compose-action="pull" data-stack="${Utils.escapeHtml(stack)}" title="${i18n.t('pages.containers.composePull')}"><i class="fas fa-cloud-download-alt"></i></button>
                <button class="action-btn" data-compose-action="up" data-stack="${Utils.escapeHtml(stack)}" title="${i18n.t('pages.containers.composeUp')}"><i class="fas fa-arrow-circle-up"></i></button>
                <button class="action-btn" data-compose-action="config" data-stack="${Utils.escapeHtml(stack)}" title="${i18n.t('pages.containers.composeConfig')}"><i class="fas fa-file-code"></i></button>
                <button class="action-btn" data-stack-action="clone" data-stack="${Utils.escapeHtml(stack)}" title="Clone stack"><i class="fas fa-copy"></i></button>
              </div>` : ''}
            </div>
          </div>
          <div class="stack-body">
            <table class="data-table containers-table">
              <thead>
                <tr>
                  <th style="width:32px"><input type="checkbox" class="bulk-checkbox bulk-select-all" data-stack="${Utils.escapeHtml(stack)}" title="Select all"></th>
                  <th>${i18n.t('pages.containers.service')}</th>
                  <th>${i18n.t('pages.containers.image')}</th>
                  <th>${i18n.t('pages.containers.version')}</th>
                  <th>${i18n.t('common.status')}</th>
                  <th>${i18n.t('pages.containers.ports')}</th>
                  <th>${i18n.t('pages.containers.created')}</th>
                  <th style="width:130px"></th>
                </tr>
              </thead>
              <tbody>
                ${items.map(c => this._renderRow(c, isStandalone)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }).join('');

    // Stop propagation for elements that need it (checkboxes, action bars, links)
    el.querySelectorAll('[data-stop-propagation]').forEach(node => {
      node.addEventListener('click', (e) => e.stopPropagation());
    });

    el.querySelectorAll('.stack-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn, button')) return;
        const stack = header.dataset.stack;
        this._collapsed[stack] = !this._collapsed[stack];
        header.closest('.stack-group').classList.toggle('collapsed');
      });
    });

    // Summary bar filter clicks
    el.querySelectorAll('.summary-filter').forEach(item => {
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        const filter = item.dataset.stateFilter;
        this._stateFilter = (this._stateFilter === filter) ? '' : filter;
        this._renderGrouped();
      });
    });

    el.querySelectorAll('tr[data-cid]').forEach(tr => {
      tr.addEventListener('click', async (e) => {
        if (e.target.closest('.action-btn, button, .bulk-checkbox')) return;
        const cid = tr.dataset.cid;
        if (this._splitView) {
          const panel = document.getElementById('split-detail-panel');
          if (panel) {
            panel.style.display = '';
            panel.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
            try {
              const data = await Api.getContainer(cid);
              const name = data.Name?.replace(/^\//, '') || cid;
              const statusClass = Utils.statusBadgeClass(data.State?.Status || 'unknown');
              const networks = Object.keys(data.NetworkSettings?.Networks || {}).join(', ') || '—';
              const ports = Object.keys(data.NetworkSettings?.Ports || {}).filter(p => data.NetworkSettings.Ports[p]).join(', ') || '—';
              const mounts = (data.Mounts || []).length;
              panel.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                  <h4 style="margin:0"><i class="fas fa-cube" style="color:var(--accent);margin-right:6px"></i>${Utils.escapeHtml(name)}</h4>
                  <div style="display:flex;gap:6px" id="split-panel-btns"></div>
                </div>
                <div class="info-grid" style="grid-template-columns:1fr 1fr">
                  <table class="info-table">
                    <tr><td>Image</td><td class="mono text-sm">${Utils.escapeHtml(data.Config?.Image || '')}</td></tr>
                    <tr><td>Status</td><td><span class="badge ${statusClass}">${data.State?.Status || 'unknown'}</span></td></tr>
                    <tr><td>Created</td><td>${data.Created ? Utils.timeAgo(data.Created) : '—'}</td></tr>
                    <tr><td>Restart Count</td><td>${data.RestartCount || 0}</td></tr>
                  </table>
                  <table class="info-table">
                    <tr><td>Network</td><td class="mono text-sm">${Utils.escapeHtml(networks)}</td></tr>
                    <tr><td>Ports</td><td class="mono text-sm">${Utils.escapeHtml(ports)}</td></tr>
                    <tr><td>Mounts</td><td>${mounts} volume(s)</td></tr>
                    <tr><td>PID</td><td class="mono">${data.State?.Pid || '—'}</td></tr>
                  </table>
                </div>
              `;
              const btnContainer = panel.querySelector('#split-panel-btns');
              const fullViewBtn = document.createElement('button');
              fullViewBtn.className = 'btn btn-xs btn-secondary';
              fullViewBtn.innerHTML = '<i class="fas fa-external-link-alt"></i> Full View';
              fullViewBtn.addEventListener('click', () => App.navigate(`/containers/${cid}`));
              const closeBtn = document.createElement('button');
              closeBtn.className = 'btn btn-xs btn-secondary';
              closeBtn.innerHTML = '<i class="fas fa-times"></i>';
              closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
              btnContainer.appendChild(fullViewBtn);
              btnContainer.appendChild(closeBtn);
            } catch (err) {
              panel.innerHTML = `<div class="text-muted" style="color:var(--red)">${err.message}</div>`;
            }
          }
        } else {
          App.navigate(`/containers/${cid}`);
        }
      });
      tr.addEventListener('contextmenu', (e) => {
        const cid = tr.dataset.cid;
        const containers = this._lastContainers || [];
        const c = containers.find(ct => ct.id === cid);
        if (!c) return;
        const running = c.state === 'running';
        const paused = c.state === 'paused';

        ContextMenu.show(e, [
          { label: 'Open Details', icon: 'fa-external-link-alt', action: () => App.navigate(`/containers/${cid}`) },
          { label: 'Open Terminal', icon: 'fa-terminal', action: () => { App.navigate(`/containers/${cid}`); setTimeout(() => document.querySelector('[data-tab="terminal"]')?.click(), 400); }, disabled: !running },
          { label: 'View Logs', icon: 'fa-file-alt', action: () => { App.navigate(`/containers/${cid}`); setTimeout(() => document.querySelector('[data-tab="logs"]')?.click(), 400); } },
          { type: 'separator' },
          { label: running ? 'Stop' : 'Start', icon: running ? 'fa-stop' : 'fa-play', action: () => this._containerAction(cid, running ? 'stop' : 'start') },
          { label: 'Restart', icon: 'fa-redo', action: () => this._containerAction(cid, 'restart'), disabled: !running },
          { label: paused ? 'Unpause' : 'Pause', icon: paused ? 'fa-play' : 'fa-pause', action: () => this._containerAction(cid, paused ? 'unpause' : 'pause'), disabled: !running && !paused },
          { type: 'separator' },
          { label: 'Inspect', icon: 'fa-info-circle', action: () => App.navigate(`/containers/${cid}`) },
          { label: 'Rename', icon: 'fa-edit', action: () => this._renameContainer(cid, c.name) },
          { label: 'Migrate to Host', icon: 'fa-exchange-alt', action: () => this._migrateWizard(cid, c.name, c.image) },
          { type: 'separator' },
          { label: 'Remove', icon: 'fa-trash', action: () => this._containerAction(cid, 'remove'), danger: true },
        ]);
      });
    });

    // Bulk selection checkboxes
    el.querySelectorAll('.bulk-row-check').forEach(cb => {
      cb.checked = this._selectedIds.has(cb.dataset.cid);
      if (cb.checked) cb.closest('tr')?.classList.add('row-selected');
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        if (cb.checked) {
          this._selectedIds.add(cb.dataset.cid);
          cb.closest('tr')?.classList.add('row-selected');
        } else {
          this._selectedIds.delete(cb.dataset.cid);
          cb.closest('tr')?.classList.remove('row-selected');
        }
        this._updateBulkBar();
      });
    });

    // Select-all per stack
    el.querySelectorAll('.bulk-select-all').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const stack = cb.dataset.stack;
        const tbody = cb.closest('table')?.querySelector('tbody');
        if (!tbody) return;
        tbody.querySelectorAll('.bulk-row-check:not(:disabled)').forEach(rcb => {
          rcb.checked = cb.checked;
          if (cb.checked) {
            this._selectedIds.add(rcb.dataset.cid);
            rcb.closest('tr')?.classList.add('row-selected');
          } else {
            this._selectedIds.delete(rcb.dataset.cid);
            rcb.closest('tr')?.classList.remove('row-selected');
          }
        });
        this._updateBulkBar();
      });
    });

    // Stack-level actions (start/stop/restart all in stack, clone)
    el.querySelectorAll('[data-stack-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.stackAction;
        const stackName = btn.dataset.stack;

        // Clone stack — handled separately
        if (action === 'clone') {
          const newName = prompt(`Clone stack "${stackName}" — enter new name:`, stackName + '-copy');
          if (!newName || newName === stackName) return;
          try {
            const config = await Api.composeConfig(stackName);
            const yaml = config.config || config.yaml || '';
            if (!yaml) { Toast.warning('No compose config found for this stack'); return; }
            await Api.saveStackConfig(newName, { config: yaml });
            Toast.success(`Stack "${newName}" created from "${stackName}". Go to Stacks page to deploy.`);
          } catch (err) { Toast.error('Clone failed: ' + err.message); }
          return;
        }

        const containers = (this._containers || []).filter(c =>
          (c.stack || c.labels?.['com.docker.compose.project']) === stackName
        );
        const ids = containers.map(c => c.id);
        if (ids.length === 0) return;

        const ok = await Modal.confirm(
          i18n.t('pages.containers.stackConfirm', { action: action.charAt(0).toUpperCase() + action.slice(1), count: ids.length, stack: stackName }),
          { confirmText: action.charAt(0).toUpperCase() + action.slice(1) }
        );
        if (!ok) return;

        try {
          const result = await Api.bulkContainerAction(ids, action);
          const failed = (result.results || []).filter(r => !r.ok);
          if (failed.length > 0) {
            Toast.warning(i18n.t('pages.containers.stackErrors', { action, count: failed.length }));
          } else {
            Toast.success(i18n.t('pages.containers.stackSuccess', { stack: stackName, action }));
          }
          await this._loadList();
        } catch (err) { Toast.error(err.message); }
      });
    });

    // Compose actions (pull, up, config)
    el.querySelectorAll('[data-compose-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.composeAction;
        const stackName = btn.dataset.stack;

        if (action === 'config') {
          try {
            const data = await Api.composeConfig(stackName);
            const stackDetail = await Api.getStack(stackName);
            Modal.open(`
              <div class="modal-header">
                <h3><i class="fas fa-file-code" style="color:var(--accent);margin-right:8px"></i> docker-compose.yml — ${Utils.escapeHtml(stackName)}</h3>
                <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
              </div>
              <div class="modal-body">
                ${data.generated ? `<div style="margin-bottom:10px;padding:8px 12px;background:var(--yellow-dim,rgba(255,193,7,.12));border:1px solid var(--yellow,#ffc107);border-radius:var(--radius-sm);font-size:12px;color:var(--text-dim)"><i class="fas fa-magic" style="margin-right:6px;color:var(--yellow,#ffc107)"></i><strong>Generated from container metadata</strong> — no compose file found on disk. Edit and save to create one.</div>` : ''}
                <textarea id="compose-editor" style="width:100%;min-height:400px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:var(--mono);font-size:12px;padding:12px;resize:vertical;outline:none;border-radius:var(--radius-sm);tab-size:2">${Utils.escapeHtml(data.config || '')}</textarea>
                <div id="compose-validation-msg" style="margin-top:8px;display:none" class="text-sm"></div>
              </div>
              <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
                <button class="btn btn-secondary" id="copy-compose"><i class="fas fa-copy"></i> ${i18n.t('common.copy')}</button>
                <button class="btn btn-secondary" id="validate-compose"><i class="fas fa-check-circle"></i> Validate</button>
                <button class="btn btn-primary" id="save-compose"><i class="fas fa-save"></i> ${i18n.t('common.save')}</button>
                <button class="btn btn-accent" id="save-deploy-compose"><i class="fas fa-rocket"></i> Save & Deploy</button>
                <button class="btn btn-secondary" id="modal-ok">${i18n.t('common.close')}</button>
              </div>
            `, { width: '800px' });
            Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
            Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
            Modal._content.querySelector('#copy-compose').addEventListener('click', () => {
              const val = Modal._content.querySelector('#compose-editor').value;
              Utils.copyToClipboard(val).then(() => Toast.success(i18n.t('common.copied')));
            });
            // Handle Tab key in textarea
            Modal._content.querySelector('#compose-editor').addEventListener('keydown', (e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const ta = e.target;
                const start = ta.selectionStart;
                ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(ta.selectionEnd);
                ta.selectionStart = ta.selectionEnd = start + 2;
              }
            });
            Modal._content.querySelector('#validate-compose').addEventListener('click', async () => {
              const msgEl = Modal._content.querySelector('#compose-validation-msg');
              const yamlContent = Modal._content.querySelector('#compose-editor').value;
              msgEl.style.display = '';
              msgEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Validating...';
              try {
                const result = await Api.validateStackConfig(stackName, { config: yamlContent, workingDir: stackDetail.workingDir });
                if (result.valid) {
                  msgEl.innerHTML = '<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Valid YAML</span>';
                } else {
                  msgEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(result.error)}</span>`;
                }
              } catch (err) {
                msgEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</span>`;
              }
            });
            const saveCompose = async (deploy = false) => {
              const yamlContent = Modal._content.querySelector('#compose-editor').value;
              try {
                await Api.saveStackConfig(stackName, { config: yamlContent, workingDir: stackDetail.workingDir });
                Toast.success('Configuration saved');
                if (deploy) {
                  Toast.info('Deploying...');
                  await Api.deployStack(stackName, { workingDir: stackDetail.workingDir });
                  Toast.success('Stack deployed');
                  Modal.close();
                  await this._loadList();
                }
              } catch (err) { Toast.error(err.message); }
            };
            Modal._content.querySelector('#save-compose').addEventListener('click', () => saveCompose(false));
            Modal._content.querySelector('#save-deploy-compose').addEventListener('click', () => saveCompose(true));
          } catch (err) { Toast.error(err.message); }
          return;
        }

        const ok = await Modal.confirm(
          i18n.t('pages.containers.composeConfirm', { action: action.toUpperCase(), stack: stackName }),
          { confirmText: action.toUpperCase() }
        );
        if (!ok) return;

        try {
          Toast.info(`${action}... ${stackName}`);
          await Api.composeAction(stackName, action);
          Toast.success(i18n.t('pages.containers.composeSuccess', { stack: stackName, action }));
          await this._loadList();
        } catch (err) {
          Toast.error(i18n.t('pages.containers.composeFailed', { action, message: err.message }));
        }
      });
    });

    // Stack security buttons (vuln scan + CIS)
    el.querySelectorAll('[data-stack-sec]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const type = btn.dataset.stackSec;
        const stackName = btn.dataset.stack;
        const stackContainers = (this._containers || []).filter(c =>
          (c.stack || c.labels?.['com.docker.compose.project'] || '_standalone') === stackName
        );
        if (type === 'vuln') {
          await this._showStackVulnModal(stackName, stackContainers);
        } else {
          await this._showStackCisModal(stackName, stackContainers);
        }
      });
    });
  },

  async _showStackVulnModal(stackName, containers) {
    const images = [...new Set(containers.map(c => c.image).filter(Boolean))];
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-search-plus" style="color:var(--yellow,#ffc107);margin-right:10px"></i>
          Security Scan — <span style="color:var(--accent)">${Utils.escapeHtml(stackName)}</span>
        </h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" id="stack-vuln-body">
        <div style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span class="text-muted text-sm"><i class="fas fa-layer-group" style="margin-right:5px"></i>${containers.length} container${containers.length > 1 ? 's' : ''}, ${images.length} unique image${images.length > 1 ? 's' : ''} to scan</span>
          <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
            ${images.map(img => `<span class="badge" style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escapeHtml(img)}">${Utils.escapeHtml(img.split('/').pop().substring(0, 30))}</span>`).join('')}
          </div>
        </div>
        <div id="stack-scan-results" style="display:flex;flex-direction:column;gap:12px">
          <div class="text-muted text-sm"><i class="fas fa-info-circle" style="margin-right:5px"></i>Click "Scan All" to start vulnerability scanning for all images in this stack.</div>
        </div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <span id="stack-scan-summary" style="flex:1;font-size:12px;line-height:1.5;align-self:center"></span>
        <button class="btn btn-primary" id="stack-scan-btn"><i class="fas fa-play" style="margin-right:6px"></i>Scan All</button>
        <button class="btn btn-secondary" id="modal-ok">Close</button>
      </div>
    `, { width: '860px' });

    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

    Modal._content.querySelector('#stack-scan-btn').addEventListener('click', async () => {
      const scanBtn = Modal._content.querySelector('#stack-scan-btn');
      const resultsEl = Modal._content.querySelector('#stack-scan-results');
      const summaryEl = Modal._content.querySelector('#stack-scan-summary');
      scanBtn.disabled = true;
      scanBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Scanning...';

      // Render per-image placeholders
      resultsEl.innerHTML = images.map(img => `
        <div id="scan-img-${Utils.escapeHtml(img.replace(/[^a-z0-9]/gi,'_'))}" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
          <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface2)">
            <i class="fas fa-spinner fa-spin" style="color:var(--accent);width:16px"></i>
            <span class="mono text-sm" style="flex:1">${Utils.escapeHtml(img)}</span>
            <span class="badge" style="font-size:10px">Scanning…</span>
          </div>
        </div>
      `).join('');

      let totalC = 0, totalH = 0, totalM = 0, totalL = 0, totalFix = 0;
      await Promise.all(images.map(async (img) => {
        const safeId = img.replace(/[^a-z0-9]/gi,'_');
        const el = resultsEl.querySelector(`#scan-img-${safeId}`);
        try {
          await Api.scanImage(encodeURIComponent(img), 'auto');
          const history = await Api.get(`/images/scan-history?image=${encodeURIComponent(img)}&limit=1`);
          const r = history[0];
          if (!r) throw new Error('No result');
          totalC += r.summary_critical; totalH += r.summary_high;
          totalM += r.summary_medium; totalL += r.summary_low; totalFix += r.fixable_count;
          const sevColor = r.summary_critical > 0 ? 'var(--red)' : r.summary_high > 0 ? '#f97316' : r.summary_total > 0 ? 'var(--yellow)' : 'var(--green)';
          const badge = r.summary_critical > 0 ? `badge-stopped` : r.summary_high > 0 ? `badge-warning` : r.summary_total > 0 ? `badge-warning` : `badge-running`;
          if (el) {
            el.innerHTML = `
              <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface2)">
                <i class="fas fa-shield-alt" style="color:${sevColor};width:16px"></i>
                <span class="mono text-sm" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(img)}</span>
                <span class="badge ${badge}" style="font-size:10px">${r.summary_total} vulns</span>
              </div>
              <div style="display:flex;align-items:center;gap:16px;padding:10px 14px;flex-wrap:wrap">
                ${r.summary_critical > 0 ? `<span style="font-size:12px;color:var(--red)"><strong>${r.summary_critical}</strong> Critical</span>` : ''}
                ${r.summary_high > 0 ? `<span style="font-size:12px;color:#f97316"><strong>${r.summary_high}</strong> High</span>` : ''}
                ${r.summary_medium > 0 ? `<span style="font-size:12px;color:var(--yellow)"><strong>${r.summary_medium}</strong> Medium</span>` : ''}
                ${r.summary_low > 0 ? `<span style="font-size:12px;color:var(--text-dim)"><strong>${r.summary_low}</strong> Low</span>` : ''}
                ${r.fixable_count > 0 ? `<span style="font-size:12px;color:var(--green)"><i class="fas fa-tools" style="margin-right:3px"></i>${r.fixable_count} fixable</span>` : ''}
                ${r.summary_total === 0 ? `<span style="font-size:12px;color:var(--green)"><i class="fas fa-check-circle" style="margin-right:4px"></i>No vulnerabilities found</span>` : ''}
                <button class="btn btn-sm btn-secondary stack-scan-detail-btn" data-scan-id="${r.id}" style="margin-left:auto;font-size:11px">
                  <i class="fas fa-list-ul" style="margin-right:4px"></i>View Details
                </button>
              </div>`;
            el.querySelector('.stack-scan-detail-btn').addEventListener('click', () => this._openScanDetailOverlay(r.id));
          }
        } catch (err) {
          if (el) el.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface2)">
              <i class="fas fa-exclamation-triangle" style="color:var(--yellow);width:16px"></i>
              <span class="mono text-sm" style="flex:1">${Utils.escapeHtml(img)}</span>
              <span class="badge badge-warning" style="font-size:10px">Error</span>
            </div>
            <div style="padding:8px 14px;font-size:12px;color:var(--text-dim)">${Utils.escapeHtml(err.message)}</div>`;
        }
      }));

      const overallColor = totalC > 0 ? 'var(--red)' : totalH > 0 ? '#f97316' : (totalM + totalL) > 0 ? 'var(--yellow)' : 'var(--green)';
      summaryEl.innerHTML = `
        <span style="font-weight:600;color:${overallColor}"><i class="fas fa-shield-alt" style="margin-right:5px"></i>Total:</span>
        ${totalC > 0 ? `<span style="margin-left:8px;color:var(--red)">${totalC} Critical</span>` : ''}
        ${totalH > 0 ? `<span style="margin-left:8px;color:#f97316">${totalH} High</span>` : ''}
        ${totalM > 0 ? `<span style="margin-left:8px;color:var(--yellow)">${totalM} Med</span>` : ''}
        ${totalL > 0 ? `<span style="margin-left:8px;color:var(--text-dim)">${totalL} Low</span>` : ''}
        ${totalFix > 0 ? `<span style="margin-left:8px;color:var(--green)">${totalFix} fixable</span>` : ''}
        ${(totalC + totalH + totalM + totalL) === 0 ? `<span style="margin-left:8px;color:var(--green)">All clear!</span>` : ''}
      `;
      scanBtn.disabled = false;
      scanBtn.innerHTML = '<i class="fas fa-sync-alt" style="margin-right:6px"></i>Re-scan';
    });
  },

  async _openScanDetailOverlay(scanId) {
    // Opens scan detail over the existing Security Scan modal (does not close it)
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10500;
      background:rgba(0,0,0,.6);backdrop-filter:blur(2px);
      display:flex;align-items:center;justify-content:center;padding:16px;
    `;
    overlay.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius,8px);max-width:860px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden">
      <div style="display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
        <i class="fas fa-shield-alt" style="color:var(--accent);font-size:16px"></i>
        <h3 id="sd-title" style="margin:0;flex:1;font-size:15px">Loading…</h3>
        <button id="sd-close" style="background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;padding:4px 8px;line-height:1">&times;</button>
      </div>
      <div id="sd-body" style="overflow-y:auto;padding:20px;flex:1">
        <div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Loading scan details…</div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
        <button id="sd-copy-prompt" class="btn btn-sm btn-secondary" style="display:none"><i class="fas fa-robot" style="margin-right:5px"></i>Copy AI Prompt</button>
        <button id="sd-close-footer" class="btn btn-secondary">Close</button>
      </div>
    </div>`;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#sd-close').addEventListener('click', close);
    overlay.querySelector('#sd-close-footer').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    try {
      const data = await Api.get(`/images/scan-history/${scanId}`);
      const vulns = data.vulnerabilities || [];
      const recs = data.recommendations || [];
      const s = { critical: data.summary_critical, high: data.summary_high, medium: data.summary_medium, low: data.summary_low, total: data.summary_total };
      const sevColor = sev => ({ critical: 'var(--red)', high: '#f97316', medium: 'var(--yellow)', low: 'var(--text-dim)' }[sev] || 'var(--text)');
      const dedup = arr => [...new Map(arr.map(v => [`${v.id}|${v.package}`, v])).values()];
      const criticalVulns = dedup(vulns.filter(v => v.severity === 'critical'));
      const highVulns = dedup(vulns.filter(v => v.severity === 'high'));
      const fixableVulns = dedup(vulns.filter(v => v.fixedIn));
      const uniqueVulns = dedup(vulns);
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
      const sortedVulns = [...vulns].sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

      overlay.querySelector('#sd-title').textContent = `Scan: ${data.image_name}`;

      overlay.querySelector('#sd-body').innerHTML = `
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:14px">
          Scanner: <strong>${Utils.escapeHtml(data.scanner)}</strong> &nbsp;|&nbsp;
          Scanned: ${Utils.formatDate(data.scanned_at)} &nbsp;|&nbsp;
          Fixable: <strong style="color:var(--green)">${data.fixable_count}</strong> / ${s.total}
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">
          <div style="text-align:center;padding:10px;background:rgba(239,68,68,.1);border-radius:var(--radius-sm)">
            <div style="font-size:24px;font-weight:700;color:var(--red)">${s.critical}</div><div style="font-size:11px;margin-top:2px">Critical</div>
          </div>
          <div style="text-align:center;padding:10px;background:rgba(249,115,22,.1);border-radius:var(--radius-sm)">
            <div style="font-size:24px;font-weight:700;color:#f97316">${s.high}</div><div style="font-size:11px;margin-top:2px">High</div>
          </div>
          <div style="text-align:center;padding:10px;background:rgba(234,179,8,.1);border-radius:var(--radius-sm)">
            <div style="font-size:24px;font-weight:700;color:var(--yellow)">${s.medium}</div><div style="font-size:11px;margin-top:2px">Medium</div>
          </div>
          <div style="text-align:center;padding:10px;background:var(--surface2);border-radius:var(--radius-sm)">
            <div style="font-size:24px;font-weight:700">${s.low}</div><div style="font-size:11px;margin-top:2px">Low</div>
          </div>
        </div>

        ${recs.filter(r => r.type !== 'summary').length > 0 ? `
        <div style="margin-bottom:16px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px"><i class="fas fa-lightbulb" style="color:var(--yellow);margin-right:5px"></i>Recommendations</div>
          ${recs.filter(r => r.type !== 'summary').map(r => {
            const c = r.priority === 'critical' ? 'var(--red)' : r.priority === 'high' ? '#f97316' : r.priority === 'medium' ? 'var(--yellow)' : 'var(--text-dim)';
            return `<div style="padding:6px 10px;margin-bottom:4px;border-left:3px solid ${c};background:var(--surface2);border-radius:0 4px 4px 0;font-size:12px">
              <strong>${Utils.escapeHtml(r.title)}</strong>
              <div style="color:var(--text-dim)">${Utils.escapeHtml(r.description)}</div>
              ${r.command ? `<code style="display:block;margin-top:4px;padding:4px 8px;background:var(--surface);border-radius:3px;font-size:11px;color:var(--accent)">${Utils.escapeHtml(r.command)}</code>` : ''}
            </div>`;
          }).join('')}
        </div>` : ''}

        ${vulns.length > 0 ? `
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px">Vulnerabilities (${vulns.length}${vulns.length > 100 ? ', showing top 100' : ''})</div>
        <table class="data-table compact" style="font-size:12px">
          <thead><tr><th>Sev</th><th>CVE</th><th>Package</th><th>Version</th><th>Fix Available</th></tr></thead>
          <tbody>${sortedVulns.slice(0, 100).map(v => `
            <tr>
              <td class="mono" style="color:${sevColor(v.severity)};font-weight:700;font-size:11px">${v.severity.toUpperCase()}</td>
              <td class="mono" style="font-size:11px">${v.url ? `<a href="${Utils.escapeHtml(v.url)}" target="_blank" style="color:var(--accent)">${Utils.escapeHtml(v.id)}</a>` : Utils.escapeHtml(v.id)}</td>
              <td style="font-size:12px">${Utils.escapeHtml(v.package)}</td>
              <td class="mono" style="font-size:11px">${Utils.escapeHtml(v.version)}</td>
              <td style="font-size:11px">${v.fixedIn ? `<span style="color:var(--green)">${Utils.escapeHtml(v.fixedIn)}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div style="color:var(--green);font-size:13px;padding:16px 0;text-align:center"><i class="fas fa-check-circle" style="margin-right:6px"></i>No vulnerabilities found — image is clean.</div>`}
      `;

      // AI prompt
      if (s.total > 0) {
        const aiPrompt = `I have a Docker image "${data.image_name}" scanned with ${data.scanner}.\n\nSummary: ${criticalVulns.length} critical, ${highVulns.length} high, ${uniqueVulns.length} unique CVEs, ${fixableVulns.length} fixable.\n\nTop CVEs:\n${[...criticalVulns, ...highVulns].slice(0,15).map(v=>`- ${v.severity.toUpperCase()} ${v.id}: ${v.package} ${v.version}${v.fixedIn?' (fix: '+v.fixedIn+')':' (no fix)'}`).join('\n')}\n\nPlease:\n1. Generate a fixed Dockerfile resolving all fixable vulnerabilities\n2. Add OS package upgrades appropriate for the base image\n3. Recommend a more secure base image if applicable\n4. For unfixable CVEs, suggest mitigations`;
        const copyBtn = overlay.querySelector('#sd-copy-prompt');
        copyBtn.style.display = '';
        copyBtn.addEventListener('click', () => Utils.copyToClipboard(aiPrompt).then(() => Toast.success('AI prompt copied!')));
      }
    } catch (err) {
      overlay.querySelector('#sd-body').innerHTML = `<div class="text-muted" style="color:var(--red)"><i class="fas fa-exclamation-triangle" style="margin-right:6px"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _showStackCisModal(stackName, containers) {
    const runningContainers = containers.filter(c => c.state === 'running');
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-clipboard-check" style="color:var(--green,#4ade80);margin-right:10px"></i>
          CIS Benchmark — <span style="color:var(--accent)">${Utils.escapeHtml(stackName)}</span>
        </h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" id="stack-cis-body">
        <div style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="text-muted text-sm"><i class="fas fa-box" style="margin-right:5px"></i>${runningContainers.length} running container${runningContainers.length > 1 ? 's' : ''} will be checked</span>
          ${containers.length > runningContainers.length ? `<span class="badge badge-warning" style="font-size:10px"><i class="fas fa-info-circle" style="margin-right:3px"></i>${containers.length - runningContainers.length} stopped (skipped)</span>` : ''}
        </div>
        <div id="stack-cis-score" style="display:none;margin-bottom:16px"></div>
        <div id="stack-cis-results"><div class="text-muted text-sm"><i class="fas fa-info-circle" style="margin-right:5px"></i>Click "Run Benchmark" to check CIS Docker security controls for containers in this stack.</div></div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;align-items:center">
        <button class="btn btn-secondary" id="cis-hardened-all" style="display:none;margin-right:auto"><i class="fas fa-shield-alt" style="margin-right:6px;color:var(--green)"></i>Get Hardened Compose</button>
        <button class="btn btn-primary" id="stack-cis-btn"><i class="fas fa-play" style="margin-right:6px"></i>Run Benchmark</button>
        <button class="btn btn-secondary" id="modal-ok">Close</button>
      </div>
    `, { width: '860px' });

    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

    const runBenchmark = async () => {
      const cisBtn = Modal._content.querySelector('#stack-cis-btn');
      const scoreEl = Modal._content.querySelector('#stack-cis-score');
      const resultsEl = Modal._content.querySelector('#stack-cis-results');
      const hardenBtn = Modal._content.querySelector('#cis-hardened-all');
      cisBtn.disabled = true;
      cisBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Running…';
      resultsEl.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Running CIS benchmark…</div>`;

      try {
        const data = await Api.runCisBenchmark(Api.getHostId() || undefined);
        const containerNames = new Set(runningContainers.map(c => (c.name || '').replace(/^\//, '')));
        const stackChecks = (data.checks || []).filter(c => c.category === 'Container' && containerNames.has(c.title));

        if (stackChecks.length === 0) {
          resultsEl.innerHTML = `<div class="empty-msg"><i class="fas fa-info-circle"></i><p>No CIS container results found for this stack's containers. They may not be running.</p></div>`;
          cisBtn.disabled = false; cisBtn.innerHTML = '<i class="fas fa-sync-alt" style="margin-right:6px"></i>Run Again';
          return;
        }

        const pass = stackChecks.filter(c => c.status === 'pass').length;
        const fail = stackChecks.filter(c => c.status === 'fail').length;
        const warn = stackChecks.filter(c => c.status === 'warn').length;
        const total = stackChecks.length;
        const score = Math.round((pass / total) * 100);
        const scoreColor = score >= 80 ? 'var(--green,#4ade80)' : score >= 50 ? 'var(--yellow,#ffc107)' : 'var(--red,#ef4444)';

        scoreEl.style.display = '';
        scoreEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:20px;padding:14px 16px;background:var(--surface2);border-radius:var(--radius);flex-wrap:wrap">
            <div style="text-align:center;min-width:64px">
              <div style="font-size:36px;font-weight:700;color:${scoreColor};line-height:1">${score}%</div>
              <div class="text-muted" style="font-size:10px;margin-top:2px">Stack Score</div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <span class="badge" style="background:rgba(74,222,128,.15);color:var(--green)"><i class="fas fa-check" style="margin-right:4px"></i>${pass} passed</span>
              <span class="badge" style="background:rgba(239,68,68,.15);color:var(--red)"><i class="fas fa-times" style="margin-right:4px"></i>${fail} failed</span>
              <span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow)"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>${warn} warnings</span>
            </div>
            <div class="text-muted" style="font-size:11px;margin-left:auto">${total} container${total > 1 ? 's' : ''} checked</div>
          </div>`;

        const statusIcon = s => s === 'pass' ? '<i class="fas fa-check-circle" style="color:var(--green)"></i>'
          : s === 'fail' ? '<i class="fas fa-times-circle" style="color:var(--red)"></i>'
          : s === 'warn' ? '<i class="fas fa-exclamation-triangle" style="color:var(--yellow)"></i>'
          : '<i class="fas fa-info-circle" style="color:var(--text-dim)"></i>';

        resultsEl.innerHTML = stackChecks.map(item => {
          const findings = item.findings || [];
          const failCount = findings.filter(f => f.severity === 'fail').length;
          const warnCount = findings.filter(f => f.severity === 'warn').length;
          const isClean = item.status === 'pass';
          return `
            <details style="margin-bottom:8px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden" ${item.status === 'fail' ? 'open' : ''}>
              <summary style="cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:10px;list-style:none;background:var(--surface2)">
                <span>${statusIcon(item.status)}</span>
                <span style="font-weight:600;flex:1">${Utils.escapeHtml(item.title)}</span>
                ${item.image ? `<span class="text-muted mono" style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(item.image.split('/').pop())}</span>` : ''}
                ${failCount ? `<span class="badge" style="background:rgba(239,68,68,.15);color:var(--red);font-size:10px">${failCount} fail</span>` : ''}
                ${warnCount ? `<span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow);font-size:10px">${warnCount} warn</span>` : ''}
                ${isClean ? `<span class="badge" style="background:rgba(74,222,128,.15);color:var(--green);font-size:10px">clean</span>` : ''}
              </summary>
              <div style="padding:12px 14px">
                ${isClean
                  ? `<div style="color:var(--green);font-size:13px"><i class="fas fa-check-circle" style="margin-right:6px"></i>All checks passed.</div>`
                  : findings.map(f => `
                      <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--surface2)">
                        <span style="width:16px;flex-shrink:0;margin-top:1px">${statusIcon(f.severity)}</span>
                        <div style="flex:1;font-size:12px">${Utils.escapeHtml(f.msg)}</div>
                      </div>`).join('')
                }
                ${!isClean ? `<div style="margin-top:10px;text-align:right"><button class="btn btn-sm btn-accent cis-stack-harden-btn" data-container="${Utils.escapeHtml(item.title)}" style="font-size:11px"><i class="fas fa-shield-alt" style="margin-right:4px"></i>Hardened compose</button></div>` : ''}
              </div>
            </details>`;
        }).join('');

        // Wire hardened compose buttons
        resultsEl.querySelectorAll('.cis-stack-harden-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>';
            try {
              const result = await Api.getCisHardenedCompose(btn.dataset.container, Api.getHostId() || undefined);
              const changesHtml = result.changes.length
                ? `<div style="margin-bottom:12px;padding:10px 14px;background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.25);border-radius:var(--radius-sm)"><div style="font-size:11px;font-weight:600;color:var(--green);margin-bottom:6px"><i class="fas fa-check-circle" style="margin-right:5px"></i>${result.changes.length} fixes applied</div><ul style="margin:0;padding-left:18px;font-size:11px;color:var(--text-dim)">${result.changes.map(c => `<li>${Utils.escapeHtml(c)}</li>`).join('')}</ul></div>`
                : '';
              Modal.open(`
                <div class="modal-header">
                  <h3><i class="fas fa-shield-alt" style="color:var(--green);margin-right:8px"></i>Hardened compose — ${Utils.escapeHtml(btn.dataset.container)}</h3>
                  <button class="modal-close-btn" id="modal-x2"><i class="fas fa-times"></i></button>
                </div>
                <div class="modal-body">
                  <div style="margin-bottom:10px;padding:8px 12px;background:rgba(56,139,253,.08);border:1px solid var(--accent);border-radius:var(--radius-sm);font-size:12px;color:var(--text-dim)">
                    <i class="fas fa-info-circle" style="margin-right:6px;color:var(--accent)"></i><strong>Generated &amp; hardened from container metadata.</strong> Adjust <code>mem_limit</code>, <code>cpus</code>, <code>user</code> to match your app.
                  </div>
                  ${changesHtml}
                  <textarea id="harden-out" style="width:100%;min-height:400px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:var(--mono);font-size:12px;padding:12px;resize:vertical;outline:none;border-radius:var(--radius-sm)">${Utils.escapeHtml(result.compose)}</textarea>
                </div>
                <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
                  <button class="btn btn-secondary" id="harden-copy"><i class="fas fa-copy"></i> Copy</button>
                  <button class="btn btn-secondary" id="modal-ok2">Close</button>
                </div>`, { width: '800px' });
              Modal._content.querySelector('#modal-x2').addEventListener('click', () => Modal.close());
              Modal._content.querySelector('#modal-ok2').addEventListener('click', () => Modal.close());
              Modal._content.querySelector('#harden-copy').addEventListener('click', () => {
                Utils.copyToClipboard(Modal._content.querySelector('#harden-out').value).then(() => Toast.success('Copied!'));
              });
            } catch (err) { Toast.error(err.message); }
            finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-shield-alt" style="margin-right:4px"></i>Hardened compose'; }
          });
        });

        if (fail > 0 || warn > 0) hardenBtn.style.display = '';
        hardenBtn.onclick = () => {
          const firstFail = stackChecks.find(c => c.status !== 'pass');
          if (firstFail) resultsEl.querySelector(`.cis-stack-harden-btn[data-container="${firstFail.title}"]`)?.click();
        };

      } catch (err) {
        resultsEl.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle" style="margin-right:6px"></i>${Utils.escapeHtml(err.message)}</div>`;
      } finally {
        cisBtn.disabled = false;
        cisBtn.innerHTML = '<i class="fas fa-sync-alt" style="margin-right:6px"></i>Run Again';
      }
    };

    Modal._content.querySelector('#stack-cis-btn').addEventListener('click', runBenchmark);
  },

  _updateBulkBar() {
    let bar = document.getElementById('bulk-action-bar');
    if (this._selectedIds.size === 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulk-action-bar';
      bar.className = 'bulk-action-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <span class="bulk-count">${this._selectedIds.size} selected</span>
      <button class="btn btn-sm btn-primary" data-bulk="start"><i class="fas fa-play"></i> Start</button>
      <button class="btn btn-sm btn-warning" data-bulk="stop"><i class="fas fa-stop"></i> Stop</button>
      <button class="btn btn-sm btn-secondary" data-bulk="restart"><i class="fas fa-redo"></i> Restart</button>
      <button class="btn btn-sm btn-danger" data-bulk="remove"><i class="fas fa-trash"></i> Remove</button>
      <button class="btn btn-sm btn-secondary" data-bulk="compare"><i class="fas fa-chart-bar"></i> Compare</button>
      <button class="btn btn-sm btn-secondary" data-bulk="clear"><i class="fas fa-times"></i> Clear</button>
    `;
    bar.querySelectorAll('[data-bulk]').forEach(btn => {
      btn.addEventListener('click', () => this._bulkAction(btn.dataset.bulk));
    });
  },

  async _bulkAction(action) {
    if (action === 'clear') {
      this._selectedIds.clear();
      this._updateBulkBar();
      this._renderGrouped();
      return;
    }

    if (action === 'compare') {
      const ids = [...this._selectedIds];
      if (ids.length < 2) { Toast.warning('Select at least 2 containers'); return; }
      if (ids.length > 5) { Toast.warning('Select at most 5 containers'); return; }
      this._showComparisonChart(ids);
      return;
    }

    const ids = [...this._selectedIds];
    if (ids.length === 0) return;

    // Get container names for confirmation
    const names = ids.map(id => {
      const c = (this._containers || []).find(c => c.id === id);
      return c ? (c.name || id.substring(0, 12)) : id.substring(0, 12);
    });

    const confirmMsg = action === 'remove'
      ? `Remove ${ids.length} container(s)?\n\n${names.join(', ')}\n\nThis cannot be undone.`
      : `${action.charAt(0).toUpperCase() + action.slice(1)} ${ids.length} container(s)?`;

    const ok = await Modal.confirm(confirmMsg, {
      danger: action === 'remove',
      confirmText: action.charAt(0).toUpperCase() + action.slice(1),
    });
    if (!ok) return;

    try {
      Toast.info(`${action}... ${ids.length} containers`);
      const result = await Api.bulkContainerAction(ids, action);
      const failed = (result.results || []).filter(r => !r.ok);
      if (failed.length > 0) {
        Toast.warning(`${action}: ${failed.length} failed`);
      } else {
        Toast.success(`${action} completed for ${ids.length} containers`);
      }
      this._selectedIds.clear();
      this._updateBulkBar();
      await this._loadList();
    } catch (err) {
      Toast.error(err.message);
    }
  },

  _renderRow(c, isStandalone) {
    const service = c.labels?.['com.docker.compose.service'] || c.name || '—';
    const imgName = (c.image || '').split(':')[0].split('/').pop();
    const version = this._getVersion(c);
    const ports = Utils.formatPorts(c.ports);
    const created = Utils.timeAgo(new Date(c.created * 1000).toISOString());
    const running = c.state === 'running';
    const paused = c.state === 'paused';

    // Parse health and exit code from Docker status string for health score
    const statusStr = c.status || '';
    const healthMatch = statusStr.match(/\((healthy|unhealthy|health: starting)\)/i);
    const healthStatus = healthMatch ? healthMatch[1].replace('health: ', '') : undefined;
    const exitMatch = statusStr.match(/Exited \((\d+)\)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;
    const restartMatch = statusStr.match(/Restarting \((\d+)\)/);
    const restartCount = restartMatch ? parseInt(restartMatch[1], 10) : 0;
    const hScore = Utils.containerHealthScore({ state: c.state, exitCode, health: healthStatus, restartCount, cpuPercent: 0, memPercent: 0, imageAge: 0, vulnCount: 0 });
    const hColor = Utils.healthScoreColor(hScore);
    const hLabel = Utils.healthScoreLabel(hScore);

    // Sandbox detection
    const isSandbox = c.labels?.['docker-dash.sandbox'] === 'true';
    const sandboxMode = c.labels?.['docker-dash.sandbox.mode'] || '';
    const sandboxExpires = c.labels?.['docker-dash.sandbox.expires'] || '';
    let sandboxBadge = '';
    if (isSandbox) {
      if (sandboxMode === 'ephemeral') {
        let ttlStr = '';
        if (sandboxExpires) {
          const remaining = Math.max(0, Math.round((new Date(sandboxExpires).getTime() - Date.now()) / 60000));
          ttlStr = remaining > 0 ? ` ${remaining}m` : ' expired';
        }
        sandboxBadge = `<span class="badge badge-ephemeral"><i class="fas fa-clock" style="margin-right:3px"></i>EPHEMERAL${ttlStr}</span>`;
      } else {
        sandboxBadge = `<span class="badge badge-sandbox"><i class="fas fa-flask" style="margin-right:3px"></i>SANDBOX</span>`;
      }
    }

    // Container metadata
    const meta = this._metaMap?.[c.name] || {};
    let metaLine = '';
    if (isSandbox) metaLine += sandboxBadge + ' ';
    if (meta.app_name) metaLine += `<span class="meta-app-name">${Utils.escapeHtml(meta.app_name)}</span>`;
    if (meta.lan_link) metaLine += ` <a href="${Utils.escapeHtml(meta.lan_link)}" class="meta-link" target="_blank" rel="noopener" data-stop-propagation title="LAN"><i class="fas fa-home"></i></a>`;
    if (meta.web_link) metaLine += ` <a href="${Utils.escapeHtml(meta.web_link)}" class="meta-link" target="_blank" rel="noopener" data-stop-propagation title="WEB"><i class="fas fa-globe"></i></a>`;
    if (meta.docs_url) metaLine += ` <a href="${Utils.escapeHtml(meta.docs_url)}" class="meta-link" target="_blank" rel="noopener" data-stop-propagation title="Docs"><i class="fas fa-book"></i></a>`;
    if (meta.category) metaLine += ` <span class="badge badge-meta-cat">${Utils.escapeHtml(meta.category)}</span>`;
    const sandboxBorderColor = isSandbox ? (sandboxMode === 'ephemeral' ? 'var(--red)' : 'var(--yellow)') : '';
    const colorStyle = sandboxBorderColor ? `border-left: 3px solid ${sandboxBorderColor}; padding-left: 8px;` : (meta.color ? `border-left: 3px solid ${meta.color}; padding-left: 8px;` : '');

    const isSelf = c.isSelf || false;

    return `
      <tr data-cid="${c.id}" class="clickable ${running ? '' : 'row-dim'}">
        <td data-stop-propagation>
          <input type="checkbox" class="bulk-checkbox bulk-row-check" data-cid="${c.id}" ${isSelf ? 'disabled title="Cannot modify Docker Dash"' : ''}>
        </td>
        <td style="${colorStyle}">
          <span class="mono">${Utils.escapeHtml(isStandalone ? (c.name || service) : service)}</span>
          ${metaLine ? `<div class="container-meta-line">${metaLine}</div>` :
            (!isStandalone && service !== c.name ? `<div class="text-muted text-xs mono">${Utils.escapeHtml(c.name)}</div>` : `<div class="text-muted text-xs mono">${Utils.shortId(c.id)}</div>`)}
        </td>
        <td><span class="mono text-sm">${Utils.escapeHtml(imgName)}</span></td>
        <td><span class="badge badge-version">${Utils.escapeHtml(version)}</span></td>
        <td><span class="badge ${Utils.statusBadgeClass(c.state)}">${c.state}</span> <span class="health-dot" style="background:${hColor}" title="${hScore}/100 — ${hLabel}"></span>
          <div class="text-xs text-muted" style="margin-top:2px">${Utils.escapeHtml(statusStr.replace(/^(Up|Exited \(\d+\))\s*/, '$1 ').trim())}</div>
          ${running ? `<div class="stats-bars" style="display:flex;gap:3px;margin-top:4px">
            <div class="stats-bar-wrap" title="CPU"><div class="stats-bar" data-stats-cpu="${c.id}" style="width:0%;background:var(--green)"></div></div>
            <div class="stats-bar-wrap" title="RAM"><div class="stats-bar" data-stats-mem="${c.id}" style="width:0%;background:var(--accent)"></div></div>
          </div>
          <canvas class="sparkline-canvas" data-sparkline-id="${c.id}" width="60" height="16" style="margin-top:2px;display:block"></canvas>` : ''}
          </td>
        <td>${this._portLinksHtml(c)}</td>
        <td class="text-sm text-muted">${created}</td>
        <td>
          <div class="action-btns">
            <button class="action-btn" data-action="edit-meta" data-id="${c.id}" data-name="${Utils.escapeHtml(c.name)}" title="${i18n.t('pages.containers.meta.edit')}"><i class="fas fa-tag"></i></button>
            ${running
              ? `<button class="action-btn" data-action="stop" data-id="${c.id}" title="${i18n.t('common.stop')}"><i class="fas fa-stop"></i></button>
                 <button class="action-btn" data-action="restart" data-id="${c.id}" title="${i18n.t('common.restart')}"><i class="fas fa-redo"></i></button>`
              : paused
              ? `<button class="action-btn" data-action="unpause" data-id="${c.id}" title="${i18n.t('common.unpause')}"><i class="fas fa-play"></i></button>`
              : `<button class="action-btn" data-action="start" data-id="${c.id}" title="${i18n.t('common.start')}"><i class="fas fa-play"></i></button>`
            }
            <button class="action-btn danger" data-action="remove" data-id="${c.id}" data-name="${Utils.escapeHtml(c.name)}" data-state="${c.state}" title="${i18n.t('common.remove')}"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  },

  _portLinksHtml(c) {
    const tcpPorts = (c.ports || []).filter(p => {
      const pub = p.public || p.PublicPort;
      const type = (p.type || p.Type || 'tcp').toLowerCase();
      return pub && type === 'tcp';
    });
    if (tcpPorts.length === 0) {
      const txt = Utils.formatPorts(c.ports);
      return txt ? `<span class="mono text-sm text-muted">${txt}</span>` : '<span class="text-muted">—</span>';
    }
    const host = window.location.hostname;
    return tcpPorts.map(p => {
      const pub = p.public || p.PublicPort;
      const priv = p.private || p.PrivatePort;
      const scheme = pub === 443 || pub === 8443 ? 'https' : 'http';
      const url = `${scheme}://${host}:${pub}`;
      return `<span class="port-link-wrap" data-stop-propagation>
        <span class="mono text-sm">${pub}→${priv}</span>
        <a href="${url}" target="_blank" rel="noopener" class="port-open-btn" title="Open ${url}"><i class="fas fa-external-link-alt"></i></a>
      </span>`;
    }).join(' ');
  },

  // ═══════════════════════════════════════════════
  // DETAIL VIEW
  // ═══════════════════════════════════════════════
  async _renderDetail(container) {
    container.innerHTML = `
      <div class="page-header">
        <div class="breadcrumb">
          <a href="#/containers"><i class="fas fa-arrow-left"></i> ${i18n.t('pages.containers.backToContainers')}</a>
          <span class="bc-sep">/</span>
          <span id="detail-name">${i18n.t('common.loading')}</span>
        </div>
        <div class="page-actions" style="display:flex;align-items:center;gap:12px">
          <span id="detail-size" class="text-muted text-sm" style="display:none;white-space:nowrap"></span>
          <div class="btn-group" id="detail-actions"></div>
        </div>
      </div>
      <div class="tabs" id="detail-tabs">
        <button class="tab active" data-tab="info">${i18n.t('pages.containers.tabs.info')}</button>
        <button class="tab" data-tab="logs">${i18n.t('pages.containers.tabs.logs')}</button>
        <button class="tab" data-tab="terminal">${i18n.t('pages.containers.tabs.terminal')}</button>
        <button class="tab" data-tab="stats">${i18n.t('pages.containers.tabs.stats')}</button>
        <button class="tab" data-tab="pipeline"><i class="fas fa-rocket" style="margin-right:4px"></i>Pipeline</button>
        <button class="tab" data-tab="env"><i class="fas fa-key" style="margin-right:4px"></i>Env</button>
        <button class="tab" data-tab="mounts"><i class="fas fa-hdd" style="margin-right:4px"></i>Mounts</button>
        <button class="tab" data-tab="networking"><i class="fas fa-network-wired" style="margin-right:4px"></i>Network</button>
        <button class="tab" data-tab="labels"><i class="fas fa-tags" style="margin-right:4px"></i>Labels</button>
        <button class="tab" data-tab="files"><i class="fas fa-folder-open" style="margin-right:4px"></i>Files</button>
        <button class="tab" data-tab="changes"><i class="fas fa-exchange-alt" style="margin-right:4px"></i>Changes</button>
        <button class="tab" data-tab="inspect">${i18n.t('pages.containers.tabs.inspect')}</button>
      </div>
      <div class="tab-content" id="detail-content">${i18n.t('common.loading')}</div>
    `;

    container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._renderTab(tab.dataset.tab);
      });
    });

    await this._loadDetail();
  },

  async _loadDetail() {
    try {
      const info = await Api.getContainer(this._detailId);
      this._detailData = info;

      const name = info.name || Utils.shortId(info.id);
      const nameEl = document.getElementById('detail-name');
      if (nameEl) nameEl.textContent = name;

      // Show container size in header
      const sizeEl = document.getElementById('detail-size');
      if (sizeEl && (info.sizeRootFs || info.sizeRw)) {
        const parts = [];
        if (info.sizeRootFs) parts.push(`${Utils.formatBytes(info.sizeRootFs)} total`);
        if (info.sizeRw) parts.push(`${Utils.formatBytes(info.sizeRw)} writable`);
        sizeEl.innerHTML = `<i class="fas fa-hdd" style="margin-right:4px"></i>${parts.join(' / ')}`;
        sizeEl.style.display = '';
      }

      this._renderDetailActions(info);
      this._renderTab('info');
    } catch (err) {
      Toast.error(i18n.t('pages.containers.loadContainerFailed', { message: err.message }));
      document.getElementById('detail-content').innerHTML =
        `<div class="empty-msg">${i18n.t('pages.containers.notFoundOrError')}</div>`;
    }
  },

  _renderDetailActions(info) {
    const el = document.getElementById('detail-actions');
    if (!el) return;
    // inspectContainer returns state as object: { Status, Running, Paused, ... }
    const state = info.state || {};
    const running = state.Running || state.Status === 'running';
    const paused = state.Paused || state.Status === 'paused';

    el.innerHTML = `
      ${running
        ? `<button class="btn btn-sm btn-warning" data-act="stop"><i class="fas fa-stop"></i> ${i18n.t('common.stop')}</button>
           <button class="btn btn-sm btn-secondary" data-act="restart"><i class="fas fa-redo"></i> ${i18n.t('common.restart')}</button>
           <button class="btn btn-sm btn-secondary" data-act="pause"><i class="fas fa-pause"></i> ${i18n.t('common.pause')}</button>`
        : paused
        ? `<button class="btn btn-sm btn-primary" data-act="unpause"><i class="fas fa-play"></i> ${i18n.t('common.unpause')}</button>`
        : `<button class="btn btn-sm btn-primary" data-act="start"><i class="fas fa-play"></i> ${i18n.t('common.start')}</button>`
      }
      <button class="btn btn-sm btn-secondary" data-act="meta"><i class="fas fa-tag"></i> ${i18n.t('pages.containers.meta.edit')}</button>
      <button class="btn btn-sm btn-secondary" data-act="resources"><i class="fas fa-sliders-h"></i> ${i18n.t('pages.containers.editResources')}</button>
      <button class="btn btn-sm btn-secondary" data-act="healthlogs"><i class="fas fa-heartbeat"></i> ${i18n.t('pages.containers.healthCheckLogs')}</button>
      <button class="btn btn-sm btn-accent" data-act="update"><i class="fas fa-arrow-circle-up"></i> Update</button>
      <button class="btn btn-sm btn-accent" data-act="safe-update" title="Scan for vulnerabilities before updating"><i class="fas fa-shield-alt"></i> Safe Update</button>
      <button class="btn btn-sm btn-secondary" data-act="rollback" title="Rollback to previous image"><i class="fas fa-history"></i> Rollback</button>
      <button class="btn btn-sm btn-secondary" data-act="diagnose" title="Run troubleshooting wizard"><i class="fas fa-stethoscope"></i> Diagnose</button>
      <button class="btn btn-sm btn-accent" data-act="doctor" title="AI Container Doctor — deep analysis with log pattern matching"><i class="fas fa-user-md"></i> Doctor</button>
      <button class="btn btn-sm btn-secondary" data-act="rename"><i class="fas fa-pencil-alt"></i> Rename</button>
      <button class="btn btn-sm btn-secondary" data-act="clone"><i class="fas fa-clone"></i> Clone</button>
      <button class="btn btn-sm btn-secondary" data-act="export"><i class="fas fa-file-export"></i> Export</button>
      <button class="btn btn-sm btn-danger" data-act="remove"><i class="fas fa-trash"></i> ${i18n.t('common.remove')}</button>
    `;

    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'export') return this._exportDialog();
        if (btn.dataset.act === 'update') return this._updateContainer(this._detailId, info.image);
        if (btn.dataset.act === 'rename') return this._renameContainer(this._detailId, info.name);
        if (btn.dataset.act === 'safe-update') return this._safeUpdateContainer(this._detailId, info.name, info.image);
        if (btn.dataset.act === 'diagnose') return this._diagnoseContainer(this._detailId, info.name);
        if (btn.dataset.act === 'doctor') return this._doctorContainer(this._detailId, info.name);
        if (btn.dataset.act === 'clone') return this._cloneContainer(this._detailId, info.name, info.image);
        if (btn.dataset.act === 'rollback') return this._rollbackDialog(this._detailId, info.name);
        if (btn.dataset.act === 'meta') return this._editMetaDialog(info.name);
        if (btn.dataset.act === 'resources') return this._editResources();
        if (btn.dataset.act === 'healthlogs') return this._viewHealthLogs(this._detailId, info.name || '');
        this._containerAction(this._detailId, btn.dataset.act);
      });
    });
  },

  async _editResources() {
    const info = this._detailData;
    const resources = info.resources || {};
    const currentMemMB = resources.memory ? Math.round(resources.memory / (1024 * 1024)) : 0;
    const currentCpuCores = resources.cpuQuota ? parseFloat((resources.cpuQuota / (resources.cpuPeriod || 100000)).toFixed(2)) : 0;

    // Try to get current usage
    let usedMemMB = 0, cpuPct = 0;
    try {
      const stats = await Api.getContainerStats(this._detailId);
      usedMemMB = Math.round((stats.memUsage || 0) / (1024 * 1024));
      cpuPct = parseFloat((stats.cpuPercent || 0).toFixed(1));
    } catch { /* ignore */ }

    const memPresets = [256, 512, 1024, 2048];
    const cpuPresets = [0.5, 1, 2, 4];

    const usageBarMem = currentMemMB > 0 ? Math.min(100, Math.round((usedMemMB / currentMemMB) * 100)) : 0;
    const usageBarCpu = currentCpuCores > 0 ? Math.min(100, Math.round((cpuPct / (currentCpuCores * 100)) * 100)) : 0;

    const result = await Modal.form(`
      <div style="display:flex;gap:16px;margin-bottom:16px;padding:12px;background:var(--surface2);border-radius:var(--radius-sm)">
        <div style="flex:1;text-align:center">
          <div class="text-sm text-muted">CPU Usage</div>
          <div style="font-size:20px;font-weight:700;color:var(--accent)">${cpuPct}%</div>
        </div>
        <div style="flex:1;text-align:center">
          <div class="text-sm text-muted">Memory Usage</div>
          <div style="font-size:20px;font-weight:700;color:var(--accent)">${usedMemMB} MB</div>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n.t('pages.containers.memoryLimitMB')} <span id="res-mem-val" style="font-weight:700;color:var(--accent)">${currentMemMB || 'Unlimited'}</span> MB</label>
        ${currentMemMB > 0 ? `<div class="resource-usage-bar" style="margin-bottom:8px">
          <div class="resource-usage-fill" style="width:${usageBarMem}%;background:${usageBarMem > 80 ? 'var(--red)' : usageBarMem > 60 ? 'var(--yellow)' : 'var(--green)'}"></div>
          <span class="resource-usage-label">${usedMemMB} / ${currentMemMB} MB (${usageBarMem}%)</span>
        </div>` : ''}
        <input type="range" id="res-mem" class="resource-slider" value="${currentMemMB}" min="0" max="8192" step="64">
        <div class="resource-presets">
          ${memPresets.map(v => `<button type="button" class="btn btn-sm btn-secondary res-preset" data-target="res-mem" data-value="${v}">${v >= 1024 ? (v / 1024) + 'GB' : v + 'MB'}</button>`).join('')}
          <button type="button" class="btn btn-sm btn-secondary res-preset" data-target="res-mem" data-value="0">Unlimited</button>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n.t('pages.containers.cpuLimitCores')} <span id="res-cpu-val" style="font-weight:700;color:var(--accent)">${currentCpuCores || 'Unlimited'}</span> cores</label>
        ${currentCpuCores > 0 ? `<div class="resource-usage-bar" style="margin-bottom:8px">
          <div class="resource-usage-fill" style="width:${usageBarCpu}%;background:${usageBarCpu > 80 ? 'var(--red)' : usageBarCpu > 60 ? 'var(--yellow)' : 'var(--green)'}"></div>
          <span class="resource-usage-label">${cpuPct}% / ${(currentCpuCores * 100).toFixed(0)}% (${usageBarCpu}%)</span>
        </div>` : ''}
        <input type="range" id="res-cpu" class="resource-slider" value="${currentCpuCores * 100}" min="0" max="800" step="25">
        <div class="resource-presets">
          ${cpuPresets.map(v => `<button type="button" class="btn btn-sm btn-secondary res-preset" data-target="res-cpu" data-value="${v * 100}">${v}</button>`).join('')}
          <button type="button" class="btn btn-sm btn-secondary res-preset" data-target="res-cpu" data-value="0">Unlimited</button>
        </div>
      </div>
    `, {
      title: i18n.t('pages.containers.editResources'),
      width: '520px',
      onSubmit: (content) => {
        const mem = parseInt(content.querySelector('#res-mem').value) || 0;
        const cpuVal = parseInt(content.querySelector('#res-cpu').value) || 0;
        return { memory: mem * 1024 * 1024, cpuQuota: cpuVal * 1000, cpuPeriod: 100000 };
      },
      onMount: (content) => {
        const memSlider = content.querySelector('#res-mem');
        const cpuSlider = content.querySelector('#res-cpu');
        const memVal = content.querySelector('#res-mem-val');
        const cpuVal = content.querySelector('#res-cpu-val');

        memSlider.addEventListener('input', () => {
          const v = parseInt(memSlider.value);
          memVal.textContent = v === 0 ? 'Unlimited' : (v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v + '');
        });
        cpuSlider.addEventListener('input', () => {
          const v = parseInt(cpuSlider.value);
          cpuVal.textContent = v === 0 ? 'Unlimited' : (v / 100).toFixed(2);
        });

        content.querySelectorAll('.res-preset').forEach(btn => {
          btn.addEventListener('click', () => {
            const target = content.querySelector('#' + btn.dataset.target);
            target.value = btn.dataset.value;
            target.dispatchEvent(new Event('input'));
          });
        });
      }
    });

    if (result) {
      try {
        await Api.updateContainerResources(this._detailId, result);
        Toast.success(i18n.t('pages.containers.resourcesUpdated'));
        await this._loadDetail();
      } catch (err) {
        Toast.error(i18n.t('pages.containers.resourceUpdateFailed', { message: err.message }));
      }
    }
  },

  async _cloneContainer(id, sourceName, image) {
    const result = await Modal.form(`
      <div class="form-group">
        <label>New Container Name</label>
        <input type="text" id="clone-name" class="form-control" value="${Utils.escapeHtml(sourceName)}-clone" autofocus>
      </div>
      <p class="text-muted text-sm">This will create a new container with the same image (<strong>${Utils.escapeHtml(image)}</strong>) and configuration. Port bindings will be cleared to avoid conflicts.</p>
    `, {
      title: 'Clone Container',
      width: '450px',
      onSubmit: (content) => content.querySelector('#clone-name').value.trim(),
    });

    if (!result) return;
    try {
      await Api.post(`/containers/${id}/clone`, { name: result });
      Toast.success(`Container cloned as "${result}"`);
      location.hash = '#/containers';
    } catch (err) {
      Toast.error('Clone failed: ' + err.message);
    }
  },

  async _updateContainer(id, image) {
    const ok = await Modal.confirm(
      `Pull latest image for <strong>${Utils.escapeHtml(image)}</strong> and recreate this container with the same configuration?`,
      { danger: true, confirmText: 'Update' }
    );
    if (!ok) return;

    Toast.info('Updating container...');
    try {
      const result = await Api.updateContainer(id);
      Toast.success(`Container updated via ${result.method}`);
      // Reload detail or go back to list
      if (result.newId) {
        this._detailId = result.newId;
      }
      await this._loadDetail();
    } catch (err) {
      Toast.error('Update failed: ' + err.message);
    }
  },

  async _renameContainer(id, currentName) {
    const result = await Modal.form(`
      <div class="form-group">
        <label>New Name</label>
        <input type="text" id="rename-input" class="form-control" value="${Utils.escapeHtml(currentName)}" required>
      </div>
    `, {
      title: 'Rename Container',
      width: '400px',
      onSubmit: (content) => {
        const newName = content.querySelector('#rename-input').value.trim();
        if (!newName) { Toast.warning('Name cannot be empty'); return false; }
        if (newName === currentName) { Toast.info('Name unchanged'); return false; }
        return { name: newName };
      },
    });

    if (result) {
      try {
        await Api.renameContainer(id, result.name);
        Toast.success('Container renamed to "' + result.name + '"');
        await this._loadDetail();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _migrateWizard(containerId, containerName, image) {
    // Get available hosts
    let hosts;
    try {
      hosts = await Api.getHosts();
    } catch { Toast.error('Failed to load hosts'); return; }

    if (hosts.length < 2) { Toast.warning('Migration requires at least 2 configured hosts'); return; }

    const currentHostId = Api.getHostId();
    const otherHosts = hosts.filter(h => h.id !== currentHostId);

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-exchange-alt" style="margin-right:8px;color:var(--accent)"></i>Migrate Container</h3>
        <button class="modal-close-btn" id="mig-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div style="padding:12px;background:var(--surface2);border-radius:var(--radius);margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="text-align:center">
              <i class="fas fa-cube" style="font-size:24px;color:var(--accent)"></i>
              <div class="text-sm" style="font-weight:600;margin-top:4px">${Utils.escapeHtml(containerName)}</div>
              <div class="text-xs text-muted">${Utils.escapeHtml(image)}</div>
            </div>
            <i class="fas fa-arrow-right" style="font-size:18px;color:var(--text-dim)"></i>
            <div style="flex:1">
              <label class="text-sm" style="font-weight:600">Target Host</label>
              <select id="mig-target" class="form-control" style="margin-top:4px">
                ${otherHosts.map(h => `<option value="${h.id}">${Utils.escapeHtml(h.name)} ${h.environment ? '(' + h.environment + ')' : ''}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>
        <div class="text-sm text-muted" style="margin-bottom:12px">
          <i class="fas fa-info-circle" style="margin-right:4px;color:var(--accent)"></i>
          Migration will: pull the image on the target host, create a new container with the same configuration, and start it. The original container will NOT be removed automatically.
        </div>
        <div id="mig-status" style="display:none;padding:12px;background:var(--surface2);border-radius:var(--radius)"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="mig-cancel">Cancel</button>
        <button class="btn btn-accent" id="mig-start"><i class="fas fa-exchange-alt"></i> Start Migration</button>
      </div>
    `, { width: '550px' });

    Modal._content.querySelector('#mig-close').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#mig-cancel').addEventListener('click', () => Modal.close());

    Modal._content.querySelector('#mig-start').addEventListener('click', async () => {
      const targetHostId = parseInt(Modal._content.querySelector('#mig-target').value);
      const btn = Modal._content.querySelector('#mig-start');
      const statusEl = Modal._content.querySelector('#mig-status');

      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Migrating...';
      statusEl.style.display = 'block';
      statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Inspecting container...';

      try {
        // Get container config from source
        const inspect = await Api.getContainer(containerId);
        statusEl.innerHTML = '<i class="fas fa-check" style="color:var(--green)"></i> Config read. Creating on target host...';

        // Build create options from inspect
        const createOpts = {
          name: inspect.Name?.replace(/^\//, '') || containerName,
          Image: inspect.Config?.Image || image,
          Env: inspect.Config?.Env || [],
          Cmd: inspect.Config?.Cmd || undefined,
          ExposedPorts: inspect.Config?.ExposedPorts || {},
          HostConfig: {
            PortBindings: inspect.HostConfig?.PortBindings || {},
            RestartPolicy: inspect.HostConfig?.RestartPolicy || { Name: 'unless-stopped' },
            Binds: inspect.HostConfig?.Binds || [],
          },
          Labels: inspect.Config?.Labels || {},
        };

        // Switch to target host, create, switch back
        const originalHost = Api.getHostId();
        Api.setHost(targetHostId);

        try {
          const created = await Api.createContainer(createOpts);
          statusEl.innerHTML += '<br><i class="fas fa-check" style="color:var(--green)"></i> Container created. Starting...';
          await Api.containerAction(created.id, 'start');
          statusEl.innerHTML += '<br><i class="fas fa-check" style="color:var(--green)"></i> <strong style="color:var(--green)">Migration complete!</strong> Container is running on target host.';
          btn.innerHTML = '<i class="fas fa-check"></i> Done';
          Toast.success('Container migrated successfully');
        } finally {
          Api.setHost(originalHost);
        }
      } catch (err) {
        statusEl.innerHTML = `<i class="fas fa-times" style="color:var(--red)"></i> Migration failed: ${Utils.escapeHtml(err.message)}`;
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-exchange-alt"></i> Retry';
      }
    });
  },

  async _safeUpdateContainer(id, name, image) {
    const ok = await Modal.confirm(
      `<strong>Safe Update</strong>: Pull latest <code>${Utils.escapeHtml(image)}</code>, scan for vulnerabilities with Trivy, and only swap if no critical CVEs are found.<br><br>This is safer than a regular update.`,
      { confirmText: 'Safe Update', danger: false }
    );
    if (!ok) return;

    Toast.info('Safe updating... (pull + scan + swap)');
    try {
      const result = await Api.safeUpdateContainer(id);
      if (result.ok) {
        Toast.success(`Safe update complete. Scan: ${result.scan?.critical || 0} critical, ${result.scan?.high || 0} high`);
        if (result.newId) this._detailId = result.newId;
        await this._loadDetail();
      } else if (result.blocked) {
        Toast.error(`Update BLOCKED: ${result.scan?.critical} critical vulnerabilities found. Use regular update to override.`);
        Modal.open(`
          <div class="modal-header"><h3 style="color:var(--red)"><i class="fas fa-shield-alt"></i> Update Blocked</h3>
            <button class="modal-close-btn" id="blocked-close-x"><i class="fas fa-times"></i></button></div>
          <div class="modal-body">
            <p>${Utils.escapeHtml(result.message)}</p>
            <p><strong>Critical:</strong> ${result.scan?.critical || 0} | <strong>High:</strong> ${result.scan?.high || 0}</p>
          </div>
          <div class="modal-footer"><button class="btn btn-primary" id="blocked-close-btn">OK</button></div>
        `, { width: '450px' });
        Modal._content.querySelector('#blocked-close-x').addEventListener('click', () => Modal.close());
        Modal._content.querySelector('#blocked-close-btn').addEventListener('click', () => Modal.close());
      }
    } catch (err) { Toast.error(err.message); }
  },

  async _diagnoseContainer(id, name) {
    Toast.info('Running diagnostics...');
    try {
      const result = await Api.diagnoseContainer(id);
      const statusColors = { ok: 'var(--green)', warning: '#d29922', error: 'var(--red)', info: 'var(--accent)', skipped: 'var(--text-dim)' };

      const html = `
        <div class="modal-header">
          <h3><i class="fas fa-stethoscope" style="margin-right:8px;color:var(--accent)"></i>Diagnose: ${Utils.escapeHtml(result.container)}</h3>
          <button class="modal-close-btn" id="diag-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <p>Overall: <strong style="color:${result.overall === 'healthy' ? 'var(--green)' : result.overall === 'warning' ? '#d29922' : 'var(--red)'}">${result.overall.toUpperCase()}</strong>
          (${result.errors} errors, ${result.warnings} warnings)</p>
          <table class="data-table" style="margin-top:12px">
            <thead><tr><th>#</th><th style="text-align:left">Check</th><th>Status</th><th style="text-align:left">Detail</th></tr></thead>
            <tbody>${result.steps.map(s => `
              <tr>
                <td>${s.step}</td>
                <td style="text-align:left"><strong>${Utils.escapeHtml(s.title)}</strong></td>
                <td><span style="color:${statusColors[s.status] || 'var(--text)'}">${s.status.toUpperCase()}</span></td>
                <td style="text-align:left" class="text-sm">${Utils.escapeHtml(s.detail)}${s.suggestion ? '<br><em class="text-muted">' + Utils.escapeHtml(s.suggestion) + '</em>' : ''}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="diag-close-btn">Close</button></div>
      `;
      Modal.open(html, { width: '700px' });
      Modal._content.querySelector('#diag-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#diag-close-btn').addEventListener('click', () => Modal.close());
    } catch (err) { Toast.error(err.message); }
  },

  async _doctorContainer(id, name) {
    Toast.info('Running Container Doctor analysis...');
    try {
      const result = await Api.get(`/containers/${id}/doctor`);
      const overallColor = result.overall === 'healthy' ? 'var(--green)' : result.overall === 'warning' ? 'var(--yellow)' : 'var(--red)';

      const checksHtml = result.steps.map(s => `
        <div class="doctor-card severity-${s.status === 'error' ? 'critical' : s.status}">
          <div class="doctor-card-header">
            <span class="severity-badge ${s.status === 'error' ? 'critical' : s.status}">${s.status.toUpperCase()}</span>
            <span class="doctor-card-title">${Utils.escapeHtml(s.title)}</span>
          </div>
          <div class="doctor-card-detail">${Utils.escapeHtml(s.detail)}</div>
          ${s.suggestion ? `<div class="doctor-card-suggestion">${Utils.escapeHtml(s.suggestion)}</div>` : ''}
        </div>
      `).join('');

      let patternsHtml = '';
      if (result.logAnalysis?.patterns?.length > 0) {
        patternsHtml = `
          <h4 style="margin:16px 0 8px;color:var(--text-bright)"><i class="fas fa-search" style="margin-right:6px;color:var(--accent)"></i>Log Pattern Analysis</h4>
          <div class="doctor-patterns">
            ${result.logAnalysis.patterns.map(p => `
              <div class="doctor-pattern">
                <span class="severity-badge ${p.severity}" style="font-size:9px">${p.severity.toUpperCase()}</span>
                <span class="doctor-pattern-category">${Utils.escapeHtml(p.category)}</span>
                <div style="flex:1">
                  <strong>${Utils.escapeHtml(p.title)}</strong>
                  <div class="text-sm text-muted" style="margin-top:2px">${Utils.escapeHtml(p.explanation)}</div>
                  <div class="text-sm" style="margin-top:4px;color:var(--text-dim)"><strong>Fixes:</strong> ${p.fixes.map(f => Utils.escapeHtml(f)).join(' | ')}</div>
                  <div class="mono text-xs" style="margin-top:4px;color:var(--text-dim);word-break:break-all">${Utils.escapeHtml(p.matchedLine)}</div>
                </div>
              </div>
            `).join('')}
          </div>`;
      } else {
        patternsHtml = '<p class="text-muted" style="margin:12px 0"><i class="fas fa-check-circle" style="color:var(--green);margin-right:6px"></i>No known error patterns detected in recent logs.</p>';
      }

      const html = `
        <div class="modal-header">
          <h3><i class="fas fa-user-md" style="margin-right:8px;color:var(--accent)"></i>Container Doctor: ${Utils.escapeHtml(result.container)}</h3>
          <button class="modal-close-btn" id="doctor-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px;background:var(--surface2);border-radius:var(--radius)">
            <div style="font-size:32px;color:${overallColor}">
              <i class="fas fa-${result.overall === 'healthy' ? 'heart' : result.overall === 'warning' ? 'exclamation-triangle' : 'times-circle'}"></i>
            </div>
            <div>
              <div style="font-size:18px;font-weight:700;color:${overallColor}">${result.overall.toUpperCase()}</div>
              <div class="text-sm text-muted">${result.errors} error(s), ${result.warnings} warning(s), ${result.logAnalysis?.patterns?.length || 0} log pattern(s)</div>
            </div>
          </div>
          <h4 style="margin:0 0 8px;color:var(--text-bright)"><i class="fas fa-clipboard-check" style="margin-right:6px;color:var(--accent)"></i>Diagnostic Checks</h4>
          <div class="doctor-report">${checksHtml}</div>
          ${patternsHtml}
          ${result.logText ? `
            <details style="margin-top:16px">
              <summary style="cursor:pointer;color:var(--accent);font-weight:600"><i class="fas fa-file-alt" style="margin-right:6px"></i>Recent Logs (last 30 lines)</summary>
              <pre class="inspect-json" style="margin-top:8px;max-height:200px;overflow:auto;font-size:11px">${Utils.escapeHtml(result.logText)}</pre>
            </details>` : ''}
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
              <select id="doctor-ai-provider" class="form-control" style="width:auto;padding:4px 8px;font-size:12px">
                <option value="ollama">Ollama (local)</option>
                <option value="openai">OpenAI</option>
              </select>
              <input id="doctor-ai-model" type="text" class="form-control" placeholder="Model (e.g. llama3 / gpt-4o-mini)" style="width:180px;padding:4px 8px;font-size:12px">
              <input id="doctor-ai-config" type="text" class="form-control" placeholder="Ollama URL or OpenAI API key" style="width:220px;padding:4px 8px;font-size:12px">
              <button class="btn btn-sm btn-accent" id="doctor-ask-ai"><i class="fas fa-robot"></i> Ask AI</button>
              <button class="btn btn-sm btn-secondary" id="doctor-copy-ai"><i class="fas fa-copy"></i> Copy Prompt</button>
            </div>
            <div id="doctor-ai-response" style="display:none;margin-top:8px;padding:12px;background:var(--surface2);border-radius:var(--radius);font-size:12px;white-space:pre-wrap;max-height:300px;overflow-y:auto;border:1px solid var(--border)"></div>
          </div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="doctor-ok">Close</button></div>
      `;
      Modal.open(html, { width: '750px' });
      Modal._content.querySelector('#doctor-close')?.addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#doctor-ok')?.addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#doctor-copy-ai')?.addEventListener('click', () => {
        Utils.copyToClipboard(result.aiPrompt || '').then(() => Toast.success('AI prompt copied to clipboard'));
      });

      // Restore last-used AI config from localStorage
      const aiProviderEl = Modal._content.querySelector('#doctor-ai-provider');
      const aiModelEl = Modal._content.querySelector('#doctor-ai-model');
      const aiConfigEl = Modal._content.querySelector('#doctor-ai-config');
      aiProviderEl.value = localStorage.getItem('dd-ai-provider') || 'ollama';
      aiModelEl.value = localStorage.getItem('dd-ai-model') || '';
      aiConfigEl.value = localStorage.getItem('dd-ai-config') || '';

      Modal._content.querySelector('#doctor-ask-ai')?.addEventListener('click', async () => {
        const provider = aiProviderEl.value;
        const model = aiModelEl.value.trim();
        const configVal = aiConfigEl.value.trim();
        localStorage.setItem('dd-ai-provider', provider);
        localStorage.setItem('dd-ai-model', model);
        localStorage.setItem('dd-ai-config', configVal);

        const config = provider === 'openai'
          ? { apiKey: configVal, model: model || 'gpt-4o-mini' }
          : { baseUrl: configVal || 'http://localhost:11434', model: model || 'llama3' };

        const respEl = Modal._content.querySelector('#doctor-ai-response');
        respEl.style.display = 'block';
        respEl.textContent = 'Asking AI…';

        const askBtn = Modal._content.querySelector('#doctor-ask-ai');
        askBtn.disabled = true;
        try {
          const r = await Api.aiChat(result.aiPrompt, provider, config);
          respEl.textContent = r.response || 'No response';
        } catch (err) {
          respEl.textContent = 'Error: ' + err.message;
        } finally {
          askBtn.disabled = false;
        }
      });
    } catch (err) { Toast.error('Doctor analysis failed: ' + err.message); }
  },

  async _exportDialog() {
    const id = this._detailId;
    const name = this._detailData?.name || 'container';

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-file-export" style="color:var(--accent);margin-right:8px"></i>Export — ${Utils.escapeHtml(name)}</h3>
        <button class="modal-close-btn" id="export-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:16px">
          <label>Export Format</label>
          <select id="export-format" class="form-control">
            <option value="compose">Docker Compose YAML</option>
            <option value="run">Docker Run Command</option>
            <option value="json">JSON Inspect</option>
          </select>
        </div>
        <div id="export-preview" style="display:none">
          <pre class="inspect-json" id="export-content" style="max-height:50vh;overflow:auto;white-space:pre-wrap"></pre>
        </div>
        <div id="export-loading" style="display:none;text-align:center;padding:24px">
          <i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="export-copy" style="display:none"><i class="fas fa-copy"></i> ${i18n.t('common.copy')}</button>
        <button class="btn btn-secondary" id="export-download" style="display:none"><i class="fas fa-download"></i> Download</button>
        <button class="btn btn-primary" id="export-generate"><i class="fas fa-eye"></i> Generate</button>
      </div>
    `, { width: '700px' });

    let currentData = '';
    let currentFilename = '';

    Modal._content.querySelector('#export-close').addEventListener('click', () => Modal.close());

    const generate = async () => {
      const format = Modal._content.querySelector('#export-format').value;
      const loading = Modal._content.querySelector('#export-loading');
      const preview = Modal._content.querySelector('#export-preview');
      const content = Modal._content.querySelector('#export-content');
      const copyBtn = Modal._content.querySelector('#export-copy');
      const dlBtn = Modal._content.querySelector('#export-download');

      loading.style.display = '';
      preview.style.display = 'none';

      try {
        let data;
        if (format === 'json') {
          data = JSON.stringify(await Api.getContainer(id), null, 2);
          currentFilename = `${name}-inspect.json`;
        } else {
          data = await Api.get(`/containers/${id}/export?format=${format}`);
          currentFilename = format === 'compose' ? `${name}-compose.yml` : `${name}-run.sh`;
        }
        currentData = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        content.textContent = currentData;
        loading.style.display = 'none';
        preview.style.display = '';
        copyBtn.style.display = '';
        dlBtn.style.display = '';
      } catch (err) {
        loading.style.display = 'none';
        Toast.error(err.message);
      }
    };

    Modal._content.querySelector('#export-generate').addEventListener('click', generate);

    Modal._content.querySelector('#export-copy').addEventListener('click', () => {
      Utils.copyToClipboard(currentData).then(() => Toast.success(i18n.t('common.copied')));
    });

    Modal._content.querySelector('#export-download').addEventListener('click', () => {
      const blob = new Blob([currentData], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = currentFilename;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    // Auto-generate on open
    generate();
  },

  async _editMetaDialog(containerName) {
    let current = {};
    try { current = await Api.getContainerMeta(containerName); } catch {}

    const colorOptions = [
      { value: '', label: i18n.t('pages.containers.meta.defaultColor') },
      { value: '#388bfd', label: i18n.t('pages.containers.meta.blue') },
      { value: '#3fb950', label: i18n.t('pages.containers.meta.green') },
      { value: '#f85149', label: i18n.t('pages.containers.meta.red') },
      { value: '#d29922', label: i18n.t('pages.containers.meta.yellow') },
      { value: '#a371f7', label: i18n.t('pages.containers.meta.purple') },
      { value: '#db6d28', label: i18n.t('pages.containers.meta.orange') },
      { value: '#39d0d8', label: i18n.t('pages.containers.meta.cyan') },
    ].map(o => `<option value="${o.value}" ${current.color === o.value ? 'selected' : ''}>${o.label}</option>`).join('');

    const result = await Modal.form(`
      <div class="form-group">
        <label>${i18n.t('pages.containers.meta.appName')}</label>
        <input type="text" id="meta-app-name" class="form-control" value="${Utils.escapeHtml(current.app_name || '')}" placeholder="${i18n.t('pages.containers.meta.appNamePlaceholder')}">
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.containers.meta.description')}</label>
        <textarea id="meta-desc" class="form-control" rows="2" placeholder="${i18n.t('pages.containers.meta.descPlaceholder')}">${Utils.escapeHtml(current.description || '')}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.containers.meta.lanLink')}</label>
          <input type="url" id="meta-lan" class="form-control" value="${Utils.escapeHtml(current.lan_link || '')}" placeholder="http://192.168.1.x:8080">
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.containers.meta.webLink')}</label>
          <input type="url" id="meta-web" class="form-control" value="${Utils.escapeHtml(current.web_link || '')}" placeholder="https://app.example.com">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.containers.meta.docsUrl')}</label>
          <input type="url" id="meta-docs" class="form-control" value="${Utils.escapeHtml(current.docs_url || '')}" placeholder="https://docs.example.com">
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.containers.meta.owner')}</label>
          <input type="text" id="meta-owner" class="form-control" value="${Utils.escapeHtml(current.owner || '')}" placeholder="${i18n.t('pages.containers.meta.ownerPlaceholder')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.containers.meta.category')}</label>
          <input type="text" id="meta-category" class="form-control" value="${Utils.escapeHtml(current.category || '')}" placeholder="${i18n.t('pages.containers.meta.categoryPlaceholder')}">
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.containers.meta.color')}</label>
          <select id="meta-color" class="form-control">${colorOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.containers.meta.notes')}</label>
        <textarea id="meta-notes" class="form-control" rows="2" placeholder="${i18n.t('pages.containers.meta.notesPlaceholder')}">${Utils.escapeHtml(current.notes || '')}</textarea>
      </div>
    `, {
      title: `${i18n.t('pages.containers.meta.title')} — ${containerName}`,
      width: '580px',
      onSubmit: (content) => ({
        app_name: content.querySelector('#meta-app-name').value.trim(),
        description: content.querySelector('#meta-desc').value.trim(),
        lan_link: content.querySelector('#meta-lan').value.trim(),
        web_link: content.querySelector('#meta-web').value.trim(),
        docs_url: content.querySelector('#meta-docs').value.trim(),
        owner: content.querySelector('#meta-owner').value.trim(),
        category: content.querySelector('#meta-category').value.trim(),
        color: content.querySelector('#meta-color').value,
        notes: content.querySelector('#meta-notes').value.trim(),
        icon: '', custom_fields: {},
      })
    });

    if (result) {
      try {
        await Api.updateContainerMeta(containerName, result);
        Toast.success(i18n.t('pages.containers.meta.saved'));
        if (this._view === 'list') await this._loadList();
        else await this._loadDetail();
      } catch (err) {
        Toast.error(i18n.t('pages.containers.meta.saveFailed', { message: err.message }));
      }
    }
  },

  async _containerAction(id, action) {
    if (action === 'remove') {
      const info = this._detailData || {};
      const name = info.name || id.substring(0, 12);
      const isRunning = info.state === 'running';
      const ok = await Modal.confirm(
        `Remove container "${name}"? This action cannot be undone.`,
        { danger: true, confirmText: i18n.t('common.remove'), typeToConfirm: isRunning ? name : undefined }
      );
      if (!ok) return;
      try {
        await Api.removeContainer(id, true);
        Toast.success(i18n.t('pages.containers.removed'));
        App.navigate('/containers');
      } catch (err) { Toast.error(err.message); }
      return;
    }

    const taskId = TaskBar.add(`${action} container ${id.substring(0, 8)}...`);
    try {
      await Api.containerAction(id, action);
      TaskBar.complete(taskId, `${action} completed`);
      Toast.success(i18n.t('pages.containers.actionSuccess', { action }));
      if (this._view === 'list') await this._loadList();
      else await this._loadDetail();
    } catch (err) {
      TaskBar.error(taskId, `${action} failed: ${err.message}`);
      Toast.error(i18n.t('pages.containers.actionFailed', { action, message: err.message }));
    }
  },

  _renderTab(tab) {
    const content = document.getElementById('detail-content');
    if (!content || !this._detailData) return;

    if (tab === 'info') this._renderInfoTab(content);
    else if (tab === 'logs') this._renderLogsTab(content);
    else if (tab === 'terminal') this._renderTerminalTab(content);
    else if (tab === 'stats') this._renderStatsTab(content);
    else if (tab === 'env') this._renderEnvTab(content);
    else if (tab === 'mounts') this._renderMountsTab(content);
    else if (tab === 'networking') this._renderNetworkTab(content);
    else if (tab === 'labels') this._renderLabelsTab(content);
    else if (tab === 'files') this._renderFilesTab(content);
    else if (tab === 'changes') this._renderChangesTab(content);
    else if (tab === 'pipeline') this._renderPipelineTab(content);
    else if (tab === 'inspect') this._renderInspectTab(content);
  },

  async _renderPipelineTab(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-rocket" style="color:var(--accent);margin-right:8px"></i>Deployment Pipeline</h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" id="pipeline-start-safe"><i class="fas fa-shield-alt"></i> Safe Deploy</button>
            <button class="btn btn-sm btn-secondary" id="pipeline-start-quick"><i class="fas fa-bolt"></i> Quick Deploy</button>
          </div>
        </div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin-bottom:16px">
            Deploy updates through a staged pipeline: Pull &rarr; Scan &rarr; Swap &rarr; Verify &rarr; Notify.
            Safe deploy runs all stages. Quick deploy skips scan and verify.
          </p>
          <div id="pipeline-active" class="hidden">
            <div class="pipeline-stages" id="pipeline-stages"></div>
            <div id="pipeline-result" style="margin-top:12px"></div>
          </div>
        </div>
      </div>
      <div class="card mt-md">
        <div class="card-header"><h3><i class="fas fa-history" style="color:var(--text-dim);margin-right:8px"></i>Pipeline History</h3></div>
        <div class="card-body" id="pipeline-history"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>
      </div>
    `;

    const startPipeline = async (skipScan, skipVerify) => {
      const ok = await Modal.confirm(
        `Start ${skipScan ? 'quick' : 'safe'} deployment pipeline for "${this._detailData?.name || 'this container'}"?`,
        { confirmText: skipScan ? 'Quick Deploy' : 'Safe Deploy', danger: false }
      );
      if (!ok) return;

      const activeEl = document.getElementById('pipeline-active');
      const stagesEl = document.getElementById('pipeline-stages');
      const resultEl = document.getElementById('pipeline-result');
      if (activeEl) activeEl.classList.remove('hidden');

      // Show pending stages
      const stageNames = [
        { name: 'pull', label: 'Pull', icon: 'fa-download' },
        { name: 'scan', label: 'Scan', icon: 'fa-shield-alt' },
        { name: 'swap', label: 'Swap', icon: 'fa-exchange-alt' },
        { name: 'verify', label: 'Verify', icon: 'fa-heartbeat' },
        { name: 'notify', label: 'Notify', icon: 'fa-bell' },
      ];

      if (stagesEl) {
        stagesEl.innerHTML = stageNames.map((s, i) => {
          const status = (skipScan && s.name === 'scan') || (skipVerify && s.name === 'verify') ? 'skipped' : 'running';
          return `
            ${i > 0 ? '<span class="pipeline-arrow"><i class="fas fa-chevron-right"></i></span>' : ''}
            <div class="pipeline-stage ${i === 0 ? 'running' : status === 'skipped' ? 'skipped' : 'pending'}">
              <div class="pipeline-stage-icon"><i class="fas ${s.icon}"></i></div>
              <div class="pipeline-stage-label">${s.label}</div>
            </div>
          `;
        }).join('');
      }

      if (resultEl) resultEl.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Pipeline running...</div>';

      try {
        const result = await Api.post(`/containers/${this._detailId}/pipeline/start`, { skipScan, skipVerify });

        // Update stages with result
        if (stagesEl && result.stages) {
          stagesEl.innerHTML = result.stages.map((s, i) => `
            ${i > 0 ? `<span class="pipeline-arrow ${s.status === 'success' ? 'done' : s.status === 'running' ? 'active' : ''}"><i class="fas fa-chevron-right"></i></span>` : ''}
            <div class="pipeline-stage ${s.status}">
              <div class="pipeline-stage-icon"><i class="fas ${s.icon || 'fa-circle'}"></i></div>
              <div class="pipeline-stage-label">${s.label || s.name}</div>
              ${s.detail ? `<div class="pipeline-stage-duration text-xs">${Utils.escapeHtml(s.detail).substring(0, 30)}</div>` : ''}
            </div>
          `).join('');
        }

        if (resultEl) {
          const isOk = result.status === 'success';
          resultEl.innerHTML = `
            <div style="padding:12px;background:${isOk ? 'var(--green-dim)' : 'var(--red-dim)'};border-radius:var(--radius);display:flex;align-items:center;gap:8px">
              <i class="fas fa-${isOk ? 'check-circle' : 'times-circle'}" style="color:${isOk ? 'var(--green)' : 'var(--red)'};font-size:20px"></i>
              <div>
                <strong style="color:${isOk ? 'var(--green)' : 'var(--red)'}">${isOk ? 'Pipeline Completed' : 'Pipeline Failed'}</strong>
                ${result.error ? `<div class="text-sm text-muted">${Utils.escapeHtml(result.error)}</div>` : ''}
              </div>
            </div>
          `;
        }

        // Refresh history
        this._loadPipelineHistory();
        // Reload container detail
        if (result.status === 'success') {
          setTimeout(() => this._loadDetail(), 1000);
        }
      } catch (err) {
        if (resultEl) resultEl.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div>`;
      }
    };

    el.querySelector('#pipeline-start-safe')?.addEventListener('click', () => startPipeline(false, false));
    el.querySelector('#pipeline-start-quick')?.addEventListener('click', () => startPipeline(true, true));

    this._loadPipelineHistory();
  },

  async _loadPipelineHistory() {
    const historyEl = document.getElementById('pipeline-history');
    if (!historyEl) return;

    try {
      const data = await Api.get(`/containers/${this._detailId}/pipeline/history`);
      const pipelines = data.pipelines || [];

      if (pipelines.length === 0) {
        historyEl.innerHTML = '<div class="text-muted text-sm" style="padding:12px">No previous pipeline deployments.</div>';
        return;
      }

      historyEl.innerHTML = `
        <table class="data-table pipeline-history-table">
          <thead><tr><th>Date</th><th>Status</th><th>Stages</th><th>By</th><th>Duration</th></tr></thead>
          <tbody>
            ${pipelines.map(p => {
              const started = new Date(p.started_at);
              const completed = p.completed_at ? new Date(p.completed_at) : null;
              const duration = completed ? Math.round((completed - started) / 1000) : '-';
              return `
                <tr>
                  <td class="text-sm">${Utils.formatDate(p.started_at)}</td>
                  <td><span class="badge badge-${p.status === 'success' ? 'running' : p.status === 'failed' ? 'stopped' : 'pending'}">${p.status}</span></td>
                  <td>
                    <div class="pipeline-mini-stages">
                      ${(p.stages || []).map(s => `<div class="pipeline-mini-dot ${s.status}" title="${s.label || s.name}: ${s.status}${s.detail ? ' — ' + s.detail : ''}"></div>`).join('')}
                    </div>
                  </td>
                  <td class="text-sm text-muted">${Utils.escapeHtml(p.started_by || '-')}</td>
                  <td class="mono text-sm">${typeof duration === 'number' ? duration + 's' : duration}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      historyEl.innerHTML = `<div class="text-sm text-muted">${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _renderInfoTab(el) {
    const info = this._detailData;
    const state = info.state || {};
    const stateStatus = state.Status || (typeof state === 'string' ? state : 'unknown');

    const env = (info.env || []).map(e => {
      const [k, ...v] = e.split('=');
      return `<tr><td class="mono text-sm">${Utils.escapeHtml(k)}</td><td class="mono text-sm">${Utils.escapeHtml(v.join('='))}</td></tr>`;
    }).join('');

    const mounts = (info.mounts || []).map(m => `
      <tr>
        <td><span class="badge badge-info">${m.Type}</span></td>
        <td class="mono text-sm">${Utils.escapeHtml(m.Source || m.Name || '')}</td>
        <td class="mono text-sm">${Utils.escapeHtml(m.Destination)}</td>
        <td>${m.RW ? 'rw' : 'ro'}</td>
      </tr>
    `).join('');

    const ports = Object.entries(info.ports || {}).map(([k, v]) => {
      const bindings = (v || []).map(b => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`).join(', ');
      return `<tr><td class="mono text-sm">${k}</td><td class="mono text-sm">${bindings || '—'}</td></tr>`;
    }).join('');

    const nets = Object.entries(info.networks || {}).map(([name, n]) => `
      <tr><td>${Utils.escapeHtml(name)}</td><td class="mono text-sm">${n.IPAddress || '—'}</td><td class="mono text-sm">${n.Gateway || '—'}</td></tr>
    `).join('');

    const resources = info.resources || {};

    // Sandbox info card
    const sbLabels = info.labels || {};
    const isSandbox = sbLabels['docker-dash.sandbox'] === 'true';
    let sandboxCard = '';
    if (isSandbox) {
      const sbMode = sbLabels['docker-dash.sandbox.mode'] || 'unknown';
      const sbExpires = sbLabels['docker-dash.sandbox.expires'] || '';
      const sbUser = sbLabels['docker-dash.sandbox.user'] || '';
      const sbMem = resources.memory ? Utils.formatBytes(resources.memory) : '—';
      const sbCpu = resources.nanoCpus ? (resources.nanoCpus / 1e9).toFixed(2) : '—';
      let ttlLine = '';
      if (sbExpires) {
        const remaining = Math.max(0, Math.round((new Date(sbExpires).getTime() - Date.now()) / 60000));
        ttlLine = remaining > 0 ? `${remaining} minutes remaining (expires ${new Date(sbExpires).toLocaleTimeString()})` : '<span style="color:var(--red)">Expired</span>';
      } else {
        ttlLine = 'No time limit';
      }
      sandboxCard = `
        <div class="card mb-md" style="border:1px solid ${sbMode === 'ephemeral' ? 'var(--red)' : 'var(--yellow)'};border-left:4px solid ${sbMode === 'ephemeral' ? 'var(--red)' : 'var(--yellow)'}">
          <div class="card-body" style="padding:14px 18px">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-size:24px;color:${sbMode === 'ephemeral' ? 'var(--red)' : 'var(--yellow)'}"><i class="fas fa-flask"></i></span>
              <div style="flex:1">
                <div style="font-weight:700;font-size:14px;color:var(--text-bright)">Sandbox Mode: ${sbMode.charAt(0).toUpperCase() + sbMode.slice(1)}</div>
                <div class="text-sm text-muted">TTL: ${ttlLine} &nbsp;|&nbsp; Limits: ${sbMem} RAM / ${sbCpu} CPU &nbsp;|&nbsp; User: ${Utils.escapeHtml(sbUser)}</div>
              </div>
              <button class="btn btn-sm btn-secondary" id="sb-extend-btn"><i class="fas fa-clock"></i> Extend +1h</button>
              <button class="btn btn-sm btn-danger" id="sb-remove-btn"><i class="fas fa-trash"></i> Stop &amp; Remove</button>
            </div>
          </div>
        </div>`;
    }

    el.innerHTML = `
      ${sandboxCard}
      <div class="info-grid">
        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.containers.general')}</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>${i18n.t('pages.containers.id')}</td><td class="mono">${Utils.shortId(info.id)}</td></tr>
              <tr><td>${i18n.t('pages.containers.image')}</td><td class="mono text-sm">${Utils.escapeHtml(info.image)}</td></tr>
              <tr><td>${i18n.t('common.status')}</td><td><span class="badge ${Utils.statusBadgeClass(stateStatus)}">${stateStatus}</span> <span class="text-sm text-muted">${Utils.containerStatusMessage(stateStatus, state.ExitCode, state.Health?.Status, info.restartCount)}</span></td></tr>
              <tr><td>Health Score</td><td><strong style="color:${Utils.healthScoreColor(Utils.containerHealthScore({state: stateStatus, exitCode: state.ExitCode || 0, health: state.Health?.Status, restartCount: info.restartCount || 0, cpuPercent: 0, memPercent: 0, imageAge: 0, vulnCount: 0}))}">${Utils.containerHealthScore({state: stateStatus, exitCode: state.ExitCode || 0, health: state.Health?.Status, restartCount: info.restartCount || 0, cpuPercent: 0, memPercent: 0, imageAge: 0, vulnCount: 0})}/100</strong> <span class="text-sm text-muted">(${Utils.healthScoreLabel(Utils.containerHealthScore({state: stateStatus, exitCode: state.ExitCode || 0, health: state.Health?.Status, restartCount: info.restartCount || 0, cpuPercent: 0, memPercent: 0, imageAge: 0, vulnCount: 0}))})</span></td></tr>
              <tr><td>${i18n.t('pages.containers.created')}</td><td>${Utils.formatDate(info.created)}</td></tr>
              <tr><td>${i18n.t('pages.containers.started')}</td><td>${Utils.formatDate(state.StartedAt)}</td></tr>
              ${stateStatus === 'exited' ? `<tr><td>${i18n.t('pages.containers.exitCode')}</td><td>${state.ExitCode}</td></tr>` : ''}
              <tr><td>${i18n.t('pages.containers.platform')}</td><td>${info.platform || '—'}</td></tr>
              <tr><td>${i18n.t('pages.containers.restartPolicy')}</td><td>${info.restartPolicy?.Name || '—'}</td></tr>
              <tr><td>${i18n.t('pages.containers.command')}</td><td class="mono text-sm">${Utils.escapeHtml((info.cmd || []).join(' '))}</td></tr>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.containers.resources')}</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>${i18n.t('pages.containers.cpuLimit')}</td><td>${resources.cpuQuota ? ((resources.cpuQuota / (resources.cpuPeriod || 100000))).toFixed(2) + ' ' + i18n.t('pages.containers.cores') : i18n.t('pages.containers.unlimited')}</td></tr>
              <tr><td>${i18n.t('pages.containers.memoryLimit')}</td><td>${resources.memory ? Utils.formatBytes(resources.memory) : i18n.t('pages.containers.unlimited')}</td></tr>
              <tr><td>${i18n.t('pages.containers.pidsLimit')}</td><td>${resources.pidsLimit || i18n.t('pages.containers.unlimited')}</td></tr>
            </table>
          </div>
        </div>
      </div>

      ${ports ? `
      <div class="card mt-md">
        <div class="card-header"><h3>${i18n.t('pages.containers.portBindings')}</h3></div>
        <div class="card-body">
          <table class="data-table compact"><thead><tr><th>${i18n.t('pages.containers.container')}</th><th>${i18n.t('pages.containers.host')}</th></tr></thead><tbody>${ports}</tbody></table>
        </div>
      </div>` : ''}

      ${mounts ? `
      <div class="card mt-md">
        <div class="card-header"><h3>${i18n.t('pages.containers.mounts')}</h3></div>
        <div class="card-body">
          <table class="data-table compact"><thead><tr><th>${i18n.t('pages.containers.type')}</th><th>${i18n.t('pages.containers.source')}</th><th>${i18n.t('pages.containers.destination')}</th><th>${i18n.t('pages.containers.mode')}</th></tr></thead><tbody>${mounts}</tbody></table>
        </div>
      </div>` : ''}

      ${nets ? `
      <div class="card mt-md">
        <div class="card-header"><h3>${i18n.t('pages.containers.networks')}</h3></div>
        <div class="card-body">
          <table class="data-table compact"><thead><tr><th>${i18n.t('pages.containers.network')}</th><th>${i18n.t('pages.containers.ip')}</th><th>${i18n.t('pages.containers.gateway')}</th></tr></thead><tbody>${nets}</tbody></table>
        </div>
      </div>` : ''}

      ${env ? `
      <div class="card mt-md">
        <div class="card-header"><h3>${i18n.t('pages.containers.environment')}</h3></div>
        <div class="card-body env-table-wrap">
          <table class="data-table compact"><thead><tr><th>${i18n.t('pages.containers.key')}</th><th>${i18n.t('pages.containers.value')}</th></tr></thead><tbody>${env}</tbody></table>
        </div>
      </div>` : ''}
    `;

    // Load and display container metadata card
    this._loadMetaCard(el, info.name);

    // Wire sandbox buttons
    if (isSandbox) {
      el.querySelector('#sb-extend-btn')?.addEventListener('click', async () => {
        try {
          const r = await Api.extendSandbox(this._detailId);
          Toast.success(`Sandbox extended to ${new Date(r.expiresAt).toLocaleTimeString()}`);
          this._renderTab('info');
        } catch (err) { Toast.error(err.message); }
      });
      el.querySelector('#sb-remove-btn')?.addEventListener('click', async () => {
        const ok = await Modal.confirm('Stop and permanently remove this sandbox container?', { danger: true, confirmText: 'Remove' });
        if (!ok) return;
        try {
          await Api.removeSandbox(this._detailId);
          Toast.success('Sandbox removed');
          App.navigate('/containers');
        } catch (err) { Toast.error(err.message); }
      });
    }
  },

  async _loadMetaCard(el, containerName) {
    try {
      const meta = await Api.getContainerMeta(containerName);
      const customFields = typeof meta.custom_fields === 'object' && meta.custom_fields !== null ? meta.custom_fields : {};
      const userFields = Object.entries(customFields).filter(([k]) => k !== 'sandbox');
      const hasData = meta.app_name || meta.description || meta.lan_link || meta.web_link || meta.docs_url || meta.category || meta.owner || meta.notes || userFields.length > 0;
      if (!hasData) return;

      const links = [];
      if (meta.lan_link) links.push(`<a href="${Utils.escapeHtml(meta.lan_link)}" target="_blank" rel="noopener"><i class="fas fa-home"></i> LAN</a>`);
      if (meta.web_link) links.push(`<a href="${Utils.escapeHtml(meta.web_link)}" target="_blank" rel="noopener"><i class="fas fa-globe"></i> WEB</a>`);
      if (meta.docs_url) links.push(`<a href="${Utils.escapeHtml(meta.docs_url)}" target="_blank" rel="noopener"><i class="fas fa-book"></i> Docs</a>`);

      const customFieldsHtml = userFields.length > 0 ? `
        <tr><td colspan="2" style="padding-top:12px;font-weight:600;color:var(--accent);font-size:11px;text-transform:uppercase">Custom Attributes</td></tr>
        ${userFields.map(([k, v]) => `
          <tr>
            <td style="color:var(--text-dim)">${Utils.escapeHtml(k)}</td>
            <td class="meta-editable" data-field="custom_val_${Utils.escapeHtml(k)}" data-custom-key="${Utils.escapeHtml(k)}">${Utils.escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td>
          </tr>
        `).join('')}
      ` : '';

      const card = document.createElement('div');
      card.className = 'card mt-md';
      card.style.borderLeft = meta.color ? `3px solid ${meta.color}` : '';
      card.innerHTML = `
        <div class="card-header"><h3><i class="fas fa-tag" style="color:var(--accent);margin-right:6px"></i>${i18n.t('pages.containers.meta.title')}</h3></div>
        <div class="card-body">
          <table class="info-table">
            ${meta.app_name ? `<tr><td>${i18n.t('pages.containers.meta.appName')}</td><td class="text-bright meta-editable" data-field="app_name" style="font-weight:600">${Utils.escapeHtml(meta.app_name)}</td></tr>` : ''}
            ${meta.description ? `<tr><td>${i18n.t('pages.containers.meta.description')}</td><td class="meta-editable" data-field="description">${Utils.escapeHtml(meta.description)}</td></tr>` : ''}
            ${links.length ? `<tr><td>Links</td><td><div class="meta-card-links">${links.join('')}</div></td></tr>` : ''}
            ${meta.category ? `<tr><td>${i18n.t('pages.containers.meta.category')}</td><td class="meta-editable" data-field="category"><span class="badge badge-meta-cat">${Utils.escapeHtml(meta.category)}</span></td></tr>` : ''}
            ${meta.owner ? `<tr><td>${i18n.t('pages.containers.meta.owner')}</td><td class="meta-editable" data-field="owner">${Utils.escapeHtml(meta.owner)}</td></tr>` : ''}
            ${meta.notes ? `<tr><td>${i18n.t('pages.containers.meta.notes')}</td><td class="text-sm meta-editable" data-field="notes">${Utils.escapeHtml(meta.notes)}</td></tr>` : ''}
            ${customFieldsHtml}
          </table>
          <button class="btn btn-xs btn-secondary" id="meta-add-custom" style="margin-top:8px"><i class="fas fa-plus"></i> Add Custom Field</button>
        </div>
      `;

      // Insert before the first info-grid
      const firstGrid = el.querySelector('.info-grid');
      if (firstGrid) el.insertBefore(card, firstGrid);
      else el.prepend(card);

      // Wire inline editing for editable meta cells
      card.querySelectorAll('.meta-editable').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.title = 'Click to edit';
        cell.addEventListener('click', async () => {
          const field = cell.dataset.field;
          const currentVal = cell.textContent.trim();
          const input = document.createElement('input');
          input.className = 'form-control';
          input.value = currentVal;
          input.style.cssText = 'padding:2px 6px;font-size:12px;width:100%;';
          cell.textContent = '';
          cell.appendChild(input);
          input.focus();
          input.select();

          const save = async () => {
            const newVal = input.value.trim();
            cell.textContent = newVal || '\u2014';
            if (newVal !== currentVal) {
              try {
                const update = {};
                update[field] = newVal;
                await Api.updateContainerMeta(containerName, update);
                Toast.success(`${field} updated`);
              } catch (err) { Toast.error(err.message); cell.textContent = currentVal; }
            }
          };

          input.addEventListener('blur', save);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { cell.textContent = currentVal; }
          });
        });
      });

      // Wire inline editing for custom field values
      card.querySelectorAll('[data-custom-key]').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.title = 'Click to edit';
        cell.addEventListener('click', async () => {
          const customKey = cell.dataset.customKey;
          const currentVal = cell.textContent.trim();
          const input = document.createElement('input');
          input.className = 'form-control';
          input.value = currentVal;
          input.style.cssText = 'padding:2px 6px;font-size:12px;width:100%;';
          cell.textContent = '';
          cell.appendChild(input);
          input.focus();
          input.select();

          const save = async () => {
            const newVal = input.value.trim();
            cell.textContent = newVal || '\u2014';
            if (newVal !== currentVal) {
              try {
                const currentMeta = await Api.getContainerMeta(containerName);
                const cf = typeof currentMeta.custom_fields === 'object' && currentMeta.custom_fields !== null ? currentMeta.custom_fields : {};
                cf[customKey] = newVal;
                await Api.updateContainerMeta(containerName, { custom_fields: cf });
                Toast.success(`${customKey} updated`);
              } catch (err) { Toast.error(err.message); cell.textContent = currentVal; }
            }
          };

          input.addEventListener('blur', save);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { cell.textContent = currentVal; }
          });
        });
      });

      // Add Custom Field button
      card.querySelector('#meta-add-custom')?.addEventListener('click', async () => {
        const key = prompt('Field name:');
        if (!key) return;
        const value = prompt('Value:');
        if (value === null) return;
        try {
          const currentMeta = await Api.getContainerMeta(containerName);
          const cf = typeof currentMeta.custom_fields === 'object' && currentMeta.custom_fields !== null ? currentMeta.custom_fields : {};
          cf[key] = value;
          await Api.updateContainerMeta(containerName, { custom_fields: cf });
          Toast.success(`Custom field "${key}" added`);
          // Refresh the meta card
          card.remove();
          this._loadMetaCard(el, containerName);
        } catch (err) { Toast.error(err.message); }
      });
    } catch { /* silently skip */ }
  },

  _allLogLines: [],

  async _renderLogsTab(el) {
    el.innerHTML = `
      <div class="log-toolbar">
        <select id="log-tail">
          <option value="100">${i18n.t('pages.containers.last', { n: 100 })}</option>
          <option value="500" selected>${i18n.t('pages.containers.last', { n: 500 })}</option>
          <option value="2000">${i18n.t('pages.containers.last', { n: 2000 })}</option>
        </select>
        <select id="log-since" title="Time range">
          <option value="">All time</option>
          <option value="1h">Last 1h</option>
          <option value="6h">Last 6h</option>
          <option value="24h">Last 24h</option>
          <option value="168h">Last 7d</option>
        </select>
        <label class="toggle-label"><input type="checkbox" id="log-follow" checked> ${i18n.t('pages.containers.follow')}</label>
        <div class="search-box" style="flex:1;max-width:260px">
          <i class="fas fa-search"></i>
          <input type="text" id="log-search" placeholder="${i18n.t('pages.containers.searchLogs')}" class="input-sm">
        </div>
        <span id="log-search-count" class="text-muted text-sm" style="min-width:60px"></span>
        <button class="btn btn-sm btn-secondary" id="log-download" title="${i18n.t('pages.containers.downloadLogs')}"><i class="fas fa-download"></i></button>
        <button class="btn btn-sm btn-secondary" id="log-refresh"><i class="fas fa-sync-alt"></i></button>
      </div>
      <pre class="log-viewer" id="log-output">${i18n.t('common.loading')}</pre>
    `;

    this._allLogLines = [];

    const renderLogLines = (lines, searchTerm) => {
      const output = el.querySelector('#log-output');
      if (!output) return;
      if (!lines || lines.length === 0) { output.innerHTML = i18n.t('pages.containers.logsEmpty'); return; }

      const html = lines.map(line => {
        let cls = '';
        const lower = line.toLowerCase();
        if (/\b(error|fatal|panic|exception|fail)\b/i.test(line)) cls = 'log-error';
        else if (/\b(warn|warning)\b/i.test(line)) cls = 'log-warn';
        else if (/\b(info)\b/i.test(line)) cls = 'log-info';
        else if (/\b(debug|trace)\b/i.test(line)) cls = 'log-debug';

        let escaped = Utils.escapeHtml(line);
        if (searchTerm) {
          const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          escaped = escaped.replace(regex, '<mark class="log-highlight">$1</mark>');
        }
        return `<span class="log-line ${cls}">${escaped}</span>`;
      }).join('\n');

      output.innerHTML = html;
      if (el.querySelector('#log-follow')?.checked) output.scrollTop = output.scrollHeight;
    };

    const loadLogs = async () => {
      const tail = el.querySelector('#log-tail').value;
      const since = el.querySelector('#log-since')?.value || '';
      const searchInput = el.querySelector('#log-search');
      const search = searchInput?.value?.trim() || '';
      try {
        const data = await Api.getContainerLogs(this._detailId, tail, search, since);
        const lines = Array.isArray(data.lines) ? data.lines : [];
        if (!search) this._allLogLines = lines;
        const countEl = el.querySelector('#log-search-count');
        if (countEl) countEl.textContent = search ? `${lines.length} ${i18n.t('pages.containers.matches')}` : '';
        renderLogLines(lines, search);
      } catch (err) {
        const output = el.querySelector('#log-output');
        if (output) output.textContent = i18n.t('pages.containers.logsError', { message: err.message });
      }
    };

    el.querySelector('#log-tail').addEventListener('change', loadLogs);
    el.querySelector('#log-since').addEventListener('change', loadLogs);
    el.querySelector('#log-refresh').addEventListener('click', loadLogs);

    // Server-side search
    el.querySelector('#log-search').addEventListener('input', Utils.debounce(() => loadLogs(), 400));

    // Download
    el.querySelector('#log-download').addEventListener('click', () => {
      const tail = el.querySelector('#log-tail').value;
      const since = el.querySelector('#log-since')?.value || '';
      const search = el.querySelector('#log-search')?.value?.trim() || '';
      let url = `/api/containers/${this._detailId}/logs?tail=${tail}&download=true`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (since) url += `&since=${encodeURIComponent(since)}`;
      const a = document.createElement('a');
      a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    });

    // Follow toggle: use WebSocket-based log streaming
    el.querySelector('#log-follow').addEventListener('change', (e) => {
      if (e.target.checked) {
        this._startLogFollow();
      } else {
        this._stopLogFollow();
      }
    });

    // Start follow by default since checkbox is checked
    await loadLogs();
    if (el.querySelector('#log-follow')?.checked) {
      this._startLogFollow();
    }
  },

  _startLogFollow() {
    this._logFollowing = true;
    WS.send('logs:subscribe', { containerId: this._detailId, tail: 50, hostId: Api.getHostId() });

    this._logDataHandler = WS.on('logs:data', (msg) => {
      if (msg.data?.containerId !== this._detailId) return;
      const el = document.getElementById('log-output');
      if (!el) return;
      const lines = msg.data.lines || [];
      for (const line of lines) {
        let cls = '';
        if (/\b(error|fatal|panic|exception|fail)\b/i.test(line)) cls = 'log-error';
        else if (/\b(warn|warning)\b/i.test(line)) cls = 'log-warn';
        else if (/\b(info)\b/i.test(line)) cls = 'log-info';
        else if (/\b(debug|trace)\b/i.test(line)) cls = 'log-debug';
        el.innerHTML += `\n<span class="log-line ${cls}">${Utils.escapeHtml(line)}</span>`;
        this._allLogLines.push(line);
      }
      // Auto-scroll
      el.scrollTop = el.scrollHeight;
      // Trim if too long
      if (el.innerHTML.length > 500000) {
        const allLines = el.querySelectorAll('.log-line');
        const removeCount = Math.floor(allLines.length / 3);
        for (let i = 0; i < removeCount; i++) allLines[i].remove();
      }
    });

    this._logEndHandler = WS.on('logs:end', (msg) => {
      if (msg.data?.containerId !== this._detailId) return;
      const el = document.getElementById('log-output');
      if (el) el.innerHTML += '\n<span class="log-line log-warn">[Stream ended — container may have stopped]</span>';
      this._logFollowing = false;
    });
  },

  _stopLogFollow() {
    this._logFollowing = false;
    WS.send('logs:unsubscribe', {});
    if (this._logDataHandler) { this._logDataHandler(); this._logDataHandler = null; }
    if (this._logEndHandler) { this._logEndHandler(); this._logEndHandler = null; }
  },

  // ─── Terminal Tab (exec) ────────────────────
  _execUnsub: null,
  _execActive: false,

  _renderTerminalTab(el) {
    const state = this._detailData?.state || {};
    const running = state.Running || state.Status === 'running';

    if (!running) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-terminal"></i><p>${i18n.t('pages.containers.mustBeRunning')}</p></div>`;
      return;
    }

    el.innerHTML = `
      <div class="terminal-toolbar">
        <select id="term-shell" class="form-control" style="width:auto;display:inline-block;padding:4px 8px">
          <option value="/bin/sh">sh</option>
          <option value="/bin/bash">bash</option>
          <option value="/bin/ash">ash</option>
        </select>
        <button class="btn btn-sm btn-primary" id="term-connect">
          <i class="fas fa-plug"></i> ${i18n.t('pages.containers.connect')}
        </button>
        <button class="btn btn-sm btn-danger hidden" id="term-disconnect">
          <i class="fas fa-times"></i> ${i18n.t('pages.containers.disconnect')}
        </button>
        <span class="text-dim text-sm" id="term-status">${i18n.t('pages.containers.notConnected')}</span>
      </div>
      <div id="terminal-container" class="terminal-container" style="height:calc(100vh - 300px)"></div>
    `;

    el.querySelector('#term-connect').addEventListener('click', () => this._startExec());
    el.querySelector('#term-disconnect').addEventListener('click', () => this._stopExec());
  },

  _startExec() {
    if (this._execActive) return;
    this._execActive = true;

    const termEl = document.getElementById('terminal-container');
    const statusEl = document.getElementById('term-status');
    const connectBtn = document.getElementById('term-connect');
    const disconnectBtn = document.getElementById('term-disconnect');
    const shellSelect = document.getElementById('term-shell');
    if (!termEl) return;

    termEl.innerHTML = '';
    connectBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    statusEl.textContent = i18n.t('pages.containers.connecting');
    statusEl.style.color = 'var(--yellow)';

    // Check if xterm is available
    if (typeof Terminal === 'undefined') {
      // Fallback to old textarea terminal
      this._startExecFallback(termEl, statusEl, connectBtn, disconnectBtn);
      return;
    }

    // Initialize xterm.js
    this._term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
      },
    });

    if (typeof FitAddon !== 'undefined') {
      this._fitAddon = new FitAddon.FitAddon();
      this._term.loadAddon(this._fitAddon);
    }

    this._term.open(termEl);
    if (this._fitAddon) this._fitAddon.fit();

    // Resize observer
    this._termResizeObserver = new ResizeObserver(() => {
      if (this._fitAddon) this._fitAddon.fit();
      if (this._execActive && this._term) {
        WS.send('exec:resize', { cols: this._term.cols, rows: this._term.rows });
      }
    });
    this._termResizeObserver.observe(termEl);

    // Send terminal input via WebSocket
    this._termDataDisposable = this._term.onData((data) => {
      WS.send('exec:input', { data });
    });

    // Listen for exec events
    const onStarted = () => {
      statusEl.textContent = i18n.t('pages.containers.connected');
      statusEl.style.color = 'var(--green)';
      this._term.focus();
      // Send initial resize
      WS.send('exec:resize', { cols: this._term.cols, rows: this._term.rows });
    };

    const onOutput = (msg) => {
      if (this._term) this._term.write(msg.data);
    };

    const onEnd = () => {
      statusEl.textContent = i18n.t('pages.containers.disconnected');
      statusEl.style.color = 'var(--red)';
      if (this._term) this._term.write('\r\n\x1b[31m[Session ended]\x1b[0m\r\n');
      this._execActive = false;
      connectBtn.classList.remove('hidden');
      disconnectBtn.classList.add('hidden');
    };

    const onError = (msg) => {
      Toast.error(i18n.t('pages.containers.terminalError', { message: msg.message || 'Connection failed' }));
      onEnd();
    };

    this._execUnsub = [
      WS.on('exec:started', onStarted),
      WS.on('exec:output', onOutput),
      WS.on('exec:end', onEnd),
      WS.on('exec:error', onError),
    ];

    const shell = shellSelect?.value || '/bin/sh';
    WS.send('exec:start', {
      containerId: this._detailId,
      shell,
      cols: this._term.cols,
      rows: this._term.rows,
      hostId: Api.getHostId(),
    });
  },

  _startExecFallback(termEl, statusEl, connectBtn, disconnectBtn) {
    // Old textarea-based terminal as fallback if xterm.js not loaded
    termEl.innerHTML = '<pre class="terminal-output" id="term-output"></pre><input type="text" id="term-input" class="terminal-input" autofocus autocomplete="off" spellcheck="false">';
    statusEl.textContent = i18n.t('pages.containers.connecting');

    const output = document.getElementById('term-output');
    const input = document.getElementById('term-input');

    WS.send('exec:start', { containerId: this._detailId, hostId: Api.getHostId() });

    const onStarted = () => {
      statusEl.textContent = i18n.t('pages.containers.connected');
      statusEl.style.color = 'var(--green)';
      input.focus();
    };
    const onOutput = (msg) => {
      if (output) { output.textContent += msg.data; output.scrollTop = output.scrollHeight; }
    };
    const onEnd = () => {
      statusEl.textContent = i18n.t('pages.containers.disconnected');
      statusEl.style.color = 'var(--red)';
      this._execActive = false;
      connectBtn.classList.remove('hidden');
      disconnectBtn.classList.add('hidden');
    };
    const onError = (msg) => {
      Toast.error(msg.message || 'Connection failed');
      onEnd();
    };

    this._execUnsub = [
      WS.on('exec:started', onStarted),
      WS.on('exec:output', onOutput),
      WS.on('exec:end', onEnd),
      WS.on('exec:error', onError),
    ];

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { WS.send('exec:input', { data: input.value + '\n' }); input.value = ''; }
      else if (e.key === 'Tab') { e.preventDefault(); WS.send('exec:input', { data: '\t' }); }
      else if (e.ctrlKey && e.key === 'c') { WS.send('exec:input', { data: '\x03' }); }
      else if (e.ctrlKey && e.key === 'd') { WS.send('exec:input', { data: '\x04' }); }
    });
  },

  _stopExec() {
    WS.send('exec:input', { data: '\x04' });
    this._execActive = false;
    if (this._execUnsub) { this._execUnsub.forEach(fn => fn()); this._execUnsub = null; }
    if (this._termDataDisposable) { this._termDataDisposable.dispose(); this._termDataDisposable = null; }
    if (this._termResizeObserver) { this._termResizeObserver.disconnect(); this._termResizeObserver = null; }
    if (this._term) { this._term.dispose(); this._term = null; }
    this._fitAddon = null;
  },

  async _renderStatsTab(el) {
    el.innerHTML = `
      <div class="stats-toolbar">
        <select id="stats-range">
          <option value="1h" selected>${i18n.t('pages.containers.statsRange1h')}</option>
          <option value="6h">${i18n.t('pages.containers.statsRange6h')}</option>
          <option value="24h">${i18n.t('pages.containers.statsRange24h')}</option>
          <option value="7d">${i18n.t('pages.containers.statsRange7d')}</option>
        </select>
        <button class="btn btn-sm btn-secondary" id="stats-refresh"><i class="fas fa-sync-alt"></i></button>
      </div>
      <div class="stats-grid">
        <div class="card"><div class="card-header"><h3>${i18n.t('pages.containers.cpuPercent')}</h3><div class="chart-export-btns" style="display:flex;gap:4px;margin-left:auto"><button class="btn btn-xs btn-secondary chart-export-png" data-canvas="sc-cpu" title="Export PNG"><i class="fas fa-image"></i></button><button class="btn btn-xs btn-secondary chart-export-csv" data-canvas="sc-cpu" title="Export CSV"><i class="fas fa-file-csv"></i></button></div></div><div class="card-body chart-container"><canvas id="sc-cpu"></canvas></div></div>
        <div class="card"><div class="card-header"><h3>${i18n.t('pages.containers.memory')}</h3><div class="chart-export-btns" style="display:flex;gap:4px;margin-left:auto"><button class="btn btn-xs btn-secondary chart-export-png" data-canvas="sc-mem" title="Export PNG"><i class="fas fa-image"></i></button><button class="btn btn-xs btn-secondary chart-export-csv" data-canvas="sc-mem" title="Export CSV"><i class="fas fa-file-csv"></i></button></div></div><div class="card-body chart-container"><canvas id="sc-mem"></canvas></div></div>
        <div class="card"><div class="card-header"><h3>${i18n.t('pages.containers.networkIO')}</h3><div class="chart-export-btns" style="display:flex;gap:4px;margin-left:auto"><button class="btn btn-xs btn-secondary chart-export-png" data-canvas="sc-net" title="Export PNG"><i class="fas fa-image"></i></button><button class="btn btn-xs btn-secondary chart-export-csv" data-canvas="sc-net" title="Export CSV"><i class="fas fa-file-csv"></i></button></div></div><div class="card-body chart-container"><canvas id="sc-net"></canvas></div></div>
        <div class="card"><div class="card-header"><h3>${i18n.t('pages.containers.blockIO')}</h3><div class="chart-export-btns" style="display:flex;gap:4px;margin-left:auto"><button class="btn btn-xs btn-secondary chart-export-png" data-canvas="sc-blk" title="Export PNG"><i class="fas fa-image"></i></button><button class="btn btn-xs btn-secondary chart-export-csv" data-canvas="sc-blk" title="Export CSV"><i class="fas fa-file-csv"></i></button></div></div><div class="card-body chart-container"><canvas id="sc-blk"></canvas></div></div>
      </div>
    `;

    const loadStats = async () => {
      const range = el.querySelector('#stats-range').value;
      try {
        const data = await Api.getContainerStatsHistory(this._detailId, range);
        const points = data.stats || data || [];
        this._renderStatsCharts(points);
      } catch (err) {
        Toast.error(i18n.t('pages.containers.statsFailed', { message: err.message }));
      }
    };

    el.querySelector('#stats-range').addEventListener('change', loadStats);
    el.querySelector('#stats-refresh').addEventListener('click', loadStats);

    await loadStats();

    // Wire chart export buttons
    el.querySelectorAll('.chart-export-png').forEach(btn => {
      btn.addEventListener('click', () => {
        const canvasId = btn.dataset.canvas;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const link = document.createElement('a');
        link.download = `docker-dash-${canvasId}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        Toast.success('Chart exported as PNG');
      });
    });

    el.querySelectorAll('.chart-export-csv').forEach(btn => {
      btn.addEventListener('click', () => {
        const canvasId = btn.dataset.canvas;
        const canvas = document.getElementById(canvasId);
        const chart = canvas ? Chart.getChart(canvas) : null;
        if (!chart) { Toast.error('Chart not ready'); return; }
        const labels = chart.data.labels || [];
        const datasets = chart.data.datasets || [];
        let csv = 'Time,' + datasets.map(d => d.label).join(',') + '\n';
        labels.forEach((label, i) => {
          csv += label + ',' + datasets.map(d => (d.data[i] !== undefined ? Number(d.data[i]).toFixed(2) : '')).join(',') + '\n';
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const link = document.createElement('a');
        link.download = `docker-dash-${canvasId}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
        link.href = URL.createObjectURL(blob);
        link.click();
        Toast.success('Chart exported as CSV');
      });
    });
  },

  _renderStatsCharts(points) {
    if (!points || points.length === 0) return;
    const labels = points.map(p => new Date(p.timestamp || p.collected_at).toLocaleTimeString());

    this._makeLineChart('sc-cpu', labels, [
      { label: i18n.t('pages.containers.cpuPercent'), data: points.map(p => p.cpu_percent), color: '#0ea5e9' }
    ], '%');

    this._makeLineChart('sc-mem', labels, [
      { label: i18n.t('pages.containers.memory'), data: points.map(p => p.memory_usage / (1024*1024)), color: '#a855f7' }
    ], ' MB');

    this._makeLineChart('sc-net', labels, [
      { label: 'RX', data: points.map(p => (p.net_rx || 0) / 1024), color: '#22c55e' },
      { label: 'TX', data: points.map(p => (p.net_tx || 0) / 1024), color: '#ef4444' },
    ], ' KB');

    this._makeLineChart('sc-blk', labels, [
      { label: 'Read', data: points.map(p => (p.block_read || 0) / 1024), color: '#eab308' },
      { label: 'Write', data: points.map(p => (p.block_write || 0) / 1024), color: '#f97316' },
    ], ' KB');
  },

  _makeLineChart(canvasId, labels, datasets, suffix) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: datasets.map(ds => ({
          label: ds.label,
          data: ds.data,
          borderColor: ds.color,
          backgroundColor: ds.color + '20',
          fill: true,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: { display: true, grid: { color: '#1e2a3a' }, ticks: { maxTicksLimit: 10 } },
          y: { beginAtZero: true, grid: { color: '#1e2a3a' }, ticks: { callback: v => v + suffix } },
        },
        plugins: {
          legend: { display: datasets.length > 1, position: 'top', labels: { usePointStyle: true, padding: 8 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}${suffix}` } },
        },
      },
    });
  },

  _renderEnvTab(el) {
    const envVars = this._detailData?.env || [];
    const parsed = envVars.map(e => {
      const eq = e.indexOf('=');
      return eq > 0 ? { key: e.substring(0, eq), value: e.substring(eq + 1) } : { key: e, value: '' };
    }).sort((a, b) => a.key.localeCompare(b.key));

    const sensitive = /password|secret|token|key|api_key|auth|credential/i;

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span class="text-muted text-sm">${parsed.length} environment variable(s)</span>
        <div style="display:flex;gap:8px">
          <div class="search-box" style="min-width:200px">
            <i class="fas fa-search"></i>
            <input type="text" id="env-search" placeholder="Filter variables..." class="input-sm">
          </div>
          <button class="btn btn-sm btn-secondary" id="env-copy-all"><i class="fas fa-copy"></i> Copy All</button>
        </div>
      </div>
      ${parsed.length === 0 ? '<div class="empty-msg">No environment variables</div>' : `
      <table class="data-table" id="env-table">
        <thead><tr><th style="text-align:left;width:35%">Variable</th><th style="text-align:left">Value</th></tr></thead>
        <tbody>${parsed.map(v => `
          <tr class="env-row" data-key="${Utils.escapeHtml(v.key.toLowerCase())}">
            <td style="text-align:left" class="mono text-sm"><strong>${Utils.escapeHtml(v.key)}</strong></td>
            <td style="text-align:left;word-break:break-all" class="mono text-sm">${
              sensitive.test(v.key)
                ? '<span class="text-muted env-reveal" title="Click to reveal" style="cursor:pointer" data-v="' + Utils.escapeHtml(v.value) + '">••••••••</span>'
                : Utils.escapeHtml(v.value)
            }</td>
          </tr>
        `).join('')}</tbody>
      </table>`}
    `;

    // Wire up env var reveal clicks
    el.querySelectorAll('.env-reveal').forEach(span => {
      span.addEventListener('click', () => { span.textContent = span.dataset.v; });
    });

    el.querySelector('#env-search')?.addEventListener('input', Utils.debounce(() => {
      const q = el.querySelector('#env-search').value.toLowerCase();
      el.querySelectorAll('.env-row').forEach(row => {
        row.style.display = row.dataset.key.includes(q) ? '' : 'none';
      });
    }, 200));

    el.querySelector('#env-copy-all')?.addEventListener('click', () => {
      const text = parsed.map(v => v.key + '=' + v.value).join('\n');
      Utils.copyToClipboard(text);
      Toast.success('Environment variables copied!');
    });

    // Load and show dependencies
    this._loadDependencies(el);
  },

  async _loadDependencies(el) {
    try {
      const deps = await Api.getContainerDeps(this._detailId);
      if (!deps.hasDependencies) return;

      const depsHtml = document.createElement('div');
      depsHtml.style.marginTop = '20px';
      depsHtml.innerHTML = `
        <div class="card" style="border-left:3px solid var(--accent)">
          <div class="card-header">
            <h3><i class="fas fa-project-diagram" style="margin-right:8px;color:var(--accent)"></i>Detected Dependencies</h3>
            <button class="btn btn-sm btn-primary" id="deploy-with-deps"><i class="fas fa-rocket"></i> Deploy All to Host</button>
          </div>
          <div class="card-body" style="padding:0">
            ${deps.dependencies.length > 0 ? `
            <table class="data-table">
              <thead><tr><th style="text-align:left">Service</th><th>Detected Via</th><th>Env Variable</th><th>State</th></tr></thead>
              <tbody>${deps.dependencies.map(d => `
                <tr style="cursor:pointer" data-nav-container="${d.container?.id || ''}"
                  <td style="text-align:left"><i class="fas fa-cube" style="margin-right:6px;color:var(--accent)"></i><strong>${Utils.escapeHtml(d.container?.name || d.hostname)}</strong>
                    <div class="text-sm text-muted">${Utils.escapeHtml(d.container?.image || '')}</div></td>
                  <td><span class="badge badge-info" style="font-size:10px">${d.type}</span></td>
                  <td class="mono text-sm">${Utils.escapeHtml(d.envVar || '')}</td>
                  <td><span class="badge ${d.container?.state === 'running' ? 'badge-running' : 'badge-stopped'}">${d.container?.state || 'unknown'}</span></td>
                </tr>
              `).join('')}</tbody>
            </table>` : ''}

            ${deps.stackMembers.length > 0 ? `
            <div style="padding:12px 16px;border-top:1px solid var(--border)">
              <div class="text-sm text-muted" style="margin-bottom:8px"><i class="fas fa-layer-group" style="margin-right:4px"></i>Same stack: <strong>${Utils.escapeHtml(deps.stack)}</strong></div>
              <div style="display:flex;flex-wrap:wrap;gap:4px">
                ${deps.stackMembers.map(s => `<span class="badge ${s.state === 'running' ? 'badge-running' : 'badge-stopped'}" style="cursor:pointer;font-size:11px" data-nav-container="${s.id}">${Utils.escapeHtml(s.name)}</span>`).join('')}
              </div>
            </div>` : ''}
          </div>
        </div>
      `;
      el.appendChild(depsHtml);

      // Wire up container navigation clicks in dependencies
      depsHtml.querySelectorAll('[data-nav-container]').forEach(node => {
        node.addEventListener('click', () => { location.hash = '#/containers/' + node.dataset.navContainer; });
      });

      // Deploy with dependencies button
      depsHtml.querySelector('#deploy-with-deps')?.addEventListener('click', async () => {
        try {
          const hosts = await Api.getHosts();
          const hostOptions = (hosts || []).filter(h => h.is_active).map(h =>
            '<option value="' + h.id + '">' + Utils.escapeHtml(h.name) + '</option>'
          ).join('');

          if (!hostOptions) {
            Toast.warning('No remote hosts configured. Add hosts in Settings > Hosts first.');
            return;
          }

          const result = await Modal.form(
            '<div class="form-group"><label>Destination Host</label><select id="dep-host" class="form-control">' + hostOptions + '</select></div>' +
            '<p class="text-sm text-muted">' + (deps.dependencies.length + deps.stackMembers.length) + ' dependent container(s) will be migrated first, then this container. Zero-downtime migration.</p>',
            {
              title: 'Deploy with Dependencies',
              width: '450px',
              onSubmit: (content) => ({ destHostId: parseInt(content.querySelector('#dep-host').value) }),
            }
          );

          if (result) {
            Toast.info('Migrating container + dependencies...');
            const migResult = await Api.deployWithDeps(this._detailId, result.destHostId);
            if (migResult.ok) {
              Toast.success('All ' + migResult.succeeded + ' containers migrated successfully!');
            } else {
              Toast.warning(migResult.succeeded + '/' + migResult.total + ' migrated. ' + migResult.failed + ' failed.');
            }
          }
        } catch (err) { Toast.error(err.message); }
      });
    } catch { /* dependency detection is best-effort */ }
  },

  _renderLabelsTab(el) {
    const labels = this._detailData?.labels || {};
    const entries = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));

    if (entries.length === 0) {
      el.innerHTML = '<div class="empty-msg"><i class="fas fa-tags"></i><p>No labels</p></div>';
      return;
    }

    // Group: compose labels, traefik labels, custom labels
    const compose = entries.filter(([k]) => k.startsWith('com.docker.compose.'));
    const traefik = entries.filter(([k]) => k.startsWith('traefik.'));
    const dockerDash = entries.filter(([k]) => k.startsWith('docker-dash.'));
    const custom = entries.filter(([k]) => !k.startsWith('com.docker.compose.') && !k.startsWith('traefik.') && !k.startsWith('docker-dash.'));

    const renderGroup = (title, icon, items) => {
      if (items.length === 0) return '';
      return `
        <div style="margin-bottom:16px">
          <h4 style="margin:0 0 8px"><i class="${icon}" style="margin-right:6px;opacity:0.6"></i>${title} (${items.length})</h4>
          <table class="data-table">
            <thead><tr><th style="text-align:left;width:40%">Label</th><th style="text-align:left">Value</th></tr></thead>
            <tbody>${items.map(([k, v]) => `
              <tr class="label-row" data-key="${Utils.escapeHtml(k.toLowerCase())}">
                <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(k)}</td>
                <td style="text-align:left;word-break:break-all" class="mono text-sm">${Utils.escapeHtml(v)}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>`;
    };

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span class="text-muted text-sm">${entries.length} label(s)</span>
        <div style="display:flex;gap:8px">
          <div class="search-box" style="min-width:200px">
            <i class="fas fa-search"></i>
            <input type="text" id="label-search" placeholder="Filter labels..." class="input-sm">
          </div>
          <button class="btn btn-sm btn-secondary" id="label-copy"><i class="fas fa-copy"></i> Copy All</button>
        </div>
      </div>
      ${renderGroup('Custom Labels', 'fas fa-tag', custom)}
      ${renderGroup('Docker Compose', 'fas fa-layer-group', compose)}
      ${renderGroup('Traefik', 'fas fa-random', traefik)}
      ${renderGroup('Docker Dash', 'fas fa-chart-pie', dockerDash)}
    `;

    el.querySelector('#label-search')?.addEventListener('input', Utils.debounce(() => {
      const q = el.querySelector('#label-search').value.toLowerCase();
      el.querySelectorAll('.label-row').forEach(row => {
        row.style.display = row.dataset.key.includes(q) ? '' : 'none';
      });
    }, 200));

    el.querySelector('#label-copy')?.addEventListener('click', () => {
      Utils.copyToClipboard(entries.map(([k, v]) => k + '=' + v).join('\n'));
      Toast.success('Labels copied!');
    });
  },

  _renderMountsTab(el) {
    const mounts = this._detailData?.mounts || [];
    if (mounts.length === 0) {
      el.innerHTML = '<div class="empty-msg"><i class="fas fa-hdd"></i><p>No volumes or bind mounts</p></div>';
      return;
    }

    el.innerHTML = `
      <div class="text-muted text-sm" style="margin-bottom:12px">${mounts.length} mount(s)</div>
      <table class="data-table">
        <thead><tr>
          <th style="text-align:left">Type</th>
          <th style="text-align:left">Source</th>
          <th style="text-align:left">Destination</th>
          <th>Mode</th>
        </tr></thead>
        <tbody>${mounts.map(m => {
          const isVolume = m.Type === 'volume' || m.type === 'volume';
          const source = m.Source || m.source || m.Name || m.name || '—';
          const dest = m.Destination || m.destination || '—';
          const rw = m.RW !== undefined ? m.RW : m.rw;
          return `
            <tr>
              <td style="text-align:left"><span class="badge ${isVolume ? 'badge-info' : 'badge-warning'}" style="font-size:10px">${isVolume ? 'volume' : 'bind'}</span></td>
              <td style="text-align:left;word-break:break-all" class="mono text-sm">${Utils.escapeHtml(source)}</td>
              <td style="text-align:left;word-break:break-all" class="mono text-sm">${Utils.escapeHtml(dest)}</td>
              <td>${rw === false ? '<span class="text-muted">ro</span>' : '<span class="text-green">rw</span>'}</td>
            </tr>`;
        }).join('')}</tbody>
      </table>
    `;
  },

  _renderNetworkTab(el) {
    const networks = this._detailData?.networks || {};
    const entries = Object.entries(networks);

    if (entries.length === 0) {
      el.innerHTML = '<div class="empty-msg"><i class="fas fa-network-wired"></i><p>Not connected to any network</p></div>';
      return;
    }

    // Port bindings
    const ports = this._detailData?.ports || {};
    const portEntries = Object.entries(ports);

    el.innerHTML = `
      ${portEntries.length > 0 ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3><i class="fas fa-plug" style="margin-right:8px;opacity:0.6"></i>Port Bindings</h3></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead><tr><th style="text-align:left">Container Port</th><th style="text-align:left">Host Binding</th></tr></thead>
            <tbody>${portEntries.map(([containerPort, bindings]) => {
              if (!bindings || bindings.length === 0) return `<tr><td style="text-align:left" class="mono">${Utils.escapeHtml(containerPort)}</td><td class="text-muted">Not bound</td></tr>`;
              return bindings.map(b => `<tr><td style="text-align:left" class="mono">${Utils.escapeHtml(containerPort)}</td><td class="mono text-green">${b.HostIp || '0.0.0.0'}:${b.HostPort}</td></tr>`).join('');
            }).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-header"><h3><i class="fas fa-network-wired" style="margin-right:8px;opacity:0.6"></i>Networks (${entries.length})</h3></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead><tr><th style="text-align:left">Network</th><th style="text-align:left">IPv4 Address</th><th style="text-align:left">Gateway</th><th style="text-align:left">MAC</th></tr></thead>
            <tbody>${entries.map(([name, net]) => `
              <tr>
                <td style="text-align:left"><strong>${Utils.escapeHtml(name)}</strong></td>
                <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(net.IPAddress || '—')}</td>
                <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(net.Gateway || '—')}</td>
                <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(net.MacAddress || '—')}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
      </div>
    `;
  },

  _renderInspectTab(el) {
    const json = JSON.stringify(this._detailData, null, 2);
    el.innerHTML = `
      <div class="inspect-toolbar">
        <button class="btn btn-sm btn-secondary" id="inspect-copy"><i class="fas fa-copy"></i> ${i18n.t('pages.containers.copyJson')}</button>
      </div>
      <pre class="inspect-json">${Utils.escapeHtml(json)}</pre>
    `;
    el.querySelector('#inspect-copy').addEventListener('click', () => {
      Utils.copyToClipboard(json).then(() => Toast.success(i18n.t('common.copied')));
    });
  },

  // Popular images for the image picker
  _popularImages: [
    { name: 'nginx', desc: 'Web server & reverse proxy', icon: 'fa-globe' },
    { name: 'postgres', desc: 'PostgreSQL database', icon: 'fa-database' },
    { name: 'redis', desc: 'In-memory data store', icon: 'fa-bolt' },
    { name: 'mysql', desc: 'MySQL database', icon: 'fa-database' },
    { name: 'mariadb', desc: 'MariaDB database', icon: 'fa-database' },
    { name: 'mongo', desc: 'MongoDB NoSQL database', icon: 'fa-leaf' },
    { name: 'node', desc: 'Node.js runtime', icon: 'fa-code' },
    { name: 'python', desc: 'Python runtime', icon: 'fa-code' },
    { name: 'alpine', desc: 'Minimal Linux base (~5MB)', icon: 'fa-mountain' },
    { name: 'ubuntu', desc: 'Ubuntu Linux', icon: 'fa-ubuntu', brand: true },
    { name: 'httpd', desc: 'Apache HTTP Server', icon: 'fa-server' },
    { name: 'rabbitmq', desc: 'Message broker', icon: 'fa-envelope' },
    { name: 'traefik', desc: 'Cloud-native reverse proxy', icon: 'fa-network-wired' },
    { name: 'caddy', desc: 'Automatic HTTPS web server', icon: 'fa-lock' },
    { name: 'grafana/grafana', desc: 'Monitoring dashboards', icon: 'fa-chart-line' },
    { name: 'prom/prometheus', desc: 'Metrics & alerting', icon: 'fa-fire' },
    { name: 'portainer/portainer-ce', desc: 'Container management', icon: 'fa-cubes' },
    { name: 'dpage/pgadmin4', desc: 'PostgreSQL admin UI', icon: 'fa-table' },
    { name: 'wordpress', desc: 'WordPress CMS', icon: 'fa-blog' },
    { name: 'adminer', desc: 'Database management UI', icon: 'fa-columns' },
  ],

  // ─── Container Creation Wizard ──────────────────
  async _createContainerDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>${i18n.t('pages.containers.containerName')}</label>
        <input type="text" id="cc-name" class="form-control" placeholder="my-container" required>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.containers.image')}</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="cc-image" class="form-control" placeholder="${i18n.t('pages.containers.imagePlaceholder')}" required style="flex:1">
          <button type="button" class="btn btn-sm btn-secondary" id="cc-browse-images" title="Browse popular images"><i class="fas fa-search"></i> Browse</button>
        </div>
        <div id="cc-image-picker" style="display:none;margin-top:8px;max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface2)">
          ${this._popularImages.map(img => `
            <div class="image-picker-item" data-image="${img.name}:latest" style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s">
              <i class="${img.brand ? 'fab' : 'fas'} ${img.icon}" style="width:16px;text-align:center;color:var(--accent)"></i>
              <span class="mono text-sm" style="font-weight:600">${img.name}</span>
              <span class="text-xs text-muted" style="flex:1">${img.desc}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.containers.portsLabel')}</label>
          <textarea id="cc-ports" class="form-control" rows="3" placeholder="8080:80&#10;443:443"></textarea>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.containers.volumesLabel')}</label>
          <textarea id="cc-volumes" class="form-control" rows="3" placeholder="/data:/app/data&#10;myvolume:/var/lib"></textarea>
        </div>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.containers.envLabel')}</label>
        <textarea id="cc-env" class="form-control" rows="3" placeholder="NODE_ENV=production&#10;PORT=3000"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.containers.restartPolicyLabel')}</label>
          <select id="cc-restart" class="form-control">
            <option value="">${i18n.t('pages.containers.restartNone')}</option>
            <option value="always" selected>${i18n.t('pages.containers.restartAlways')}</option>
            <option value="unless-stopped">${i18n.t('pages.containers.restartUnlessStopped')}</option>
            <option value="on-failure">${i18n.t('pages.containers.restartOnFailure')}</option>
          </select>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.containers.networkLabel')}</label>
          <input type="text" id="cc-network" class="form-control" placeholder="${i18n.t('pages.containers.bridgeDefault')}">
        </div>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.containers.commandLabel')}</label>
        <input type="text" id="cc-cmd" class="form-control" placeholder="e.g. /bin/sh -c 'node app.js'">
      </div>
      <div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap">
        <label class="toggle-label">
          <input type="checkbox" id="cc-start" checked> ${i18n.t('pages.containers.startAfterCreation')}
        </label>
        <label class="toggle-label">
          <input type="checkbox" id="cc-cis-harden"> <i class="fas fa-shield-alt" style="color:var(--green);margin-right:3px"></i> CIS Hardened
        </label>
      </div>
      <div id="cc-cis-info" style="display:none;margin-top:8px;padding:8px 12px;background:var(--green-dim);border-radius:var(--radius);font-size:11px;color:var(--green)">
        <strong>CIS Benchmark hardening:</strong> cap_drop ALL, no-new-privileges, read-only rootfs, memory limit 512MB, CPU 0.5, restart unless-stopped, tmpfs /tmp and /run
      </div>
    `, {
      title: i18n.t('pages.containers.createTitle'),
      width: '700px',
      onMount: (content) => {
        // Image picker toggle
        const browseBtn = content.querySelector('#cc-browse-images');
        const picker = content.querySelector('#cc-image-picker');
        const imageInput = content.querySelector('#cc-image');
        browseBtn.addEventListener('click', () => {
          picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
        });
        picker.querySelectorAll('.image-picker-item').forEach(item => {
          item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface3)'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });
          item.addEventListener('click', () => {
            imageInput.value = item.dataset.image;
            picker.style.display = 'none';
          });
        });
        // CIS hardening toggle
        const cisCheck = content.querySelector('#cc-cis-harden');
        const cisInfo = content.querySelector('#cc-cis-info');
        cisCheck.addEventListener('change', () => {
          cisInfo.style.display = cisCheck.checked ? 'block' : 'none';
          if (cisCheck.checked) {
            content.querySelector('#cc-restart').value = 'unless-stopped';
          }
        });
      },
      onSubmit: (content) => {
        const name = content.querySelector('#cc-name').value.trim();
        const image = content.querySelector('#cc-image').value.trim();
        if (!name || !image) { Toast.warning(i18n.t('pages.containers.nameImageRequired')); return false; }

        const portsText = content.querySelector('#cc-ports').value.trim();
        const portBindings = {};
        const exposedPorts = {};
        if (portsText) {
          portsText.split('\n').filter(Boolean).forEach(line => {
            const [host, container] = line.trim().split(':');
            if (host && container) {
              const key = `${container}/tcp`;
              exposedPorts[key] = {};
              portBindings[key] = [{ HostPort: host }];
            }
          });
        }

        const volText = content.querySelector('#cc-volumes').value.trim();
        const binds = volText ? volText.split('\n').filter(Boolean).map(l => l.trim()) : [];

        const envText = content.querySelector('#cc-env').value.trim();
        const env = envText ? envText.split('\n').filter(Boolean).map(l => l.trim()) : [];

        const restart = content.querySelector('#cc-restart').value;
        const network = content.querySelector('#cc-network').value.trim();
        const cmd = content.querySelector('#cc-cmd').value.trim();
        const autoStart = content.querySelector('#cc-start').checked;
        const cisHarden = content.querySelector('#cc-cis-harden').checked;

        const hostConfig = {
          PortBindings: portBindings,
          Binds: binds.length ? binds : undefined,
          RestartPolicy: restart ? { Name: restart } : undefined,
          NetworkMode: network || undefined,
        };

        // CIS Benchmark hardening
        if (cisHarden) {
          hostConfig.CapDrop = ['ALL'];
          hostConfig.SecurityOpt = ['no-new-privileges'];
          hostConfig.ReadonlyRootfs = true;
          hostConfig.Tmpfs = { '/tmp': 'rw,noexec,nosuid,size=64m', '/run': 'rw,noexec,nosuid,size=64m' };
          hostConfig.Memory = 536870912; // 512MB
          hostConfig.NanoCpus = 500000000; // 0.5 CPU
          hostConfig.RestartPolicy = { Name: 'unless-stopped' };
        }

        return {
          name,
          Image: image,
          ExposedPorts: exposedPorts,
          HostConfig: hostConfig,
          Env: env.length ? env : undefined,
          Cmd: cmd ? cmd.split(' ') : undefined,
          _autoStart: autoStart,
        };
      }
    });

    if (result) {
      const autoStart = result._autoStart;
      delete result._autoStart;
      try {
        const created = await Api.createContainer(result);
        Toast.success(i18n.t('pages.containers.containerCreated', { id: created.id?.substring(0, 12) || '' }));
        if (autoStart && created.id) {
          await Api.containerAction(created.id, 'start');
          Toast.success(i18n.t('pages.containers.containerStarted'));
        }
        await this._loadList();
      } catch (err) { Toast.error(i18n.t('pages.containers.createFailed', { message: err.message })); }
    }
  },

  // ─── Container Templates Dialog ──────────────
  async _templatesDialog() {
    try {
      const res = await Api.getTemplates();
      const templates = res.templates || res;
      const cats = { all: i18n.t('pages.containers.templatesCatAll'), web: i18n.t('pages.containers.templatesCatWeb'), database: i18n.t('pages.containers.templatesCatDb'), tool: i18n.t('pages.containers.templatesCatTool'), monitoring: i18n.t('pages.containers.templatesCatMon'), messaging: i18n.t('pages.containers.templatesCatMsg') };

      const catBtns = Object.entries(cats).map(([k, v]) =>
        `<button class="btn btn-xs ${k === 'all' ? 'btn-primary' : 'btn-secondary'}" data-cat="${k}">${v}</button>`
      ).join('');

      const templateCards = templates.map(t => `
        <div class="template-card" data-category="${t.category}" data-id="${t.id}">
          <div class="template-card-icon"><i class="fas ${t.icon}"></i></div>
          <div class="template-card-body">
            <h4>${Utils.escapeHtml(t.name)}</h4>
            <p class="text-muted text-sm">${Utils.escapeHtml(t.description)}</p>
          </div>
          <div class="template-card-actions">
            <button class="btn btn-xs btn-secondary template-view-btn" data-tid="${t.id}" title="View YAML">
              <i class="fas fa-eye"></i>
            </button>
            <button class="btn btn-xs btn-secondary template-edit-btn" data-tid="${t.id}" title="Configure">
              <i class="fas fa-sliders-h"></i>
            </button>
            <button class="btn btn-xs btn-primary template-deploy-btn" data-tid="${t.id}">
              <i class="fas fa-rocket"></i> ${i18n.t('pages.containers.templatesDeploy')}
            </button>
          </div>
        </div>
      `).join('');

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-th" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.containers.templatesTitle')}</h3>
          <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <p class="text-muted text-sm" style="margin-bottom:12px">${i18n.t('pages.containers.templatesDesc')}</p>
          <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap" id="template-cats">${catBtns}</div>
          <div class="template-grid" id="template-list">${templateCards}</div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="modal-ok">${i18n.t('common.close')}</button></div>
      `, { width: '700px' });

      Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

      // Category filter (case-insensitive partial match)
      Modal._content.querySelectorAll('[data-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          Modal._content.querySelectorAll('[data-cat]').forEach(b => b.className = 'btn btn-xs btn-secondary');
          btn.className = 'btn btn-xs btn-primary';
          const cat = btn.dataset.cat.toLowerCase();
          Modal._content.querySelectorAll('.template-card').forEach(card => {
            const cardCat = (card.dataset.category || '').toLowerCase();
            card.style.display = (cat === 'all' || cardCat.includes(cat)) ? '' : 'none';
          });
        });
      });

      // View buttons — read-only YAML preview (sub-modal over templates)
      Modal._content.querySelectorAll('.template-view-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tmpl = templates.find(t => t.id === btn.dataset.tid);
          if (!tmpl) return;
          const sub = Modal.openSub(`
            <div class="modal-header">
              <h3><i class="${tmpl.icon}" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(tmpl.name)}</h3>
              <button class="modal-close-btn" id="tpl-sub-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
              <pre class="inspect-json" style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px">${Utils.escapeHtml(tmpl.compose)}</pre>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" id="tpl-sub-copy"><i class="fas fa-copy"></i> ${i18n.t('common.copy')}</button>
              <button class="btn btn-primary" id="tpl-sub-ok">${i18n.t('common.close')}</button>
            </div>
          `, { width: '600px' });
          sub.querySelector('#tpl-sub-close').addEventListener('click', () => Modal.closeSub());
          sub.querySelector('#tpl-sub-ok').addEventListener('click', () => Modal.closeSub());
          sub.querySelector('#tpl-sub-copy').addEventListener('click', () => {
            Utils.copyToClipboard(tmpl.compose).then(() => Toast.success(i18n.t('common.copied')));
          });
        });
      });

      // Edit buttons — open dynamic configurator (closes templates, reopens on cancel)
      Modal._content.querySelectorAll('.template-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tmpl = templates.find(t => t.id === btn.dataset.tid);
          if (!tmpl) return;
          Modal.close();
          setTimeout(() => {
            TemplateConfigurator.open(tmpl, {
              mode: 'deploy',
              onDeploy: async ({ name, compose }) => {
                try {
                  Toast.info(`Deploying ${tmpl.name}...`);
                  await Api.post(`/templates/${tmpl.id}/deploy`, { name, compose });
                  Toast.success(i18n.t('pages.containers.templatesDeplyed', { name: tmpl.name }));
                  await this._loadList();
                } catch (err) {
                  Toast.error(i18n.t('pages.containers.templatesDeployFailed', { message: err.message }));
                }
              },
              onCancel: () => {
                // Re-open templates dialog when configurator is cancelled
                setTimeout(() => this._templatesDialog(), 250);
              },
            });
          }, 250);
        });
      });

      // Deploy buttons — deploy directly with defaults
      Modal._content.querySelectorAll('.template-deploy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const tmpl = templates.find(t => t.id === btn.dataset.tid);
          if (!tmpl) return;
          Modal.close();
          this._deployTemplate(tmpl);
        });
      });
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _deployTemplate(tmpl) {
    // Wait for modal close animation
    await new Promise(r => setTimeout(r, 250));

    const nameResult = await Modal.form(`
      <div class="form-group">
        <label>${i18n.t('pages.containers.containerName')}</label>
        <input type="text" id="tmpl-name" class="form-control" value="${tmpl.id}" required>
        <small class="text-muted">${i18n.t('pages.containers.templatesNameHint')}</small>
      </div>
    `, {
      title: `${i18n.t('pages.containers.templatesDeploy')}: ${tmpl.name}`,
      width: '400px',
      onSubmit: (content) => {
        const name = content.querySelector('#tmpl-name').value.trim();
        if (!name) return false;
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          Toast.error('Name must contain only letters, numbers, dashes, underscores');
          return false;
        }
        return name;
      },
    });

    if (nameResult) {
      try {
        Toast.info(`Deploying ${tmpl.name}...`);
        await Api.post(`/templates/${tmpl.id}/deploy`, { name: nameResult });
        Toast.success(i18n.t('pages.containers.templatesDeplyed', { name: tmpl.name }));
        await this._loadList();
      } catch (err) {
        Toast.error(i18n.t('pages.containers.templatesDeployFailed', { message: err.message }));
      }
    }
  },

  // ─── Health Check Logs Viewer ──────────────────
  async _viewHealthLogs(containerId, containerName) {
    try {
      const data = await Api.getHealthLogs(containerId);

      if (data.message || !data.logs || data.logs.length === 0) {
        Modal.open(`
          <div class="modal-header">
            <h3><i class="fas fa-heartbeat" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.containers.healthCheckTitle')} — ${Utils.escapeHtml(containerName)}</h3>
            <button class="modal-close-btn" id="hlogs-empty-close-x"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body"><div class="empty-msg"><i class="fas fa-info-circle"></i> ${i18n.t('pages.containers.noHealthCheck')}</div></div>
          <div class="modal-footer"><button class="btn btn-primary" id="hlogs-empty-close-btn">${i18n.t('common.close')}</button></div>
        `, { width: '500px' });
        Modal._content.querySelector('#hlogs-empty-close-x').addEventListener('click', () => Modal.close());
        Modal._content.querySelector('#hlogs-empty-close-btn').addEventListener('click', () => Modal.close());
        return;
      }

      const statusColor = { healthy: 'var(--green)', unhealthy: 'var(--red)', starting: 'var(--yellow)' };
      const rows = data.logs.map(l => `
        <tr>
          <td class="text-sm">${Utils.timeAgo(l.start)}</td>
          <td><span class="badge ${l.exitCode === 0 ? 'badge-running' : 'badge-stopped'}">${l.exitCode}</span></td>
          <td class="mono text-xs" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escapeHtml(l.output)}">${Utils.escapeHtml(l.output || '—')}</td>
        </tr>
      `).join('');

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-heartbeat" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.containers.healthCheckTitle')} — ${Utils.escapeHtml(containerName)}</h3>
          <button class="modal-close-btn" id="hlogs-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:16px;margin-bottom:16px">
            <div style="padding:8px 16px;border-radius:var(--radius-sm);background:var(--surface3)">
              <span class="text-sm text-muted">${i18n.t('pages.containers.healthStatus')}:</span>
              <strong style="color:${statusColor[data.status] || 'var(--text)'}">${data.status}</strong>
            </div>
            <div style="padding:8px 16px;border-radius:var(--radius-sm);background:var(--surface3)">
              <span class="text-sm text-muted">${i18n.t('pages.containers.healthFailStreak')}:</span>
              <strong style="${data.failingStreak > 0 ? 'color:var(--red)' : ''}">${data.failingStreak}</strong>
            </div>
          </div>
          <div style="max-height:350px;overflow-y:auto">
            <table class="data-table compact">
              <thead><tr><th>${i18n.t('pages.containers.healthLogTime')}</th><th>${i18n.t('pages.containers.healthLogExit')}</th><th>${i18n.t('pages.containers.healthLogOutput')}</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="hlogs-close-btn">${i18n.t('common.close')}</button></div>
      `, { width: '700px' });
      Modal._content.querySelector('#hlogs-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#hlogs-close-btn').addEventListener('click', () => Modal.close());
    } catch (err) {
      Toast.error(err.message);
    }
  },

  _showActionsGuide() {
    // Build overlay
    const overlay = document.createElement('div');
    overlay.id = 'actions-guide-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10000;
      background:rgba(0,0,0,.65);backdrop-filter:blur(3px);
      display:flex;align-items:center;justify-content:center;padding:16px;
    `;

    overlay.innerHTML = `
      <div style="
        background:var(--surface);border:1px solid var(--border);border-radius:var(--radius,8px);
        max-width:960px;width:100%;max-height:90vh;display:flex;flex-direction:column;
        box-shadow:0 24px 64px rgba(0,0,0,.4);overflow:hidden;
      ">
        <!-- Header -->
        <div style="display:flex;align-items:center;gap:12px;padding:18px 24px;border-bottom:1px solid var(--border);flex-shrink:0">
          <div style="width:36px;height:36px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-map" style="color:#fff;font-size:15px"></i>
          </div>
          <div>
            <div style="font-weight:700;font-size:16px">Actions Guide</div>
            <div style="font-size:12px;color:var(--text-dim)">Every button, every action — explained</div>
          </div>
          <button id="guide-close" style="margin-left:auto;background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:4px;line-height:1" title="Close">&times;</button>
        </div>

        <!-- Body — 2 columns -->
        <div style="overflow-y:auto;padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:16px">

          <!-- ── STACK ACTIONS ── -->
          <div style="grid-column:1/-1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <i class="fas fa-layer-group" style="color:var(--accent);font-size:14px"></i>
              <span style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">Stack-level actions</span>
              <div style="flex:1;height:1px;background:var(--border);margin-left:4px"></div>
            </div>
          </div>

          ${[
            { icon:'fa-play', color:'var(--green)', label:'Start all', desc:'Starts all stopped containers in the stack simultaneously. Only visible when at least one container is stopped.' },
            { icon:'fa-redo', color:'var(--yellow)', label:'Restart all', desc:'Restarts every running container in the stack. Useful after a config change that doesn\'t require a full redeploy.' },
            { icon:'fa-stop', color:'var(--red)', label:'Stop all', desc:'Stops all running containers in the stack gracefully (SIGTERM → SIGKILL after timeout). Only visible when containers are running.' },
            { icon:'fa-cloud-download-alt', color:'var(--accent)', label:'Pull latest images', desc:'Runs <code>docker compose pull</code> for the stack — fetches updated images from the registry without recreating containers.' },
            { icon:'fa-arrow-circle-up', color:'var(--accent)', label:'Up (redeploy)', desc:'Runs <code>docker compose up -d</code> — recreates containers that have changed image or config. Running containers with no changes are left untouched.' },
            { icon:'fa-file-code', color:'var(--accent)', label:'View / Edit compose', desc:'Opens the docker-compose.yml for this stack. If no file is found on disk, a best-effort YAML is generated from container metadata. You can edit and save directly from the modal.' },
            { icon:'fa-search-plus', color:'var(--yellow)', label:'Security scan', desc:'Scans all unique images in the stack for known CVEs using the auto-detected scanner (Trivy → Grype → Docker Scout). Results show Critical / High / Medium / Low counts per image.' },
            { icon:'fa-clipboard-check', color:'var(--green)', label:'CIS Benchmark', desc:'Runs the CIS Docker Benchmark v1.6 and filters results to containers in this stack. Shows a stack security score, per-container findings, and a "Hardened compose" generator for failing containers.' },
          ].map(a => `
            <div style="display:flex;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas ${a.icon}" style="color:${a.color};font-size:14px"></i>
              </div>
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px">${a.label}</div>
                <div style="font-size:12px;color:var(--text-dim);line-height:1.5">${a.desc}</div>
              </div>
            </div>
          `).join('')}

          <!-- ── CONTAINER ACTIONS ── -->
          <div style="grid-column:1/-1;margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <i class="fas fa-cube" style="color:var(--accent);font-size:14px"></i>
              <span style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">Container-level actions</span>
              <div style="flex:1;height:1px;background:var(--border);margin-left:4px"></div>
            </div>
          </div>

          ${[
            { icon:'fa-play', color:'var(--green)', label:'Start', desc:'Starts a stopped container. The container retains its configuration — volumes, ports, environment — from when it was created.' },
            { icon:'fa-stop', color:'var(--red)', label:'Stop', desc:'Sends SIGTERM to the main process, then SIGKILL after the stop timeout (default 10 s). Data on volumes is preserved.' },
            { icon:'fa-redo', color:'var(--yellow)', label:'Restart', desc:'Equivalent to stop + start in sequence. Useful for applying env changes or recovering from a crash without losing state.' },
            { icon:'fa-terminal', color:'var(--accent)', label:'Exec / Terminal', desc:'Opens an interactive terminal inside the running container. Defaults to <code>sh</code>. Useful for debugging, inspecting logs, or running one-off commands.' },
            { icon:'fa-scroll', color:'var(--accent)', label:'Logs', desc:'Streams the container\'s stdout/stderr in real time. You can tail a fixed number of lines, search output, or download the full log as a text file.' },
            { icon:'fa-chart-bar', color:'var(--accent)', label:'Stats', desc:'Shows live CPU %, memory usage, network I/O, and block I/O for the container. Refreshes every 2 seconds via WebSocket.' },
            { icon:'fa-edit', color:'var(--accent)', label:'Edit / Rename', desc:'Opens the container detail view where you can rename the container, change environment variables, update port mappings, and set resource limits (CPU / memory).' },
            { icon:'fa-trash', color:'var(--red)', label:'Remove', desc:'Removes the container permanently. Running containers must be stopped first (or force-remove is used). Volumes attached to the container are <strong>not</strong> deleted.' },
            { icon:'fa-clone', color:'var(--accent)', label:'Duplicate', desc:'Creates a new container with the same image, environment, port mappings, and volume configuration as the selected container.' },
            { icon:'fa-tag', color:'var(--accent)', label:'Commit / Tag', desc:'Commits the container\'s current filesystem state as a new image and optionally tags it. Useful for saving a manually configured state.' },
          ].map(a => `
            <div style="display:flex;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas ${a.icon}" style="color:${a.color};font-size:14px"></i>
              </div>
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px">${a.label}</div>
                <div style="font-size:12px;color:var(--text-dim);line-height:1.5">${a.desc}</div>
              </div>
            </div>
          `).join('')}

          <!-- ── STATUS INDICATORS ── -->
          <div style="grid-column:1/-1;margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <i class="fas fa-circle" style="color:var(--accent);font-size:14px"></i>
              <span style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">Status indicators</span>
              <div style="flex:1;height:1px;background:var(--border);margin-left:4px"></div>
            </div>
          </div>

          ${[
            { dot:'var(--green)', label:'Running', desc:'Container is active and its main process is alive.' },
            { dot:'var(--red)', label:'Exited / Stopped', desc:'Container has stopped — either intentionally or due to a crash. Check logs for exit code.' },
            { dot:'var(--yellow)', label:'Restarting / Paused', desc:'Container is in a transient state: restarting after a crash, paused via <code>docker pause</code>, or being created.' },
            { dot:'#6b7280', label:'Needs attention', desc:'Container has restarted multiple times recently — likely a crash-loop. Check logs immediately.' },
          ].map(a => `
            <div style="display:flex;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas fa-circle" style="color:${a.dot};font-size:14px"></i>
              </div>
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px">${a.label}</div>
                <div style="font-size:12px;color:var(--text-dim);line-height:1.5">${a.desc}</div>
              </div>
            </div>
          `).join('')}

        </div><!-- /grid -->

        <!-- Footer -->
        <div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;flex-shrink:0">
          <button id="guide-close-footer" class="btn btn-secondary">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#guide-close').addEventListener('click', close);
    overlay.querySelector('#guide-close-footer').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.containers.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.containers.help.intro')}</p>

        <h4><i class="fas fa-layer-group"></i> ${i18n.t('pages.containers.help.stacksTitle')}</h4>
        <p>${i18n.t('pages.containers.help.stacksBody')}</p>

        <h4><i class="fas fa-play"></i> ${i18n.t('pages.containers.help.startStopTitle')}</h4>
        <p>${i18n.t('pages.containers.help.startStopBody')}</p>

        <h4><i class="fas fa-redo"></i> ${i18n.t('pages.containers.help.restartPolicyTitle')}</h4>
        <p>${i18n.t('pages.containers.help.restartPolicyBody')}</p>

        <h4><i class="fas fa-terminal"></i> ${i18n.t('pages.containers.help.terminalTitle')}</h4>
        <p>${i18n.t('pages.containers.help.terminalBody')}</p>

        <h4><i class="fas fa-plug"></i> ${i18n.t('pages.containers.help.portsTitle')}</h4>
        <p>${i18n.t('pages.containers.help.portsBody')}</p>

        <h4><i class="fas fa-sign-out-alt"></i> ${i18n.t('pages.containers.help.exitCodesTitle')}</h4>
        <p>${i18n.t('pages.containers.help.exitCodesBody')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.containers.help.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '640px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  // ─── Files Tab ──────────────────────────────────
  _filesPath: '/',

  async _renderFilesTab(el) {
    this._filesPath = '/';
    el.innerHTML = `
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h3><i class="fas fa-folder-open" style="margin-right:8px"></i>File Browser</h3>
          <button class="btn btn-sm btn-primary" id="file-upload-btn"><i class="fas fa-upload" style="margin-right:4px"></i>Upload</button>
        </div>
        <div class="card-body">
          <div id="files-breadcrumb" class="files-breadcrumb" style="margin-bottom:12px"></div>
          <div id="files-list"></div>
        </div>
      </div>
      <div id="file-preview-panel" style="display:none" class="card mt-md">
        <div class="card-header">
          <h3 id="file-preview-name"><i class="fas fa-file" style="margin-right:8px"></i>File Preview</h3>
          <button class="btn btn-sm btn-secondary" id="file-preview-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="card-body"><pre id="file-preview-content" class="inspect-json" style="max-height:500px;overflow:auto;white-space:pre-wrap;word-break:break-all"></pre></div>
      </div>
    `;
    el.querySelector('#file-preview-close')?.addEventListener('click', () => {
      el.querySelector('#file-preview-panel').style.display = 'none';
    });

    // Upload button
    el.querySelector('#file-upload-btn')?.addEventListener('click', () => {
      this._showUploadModal(el);
    });

    await this._loadFiles(el);
  },

  _showUploadModal(filesEl) {
    const currentDir = this._filesPath || '/';
    Modal.open(`
      <h3 style="margin-bottom:16px"><i class="fas fa-upload" style="margin-right:8px"></i>Upload File to Container</h3>
      <div style="margin-bottom:12px">
        <label class="text-sm text-muted" style="display:block;margin-bottom:4px">Destination Directory</label>
        <input type="text" id="upload-dest-path" class="form-control" value="${Utils.escapeHtml(currentDir)}" placeholder="/">
      </div>
      <div style="margin-bottom:16px">
        <label class="text-sm text-muted" style="display:block;margin-bottom:4px">Select File (max 50MB)</label>
        <input type="file" id="upload-file-input" class="form-control">
      </div>
      <div id="upload-progress" style="display:none;margin-bottom:12px">
        <div style="background:var(--surface2);border-radius:var(--radius-sm);overflow:hidden;height:6px">
          <div id="upload-progress-bar" style="width:0%;height:100%;background:var(--accent);transition:width 0.3s"></div>
        </div>
        <span class="text-sm text-muted" id="upload-status">Uploading...</span>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-sm btn-secondary" id="upload-cancel">Cancel</button>
        <button class="btn btn-sm btn-primary" id="upload-submit"><i class="fas fa-upload" style="margin-right:4px"></i>Upload</button>
      </div>
    `);

    Modal._content.querySelector('#upload-cancel').addEventListener('click', () => Modal.close());

    Modal._content.querySelector('#upload-submit').addEventListener('click', async () => {
      const destPath = Modal._content.querySelector('#upload-dest-path').value.trim();
      const fileInput = Modal._content.querySelector('#upload-file-input');
      const file = fileInput.files[0];

      if (!file) { Toast.error('Please select a file'); return; }
      if (!destPath || !destPath.startsWith('/')) { Toast.error('Destination must start with /'); return; }
      if (destPath.includes('..')) { Toast.error('Path must not contain ..'); return; }
      if (file.size > 50 * 1024 * 1024) { Toast.error('File exceeds 50MB limit'); return; }

      const progressEl = Modal._content.querySelector('#upload-progress');
      const progressBar = Modal._content.querySelector('#upload-progress-bar');
      const statusEl = Modal._content.querySelector('#upload-status');
      const submitBtn = Modal._content.querySelector('#upload-submit');

      progressEl.style.display = '';
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>Uploading...';
      statusEl.textContent = 'Reading file...';
      progressBar.style.width = '30%';

      try {
        // Read file as base64
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });

        statusEl.textContent = 'Uploading to container...';
        progressBar.style.width = '60%';

        await Api.uploadFile(this._detailId, destPath, file.name, base64);

        progressBar.style.width = '100%';
        statusEl.textContent = 'Done!';
        Toast.success(`Uploaded ${file.name} to ${destPath}`);

        setTimeout(() => {
          Modal.close();
          this._loadFiles(filesEl);
        }, 500);
      } catch (err) {
        Toast.error('Upload failed: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-upload" style="margin-right:4px"></i>Upload';
        progressEl.style.display = 'none';
      }
    });
  },

  async _loadFiles(el) {
    const listEl = el.querySelector('#files-list');
    const breadcrumbEl = el.querySelector('#files-breadcrumb');
    if (!listEl) return;

    listEl.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    // Render breadcrumb
    const parts = this._filesPath.split('/').filter(Boolean);
    let breadcrumb = `<a href="#" class="files-crumb" data-path="/">/</a>`;
    let cumPath = '';
    for (const p of parts) {
      cumPath += '/' + p;
      breadcrumb += ` <span class="text-muted">/</span> <a href="#" class="files-crumb" data-path="${Utils.escapeHtml(cumPath)}">${Utils.escapeHtml(p)}</a>`;
    }
    breadcrumbEl.innerHTML = breadcrumb;
    breadcrumbEl.querySelectorAll('.files-crumb').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this._filesPath = a.dataset.path;
        this._loadFiles(el);
      });
    });

    try {
      const data = await Api.getContainerFiles(this._detailId, this._filesPath);
      const entries = data.entries || [];

      if (entries.length === 0) {
        listEl.innerHTML = '<div class="text-muted text-sm">Empty directory</div>';
        return;
      }

      // Sort: directories first, then files
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      listEl.innerHTML = `
        ${this._filesPath !== '/' ? `<div class="file-entry file-dir" data-path="${Utils.escapeHtml(this._filesPath.replace(/\/[^/]+\/?$/, '') || '/')}">
          <span class="file-icon"><i class="fas fa-level-up-alt"></i></span>
          <span class="file-name">..</span>
          <span class="file-size"></span><span class="file-modified"></span><span class="file-actions"></span>
        </div>` : ''}
        ${entries.map(e => {
          const icon = e.type === 'directory' ? 'fa-folder' : e.type === 'symlink' ? 'fa-link' : 'fa-file';
          const iconColor = e.type === 'directory' ? 'color:var(--accent)' : e.type === 'symlink' ? 'color:var(--purple)' : '';
          const fullPath = (this._filesPath === '/' ? '/' : this._filesPath + '/') + e.name;
          return `<div class="file-entry ${e.type === 'directory' ? 'file-dir' : 'file-file'}" data-path="${Utils.escapeHtml(fullPath)}" data-type="${e.type}">
            <span class="file-icon"><i class="fas ${icon}" style="${iconColor}"></i></span>
            <span class="file-name">${Utils.escapeHtml(e.name)}</span>
            <span class="file-size text-muted text-sm">${e.type !== 'directory' ? Utils.formatBytes(e.size) : ''}</span>
            <span class="file-modified text-muted text-sm">${e.modified || ''}</span>
            <span class="file-actions">${e.type !== 'directory' ? `<a href="${Api.getFileDownloadUrl(this._detailId, fullPath)}" class="action-btn" title="Download" data-stop-propagation><i class="fas fa-download"></i></a>` : ''}</span>
          </div>`;
        }).join('')}
      `;

      // Stop propagation for download links
      listEl.querySelectorAll('[data-stop-propagation]').forEach(node => {
        node.addEventListener('click', (e) => e.stopPropagation());
      });

      listEl.querySelectorAll('.file-entry').forEach(row => {
        row.addEventListener('click', async () => {
          const path = row.dataset.path;
          const type = row.dataset.type;
          if (type === 'directory' || row.classList.contains('file-dir')) {
            this._filesPath = path;
            this._loadFiles(el);
          } else {
            // Preview file
            try {
              const panel = el.querySelector('#file-preview-panel');
              const nameEl = el.querySelector('#file-preview-name');
              const contentEl = el.querySelector('#file-preview-content');
              nameEl.innerHTML = `<i class="fas fa-file" style="margin-right:8px"></i>${Utils.escapeHtml(path)}`;
              contentEl.textContent = 'Loading...';
              panel.style.display = '';
              const data = await Api.getFileContent(this._detailId, path);
              contentEl.textContent = data.content || '(empty)';
              if (data.truncated) contentEl.textContent += '\n\n--- Truncated (file too large) ---';
            } catch (err) {
              el.querySelector('#file-preview-content').textContent = 'Error: ' + err.message;
            }
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="text-muted">Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // ─── Changes (Diff) Tab ────────────────────────
  async _renderChangesTab(el) {
    el.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading container changes...</div>';
    try {
      const data = await Api.getContainerDiff(this._detailId);
      const { changes, summary } = data;

      if (!changes || changes.length === 0) {
        el.innerHTML = `<div class="card"><div class="card-body"><div class="empty-msg"><i class="fas fa-check-circle" style="color:var(--green)"></i><p>No filesystem changes detected compared to image.</p></div></div></div>`;
        return;
      }

      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-exchange-alt" style="margin-right:8px"></i>Filesystem Changes</h3>
            <span class="text-sm text-muted">${summary.total} total</span>
          </div>
          <div class="card-body">
            <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
              <span class="badge" style="background:var(--yellow-dim);color:var(--yellow)"><i class="fas fa-pen"></i> ${summary.modified} Modified</span>
              <span class="badge" style="background:var(--green-dim);color:var(--green)"><i class="fas fa-plus"></i> ${summary.added} Added</span>
              <span class="badge" style="background:var(--red-dim);color:var(--red)"><i class="fas fa-minus"></i> ${summary.deleted} Deleted</span>
            </div>
            <div class="diff-filter" style="margin-bottom:12px">
              <button class="btn btn-sm btn-secondary diff-filter-btn active" data-filter="all">All</button>
              <button class="btn btn-sm btn-secondary diff-filter-btn" data-filter="0">Modified</button>
              <button class="btn btn-sm btn-secondary diff-filter-btn" data-filter="1">Added</button>
              <button class="btn btn-sm btn-secondary diff-filter-btn" data-filter="2">Deleted</button>
            </div>
            <div id="diff-entries" style="max-height:500px;overflow-y:auto">
              ${changes.map(c => {
                const color = c.kind === 0 ? 'var(--yellow)' : c.kind === 1 ? 'var(--green)' : 'var(--red)';
                const icon = c.kind === 0 ? 'fa-pen' : c.kind === 1 ? 'fa-plus' : 'fa-minus';
                return `<div class="diff-entry" data-kind="${c.kind}" style="padding:4px 8px;border-left:3px solid ${color};margin-bottom:2px;background:var(--surface2);border-radius:0 var(--radius-xs) var(--radius-xs) 0">
                  <i class="fas ${icon}" style="color:${color};width:16px;margin-right:8px;font-size:11px"></i>
                  <span class="mono text-sm">${Utils.escapeHtml(c.path)}</span>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>
      `;

      el.querySelectorAll('.diff-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          el.querySelectorAll('.diff-filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const filter = btn.dataset.filter;
          el.querySelectorAll('.diff-entry').forEach(e => {
            e.style.display = (filter === 'all' || e.dataset.kind === filter) ? '' : 'none';
          });
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="card"><div class="card-body"><div class="empty-msg">Error: ${Utils.escapeHtml(err.message)}</div></div></div>`;
    }
  },

  // ─── Rollback Dialog ───────────────────────────
  async _rollbackDialog(containerId, containerName) {
    try {
      const data = await Api.getContainerHistory(containerId);
      const entries = data.entries || [];

      if (entries.length === 0) {
        Toast.info('No version history available for this container. History is recorded when updates are performed.');
        return;
      }

      const rows = entries.map(e => {
        const date = e.deployed_at ? Utils.formatDate(e.deployed_at) : '—';
        const shortId = (e.image_id || '').substring(0, 19);
        const isCurrent = e.image_id === data.currentImageId;
        return `<tr${isCurrent ? ' style="opacity:0.5"' : ''}>
          <td class="mono text-sm">${Utils.escapeHtml(e.image_name)}</td>
          <td class="mono text-sm" title="${Utils.escapeHtml(e.image_id)}">${shortId}</td>
          <td class="text-sm">${date}</td>
          <td><span class="badge badge-info">${e.action}</span></td>
          <td class="text-sm">${e.deployed_by || '—'}</td>
          <td>${isCurrent
            ? '<span class="badge badge-running">Current</span>'
            : e.imageAvailable
              ? `<button class="btn btn-sm btn-warning rollback-btn" data-history-id="${e.id}"><i class="fas fa-undo"></i> Rollback</button>`
              : '<span class="text-muted text-sm">Image pruned</span>'
          }</td>
        </tr>`;
      }).join('');

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-history" style="color:var(--accent);margin-right:8px"></i>Version History — ${Utils.escapeHtml(containerName)}</h3>
          <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="text-sm text-muted" style="margin-bottom:12px">Current image: <span class="mono">${Utils.escapeHtml(data.currentImage)}</span></div>
          <table class="data-table compact">
            <thead><tr><th>Image</th><th>ID</th><th>Date</th><th>Action</th><th>By</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-ok">Close</button>
        </div>
      `, { width: '800px' });

      Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

      Modal._content.querySelectorAll('.rollback-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const historyId = btn.dataset.historyId;
          const ok = await Modal.confirm(`Rollback "${containerName}" to a previous image version? The container will be recreated.`, { danger: true, confirmText: 'Rollback' });
          if (!ok) return;
          try {
            Toast.info('Rolling back...');
            const result = await Api.rollbackContainer(containerId, parseInt(historyId));
            Toast.success(`Rolled back to ${result.rolledBackTo || 'previous version'}`);
            Modal.close();
            await this._loadDetail();
          } catch (err) {
            Toast.error('Rollback failed: ' + err.message);
          }
        });
      });
    } catch (err) {
      Toast.error('Failed to load history: ' + err.message);
    }
  },

  // ─── Container Groups ───────────────────────────
  _userGroups: [],

  async _renderUserGroups() {
    const section = document.getElementById('container-groups-section');
    if (!section || !this._userGroups.length) {
      if (section) section.innerHTML = '';
      return;
    }

    const containers = this._containers || [];
    const containerMap = {};
    containers.forEach(c => { containerMap[c.id] = c; });

    const groupsHtml = [];
    for (const g of this._userGroups) {
      let groupDetail;
      try { groupDetail = await Api.getGroup(g.id); } catch { continue; }
      const members = (groupDetail.members || []).map(cid => containerMap[cid]).filter(Boolean);
      const running = members.filter(c => c.state === 'running').length;
      const collapsed = this._collapsed[`group_${g.id}`] || false;

      groupsHtml.push(`
        <div class="stack-group ${collapsed ? 'collapsed' : ''}" style="margin-bottom:8px">
          <div class="stack-header" data-stack="group_${g.id}" style="border-left:3px solid ${g.color || 'var(--accent)'}">
            <div class="stack-header-left">
              <i class="fas fa-chevron-down stack-chevron"></i>
              <i class="${g.icon || 'fas fa-folder'}" style="color:${g.color || 'var(--accent)'}"></i>
              <span class="stack-name">${Utils.escapeHtml(g.name)}</span>
              <span class="stack-count">${members.length}</span>
            </div>
            <div class="stack-header-right">
              <span class="stack-status ${running === members.length && members.length > 0 ? 'all-running' : ''}">
                <i class="fas fa-circle"></i> ${running}/${members.length}
              </span>
              <div class="stack-actions" data-stop-propagation>
                <button class="action-btn group-edit-btn" data-group-id="${g.id}" title="Edit group"><i class="fas fa-edit"></i></button>
                <button class="action-btn group-add-btn" data-group-id="${g.id}" title="Add containers"><i class="fas fa-plus"></i></button>
              </div>
            </div>
          </div>
          <div class="stack-body">
            ${members.length === 0 ? '<div class="text-muted text-sm" style="padding:12px 16px">No containers in this group. Click + to add.</div>' : `
            <table class="data-table containers-table">
              <thead><tr><th>Container</th><th>Image</th><th>State</th><th style="width:60px"></th></tr></thead>
              <tbody>
                ${members.map(c => `
                  <tr style="cursor:pointer" data-nav-container="${c.id}">
                    <td>${Utils.escapeHtml(c.name)}</td>
                    <td class="text-muted text-sm" style="font-family:var(--mono)">${Utils.escapeHtml(c.image)}</td>
                    <td><span class="badge ${c.state === 'running' ? 'badge-success' : 'badge-danger'}">${c.state}</span></td>
                    <td data-stop-propagation>
                      <button class="action-btn group-remove-member" data-group-id="${g.id}" data-container-id="${c.id}" title="Remove from group"><i class="fas fa-times"></i></button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`}
          </div>
        </div>
      `);
    }

    section.innerHTML = groupsHtml.join('');

    section.querySelectorAll('.stack-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn, button')) return;
        const stack = header.dataset.stack;
        this._collapsed[stack] = !this._collapsed[stack];
        header.closest('.stack-group').classList.toggle('collapsed');
      });
    });

    // Wire up container navigation and stop-propagation in groups
    section.querySelectorAll('[data-nav-container]').forEach(row => {
      row.addEventListener('click', () => { App.navigate('/containers/' + row.dataset.navContainer); });
    });
    section.querySelectorAll('[data-stop-propagation]').forEach(node => {
      node.addEventListener('click', (e) => e.stopPropagation());
    });

    section.querySelectorAll('.group-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => this._editGroupDialog(parseInt(btn.dataset.groupId)));
    });

    section.querySelectorAll('.group-add-btn').forEach(btn => {
      btn.addEventListener('click', () => this._addToGroupDialog(parseInt(btn.dataset.groupId)));
    });

    section.querySelectorAll('.group-remove-member').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await Api.removeContainerFromGroup(parseInt(btn.dataset.groupId), btn.dataset.containerId);
          Toast.success('Container removed from group');
          this._loadList();
        } catch (err) { Toast.error(err.message); }
      });
    });
  },

  async _manageGroupsDialog() {
    const groups = await Api.getGroups().catch(() => []);

    const html = `
      <div class="modal-header">
        <h3 style="margin:0"><i class="fas fa-folder" style="margin-right:8px;color:var(--accent)"></i>Container Groups</h3>
        <button class="modal-close-btn" id="grp-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:12px">
          <div style="display:flex;gap:8px">
            <input type="text" id="grp-new-name" class="form-control" placeholder="New group name" style="flex:1">
            <input type="color" id="grp-new-color" value="#388bfd" style="width:40px;height:36px;padding:2px;border:1px solid var(--border);border-radius:var(--radius)">
            <button class="btn btn-primary btn-sm" id="grp-create"><i class="fas fa-plus"></i> Create</button>
          </div>
        </div>
        <div id="grp-list">
          ${groups.length === 0 ? '<div class="text-muted text-sm">No groups created yet.</div>' : groups.map(g => `
            <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--surface2);border-radius:var(--radius);margin-bottom:6px;border-left:3px solid ${g.color || 'var(--accent)'}">
              <i class="${g.icon || 'fas fa-folder'}" style="color:${g.color || 'var(--accent)'}"></i>
              <span style="flex:1">${Utils.escapeHtml(g.name)}</span>
              <span class="text-muted text-sm">${g.member_count || 0} containers</span>
              <button class="action-btn grp-del" data-id="${g.id}" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    Modal.open(html, { width: '480px' });
    Modal._content.querySelector('#grp-close').addEventListener('click', () => Modal.close());

    Modal._content.querySelector('#grp-create').addEventListener('click', async () => {
      const name = Modal._content.querySelector('#grp-new-name').value.trim();
      const color = Modal._content.querySelector('#grp-new-color').value;
      if (!name) return;
      try {
        await Api.createGroup({ name, color });
        Toast.success('Group created');
        Modal.close();
        this._loadList();
      } catch (err) { Toast.error(err.message); }
    });

    Modal._content.querySelectorAll('.grp-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await Modal.confirm('Delete this group?', { danger: true });
        if (!ok) return;
        try {
          await Api.deleteGroup(parseInt(btn.dataset.id));
          Toast.success('Group deleted');
          this._loadList();
          this._manageGroupsDialog();
        } catch (err) { Toast.error(err.message); }
      });
    });
  },

  async _editGroupDialog(groupId) {
    const group = await Api.getGroup(groupId).catch(() => null);
    if (!group) return Toast.error('Group not found');

    const result = await Modal.form(`
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="grp-edit-name" class="form-control" value="${Utils.escapeHtml(group.name)}">
      </div>
      <div class="form-group">
        <label>Color</label>
        <input type="color" id="grp-edit-color" value="${group.color || '#388bfd'}" style="width:60px;height:36px;padding:2px;border:1px solid var(--border);border-radius:var(--radius)">
      </div>
    `, {
      title: 'Edit Group',
      width: '400px',
      onSubmit: (el) => ({
        name: el.querySelector('#grp-edit-name').value.trim(),
        color: el.querySelector('#grp-edit-color').value,
      }),
    });

    if (result && result.name) {
      try {
        await Api.updateGroup(groupId, result);
        Toast.success('Group updated');
        this._loadList();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _addToGroupDialog(groupId) {
    const containers = this._containers || [];
    const group = await Api.getGroup(groupId).catch(() => null);
    if (!group) return;
    const existingMembers = new Set(group.members || []);
    const available = containers.filter(c => !existingMembers.has(c.id));

    const html = `
      <div class="modal-header">
        <h3 style="margin:0"><i class="fas fa-plus" style="margin-right:8px;color:var(--accent)"></i>Add to "${Utils.escapeHtml(group.name)}"</h3>
        <button class="modal-close-btn" id="atg-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <input type="text" id="atg-search" class="form-control" placeholder="Search containers..." style="margin-bottom:12px">
        <div id="atg-list" style="max-height:400px;overflow-y:auto">
          ${available.length === 0 ? '<div class="text-muted text-sm">All containers are already in this group.</div>' :
            available.map(c => `
              <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:var(--radius)" class="atg-item">
                <input type="checkbox" class="atg-cb" value="${c.id}">
                <span class="badge ${c.state === 'running' ? 'badge-success' : 'badge-danger'}" style="font-size:10px">${c.state}</span>
                <span>${Utils.escapeHtml(c.name)}</span>
              </label>
            `).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="atg-cancel">${i18n.t('common.cancel')}</button>
        <button class="btn btn-primary" id="atg-add"><i class="fas fa-plus"></i> Add selected</button>
      </div>
    `;

    Modal.open(html, { width: '480px' });
    Modal._content.querySelector('#atg-close').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#atg-cancel').addEventListener('click', () => Modal.close());

    Modal._content.querySelector('#atg-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      Modal._content.querySelectorAll('.atg-item').forEach(item => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    Modal._content.querySelector('#atg-add').addEventListener('click', async () => {
      const selected = [...Modal._content.querySelectorAll('.atg-cb:checked')].map(cb => cb.value);
      if (selected.length === 0) return;
      try {
        await Api.addContainersToGroup(groupId, selected);
        Toast.success(`${selected.length} container(s) added to group`);
        Modal.close();
        this._loadList();
      } catch (err) { Toast.error(err.message); }
    });
  },

  _sandboxDialog(prefillImage = '') {
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-flask" style="margin-right:8px;color:var(--yellow)"></i>Launch Sandbox Container</h3>
        <button class="modal-close-btn" id="sb-close-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-sm text-muted" style="margin-bottom:16px">Sandbox containers run with resource limits, network isolation, and auto-cleanup. Perfect for testing images risk-free.</p>

        <!-- Project Source -->
        <div class="form-group" style="margin-bottom:14px">
          <label style="margin-bottom:8px;display:block">Project Source</label>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <label class="toggle-label"><input type="radio" name="sb-source" value="none" checked> <strong>None</strong> <span class="text-muted text-sm">— empty container</span></label>
            <label class="toggle-label"><input type="radio" name="sb-source" value="github"> <i class="fab fa-github" style="margin-right:4px"></i><strong>GitHub Repository</strong></label>
            <label class="toggle-label"><input type="radio" name="sb-source" value="upload"> <i class="fas fa-upload" style="margin-right:4px"></i><strong>Upload Archive</strong></label>
          </div>
        </div>

        <!-- GitHub fields -->
        <div id="sb-github-fields" style="display:none;margin-bottom:14px;padding:12px;background:var(--surface2);border-radius:var(--radius)">
          <div class="form-row">
            <div class="form-group" style="flex:3">
              <label>Repository URL</label>
              <input id="sb-github-url" type="text" class="form-control" placeholder="https://github.com/owner/repo">
            </div>
            <div class="form-group" style="flex:1">
              <label>Branch</label>
              <input id="sb-github-branch" type="text" class="form-control" placeholder="main" value="main">
            </div>
          </div>
        </div>

        <!-- Upload fields -->
        <div id="sb-upload-fields" style="display:none;margin-bottom:14px;padding:12px;background:var(--surface2);border-radius:var(--radius)">
          <div class="form-group">
            <label>Archive File <span class="text-muted text-sm">(.tar or .tar.gz)</span></label>
            <input id="sb-upload-file" type="file" class="form-control" accept=".tar,.tar.gz,.tgz">
          </div>
        </div>

        <!-- Image + Name -->
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Image <span id="sb-image-hint" class="text-muted text-sm"></span></label>
            <input id="sb-image" type="text" class="form-control" placeholder="nginx:alpine" value="${Utils.escapeHtml(prefillImage)}">
          </div>
          <div class="form-group">
            <label>Name (optional)</label>
            <input id="sb-name" type="text" class="form-control" placeholder="auto-generated">
          </div>
        </div>

        <!-- Mode -->
        <div class="form-group" style="margin-bottom:12px">
          <label>Mode</label>
          <div style="display:flex;gap:12px">
            <label class="toggle-label"><input type="radio" name="sb-mode" value="ephemeral" checked> <strong>Ephemeral</strong> <span class="text-muted text-sm">— auto-delete on stop</span></label>
            <label class="toggle-label"><input type="radio" name="sb-mode" value="persistent"> <strong>Persistent</strong> <span class="text-muted text-sm">— survives stop, isolated</span></label>
          </div>
        </div>

        <!-- TTL / RAM / CPU -->
        <div class="form-row">
          <div class="form-group">
            <label>TTL (auto-kill)</label>
            <select id="sb-ttl" class="form-control">
              <option value="1800">30 minutes</option>
              <option value="3600" selected>1 hour</option>
              <option value="14400">4 hours</option>
              <option value="0">No limit</option>
            </select>
          </div>
          <div class="form-group">
            <label>RAM Limit</label>
            <select id="sb-mem" class="form-control">
              <option value="268435456">256 MB</option>
              <option value="536870912" selected>512 MB</option>
              <option value="1073741824">1 GB</option>
              <option value="2147483648">2 GB</option>
            </select>
          </div>
          <div class="form-group">
            <label>CPU Limit</label>
            <select id="sb-cpu" class="form-control">
              <option value="0.25">0.25 cores</option>
              <option value="0.5" selected>0.5 cores</option>
              <option value="1">1 core</option>
              <option value="2">2 cores</option>
            </select>
          </div>
        </div>

        <!-- Advanced overrides (shown when project source active) -->
        <div id="sb-advanced-fields" style="display:none;margin-bottom:12px">
          <div class="form-row">
            <div class="form-group" style="flex:2">
              <label>Start Command <span class="text-muted text-sm">(override auto-detect)</span></label>
              <input id="sb-start-cmd" type="text" class="form-control" placeholder="auto-detected">
            </div>
            <div class="form-group" style="flex:1">
              <label>Expose Port <span class="text-muted text-sm">(override)</span></label>
              <input id="sb-expose-port" type="number" class="form-control" placeholder="auto-detected" min="1" max="65535">
            </div>
          </div>
        </div>

        <!-- Checkboxes -->
        <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap">
          <label class="toggle-label"><input type="checkbox" id="sb-terminal" checked> Open terminal after launch</label>
          <label class="toggle-label"><input type="checkbox" id="sb-isolated" checked> Isolated network</label>
          <label class="toggle-label" id="sb-autodetect-wrap" style="display:none"><input type="checkbox" id="sb-autodetect" checked> Auto-detect &amp; run</label>
        </div>

        <!-- Security notice -->
        <div style="margin-top:12px;padding:10px;background:var(--surface2);border-radius:var(--radius);font-size:11px;color:var(--text-dim)">
          <i class="fas fa-shield-alt" style="margin-right:6px;color:var(--yellow)"></i>
          Sandbox containers run with <code>no-new-privileges</code>, resource limits, no Docker socket access, and <code>restart: no</code>.
        </div>

        <!-- Progress section (hidden until launch with project source) -->
        <div id="sb-progress" style="display:none;margin-top:16px;padding:14px;background:var(--surface2);border-radius:var(--radius)">
          <div style="font-size:12px;font-weight:600;color:var(--text-dim);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.05em">Launch Progress</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div class="sb-step" id="sb-step-1" style="display:flex;align-items:center;gap:8px;font-size:13px">
              <span class="sb-step-icon" style="width:16px;text-align:center;color:var(--text-dim)">⟳</span>
              <span>Pulling image...</span>
            </div>
            <div class="sb-step" id="sb-step-2" style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim)">
              <span class="sb-step-icon" style="width:16px;text-align:center">⟳</span>
              <span id="sb-step-2-label">Downloading project...</span>
            </div>
            <div class="sb-step" id="sb-step-3" style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim)">
              <span class="sb-step-icon" style="width:16px;text-align:center">⟳</span>
              <span>Detecting stack...</span>
            </div>
            <div class="sb-step" id="sb-step-4" style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim)">
              <span class="sb-step-icon" style="width:16px;text-align:center">⟳</span>
              <span>Installing dependencies...</span>
            </div>
            <div class="sb-step" id="sb-step-5" style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim)">
              <span class="sb-step-icon" style="width:16px;text-align:center">⟳</span>
              <span>Starting application...</span>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="sb-close-btn">Cancel</button>
        <button class="btn btn-warning" id="sb-launch"><i class="fas fa-flask"></i> Launch Sandbox</button>
      </div>
    `, { width: '720px' });

    const mc = Modal._content;
    mc.querySelector('#sb-close-x').addEventListener('click', () => Modal.close());
    mc.querySelector('#sb-close-btn').addEventListener('click', () => Modal.close());

    // ── Project source radio toggle logic ──────────────────────────────────
    const githubFields  = mc.querySelector('#sb-github-fields');
    const uploadFields  = mc.querySelector('#sb-upload-fields');
    const advancedFields = mc.querySelector('#sb-advanced-fields');
    const autodetectWrap = mc.querySelector('#sb-autodetect-wrap');
    const imageHint     = mc.querySelector('#sb-image-hint');
    const isolatedCb    = mc.querySelector('#sb-isolated');
    const imageInput    = mc.querySelector('#sb-image');

    const onSourceChange = () => {
      const source = mc.querySelector('input[name="sb-source"]:checked')?.value || 'none';
      githubFields.style.display  = source === 'github' ? '' : 'none';
      uploadFields.style.display  = source === 'upload' ? '' : 'none';
      advancedFields.style.display = source !== 'none' ? '' : 'none';
      autodetectWrap.style.display = source !== 'none' ? '' : 'none';

      if (source !== 'none') {
        imageHint.textContent = '(optional — auto-detect from project)';
        imageInput.placeholder = 'auto-detected';
        // Uncheck isolated network so registries are reachable
        isolatedCb.checked = false;
        // Update step 2 label
        const step2Label = mc.querySelector('#sb-step-2-label');
        if (step2Label) step2Label.textContent = source === 'github' ? 'Downloading project...' : 'Uploading archive...';
      } else {
        imageHint.textContent = '';
        imageInput.placeholder = 'nginx:alpine';
        isolatedCb.checked = true;
      }
    };

    mc.querySelectorAll('input[name="sb-source"]').forEach(r => r.addEventListener('change', onSourceChange));

    // ── Launch handler ─────────────────────────────────────────────────────
    mc.querySelector('#sb-launch').addEventListener('click', async () => {
      const source = mc.querySelector('input[name="sb-source"]:checked')?.value || 'none';
      const image  = mc.querySelector('#sb-image').value.trim();

      if (source === 'none' && !image) { Toast.warning('Enter an image name'); return; }
      if (source === 'github') {
        const url = mc.querySelector('#sb-github-url').value.trim();
        if (!url) { Toast.warning('Enter a GitHub repository URL'); return; }
      }
      if (source === 'upload') {
        const fileInput = mc.querySelector('#sb-upload-file');
        if (!fileInput.files || !fileInput.files.length) { Toast.warning('Select an archive file to upload'); return; }
      }

      const mode           = mc.querySelector('input[name="sb-mode"]:checked')?.value || 'ephemeral';
      const ttl            = parseInt(mc.querySelector('#sb-ttl').value) || 0;
      const memLimit       = parseInt(mc.querySelector('#sb-mem').value);
      const cpuLimit       = parseFloat(mc.querySelector('#sb-cpu').value);
      const openTerminal   = mc.querySelector('#sb-terminal').checked;
      const isolatedNetwork = mc.querySelector('#sb-isolated').checked;
      const name           = mc.querySelector('#sb-name').value.trim() || undefined;
      const autoDetect     = source !== 'none' ? mc.querySelector('#sb-autodetect').checked : undefined;
      const startCommand   = mc.querySelector('#sb-start-cmd')?.value.trim() || undefined;
      const exposePortRaw  = mc.querySelector('#sb-expose-port')?.value.trim();
      const exposePort     = exposePortRaw ? parseInt(exposePortRaw) : undefined;

      const btn = mc.querySelector('#sb-launch');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Launching...';

      // Build payload
      const payload = { image: image || undefined, mode, ttl, memLimit, cpuLimit, name, openTerminal, isolatedNetwork, projectSource: source };
      if (autoDetect !== undefined) payload.autoDetect = autoDetect;
      if (startCommand) payload.startCommand = startCommand;
      if (exposePort)   payload.exposePort   = exposePort;

      if (source === 'github') {
        payload.githubUrl    = mc.querySelector('#sb-github-url').value.trim();
        payload.githubBranch = mc.querySelector('#sb-github-branch').value.trim() || 'main';
      }

      // Show progress section when using a project source
      const progressEl = mc.querySelector('#sb-progress');
      const formBody   = mc.querySelector('.modal-body');

      const setStepState = (stepNum, state) => {
        const stepEl = mc.querySelector(`#sb-step-${stepNum}`);
        if (!stepEl) return;
        const icon = stepEl.querySelector('.sb-step-icon');
        if (state === 'pending') {
          icon.textContent = '⟳';
          stepEl.style.color = 'var(--text-dim)';
        } else if (state === 'active') {
          icon.textContent = '⟳';
          icon.style.color = 'var(--yellow)';
          stepEl.style.color = '';
        } else if (state === 'done') {
          icon.textContent = '✓';
          icon.style.color = 'var(--green)';
          stepEl.style.color = '';
        } else if (state === 'error') {
          icon.textContent = '✗';
          icon.style.color = 'var(--red)';
          stepEl.style.color = 'var(--red)';
        }
      };

      if (source !== 'none') {
        // Hide form rows, show progress
        Array.from(formBody.children).forEach(el => {
          if (el.id !== 'sb-progress') el.style.display = 'none';
        });
        progressEl.style.display = '';
        // Mark all steps as active (indeterminate — we get result in one shot)
        for (let i = 1; i <= 5; i++) setStepState(i, 'active');
      }

      // Handle file upload: read as base64
      if (source === 'upload') {
        const fileInput = mc.querySelector('#sb-upload-file');
        const file = fileInput.files[0];
        payload.uploadFilename = file.name;
        try {
          payload.uploadContent = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              // result is data:<mime>;base64,<data> — strip prefix
              const b64 = reader.result.split(',')[1];
              resolve(b64);
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
          });
        } catch (readErr) {
          Toast.error('Failed to read archive: ' + readErr.message);
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-flask"></i> Launch Sandbox';
          return;
        }
      }

      try {
        const result = await Api.createSandbox(payload);

        if (source !== 'none') {
          for (let i = 1; i <= 5; i++) setStepState(i, 'done');
        }

        const portMsg = result.port
          ? ` — <a href="http://${window.location.hostname}:${result.port}" target="_blank" style="color:var(--accent)">Open http://${window.location.hostname}:${result.port}</a>`
          : '';

        if (result.port) {
          Toast.success(`App running on port ${result.port} — Open http://${window.location.hostname}:${result.port}`);
        } else {
          Toast.success(`Sandbox "${result.name}" launched`);
        }

        Modal.close();
        await this._loadList();

        if (openTerminal) {
          App.navigate(`/containers/${result.id}`);
          setTimeout(() => {
            document.querySelector('[data-tab="terminal"]')?.click();
          }, 400);
        }
      } catch (err) {
        if (source !== 'none') {
          for (let i = 1; i <= 5; i++) setStepState(i, 'error');
        }
        Toast.error('Sandbox launch failed: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-flask"></i> Launch Sandbox';
      }
    });
  },

  _githubComposeDialog() {
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fab fa-github" style="margin-right:8px;color:var(--accent)"></i>Generate docker-compose from GitHub</h3>
        <button class="modal-close-btn" id="ghc-close-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-muted text-sm" style="margin-bottom:16px">Paste a public GitHub repository URL. Docker Dash will fetch the project files and use AI to generate a production-ready docker-compose.yml.</p>
        <div class="form-group">
          <label>GitHub Repository URL</label>
          <input id="ghc-url" type="text" class="form-control" placeholder="https://github.com/owner/repo">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <select id="ghc-provider" class="form-control" style="width:auto;padding:4px 8px;font-size:12px">
            <option value="ollama">Ollama (local)</option>
            <option value="openai">OpenAI</option>
          </select>
          <input id="ghc-model" type="text" class="form-control" placeholder="Model (llama3 / gpt-4o-mini)" style="width:180px;padding:4px 8px;font-size:12px">
          <input id="ghc-config" type="text" class="form-control" placeholder="Ollama URL or OpenAI API key" style="flex:1;min-width:180px;padding:4px 8px;font-size:12px">
        </div>
        <div id="ghc-result" style="display:none;margin-top:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="text-sm text-muted" id="ghc-result-label"></span>
            <button class="btn btn-sm btn-secondary" id="ghc-copy"><i class="fas fa-copy"></i> Copy</button>
          </div>
          <pre class="inspect-json" id="ghc-compose-output" style="max-height:50vh;overflow:auto;font-size:12px"></pre>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="ghc-close-btn">Close</button>
        <button class="btn btn-accent" id="ghc-generate"><i class="fas fa-robot"></i> Generate</button>
      </div>
    `, { width: '750px' });

    const mc = Modal._content;
    mc.querySelector('#ghc-close-x').addEventListener('click', () => Modal.close());
    mc.querySelector('#ghc-close-btn').addEventListener('click', () => Modal.close());

    // Restore last AI config
    const provEl = mc.querySelector('#ghc-provider');
    const modelEl = mc.querySelector('#ghc-model');
    const cfgEl = mc.querySelector('#ghc-config');
    provEl.value = localStorage.getItem('dd-ai-provider') || 'ollama';
    modelEl.value = localStorage.getItem('dd-ai-model') || '';
    cfgEl.value = localStorage.getItem('dd-ai-config') || '';

    mc.querySelector('#ghc-copy').addEventListener('click', () => {
      const txt = mc.querySelector('#ghc-compose-output')?.textContent || '';
      Utils.copyToClipboard(txt).then(() => Toast.success('Copied!'));
    });

    mc.querySelector('#ghc-generate').addEventListener('click', async () => {
      const repoUrl = mc.querySelector('#ghc-url').value.trim();
      if (!repoUrl) { Toast.warning('Enter a GitHub repository URL'); return; }

      const provider = provEl.value;
      const model = modelEl.value.trim();
      const configVal = cfgEl.value.trim();
      localStorage.setItem('dd-ai-provider', provider);
      localStorage.setItem('dd-ai-model', model);
      localStorage.setItem('dd-ai-config', configVal);

      const config = provider === 'openai'
        ? { apiKey: configVal, model: model || 'gpt-4o-mini' }
        : { baseUrl: configVal || 'http://localhost:11434', model: model || 'llama3' };

      const genBtn = mc.querySelector('#ghc-generate');
      genBtn.disabled = true;
      genBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';

      const resultEl = mc.querySelector('#ghc-result');
      const outputEl = mc.querySelector('#ghc-compose-output');
      const labelEl = mc.querySelector('#ghc-result-label');

      resultEl.style.display = 'block';
      outputEl.textContent = 'Fetching repository and generating compose…';

      try {
        const r = await Api.aiGithubCompose(repoUrl, provider, config);
        outputEl.textContent = r.compose || 'No output';
        labelEl.textContent = `Generated for ${r.repo}`;
      } catch (err) {
        outputEl.textContent = 'Error: ' + err.message;
        labelEl.textContent = '';
      } finally {
        genBtn.disabled = false;
        genBtn.innerHTML = '<i class="fas fa-robot"></i> Generate';
      }
    });
  },

  _statsTimer: null,

  _startStatsPolling() {
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(() => this._tickStats(), 5000);
  },

  async _loadSparklines() {
    try {
      const data = await Api.getSparklines();
      Object.entries(data).forEach(([containerId, points]) => {
        const canvas = document.querySelector(`[data-sparkline-id="${containerId}"]`);
        if (!canvas || !points.length) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const cpuVals = points.map(p => p.cpu);
        const max = Math.max(...cpuVals, 1);
        const step = w / (cpuVals.length - 1 || 1);

        ctx.beginPath();
        ctx.strokeStyle = '#388bfd';
        ctx.lineWidth = 1;
        cpuVals.forEach((v, i) => {
          const x = i * step;
          const y = h - (v / max) * (h - 2) - 1;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    } catch { /* sparklines not available */ }
  },

  async _showComparisonChart(ids) {
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-chart-bar" style="margin-right:8px;color:var(--accent)"></i>Container Comparison</h3>
        <button class="modal-close-btn" id="compare-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <select id="compare-range" class="form-control" style="width:auto;font-size:12px">
            <option value="1h">Last 1h</option>
            <option value="6h" selected>Last 6h</option>
            <option value="24h">Last 24h</option>
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div><canvas id="compare-cpu-chart"></canvas></div>
          <div><canvas id="compare-mem-chart"></canvas></div>
        </div>
      </div>
      <div class="modal-footer"><button class="btn btn-primary" id="compare-close-btn">Close</button></div>
    `, { width: '850px' });

    Modal._content.querySelector('#compare-close').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#compare-close-btn').addEventListener('click', () => Modal.close());

    const palette = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7'];

    const loadCharts = async () => {
      const range = Modal._content.querySelector('#compare-range')?.value || '6h';
      const allData = await Promise.all(ids.map(id => Api.getContainerStatsHistory(id, range).catch(() => ({ points: [] }))));

      // Find container names
      const containers = this._lastContainers || [];
      const names = ids.map(id => {
        const c = containers.find(c => c.id === id);
        return c?.name || id.substring(0, 8);
      });

      // CPU chart
      const cpuCanvas = Modal._content.querySelector('#compare-cpu-chart');
      if (cpuCanvas) {
        const existing = Chart.getChart(cpuCanvas);
        if (existing) existing.destroy();
        new Chart(cpuCanvas, {
          type: 'line',
          data: {
            labels: (allData[0]?.points || allData[0] || []).map(p => p.time ? new Date(p.time).toLocaleTimeString() : ''),
            datasets: ids.map((id, i) => ({
              label: names[i],
              data: (allData[i]?.points || allData[i] || []).map(p => p.cpu),
              borderColor: palette[i],
              borderWidth: 1.5,
              fill: false,
              tension: 0.3,
              pointRadius: 0,
            })),
          },
          options: { responsive: true, plugins: { title: { display: true, text: 'CPU %' } }, scales: { y: { beginAtZero: true } } },
        });
      }

      // Memory chart
      const memCanvas = Modal._content.querySelector('#compare-mem-chart');
      if (memCanvas) {
        const existing = Chart.getChart(memCanvas);
        if (existing) existing.destroy();
        new Chart(memCanvas, {
          type: 'line',
          data: {
            labels: (allData[0]?.points || allData[0] || []).map(p => p.time ? new Date(p.time).toLocaleTimeString() : ''),
            datasets: ids.map((id, i) => ({
              label: names[i],
              data: (allData[i]?.points || allData[i] || []).map(p => p.mem ? p.mem / (1024 * 1024) : 0),
              borderColor: palette[i],
              borderWidth: 1.5,
              fill: false,
              tension: 0.3,
              pointRadius: 0,
            })),
          },
          options: { responsive: true, plugins: { title: { display: true, text: 'Memory (MB)' } }, scales: { y: { beginAtZero: true } } },
        });
      }
    };

    await loadCharts();
    Modal._content.querySelector('#compare-range')?.addEventListener('change', loadCharts);
  },

  async _tickStats() {
    if (this._view !== 'list') return;
    try {
      const data = await Api.getStatsOverview();
      const containers = data.containers || [];
      containers.forEach(s => {
        const cpuEl = document.querySelector(`[data-stats-cpu="${s.container_id}"]`);
        const memEl = document.querySelector(`[data-stats-mem="${s.container_id}"]`);
        if (cpuEl) {
          const pct = Math.min(s.cpu_percent || 0, 100).toFixed(1);
          const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)';
          cpuEl.style.width = `${pct}%`;
          cpuEl.style.background = color;
          cpuEl.parentElement.title = `CPU: ${pct}%`;
        }
        if (memEl) {
          const pct = Math.min(s.mem_percent || 0, 100).toFixed(1);
          const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--accent)';
          memEl.style.width = `${pct}%`;
          memEl.style.background = color;
          memEl.parentElement.title = `RAM: ${pct}%`;
        }
      });
    } catch { /* stats unavailable */ }
  },

  _renderSavedFilters(container) {
    const bar = container.querySelector('#container-filter-presets') || document.getElementById('container-filter-presets');
    if (!bar) return;
    // Remove existing saved filter buttons
    bar.querySelectorAll('.saved-filter').forEach(b => b.remove());

    const saved = JSON.parse(localStorage.getItem('dd-saved-filters') || '[]');
    const saveBtn = bar.querySelector('#save-filter-btn');
    saved.forEach((f, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-xs filter-preset saved-filter';
      btn.style.cssText = 'border-style:dashed;';
      btn.innerHTML = `${Utils.escapeHtml(f.label)} <i class="fas fa-times" data-remove-filter="${i}" style="margin-left:4px;font-size:9px;opacity:0.5"></i>`;
      btn.addEventListener('click', (e) => {
        if (e.target.dataset.removeFilter !== undefined) {
          saved.splice(parseInt(e.target.dataset.removeFilter), 1);
          localStorage.setItem('dd-saved-filters', JSON.stringify(saved));
          this._renderSavedFilters(container);
          return;
        }
        bar.querySelectorAll('.filter-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._filter = f.search || '';
        this._stateFilter = f.state || '';
        const searchInput = document.getElementById('container-search');
        if (searchInput) searchInput.value = f.search || '';
        this._renderGrouped();
      });
      if (saveBtn) bar.insertBefore(btn, saveBtn);
      else bar.appendChild(btn);
    });
  },

  _createStackWizard() {
    let step = 1;
    const state = { name: '', services: [{ name: 'web', image: 'nginx:alpine', ports: '80:80' }], network: '', volumes: [] };

    const renderStep = () => {
      const steps = [
        { num: 1, label: 'Stack Name' },
        { num: 2, label: 'Services' },
        { num: 3, label: 'Review & Deploy' },
      ];

      const stepBar = steps.map(s =>
        `<div style="display:flex;align-items:center;gap:6px;${s.num === step ? 'color:var(--accent);font-weight:600' : 'color:var(--text-dim)'}">
          <span style="width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;
            ${s.num < step ? 'background:var(--green);color:#fff' : s.num === step ? 'background:var(--accent);color:#fff' : 'background:var(--surface3);color:var(--text-dim)'}">
            ${s.num < step ? '<i class="fas fa-check"></i>' : s.num}
          </span>
          <span style="font-size:12px">${s.label}</span>
          ${s.num < steps.length ? '<span style="flex:1;height:1px;background:var(--border);margin:0 8px"></span>' : ''}
        </div>`
      ).join('');

      let content = '';
      if (step === 1) {
        content = `
          <div class="form-group">
            <label>Stack / Project Name</label>
            <input id="wiz-name" class="form-control" value="${Utils.escapeHtml(state.name)}" placeholder="my-stack" autofocus>
            <p class="text-muted text-sm" style="margin-top:6px">This becomes the Docker Compose project name. Use lowercase letters, numbers, and hyphens.</p>
          </div>
        `;
      } else if (step === 2) {
        content = `
          <div id="wiz-services">
            ${state.services.map((s, i) => `
              <div class="card" style="padding:12px;margin-bottom:8px;border:1px solid var(--border)">
                <div style="display:flex;gap:8px;align-items:center">
                  <span style="font-weight:600;color:var(--accent);min-width:60px">Service ${i + 1}</span>
                  ${i > 0 ? `<button class="btn btn-xs btn-danger wiz-remove-svc" data-idx="${i}" style="margin-left:auto"><i class="fas fa-times"></i></button>` : ''}
                </div>
                <div class="form-row" style="margin-top:8px">
                  <div class="form-group"><label>Name</label><input class="form-control wiz-svc-name" data-idx="${i}" value="${Utils.escapeHtml(s.name)}"></div>
                  <div class="form-group"><label>Image</label><input class="form-control wiz-svc-image" data-idx="${i}" value="${Utils.escapeHtml(s.image)}" placeholder="nginx:alpine"></div>
                  <div class="form-group"><label>Ports</label><input class="form-control wiz-svc-ports" data-idx="${i}" value="${Utils.escapeHtml(s.ports)}" placeholder="8080:80"></div>
                </div>
              </div>
            `).join('')}
          </div>
          <button class="btn btn-sm btn-secondary" id="wiz-add-svc"><i class="fas fa-plus"></i> Add Service</button>
        `;
      } else if (step === 3) {
        const yaml = ['version: "3.8"', 'services:'];
        state.services.forEach(s => {
          yaml.push(`  ${s.name}:`);
          yaml.push(`    image: ${s.image}`);
          yaml.push(`    restart: unless-stopped`);
          if (s.ports) {
            yaml.push(`    ports:`);
            s.ports.split(',').forEach(p => yaml.push(`      - "${p.trim()}"`));
          }
        });
        const yamlStr = yaml.join('\n');

        content = `
          <div class="form-group">
            <label>Generated docker-compose.yml</label>
            <textarea id="wiz-yaml" class="form-control" rows="12" style="font-family:var(--mono);font-size:12px">${Utils.escapeHtml(yamlStr)}</textarea>
          </div>
          <p class="text-muted text-sm"><i class="fas fa-info-circle" style="margin-right:4px"></i>You can edit the YAML before deploying. Changes will be used as-is.</p>
        `;
      }

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-magic" style="margin-right:8px;color:var(--accent)"></i>Create Stack</h3>
          <button class="modal-close-btn" id="wiz-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:4px;margin-bottom:20px">${stepBar}</div>
          ${content}
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
          ${step > 1 ? '<button class="btn btn-secondary" id="wiz-back"><i class="fas fa-arrow-left"></i> Back</button>' : ''}
          <span style="flex:1"></span>
          ${step < 3 ? '<button class="btn btn-primary" id="wiz-next">Next <i class="fas fa-arrow-right"></i></button>' : ''}
          ${step === 3 ? '<button class="btn btn-accent" id="wiz-deploy"><i class="fas fa-rocket"></i> Deploy Stack</button>' : ''}
        </div>
      `, { width: '650px' });

      Modal._content.querySelector('#wiz-close').addEventListener('click', () => Modal.close());

      if (step === 1) {
        Modal._content.querySelector('#wiz-name')?.focus();
      }

      Modal._content.querySelector('#wiz-back')?.addEventListener('click', () => { saveCurrentStep(); step--; renderStep(); });
      Modal._content.querySelector('#wiz-next')?.addEventListener('click', () => {
        if (!saveCurrentStep()) return;
        step++;
        renderStep();
      });

      Modal._content.querySelector('#wiz-add-svc')?.addEventListener('click', () => {
        saveCurrentStep();
        state.services.push({ name: `svc${state.services.length + 1}`, image: '', ports: '' });
        renderStep();
      });

      Modal._content.querySelectorAll('.wiz-remove-svc').forEach(btn => {
        btn.addEventListener('click', () => {
          saveCurrentStep();
          state.services.splice(parseInt(btn.dataset.idx), 1);
          renderStep();
        });
      });

      Modal._content.querySelector('#wiz-deploy')?.addEventListener('click', async () => {
        const yaml = Modal._content.querySelector('#wiz-yaml').value;
        const deployBtn = Modal._content.querySelector('#wiz-deploy');
        deployBtn.disabled = true;
        deployBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deploying...';
        try {
          await Api.saveStackConfig(state.name, { config: yaml });
          await Api.deployStack(state.name, {});
          Toast.success(`Stack "${state.name}" deployed!`);
          Modal.close();
          await this._loadList();
        } catch (err) {
          Toast.error('Deploy failed: ' + err.message);
          deployBtn.disabled = false;
          deployBtn.innerHTML = '<i class="fas fa-rocket"></i> Deploy Stack';
        }
      });
    };

    const saveCurrentStep = () => {
      const mc = Modal._content;
      if (step === 1) {
        const name = mc.querySelector('#wiz-name')?.value?.trim();
        if (!name) { Toast.warning('Enter a stack name'); return false; }
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { Toast.warning('Use lowercase letters, numbers, and hyphens'); return false; }
        state.name = name;
      } else if (step === 2) {
        mc.querySelectorAll('.wiz-svc-name').forEach(input => {
          const idx = parseInt(input.dataset.idx);
          state.services[idx].name = input.value.trim();
        });
        mc.querySelectorAll('.wiz-svc-image').forEach(input => {
          const idx = parseInt(input.dataset.idx);
          state.services[idx].image = input.value.trim();
        });
        mc.querySelectorAll('.wiz-svc-ports').forEach(input => {
          const idx = parseInt(input.dataset.idx);
          state.services[idx].ports = input.value.trim();
        });
        if (state.services.some(s => !s.name || !s.image)) { Toast.warning('All services need a name and image'); return false; }
      }
      return true;
    };

    renderStep();
  },

  destroy() {
    clearInterval(this._refreshTimer);
    clearInterval(this._statsTimer);
    if (this._logStream) this._logStream();
    this._stopLogFollow();
    if (this._boundKbHandler) { document.removeEventListener('keydown', this._boundKbHandler); this._boundKbHandler = null; }
    if (this._sandboxExpiredHandler) { this._sandboxExpiredHandler(); this._sandboxExpiredHandler = null; }
    if (this._execUnsub) this._execUnsub.forEach(fn => fn());
    if (this._termDataDisposable) { this._termDataDisposable.dispose(); this._termDataDisposable = null; }
    if (this._termResizeObserver) { this._termResizeObserver.disconnect(); this._termResizeObserver = null; }
    if (this._term) { this._term.dispose(); this._term = null; }
    this._fitAddon = null;
    if (this._detailId) WS.unsubscribe(`logs:${this._detailId}`);
    // Clean up bulk action bar
    this._selectedIds.clear();
    const bar = document.getElementById('bulk-action-bar');
    if (bar) bar.remove();
    // Reset filters so returning to page shows everything
    this._filter = '';
    this._stateFilter = '';
  },
};

// Handle action button clicks via event delegation (containers only)
const _containerActions = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'remove', 'edit-meta']);
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action][data-id]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (!_containerActions.has(action)) return;
  e.stopPropagation();
  const id = btn.dataset.id;

  if (action === 'edit-meta') {
    const name = btn.dataset.name;
    if (name) ContainersPage._editMetaDialog(name);
    return;
  }

  if (action === 'remove') {
    const containerName = btn.dataset.name || id.substring(0, 12);
    const isRunning = btn.dataset.state === 'running';
    Modal.confirm(
      `Remove container "${containerName}"? This action cannot be undone.`,
      { danger: true, confirmText: i18n.t('common.remove'), typeToConfirm: isRunning ? containerName : undefined }
    ).then(ok => {
      if (ok) Api.removeContainer(id, true).then(() => {
        Toast.success(i18n.t('pages.containers.removed'));
        if (ContainersPage._view === 'list') ContainersPage._loadList();
        else App.navigate('/containers');
      }).catch(err => Toast.error(err.message));
    });
  } else {
    Api.containerAction(id, action).then(() => {
      Toast.success(i18n.t('pages.containers.actionSuccess', { action }));
      if (ContainersPage._view === 'list') ContainersPage._loadList();
    }).catch(err => Toast.error(err.message));
  }
});

window.ContainersPage = ContainersPage;
