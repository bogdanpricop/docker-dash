/* ═══════════════════════════════════════════════════
   pages/networks.js — Networks Management
   ═══════════════════════════════════════════════════ */
'use strict';

const NetworksPage = {
  _table: null,

  _tab: 'list',

  async render(container, params = {}) {
    if (params.id) {
      await this._renderNetworkDetail(container, params.id);
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-network-wired"></i> ${i18n.t('pages.networks.title')}</h2>
        <div class="page-actions">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" id="net-search" placeholder="${i18n.t('pages.networks.filterPlaceholder')}">
          </div>
          <button class="btn btn-sm btn-primary" id="net-create">
            <i class="fas fa-plus"></i> ${i18n.t('common.create')}
          </button>
          <button class="prune-help-btn" id="net-help" title="${i18n.t('pages.networks.helpTooltip')}">?</button>
          <button class="btn btn-sm btn-secondary" id="net-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div class="tabs" id="net-tabs">
        <button class="tab active" data-tab="list">${i18n.t('pages.networks.title')}</button>
        <button class="tab" data-tab="topology">${i18n.t('pages.networks.topology')}</button>
      </div>
      <div id="net-content">
        <div id="net-table"></div>
      </div>
    `;

    container.querySelectorAll('#net-tabs .tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('#net-tabs .tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        if (this._tab === 'topology') this._renderTopology(container.querySelector('#net-content'));
        else { container.querySelector('#net-content').innerHTML = '<div id="net-table"></div>'; this._initTable(container); this._load(); }
      });
    });

    this._initTable(container);
    container.querySelector('#net-create').addEventListener('click', () => this._createDialog());
    container.querySelector('#net-help').addEventListener('click', () => this._showHelp());
    container.querySelector('#net-refresh').addEventListener('click', () => this._load());

    await this._load();
    this._refreshTimer = setInterval(() => this._load(), 30000);
  },

  _initTable(container) {
    const tableEl = container.querySelector('#net-table');
    if (!tableEl) return;

    this._table = new DataTable(tableEl, {
      columns: [
        { key: 'name', label: i18n.t('pages.networks.name'), render: v => `<span class="mono">${Utils.escapeHtml(v)}</span>` },
        { key: 'driver', label: i18n.t('pages.networks.driver'), render: v => `<span class="badge badge-info">${v}</span>` },
        { key: 'scope', label: i18n.t('pages.networks.scope') },
        { key: 'subnet', label: i18n.t('pages.networks.subnet'), render: v => v ? `<span class="mono text-sm">${Utils.escapeHtml(v)}</span>` : '—' },
        { key: '_containers', label: i18n.t('pages.networks.containers'), render: (_, row) => Object.keys(row.containers || {}).length },
        { key: '_actions', label: '', sortable: false, width: '100px', render: (_, row) => {
          if (row.name === 'bridge' || row.name === 'host' || row.name === 'none') return '';
          return `<div class="action-btns">
            <button class="action-btn" data-action="inspect" data-id="${row.id}" title="${i18n.t('pages.networks.inspect')}"><i class="fas fa-info-circle"></i></button>
            <button class="action-btn danger" data-action="remove" data-id="${row.id}" title="${i18n.t('common.remove')}"><i class="fas fa-trash"></i></button>
          </div>`;
        }},
      ],
      emptyText: i18n.t('pages.networks.noNetworks'),
    });

    // Event delegation for table action buttons
    tableEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'inspect') App.navigate(`/networks/${id}`);
      else if (btn.dataset.action === 'remove') this._remove(id);
    });

    const searchEl = container.querySelector('#net-search');
    if (searchEl) searchEl.addEventListener('input', Utils.debounce(e => this._table.setFilter(e.target.value), 200));
  },

  // ─── Network Detail View ────────────
  async _renderNetworkDetail(container, networkId) {
    container.innerHTML = `
      <div class="page-header">
        <div class="breadcrumb">
          <a href="#/networks"><i class="fas fa-arrow-left"></i> Networks</a>
          <span class="bc-sep">/</span>
          <span id="net-detail-name">Loading...</span>
        </div>
      </div>
      <div class="tabs" id="net-detail-tabs">
        <button class="tab active" data-tab="overview">Overview</button>
        <button class="tab" data-tab="containers">Connected Containers</button>
        <button class="tab" data-tab="inspect">Inspect</button>
      </div>
      <div id="net-detail-content"></div>
    `;

    try {
      const net = await Api.getNetwork(networkId);
      this._netData = net;
      container.querySelector('#net-detail-name').textContent = net.Name || networkId;

      container.querySelectorAll('#net-detail-tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
          container.querySelectorAll('#net-detail-tabs .tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          this._renderNetTab(tab.dataset.tab);
        });
      });

      this._renderNetTab('overview');
    } catch (err) {
      container.querySelector('#net-detail-content').innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  _renderNetTab(tab) {
    const el = document.getElementById('net-detail-content');
    const net = this._netData;
    if (!el || !net) return;

    if (tab === 'overview') {
      const ipam = net.IPAM?.Config?.[0] || {};
      const options = Object.entries(net.Options || {}).map(([k, v]) =>
        `<tr><td class="mono text-sm">${Utils.escapeHtml(k)}</td><td class="mono text-sm">${Utils.escapeHtml(v)}</td></tr>`
      ).join('') || '<tr><td colspan="2" class="text-muted">No options</td></tr>';

      el.innerHTML = `
        <div class="info-grid">
          <div class="card">
            <div class="card-header"><h3>General</h3></div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>Name</td><td class="mono">${Utils.escapeHtml(net.Name)}</td></tr>
                <tr><td>ID</td><td class="mono text-sm">${Utils.escapeHtml((net.Id || '').substring(0, 12))}</td></tr>
                <tr><td>Driver</td><td><span class="badge badge-info">${Utils.escapeHtml(net.Driver)}</span></td></tr>
                <tr><td>Scope</td><td>${Utils.escapeHtml(net.Scope)}</td></tr>
                <tr><td>Internal</td><td>${net.Internal ? '<span style="color:var(--yellow)">Yes (isolated)</span>' : 'No'}</td></tr>
                <tr><td>Attachable</td><td>${net.Attachable ? 'Yes' : 'No'}</td></tr>
                <tr><td>Created</td><td>${net.Created ? Utils.timeAgo(net.Created) : '—'}</td></tr>
              </table>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><h3>IPAM Configuration</h3></div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>Subnet</td><td class="mono">${Utils.escapeHtml(ipam.Subnet || '—')}</td></tr>
                <tr><td>Gateway</td><td class="mono">${Utils.escapeHtml(ipam.Gateway || '—')}</td></tr>
                <tr><td>IP Range</td><td class="mono">${Utils.escapeHtml(ipam.IPRange || '—')}</td></tr>
              </table>
            </div>
          </div>
          <div class="card" style="grid-column:1/-1">
            <div class="card-header"><h3>Driver Options</h3></div>
            <div class="card-body">
              <table class="data-table compact"><thead><tr><th>Option</th><th>Value</th></tr></thead><tbody>${options}</tbody></table>
            </div>
          </div>
        </div>
      `;
    } else if (tab === 'containers') {
      const containers = Object.entries(net.Containers || {});
      if (containers.length === 0) {
        el.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i><p>No containers connected to this network.</p></div>';
      } else {
        const rows = containers.map(([id, c]) => {
          const tr = document.createElement('tr');
          tr.style.cursor = 'pointer';
          tr.innerHTML = `
            <td>${Utils.escapeHtml(c.Name || id.substring(0, 12))}</td>
            <td class="mono text-sm">${Utils.escapeHtml(c.IPv4Address || '—')}</td>
            <td class="mono text-sm">${Utils.escapeHtml(c.IPv6Address || '—')}</td>
            <td class="mono text-sm">${Utils.escapeHtml(c.MacAddress || '—')}</td>
          `;
          tr.addEventListener('click', () => App.navigate(`/containers/${id.substring(0, 12)}`));
          return tr;
        });
        el.innerHTML = `
          <div class="card">
            <div class="card-header"><h3>${containers.length} Connected Container(s)</h3></div>
            <div class="card-body">
              <table class="data-table compact">
                <thead><tr><th>Container</th><th>IPv4 Address</th><th>IPv6 Address</th><th>MAC Address</th></tr></thead>
                <tbody id="net-containers-tbody"></tbody>
              </table>
            </div>
          </div>
        `;
        const tbody = el.querySelector('#net-containers-tbody');
        rows.forEach(tr => tbody.appendChild(tr));
      }
    } else if (tab === 'inspect') {
      el.innerHTML = `
        <div class="card">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <h3>Raw Inspect</h3>
            <button class="btn btn-sm btn-secondary" id="net-copy-inspect"><i class="fas fa-copy"></i> Copy</button>
          </div>
          <div class="card-body">
            <pre class="inspect-json" style="max-height:60vh;overflow:auto">${Utils.escapeHtml(JSON.stringify(net, null, 2))}</pre>
          </div>
        </div>
      `;
      el.querySelector('#net-copy-inspect')?.addEventListener('click', () => {
        Utils.copyToClipboard(JSON.stringify(net, null, 2)).then(() => Toast.success('Copied'));
      });
    }
  },

  // ─── Network Topology Visualization ────────────
  async _renderTopology(el) {
    el.innerHTML = `<div class="text-muted" style="padding:20px"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div>`;
    try {
      const data = await Api.getTopology();
      const nodes = data.nodes || [];
      const links = data.links || [];
      const nets = data.networks || [];

      if (nodes.length === 0) {
        el.innerHTML = `<div class="empty-msg">${i18n.t('pages.networks.topologyNoData')}</div>`;
        return;
      }

      el.innerHTML = `
        <div style="margin-top:12px;position:relative;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;height:calc(100vh - 180px);min-height:400px">
          <canvas id="topo-canvas" style="width:100%;height:100%"></canvas>
          <div style="position:absolute;top:12px;left:12px;background:var(--surface2);border-radius:var(--radius-sm);padding:8px 12px;font-size:11px;opacity:0.9">
            <div style="font-weight:600;margin-bottom:4px"><i class="fas fa-project-diagram text-dim" style="margin-right:4px"></i>${i18n.t('pages.networks.topologyTitle')}</div>
            <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--green);margin-right:6px"></span>${i18n.t('pages.networks.topologyRunning')}</div>
            <div style="margin-top:4px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#545d68;margin-right:6px"></span>${i18n.t('pages.networks.topologyStopped')}</div>
            <div style="margin-top:4px"><span style="display:inline-block;width:10px;height:2px;background:var(--accent);margin-right:6px"></span>${i18n.t('pages.networks.topologyNetwork')}</div>
          </div>
          <div id="topo-zoom-controls" style="position:absolute;top:12px;right:12px;display:flex;flex-direction:column;gap:4px">
            <button class="btn btn-sm btn-secondary" id="topo-zoom-in" title="Zoom in" style="width:32px;height:32px;padding:0"><i class="fas fa-plus"></i></button>
            <button class="btn btn-sm btn-secondary" id="topo-zoom-out" title="Zoom out" style="width:32px;height:32px;padding:0"><i class="fas fa-minus"></i></button>
            <button class="btn btn-sm btn-secondary" id="topo-zoom-reset" title="Reset view" style="width:32px;height:32px;padding:0"><i class="fas fa-compress-arrows-alt"></i></button>
          </div>
          <div id="topo-zoom-level" style="position:absolute;bottom:12px;right:12px;background:var(--surface2);border-radius:var(--radius-sm);padding:4px 8px;font-size:11px;opacity:0.8"></div>
        </div>
      `;

      // Simple force-directed layout on canvas
      const canvas = document.getElementById('topo-canvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const container = canvas.parentElement;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      // Initialize node positions
      const W = canvas.width, H = canvas.height;
      const nodeMap = {};
      nodes.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / nodes.length;
        const r = Math.min(W, H) * 0.35;
        n.x = W / 2 + r * Math.cos(angle);
        n.y = H / 2 + r * Math.sin(angle);
        n.vx = 0; n.vy = 0;
        nodeMap[n.id] = n;
      });

      // Force simulation
      const simulate = () => {
        for (let iter = 0; iter < 80; iter++) {
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const dx = nodes[j].x - nodes[i].x;
              const dy = nodes[j].y - nodes[i].y;
              const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
              const force = 8000 / (dist * dist);
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              nodes[i].vx -= fx; nodes[i].vy -= fy;
              nodes[j].vx += fx; nodes[j].vy += fy;
            }
          }
          for (const link of links) {
            const a = nodeMap[link.source];
            const b = nodeMap[link.target];
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const force = (dist - 150) * 0.02;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
          }
          for (const n of nodes) {
            if (n._dragging) continue;
            n.vx += (W / 2 - n.x) * 0.005;
            n.vy += (H / 2 - n.y) * 0.005;
            n.vx *= 0.85; n.vy *= 0.85;
            n.x += n.vx; n.y += n.vy;
            n.x = Math.max(60, Math.min(W - 60, n.x));
            n.y = Math.max(40, Math.min(H - 40, n.y));
          }
        }
      };
      simulate();

      // Interaction state
      let hoveredNode = null;
      let dragNode = null;
      let zoom = 1;
      let panX = 0, panY = 0;
      let isPanning = false;
      let panStartX = 0, panStartY = 0;

      const toCanvas = (e) => {
        const r = canvas.getBoundingClientRect();
        return {
          x: (e.clientX - r.left - panX) / zoom,
          y: (e.clientY - r.top - panY) / zoom,
        };
      };

      const findNode = (mx, my) => nodes.find(n => {
        const dx = n.x - mx, dy = n.y - my;
        return Math.sqrt(dx * dx + dy * dy) < 20;
      });

      const connectedTo = (node) => {
        if (!node) return new Set();
        const ids = new Set();
        for (const link of links) {
          if (link.source === node.id) ids.add(link.target);
          if (link.target === node.id) ids.add(link.source);
        }
        return ids;
      };

      // Draw function
      const draw = () => {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        const highlighted = connectedTo(hoveredNode);

        // Draw links
        for (const link of links) {
          const a = nodeMap[link.source];
          const b = nodeMap[link.target];
          if (!a || !b) continue;
          const isHighlighted = hoveredNode && (link.source === hoveredNode.id || link.target === hoveredNode.id);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = isHighlighted
            ? (isLight ? 'rgba(56,139,253,0.7)' : 'rgba(56,139,253,0.6)')
            : (hoveredNode ? (isLight ? 'rgba(56,139,253,0.1)' : 'rgba(56,139,253,0.08)') : (isLight ? 'rgba(56,139,253,0.3)' : 'rgba(56,139,253,0.25)'));
          ctx.lineWidth = isHighlighted ? 3 : 2;
          ctx.stroke();
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.fillStyle = isHighlighted ? (isLight ? '#388bfd' : '#58a6ff') : (isLight ? '#888' : '#545d68');
          ctx.textAlign = 'center';
          ctx.fillText(link.network, mx, my - 6);
        }

        // Draw nodes
        for (const n of nodes) {
          const isRunning = n.state === 'running';
          const isHovered = hoveredNode === n;
          const isConnected = hoveredNode && (highlighted.has(n.id) || n === hoveredNode);
          const dimmed = hoveredNode && !isConnected;
          const color = isRunning ? '#3fb950' : '#545d68';
          const alpha = dimmed ? 0.3 : 1;

          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(n.x, n.y, isHovered ? 26 : 22, 0, Math.PI * 2);
          ctx.fillStyle = isRunning ? (isLight ? 'rgba(63,185,80,0.1)' : 'rgba(63,185,80,0.15)') : (isLight ? 'rgba(84,93,104,0.08)' : 'rgba(84,93,104,0.15)');
          ctx.fill();

          ctx.beginPath();
          ctx.arc(n.x, n.y, isHovered ? 19 : 16, 0, Math.PI * 2);
          ctx.fillStyle = isLight ? '#fff' : '#161b22';
          ctx.fill();
          ctx.strokeStyle = isHovered ? '#58a6ff' : color;
          ctx.lineWidth = isHovered ? 3 : 2.5;
          ctx.stroke();

          const nodeIcon = Utils.guessContainerIcon(n.image || '', n.label || '');
          ctx.font = '900 12px "Font Awesome 6 Free"';
          ctx.fillStyle = isHovered ? '#58a6ff' : color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(nodeIcon, n.x, n.y);

          ctx.font = isHovered ? 'bold 11px "Inter", sans-serif' : '11px "Inter", sans-serif';
          ctx.fillStyle = isLight ? '#333' : '#e6edf3';
          ctx.textBaseline = 'top';
          ctx.fillText(n.label.length > 18 ? n.label.substring(0, 16) + '..' : n.label, n.x, n.y + 22);
          ctx.globalAlpha = 1;
        }

        ctx.restore();
      };
      draw();

      // Mouse events
      canvas.addEventListener('mousemove', (e) => {
        const { x, y } = toCanvas(e);
        if (dragNode) {
          dragNode.x = x;
          dragNode.y = y;
          draw();
          return;
        }
        if (isPanning) {
          panX += e.clientX - panStartX;
          panY += e.clientY - panStartY;
          panStartX = e.clientX;
          panStartY = e.clientY;
          draw();
          return;
        }
        const prev = hoveredNode;
        hoveredNode = findNode(x, y);
        canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
        if (prev !== hoveredNode) draw();
      });

      canvas.addEventListener('mousedown', (e) => {
        const { x, y } = toCanvas(e);
        const node = findNode(x, y);
        if (node) {
          dragNode = node;
          node._dragging = true;
          canvas.style.cursor = 'grabbing';
        } else {
          isPanning = true;
          panStartX = e.clientX;
          panStartY = e.clientY;
          canvas.style.cursor = 'move';
        }
      });

      canvas.addEventListener('mouseup', () => {
        if (dragNode) {
          dragNode._dragging = false;
          dragNode = null;
        }
        isPanning = false;
        canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
      });

      canvas.addEventListener('dblclick', (e) => {
        const { x, y } = toCanvas(e);
        const node = findNode(x, y);
        if (node) location.hash = `#/containers/${node.id}`;
      });

      const zoomLabel = document.getElementById('topo-zoom-level');
      const updateZoomLabel = () => { if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%'; };
      updateZoomLabel();

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        zoom = Math.max(0.2, Math.min(5, zoom * factor));
        updateZoomLabel();
        draw();
      }, { passive: false });

      const zoomIn = document.getElementById('topo-zoom-in');
      const zoomOut = document.getElementById('topo-zoom-out');
      const zoomReset = document.getElementById('topo-zoom-reset');
      if (zoomIn) zoomIn.addEventListener('click', () => { zoom = Math.min(5, zoom * 1.25); updateZoomLabel(); draw(); });
      if (zoomOut) zoomOut.addEventListener('click', () => { zoom = Math.max(0.2, zoom * 0.8); updateZoomLabel(); draw(); });
      if (zoomReset) zoomReset.addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; updateZoomLabel(); draw(); });

      canvas.addEventListener('mouseleave', () => {
        if (hoveredNode) { hoveredNode = null; draw(); }
        if (dragNode) { dragNode._dragging = false; dragNode = null; }
        isPanning = false;
      });

    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _load() {
    try {
      const networks = await Api.getNetworks();
      networks.forEach(n => {
        n._containers = Object.keys(n.containers || {}).length;
      });
      this._table.setData(networks);
    } catch (err) {
      Toast.error(i18n.t('pages.networks.loadFailed', { message: err.message }));
    }
  },

  async _createDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>${i18n.t('pages.networks.networkName')}</label>
        <input type="text" id="net-name" class="form-control" required>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.networks.driverLabel')}</label>
        <select id="net-driver" class="form-control">
          <option value="bridge">bridge</option>
          <option value="overlay">overlay</option>
          <option value="macvlan">macvlan</option>
        </select>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.networks.subnetLabel')}</label>
        <input type="text" id="net-subnet" class="form-control" placeholder="${i18n.t('pages.networks.autoPlaceholder')}">
      </div>
    `, {
      title: i18n.t('pages.networks.createTitle'),
      width: '420px',
      onSubmit: (content) => {
        const name = content.querySelector('#net-name').value.trim();
        if (!name) { Toast.warning(i18n.t('pages.networks.nameRequired')); return false; }
        const driver = content.querySelector('#net-driver').value;
        const subnet = content.querySelector('#net-subnet').value.trim();
        return { name, driver, subnet: subnet || undefined };
      }
    });

    if (result) {
      try {
        await Api.createNetwork(result);
        Toast.success(i18n.t('pages.networks.networkCreated', { name: result.name }));
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _inspect(id) {
    try {
      const data = await Api.getNetwork(id);
      const containers = Object.entries(data.Containers || {}).map(([cid, c]) =>
        `<tr><td class="mono text-sm">${Utils.shortId(cid)}</td><td>${Utils.escapeHtml(c.Name)}</td><td class="mono text-sm">${c.IPv4Address || '—'}</td></tr>`
      ).join('');

      Modal.open(`
        <div class="modal-header"><h3>${Utils.escapeHtml(data.Name)}</h3>
          <button class="modal-close-btn" id="net-modal-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <table class="info-table">
            <tr><td>${i18n.t('pages.networks.driver')}</td><td>${data.Driver}</td></tr>
            <tr><td>${i18n.t('pages.networks.scope')}</td><td>${data.Scope}</td></tr>
            <tr><td>${i18n.t('pages.networks.internal')}</td><td>${data.Internal ? i18n.t('common.yes') : i18n.t('common.no')}</td></tr>
            <tr><td>${i18n.t('pages.networks.subnet')}</td><td class="mono">${data.IPAM?.Config?.[0]?.Subnet || '—'}</td></tr>
            <tr><td>${i18n.t('pages.containers.gateway')}</td><td class="mono">${data.IPAM?.Config?.[0]?.Gateway || '—'}</td></tr>
          </table>
          ${containers ? `<h4 class="mt-md">${i18n.t('pages.networks.connectedContainers')}</h4>
            <table class="data-table compact"><thead><tr><th>${i18n.t('pages.containers.id')}</th><th>${i18n.t('common.name')}</th><th>${i18n.t('pages.containers.ip')}</th></tr></thead><tbody>${containers}</tbody></table>` : ''}
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" id="net-connect-btn"><i class="fas fa-plug"></i> Connect Container</button>
            ${containers ? '<button class="btn btn-sm btn-warning" id="net-disconnect-btn"><i class="fas fa-unlink"></i> Disconnect</button>' : ''}
          </div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="net-modal-close-btn">${i18n.t('common.close')}</button></div>
      `, { width: '600px' });

      Modal._content.querySelector('#net-modal-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#net-modal-close-btn').addEventListener('click', () => Modal.close());

      const connectBtn = Modal._content.querySelector('#net-connect-btn');
      if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
          const containerList = await Api.getContainers(true);
          const opts = containerList.map(c => `<option value="${c.id}">${Utils.escapeHtml(c.name)} (${c.state})</option>`).join('');

          const result = await Modal.form(`
            <div class="form-group">
              <label>Container</label>
              <select id="connect-container" class="form-control">${opts}</select>
            </div>
          `, {
            title: 'Connect Container to Network',
            width: '420px',
            onSubmit: (content) => content.querySelector('#connect-container').value,
          });

          if (result) {
            try {
              await Api.post(`/networks/${id}/connect`, { containerId: result });
              Toast.success('Container connected to network');
              Modal.close();
            } catch (err) { Toast.error(err.message); }
          }
        });
      }

      const disconnectBtn = Modal._content.querySelector('#net-disconnect-btn');
      if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async () => {
          const connectedContainers = Object.entries(data.Containers || {});
          const opts = connectedContainers.map(([cid, c]) => `<option value="${cid}">${Utils.escapeHtml(c.Name)}</option>`).join('');

          const result = await Modal.form(`
            <div class="form-group">
              <label>Container to disconnect</label>
              <select id="disconnect-container" class="form-control">${opts}</select>
            </div>
          `, {
            title: 'Disconnect Container from Network',
            width: '420px',
            onSubmit: (content) => content.querySelector('#disconnect-container').value,
          });

          if (result) {
            try {
              await Api.post(`/networks/${id}/disconnect`, { containerId: result });
              Toast.success('Container disconnected from network');
              Modal.close();
            } catch (err) { Toast.error(err.message); }
          }
        });
      }
    } catch (err) { Toast.error(err.message); }
  },

  async _remove(id) {
    const ok = await Modal.confirm(i18n.t('pages.networks.removeConfirm'), { danger: true, confirmText: i18n.t('common.remove') });
    if (!ok) return;
    try {
      await Api.removeNetwork(id);
      Toast.success(i18n.t('pages.networks.removed'));
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.networks.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.networks.help.intro')}</p>

        <h4><i class="fas fa-sitemap"></i> ${i18n.t('pages.networks.help.driversTitle')}</h4>
        <p>${i18n.t('pages.networks.help.driversBody')}</p>

        <h4><i class="fas fa-project-diagram"></i> ${i18n.t('pages.networks.help.subnetTitle')}</h4>
        <p>${i18n.t('pages.networks.help.subnetBody')}</p>

        <h4><i class="fas fa-globe"></i> ${i18n.t('pages.networks.help.scopeTitle')}</h4>
        <p>${i18n.t('pages.networks.help.scopeBody')}</p>

        <h4><i class="fas fa-link"></i> ${i18n.t('pages.networks.help.connectedTitle')}</h4>
        <p>${i18n.t('pages.networks.help.connectedBody')}</p>

        <h4><i class="fas fa-lock"></i> ${i18n.t('pages.networks.help.defaultTitle')}</h4>
        <p>${i18n.t('pages.networks.help.defaultBody')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          <strong>${i18n.t('common.tip')}:</strong> ${i18n.t('pages.networks.help.tipText')}
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

  destroy() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  },
};

window.NetworksPage = NetworksPage;
