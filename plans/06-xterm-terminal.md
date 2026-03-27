# Plan 06 — Xterm.js Terminal

## Problem
Current exec terminal is a basic textarea with line-based input. No character-at-a-time, no escape sequences, no resize, no colors, no tab completion, no arrow keys. Unusable for real work.

## Goal
Full terminal emulator using xterm.js with proper PTY handling, resize, and shell selection.

## Implementation Steps

### Step 1: Load xterm.js from CDN
**File:** `public/index.html`

Add to `<head>`:
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/lib/addon-web-links.min.js"></script>
```

### Step 2: Backend — Improve exec handling
**File:** `src/ws/index.js`

Modify exec:start handler to support:
- Shell selection (sh, bash, ash, zsh)
- Initial terminal dimensions (rows, cols)
- Proper binary streaming

```js
case 'exec:start': {
  const { containerId, shell = '/bin/sh', cols = 80, rows = 24 } = msg;
  const container = docker.getContainer(containerId);

  // Try requested shell, fallback chain
  const shells = [shell, '/bin/bash', '/bin/ash', '/bin/sh'];
  let exec, stream;

  for (const sh of shells) {
    try {
      exec = await container.exec({
        Cmd: [sh],
        AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: true,
        Env: [`TERM=xterm-256color`, `COLUMNS=${cols}`, `LINES=${rows}`],
      });
      stream = await exec.start({ hijack: true, stdin: true, Tty: true });
      break;
    } catch { continue; }
  }

  if (!stream) {
    send(client.ws, { type: 'exec:error', error: 'No shell available' });
    break;
  }

  client.exec = exec;
  client.execStream = stream;

  // Stream output to client as binary
  stream.on('data', (chunk) => {
    if (client.ws.readyState === 1) {
      client.ws.send(chunk); // Send raw binary for xterm
    }
  });

  stream.on('end', () => {
    send(client.ws, { type: 'exec:end' });
    client.exec = null;
    client.execStream = null;
  });

  send(client.ws, { type: 'exec:started' });
  break;
}
```

### Step 3: Backend — Handle exec resize
**File:** `src/ws/index.js`

Ensure exec:resize actually works:
```js
case 'exec:resize': {
  if (client.exec) {
    try {
      await client.exec.resize({ h: msg.rows, w: msg.cols });
    } catch { /* resize not supported */ }
  }
  break;
}
```

### Step 4: Backend — Handle binary input
**File:** `src/ws/index.js`

Handle raw binary messages (keystrokes) from xterm:
```js
ws.on('message', (data, isBinary) => {
  if (isBinary && client.execStream) {
    client.execStream.write(data);
    return;
  }
  // ... existing JSON message handling
});
```

### Step 5: Frontend — Replace terminal with xterm.js
**File:** `public/js/pages/containers.js` — terminal tab

Replace the entire terminal rendering:
```js
async _renderTerminal(el) {
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
      <select id="term-shell" class="form-control" style="width:auto">
        <option value="/bin/sh">sh</option>
        <option value="/bin/bash">bash</option>
        <option value="/bin/ash">ash</option>
      </select>
      <button class="btn btn-sm btn-primary" id="term-connect">
        <i class="fas fa-plug"></i> Connect
      </button>
      <button class="btn btn-sm btn-danger" id="term-disconnect" style="display:none">
        <i class="fas fa-times"></i> Disconnect
      </button>
    </div>
    <div id="terminal-container" style="height:calc(100vh - 280px)"></div>
  `;

  const termEl = el.querySelector('#terminal-container');

  // Initialize xterm
  this._term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  this._term.loadAddon(fitAddon);
  this._term.loadAddon(new WebLinksAddon.WebLinksAddon());
  this._term.open(termEl);
  fitAddon.fit();

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    if (this._execConnected) {
      WS.send({ type: 'exec:resize', rows: this._term.rows, cols: this._term.cols });
    }
  });
  resizeObserver.observe(termEl);
  this._termResizeObserver = resizeObserver;

  // Connect button
  el.querySelector('#term-connect').addEventListener('click', () => {
    const shell = el.querySelector('#term-shell').value;
    this._connectTerminal(shell);
    el.querySelector('#term-connect').style.display = 'none';
    el.querySelector('#term-disconnect').style.display = '';
  });

  el.querySelector('#term-disconnect').addEventListener('click', () => {
    this._disconnectTerminal();
    el.querySelector('#term-connect').style.display = '';
    el.querySelector('#term-disconnect').style.display = 'none';
  });
},

_connectTerminal(shell) {
  const { cols, rows } = this._term;
  WS.send({ type: 'exec:start', containerId: this._detailId, shell, cols, rows });
  this._execConnected = true;

  // Send keystrokes as binary
  this._termDataHandler = this._term.onData((data) => {
    WS._ws.send(new TextEncoder().encode(data));
  });

  // Receive output
  this._execOutputHandler = (data) => {
    // Binary data from WebSocket
    this._term.write(new Uint8Array(data));
  };
  WS._ws.addEventListener('message', this._binaryHandler = (event) => {
    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then(buf => this._term.write(new Uint8Array(buf)));
    } else if (event.data instanceof ArrayBuffer) {
      this._term.write(new Uint8Array(event.data));
    }
  });
},

_disconnectTerminal() {
  WS.send({ type: 'exec:stop' });
  this._execConnected = false;
  if (this._termDataHandler) { this._termDataHandler.dispose(); }
  if (this._binaryHandler) { WS._ws.removeEventListener('message', this._binaryHandler); }
  this._term.write('\r\n\x1b[31m[Disconnected]\x1b[0m\r\n');
},
```

### Step 6: Cleanup on tab switch / page leave
**File:** `public/js/pages/containers.js` — destroy / tab switch

```js
// On tab switch away from terminal:
if (this._term) { this._disconnectTerminal(); }

// On page destroy:
if (this._term) { this._term.dispose(); this._term = null; }
if (this._termResizeObserver) { this._termResizeObserver.disconnect(); }
```

## Files Changed
| File | Changes |
|------|---------|
| `public/index.html` | Add xterm.js CDN links |
| `src/ws/index.js` | Improved exec with shell selection, resize, binary |
| `public/js/pages/containers.js` | Full xterm.js terminal replacement |

## Testing
- Connect to running container → type `ls -la --color` → verify colored output
- Type `top` → verify real-time updates
- Resize browser window → verify terminal reflows
- Press Ctrl+C → verify signal sent
- Tab completion → verify works
- Switch to another tab → verify exec session ends
- Select bash vs sh → verify correct shell
