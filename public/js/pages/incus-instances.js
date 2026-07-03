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

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-cubes"></i> Incus / LXD instances</h1>
        <div>
          <select id="incus-project" class="form-control" style="width:auto;display:inline-block"></select>
          <button class="btn btn-sm btn-secondary" id="incus-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div id="incus-info-panel"></div>
      <div id="incus-list-container">Loading...</div>
    `;
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
      const projects = await Api.getIncusProjects();
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
      const list = await Api.getIncusInstances(this._project);
      // Info panel
      try {
        const info = await Api.getIncusInfo();
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
      el.innerHTML = `<div class="empty-msg">Error loading Incus instances: ${Utils.escapeHtml(err.message)}</div>`;
    }
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
      if (action === 'start')        promise = Api.startIncusInstance(name);
      else if (action === 'stop')    promise = Api.stopIncusInstance(name, false);
      else if (action === 'restart') promise = Api.restartIncusInstance(name);
      else if (action === 'delete')  promise = Api.deleteIncusInstance(name);
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
