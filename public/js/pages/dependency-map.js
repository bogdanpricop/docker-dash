/* ===============================================
   pages/dependency-map.js — Container Dependency Graph
   Canvas-based force-directed graph visualization
   =============================================== */
'use strict';

const DependencyMapPage = {
  _canvas: null,
  _ctx: null,
  _nodes: [],
  _edges: [],
  _clusters: [],
  _animFrame: null,
  _zoom: 1,
  _panX: 0,
  _panY: 0,
  _dragging: null,
  _hoveredNode: null,
  _selectedNode: null,
  _isDragging: false,
  _lastMouse: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-project-diagram" style="color:var(--accent)"></i> Dependency Map</h2>
        <div class="page-actions">
          <select id="dep-filter" class="form-control" style="width:auto">
            <option value="all">All Containers</option>
            <option value="running">Running Only</option>
            <option value="connected">With Dependencies</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="dep-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div class="dep-map-container" id="dep-map-container" style="height:calc(100vh - 180px)">
        <canvas id="dep-map-canvas" class="dep-map-canvas"></canvas>
        <div class="dep-map-controls">
          <button id="dep-zoom-in" title="Zoom In"><i class="fas fa-plus"></i></button>
          <button id="dep-zoom-out" title="Zoom Out"><i class="fas fa-minus"></i></button>
          <button id="dep-zoom-fit" title="Fit All"><i class="fas fa-compress-arrows-alt"></i></button>
        </div>
        <div class="dep-map-legend">
          <div class="dep-map-legend-item"><div class="dep-map-legend-dot" style="background:var(--green)"></div>Running</div>
          <div class="dep-map-legend-item"><div class="dep-map-legend-dot" style="background:var(--red)"></div>Stopped</div>
          <div class="dep-map-legend-item"><div class="dep-map-legend-dot" style="background:var(--text-dim)"></div>Other</div>
          <div class="dep-map-legend-item" style="border-left:1px solid var(--border);padding-left:12px"><span style="color:var(--accent)">&#9473;</span> URL/Hostname</div>
          <div class="dep-map-legend-item"><span style="color:var(--text-dim)">- - -</span> Network</div>
        </div>
        <div class="dep-map-tooltip hidden" id="dep-tooltip"></div>
      </div>
    `;

    container.querySelector('#dep-refresh').addEventListener('click', () => this._loadData());
    container.querySelector('#dep-filter').addEventListener('change', () => this._loadData());
    container.querySelector('#dep-zoom-in').addEventListener('click', () => { this._zoom *= 1.2; this._draw(); });
    container.querySelector('#dep-zoom-out').addEventListener('click', () => { this._zoom /= 1.2; this._draw(); });
    container.querySelector('#dep-zoom-fit').addEventListener('click', () => this._fitAll());

    this._initCanvas();
    await this._loadData();
  },

  _initCanvas() {
    this._canvas = document.getElementById('dep-map-canvas');
    if (!this._canvas) return;
    this._ctx = this._canvas.getContext('2d');

    const resizeCanvas = () => {
      const container = document.getElementById('dep-map-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      this._canvas.width = rect.width * window.devicePixelRatio;
      this._canvas.height = rect.height * window.devicePixelRatio;
      this._canvas.style.width = rect.width + 'px';
      this._canvas.style.height = rect.height + 'px';
      this._ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      this._draw();
    };

    resizeCanvas();
    this._resizeHandler = resizeCanvas;
    window.addEventListener('resize', this._resizeHandler);

    // Mouse events
    this._canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this._canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this._canvas.addEventListener('mouseup', () => this._onMouseUp());
    this._canvas.addEventListener('wheel', (e) => { e.preventDefault(); this._onWheel(e); }, { passive: false });
    this._canvas.addEventListener('dblclick', (e) => this._onDblClick(e));

    // Touch events
    this._canvas.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.touches[0]; this._onMouseDown({ clientX: t.clientX, clientY: t.clientY, offsetX: t.clientX - this._canvas.getBoundingClientRect().left, offsetY: t.clientY - this._canvas.getBoundingClientRect().top }); }, { passive: false });
    this._canvas.addEventListener('touchmove', (e) => { e.preventDefault(); const t = e.touches[0]; this._onMouseMove({ clientX: t.clientX, clientY: t.clientY, offsetX: t.clientX - this._canvas.getBoundingClientRect().left, offsetY: t.clientY - this._canvas.getBoundingClientRect().top }); }, { passive: false });
    this._canvas.addEventListener('touchend', () => this._onMouseUp());
  },

  async _loadData() {
    try {
      const data = await Api.get('/containers/dependency-graph');
      const filter = document.getElementById('dep-filter')?.value || 'all';

      let nodes = data.nodes || [];
      let edges = data.edges || [];

      if (filter === 'running') {
        const runningIds = new Set(nodes.filter(n => n.state === 'running').map(n => n.id));
        nodes = nodes.filter(n => runningIds.has(n.id));
        edges = edges.filter(e => runningIds.has(e.source) && runningIds.has(e.target));
      } else if (filter === 'connected') {
        const connectedIds = new Set();
        edges.forEach(e => { connectedIds.add(e.source); connectedIds.add(e.target); });
        nodes = nodes.filter(n => connectedIds.has(n.id));
        edges = edges.filter(e => connectedIds.has(e.source) && connectedIds.has(e.target));
      }

      // Initialize node positions with force-directed layout seed
      const cx = (this._canvas?.width || 800) / (2 * window.devicePixelRatio);
      const cy = (this._canvas?.height || 600) / (2 * window.devicePixelRatio);
      const radius = Math.min(cx, cy) * 0.6;

      nodes.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / nodes.length;
        n.x = cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 40;
        n.y = cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 40;
        n.vx = 0;
        n.vy = 0;
        n.radius = 20;
      });

      this._nodes = nodes;
      this._edges = edges;
      this._clusters = data.clusters || [];

      // Run force simulation
      this._simulate();
      this._fitAll();
    } catch (err) {
      Toast.error('Failed to load dependency graph: ' + err.message);
    }
  },

  _simulate() {
    const iterations = 100;
    const nodes = this._nodes;
    const edges = this._edges;
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations;
      const strength = 0.3 * alpha;

      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (150 * 150) / (dist * dist);
          const fx = (dx / dist) * force * strength;
          const fy = (dy / dist) * force * strength;
          a.x -= fx; a.y -= fy;
          b.x += fx; b.y += fy;
        }
      }

      // Attraction along edges
      for (const e of edges) {
        const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
        if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = e.type === 'network' ? 200 : 120;
        const force = (dist - ideal) * 0.005 * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.x += fx; a.y += fy;
        b.x -= fx; b.y -= fy;
      }

      // Center gravity
      const cx = (this._canvas?.width || 800) / (2 * window.devicePixelRatio);
      const cy = (this._canvas?.height || 600) / (2 * window.devicePixelRatio);
      for (const n of nodes) {
        n.x += (cx - n.x) * 0.01 * alpha;
        n.y += (cy - n.y) * 0.01 * alpha;
      }
    }
  },

  _fitAll() {
    if (this._nodes.length === 0) { this._zoom = 1; this._panX = 0; this._panY = 0; this._draw(); return; }
    const xs = this._nodes.map(n => n.x);
    const ys = this._nodes.map(n => n.y);
    const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40;
    const minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + 40;
    const w = (this._canvas?.width || 800) / window.devicePixelRatio;
    const h = (this._canvas?.height || 600) / window.devicePixelRatio;
    const scaleX = w / (maxX - minX);
    const scaleY = h / (maxY - minY);
    this._zoom = Math.min(scaleX, scaleY, 2) * 0.85;
    this._panX = w / 2 - ((minX + maxX) / 2) * this._zoom;
    this._panY = h / 2 - ((minY + maxY) / 2) * this._zoom;
    this._draw();
  },

  _draw() {
    const ctx = this._ctx;
    const canvas = this._canvas;
    if (!ctx || !canvas) return;
    const w = canvas.width / window.devicePixelRatio;
    const h = canvas.height / window.devicePixelRatio;

    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this._panX, this._panY);
    ctx.scale(this._zoom, this._zoom);

    const nodeMap = new Map(this._nodes.map(n => [n.id, n]));

    // Draw cluster backgrounds
    for (const cluster of this._clusters) {
      const clusterNodes = cluster.nodeIds.map(id => nodeMap.get(id)).filter(Boolean);
      if (clusterNodes.length < 2) continue;
      const xs = clusterNodes.map(n => n.x);
      const ys = clusterNodes.map(n => n.y);
      const pad = 35;
      ctx.fillStyle = 'rgba(56,139,253,0.04)';
      ctx.strokeStyle = 'rgba(56,139,253,0.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const rx = Math.min(...xs) - pad, ry = Math.min(...ys) - pad;
      const rw = Math.max(...xs) - rx + pad * 2, rh = Math.max(...ys) - ry + pad * 2;
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, 8);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      // Cluster label
      ctx.fillStyle = 'rgba(56,139,253,0.5)';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(cluster.name, rx + 6, ry + 12);
    }

    // Draw edges
    for (const e of this._edges) {
      const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
      if (!a || !b) continue;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);

      const isHighlighted = this._selectedNode && (e.source === this._selectedNode.id || e.target === this._selectedNode.id);

      if (e.type === 'network') {
        ctx.strokeStyle = isHighlighted ? 'rgba(56,139,253,0.6)' : 'rgba(110,118,129,0.2)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = isHighlighted ? 'rgba(56,139,253,0.9)' : 'rgba(56,139,253,0.3)';
        ctx.setLineDash([]);
        ctx.lineWidth = isHighlighted ? 2 : 1.5;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Edge label
      if (isHighlighted && e.label) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.fillStyle = 'rgba(56,139,253,0.7)';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillText(e.label, mx + 4, my - 4);
      }
    }

    // Draw nodes
    for (const n of this._nodes) {
      const isSelected = this._selectedNode?.id === n.id;
      const isHovered = this._hoveredNode?.id === n.id;
      const r = n.radius;

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      const fill = n.state === 'running' ? 'rgba(63,185,80,0.15)' : n.state === 'exited' ? 'rgba(248,81,73,0.1)' : 'rgba(110,118,129,0.1)';
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.strokeStyle = n.state === 'running' ? '#3fb950' : n.state === 'exited' ? '#f85149' : '#6e7681';
      ctx.lineWidth = isSelected ? 3 : isHovered ? 2 : 1.5;
      ctx.stroke();

      if (isSelected || isHovered) {
        ctx.shadowColor = n.state === 'running' ? 'rgba(63,185,80,0.4)' : 'rgba(56,139,253,0.3)';
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // Node icon
      ctx.fillStyle = n.state === 'running' ? '#3fb950' : n.state === 'exited' ? '#f85149' : '#6e7681';
      ctx.font = '14px "Font Awesome 6 Free"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\uf1b2', n.x, n.y); // cube icon fallback

      // Node label
      ctx.fillStyle = '#b1bac4';
      ctx.font = `${isHovered || isSelected ? 'bold ' : ''}11px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(n.name.length > 18 ? n.name.substring(0, 16) + '..' : n.name, n.x, n.y + r + 4);
    }

    ctx.restore();
  },

  _getNodeAt(x, y) {
    const mx = (x - this._panX) / this._zoom;
    const my = (y - this._panY) / this._zoom;
    for (const n of this._nodes) {
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy <= n.radius * n.radius * 1.5) return n;
    }
    return null;
  },

  _onMouseDown(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = e.offsetX || (e.clientX - rect.left);
    const y = e.offsetY || (e.clientY - rect.top);
    const node = this._getNodeAt(x, y);

    if (node) {
      this._dragging = node;
      this._selectedNode = node;
    } else {
      this._selectedNode = null;
    }
    this._isDragging = true;
    this._lastMouse = { x: e.clientX, y: e.clientY };
    this._draw();
  },

  _onMouseMove(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = e.offsetX || (e.clientX - rect.left);
    const y = e.offsetY || (e.clientY - rect.top);

    if (this._dragging) {
      const dx = (e.clientX - this._lastMouse.x) / this._zoom;
      const dy = (e.clientY - this._lastMouse.y) / this._zoom;
      this._dragging.x += dx;
      this._dragging.y += dy;
      this._lastMouse = { x: e.clientX, y: e.clientY };
      this._draw();
      return;
    }

    if (this._isDragging && this._lastMouse) {
      // Pan canvas
      this._panX += e.clientX - this._lastMouse.x;
      this._panY += e.clientY - this._lastMouse.y;
      this._lastMouse = { x: e.clientX, y: e.clientY };
      this._draw();
      return;
    }

    // Hover
    const node = this._getNodeAt(x, y);
    if (node !== this._hoveredNode) {
      this._hoveredNode = node;
      this._canvas.style.cursor = node ? 'pointer' : 'grab';

      const tooltip = document.getElementById('dep-tooltip');
      if (node && tooltip) {
        tooltip.classList.remove('hidden');
        tooltip.style.left = (x + 16) + 'px';
        tooltip.style.top = (y + 16) + 'px';
        const edgeCount = this._edges.filter(e => e.source === node.id || e.target === node.id).length;
        tooltip.innerHTML = `
          <strong>${Utils.escapeHtml(node.name)}</strong><br>
          <span class="text-sm text-muted">${Utils.escapeHtml(node.image)}</span><br>
          <span class="badge badge-${node.state === 'running' ? 'running' : 'stopped'}" style="margin-top:4px">${node.state}</span>
          ${node.stack ? `<br><span class="text-xs text-muted">Stack: ${Utils.escapeHtml(node.stack)}</span>` : ''}
          <br><span class="text-xs text-muted">${edgeCount} connection(s)</span>
        `;
      } else if (tooltip) {
        tooltip.classList.add('hidden');
      }
      this._draw();
    }
  },

  _onMouseUp() {
    this._dragging = null;
    this._isDragging = false;
    this._lastMouse = null;
  },

  _onWheel(e) {
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    this._panX = mx - (mx - this._panX) * factor;
    this._panY = my - (my - this._panY) * factor;
    this._zoom *= factor;
    this._zoom = Math.max(0.1, Math.min(5, this._zoom));
    this._draw();
  },

  _onDblClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = e.offsetX || (e.clientX - rect.left);
    const y = e.offsetY || (e.clientY - rect.top);
    const node = this._getNodeAt(x, y);
    if (node) {
      // Navigate to container detail
      App.navigate(`/containers/${node.id}`);
    }
  },

  destroy() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    this._canvas = null;
    this._ctx = null;
    this._nodes = [];
    this._edges = [];
  },
};

window.DependencyMapPage = DependencyMapPage;
