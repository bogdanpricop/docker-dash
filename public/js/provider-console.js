'use strict';

(() => {
  const title = document.getElementById('console-title');
  const provider = document.getElementById('console-provider');
  const status = document.getElementById('console-status');
  const message = document.getElementById('console-message');
  const screen = document.getElementById('console-screen');
  const terminalTarget = document.getElementById('console-terminal');
  const cad = document.getElementById('console-cad');
  const scale = document.getElementById('console-scale');
  const disconnect = document.getElementById('console-disconnect');
  let socket = null;
  let rfb = null;
  let terminal = null;
  let fitAddon = null;
  let scaled = true;

  function setStatus(text, className = '') {
    status.textContent = text;
    status.className = className;
  }

  function fail(text) {
    setStatus('Unavailable', 'error');
    message.textContent = text;
    message.classList.remove('hidden');
    cad.disabled = true;
    scale.disabled = true;
  }

  function tokenFromFragment() {
    const token = location.hash.slice(1);
    history.replaceState(null, '', location.pathname);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }

  function attachRfb(ws) {
    const RFB = window.NoVNC?.default || window.NoVNC;
    if (typeof RFB !== 'function') throw new Error('The noVNC client could not be loaded');
    screen.classList.add('active');
    message.classList.add('hidden');
    rfb = new RFB(screen, ws, { shared: true });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.addEventListener('connect', () => {
      setStatus('Connected', 'connected'); cad.disabled = false; scale.disabled = false;
    });
    rfb.addEventListener('disconnect', event => {
      if (!event.detail.clean) fail('The VM console connection ended unexpectedly. Open a new console from the VM details page.');
      else setStatus('Disconnected');
    });
    rfb.addEventListener('securityfailure', () => fail('The protected console handshake failed.'));
  }

  function attachSerial(ws) {
    if (typeof window.Terminal !== 'function') throw new Error('The terminal client could not be loaded');
    terminalTarget.classList.add('active');
    message.classList.add('hidden');
    terminal = new window.Terminal({
      cursorBlink: true, convertEol: true, scrollback: 5000,
      theme: { background: '#05070b', foreground: '#e7edf7' },
    });
    if (window.FitAddon?.FitAddon) {
      fitAddon = new window.FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
    }
    terminal.open(terminalTarget);
    fitAddon?.fit();
    terminal.focus();
    terminal.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    });
    ws.addEventListener('message', event => {
      if (typeof event.data === 'string') terminal.write(event.data);
      else if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
      else if (event.data instanceof Blob) event.data.arrayBuffer().then(data => terminal.write(new Uint8Array(data)));
    });
    window.addEventListener('resize', () => fitAddon?.fit());
    setStatus('Connected · serial', 'connected');
  }

  function connect() {
    const token = tokenFromFragment();
    if (!token) return fail('This console launch link is missing, invalid, or was already removed from the address bar.');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}/ws/provider-console`, ['binary', `dd-console.${token}`]);
    socket.binaryType = 'arraybuffer';
    const onReady = event => {
      if (typeof event.data !== 'string') return fail('The console gateway returned an invalid bootstrap response.');
      let payload;
      try { payload = JSON.parse(event.data); } catch { return fail('The console gateway returned an invalid bootstrap response.'); }
      if (payload.type === 'console:error') return fail(payload.message || 'The VM console could not be opened.');
      if (payload.type !== 'console:ready') return fail('The console gateway returned an unexpected response.');
      socket.removeEventListener('message', onReady);
      title.textContent = payload.session?.displayName || 'VM Console';
      provider.textContent = payload.session?.provider || '';
      document.title = `${title.textContent} · VM Console`;
      socket.send(JSON.stringify({ type: 'console:attach' }));
      try {
        if (payload.protocol === 'rfb') attachRfb(socket);
        else if (payload.protocol === 'serial') attachSerial(socket);
        else fail('This VM console protocol is not supported by the browser client.');
      } catch (err) { fail(err.message); socket.close(); }
    };
    socket.addEventListener('message', onReady);
    socket.addEventListener('open', () => setStatus('Authorizing…'));
    socket.addEventListener('close', event => {
      if (!rfb && !terminal && status.className !== 'error') {
        fail(event.code === 4003 ? 'Console access was locked by an administrator.' : 'The console token expired or access was denied.');
      }
    });
    socket.addEventListener('error', () => {
      if (!rfb && !terminal) fail('The console gateway could not be reached.');
    });
  }

  cad.addEventListener('click', () => rfb?.sendCtrlAltDel());
  scale.addEventListener('click', () => {
    if (!rfb) return;
    scaled = !scaled;
    rfb.scaleViewport = scaled;
    scale.textContent = scaled ? 'Actual size' : 'Fit screen';
  });
  disconnect.addEventListener('click', () => {
    try { rfb?.disconnect(); } catch {}
    try { socket?.close(1000, 'User disconnected'); } catch {}
    try { terminal?.dispose(); } catch {}
    setStatus('Disconnected');
  });
  window.addEventListener('beforeunload', () => { try { socket?.close(1000, 'Window closed'); } catch {} });
  connect();
})();
