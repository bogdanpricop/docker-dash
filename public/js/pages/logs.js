/* ═══════════════════════════════════════════════════
   logs.js — Centralized Log Explorer Page
   ═══════════════════════════════════════════════════ */
'use strict';

const LogsPage = {
  _refreshTimer: null,
  _lastLogs: null,
  _selectedContainers: new Set(),
  _allContainers: [],
  _collapsed: {},
  _sidebarTab: 'tree', // 'tree' | 'tags'

  async render(container, params = {}) {
    const target = /^container\/([a-f0-9]{12,64})$/.exec(params.id || '')?.[1];
    this._mode = target ? 'single' : 'multi';
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-scroll" style="color:var(--accent)"></i> Log Explorer</h2>
        <div class="page-actions">
          <select id="logs-mode" class="form-control" aria-label="Log view">
            <option value="single">Single</option><option value="multi">Multi</option><option value="grouped">Grouped</option>
          </select>
          <select id="logs-level" class="form-control" style="width:auto;padding:4px 8px;font-size:12px">
            <option value="all">All Levels</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <select id="logs-since" class="form-control" style="width:auto;padding:4px 8px;font-size:12px">
            <option value="">All time</option>
            <option value="1h" selected>Last 1h</option>
            <option value="6h">Last 6h</option>
            <option value="24h">Last 24h</option>
          </select>
          <select id="logs-tail" class="form-control" style="width:auto;padding:4px 8px;font-size:12px">
            <option value="50">50 lines/container</option>
            <option value="100" selected>100 lines</option>
            <option value="200">200 lines</option>
            <option value="500">500 lines</option>
          </select>
          <div class="search-box" style="max-width:220px">
            <i class="fas fa-search"></i>
            <input type="text" id="logs-search" placeholder="Search logs…" aria-label="Search logs">
          </div>
          <button class="btn btn-sm btn-secondary" id="logs-refresh"><i class="fas fa-sync-alt"></i></button>
          <button class="btn btn-sm btn-secondary" id="logs-download" title="Download logs"><i class="fas fa-download"></i></button>
        </div>
      </div>
      <div class="log-viewer-controls" id="explorer-log-controls"></div>
      <div class="text-xs text-muted" id="logs-refresh-status"></div>
      <div style="display:flex;gap:0;height:calc(100vh - 160px);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
        <div id="logs-sidebar" style="width:20%;min-width:180px;max-width:280px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden">
          <div style="display:flex;border-bottom:1px solid var(--border)">
            <button class="logs-sidebar-tab active" data-logs-tab="tree" style="flex:1;padding:6px;font-size:11px;background:none;border:none;color:var(--text);cursor:pointer;border-bottom:2px solid var(--accent)">
              <i class="fas fa-sitemap" style="margin-right:4px"></i>Tree
            </button>
            <button class="logs-sidebar-tab" data-logs-tab="tags" style="flex:1;padding:6px;font-size:11px;background:none;border:none;color:var(--text-dim);cursor:pointer;border-bottom:2px solid transparent">
              <i class="fas fa-tags" style="margin-right:4px"></i>Tags
            </button>
          </div>
          <div style="padding:4px 8px;border-bottom:1px solid var(--border);display:flex;gap:4px">
            <button class="btn-icon" id="logs-select-all" title="Select all" style="font-size:10px"><i class="fas fa-check-double"></i></button>
            <button class="btn-icon" id="logs-deselect-all" title="Deselect all" style="font-size:10px"><i class="fas fa-times"></i></button>
            <button class="btn-icon" id="logs-collapse-all" title="Collapse all" style="font-size:10px"><i class="fas fa-compress-alt"></i></button>
            <button class="btn-icon" id="logs-expand-all" title="Expand all" style="font-size:10px"><i class="fas fa-expand-alt"></i></button>
          </div>
          <div id="logs-container-panel" style="flex:1;overflow-y:auto;padding:4px 0;font-size:12px"></div>
        </div>
        <pre class="log-viewer" id="logs-output" style="flex:1;margin:0;height:100%;overflow:auto;font-size:12px;padding:12px;background:var(--surface2);border:none;border-radius:0">Loading...</pre>
      </div>
    `;

    const output = container.querySelector('#logs-output');
    this._viewer = new LogViewer(container.querySelector('#explorer-log-controls'), output, paused => {
      if (paused) {
        this._loadSequence = (this._loadSequence || 0) + 1;
        container.querySelector('#logs-refresh-status').textContent = 'Paused';
      } else this._loadLogs();
    });
    const mode = container.querySelector('#logs-mode');
    mode.value = this._mode;
    mode.addEventListener('change', () => {
      this._mode = mode.value;
      if (this._mode === 'single') this._selectedContainers = new Set([...this._selectedContainers].slice(0, 1));
      this._renderSidebar();
      this._loadLogs();
    });

    // Load containers and build tree
    try {
      const { containers, host } = await Api.get('/containers?context=1');
      if (!output.isConnected) return;
      this._hostId = host.id;
      this._allContainers = containers.filter(c => c.state === 'running' || c.id.startsWith(target || '__none__'));
      const candidates = target ? this._allContainers.filter(c => c.id.startsWith(target)) : this._allContainers.slice(0, 25);
      this._selectedContainers = new Set(candidates.map(c => c.id.substring(0, 12)));
      this._renderSidebar();
    } catch (error) {
      if (output.isConnected) output.textContent = error.message;
      return;
    }

    // Sidebar tab switching
    container.querySelectorAll('.logs-sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.logs-sidebar-tab').forEach(t => {
          t.classList.remove('active');
          t.style.borderBottomColor = 'transparent';
          t.style.color = 'var(--text-dim)';
        });
        tab.classList.add('active');
        tab.style.borderBottomColor = 'var(--accent)';
        tab.style.color = 'var(--text)';
        this._sidebarTab = tab.dataset.logsTab;
        this._renderSidebar();
      });
    });

    // Toolbar buttons
    container.querySelector('#logs-select-all').addEventListener('click', () => {
      this._selectedContainers = new Set(this._allContainers.slice(0, this._mode === 'single' ? 1 : 25).map(c => c.id.substring(0, 12)));
      this._renderSidebar();
      this._loadLogs();
    });
    container.querySelector('#logs-deselect-all').addEventListener('click', () => {
      this._selectedContainers.clear();
      this._renderSidebar();
      this._loadLogs();
    });
    container.querySelector('#logs-collapse-all').addEventListener('click', () => {
      Object.keys(this._collapsed).forEach(k => { this._collapsed[k] = true; });
      // Collapse all stacks
      this._allContainers.forEach(c => {
        const stack = c.stack || c.labels?.['com.docker.compose.project'] || '_standalone';
        this._collapsed[stack] = true;
      });
      this._renderSidebar();
    });
    container.querySelector('#logs-expand-all').addEventListener('click', () => {
      this._collapsed = {};
      this._renderSidebar();
    });

    container.querySelector('#logs-level').addEventListener('change', () => this._loadLogs());
    container.querySelector('#logs-since').addEventListener('change', () => this._loadLogs());
    container.querySelector('#logs-tail').addEventListener('change', () => this._loadLogs());
    container.querySelector('#logs-search').addEventListener('input', Utils.debounce(() => this._loadLogs(), 400));
    container.querySelector('#logs-refresh').addEventListener('click', () => this._loadLogs());
    container.querySelector('#logs-download').addEventListener('click', () => this._downloadLogs());

    await this._loadLogs();
    if (output.isConnected) this._refreshTimer = setInterval(() => this._loadLogs(), 8000);
  },

  _selectContainer(id, selected) {
    if (!selected) this._selectedContainers.delete(id);
    else if (this._mode === 'single') this._selectedContainers = new Set([id]);
    else if (this._selectedContainers.size < 25) this._selectedContainers.add(id);
  },

  _renderSidebar() {
    const panel = document.getElementById('logs-container-panel');
    if (!panel) return;

    if (this._sidebarTab === 'tree') {
      this._renderTree(panel);
    } else {
      this._renderTags(panel);
    }
  },

  _renderTree(panel) {
    // Group by stack
    const stacks = {};
    this._allContainers.forEach(c => {
      const stack = c.stack || c.labels?.['com.docker.compose.project'] || '_standalone';
      if (!stacks[stack]) stacks[stack] = [];
      stacks[stack].push(c);
    });

    const stackNames = Object.keys(stacks).sort((a, b) => {
      if (a === '_standalone') return 1;
      if (b === '_standalone') return -1;
      return a.localeCompare(b);
    });

    panel.innerHTML = stackNames.map(stack => {
      const containers = stacks[stack];
      const label = stack === '_standalone' ? 'Standalone' : Utils.escapeHtml(stack);
      const isCollapsed = !!this._collapsed[stack];
      const allSelected = containers.every(c => this._selectedContainers.has(c.id?.substring(0, 12)));
      const someSelected = containers.some(c => this._selectedContainers.has(c.id?.substring(0, 12)));

      return `
        <div class="logs-tree-stack">
          <div class="logs-tree-header" data-stack="${Utils.escapeHtml(stack)}" style="display:flex;align-items:center;gap:4px;padding:3px 8px;cursor:pointer;user-select:none;color:var(--text-bright);font-weight:600;font-size:11px">
            <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="font-size:9px;color:var(--text-dim);width:12px;text-align:center"></i>
            <input type="checkbox" class="logs-stack-check" data-stack="${Utils.escapeHtml(stack)}" ${allSelected ? 'checked' : ''} ${someSelected && !allSelected ? 'style="opacity:0.5"' : ''}>
            <i class="fas fa-layer-group" style="color:var(--accent);font-size:10px"></i>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
            <span style="color:var(--text-dim);font-size:10px">${containers.length}</span>
          </div>
          <div class="logs-tree-body" data-stack-body="${Utils.escapeHtml(stack)}" style="${isCollapsed ? 'display:none' : ''}">
            ${containers.map(c => {
              const cid = c.id?.substring(0, 12);
              const selected = this._selectedContainers.has(cid);
              return `
                <div class="logs-tree-leaf" style="display:flex;align-items:center;gap:4px;padding:2px 8px 2px 28px;cursor:pointer;font-size:11px;color:${selected ? 'var(--text)' : 'var(--text-dim)'}" data-cid="${cid}">
                  <input type="checkbox" class="logs-leaf-check" data-cid="${cid}" ${selected ? 'checked' : ''}>
                  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0"></span>
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(c.name)}</span>
                </div>`;
            }).join('')}
          </div>
        </div>`;
    }).join('');

    // Wire stack collapse/expand
    panel.querySelectorAll('.logs-tree-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.type === 'checkbox') return; // Don't toggle on checkbox click
        const stack = header.dataset.stack;
        this._collapsed[stack] = !this._collapsed[stack];
        const body = panel.querySelector(`[data-stack-body="${CSS.escape(stack)}"]`);
        if (body) body.style.display = this._collapsed[stack] ? 'none' : '';
        const icon = header.querySelector('i.fa-chevron-down, i.fa-chevron-right');
        if (icon) icon.className = `fas ${this._collapsed[stack] ? 'fa-chevron-right' : 'fa-chevron-down'}`;
      });
    });

    // Wire stack checkboxes (select/deselect all containers in stack)
    panel.querySelectorAll('.logs-stack-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const stack = cb.dataset.stack;
        const containers = stacks[stack] || [];
        const candidates = cb.checked && this._mode === 'single' ? containers.slice(0, 1) : containers;
        candidates.forEach(c => this._selectContainer(c.id.substring(0, 12), cb.checked));
        this._renderSidebar();
        this._loadLogs();
      });
    });

    // Wire leaf checkboxes
    panel.querySelectorAll('.logs-leaf-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const cid = cb.dataset.cid;
        this._selectContainer(cid, cb.checked);
        this._renderSidebar();
        this._loadLogs();
      });
    });

    // Wire leaf row click (toggle checkbox)
    panel.querySelectorAll('.logs-tree-leaf').forEach(leaf => {
      leaf.addEventListener('click', (e) => {
        if (e.target.type === 'checkbox') return;
        const cid = leaf.dataset.cid;
        this._selectContainer(cid, !this._selectedContainers.has(cid));
        this._renderSidebar();
        this._loadLogs();
      });
    });
  },

  _renderTags(panel) {
    // Flat tag view (original style)
    panel.innerHTML = `
      <div style="padding:6px 8px">
        <div class="logs-tag-item active" data-log-tag="" style="display:inline-block;margin:2px;padding:3px 8px;border-radius:10px;font-size:11px;cursor:pointer;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)">All</div>
        ${this._allContainers.map(c => {
          const cid = c.id?.substring(0, 12);
          const selected = this._selectedContainers.has(cid);
          return `<div class="logs-tag-item ${selected ? 'active' : ''}" data-log-tag="${cid}" style="display:inline-block;margin:2px;padding:3px 8px;border-radius:10px;font-size:11px;cursor:pointer;background:${selected ? 'var(--accent-dim)' : 'var(--surface3)'};color:${selected ? 'var(--accent)' : 'var(--text-dim)'};border:1px solid ${selected ? 'var(--accent)' : 'var(--border)'}">${Utils.escapeHtml(c.name)}</div>`;
        }).join('')}
      </div>
    `;

    panel.querySelectorAll('.logs-tag-item').forEach(tag => {
      tag.addEventListener('click', () => {
        const cid = tag.dataset.logTag;
        if (cid === '') {
          // Select all
          this._selectedContainers = new Set(this._allContainers.slice(0, this._mode === 'single' ? 1 : 25).map(c => c.id.substring(0, 12)));
        } else {
          this._selectContainer(cid, !this._selectedContainers.has(cid));
        }
        this._renderSidebar();
        this._loadLogs();
      });
    });
  },

  async _loadLogs() {
    const viewer = this._viewer;
    if (!viewer?.output.isConnected || viewer.paused) return;
    const output = viewer.output;
    const status = document.getElementById('logs-refresh-status');
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    const level = document.getElementById('logs-level').value;
    const range = Number.parseInt(document.getElementById('logs-since').value, 10);
    const since = range ? new Date(Date.now() - range * 3600000).toISOString() : '';
    const tail = document.getElementById('logs-tail').value;
    const search = document.getElementById('logs-search').value.trim();
    const containers = [...this._selectedContainers].join(',');
    if (!containers) {
      this._lastLogs = [];
      viewer.set([], search, this._mode);
      output.textContent = 'Select a container from the sidebar.';
      status.textContent = '';
      return;
    }
    try {
      const { logs, truncated } = await Api.getMultiLogs({ containers, tail, since, search, level, hostId: this._hostId });
      if (!output.isConnected || this._loadSequence !== sequence) return;
      if (JSON.stringify(logs) !== JSON.stringify(this._lastLogs) || this._renderedMode !== this._mode || this._renderedSearch !== search) {
        this._lastLogs = logs;
        this._renderedMode = this._mode;
        this._renderedSearch = search;
        viewer.set(logs, search, this._mode);
        if (!logs.length) output.textContent = 'No log entries match your filters.';
      }
      status.textContent = truncated ? 'Snapshot limit reached. Narrow the filters to see more detail.'
        : `Snapshot at ${new Date().toLocaleTimeString()} · up to 25 containers`;
    } catch (error) {
      if (output.isConnected && this._loadSequence === sequence) status.textContent = 'Could not refresh logs · ' + error.message;
    }
  },

  _downloadLogs() {
    if (!this._lastLogs?.length) { Toast.warning('No logs to download'); return; }
    const tsv = this._lastLogs.map(l => `${l.ts}\t${l.container}\t${l.severity}\t${l.msg}`).join('\n');
    const blob = new Blob([tsv], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `docker-dash-logs-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    Toast.success('Logs downloaded');
  },

  destroy() {
    clearInterval(this._refreshTimer);
    this._selectedContainers.clear();
    this._lastLogs = null;
    this._viewer = null;
    this._loadSequence = (this._loadSequence || 0) + 1;
  },
};

window.LogsPage = LogsPage;
