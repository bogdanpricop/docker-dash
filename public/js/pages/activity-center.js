/* Durable provider-operation activity center. */
'use strict';

const ActivityCenterPage = {
  _off: null,
  _timer: null,
  _hosts: [],
  _items: [],

  _ownerLabel(operation) {
    if (operation.owner?.type !== 'user') return 'System';
    return operation.owner.username || `User #${operation.owner.id}`;
  },

  _duration(operation) {
    if (!operation.startedAt) return '—';
    const start = Date.parse(operation.startedAt);
    const end = Date.parse(operation.completedAt || new Date().toISOString());
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
    return Utils.formatDuration(Math.max(1, Math.round((end - start) / 1000)));
  },

  async render(container, params = {}) {
    this.destroy();
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-tasks"></i> Activity Center</h1>
      <div class="text-muted text-sm">Durable virtualization tasks, retries, reconciliation, and outcomes</div></div>
      <button class="btn btn-sm btn-secondary" id="activity-refresh"><i class="fas fa-sync"></i> Refresh</button></div>
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap">
        <label class="sr-only" for="activity-search">Search activity</label><input id="activity-search" class="form-control" style="min-width:220px;flex:1" placeholder="Search operation, VM, action or owner…">
        <select id="activity-host" class="form-control" aria-label="Filter by endpoint" style="width:auto"><option value="">All permitted endpoints</option>
          ${this._hosts.map(host => `<option value="${host.id}">${Utils.escapeHtml(host.name)}</option>`).join('')}</select>
        <select id="activity-state" class="form-control" aria-label="Filter by state" style="width:auto"><option value="">All states</option>
          ${['queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown']
            .map(state => `<option value="${state}">${state.replaceAll('_', ' ')}</option>`).join('')}</select>
        <span class="text-muted text-sm" id="activity-count" style="align-self:center"></span>
      </div><div id="activity-list"></div><div id="activity-detail" style="margin-top:16px"></div>`;
    container.querySelector('#activity-refresh').addEventListener('click', () => this._load());
    container.querySelector('#activity-host').addEventListener('change', () => this._load());
    container.querySelector('#activity-state').addEventListener('change', () => this._load());
    container.querySelector('#activity-search').addEventListener('input', () => this._renderList(document.getElementById('activity-list')));
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
      this._renderList(target);
    } catch (err) {
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderList(target) {
    if (!target) return;
    const needle = String(document.getElementById('activity-search')?.value || '').trim().toLowerCase();
    const items = needle ? this._items.filter(item => [
      item.id, item.type, item.action, item.provider?.type, item.provider?.endpointId,
      item.resource?.id, this._ownerLabel(item), item.state,
    ].some(value => String(value || '').toLowerCase().includes(needle))) : this._items;
    const count = document.getElementById('activity-count');
    if (count) count.textContent = needle ? `${items.length} of ${this._items.length} operation(s)` : `${items.length} operation(s)`;
    if (!items.length) {
      target.innerHTML = '<div class="empty-msg"><i class="fas fa-check-circle"></i>No provider operations match these filters.</div>';
      return;
    }
    target.innerHTML = `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Operation</th><th>Provider</th><th>Action</th><th>Owner</th><th>State</th><th>Native task</th><th>Progress</th><th>Duration</th><th>Updated</th></tr></thead><tbody>
      ${items.map(item => `<tr data-operation-id="${item.id}" tabindex="0" role="button" aria-label="Open operation ${Utils.escapeHtml(item.id)}" style="cursor:pointer"><td><code>${Utils.escapeHtml(item.id)}</code><div class="text-muted text-sm">${Utils.escapeHtml(item.resource?.id || '')}</div></td>
        <td>${Utils.escapeHtml(item.provider?.type || '—')} · #${item.provider?.endpointId || '—'}</td><td>${Utils.escapeHtml(item.action || item.type)}</td>
        <td>${Utils.escapeHtml(this._ownerLabel(item))}</td>
        <td><span class="badge ${Utils.statusBadgeClass(item.state)}">${Utils.escapeHtml(item.state)}</span></td>
        <td>${item.hasNativeTask ? `<span class="badge badge-info">${Utils.escapeHtml(item.nativeTaskState || 'bound')}</span>` : '—'}</td>
        <td style="min-width:120px"><div style="height:6px;background:var(--surface2);border-radius:6px;overflow:hidden"><div style="height:100%;width:${Math.max(0, Math.min(100, item.progress || 0))}%;background:var(--accent)"></div></div><span class="text-muted text-sm">${item.progress || 0}%</span></td>
        <td>${Utils.escapeHtml(this._duration(item))}<div class="text-muted text-sm">attempt ${item.attempt}/${item.maxAttempts}</div></td><td>${Utils.escapeHtml(Utils.timeAgo(item.updatedAt))}</td></tr>`).join('')}</tbody></table></div>`;
    target.querySelectorAll('[data-operation-id]').forEach(row => {
      const open = () => {
        history.replaceState(null, '', `#/activity/${row.dataset.operationId}`); this._showDetail(row.dataset.operationId);
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });
    });
  },

  async _cancelOperation(operation) {
    const nativeWarning = operation.hasNativeTask
      ? 'The provider may reject cancellation or finish in another valid state. An unconfirmed outcome becomes unknown.'
      : 'Queued work can stop locally; dispatched work still requires handler/provider confirmation.';
    const confirmed = await Modal.confirm(`Request cancellation for ${operation.action || operation.type}? ${nativeWarning}`, {
      title: 'Request safe cancellation', confirmText: 'Request cancellation', danger: true,
      typeToConfirm: ['running', 'reconciling', 'cancel_requested'].includes(operation.state) ? operation.id : null,
    });
    if (!confirmed) return;
    try {
      await Api.cancelProviderOperation(operation.id);
      Toast.success('Cancellation requested');
      await this._load(); await this._showDetail(operation.id);
    } catch (err) { Toast.error(err.message); }
  },

  async _resolveOperation(operation) {
    const result = await Modal.form(`<div class="alert alert-warning text-sm">Manual resolution releases the retained resource lock. Verify the result in the native provider before continuing.<div style="margin-top:6px"><code>${Utils.escapeHtml(operation.id)}</code></div></div>
      <label class="form-label">Resolution<select class="form-control" id="activity-resolution"><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label>
      <label class="form-label" style="margin-top:12px">Evidence<textarea class="form-control" id="activity-resolution-evidence" rows="4" maxlength="1000" placeholder="Provider task state, inventory evidence, ticket or console verification"></textarea></label>
      <label class="form-label" style="margin-top:12px">Type operation ID to confirm<input class="form-control" id="activity-resolution-confirm" autocomplete="off" value=""></label>`, {
      title: 'Resolve unknown operation', submitLabel: 'Record resolution', width: '620px',
      onSubmit: modal => {
        const resolution = modal.querySelector('#activity-resolution').value;
        const evidence = modal.querySelector('#activity-resolution-evidence').value.trim();
        const confirmation = modal.querySelector('#activity-resolution-confirm').value;
        if (evidence.length < 8) { Toast.error('Provide at least 8 characters of verification evidence'); return false; }
        if (confirmation !== operation.id) { Toast.error('Operation ID confirmation does not match'); return false; }
        return { resolution, evidence };
      },
    });
    if (!result) return;
    try {
      await Api.resolveProviderOperation(operation.id, result.resolution, result.evidence);
      Toast.success(`Unknown operation resolved as ${result.resolution}`);
      await this._load(); await this._showDetail(operation.id);
    } catch (err) { Toast.error(err.message); }
  },

  async _showDetail(id) {
    const target = document.getElementById('activity-detail');
    if (!target) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading operation evidence…</div>';
    try {
      const [operation, eventResult] = await Promise.all([Api.getProviderOperation(id), Api.getProviderOperationEvents(id, 200)]);
      target.innerHTML = `<div class="card" style="padding:16px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h3 style="margin:0">${Utils.escapeHtml(operation.action || operation.type)}</h3>
        <code>${Utils.escapeHtml(operation.id)}</code></div><div style="display:flex;gap:8px;flex-wrap:wrap">${operation.permissions?.canCancel ? '<button class="btn btn-sm btn-danger" id="activity-cancel"><i class="fas fa-stop-circle"></i> Request cancellation</button>' : ''}${operation.permissions?.canResolve ? '<button class="btn btn-sm btn-warning" id="activity-resolve"><i class="fas fa-gavel"></i> Resolve unknown</button>' : ''}<button class="btn btn-sm btn-secondary" id="activity-close">Close</button></div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0">
          <div><span class="text-muted text-sm">State</span><br><span class="badge ${Utils.statusBadgeClass(operation.state)}">${Utils.escapeHtml(operation.state)}</span></div>
          <div><span class="text-muted text-sm">Provider</span><br>${Utils.escapeHtml(operation.provider?.type)} · #${operation.provider?.endpointId}</div>
          <div><span class="text-muted text-sm">Progress</span><br>${operation.progress}% · ${Utils.escapeHtml(operation.phase || '—')}</div>
          <div><span class="text-muted text-sm">Resource</span><br><a href="#/virtual-machines/${operation.provider?.endpointId}/${operation.resource?.id}"><code>${Utils.escapeHtml(operation.resource?.id)}</code></a></div>
          <div><span class="text-muted text-sm">Owner</span><br>${Utils.escapeHtml(this._ownerLabel(operation))}</div>
          <div><span class="text-muted text-sm">Native task</span><br>${operation.hasNativeTask ? `${Utils.escapeHtml(operation.nativeTaskState || 'bound')} <span class="text-muted text-sm">(reference hidden)</span>` : 'Not bound'}</div>
          <div><span class="text-muted text-sm">Timing</span><br>${Utils.escapeHtml(this._duration(operation))}<div class="text-muted text-sm">${Utils.escapeHtml(Utils.formatDate(operation.startedAt))} → ${Utils.escapeHtml(Utils.formatDate(operation.completedAt))}</div></div>
          <div><span class="text-muted text-sm">Retry</span><br>${operation.attempt}/${operation.maxAttempts} · ${Utils.escapeHtml(operation.retryPolicy)}</div>
        </div>
        ${operation.error ? `<div class="alert alert-danger">${Utils.escapeHtml(operation.error.code)} · ${Utils.escapeHtml(operation.error.message || '')}</div>` : ''}
        ${operation.resolution ? `<div class="alert alert-info"><strong>Manual resolution: ${Utils.escapeHtml(operation.resolution.state)}</strong><div>${Utils.escapeHtml(operation.resolution.evidence || '')}</div></div>` : ''}
        ${operation.cancelRequestedAt ? `<div class="alert alert-warning text-sm">Cancellation requested ${Utils.escapeHtml(Utils.formatDate(operation.cancelRequestedAt))}; final provider state remains authoritative.</div>` : ''}
        <h4>Timeline</h4><div style="display:grid;gap:8px">${(eventResult.events || []).map(event => `<div style="border-left:3px solid var(--accent);padding:6px 10px;background:var(--surface2)">
          <strong>${Utils.escapeHtml(event.type)}</strong> <span class="text-muted text-sm">${Utils.escapeHtml(Utils.formatDate(event.createdAt))}</span>
          <div>${Utils.escapeHtml(event.message || '')}${event.state ? ` · ${Utils.escapeHtml(event.state)}` : ''}${event.phase ? ` · ${Utils.escapeHtml(event.phase)}` : ''}${event.progress != null ? ` · ${event.progress}%` : ''}</div></div>`).join('') || '<div class="text-muted">No events recorded.</div>'}</div></div>`;
      target.querySelector('#activity-close').addEventListener('click', () => {
        target.innerHTML = ''; history.replaceState(null, '', '#/activity');
      });
      target.querySelector('#activity-cancel')?.addEventListener('click', () => this._cancelOperation(operation));
      target.querySelector('#activity-resolve')?.addEventListener('click', () => this._resolveOperation(operation));
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
