/* ═══════════════════════════════════════════════════
   logs.js — Centralized Log Explorer Page
   ═══════════════════════════════════════════════════ */
'use strict';

const LogsPage = {
  _refreshTimer: null,
  _lastLogs: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-scroll" style="color:var(--accent)"></i> Log Explorer</h2>
        <div class="page-actions">
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
            <input type="text" id="logs-search" placeholder="Search / regex...">
          </div>
          <button class="btn btn-sm btn-secondary" id="logs-refresh"><i class="fas fa-sync-alt"></i></button>
          <button class="btn btn-sm btn-secondary" id="logs-download" title="Download logs"><i class="fas fa-download"></i></button>
        </div>
      </div>
      <div id="logs-container-filter" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>
      <pre class="log-viewer" id="logs-output" style="height:calc(100vh - 220px);overflow:auto;font-size:12px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">Loading...</pre>
    `;

    // Load container list for filter buttons
    try {
      const containers = await Api.getContainers(false);
      const filterEl = container.querySelector('#logs-container-filter');
      filterEl.innerHTML = `
        <button class="btn btn-xs filter-preset active" data-log-container="">All Containers</button>
        ${containers.filter(c => c.state === 'running').map(c => `
          <button class="btn btn-xs filter-preset" data-log-container="${c.id?.substring(0,12)}">${Utils.escapeHtml(c.name)}</button>
        `).join('')}
      `;
      filterEl.querySelectorAll('[data-log-container]').forEach(btn => {
        btn.addEventListener('click', (event) => {
          // Toggle multi-select with Ctrl key
          if (!event.ctrlKey) {
            filterEl.querySelectorAll('[data-log-container]').forEach(b => b.classList.remove('active'));
          }
          btn.classList.toggle('active');
          // If "All" is clicked, deselect others
          if (btn.dataset.logContainer === '') {
            filterEl.querySelectorAll('[data-log-container]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          } else {
            filterEl.querySelector('[data-log-container=""]').classList.remove('active');
          }
          this._loadLogs();
        });
      });
    } catch { /* ignore */ }

    container.querySelector('#logs-level').addEventListener('change', () => this._loadLogs());
    container.querySelector('#logs-since').addEventListener('change', () => this._loadLogs());
    container.querySelector('#logs-tail').addEventListener('change', () => this._loadLogs());
    container.querySelector('#logs-search').addEventListener('input', Utils.debounce(() => this._loadLogs(), 400));
    container.querySelector('#logs-refresh').addEventListener('click', () => this._loadLogs());
    container.querySelector('#logs-download').addEventListener('click', () => this._downloadLogs());

    await this._loadLogs();
  },

  async _loadLogs() {
    const output = document.getElementById('logs-output');
    if (!output) return;
    output.innerHTML = '<span class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading logs from all containers...</span>';

    const level = document.getElementById('logs-level')?.value || 'all';
    const sinceVal = document.getElementById('logs-since')?.value || '';
    const tail = document.getElementById('logs-tail')?.value || '100';
    const search = document.getElementById('logs-search')?.value?.trim() || '';

    // Get selected containers
    const activeBtns = document.querySelectorAll('#logs-container-filter .filter-preset.active');
    let containerIds = '';
    activeBtns.forEach(btn => {
      if (btn.dataset.logContainer) containerIds += (containerIds ? ',' : '') + btn.dataset.logContainer;
    });

    // Calculate since timestamp
    let since = '';
    if (sinceVal) {
      const hours = { '1h': 1, '6h': 6, '24h': 24 }[sinceVal] || 0;
      if (hours) since = new Date(Date.now() - hours * 3600000).toISOString();
    }

    try {
      const data = await Api.getMultiLogs({ containers: containerIds, tail, since, search, level });
      const logs = data.logs || [];

      if (logs.length === 0) {
        output.innerHTML = '<span class="text-muted">No log entries found matching your filters.</span>';
        return;
      }

      // Assign colors per container
      const containerColors = {};
      const palette = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#bc8cff'];
      let colorIdx = 0;
      logs.forEach(l => {
        if (!containerColors[l.container]) {
          containerColors[l.container] = palette[colorIdx % palette.length];
          colorIdx++;
        }
      });

      this._lastLogs = logs;

      output.innerHTML = logs.map(l => {
        const color = containerColors[l.container] || 'var(--text-dim)';
        const severityClass = l.severity === 'error' ? 'log-error' : l.severity === 'warn' ? 'log-warn' : l.severity === 'debug' ? 'log-debug' : '';
        const ts = l.ts ? `<span class="text-muted" style="font-size:10px;min-width:19ch;display:inline-block">${Utils.escapeHtml(l.ts)}</span>` : '';
        const tag = `<span style="color:${color};font-weight:600;min-width:16ch;display:inline-block;font-size:11px">[${Utils.escapeHtml(l.container)}]</span>`;
        let msg = Utils.escapeHtml(l.msg);
        if (search) {
          try {
            const regex = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            msg = msg.replace(regex, '<mark class="log-highlight">$1</mark>');
          } catch { /* invalid regex, skip highlighting */ }
        }
        return `<span class="log-line ${severityClass}">${ts} ${tag} ${msg}</span>`;
      }).join('\n');

      // Auto-scroll to bottom
      output.scrollTop = output.scrollHeight;
    } catch (err) {
      output.innerHTML = `<span style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</span>`;
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
    Toast.success('Logs downloaded');
  },

  destroy() {
    clearInterval(this._refreshTimer);
  },
};

window.LogsPage = LogsPage;
