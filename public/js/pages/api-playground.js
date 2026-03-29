/* ═══════════════════════════════════════════════════
   pages/api-playground.js — REST API Playground
   ═══════════════════════════════════════════════════ */
'use strict';

const ApiPlaygroundPage = {
  _docs: null,
  _expandedGroup: null,
  _history: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-flask" style="color:var(--accent)"></i> ${i18n.t('pages.apiPlayground.title')}</h2>
          <div class="page-subtitle">${i18n.t('pages.apiPlayground.subtitle')}</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="api-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="api-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.apiPlayground.loadingDocs')}</div></div>
    `;

    container.querySelector('#api-refresh').addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const el = document.getElementById('api-content');
    if (!el) return;

    try {
      const docs = await Api.get('/docs');
      this._docs = docs;

      const endpoints = docs.endpoints || [];

      // Separate top-level endpoints (no group) and grouped endpoints
      const topLevel = endpoints.filter(e => !e.group && e.method);
      const groups = endpoints.filter(e => e.group);

      let html = '';

      // Top-level endpoints
      if (topLevel.length) {
        html += this._renderGroup({ group: 'General', endpoints: topLevel });
      }

      // Grouped endpoints
      for (const g of groups) {
        html += this._renderGroup(g);
      }

      el.innerHTML = `
        <div class="text-sm text-muted" style="margin-bottom:16px">
          <i class="fas fa-info-circle"></i> Base URL: <code style="background:var(--surface2);padding:2px 6px;border-radius:4px">${window.location.origin}/api</code>
          &nbsp;|&nbsp; Version: <strong>${Utils.escapeHtml(docs.version || '?')}</strong>
          &nbsp;|&nbsp; ${i18n.t('pages.apiPlayground.auth')}
        </div>
        <div id="api-try-panel" style="display:none;margin-bottom:16px"></div>
        ${html}
      `;

      // Group header toggle
      el.querySelectorAll('.api-group-header').forEach(header => {
        header.addEventListener('click', () => {
          const group = header.closest('.api-group');
          group.classList.toggle('collapsed');
        });
      });

      // Try it buttons
      el.querySelectorAll('.api-try-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const method = btn.dataset.method;
          const path = btn.dataset.path;
          const desc = btn.dataset.desc || '';
          this._showTryPanel(method, path, desc);
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${i18n.t('pages.apiPlayground.loadFailed', { message: Utils.escapeHtml(err.message) })}</div>`;
    }
  },

  _renderGroup(g) {
    const eps = g.endpoints || [];
    return `
      <div class="api-group card" style="margin-bottom:8px">
        <div class="api-group-header card-header" style="cursor:pointer;user-select:none">
          <h3 style="display:flex;align-items:center;gap:8px">
            <i class="fas fa-chevron-down" style="font-size:12px;transition:transform 0.2s"></i>
            ${Utils.escapeHtml(g.group)}
            <span class="text-muted text-sm" style="font-weight:normal">(${eps.length} ${i18n.t('pages.apiPlayground.endpoints')})</span>
          </h3>
        </div>
        <div class="api-group-body card-body" style="padding:0">
          <table class="data-table" style="margin:0">
            <tbody>
              ${eps.map(e => `
                <tr>
                  <td style="width:80px"><span class="api-method-badge api-method-${(e.method || 'GET').toLowerCase()}">${e.method || 'GET'}</span></td>
                  <td style="font-family:var(--mono);font-size:12px">${this._highlightParams(e.path || '')}</td>
                  <td class="text-muted text-sm">${Utils.escapeHtml(e.description || '')}</td>
                  <td style="width:40px;text-align:center">${e.auth === false ? '<span class="text-muted text-xs" title="No auth required"><i class="fas fa-unlock"></i></span>' : '<span class="text-muted text-xs" title="Auth required"><i class="fas fa-lock"></i></span>'}</td>
                  <td style="width:70px"><button class="btn btn-xs btn-primary api-try-btn" data-method="${e.method || 'GET'}" data-path="${Utils.escapeHtml(e.path || '')}" data-desc="${Utils.escapeHtml(e.description || '')}">${i18n.t('pages.apiPlayground.tryIt')}</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  _highlightParams(path) {
    return Utils.escapeHtml(path).replace(/:([a-zA-Z_]+)/g, '<span style="color:var(--yellow);font-weight:600">:$1</span>');
  },

  _showTryPanel(method, path, desc) {
    const panel = document.getElementById('api-try-panel');
    if (!panel) return;
    panel.style.display = 'block';

    // Extract path params
    const paramMatches = path.match(/:([a-zA-Z_]+)/g) || [];
    const params = paramMatches.map(p => p.substring(1));
    const needsBody = ['POST', 'PUT', 'PATCH'].includes(method);

    panel.innerHTML = `
      <div class="card" style="border:2px solid var(--accent)">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="display:flex;align-items:center;gap:8px;margin:0">
            <span class="api-method-badge api-method-${method.toLowerCase()}">${method}</span>
            <span style="font-family:var(--mono);font-size:13px">${this._highlightParams(path)}</span>
          </h3>
          <button class="action-btn" id="api-try-close" title="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="card-body">
          ${desc ? `<div class="text-muted text-sm" style="margin-bottom:12px">${Utils.escapeHtml(desc)}</div>` : ''}
          ${params.length ? `
            <div style="margin-bottom:12px">
              <label class="text-sm" style="font-weight:600;margin-bottom:4px;display:block">${i18n.t('pages.apiPlayground.pathParameters')}</label>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                ${params.map(p => `
                  <div style="display:flex;align-items:center;gap:4px">
                    <span class="text-sm" style="font-family:var(--mono);color:var(--yellow)">:${p}</span>
                    <input type="text" class="form-control form-control-sm api-param" data-param="${p}" placeholder="${p}" style="width:160px">
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
          ${needsBody ? `
            <div style="margin-bottom:12px">
              <label class="text-sm" style="font-weight:600;margin-bottom:4px;display:block">${i18n.t('pages.apiPlayground.requestBody')}</label>
              <textarea id="api-req-body" class="form-control" style="font-family:var(--mono);font-size:12px;height:120px;resize:vertical" placeholder='{"key": "value"}'></textarea>
            </div>
          ` : ''}
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-primary" id="api-send"><i class="fas fa-paper-plane"></i> ${i18n.t('pages.apiPlayground.send')}</button>
            <button class="btn btn-secondary btn-sm" id="api-copy-curl" title="${i18n.t('pages.apiPlayground.curl')}"><i class="fas fa-terminal"></i> ${i18n.t('pages.apiPlayground.curl')}</button>
            <span id="api-response-time" class="text-muted text-sm"></span>
          </div>
          <div id="api-response" style="margin-top:12px;display:none">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span id="api-resp-status" style="font-weight:600"></span>
              <button class="btn btn-xs btn-secondary" id="api-copy-resp"><i class="fas fa-copy"></i> ${i18n.t('pages.apiPlayground.copy')}</button>
            </div>
            <pre id="api-resp-body" style="background:var(--surface1);padding:16px;border-radius:var(--radius);overflow:auto;max-height:400px;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word"></pre>
          </div>
        </div>
      </div>
    `;

    panel.querySelector('#api-try-close').addEventListener('click', () => {
      panel.style.display = 'none';
      panel.innerHTML = '';
    });

    panel.querySelector('#api-send').addEventListener('click', () => this._sendRequest(method, path, params));

    panel.querySelector('#api-copy-curl').addEventListener('click', () => {
      const curl = this._buildCurl(method, path, params);
      navigator.clipboard?.writeText(curl);
      Toast.success(i18n.t('pages.apiPlayground.curlCopied'));
    });

    panel.querySelector('#api-copy-resp')?.addEventListener('click', () => {
      const body = document.getElementById('api-resp-body')?.textContent || '';
      navigator.clipboard?.writeText(body);
      Toast.success(i18n.t('pages.apiPlayground.responseCopied'));
    });

    // Scroll to panel
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  _buildPath(path, params) {
    let resolved = path;
    for (const p of params) {
      const input = document.querySelector(`.api-param[data-param="${p}"]`);
      const val = input?.value?.trim() || p;
      resolved = resolved.replace(`:${p}`, encodeURIComponent(val));
    }
    return resolved;
  },

  _buildCurl(method, path, params) {
    const resolvedPath = this._buildPath(path, params);
    const bodyEl = document.getElementById('api-req-body');
    const body = bodyEl?.value?.trim() || '';
    let curl = `curl -X ${method} '${window.location.origin}${resolvedPath}'`;
    curl += ` \\\n  -H 'Content-Type: application/json'`;
    if (Api._bearerToken) curl += ` \\\n  -H 'Authorization: Bearer ${Api._bearerToken}'`;
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      curl += ` \\\n  -d '${body}'`;
    }
    return curl;
  },

  async _sendRequest(method, path, params) {
    const resolvedPath = this._buildPath(path, params);
    // Remove the /api prefix since Api.request adds it
    const apiPath = resolvedPath.replace(/^\/api/, '');

    const bodyEl = document.getElementById('api-req-body');
    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(method) && bodyEl?.value?.trim()) {
      try {
        body = JSON.parse(bodyEl.value.trim());
      } catch {
        Toast.error(i18n.t('pages.apiPlayground.invalidJson'));
        return;
      }
    }

    const sendBtn = document.getElementById('api-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ' + i18n.t('pages.apiPlayground.sending'); }

    const start = performance.now();
    try {
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      };
      if (Api._bearerToken) {
        options.headers['Authorization'] = `Bearer ${Api._bearerToken}`;
      }
      if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(`/api${Api._appendHostId(apiPath)}`, options);
      const elapsed = Math.round(performance.now() - start);
      const contentType = res.headers.get('content-type') || '';
      let responseBody;
      if (contentType.includes('json')) {
        responseBody = await res.json();
      } else {
        responseBody = await res.text();
      }

      const timeEl = document.getElementById('api-response-time');
      if (timeEl) timeEl.textContent = `${elapsed}ms`;

      const respEl = document.getElementById('api-response');
      if (respEl) respEl.style.display = 'block';

      const statusEl = document.getElementById('api-resp-status');
      if (statusEl) {
        const color = res.ok ? 'var(--green)' : 'var(--red)';
        statusEl.innerHTML = `<span style="color:${color}">${res.status} ${res.statusText}</span>`;
      }

      const bodyEl2 = document.getElementById('api-resp-body');
      if (bodyEl2) {
        const formatted = typeof responseBody === 'object' ? JSON.stringify(responseBody, null, 2) : responseBody;
        bodyEl2.textContent = formatted;
        this._syntaxHighlight(bodyEl2);
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      const timeEl = document.getElementById('api-response-time');
      if (timeEl) timeEl.textContent = `${elapsed}ms`;

      const respEl = document.getElementById('api-response');
      if (respEl) respEl.style.display = 'block';

      const statusEl = document.getElementById('api-resp-status');
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">Error</span>`;

      const bodyEl2 = document.getElementById('api-resp-body');
      if (bodyEl2) bodyEl2.textContent = err.message;
    } finally {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> ' + i18n.t('pages.apiPlayground.send'); }
    }
  },

  _syntaxHighlight(preEl) {
    // Simple JSON syntax highlighting via inline HTML
    const text = preEl.textContent;
    try {
      JSON.parse(text); // Only highlight if valid JSON
      const highlighted = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"([^"]+)"(\s*:)/g, '<span style="color:#79c0ff">"$1"</span>$2') // keys
        .replace(/:\s*"([^"]*)"/g, ': <span style="color:#a5d6ff">"$1"</span>') // string values
        .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#d2a8ff">$1</span>') // numbers
        .replace(/:\s*(true|false)/g, ': <span style="color:#ff7b72">$1</span>') // booleans
        .replace(/:\s*(null)/g, ': <span style="color:#8b949e">$1</span>'); // null
      preEl.innerHTML = highlighted;
    } catch {
      // Not JSON, leave as-is
    }
  },

  destroy() {},
};

window.ApiPlaygroundPage = ApiPlaygroundPage;
