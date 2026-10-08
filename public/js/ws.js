/* ═══════════════════════════════════════════════════
   ws.js — WebSocket Client
   ═══════════════════════════════════════════════════ */
'use strict';

const WS = {
  _ws: null,
  _reconnectTimer: null,
  _reconnectDelay: 1000,
  _maxReconnect: 30000,
  _handlers: new Map(),   // type → Set<fn>
  _subscriptions: new Set(),
  _connected: false,
  _intentionalClose: false,
  _useTokenFallback: false,  // v7.3.5: only true after a cookie-only attempt failed with 4001

  connect() {
    if (this._ws && this._ws.readyState <= 1) return;
    this._intentionalClose = false;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // v7.3.5: prefer cookie auth (the session cookie is httpOnly so JS can't
    // probe it — browser attaches it automatically on the WS handshake).
    // The server rejects ?token= unless WS_QUERY_TOKEN_ENABLED=true is set,
    // and that's off by default for security (tokens can leak via logs/refer).
    // Only fall back to token-in-query after a cookie attempt closes 4001.
    const token = Api?._bearerToken || '';
    const url = (this._useTokenFallback && token)
      ? `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`
      : `${proto}//${location.host}/ws`;

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.error('WS connect failed', e);
      this._scheduleReconnect();
      return;
    }

    // Connection timeout: close if no 'open' event within 10 seconds
    const connectTimeout = setTimeout(() => {
      if (this._ws && this._ws.readyState !== WebSocket.OPEN) {
        console.warn('[WS] Connection timeout');
        this._ws.close();
      }
    }, 10000);

    this._ws.onopen = () => {
      clearTimeout(connectTimeout);
      this._connected = true;
      this._reconnectDelay = 1000;
      // v7.3.5: cookie auth worked — clear the fallback flag so future
      // reconnects also try cookie-first (in case token rotated).
      this._useTokenFallback = false;
      if (window._ddDebug) console.log('[WS] Connected');
      this._emit('_connected');
      // Re-subscribe channels
      for (const ch of this._subscriptions) {
        this._send({ type: 'subscribe', channel: ch });
      }
    };

    this._ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        this._emit(msg.type, msg);
        // Also emit with channel prefix if present
        if (msg.channel) {
          this._emit(`${msg.type}:${msg.channel}`, msg);
        }
      } catch { /* ignore */ }
    };

    this._ws.onclose = (evt) => {
      this._connected = false;
      if (window._ddDebug) console.log('[WS] Disconnected', evt.code);
      this._emit('_disconnected');
      if (evt.code === 4003) {
        // Revoked/changed sessions must not trigger token-in-URL fallback.
        this._intentionalClose = true;
        this._useTokenFallback = false;
        clearTimeout(this._reconnectTimer);
        if (typeof App !== 'undefined') App.handleUnauthorized();
        return;
      }
      if (evt.code === 4001) {
        // v7.3.5: cookie auth failed. If we haven't tried token-in-query yet
        // and we have a Bearer token, retry once with the fallback. This
        // handles browsers that block the session cookie (e.g. strict
        // tracking prevention). Only flip + retry if the user is still
        // authenticated as far as the API is concerned.
        if (!this._useTokenFallback && Api?._bearerToken && !this._intentionalClose) {
          this._useTokenFallback = true;
          if (window._ddDebug) console.log('[WS] Cookie auth rejected, retrying with token fallback');
          this._scheduleReconnect();
          return;
        }
        // Either we already tried both modes, or we have no token to try.
        // Real auth failure — bounce to login (idempotent in v7.3.1+).
        if (typeof App !== 'undefined') App.handleUnauthorized();
        return;
      }
      if (!this._intentionalClose) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = () => {
      // onclose will fire after this
    };
  },

  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._connected = false;
    this._subscriptions.clear();
  },

  subscribe(channel) {
    this._subscriptions.add(channel);
    if (this._connected) {
      this._send({ type: 'subscribe', channel });
    }
  },

  unsubscribe(channel) {
    this._subscriptions.delete(channel);
    if (this._connected) {
      this._send({ type: 'unsubscribe', channel });
    }
  },

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  },

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  },

  send(type, data) {
    this._send({ type, ...data });
  },

  get isConnected() {
    return this._connected;
  },

  // ─── Internal ──────────────────────────────────
  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  },

  _emit(type, data) {
    const set = this._handlers.get(type);
    if (set) {
      for (const fn of set) {
        try { fn(data); } catch (e) { console.error(`WS handler error [${type}]`, e); }
      }
    }
  },

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const baseDelay = this._reconnectDelay;
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = baseDelay + jitter;
    this._reconnectTimer = setTimeout(() => {
      if (window._ddDebug) console.log('[WS] Reconnecting...');
      this.connect();
    }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnect);
  },
};

window.WS = WS;
