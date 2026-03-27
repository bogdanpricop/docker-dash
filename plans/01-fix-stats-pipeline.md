# Plan 01 — Fix Stats Pipeline

## Problem
1. `ws/index.js:broadcastStats()` exists but is NEVER CALLED — dead code
2. Dashboard calls `Api.getStatsOverview()` but there's no backend route for it
3. Container detail stats tab calls `getContainerStatsHistory()` — route exists in stats routes but frontend never subscribes to WebSocket updates
4. Stats are collected every 10s and stored in SQLite, but never pushed to clients in real-time

## Goal
Wire the existing stats collection into WebSocket broadcasting so dashboard and container detail pages get live data without polling.

## Implementation Steps

### Step 1: Hook stats broadcast into collector
**File:** `src/services/stats.js` — `collect()` method

After `insertMany(rows)`, emit an event with the collected data:
```js
// After line 51: if (rows.length > 0) insertMany(rows);
if (rows.length > 0) {
  insertMany(rows);
  this.emit('collected', rows); // Emit for WebSocket broadcasting
}
```

Make StatsService extend EventEmitter:
```js
const { EventEmitter } = require('events');
class StatsService extends EventEmitter { ... }
```

### Step 2: Wire WebSocket to stats events
**File:** `src/ws/index.js`

After starting the stats service, listen for `collected` events:
```js
statsService.on('collected', (rows) => {
  // Build overview: top 5 CPU, top 5 memory
  const overview = {
    containers: rows.map(r => ({
      containerId: r[1], name: r[2],
      cpu: r[3], memUsage: r[4], memLimit: r[5], memPercent: r[6],
      netRx: r[7], netTx: r[8], pids: r[11],
    })),
    timestamp: r[12],
  };
  broadcastToChannel('stats:overview', { type: 'stats:overview', data: overview });

  // Per-container broadcasts for detail views
  for (const row of rows) {
    broadcastToChannel(`stats:${row[1]}`, { type: 'stats:update', data: { ... } });
  }
});
```

### Step 3: Add stats overview REST endpoint (fallback)
**File:** `src/routes/stats.js`

Add `GET /stats/overview` that calls `statsService.getOverview()`:
```js
router.get('/overview', requireAuth, (req, res) => {
  res.json(statsService.getOverview());
});
```

### Step 4: Frontend — Subscribe to stats:overview on dashboard
**File:** `public/js/pages/dashboard.js`

Replace 30s polling with WebSocket subscription:
```js
WS.subscribe('stats:overview');
WS.on('stats:overview', (data) => {
  this._updateCharts(data);
});
```
Keep HTTP fallback for initial load.

### Step 5: Frontend — Subscribe to stats:{id} on container detail
**File:** `public/js/pages/containers.js` — stats tab

Subscribe when stats tab opens, unsubscribe on tab change:
```js
WS.subscribe(`stats:${this._detailId}`);
WS.on(`stats:${this._detailId}`, (data) => {
  this._appendStatsPoint(data);
});
```

## Files Changed
| File | Changes |
|------|---------|
| `src/services/stats.js` | Extend EventEmitter, emit 'collected' |
| `src/ws/index.js` | Listen for stats events, broadcast to channels |
| `src/routes/stats.js` | Add GET /overview endpoint |
| `public/js/pages/dashboard.js` | Subscribe to stats:overview, update charts |
| `public/js/pages/containers.js` | Subscribe to stats:{id}, append chart points |

## Testing
- Open dashboard → verify charts update every 10s without page refresh
- Open container detail → stats tab → verify live data points appear
- Open 2 browser tabs → verify both get updates
- Kill a container → verify its stats stop appearing
