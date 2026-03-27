# Plan 07 — Dashboard Live Resource Graphs

## Problem
Dashboard shows static stat cards and charts that refresh every 30s via HTTP polling. The stats collector runs every 10s but data never reaches the dashboard in real-time. No CPU/memory time-series graphs.

## Goal
Live-updating CPU and memory time-series charts on the dashboard, powered by WebSocket stats broadcasts (Plan 01 dependency).

## Dependencies
- Plan 01 (Fix Stats Pipeline) must be implemented first

## Implementation Steps

### Step 1: Add time-series widget to dashboard
**File:** `public/js/pages/dashboard.js`

Add two new draggable widgets: "CPU History" and "Memory History"

```js
// In widget definitions, add:
{ id: 'cpu-history', title: 'CPU Usage', icon: 'fa-microchip', render: '_renderCpuHistory' },
{ id: 'mem-history', title: 'Memory Usage', icon: 'fa-memory', render: '_renderMemHistory' },
```

### Step 2: Implement rolling time-series charts
**File:** `public/js/pages/dashboard.js`

Use Chart.js with streaming data:
```js
_renderCpuHistory(container) {
  container.innerHTML = '<canvas id="cpu-history-chart"></canvas>';
  const ctx = document.getElementById('cpu-history-chart');

  // Store last 60 data points (10 minutes at 10s intervals)
  this._cpuHistory = this._cpuHistory || [];

  this._charts.cpuHistory = new Chart(ctx, {
    type: 'line',
    data: {
      labels: this._cpuHistory.map(p => p.time),
      datasets: [{
        label: 'Total CPU %',
        data: this._cpuHistory.map(p => p.value),
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14, 165, 233, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      scales: {
        x: { display: false },
        y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } },
      },
      plugins: { legend: { display: false } },
    },
  });
},
```

### Step 3: Subscribe to stats:overview via WebSocket
**File:** `public/js/pages/dashboard.js`

```js
// In render(), after initial load:
WS.subscribe('stats:overview');
this._statsHandler = (data) => {
  const totalCpu = data.containers.reduce((s, c) => s + c.cpu, 0);
  const totalMem = data.containers.reduce((s, c) => s + c.memUsage, 0);
  const time = new Date().toLocaleTimeString();

  // Append to rolling history
  this._cpuHistory.push({ time, value: totalCpu.toFixed(1) });
  this._memHistory.push({ time, value: totalMem });
  if (this._cpuHistory.length > 60) this._cpuHistory.shift();
  if (this._memHistory.length > 60) this._memHistory.shift();

  // Update charts
  this._updateTimeSeriesChart('cpuHistory', this._cpuHistory);
  this._updateTimeSeriesChart('memHistory', this._memHistory);

  // Update stat cards and bar charts
  this._updateStatCards(data);
  this._updateTopCharts(data);
};
WS.on('stats:overview', this._statsHandler);
```

### Step 4: Animated stat card updates
**File:** `public/js/pages/dashboard.js`

Instead of rebuilding cards, animate number changes:
```js
_updateStatCards(data) {
  this._animateNumber('running-count', data.running);
  this._animateNumber('stopped-count', data.stopped);
},

_animateNumber(elId, target) {
  const el = document.getElementById(elId);
  if (!el) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  el.textContent = target;
  el.classList.add('number-bump');
  setTimeout(() => el.classList.remove('number-bump'), 300);
},
```

### Step 5: CSS for animated numbers
**File:** `public/css/app.css`
```css
.number-bump {
  animation: bump 0.3s ease;
}
@keyframes bump {
  0% { transform: scale(1); }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); }
}
```

### Step 6: Cleanup on destroy
```js
destroy() {
  WS.unsubscribe('stats:overview');
  if (this._statsHandler) WS.off('stats:overview', this._statsHandler);
  Object.values(this._charts).forEach(c => c.destroy());
  this._charts = {};
},
```

## Files Changed
| File | Changes |
|------|---------|
| `public/js/pages/dashboard.js` | Time-series widgets, WS subscription, animated updates |
| `public/css/app.css` | Number animation keyframes |

## Testing
- Open dashboard → verify CPU/memory charts update every 10s
- Start a container → verify running count bumps up with animation
- Stop a container → verify CPU chart drops
- Leave dashboard open 10 min → verify chart scrolls with 60-point window
- Open in 2 browsers → verify both update simultaneously
