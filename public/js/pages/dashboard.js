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
    // v8.9.19-alpha.1 — if the selected host is a vSphere/ESXi host, the Docker
    // dashboard would run Docker APIs against a non-Docker daemon and show the
    // wrong (or empty) data even though the switcher shows the ESXi server.
    // Render a vSphere-specific summary for that host instead.
    const _curHost = await this._resolveCurrentHost();
    if (_curHost && _curHost.daemonType === 'vsphere') {
      return this._renderVSphereDashboard(container, _curHost);
    }

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-chart-pie"></i> ${i18n.t('pages.dashboard.title')}</h2>
          <div class="page-subtitle">${i18n.t('pages.dashboard.subtitle')}</div>
        </div>
        <div class="page-actions" style="align-items:center">
          <button class="btn btn-sm btn-secondary" data-tab-jump="tools" title="Open System → Tools" style="margin-right:8px"><i class="fas fa-toolbox"></i> Tools</button>
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
        <!-- Cluster Health Score -->
        <div class="stat-card" id="stat-health-card">
          <div style="position:relative;width:48px;height:48px;flex-shrink:0">
            <svg id="health-gauge-svg" viewBox="0 0 36 36" style="width:100%;height:100%;transform:rotate(-90deg)">
              <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--surface3)" stroke-width="3"/>
              <circle id="health-gauge-arc" cx="18" cy="18" r="15.915" fill="none" stroke="var(--text-dim)" stroke-width="3" stroke-dasharray="0 100" stroke-linecap="round" style="transition:stroke-dasharray 0.8s ease,stroke 0.5s ease"/>
            </svg>
            <div id="health-score-text" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--text-dim)">—</div>
          </div>
          <div class="stat-body">
            <div class="stat-value" id="health-status-text" style="font-size:16px">—</div>
            <div class="stat-label"><i class="fas fa-heartbeat" style="margin-right:4px"></i>Health</div>
            <div id="health-detail-text" style="font-size:9px;color:var(--text-dim);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
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
      const [containers, images, volumes, overview, sysInfo, health] = await Promise.all([
        Api.getContainers(true),
        Api.getImages(),
        Api.getVolumes(),
        Api.getStatsOverview().catch(() => null),
        Api.getSystemInfo().catch(() => null),
        Api.getClusterHealth().catch(() => null),
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
      this._renderClusterHealth(health);

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
          <span>Failed to load dashboard data. <button class="btn btn-sm" style="margin-left:8px" id="dash-retry-btn">Retry</button></span>
        </div>`;
        banner.querySelector('#dash-retry-btn')?.addEventListener('click', () => DashboardPage._load());
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
      <span class="host-info-item text-muted"><i class="fab fa-linux"></i> ${Utils.escapeHtml(info.os || '—')}</span>
    `;
  },

  _renderClusterHealth(health) {
    const arc = document.getElementById('health-gauge-arc');
    const scoreText = document.getElementById('health-score-text');
    const statusText = document.getElementById('health-status-text');
    const detailText = document.getElementById('health-detail-text');
    if (!arc || !scoreText) return;

    if (!health) {
      scoreText.textContent = '—';
      if (statusText) statusText.textContent = '—';
      return;
    }

    const score = health.score ?? 0;
    const status = health.status || 'unknown';
    const b = health.breakdown || {};

    const color = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--red)';

    arc.setAttribute('stroke-dasharray', `${score} 100`);
    arc.setAttribute('stroke', color);
    scoreText.textContent = score;
    scoreText.style.color = color;

    const statusLabel = status === 'healthy' ? 'Healthy' : status === 'degraded' ? 'Degraded' : 'Critical';
    if (statusText) {
      statusText.textContent = `${score} ${statusLabel}`;
      statusText.style.color = color;
    }
    if (detailText) {
      const parts = [];
      if (b.containersTotal > 0) parts.push(`${b.containersRunning}/${b.containersTotal}`);
      if (b.cpuUsage !== undefined) parts.push(`CPU ${b.cpuUsage}%`);
      if (b.memoryUsage !== undefined) parts.push(`RAM ${b.memoryUsage}%`);
      if (b.unhealthy > 0) parts.push(`${b.unhealthy} unhealthy`);
      detailText.textContent = parts.join(' · ');
      statusText.style.color = color;
    }
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

  // ─── vSphere / ESXi dashboard variant (v8.9.19) ──────────────────
  // Resolve the host the Dashboard should represent: the explicitly-selected
  // host, or (when none) the default / first host. Returns null on any error
  // so the Docker path stays the default.
  async _resolveCurrentHost() {
    try {
      const id = Api.getHostId();
      const hosts = await Api.getHosts();
      if (!Array.isArray(hosts) || !hosts.length) return null;
      if (id) return hosts.find(h => h.id === id) || null;
      return hosts.find(h => h.isDefault) || hosts[0];
    } catch { return null; }
  },

  _renderVSphereDashboard(container, host) {
    const hostId = host.id;
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-server" style="color:#22c55e;margin-right:8px"></i>${Utils.escapeHtml(host.name)}</h2>
          <div class="page-subtitle"><i class="fab fa-vmware" style="margin-right:6px"></i>VMware vSphere / ESXi — dashboard summary</div>
        </div>
        <div class="page-actions" style="align-items:center">
          <button class="btn btn-sm btn-secondary" data-tab-jump="tools" title="Open System → Tools" style="margin-right:8px"><i class="fas fa-toolbox"></i> Tools</button>
          <a href="https://github.com/bogdanpricop/docker-dash" target="_blank" rel="noopener" class="text-muted text-xs" style="margin-right:8px" title="Docker Dash on GitHub"><i class="fab fa-github"></i></a>
          <button class="btn btn-sm btn-primary" id="vdash-open" style="margin-right:8px"><i class="fas fa-external-link-alt"></i> Full vSphere page</button>
          <span class="text-muted text-sm" style="margin-right:8px"><i class="fas fa-clock" style="margin-right:4px"></i><span id="vdash-updated">—</span></span>
          <button class="btn btn-sm" id="vdash-refresh"><i class="fas fa-sync-alt"></i> ${i18n.t('common.refresh')}</button>
        </div>
      </div>

      <div id="vdash-error" style="display:none;margin-bottom:12px"></div>

      <div class="stat-cards" id="vdash-stats">
        <div class="stat-card"><div class="stat-icon green"><i class="fas fa-play-circle"></i></div><div class="stat-body"><div class="stat-value" id="vst-on">—</div><div class="stat-label">VMs powered on</div></div></div>
        <div class="stat-card"><div class="stat-icon red"><i class="fas fa-stop-circle"></i></div><div class="stat-body"><div class="stat-value" id="vst-off">—</div><div class="stat-label">VMs powered off</div></div></div>
        <div class="stat-card"><div class="stat-icon purple"><i class="fas fa-server"></i></div><div class="stat-body"><div class="stat-value" id="vst-hosts">—</div><div class="stat-label">ESXi hosts</div></div></div>
        <div class="stat-card"><div class="stat-icon volumes"><i class="fas fa-hdd"></i></div><div class="stat-body"><div class="stat-value" id="vst-ds">—</div><div class="stat-label">Datastores</div></div></div>
        <div class="stat-card"><div class="stat-icon" id="vst-sec-icon" style="background:var(--text-dim)"><i class="fas fa-shield-alt"></i></div><div class="stat-body"><div class="stat-value" id="vst-sec" style="font-size:16px">—</div><div class="stat-label"><i class="fas fa-lock" style="margin-right:4px"></i>Version</div></div></div>
      </div>

      <div class="card" id="host-info-card" style="margin-bottom:16px"><div class="card-body" style="padding:10px 16px"><div id="vdash-hostinfo" class="host-info-bar">${i18n.t('common.loading')}</div></div></div>

      <div class="dash-grid" id="vdash-hosts"></div>

      <div class="card" style="margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-hdd text-dim" style="margin-right:8px"></i>Datastores</h3></div>
        <div class="card-body" id="vdash-datastores">${i18n.t('common.loading')}</div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-desktop text-dim" style="margin-right:8px"></i>Virtual Machines</h3><span class="text-dim text-sm" id="vdash-vm-count"></span></div>
        <div class="card-body" style="padding:0"><div id="vdash-vms" style="padding:12px 16px">${i18n.t('common.loading')}</div></div>
      </div>
    `;
    container.querySelector('#vdash-open').addEventListener('click', () => App.navigate('/vsphere-resources'));
    container.querySelector('#vdash-refresh').addEventListener('click', () => this._loadVSphere(hostId));
    this._loadVSphere(hostId);
    this._refreshTimer = setInterval(() => this._loadVSphere(hostId), 30000);
  },

  async _loadVSphere(hostId) {
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    try {
      const [info, hosts, vms, datastores, security] = await Promise.all([
        Api.getVSphereInfo(hostId).catch(() => ({})),
        Api.getVSphereHosts(hostId).catch(() => []),
        Api.getVSphereVMs(hostId).catch(() => []),
        Api.getVSphereDatastores(hostId).catch(() => []),
        Api.getVSphereVersionCheck(hostId).catch(() => ({ hosts: [] })),
      ]);
      const hostsA = Array.isArray(hosts) ? hosts : [];
      const vmsA = Array.isArray(vms) ? vms : [];
      const dsA = Array.isArray(datastores) ? datastores : [];
      const info2 = info || {};

      const vmOn = vmsA.filter(v => v.powerState === 'poweredOn').length;
      set('vst-on', vmOn);
      set('vst-off', vmsA.length - vmOn);
      set('vst-hosts', hostsA.length);
      set('vst-ds', dsA.length);

      // Version / security roll-up across all ESXi hosts.
      const checks = ((security && security.hosts) || []).map(h => h.check).filter(Boolean);
      let sev = { t: 'OK', bg: '#3fb950' };
      if (!checks.length) sev = { t: 'n/a', bg: 'var(--text-dim)' };
      else if (checks.some(c => c.isEndOfLife)) sev = { t: 'End of life', bg: '#f85149' };
      else if (checks.some(c => (c.criticalCVECount || 0) > 0)) sev = { t: 'Critical CVEs', bg: '#f85149' };
      else if (checks.some(c => (c.highCVECount || 0) > 0 || c.isEndOfSupportSoon)) sev = { t: 'Attention', bg: '#d29922' };
      else if (checks.some(c => !c.isUpToDate)) sev = { t: 'Update available', bg: '#d29922' };
      set('vst-sec', sev.t);
      const secIcon = document.getElementById('vst-sec-icon');
      if (secIcon) secIcon.style.background = sev.bg;

      // Host info bar.
      const hib = document.getElementById('vdash-hostinfo');
      if (hib) {
        const bits = [
          info2.productFullName || info2.productName || 'vSphere',
          info2.version ? `v${info2.version}${info2.build ? ` (build ${info2.build})` : ''}` : null,
          info2.apiVersion ? `API ${info2.apiVersion}` : null,
          `${hostsA.length} host(s) · ${vmsA.length} VM(s) · ${dsA.length} datastore(s)`,
        ].filter(Boolean);
        hib.innerHTML = bits.map(b => `<span style="margin-right:16px"><i class="fas fa-circle" style="font-size:6px;vertical-align:middle;margin-right:6px;color:var(--text-dim)"></i>${Utils.escapeHtml(String(b))}</span>`).join('');
      }

      // Per-host CPU/Mem gauge cards.
      const hostsEl = document.getElementById('vdash-hosts');
      if (hostsEl) {
        hostsEl.innerHTML = hostsA.length ? hostsA.map(h => `
          <div class="card" style="padding:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(h.name || '—')}</strong>
              <span class="badge" style="background:${h.connectionState === 'connected' ? '#3fb950' : '#f85149'};color:#fff;font-size:10px">${Utils.escapeHtml(h.connectionState || '?')}</span>
            </div>
            ${this._vBar('CPU', h.cpuPercent, `${h.cpuUsageMHz || 0} / ${h.cpuTotalMHz || 0} MHz`)}
            ${this._vBar('Memory', h.memoryPercent, `${((h.memoryUsageMB || 0) / 1024).toFixed(1)} / ${((h.memoryTotalMB || 0) / 1024).toFixed(0)} GiB`)}
            <div style="font-size:12px;color:var(--text-dim);display:flex;justify-content:space-between;margin-top:8px">
              <span>${h.cpuCores || '?'}c / ${h.cpuThreads || '?'}t · ESXi ${Utils.escapeHtml(h.productVersion || '?')}</span>
              <span>${this._vUptime(h.uptimeSeconds)}</span>
            </div>
          </div>`).join('') : '<div class="empty-msg" style="grid-column:1/-1">No ESXi hosts returned.</div>';
      }

      // Datastore usage bars.
      const dsEl = document.getElementById('vdash-datastores');
      if (dsEl) {
        dsEl.innerHTML = dsA.length ? dsA.map(d => {
          const cap = d.capacityBytes || 0, free = d.freeSpaceBytes || 0, used = cap - free;
          const pct = cap ? Math.round(used / cap * 100) : 0;
          const barCol = pct >= 90 ? '#f85149' : pct >= 75 ? '#d29922' : '#3fb950';
          return `<div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
              <strong>${Utils.escapeHtml(d.name || '—')}</strong>
              <span class="text-dim">${this._vGiB(used)} / ${this._vGiB(cap)} GiB · ${pct}%</span>
            </div>
            <div style="height:8px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${barCol}"></div></div>
          </div>`;
        }).join('') : '<div class="empty-msg">No datastores returned.</div>';
      }

      // VM list (compact — top 30 by power state then name).
      const vmsEl = document.getElementById('vdash-vms');
      set('vdash-vm-count', vmsA.length ? `${vmOn} running / ${vmsA.length} total` : '');
      if (vmsEl) {
        const sorted = vmsA.slice().sort((a, b) =>
          (b.powerState === 'poweredOn') - (a.powerState === 'poweredOn') || String(a.name || '').localeCompare(String(b.name || '')));
        const shown = sorted.slice(0, 30);
        vmsEl.innerHTML = shown.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">
          ${shown.map(vm => {
            const on = vm.powerState === 'poweredOn';
            const dot = on ? '#3fb950' : vm.powerState === 'poweredOff' ? '#545d68' : '#d29922';
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;min-width:0">
              <span style="width:8px;height:8px;border-radius:50%;background:${dot};flex:0 0 auto"></span>
              <div style="min-width:0;flex:1">
                <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(vm.name || '—')}</div>
                <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(vm.guestOS || '')}</div>
              </div>
              <div style="font-size:11px;color:var(--text-dim);text-align:right;flex:0 0 auto">${vm.numCPU || '?'}vCPU<br>${vm.memoryMB ? (vm.memoryMB / 1024).toFixed(vm.memoryMB >= 1024 ? 0 : 1) + 'G' : '—'}</div>
            </div>`;
          }).join('')}
        </div>${sorted.length > 30 ? `<div class="text-dim text-sm" style="margin-top:8px">+ ${sorted.length - 30} more — see the full vSphere page.</div>` : ''}` : '<div class="empty-msg">No virtual machines returned.</div>';
      }

      const upd = document.getElementById('vdash-updated');
      if (upd) upd.textContent = new Date().toLocaleTimeString();
      const err = document.getElementById('vdash-error');
      if (err) err.style.display = 'none';
    } catch (e) {
      const err = document.getElementById('vdash-error');
      if (err) {
        err.style.display = 'block';
        err.innerHTML = `<div style="padding:12px 16px;background:rgba(248,81,73,0.1);border:1px solid var(--red);border-radius:var(--radius);color:var(--red)">
          <i class="fas fa-exclamation-triangle"></i> Failed to load vSphere data: ${Utils.escapeHtml(e.message || String(e))}</div>`;
      }
    }
  },

  _vBar(label, pct, sub) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const col = p >= 90 ? '#f85149' : p >= 75 ? '#d29922' : '#3fb950';
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span class="text-dim">${label}</span><span>${p}% <span class="text-dim">${Utils.escapeHtml(sub || '')}</span></span></div>
      <div style="height:8px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="width:${p}%;height:100%;background:${col}"></div></div>
    </div>`;
  },

  _vGiB(bytes) { return (( bytes || 0) / (1024 ** 3)).toFixed(0); },

  _vUptime(sec) {
    sec = sec || 0;
    const d = Math.floor(sec / 86400);
    if (d > 0) return `${d}d up`;
    const h = Math.floor(sec / 3600);
    return h > 0 ? `${h}h up` : `${Math.floor(sec / 60)}m up`;
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
