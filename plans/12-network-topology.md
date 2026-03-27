# Plan 12 — Interactive Network Topology

## Problem
Topology visualization exists but is static (no interaction), recalculates every render (80 force iterations), no click-to-inspect, no zoom/pan, no drag nodes.

## Goal
Interactive force-directed graph: drag nodes, click to inspect, zoom/pan, highlight connected containers, auto-refresh.

## Implementation Steps

### Step 1: Canvas interaction layer
**File:** `public/js/pages/networks.js`

Add mouse event handlers to the topology canvas:
- **Click on node**: Show container info tooltip or navigate to container
- **Drag node**: Move node position, pause simulation
- **Hover node**: Highlight connected edges and neighbor nodes
- **Mouse wheel**: Zoom in/out
- **Click+drag background**: Pan view
- **Double-click node**: Open container detail

### Step 2: Improved force simulation
Replace static 80-iteration loop with animated simulation:
```js
_simulateTopology(nodes, links, canvas) {
  const ctx = canvas.getContext('2d');
  let running = true;

  function tick() {
    if (!running) return;
    // Apply forces: repulsion between nodes, attraction along edges, center gravity
    applyForces(nodes, links);
    // Draw
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawLinks(ctx, links, nodes);
    drawNodes(ctx, nodes);
    requestAnimationFrame(tick);
  }
  tick();

  return { stop: () => { running = false; } };
}
```

### Step 3: Node interaction
```js
canvas.addEventListener('click', (e) => {
  const { x, y } = canvasCoords(e);
  const node = nodes.find(n => dist(n, { x, y }) < 20);
  if (node) {
    if (node.type === 'container') {
      location.hash = `#/containers/${node.id}`;
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = canvasCoords(e);
  const node = nodes.find(n => dist(n, { x, y }) < 20);
  canvas.style.cursor = node ? 'pointer' : 'default';
  this._hoveredNode = node;
  // Redraw with highlighting
});
```

### Step 4: Zoom and pan
```js
let zoom = 1, panX = 0, panY = 0;

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  zoom *= factor;
  zoom = Math.max(0.2, Math.min(5, zoom));
});
```

### Step 5: Network-colored edges
Color edges by network name (consistent color per network).
Show network name on hover over edge.

### Step 6: Legend interaction
Click network name in legend → highlight all containers in that network.

## Files Changed
| File | Changes |
|------|---------|
| `public/js/pages/networks.js` | Interactive canvas, zoom, pan, click, drag |
| `public/css/app.css` | Cursor styles for topology canvas |

## Testing
- Click container node → navigates to container detail
- Drag node → node follows mouse, simulation adjusts
- Zoom in/out → verify smooth zoom
- Hover node → verify connected edges highlighted
- Auto-refresh → verify positions preserved
