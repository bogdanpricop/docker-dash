/* ═══════════════════════════════════════════════════
   pages/incus-instances.js — Incus instances list
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.0-alpha.2 — Sprint 3 (Incus / LXD-successor).
//
// MINIMAL first-pass UI: list instances with their status, IPs,
// memory, and CPU. Row actions: Start, Stop, Restart, Delete. No
// snapshots UI, no console, no create-instance form yet — those
// land in v8.9.0 proper once real-world use verifies the plumbing.
//
// The page relies on the daemon_type='incus' capability gate — the
// nav item will only be surfaced when the current host is Incus (see
// index.html data-capability="incus" + App._refreshCapabilities).

const IncusInstancesPage = {
  _project: null,
  _hosts: [],
  _hostId: null,

  async render(container) {
    // v8.9.23 — resolve THIS page's own Incus/LXD host instead of following the
    // top-bar selection (which may be a Docker host → "not an Incus daemon").
    try { this._hosts = ((await Api.getHosts()) || []).filter(h => h.daemonType === 'incus' || h.daemonType === 'lxd'); } catch { this._hosts = []; }
    if (!this._hosts.length) {
      container.innerHTML = `
        <div class="page-header"><h1><i class="fas fa-cubes"></i> Incus / LXD instances</h1></div>
        <div class="empty-msg"><i class="fas fa-cubes" style="font-size:32px;opacity:.3;display:block;margin-bottom:8px"></i>
          No Incus / LXD host registered. Add one from <a href="#/hosts">Hosts → Non-Docker host</a>.</div>`;
      return;
    }
    const gid = Api.getHostId();
    if (this._hosts.some(h => h.id === gid)) this._hostId = gid;
    else if (!this._hostId || !this._hosts.some(h => h.id === this._hostId)) this._hostId = this._hosts[0].id;

    const hostSel = this._hosts.length > 1
      ? `<select id="incus-host" class="form-control" style="width:auto;display:inline-block;margin-right:8px">
           ${this._hosts.map(h => `<option value="${h.id}"${h.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(h.name)}</option>`).join('')}
         </select>`
      : `<span class="text-muted" style="margin-right:8px">${Utils.escapeHtml(this._hosts[0].name)}</span>`;

    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-cubes"></i> Incus / LXD instances</h1>
        <div>
          ${hostSel}
          <select id="incus-project" class="form-control" style="width:auto;display:inline-block"></select>
          <button class="btn btn-sm btn-secondary" id="incus-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div id="incus-info-panel"></div>
      <div id="incus-list-container">Loading...</div>
    `;
    const hs = container.querySelector('#incus-host');
    if (hs) hs.addEventListener('change', (e) => { this._hostId = parseInt(e.target.value, 10); this._project = null; this._loadProjects().then(() => this._load()); });
    container.querySelector('#incus-refresh').addEventListener('click', () => this._load());
    container.querySelector('#incus-project').addEventListener('change', (e) => {
      this._project = e.target.value || null;
      this._load();
    });
    await this._loadProjects();
    await this._load();
  },

  async _loadProjects() {
    try {
      const projects = await Api.getIncusProjects(this._hostId);
      const sel = document.getElementById('incus-project');
      sel.innerHTML = `<option value="">(default)</option>` + projects
        .map(p => `<option value="${Utils.escapeHtml(p.name)}"${p.name === this._project ? ' selected' : ''}>${Utils.escapeHtml(p.name)}</option>`)
        .join('');
    } catch { /* no projects endpoint on very old Incus — leave dropdown as-is */ }
  },

  async _load() {
    const el = document.getElementById('incus-list-container');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading instances...</div>`;
    try {
      const list = await Api.getIncusInstances(this._hostId, this._project);
      // Info panel
      try {
        const info = await Api.getIncusInfo(this._hostId);
        const infoEl = document.getElementById('incus-info-panel');
        if (infoEl && info) {
          const env = info.environment || {};
          infoEl.innerHTML = `
            <div class="card" style="margin-bottom:16px">
              <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
                <div><strong>Server:</strong> ${Utils.escapeHtml(env.server_name || '—')}</div>
                <div><strong>Version:</strong> ${Utils.escapeHtml(env.server_version || '—')}</div>
                <div><strong>API:</strong> ${(info.api_extensions || []).length} extensions</div>
                <div><strong>Kernel:</strong> ${Utils.escapeHtml(env.kernel_version || '—')}</div>
              </div>
            </div>
          `;
        }
      } catch { /* info is best-effort */ }
      this._renderList(el, list);
    } catch (err) {
      if (/forbidden|untrusted/i.test(err.message || '')) { await this._renderTrustHelp(el, err); return; }
      el.innerHTML = `<div class="empty-msg">Error loading Incus instances: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // Incus rejects docker-dash until its client cert is trusted. Guide the user
  // through it: show the fingerprint + manual command, and a token field for
  // one-click self-registration (incus config trust add <name> → token).
  async _renderTrustHelp(el, err) {
    let fp = null;
    try { fp = (await Api.getIncusClientInfo(this._hostId)).fingerprint; } catch { /* ignore */ }
    el.innerHTML = `
      <div class="card" style="border:1px solid var(--yellow);border-left:4px solid var(--yellow)">
        <div class="card-header"><h3><i class="fas fa-user-lock" style="color:var(--yellow);margin-right:8px"></i>Not trusted by this Incus/LXD server</h3></div>
        <div class="card-body">
          <p class="text-muted">${Utils.escapeHtml(err.message)}</p>
          ${fp ? `<div style="margin:8px 0"><b>docker-dash client cert fingerprint:</b> <span class="mono">${Utils.escapeHtml(fp)}</span></div>` : ''}
          <h4 style="margin:12px 0 6px">Option A — trust token (recommended)</h4>
          <p class="text-muted" style="font-size:13px">On the Incus host run <span class="mono">incus config trust add docker-dash</span>, copy the token, and paste it here:</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="text" id="incus-token" class="form-control" style="flex:1;min-width:240px" placeholder="paste the trust token">
            <button class="btn btn-primary" id="incus-trust-btn"><i class="fas fa-key"></i> Trust &amp; retry</button>
          </div>
          <h4 style="margin:16px 0 6px">Option B — add the certificate manually</h4>
          <p class="text-muted" style="font-size:13px">On the Incus host, with the docker-dash client certificate saved as <span class="mono">dd.crt</span>:</p>
          <pre class="inspect-json" style="color:var(--text)">incus config trust add-certificate dd.crt</pre>
        </div>
      </div>`;
    const btn = el.querySelector('#incus-trust-btn');
    if (btn) btn.addEventListener('click', async () => {
      const token = el.querySelector('#incus-token').value.trim();
      if (!token) { Toast.warning('Paste the trust token first'); return; }
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Trusting…';
      try {
        const r = await Api.incusTrust(this._hostId, token);
        if (r && r.ok === false) { Toast.error(r.error || 'Trust failed'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-key"></i> Trust & retry'; return; }
        Toast.success('Trusted — loading instances');
        await this._load();
      } catch (e) { Toast.error(e.message); btn.disabled = false; btn.innerHTML = '<i class="fas fa-key"></i> Trust & retry'; }
    });
  },

  _renderList(el, list) {
    if (!list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-cube" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px"></i>No Incus instances in this project. Create one from the CLI: <code>incus launch images:debian/12 my-instance</code></div>`;
      return;
    }
    const rows = list.map(inst => {
      const status = inst.status || '—';
      const statusColor = status === 'Running' ? 'green' : status === 'Stopped' ? 'red' : 'yellow';
      const type = inst.type || 'container';
      const typeIcon = type === 'virtual-machine' ? 'fa-desktop' : 'fa-box';
      const state = inst.state || {};
      const memBytes = state.memory && state.memory.usage;
      const cpuUsage = state.cpu && state.cpu.usage;
      // Extract first IPv4 from any interface, if instance is running.
      let ip = '—';
      if (state.network) {
        for (const iface of Object.values(state.network)) {
          if (!iface.addresses) continue;
          for (const a of iface.addresses) {
            if (a.family === 'inet' && a.scope !== 'link' && a.address) { ip = a.address; break; }
          }
          if (ip !== '—') break;
        }
      }
      const canStart = status !== 'Running';
      const canStop  = status === 'Running';
      const name = Utils.escapeHtml(inst.name);
      return `
        <tr>
          <td><i class="fas ${typeIcon}" style="margin-right:6px;opacity:0.7"></i><strong>${name}</strong></td>
          <td><span class="badge badge-${statusColor}">${Utils.escapeHtml(status)}</span></td>
          <td class="text-muted">${Utils.escapeHtml(type)}</td>
          <td>${Utils.escapeHtml(ip)}</td>
          <td>${memBytes ? Utils.formatBytes(memBytes) : '—'}</td>
          <td>${cpuUsage != null ? cpuUsage : '—'}</td>
          <td>
            <button class="btn btn-xs btn-success" data-action="start" data-name="${name}" ${canStart ? '' : 'disabled'} title="Start"><i class="fas fa-play"></i></button>
            <button class="btn btn-xs btn-warning" data-action="stop" data-name="${name}" ${canStop ? '' : 'disabled'} title="Stop"><i class="fas fa-stop"></i></button>
            <button class="btn btn-xs btn-secondary" data-action="restart" data-name="${name}" ${canStop ? '' : 'disabled'} title="Restart"><i class="fas fa-sync"></i></button>
            <button class="btn btn-xs btn-danger" data-action="delete" data-name="${name}" title="Delete"><i class="fas fa-trash"></i></button>
          </td>
        </tr>
      `;
    }).join('');
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr><th>Name</th><th>Status</th><th>Type</th><th>IPv4</th><th>Memory</th><th>CPU %</th><th>Actions</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div></div>
    `;
    el.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => this._runAction(btn.dataset.name, btn.dataset.action));
    });
  },

  async _runAction(name, action) {
    if (action === 'delete') {
      const ok = await Modal.confirm(
        `Delete Incus instance "${name}"? This is irreversible. Snapshots will be deleted with it.`,
        { danger: true, confirmText: 'Delete Instance' },
      );
      if (!ok) return;
    }
    try {
      let promise;
      if (action === 'start')        promise = Api.startIncusInstance(this._hostId, name);
      else if (action === 'stop')    promise = Api.stopIncusInstance(this._hostId, name, false);
      else if (action === 'restart') promise = Api.restartIncusInstance(this._hostId, name);
      else if (action === 'delete')  promise = Api.deleteIncusInstance(this._hostId, name);
      else return;
      Toast.info(`${action.charAt(0).toUpperCase() + action.slice(1)}...`);
      await promise;
      Toast.success(`Instance "${name}" — ${action} OK`);
      await this._load();
    } catch (err) {
      Toast.error(`${action} failed: ${err.message}`);
    }
  },

  destroy() {},
};

window.IncusInstancesPage = IncusInstancesPage;
