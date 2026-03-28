/* ═══════════════════════════════════════════════════
   pages/dashboard.js — Dashboard Page
   ═══════════════════════════════════════════════════ */
'use strict';

const DashboardPage = {
  _charts: {},
  _refreshTimer: null,
  _statsUnsub: null,
  _hiddenWidgets: [],
  _widgetOrder: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-chart-pie"></i> ${i18n.t('pages.dashboard.title')}</h2>
          <div class="page-subtitle">${i18n.t('pages.dashboard.subtitle')}</div>
        </div>
        <div class="page-actions" style="align-items:center">
          <a href="https://github.com/bogdanpricop/docker-dash" target="_blank" rel="noopener" class="text-muted text-xs" style="margin-right:8px" title="Docker Dash on GitHub"><i class="fab fa-github"></i></a>
          <span class="ws-status" id="ws-indicator">
            <i class="fas fa-circle"></i> <span>---</span>
          </span>
          <button class="btn btn-sm btn-secondary" id="dash-configure" title="Configure widgets"><i class="fas fa-sliders-h"></i></button>
          <button class="prune-help-btn" id="dash-help" title="${i18n.t('pages.dashboard.helpTooltip')}">?</button>
          <span class="text-muted text-sm" style="margin-right:8px"><i class="fas fa-clock" style="margin-right:4px"></i><span id="dash-last-updated">—</span></span>
          <button class="btn btn-sm" id="dash-refresh">
            <i class="fas fa-sync-alt"></i> ${i18n.t('common.refresh')}
          </button>
        </div>
      </div>

      <div id="dash-error" style="display:none;margin-bottom:12px"></div>

      <!-- Summary Cards -->
      <div class="stat-cards" id="stat-cards">
        <div class="stat-card">
          <div class="stat-icon green"><i class="fas fa-play-circle"></i></div>
          <div class="stat-body">
            <div class="stat-value" id="stat-running">---</div>
            <div class="stat-label">${i18n.t('pages.dashboard.running')}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon red"><i class="fas fa-stop-circle"></i></div>
          <div class="stat-body">
            <div class="stat-value" id="stat-stopped">---</div>
            <div class="stat-label">${i18n.t('pages.dashboard.stopped')}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon purple"><i class="fas fa-layer-group"></i></div>
          <div class="stat-body">
            <div class="stat-value" id="stat-images">---</div>
            <div class="stat-label">${i18n.t('pages.dashboard.images')}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon volumes"><i class="fas fa-database"></i></div>
          <div class="stat-body">
            <div class="stat-value" id="stat-volumes">---</div>
            <div class="stat-label">${i18n.t('pages.dashboard.volumes')}</div>
          </div>
        </div>
      </div>

      <!-- Host Info -->
      <div class="card" id="host-info-card" style="margin-bottom:16px">
        <div class="card-body" style="padding:10px 16px">
          <div id="host-info-bar" class="host-info-bar">${i18n.t('common.loading')}</div>
        </div>
      </div>

      <!-- Charts Row (draggable) -->
      <div class="dash-grid" id="dash-widgets">
        <div class="card dash-widget" draggable="true" data-widget="states">
          <div class="card-header"><span class="widget-drag-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span><h3><i class="fas fa-chart-pie text-dim" style="margin-right:8px"></i>${i18n.t('pages.dashboard.containerStates')}</h3></div>
          <div class="card-body chart-container">
            <canvas id="chart-states"></canvas>
          </div>
        </div>
        <div class="card dash-widget" draggable="true" data-widget="cpu">
          <div class="card-header"><span class="widget-drag-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span><h3><i class="fas fa-microchip text-dim" style="margin-right:8px"></i>${i18n.t('pages.dashboard.topCpu')}</h3></div>
          <div class="card-body chart-container">
            <canvas id="chart-cpu"></canvas>
          </div>
        </div>
        <div class="card dash-widget" draggable="true" data-widget="memory">
          <div class="card-header"><span class="widget-drag-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span><h3><i class="fas fa-memory text-dim" style="margin-right:8px"></i>${i18n.t('pages.dashboard.topMemory')}</h3></div>
          <div class="card-body chart-container">
            <canvas id="chart-memory"></canvas>
          </div>
        </div>
      </div>

      <!-- Resource History (live) -->
      <div class="dash-grid">
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-microchip text-dim" style="margin-right:8px"></i>CPU History</h3><span class="text-dim text-sm" id="cpu-history-label">Last 10 minutes</span></div>
          <div class="card-body chart-container" style="height:200px"><canvas id="chart-cpu-history"></canvas></div>
        </div>
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-memory text-dim" style="margin-right:8px"></i>Memory History</h3><span class="text-dim text-sm" id="mem-history-label">Last 10 minutes</span></div>
          <div class="card-body chart-container" style="height:200px"><canvas id="chart-mem-history"></canvas></div>
        </div>
      </div>

      <!-- Recent Events -->
      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <h3><i class="fas fa-stream text-dim" style="margin-right:8px"></i>${i18n.t('pages.dashboard.recentEvents')}</h3>
          <span class="text-dim text-sm">${i18n.t('pages.dashboard.liveUpdates')}</span>
        </div>
        <div class="card-body" style="padding:0">
          <div id="events-list" class="events-list" style="padding:12px 16px">${i18n.t('common.loading')}</div>
        </div>
      </div>
    `;

    container.querySelector('#dash-refresh').addEventListener('click', () => this._load());
    container.querySelector('#dash-help').addEventListener('click', () => this._showHelp());
    container.querySelector('#dash-configure').addEventListener('click', () => this._showConfigureWidgets());
    this._updateWsIndicator();

    this._statsUnsub = WS.on('event', (msg) => {
      this._prependEvent(msg.data);
    });

    WS.on('_connected', () => this._updateWsIndicator());
    WS.on('_disconnected', () => this._updateWsIndicator());

    // Drag & drop widget reordering
    this._initDragDrop();

    // Restore saved widget order
    this._restoreWidgetOrder();

    await this._load();
    this._refreshTimer = setInterval(() => this._load(), 30000);

    this._cpuHistory = [];
    this._memHistory = [];

    WS.subscribe('stats:overview');
    this._statsHandler = WS.on('stats:overview', (msg) => {
      const overview = msg.data;
      if (overview) {
        this._renderCpuChart(overview);
        this._renderMemoryChart(overview);
        this._appendHistory(overview);
      }
    });
  },

  async _load() {
    try {
      const [containers, images, volumes, overview, sysInfo] = await Promise.all([
        Api.getContainers(true),
        Api.getImages(),
        Api.getVolumes(),
        Api.getStatsOverview().catch(() => null),
        Api.getSystemInfo().catch(() => null),
      ]);

      // Backend returns lowercase keys: state, not State
      const running = containers.filter(c => c.state === 'running').length;
      const stopped = containers.length - running;

      this._animateNumber('stat-running', running);
      this._animateNumber('stat-stopped', stopped);
      this._animateNumber('stat-images', images.length);
      // volumes is an array from the API (listVolumes returns mapped array)
      const volList = Array.isArray(volumes) ? volumes : (volumes.Volumes || volumes || []);
      this._animateNumber('stat-volumes', volList.length);

      this._renderStateChart(containers);
      this._renderCpuChart(overview);
      this._renderMemoryChart(overview);
      this._renderEvents();
      this._renderHostInfo(sysInfo);

      // Update "last updated" indicator
      const updEl = document.getElementById('dash-last-updated');
      if (updEl) updEl.textContent = new Date().toLocaleTimeString();
      const errBanner = document.getElementById('dash-error');
      if (errBanner) errBanner.style.display = 'none';
    } catch (err) {
      console.error('Dashboard load error:', err);
      // Show user-facing error banner
      const banner = document.getElementById('dash-error');
      if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = `<div style="padding:12px 16px;background:rgba(248,81,73,0.1);border:1px solid var(--red);border-radius:var(--radius);color:var(--red);display:flex;align-items:center;gap:8px">
          <i class="fas fa-exclamation-triangle"></i>
          <span>Failed to load dashboard data. <button class="btn btn-sm" style="margin-left:8px" onclick="DashboardPage._load()">Retry</button></span>
        </div>`;
      }
    }
  },

  _animateNumber(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = target;
  },

  _renderStateChart(containers) {
    const states = {};
    containers.forEach(c => {
      const s = c.state || 'unknown';
      states[s] = (states[s] || 0) + 1;
    });

    const labels = Object.keys(states);
    const data = Object.values(states);
    const colors = labels.map(s => {
      const map = {
        running: '#3fb950', exited: '#545d68', paused: '#d29922',
        created: '#388bfd', dead: '#f85149', restarting: '#db6d28',
      };
      return map[s] || '#545d68';
    });

    this._renderDoughnut('chart-states', labels, data, colors);
  },

  _renderCpuChart(overview) {
    const canvas = document.getElementById('chart-cpu');
    if (!canvas) return;
    const topCpu = (overview?.topCpu || overview?.containers || [])
      .map(c => ({ ...c, cpu_percent: c.cpu_percent ?? c.cpu, container_name: c.container_name ?? c.name }))
      .sort((a, b) => b.cpu_percent - a.cpu_percent)
      .slice(0, 5);
    this._renderBarChart('chart-cpu', topCpu, 'cpu_percent', '%', Utils.cpuColor);
  },

  _renderMemoryChart(overview) {
    const canvas = document.getElementById('chart-memory');
    if (!canvas) return;
    const topMem = (overview?.topMemory || overview?.containers || [])
      .map(c => ({ ...c, mem_usage: c.mem_usage ?? c.memUsage, mem_percent: c.mem_percent ?? c.memPercent, container_name: c.container_name ?? c.name }))
      .sort((a, b) => (b.mem_usage ?? b.memUsage ?? 0) - (a.mem_usage ?? a.memUsage ?? 0))
      .slice(0, 5);
    const data = topMem.map(c => ({ ...c, memory_percent: c.mem_percent ?? c.memPercent ?? 0 }));
    this._renderBarChart('chart-memory', data, 'memory_percent', '%', Utils.memColor);
  },

  _renderDoughnut(id, labels, data, colors) {
    if (this._charts[id]) this._charts[id].destroy();
    const canvas = document.getElementById(id);
    if (!canvas) return;

    this._charts[id] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverBorderWidth: 2, hoverBorderColor: '#f0f6fc' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: '#545d68', padding: 14, usePointStyle: true, pointStyle: 'circle' } },
        },
      },
    });
  },

  _renderBarChart(id, items, valueKey, suffix, colorFn) {
    if (this._charts[id]) this._charts[id].destroy();
    const canvas = document.getElementById(id);
    if (!canvas) return;

    if (!items || items.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#545d68';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(i18n.t('pages.dashboard.noDataYet'), canvas.width / 2, canvas.height / 2);
      return;
    }

    const labels = items.map(i => i.container_name || i.name || Utils.shortId(i.container_id));
    const data = items.map(i => parseFloat(i[valueKey]) || 0);
    const colors = data.map(v => colorFn ? colorFn(v) : '#388bfd');

    this._charts[id] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 36 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grid: { color: 'rgba(48,54,61,0.3)' }, ticks: { callback: v => v + suffix, color: '#545d68' } },
          y: { grid: { display: false }, ticks: { color: '#b1bac4', font: { family: "'JetBrains Mono', monospace", size: 11 } } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (ctxArr) => {
                const idx = ctxArr[0]?.dataIndex;
                const item = items[idx];
                const name = item?.container_name || item?.name || '';
                const shortId = Utils.shortId(item?.container_id || '');
                return name ? `${name} (${shortId})` : shortId;
              },
              label: ctx => ctx.raw.toFixed(1) + suffix,
            },
          },
        },
        onClick: (_event, elements) => {
          if (elements.length > 0) {
            const idx = elements[0].index;
            const item = items[idx];
            if (item?.container_id) {
              location.hash = `#/containers/${item.container_id}`;
            }
          }
        },
        onHover: (event, elements) => {
          event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
        },
      },
    });
  },

  _renderHostInfo(info) {
    const el = document.getElementById('host-info-bar');
    if (!el || !info) return;
    const uptime = info.uptime ? Utils.formatDuration(info.uptime) : '—';
    const mem = info.memTotal ? Utils.formatBytes(info.memTotal) : '—';
    el.innerHTML = `
      <span class="host-info-item"><i class="fas fa-server"></i> ${Utils.escapeHtml(info.hostname || '—')}</span>
      <span class="host-info-sep">|</span>
      <span class="host-info-item"><i class="fas fa-microchip"></i> ${info.cpus || '—'} CPUs</span>
      <span class="host-info-sep">|</span>
      <span class="host-info-item"><i class="fas fa-memory"></i> ${mem} RAM</span>
      <span class="host-info-sep">|</span>
      <span class="host-info-item"><i class="fab fa-docker"></i> ${Utils.escapeHtml(info.dockerVersion || '—')}</span>
      <span class="host-info-sep">|</span>
      <span class="host-info-item"><i class="fas fa-hdd"></i> ${Utils.escapeHtml(info.storageDriver || '—')}</span>
      <span class="host-info-sep">|</span>
      <span class="host-info-item"><i class="fas fa-clock"></i> ${i18n.t('pages.dashboard.uptime')}: ${uptime}</span>
      <span class="host-info-sep">|</span>
      <span class="host-info-item text-muted"><i class="fas fa-linux"></i> ${Utils.escapeHtml(info.os || '—')}</span>
    `;
  },

  async _renderEvents() {
    const el = document.getElementById('events-list');
    if (!el) return;
    try {
      const res = await Api.get('/system/events?limit=15');
      const events = res.events || res || [];
      if (events.length === 0) {
        el.innerHTML = `<div class="empty-msg"><i class="fas fa-inbox"></i>${i18n.t('pages.dashboard.noRecentEvents')}</div>`;
        return;
      }
      el.innerHTML = events.map(e => `
        <div class="event-row">
          <span class="event-time">${Utils.timeAgo(e.event_time || e.eventTime)}</span>
          <span class="event-badge event-${e.action}">${e.action}</span>
          <span class="event-actor">${Utils.escapeHtml(e.actor_name || e.actorName || Utils.shortId(e.actor_id || e.actorId))}</span>
          <span class="event-type">${e.event_type || e.eventType || ''}</span>
        </div>
      `).join('');
    } catch {
      el.innerHTML = `<div class="empty-msg">${i18n.t('pages.dashboard.eventsNotAvailable')}</div>`;
    }
  },

  _prependEvent(data) {
    const el = document.getElementById('events-list');
    if (!el) return;
    const empty = el.querySelector('.empty-msg');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'event-row event-new';
    row.innerHTML = `
      <span class="event-time">${i18n.t('pages.dashboard.justNow')}</span>
      <span class="event-badge event-${data.action}">${data.action}</span>
      <span class="event-actor">${Utils.escapeHtml(data.actorName || Utils.shortId(data.actorId))}</span>
      <span class="event-type">${data.type || ''}</span>
    `;
    el.insertBefore(row, el.firstChild);
    while (el.children.length > 20) el.removeChild(el.lastChild);
  },

  _updateWsIndicator() {
    const ind = document.getElementById('ws-indicator');
    if (!ind) return;
    if (WS.isConnected) {
      ind.innerHTML = `<span class="badge-dot" style="color:var(--green)"></span> <span>${i18n.t('pages.dashboard.live')}</span>`;
      ind.style.color = 'var(--green)';
    } else {
      ind.innerHTML = `<span class="badge-dot" style="color:var(--red)"></span> <span>${i18n.t('pages.dashboard.offline')}</span>`;
      ind.style.color = 'var(--red)';
    }
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.dashboard.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.dashboard.help.intro')}</p>

        <h4><i class="fas fa-chart-pie"></i> ${i18n.t('pages.dashboard.help.chartsTitle')}</h4>
        <p>${i18n.t('pages.dashboard.help.chartsBody')}</p>

        <h4><i class="fas fa-grip-vertical"></i> ${i18n.t('pages.dashboard.help.dragTitle')}</h4>
        <p>${i18n.t('pages.dashboard.help.dragBody')}</p>

        <h4><i class="fas fa-stream"></i> ${i18n.t('pages.dashboard.help.eventsTitle')}</h4>
        <p>${i18n.t('pages.dashboard.help.eventsBody')}</p>

        <h4><i class="fas fa-wifi"></i> ${i18n.t('pages.dashboard.help.wsTitle')}</h4>
        <p>${i18n.t('pages.dashboard.help.wsBody')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.dashboard.help.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '620px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  _initDragDrop() {
    const grid = document.getElementById('dash-widgets');
    if (!grid) return;

    let dragEl = null;

    grid.addEventListener('dragstart', (e) => {
      dragEl = e.target.closest('.dash-widget');
      if (!dragEl) return;
      dragEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });

    grid.addEventListener('dragend', (e) => {
      if (dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
      grid.querySelectorAll('.dash-widget').forEach(w => w.classList.remove('drag-over'));
    });

    grid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('.dash-widget');
      if (target && target !== dragEl) {
        grid.querySelectorAll('.dash-widget').forEach(w => w.classList.remove('drag-over'));
        target.classList.add('drag-over');
      }
    });

    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('.dash-widget');
      if (!target || target === dragEl || !dragEl) return;
      target.classList.remove('drag-over');

      // Swap positions
      const widgets = [...grid.querySelectorAll('.dash-widget')];
      const dragIdx = widgets.indexOf(dragEl);
      const dropIdx = widgets.indexOf(target);

      if (dragIdx < dropIdx) {
        target.parentNode.insertBefore(dragEl, target.nextSibling);
      } else {
        target.parentNode.insertBefore(dragEl, target);
      }

      // Save order to API
      const order = [...grid.querySelectorAll('.dash-widget')].map(w => w.dataset.widget);
      this._widgetOrder = order;
      localStorage.setItem('dd-widget-order', JSON.stringify(order));
      Api.saveDashboardPrefs({ widget_order: order, hidden_widgets: this._hiddenWidgets }).catch(() => {});
    });
  },

  async _restoreWidgetOrder() {
    const grid = document.getElementById('dash-widgets');
    if (!grid) return;

    // Try API first, fall back to localStorage
    try {
      const prefs = await Api.getDashboardPrefs();
      if (prefs.widget_order && prefs.widget_order.length) {
        this._widgetOrder = prefs.widget_order;
        this._hiddenWidgets = prefs.hidden_widgets || [];
      }
    } catch {
      // Fallback to localStorage
      const saved = localStorage.getItem('dd-widget-order');
      if (saved) {
        try { this._widgetOrder = JSON.parse(saved); } catch {}
      }
    }

    // Apply widget order
    if (this._widgetOrder && this._widgetOrder.length) {
      const widgets = {};
      grid.querySelectorAll('.dash-widget').forEach(w => { widgets[w.dataset.widget] = w; });
      for (const key of this._widgetOrder) {
        if (widgets[key]) grid.appendChild(widgets[key]);
      }
    }

    // Apply hidden widgets
    if (this._hiddenWidgets && this._hiddenWidgets.length) {
      grid.querySelectorAll('.dash-widget').forEach(w => {
        if (this._hiddenWidgets.includes(w.dataset.widget)) {
          w.style.display = 'none';
        }
      });
    }
  },

  _showConfigureWidgets() {
    const allWidgets = [
      { id: 'states', label: 'Container States', icon: 'fa-chart-pie' },
      { id: 'cpu', label: 'Top CPU Consumers', icon: 'fa-microchip' },
      { id: 'memory', label: 'Top Memory Consumers', icon: 'fa-memory' },
    ];

    const html = `
      <div class="modal-header">
        <h3 style="margin:0"><i class="fas fa-sliders-h" style="margin-right:8px;color:var(--accent)"></i>Configure Widgets</h3>
        <button class="modal-close-btn" id="cfg-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-muted text-sm" style="margin-bottom:12px">Toggle widget visibility. Drag handles on the dashboard to reorder.</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${allWidgets.map(w => `
            <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:var(--radius);cursor:pointer">
              <input type="checkbox" class="widget-toggle" data-widget="${w.id}" ${this._hiddenWidgets.includes(w.id) ? '' : 'checked'}>
              <i class="fas ${w.icon}" style="color:var(--accent);width:20px;text-align:center"></i>
              <span>${w.label}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="cfg-save">${i18n.t('common.save')}</button>
      </div>
    `;

    Modal.open(html, { width: '420px' });

    Modal._content.querySelector('#cfg-close').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#cfg-save').addEventListener('click', () => {
      const hidden = [];
      Modal._content.querySelectorAll('.widget-toggle').forEach(cb => {
        if (!cb.checked) hidden.push(cb.dataset.widget);
      });
      this._hiddenWidgets = hidden;

      // Apply visibility
      const grid = document.getElementById('dash-widgets');
      if (grid) {
        grid.querySelectorAll('.dash-widget').forEach(w => {
          w.style.display = hidden.includes(w.dataset.widget) ? 'none' : '';
        });
      }

      // Save to API
      const order = grid ? [...grid.querySelectorAll('.dash-widget')].map(w => w.dataset.widget) : this._widgetOrder || [];
      Api.saveDashboardPrefs({ widget_order: order, hidden_widgets: hidden }).catch(() => {});

      Modal.close();
      Toast.success('Dashboard layout saved');
    });
  },

  _appendHistory(overview) {
    const containers = overview.containers || [];
    const time = new Date().toLocaleTimeString();
    const totalCpu = containers.reduce((s, c) => s + (c.cpu ?? c.cpu_percent ?? 0), 0);
    const totalMem = containers.reduce((s, c) => s + (c.memUsage ?? c.mem_usage ?? 0), 0);

    this._cpuHistory.push({ time, value: parseFloat(totalCpu.toFixed(1)) });
    this._memHistory.push({ time, value: totalMem });
    if (this._cpuHistory.length > 60) this._cpuHistory.shift();
    if (this._memHistory.length > 60) this._memHistory.shift();

    this._renderLineChart('chart-cpu-history', this._cpuHistory, '%', '#0ea5e9');
    this._renderLineChart('chart-mem-history', this._memHistory, ' MB', '#a855f7', true);
  },

  _renderLineChart(id, history, suffix, color, formatBytes = false) {
    const canvas = document.getElementById(id);
    if (!canvas || history.length < 2) return;

    if (this._charts[id]) this._charts[id].destroy();

    const labels = history.map(p => p.time);
    const data = formatBytes ? history.map(p => p.value / (1024 * 1024)) : history.map(p => p.value);

    this._charts[id] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: color,
          backgroundColor: color + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: {
          x: { display: false },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(48,54,61,0.3)' },
            ticks: {
              color: '#545d68',
              callback: v => formatBytes ? v.toFixed(0) + ' MB' : v + suffix,
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => formatBytes
                ? ctx.raw.toFixed(1) + ' MB'
                : ctx.raw.toFixed(1) + suffix,
            },
          },
        },
      },
    });
  },

  destroy() {
    clearInterval(this._refreshTimer);
    Object.values(this._charts).forEach(c => c.destroy());
    this._charts = {};
    if (this._statsUnsub) this._statsUnsub();
    WS.unsubscribe('stats:overview');
    if (this._statsHandler) this._statsHandler();
  },
};

window.DashboardPage = DashboardPage;
