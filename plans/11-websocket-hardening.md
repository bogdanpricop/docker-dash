# Plan 11 — WebSocket Hardening

## Problems
1. No ping/pong heartbeat — dead connections not detected
2. No rate limiting — client can flood server with messages
3. No reconnection jitter — all clients reconnect simultaneously after server restart
4. Exec stream leaks — if connection drops, Docker exec process stays alive
5. No max message size — large payloads could crash server
6. No connection timeout — hanging connections consume resources

## Implementation Steps

### Step 1: Server-side heartbeat (ping/pong)
**File:** `src/ws/index.js`
```js
// Ping every 30 seconds, terminate if no pong within 10s
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;

setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      cleanupClient(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

ws.on('pong', () => { ws.isAlive = true; });
ws.isAlive = true; // Set on connect
```

### Step 2: Client-side reconnection jitter
**File:** `public/js/ws.js`
```js
// Add random jitter to prevent thundering herd
_reconnect() {
  const base = Math.min(1000 * Math.pow(2, this._retries), 30000);
  const jitter = Math.random() * base * 0.3; // 0-30% jitter
  const delay = base + jitter;
  setTimeout(() => this._connect(), delay);
  this._retries++;
}
```

### Step 3: Rate limiting
**File:** `src/ws/index.js`
```js
// Max 50 messages per second per client
const MSG_RATE_LIMIT = 50;
const MSG_RATE_WINDOW = 1000;

ws.on('message', (data) => {
  const client = clients.get(ws);
  const now = Date.now();
  client.msgTimes = (client.msgTimes || []).filter(t => now - t < MSG_RATE_WINDOW);
  if (client.msgTimes.length >= MSG_RATE_LIMIT) {
    send(ws, { type: 'error', message: 'Rate limited' });
    return;
  }
  client.msgTimes.push(now);
  // ... process message
});
```

### Step 4: Max message size
**File:** `src/ws/index.js`
```js
const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: 64 * 1024, // 64KB max message size
});
```

### Step 5: Exec stream cleanup on disconnect
**File:** `src/ws/index.js`
```js
function cleanupClient(ws) {
  const client = clients.get(ws);
  if (!client) return;

  // Kill exec stream
  if (client.execStream) {
    try { client.execStream.destroy(); } catch {}
    client.execStream = null;
  }

  // Kill log stream
  if (client.logStream) {
    try { client.logStream.destroy(); } catch {}
    client.logStream = null;
  }

  clients.delete(ws);
}
```

### Step 6: Client-side heartbeat detection
**File:** `public/js/ws.js`
```js
// Detect server-side disconnection faster
_startHeartbeat() {
  this._heartbeatTimer = setInterval(() => {
    if (this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}
```

## Files Changed
| File | Changes |
|------|---------|
| `src/ws/index.js` | Heartbeat, rate limit, max payload, cleanup |
| `public/js/ws.js` | Jitter, heartbeat, connection timeout |

## Testing
- Kill server → verify clients reconnect with staggered timing
- Send 100 messages/sec → verify rate limit kicks in
- Open exec → kill browser tab → verify exec process cleaned up
- Leave connection idle 5 min → verify heartbeat keeps it alive
