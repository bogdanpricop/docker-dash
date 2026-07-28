/* Provider-neutral, read-only storage health and capacity posture. */
'use strict';

const StoragePosturePage = {
  _hosts: [],
  _hostId: null,
  _container: null,

  _badge(state) {
    return { pass: 'badge-success', warning: 'badge-warning', fail: 'badge-danger', unknown: 'badge-secondary' }[state] || 'badge-secondary';
  },

  _label(value) { return String(value || 'unknown').replaceAll('_', ' '); },

  _formatBytes(value) { return Number.isFinite(value) ? Utils.formatBytes(value) : '—'; },

  _capabilityHtml(capabilities) {
    return `<div class="card" style="padding:14px;margin-bottom:16px"><strong>Evidence coverage</strong>
      <div class="text-muted text-sm" style="margin:4px 0 10px">Only provider-reported evidence is assessed. Unsupported or absent telemetry remains unknown.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(capabilities || {}).map(([key, item]) =>
        `<span class="badge ${this._badge(item.state === 'supported' || item.state === 'conditional' ? 'pass' : 'unknown')}">${Utils.escapeHtml(key)}: ${Utils.escapeHtml(this._label(item.state))}</span>`).join('')}</div></div>`;
  },

  _signalHtml(signal) {
    return `<li><span class="badge ${this._badge(signal.state)}">${Utils.escapeHtml(this._label(signal.state))}</span> <strong>${Utils.escapeHtml(this._label(signal.key))}</strong> — ${Utils.escapeHtml(signal.reason || 'No provider explanation')}</li>`;
  },

  _storageHtml(storage) {
    const allocation = storage.virtualAllocationBytes === null ? '—' : this._formatBytes(storage.virtualAllocationBytes);
    return `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
      <span><i class="fas fa-database" aria-hidden="true"></i> <strong>${Utils.escapeHtml(storage.displayName)}</strong> <span class="text-muted text-sm">${Utils.escapeHtml(storage.type || 'type unknown')}${storage.shared === true ? ' · shared' : (storage.shared === false ? ' · local' : '')}</span></span>
      <span><span class="badge ${this._badge(storage.state)}">${Utils.escapeHtml(this._label(storage.state))}</span>${storage.usedPercent === null ? '' : ` <span class="text-muted text-sm">${storage.usedPercent}% used</span>`}</span>
    </summary><div style="padding-top:14px">
      <div class="stats-grid" style="margin-bottom:12px"><div class="stat-card"><div class="stat-value">${this._formatBytes(storage.capacityBytes)}</div><div class="stat-label">Capacity</div></div>
        <div class="stat-card"><div class="stat-value">${this._formatBytes(storage.usedBytes)}</div><div class="stat-label">Used</div></div>
        <div class="stat-card"><div class="stat-value">${this._formatBytes(storage.freeBytes)}</div><div class="stat-label">Free</div></div>
        <div class="stat-card"><div class="stat-value">${allocation}</div><div class="stat-label">Virtual allocation</div></div></div>
      <ul style="margin:0 0 0 18px;display:grid;gap:7px">${(storage.signals || []).map(signal => this._signalHtml(signal)).join('')}</ul>
      ${storage.contentType ? `<div class="text-muted text-sm" style="margin-top:10px">Content classes: ${Utils.escapeHtml(storage.contentType)}</div>` : ''}
    </div></details>`;
  },

  _resultHtml(result) {
    const summary = result.summary || {};
    const state = summary.state || 'unknown';
    return `${this._capabilityHtml(result.capabilities)}
      <div class="card" style="padding:16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>${Utils.escapeHtml(result.provider?.type || 'Provider')} storage posture</strong><div class="text-muted text-sm">Observed ${Utils.escapeHtml(Utils.timeAgo(result.observedAt))}</div></div><span class="badge ${this._badge(state)}">${Utils.escapeHtml(this._label(state))}</span></div>
      <div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.storageCount ?? 0}</div><div class="stat-label">Storage targets</div></div><div class="stat-card"><div class="stat-value">${summary.states?.fail ?? 0}</div><div class="stat-label">Critical</div></div><div class="stat-card"><div class="stat-value">${summary.states?.warning ?? 0}</div><div class="stat-label">Warnings</div></div><div class="stat-card"><div class="stat-value">${this._formatBytes(summary.freeBytes)}</div><div class="stat-label">Reported free space</div></div></div></div>
      ${(result.storages || []).length ? result.storages.map(storage => this._storageHtml(storage)).join('') : '<div class="empty-msg"><i class="fas fa-database"></i>No storage targets were returned by this provider.</div>'}
      ${(result.limitations || []).length ? `<div class="alert alert-info" style="margin-top:16px"><strong>Assessment limits</strong><ul>${result.limitations.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}`;
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    const selected = Api.getHostId();
    this._hostId = this._hosts.some(host => host.id === selected) ? selected : this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-database"></i> Storage Posture</h1><div class="text-muted text-sm">Read-only provider evidence for accessibility, maintenance, capacity and overcommit risk</div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${this._hosts.length ? `<select id="storage-posture-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select><button id="storage-posture-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>` : ''}</div></div>
      <div id="storage-posture-content"></div>`;
    container.querySelector('#storage-posture-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load(); });
    container.querySelector('#storage-posture-refresh')?.addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const target = this._container?.querySelector('#storage-posture-content');
    if (!target) return;
    if (!this._hostId) { target.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a supported virtualization endpoint to inspect its storage posture.</div>'; return; }
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting live storage evidence…</div>';
    try { target.innerHTML = this._resultHtml(await Api.getProviderStoragePosture(this._hostId)); }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`; }
  },

  destroy() { this._container = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = StoragePosturePage;
