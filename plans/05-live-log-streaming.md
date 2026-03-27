# Plan 05 — Live Log Streaming via WebSocket

## Problem
Container logs are fetched via HTTP (polling). The "Follow" toggle exists but just refetches periodically. No true `tail -f` experience. Docker provides a native stream API that should be piped to the browser.

## Goal
Real-time log streaming via WebSocket. When "Follow" is active, logs appear character-by-character as they happen, like a real terminal.

## Implementation Steps

### Step 1: Backend — Log stream subscription
**File:** `src/ws/index.js`

Add `logs:subscribe` and `logs:unsubscribe` message handlers:
```js
case 'logs:subscribe': {
  const { containerId, tail = 100, since } = msg;
  // Cleanup previous stream if any
  if (client.logStream) { client.logStream.destroy(); client.logStream = null; }

  const container = docker.getContainer(containerId);
  const stream = await container.logs({
    follow: true, stdout: true, stderr: true,
    tail, since: since || undefined,
    timestamps: true,
  });

  client.logStream = stream;
  client.logContainerId = containerId;

  stream.on('data', (chunk) => {
    // Demux Docker's 8-byte header format
    const lines = demuxStream(chunk);
    send(client.ws, {
      type: 'logs:data',
      containerId,
      lines,
    });
  });

  stream.on('end', () => {
    send(client.ws, { type: 'logs:end', containerId });
  });

  stream.on('error', (err) => {
    send(client.ws, { type: 'logs:error', containerId, error: err.message });
  });
  break;
}

case 'logs:unsubscribe': {
  if (client.logStream) {
    client.logStream.destroy();
    client.logStream = null;
    client.logContainerId = null;
  }
  break;
}
```

### Step 2: Backend — Cleanup on disconnect
**File:** `src/ws/index.js` — connection close handler

Add log stream cleanup:
```js
ws.on('close', () => {
  if (client.logStream) { client.logStream.destroy(); }
  if (client.execStream) { client.execStream.end(); }
  // ... existing cleanup
});
```

### Step 3: Backend — Log demux utility
**File:** `src/services/docker.js` or utility

Reuse existing `demuxLogStream()` for WebSocket. Extract to shared utility if needed.

### Step 4: Frontend — WebSocket log handler
**File:** `public/js/pages/containers.js` — logs tab

Replace polling with WebSocket subscription:
```js
_startLogStream(containerId) {
  // Subscribe via WebSocket
  WS.send({ type: 'logs:subscribe', containerId, tail: this._logTail });

  this._logHandler = (data) => {
    if (data.containerId !== containerId) return;
    this._appendLogLines(data.lines);
  };
  WS.on('logs:data', this._logHandler);

  this._logEndHandler = () => {
    this._appendLogLine('[Container stopped — log stream ended]');
  };
  WS.on('logs:end', this._logEndHandler);
},

_stopLogStream() {
  WS.send({ type: 'logs:unsubscribe' });
  if (this._logHandler) WS.off('logs:data', this._logHandler);
  if (this._logEndHandler) WS.off('logs:end', this._logEndHandler);
},
```

### Step 5: Frontend — Smooth log rendering
**File:** `public/js/pages/containers.js`

Optimize log rendering for high-throughput:
```js
_appendLogLines(lines) {
  const el = this._logEl;
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    fragment.appendChild(div);
  }
  el.appendChild(fragment);

  // Trim old lines if > 5000
  while (el.children.length > 5000) el.removeChild(el.firstChild);

  // Auto-scroll if user is near bottom
  if (this._autoScroll) {
    el.scrollTop = el.scrollHeight;
  }
},
```

### Step 6: Frontend — Follow toggle wiring
Wire the existing "Follow" toggle to start/stop the WebSocket stream.
On follow ON: subscribe to stream.
On follow OFF: unsubscribe, switch to static HTTP view.

## Files Changed
| File | Changes |
|------|---------|
| `src/ws/index.js` | logs:subscribe/unsubscribe handlers, cleanup |
| `public/js/pages/containers.js` | WS log subscription, append, follow toggle |

## Performance Notes
- Max 5000 lines in DOM, trim oldest
- Use `requestAnimationFrame` for batching if > 100 lines/sec
- DocumentFragment for batch DOM inserts
- Destroy stream on tab switch, not just on page leave

## Testing
- Open container logs → toggle Follow ON → verify real-time output
- Run `docker exec {container} echo "test"` → verify appears immediately
- Switch to another tab → verify stream stops
- Container stops → verify "stream ended" message
- Two browsers watching same container → both get updates
