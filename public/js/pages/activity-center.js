/* Durable provider-operation activity center. */
'use strict';

const ActivityCenterPage = {
  _off: null,
  _timer: null,
  _hosts: [],
  _items: [],

  async render(container, params = {}) {
    this.destroy();
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-tasks"></i> Activity Center</h1>
      <div class="text-muted text-sm">Durable virtualization tasks, retries, reconciliation, and outcomes</div></div>
      <button class="btn btn-sm btn-secondary" id="activity-refresh"><i class="fas fa-sync"></i> Refresh</button></div>
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap">
        <select id="activity-host" class="form-control" style="width:auto"><option value="">All permitted endpoints</option>
          ${this._hosts.map(host => `<option value="${host.id}">${Utils.escapeHtml(host.name)}</option>`).join('')}</select>
        <select id="activity-state" class="form-control" style="width:auto"><option value="">All states</option>
          ${['queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown']
            .map(state => `<option value="${state}">${state.replaceAll('_', ' ')}</option>`).join('')}</select>
        <span class="text-muted text-sm" id="activity-count" style="align-self:center"></span>
      </div><div id="activity-list"></div><div id="activity-detail" style="margin-top:16px"></div>`;
    container.querySelector('#activity-refresh').addEventListener('click', () => this._load());
    container.querySelector('#activity-host').addEventListener('change', () => this._load());
    container.querySelector('#activity-state').addEventListener('change', () => this._load());
    WS.subscribe('provider:operations');
    this._off = WS.on('provider:operation:update', () => {
      clearTimeout(this._timer); this._timer = setTimeout(() => this._load(), 150);
    });
    await this._load();
    const id = String(params.id || '').split('/')[0];
    if (/^op_[a-f0-9]{26}$/.test(id)) await this._showDetail(id);
  },

  async _load() {
    const target = document.getElementById('activity-list');
    if (!target) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading activity…</div>';
    try {
      const result = await Api.getProviderOperations({
        limit: 200, hostId: document.getElementById('activity-host')?.value || null,
        state: document.getElementById('activity-state')?.value || null,
      });
      this._items = result.items || [];
      const count = document.getElementById('activity-count'); if (count) count.textContent = `${this._items.length} operation(s)`;
      this._renderList(target);
    } catch (err) {
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderList(target) {
    if (!this._items.length) {
      target.innerHTML = '<div class="empty-msg"><i class="fas fa-check-circle"></i>No provider operations match these filters.</div>';
      return;
    }
    target.innerHTML = `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Operation</th><th>Provider</th><th>Action</th><th>State</th><th>Progress</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>
      ${this._items.map(item => `<tr data-operation-id="${item.id}" style="cursor:pointer"><td><code>${Utils.escapeHtml(item.id)}</code><div class="text-muted text-sm">${Utils.escapeHtml(item.resource?.id || '')}</div></td>
        <td>${Utils.escapeHtml(item.provider?.type || '—')} · #${item.provider?.endpointId || '—'}</td><td>${Utils.escapeHtml(item.action || item.type)}</td>
        <td><span class="badge ${Utils.statusBadgeClass(item.state)}">${Utils.escapeHtml(item.state)}</span></td>
        <td style="min-width:120px"><div style="height:6px;background:var(--surface2);border-radius:6px;overflow:hidden"><div style="height:100%;width:${Math.max(0, Math.min(100, item.progress || 0))}%;background:var(--accent)"></div></div><span class="text-muted text-sm">${item.progress || 0}%</span></td>
        <td>${item.attempt}/${item.maxAttempts}</td><td>${Utils.escapeHtml(Utils.timeAgo(item.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`;
    target.querySelectorAll('[data-operation-id]').forEach(row => row.addEventListener('click', () => {
      history.replaceState(null, '', `#/activity/${row.dataset.operationId}`); this._showDetail(row.dataset.operationId);
    }));
  },

  async _showDetail(id) {
    const target = document.getElementById('activity-detail');
    if (!target) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading operation evidence…</div>';
    try {
      const [operation, eventResult] = await Promise.all([Api.getProviderOperation(id), Api.getProviderOperationEvents(id, 200)]);
      target.innerHTML = `<div class="card" style="padding:16px"><div style="display:flex;justify-content:space-between;gap:12px"><div><h3 style="margin:0">${Utils.escapeHtml(operation.action || operation.type)}</h3>
        <code>${Utils.escapeHtml(operation.id)}</code></div><button class="btn btn-sm btn-secondary" id="activity-close">Close</button></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0">
          <div><span class="text-muted text-sm">State</span><br><span class="badge ${Utils.statusBadgeClass(operation.state)}">${Utils.escapeHtml(operation.state)}</span></div>
          <div><span class="text-muted text-sm">Provider</span><br>${Utils.escapeHtml(operation.provider?.type)} · #${operation.provider?.endpointId}</div>
          <div><span class="text-muted text-sm">Progress</span><br>${operation.progress}% · ${Utils.escapeHtml(operation.phase || '—')}</div>
          <div><span class="text-muted text-sm">Resource</span><br><a href="#/virtual-machines/${operation.provider?.endpointId}/${operation.resource?.id}"><code>${Utils.escapeHtml(operation.resource?.id)}</code></a></div>
        </div>
        ${operation.error ? `<div class="alert alert-danger">${Utils.escapeHtml(operation.error.code)} · ${Utils.escapeHtml(operation.error.message || '')}</div>` : ''}
        <h4>Timeline</h4><div style="display:grid;gap:8px">${(eventResult.events || []).map(event => `<div style="border-left:3px solid var(--accent);padding:6px 10px;background:var(--surface2)">
          <strong>${Utils.escapeHtml(event.type)}</strong> <span class="text-muted text-sm">${Utils.escapeHtml(Utils.formatDate(event.createdAt))}</span>
          <div>${Utils.escapeHtml(event.message || '')}${event.progress != null ? ` · ${event.progress}%` : ''}</div></div>`).join('') || '<div class="text-muted">No events recorded.</div>'}</div></div>`;
      target.querySelector('#activity-close').addEventListener('click', () => {
        target.innerHTML = ''; history.replaceState(null, '', '#/activity');
      });
    } catch (err) {
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  destroy() {
    clearTimeout(this._timer); this._timer = null;
    if (this._off) this._off();
    this._off = null;
    try { WS.unsubscribe('provider:operations'); } catch { /* best-effort */ }
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = ActivityCenterPage;
