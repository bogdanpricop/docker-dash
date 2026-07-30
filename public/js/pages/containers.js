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

  // v6.16.0 Phase 2 — lazy-load detail module on first /containers/:id nav.
  // Eliminates ~2600 lines (~100KB) from the initial JS payload for users
  // who never open container detail. See plans/deep-spec-containers-split.md.
  _detailModuleLoaded: false,

  async _loadDetailModule() {
    if (this._detailModuleLoaded) return;
    // Reuse the cache-bust version from the currently-loaded containers.js
    // script tag, so container-detail.js ships with the same version.
    const self = Array.from(document.getElementsByTagName('script'))
      .find(s => s.src && s.src.indexOf('/js/pages/containers.js') !== -1);
    const vMatch = self && self.src.match(/[?&]v=([^&]+)/);
    const v = vMatch ? vMatch[1] : Date.now();
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/pages/container-detail.js?v=' + v;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load container-detail.js'));
      document.head.appendChild(s);
    });
    if (typeof ContainersPageDetail !== 'object') {
      throw new Error('container-detail.js loaded but ContainersPageDetail global missing');
    }
    Object.assign(ContainersPage, ContainersPageDetail);
    this._detailModuleLoaded = true;
  },

  async render(container, params = {}) {
    if (params.id) {
      this._view = 'detail';
      this._detailId = params.id;
      try { await this._loadDetailModule(); }
      catch (err) {
        container.innerHTML = '<div class="empty-msg is-error">Detail view could not load: ' + Utils.escapeHtml(err.message || 'network error') + '. <button class="btn btn-sm" id="dd-reload-btn">Reload</button></div>';
        const reloadBtn = container.querySelector('#dd-reload-btn');
        if (reloadBtn) reloadBtn.addEventListener('click', () => location.reload());
        return;
      }
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
          <button class="btn btn-sm btn-secondary" id="container-exposed-ports" title="Audit all containers with ports published to the host">
            <i class="fas fa-network-wired"></i> Exposed Ports
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
    container.querySelector('#container-exposed-ports').addEventListener('click', () => this._exposedPortsDialog());
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

  // ─── Exposed Ports audit (modal) ──────────────────────────────────
  // Common service names by container (private) port, for a quick "what is
  // this" hint in the audit. Sensitive ones get flagged when public.
  _PORT_SERVICES: {
    20: 'FTP', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
    80: 'HTTP', 110: 'POP3', 143: 'IMAP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB',
    1433: 'MSSQL', 1521: 'Oracle', 2375: 'Docker API', 2376: 'Docker API (TLS)',
    3000: 'HTTP (dev)', 3306: 'MySQL', 3389: 'RDP', 5000: 'HTTP (dev)',
    5432: 'PostgreSQL', 5601: 'Kibana', 5672: 'RabbitMQ', 6379: 'Redis',
    8080: 'HTTP-alt', 8086: 'InfluxDB', 8443: 'HTTPS-alt', 9000: 'MinIO/FPM',
    9090: 'Prometheus', 9200: 'Elasticsearch', 11211: 'Memcached',
    15672: 'RabbitMQ UI', 27017: 'MongoDB',
  },
  _SENSITIVE_PORTS: new Set([22, 23, 445, 1433, 1521, 2375, 2376, 3306, 3389, 5432, 6379, 9200, 11211, 27017, 5601, 15672, 8086]),

  async _exposedPortsDialog() {
    let containers;
    try {
      containers = await Api.getContainers(true);
    } catch (err) { Toast.error(err.message); return; }

    const classify = (ip) => {
      if (!ip || ip === '0.0.0.0' || ip === '::') return { label: 'Public (all interfaces)', pub: true, color: 'var(--red)' };
      if (ip === '127.0.0.1' || ip === '::1') return { label: 'Localhost only', pub: false, color: 'var(--green)' };
      return { label: ip, pub: false, color: 'var(--text-dim)' };
    };

    // One row per published mapping, deduped across IPv4/IPv6 (prefer public).
    const byKey = new Map();
    for (const c of containers) {
      for (const p of (c.ports || [])) {
        const pub = p.public || p.PublicPort;
        if (!pub) continue;
        const priv = p.private || p.PrivatePort || 0;
        const proto = (p.type || p.Type || 'tcp').toLowerCase();
        const ip = p.ip || p.IP || '';
        const ex = classify(ip);
        const service = this._PORT_SERVICES[priv] || '';
        const sensitive = this._SENSITIVE_PORTS.has(Number(priv));
        const key = `${c.id}|${pub}|${priv}|${proto}`;
        const existing = byKey.get(key);
        if (!existing || (ex.pub && !existing._pub)) {
          byKey.set(key, {
            id: c.id, name: c.name, image: c.image, state: c.state,
            stack: c.stack || '', hostIp: ip || '0.0.0.0',
            publicPort: Number(pub), privatePort: Number(priv), proto,
            service, exposure: ex.label,
            _pub: ex.pub, _color: ex.color, _sensitive: sensitive,
          });
        }
      }
    }
    const rows = [...byKey.values()].sort((a, b) => a.publicPort - b.publicPort);
    this._exposedRows = rows;

    const containerCount = new Set(rows.map(r => r.id)).size;
    const publicCount = rows.filter(r => r._pub).length;
    const riskyCount = rows.filter(r => r._pub && r._sensitive).length;

    const summary = rows.length === 0
      ? `<div class="text-muted">No containers are publishing ports to the host.</div>`
      : `<strong>${rows.length}</strong> published port${rows.length === 1 ? '' : 's'} across <strong>${containerCount}</strong> container${containerCount === 1 ? '' : 's'}` +
        ` · <span style="color:var(--red)">${publicCount}</span> reachable on all interfaces` +
        (riskyCount > 0 ? ` · <span style="color:var(--red)"><i class="fas fa-triangle-exclamation"></i> ${riskyCount} sensitive service${riskyCount === 1 ? '' : 's'} publicly exposed</span>` : '');

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-network-wired" style="color:var(--accent);margin-right:8px"></i> Exposed Ports</h3>
        <button class="modal-close-btn" id="exposed-close-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="max-height:72vh;overflow:auto">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
          <div class="search-box" style="flex:1;min-width:200px">
            <i class="fas fa-search"></i>
            <input type="text" id="exposed-search" placeholder="Filter by container, port, service...">
          </div>
          <button class="btn btn-sm btn-secondary" id="exposed-copy" ${rows.length ? '' : 'disabled'}><i class="fas fa-copy"></i> Copy</button>
          <button class="btn btn-sm btn-secondary" id="exposed-csv" ${rows.length ? '' : 'disabled'}><i class="fas fa-file-csv"></i> CSV</button>
          <button class="btn btn-sm btn-primary" id="exposed-xlsx" ${rows.length ? '' : 'disabled'}><i class="fas fa-file-excel"></i> XLSX</button>
        </div>
        <div id="exposed-summary" style="margin-bottom:10px;font-size:13px">${summary}</div>
        <div id="exposed-ports-table"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" id="exposed-close-btn">${i18n.t('common.close')}</button></div>
    `, { width: 'min(1320px, 96vw)' });

    Modal._content.querySelector('#exposed-close-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#exposed-close-btn').addEventListener('click', () => Modal.close());

    if (rows.length === 0) return;

    const portCell = v => `<span class="mono">${Utils.escapeHtml(String(v))}</span>`;
    const table = new DataTable(Modal._content.querySelector('#exposed-ports-table'), {
      columns: [
        { key: 'name', label: 'Container', render: (v, row) => `<span class="badge ${Utils.statusBadgeClass(row.state)}" style="margin-right:6px">${Utils.escapeHtml(row.state)}</span><span class="mono">${Utils.escapeHtml(v)}</span>` },
        { key: 'stack', label: 'Stack', render: v => v ? Utils.escapeHtml(v) : '<span class="text-muted">—</span>' },
        { key: 'hostIp', label: 'Host IP', render: v => `<span class="mono text-sm">${Utils.escapeHtml(v)}</span>` },
        { key: 'publicPort', label: 'Host Port', render: portCell },
        { key: 'privatePort', label: 'Container Port', render: portCell },
        { key: 'proto', label: 'Proto' },
        { key: 'service', label: 'Service', render: (v, row) => v ? `${Utils.escapeHtml(v)}${row._sensitive && row._pub ? ' <i class="fas fa-triangle-exclamation" title="Sensitive service exposed on all interfaces" style="color:var(--red)"></i>' : ''}` : '<span class="text-muted">—</span>' },
        { key: 'exposure', label: 'Exposure', render: (v, row) => `<span style="color:${row._color}">${Utils.escapeHtml(v)}</span>` },
      ],
      rowClass: (row) => (row._pub && row._sensitive) ? 'row-risk' : '',
      onRowClick: (row) => { Modal.close(); App.navigate(`/containers/${row.id}`); },
      emptyText: 'No matching ports',
    });
    table.setData(rows);

    Modal._content.querySelector('#exposed-search').addEventListener('input',
      Utils.debounce(e => table.setFilter(e.target.value), 150));

    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const headers = ['Container', 'Stack', 'State', 'Host IP', 'Host Port', 'Container Port', 'Protocol', 'Service', 'Exposure'];
    const toRows = () => this._exposedRows.map(r => [r.name, r.stack, r.state, r.hostIp, r.publicPort, r.privatePort, r.proto, r.service, r.exposure]);

    Modal._content.querySelector('#exposed-csv').addEventListener('click', () => {
      Utils.exportCsv(`exposed-ports-${stamp()}.csv`, headers, toRows());
      Toast.success(`Exported ${this._exposedRows.length} rows`);
    });
    Modal._content.querySelector('#exposed-xlsx').addEventListener('click', () => {
      Utils.exportXlsx(`exposed-ports-${stamp()}.xlsx`, 'Exposed Ports', headers, toRows());
      Toast.success(`Exported ${this._exposedRows.length} rows`);
    });
    Modal._content.querySelector('#exposed-copy').addEventListener('click', () => {
      const text = [headers.join('\t'), ...toRows().map(r => r.join('\t'))].join('\n');
      Utils.copyToClipboard(text).then(() => Toast.success('Copied to clipboard')).catch(() => Toast.error('Copy failed'));
    });
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
        <span class="summary-item" style="font-size:11px"><i class="fas fa-cube"></i> <strong>${total}</strong> ${i18n.t('pages.containers.total')}</span>
        <span class="summary-sep" style="font-size:11px">|</span>
        <span class="summary-item summary-filter ${activeFilter === 'running' ? 'active' : ''} text-green" data-state-filter="running" style="font-size:11px;cursor:pointer"><i class="fas fa-play"></i> ${running} ${i18n.t('common.running')}</span>
        <span class="summary-sep" style="font-size:11px">|</span>
        <span class="summary-item summary-filter ${activeFilter === 'exited' ? 'active' : ''} text-muted" data-state-filter="exited" style="font-size:11px;cursor:pointer"><i class="fas fa-stop"></i> ${stopped} ${i18n.t('common.stopped')}</span>
        ${other > 0 ? `<span class="summary-sep" style="font-size:11px">|</span><span class="summary-item summary-filter ${activeFilter === 'other' ? 'active' : ''} text-yellow" data-state-filter="other" style="font-size:11px;cursor:pointer"><i class="fas fa-exclamation-triangle"></i> ${other} ${i18n.t('common.other')}</span>` : ''}
        ${needsAttention > 0 ? `<span class="summary-sep" style="font-size:11px">|</span><span class="summary-item summary-filter ${activeFilter === 'attention' ? 'active' : ''} text-orange" data-state-filter="attention" style="font-size:11px;cursor:pointer"><i class="fas fa-heartbeat"></i> ${needsAttention} ${i18n.t('pages.containers.needsAttention')}</span>` : ''}
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
                <button class="action-btn" data-stack-sec="secrets" data-stack="${Utils.escapeHtml(stack)}" title="Secrets Audit — check secret hygiene for this stack" style="color:#a78bfa"><i class="fas fa-user-secret"></i></button>
                <button class="action-btn" data-stack-sec="egress" data-stack="${Utils.escapeHtml(stack)}" title="Egress Audit — outbound network posture for this stack" style="color:#06b6d4"><i class="fas fa-network-wired"></i></button>
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

    // Stack security buttons (vuln scan + CIS + secrets + egress) — v6.9.3 adds last two
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
        } else if (type === 'cis') {
          await this._showStackCisModal(stackName, stackContainers);
        } else if (type === 'secrets') {
          await this._showStackSecretsModal(stackName, stackContainers);
        } else if (type === 'egress') {
          await this._showStackEgressModal(stackName, stackContainers);
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
            <button class="action-btn" data-basket-container="${c.id}" data-name="${Utils.escapeHtml(c.name)}" title="Add to persistent selection basket"><i class="fas fa-basket-shopping"></i></button>
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

      const templateCards = templates.map(t => {
        // Precomputed haystack — keeps the search filter cheap (no DOM text reads).
        const haystack = `${t.name} ${t.description} ${t.category} ${t.id}`.toLowerCase();
        return `
        <div class="template-card" data-category="${t.category}" data-id="${t.id}" data-search="${Utils.escapeHtml(haystack)}">
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
        </div>`;
      }).join('');

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-th" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.containers.templatesTitle')}</h3>
          <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <p class="text-muted text-sm" style="margin-bottom:12px">${i18n.t('pages.containers.templatesDesc')}</p>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
            <div class="search-box" style="flex:1;min-width:220px">
              <i class="fas fa-search"></i>
              <input type="text" id="template-search" placeholder="Filter ${templates.length} templates by name, description, category...">
            </div>
            <span id="template-count" class="text-muted text-sm" style="white-space:nowrap"></span>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap" id="template-cats">${catBtns}</div>
          <div class="template-grid" id="template-list">${templateCards}</div>
          <div id="template-empty" class="empty-msg" style="display:none"><i class="fas fa-search"></i><p>No templates match your filters.</p></div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="modal-ok">${i18n.t('common.close')}</button></div>
      `, { width: 'min(1100px, 96vw)' });

      Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

      // Unified filter (category ∩ search). Both inputs feed into applyFilters.
      let activeCat = 'all';
      let search = '';
      const cards = Modal._content.querySelectorAll('.template-card');
      const total = cards.length;
      const countEl = Modal._content.querySelector('#template-count');
      const emptyEl = Modal._content.querySelector('#template-empty');
      const applyFilters = () => {
        let shown = 0;
        cards.forEach(card => {
          const cardCat = (card.dataset.category || '').toLowerCase();
          const hay = card.dataset.search || '';
          const catOk = activeCat === 'all' || cardCat.includes(activeCat);
          const searchOk = !search || hay.includes(search);
          const visible = catOk && searchOk;
          card.style.display = visible ? '' : 'none';
          if (visible) shown++;
        });
        if (countEl) countEl.textContent = shown === total ? `${total} templates` : `${shown} of ${total}`;
        if (emptyEl) emptyEl.style.display = shown === 0 ? '' : 'none';
      };
      applyFilters();

      // Category buttons
      Modal._content.querySelectorAll('[data-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          Modal._content.querySelectorAll('[data-cat]').forEach(b => b.className = 'btn btn-xs btn-secondary');
          btn.className = 'btn btn-xs btn-primary';
          activeCat = btn.dataset.cat.toLowerCase();
          applyFilters();
        });
      });

      // Search input (debounced)
      const searchInput = Modal._content.querySelector('#template-search');
      searchInput.addEventListener('input', Utils.debounce(e => {
        search = (e.target.value || '').trim().toLowerCase();
        applyFilters();
      }, 120));
      // Focus the search so users can start typing immediately
      setTimeout(() => searchInput.focus(), 50);

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
                  this._showDeployError(tmpl, err, compose);
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
        this._showDeployError(tmpl, err, tmpl.compose);
      }
    }
  },

  /**
   * Persistent error dialog for template deploy failures. The Docker error
   * (and any structured fields the backend returned — service name, container
   * name, partial successes) is shown in a modal the user has to close, with
   * a Copy button so the message can be pasted into an issue. Replaces the
   * 4-second Toast.error which made debugging impossible.
   */
  _showDeployError(tmpl, err, composeText) {
    const body = (err && err.body) || {};
    const message = (err && err.message) || 'Unknown error';
    const status = (err && err.status) ? ` (HTTP ${err.status})` : '';
    const detailLines = [];
    if (body.service) detailLines.push(`service:        ${body.service}`);
    if (body.containerName) detailLines.push(`container:      ${body.containerName}`);
    if (Array.isArray(body.partial) && body.partial.length) {
      detailLines.push(`partial deploy: ${body.partial.length} container(s) created before the failure:`);
      body.partial.forEach(p => detailLines.push(`  - ${p.name}${p.started === false ? ' (created, NOT started)' : ''}`));
    }
    const details = detailLines.length ? detailLines.join('\n') + '\n\n' : '';
    const errorBlock = `Template:       ${tmpl.id} (${tmpl.name})\nError${status}: ${message}\n\n${details}--- Compose YAML sent ---\n${composeText || tmpl.compose || ''}`;

    const html = `
      <div class="modal-header">
        <h3 style="color:var(--red)"><i class="fas fa-circle-exclamation" style="margin-right:8px"></i>Deploy failed — ${Utils.escapeHtml(tmpl.name)}</h3>
        <button class="modal-close-btn" id="deploy-err-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-muted text-sm" style="margin-bottom:8px">The Docker API returned an error. The full message is below — copy it before closing if you want to debug or report it.</p>
        ${body.partial && body.partial.length ? `<div class="empty-msg is-warning" style="margin-bottom:10px"><i class="fas fa-triangle-exclamation"></i><p><strong>Partial deploy:</strong> ${body.partial.length} container(s) were created before the failure. Stop/remove them from the Containers page if you need to start clean.</p></div>` : ''}
        <pre class="inspect-json" style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px;border:1px solid var(--red);border-radius:4px;padding:10px">${Utils.escapeHtml(errorBlock)}</pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="deploy-err-copy"><i class="fas fa-copy"></i> ${i18n.t('common.copy')}</button>
        <button class="btn btn-primary" id="deploy-err-ok">${i18n.t('common.close')}</button>
      </div>
    `;

    // If a modal is already open (e.g. the template configurator), layer this on top via openSub.
    const useSub = !!(Modal._content && Modal._content.parentElement && getComputedStyle(Modal._content.parentElement).display !== 'none');
    const opts = { width: 'min(900px, 95vw)' };
    const root = useSub ? Modal.openSub(html, opts) : (Modal.open(html, opts), Modal._content);
    const close = () => { if (useSub) Modal.closeSub(); else Modal.close(); };
    root.querySelector('#deploy-err-x').addEventListener('click', close);
    root.querySelector('#deploy-err-ok').addEventListener('click', close);
    root.querySelector('#deploy-err-copy').addEventListener('click', () => {
      Utils.copyToClipboard(errorBlock).then(() => Toast.success(i18n.t('common.copied')));
    });
  },

  // ─── Health Check Logs Viewer ──────────────────

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
    if (typeof this._stopLogFollow === 'function') this._stopLogFollow();
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

  // ─── Stack-scoped Secrets Audit modal (v6.9.3) ─────────────
  //
  // Reuses the global /system/secrets-audit endpoint and client-filters to this
  // stack. Shows per-container score + top issues + a one-click Fix button
  // that hands off to RemediateWizard with container scope (already reusable).
  async _showStackSecretsModal(stackName, containers) {
    const running = containers.filter(c => c.state === 'running');
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-user-secret" style="color:#a78bfa;margin-right:10px"></i>
          Secrets Audit — <span style="color:var(--accent)">${Utils.escapeHtml(stackName)}</span>
        </h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" id="stack-secrets-body">
        <div style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="text-muted text-sm"><i class="fas fa-box" style="margin-right:5px"></i>${running.length} running container${running.length === 1 ? '' : 's'} will be scanned</span>
          ${containers.length > running.length ? `<span class="badge badge-warning" style="font-size:10px"><i class="fas fa-info-circle" style="margin-right:3px"></i>${containers.length - running.length} stopped (skipped)</span>` : ''}
        </div>
        <div id="stack-secrets-results"><div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading secrets audit…</div></div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:space-between;align-items:center">
        <button class="btn btn-secondary" id="secrets-remediate-stack" style="display:none"><i class="fas fa-tools" style="margin-right:6px"></i>Remediate whole stack</button>
        <div style="display:flex;gap:8px;margin-left:auto">
          <a href="#/system" style="align-self:center;font-size:12px;color:var(--accent);text-decoration:none" data-tab-jump="secrets">Open full Secrets tab →</a>
          <button class="btn btn-secondary" id="modal-ok">Close</button>
        </div>
      </div>
    `, { width: '860px' });

    const mc = Modal._content;
    mc.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    mc.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

    const results = mc.querySelector('#stack-secrets-results');
    try {
      const data = await Api.getSecretsAudit();
      const stackRows = (data.containers || []).filter(c => c.stack === stackName);
      if (stackRows.length === 0) {
        results.innerHTML = `<div class="empty-msg"><i class="fas fa-info-circle"></i><p>No secrets audit results for this stack. Containers may be stopped, or rescan via System → Secrets.</p></div>`;
        return;
      }
      const avg = Math.round(stackRows.reduce((s, r) => s + r.score, 0) / stackRows.length);
      const critical = stackRows.reduce((s, r) => s + (r.issues || []).filter(i => i.severity === 'critical').length, 0);
      const warning = stackRows.reduce((s, r) => s + (r.issues || []).filter(i => i.severity === 'warning').length, 0);
      const scoreColor = avg >= 80 ? 'var(--green)' : avg >= 60 ? 'var(--yellow)' : 'var(--red)';

      const pill = (label, val, bg) => `<div style="padding:8px 12px;background:${bg};border-radius:6px;min-width:90px"><div style="font-size:10px;color:var(--text-dim);text-transform:uppercase">${label}</div><div style="font-size:20px;font-weight:700;margin-top:2px">${val}</div></div>`;

      const sorted = [...stackRows].sort((a, b) => a.score - b.score);
      const badge = (sev) => {
        const colors = { critical: '#ef4444', warning: '#f59e0b', info: '#64748b' };
        return `<span style="display:inline-block;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;color:#fff;background:${colors[sev] || '#64748b'}">${sev.toUpperCase()}</span>`;
      };

      results.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${pill('Avg Score', avg, `color:${scoreColor};background:rgba(148,163,184,0.15)`)}
          ${pill('Critical', critical, 'rgba(239,68,68,0.15)')}
          ${pill('Warnings', warning, 'rgba(234,179,8,0.15)')}
          ${pill('Containers', stackRows.length, 'rgba(148,163,184,0.15)')}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--bg-dim);border-bottom:1px solid var(--border)">
            <th style="padding:8px;text-align:left">Container</th>
            <th style="padding:8px;text-align:right;width:70px">Score</th>
            <th style="padding:8px;text-align:left">Top issues</th>
            <th style="width:60px"></th>
          </tr></thead>
          <tbody>
          ${sorted.map(r => {
            const topIssues = (r.issues || []).slice(0, 2);
            const issuesHtml = topIssues.length === 0
              ? '<span style="color:var(--green)">✓ clean</span>'
              : topIssues.map(i => `<div style="margin:2px 0">${badge(i.severity)} ${Utils.escapeHtml(i.message.slice(0, 100))}${i.message.length > 100 ? '…' : ''}</div>`).join('');
            const moreCount = Math.max(0, (r.issues || []).length - 2);
            return `
              <tr style="border-bottom:1px solid var(--surface2)">
                <td style="padding:8px"><strong>${Utils.escapeHtml(r.name)}</strong>${r.service ? `<div style="font-size:10px;color:var(--text-dim)">${Utils.escapeHtml(r.service)}</div>` : ''}</td>
                <td style="padding:8px;text-align:right"><strong style="color:${r.score >= 80 ? 'var(--green)' : r.score >= 60 ? 'var(--yellow)' : 'var(--red)'}">${r.score}</strong></td>
                <td style="padding:8px">${issuesHtml}${moreCount > 0 ? `<div style="color:var(--text-dim);font-size:10px">+${moreCount} more</div>` : ''}</td>
                <td style="padding:8px;text-align:right">${(r.issues || []).length > 0 ? `<button class="btn btn-xs btn-primary stack-secrets-fix" data-cid="${Utils.escapeHtml(r.id)}" data-cname="${Utils.escapeHtml(r.name)}" title="Open Remediation Wizard"><i class="fas fa-tools"></i></button>` : ''}</td>
              </tr>`;
          }).join('')}
          </tbody>
        </table>`;

      // Show stack-level remediate button only when there's anything to fix
      if (critical > 0 || warning > 0) {
        const stackBtn = mc.querySelector('#secrets-remediate-stack');
        stackBtn.style.display = '';
        stackBtn.addEventListener('click', () => {
          if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
          Modal.close();
          RemediateWizard.open({
            scope: { type: 'stack', name: stackName, hostId: Api.getHostId(), displayName: 'stack: ' + stackName },
          });
        });
      }

      mc.querySelectorAll('.stack-secrets-fix').forEach(b => b.addEventListener('click', () => {
        if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
        Modal.close();
        RemediateWizard.open({
          scope: { type: 'container', id: b.dataset.cid, hostId: Api.getHostId(), displayName: b.dataset.cname },
        });
      }));
    } catch (err) {
      results.innerHTML = `<div class="empty-msg" style="color:var(--red)">Failed to load audit: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // ─── Stack-scoped Egress Audit modal (v6.9.3) ──────────────
  //
  // Same pattern as secrets: full audit → client filter → compact table.
  // "Enable filter" per row opens the existing egress policy modal scoped
  // to container. Stack-level "Enable filter" creates a stack-wide policy.
  async _showStackEgressModal(stackName, containers) {
    const running = containers.filter(c => c.state === 'running');
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-network-wired" style="color:#06b6d4;margin-right:10px"></i>
          Egress Audit — <span style="color:var(--accent)">${Utils.escapeHtml(stackName)}</span>
        </h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" id="stack-egress-body">
        <div style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="text-muted text-sm"><i class="fas fa-box" style="margin-right:5px"></i>${running.length} running container${running.length === 1 ? '' : 's'} in scope</span>
          ${containers.length > running.length ? `<span class="badge badge-warning" style="font-size:10px"><i class="fas fa-info-circle" style="margin-right:3px"></i>${containers.length - running.length} stopped (skipped)</span>` : ''}
        </div>
        <div id="stack-egress-results"><div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading egress audit…</div></div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:space-between;align-items:center">
        <button class="btn btn-primary" id="egress-enable-stack" style="display:none"><i class="fas fa-shield-alt" style="margin-right:6px"></i>Enable filter for whole stack</button>
        <div style="display:flex;gap:8px;margin-left:auto">
          <a href="#/system" style="align-self:center;font-size:12px;color:var(--accent);text-decoration:none" data-tab-jump="egress">Open full Egress tab →</a>
          <button class="btn btn-secondary" id="modal-ok">Close</button>
        </div>
      </div>
    `, { width: '860px' });

    const mc = Modal._content;
    mc.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    mc.querySelector('#modal-ok').addEventListener('click', () => Modal.close());

    const results = mc.querySelector('#stack-egress-results');
    try {
      const [data, policies] = await Promise.all([
        Api.getEgressAudit(),
        Api.egressFilterListPolicies().catch(() => ({ policies: [] })),
      ]);
      const stackRows = (data.containers || []).filter(c => c.stack === stackName);
      if (stackRows.length === 0) {
        results.innerHTML = `<div class="empty-msg"><i class="fas fa-info-circle"></i><p>No egress audit results for this stack.</p></div>`;
        return;
      }

      // Index policies by scope for Filter column
      const polByContainer = new Map();
      const polByStack = new Map();
      for (const p of (policies.policies || [])) {
        if (p.scopeType === 'container') polByContainer.set(p.scopeKey, p);
        if (p.scopeType === 'stack') polByStack.set(p.scopeKey, p);
      }

      const reachInternet = stackRows.filter(r => r.canReachInternet).length;
      const reachIMDS = stackRows.filter(r => r.canReachIMDS).length;
      const critCount = stackRows.reduce((s, r) => s + (r.findings || []).filter(f => f.severity === 'critical').length, 0);

      const pill = (label, val, bg) => `<div style="padding:8px 12px;background:${bg};border-radius:6px;min-width:90px"><div style="font-size:10px;color:var(--text-dim);text-transform:uppercase">${label}</div><div style="font-size:20px;font-weight:700;margin-top:2px">${val}</div></div>`;

      const stackPolicy = polByStack.get(stackName);

      results.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${pill('Containers', stackRows.length, 'rgba(148,163,184,0.15)')}
          ${pill('Internet reach', reachInternet, 'rgba(249,115,22,0.15)')}
          ${pill('IMDS reach', reachIMDS, 'rgba(239,68,68,0.15)')}
          ${pill('Critical', critCount, 'rgba(239,68,68,0.15)')}
        </div>
        ${stackPolicy ? `<div style="padding:10px 12px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:12px;margin-bottom:12px"><i class="fas fa-shield-alt" style="margin-right:6px"></i>Stack policy active: <strong>${Utils.escapeHtml(stackPolicy.preset)}</strong> · ${Utils.escapeHtml(stackPolicy.mode)}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--bg-dim);border-bottom:1px solid var(--border)">
            <th style="padding:8px;text-align:left">Container</th>
            <th style="padding:8px;text-align:left;width:110px">Network</th>
            <th style="padding:8px;text-align:left;width:140px">Reachability</th>
            <th style="padding:8px;text-align:right;width:70px">Score</th>
            <th style="padding:8px;text-align:left;width:180px">Filter</th>
          </tr></thead>
          <tbody>
          ${stackRows.map(r => {
            const verdict = r.canReachInternet
              ? (r.canReachIMDS ? '<span style="color:#ef4444">Internet + IMDS</span>' : '<span style="color:#f59e0b">Internet</span>')
              : '<span style="color:var(--green)">Isolated</span>';
            const fullId = r.fullId || r.id;
            const policy = polByContainer.get(fullId) || polByContainer.get(r.id) || stackPolicy;
            const filterCell = policy
              ? `<span style="padding:2px 6px;background:rgba(59,130,246,0.15);border-radius:3px;font-size:10px;font-weight:600">${Utils.escapeHtml(policy.preset)} · ${Utils.escapeHtml(policy.mode)}</span>`
              : `<button class="btn btn-xs btn-primary stack-egress-enable" data-cid="${Utils.escapeHtml(fullId)}" data-cname="${Utils.escapeHtml(r.name)}"><i class="fas fa-shield-alt" style="margin-right:4px"></i>Enable</button>`;
            return `
              <tr style="border-bottom:1px solid var(--surface2)">
                <td style="padding:8px"><strong>${Utils.escapeHtml(r.name)}</strong>${r.service ? `<div style="font-size:10px;color:var(--text-dim)">${Utils.escapeHtml(r.service)}</div>` : ''}</td>
                <td style="padding:8px"><code style="font-size:11px">${Utils.escapeHtml(r.networkMode || 'default')}</code></td>
                <td style="padding:8px">${verdict}</td>
                <td style="padding:8px;text-align:right"><strong style="color:${r.score >= 80 ? 'var(--green)' : r.score >= 60 ? 'var(--yellow)' : 'var(--red)'}">${r.score}</strong></td>
                <td style="padding:8px">${filterCell}</td>
              </tr>`;
          }).join('')}
          </tbody>
        </table>`;

      if (!stackPolicy && reachInternet > 0) {
        const stackBtn = mc.querySelector('#egress-enable-stack');
        stackBtn.style.display = '';
        stackBtn.addEventListener('click', () => {
          Modal.close();
          // Navigate to System → Egress so user sees the full filter modal with stack scope
          Toast.info('Opening System → Egress to configure stack-wide filter');
          location.hash = '#/system';
          setTimeout(() => document.querySelector('[data-tab=egress]')?.click(), 250);
        });
      }

      mc.querySelectorAll('.stack-egress-enable').forEach(b => b.addEventListener('click', () => {
        Modal.close();
        Toast.info(`Opening System → Egress for ${b.dataset.cname}`);
        location.hash = '#/system';
        setTimeout(() => document.querySelector('[data-tab=egress]')?.click(), 250);
      }));
    } catch (err) {
      results.innerHTML = `<div class="empty-msg" style="color:var(--red)">Failed to load audit: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },
};

// Handle action button clicks via event delegation (containers only)
const _containerActions = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'remove', 'edit-meta']);
document.addEventListener('click', (e) => {
  const basket = e.target.closest('[data-basket-container]');
  if (basket) {
    e.stopPropagation();
    SelectionBasket.add('container', Api.getHostId() || null, basket.dataset.basketContainer, basket.dataset.name || basket.dataset.basketContainer)
      .catch(error => Toast.error(error.message));
    return;
  }
  const btn = e.target.closest('[data-action][data-id]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (!_containerActions.has(action)) return;
  e.stopPropagation();
  const id = btn.dataset.id;

  if (action === 'edit-meta') {
    const name = btn.dataset.name;
    if (!name) return;
    // v8.1.1 — _editMetaDialog lives in the lazy-loaded container-detail.js
    // module (split in v6.16.0). When the user clicks "Edit metadata" from
    // the list view without ever opening a detail page, the method doesn't
    // exist yet. Load the detail module first, then call.
    (async () => {
      try {
        await ContainersPage._loadDetailModule();
        await ContainersPage._editMetaDialog(name);
      } catch (err) {
        Toast.error('Could not open meta editor: ' + err.message);
      }
    })();
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
