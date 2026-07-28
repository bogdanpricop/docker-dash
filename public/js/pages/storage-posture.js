/* Provider-neutral, read-only storage health and capacity posture. */
'use strict';

const StoragePosturePage = {
  _hosts: [],
  _hostId: null,
  _container: null,
  _placementGiB: 10,

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

  _topologyHtml(result) {
    const summary = result.summary || {};
    const coverage = result.coverage || {};
    const rows = (result.sharedBackings || []).map(group => `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span><i class="fas fa-project-diagram" aria-hidden="true"></i> <strong>${group.consumerCount || 0} observed consumers</strong></span><span class="badge ${this._badge(group.state === 'confirmed' ? 'pass' : 'warning')}">${Utils.escapeHtml(group.state || 'review')}</span></summary><div style="padding-top:12px"><div class="text-muted text-sm" style="margin-bottom:9px">${Utils.escapeHtml(group.reason || 'No provider explanation')}</div><ul style="margin:0 0 0 18px;display:grid;gap:6px">${(group.attachments || []).map(item => `<li><strong>${Utils.escapeHtml(item.vm?.displayName || item.vm?.id || 'VM')}</strong> · ${Utils.escapeHtml(item.disk?.label || item.disk?.device || 'disk')}<span class="text-muted text-sm">${item.storage?.displayName ? ` · ${Utils.escapeHtml(item.storage.displayName)}` : ''}</span> <span class="badge ${this._badge(item.attachment?.shared === true ? 'pass' : 'unknown')}">shared: ${Utils.escapeHtml(String(item.attachment?.shared ?? 'unknown'))}</span></li>`).join('')}</ul></div></details>`).join('');
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>Shared-disk topology</strong><div class="text-muted text-sm">Cross-VM backing correlation; provider-native backing references are hidden.</div></div><span class="badge ${this._badge(coverage.complete ? 'pass' : 'unknown')}">${coverage.complete ? 'complete evidence' : 'partial evidence'}</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.confirmedCount ?? 0}</div><div class="stat-label">Confirmed shared</div></div><div class="stat-card"><div class="stat-value">${summary.reviewCount ?? 0}</div><div class="stat-label">Needs review</div></div><div class="stat-card"><div class="stat-value">${coverage.hardwareUnavailable ?? 0}</div><div class="stat-label">Unreadable VM inventories</div></div></div><div class="text-muted text-sm" style="margin:12px 0">${coverage.truncated ? 'VM selection is bounded; results are incomplete.' : 'VM selection was not truncated.'}</div>${rows || '<div class="empty-msg"><i class="fas fa-check-circle"></i>No multi-VM backing was observed in the selected inventory.</div>'}</div>`;
  },

  _placementHtml(result) {
    const summary = result.summary || {};
    const required = result.requested?.requiredBytes;
    const rows = (result.storages || []).map(storage => `<li><strong>${Utils.escapeHtml(storage.displayName)}</strong> <span class="badge ${this._badge(storage.state === 'candidate' ? 'pass' : (storage.state === 'blocked' ? 'fail' : 'unknown'))}">${Utils.escapeHtml(storage.state)}</span> <span class="text-muted text-sm">${Utils.escapeHtml((storage.signals || []).map(signal => signal.key).join(', ') || 'no evidence')}</span></li>`).join('');
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>Disk placement advisory</strong><div class="text-muted text-sm">For ${this._formatBytes(result.requested?.bytes)} plus ${result.requested?.headroomPercent ?? '—'}% headroom (${this._formatBytes(required)} required). This does not reserve capacity.</div></div><span class="badge badge-secondary">read-only</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.candidateCount ?? 0}</div><div class="stat-label">Candidates</div></div><div class="stat-card"><div class="stat-value">${summary.blockedCount ?? 0}</div><div class="stat-label">Blocked</div></div><div class="stat-card"><div class="stat-value">${summary.unknownCount ?? 0}</div><div class="stat-label">Needs evidence</div></div></div><ul style="margin:14px 0 0 18px;display:grid;gap:6px">${rows || '<li>No storage targets were returned.</li>'}</ul></div>`;
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
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${this._hosts.length ? `<label class="text-muted text-sm">Disk GiB <input id="storage-placement-gib" type="number" min="1" max="65536" step="1" value="${this._placementGiB}" class="form-control" style="width:88px;display:inline-block"></label><select id="storage-posture-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select><button id="storage-posture-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>` : ''}</div></div>
      <div id="storage-posture-content"></div>`;
    container.querySelector('#storage-posture-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load(); });
    container.querySelector('#storage-placement-gib')?.addEventListener('change', event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 65536) { this._placementGiB = value; this._load(); } });
    container.querySelector('#storage-posture-refresh')?.addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const target = this._container?.querySelector('#storage-posture-content');
    if (!target) return;
    if (!this._hostId) { target.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a supported virtualization endpoint to inspect its storage posture.</div>'; return; }
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting live storage evidence…</div>';
    try {
      const requestedBytes = this._placementGiB * 1024 * 1024 * 1024;
      const [posture, topology, placement] = await Promise.all([
        Api.getProviderStoragePosture(this._hostId),
        Api.getProviderStorageTopology(this._hostId).catch(error => ({ error })),
        Api.getProviderStoragePlacementAdvisory(this._hostId, requestedBytes).catch(error => ({ error })),
      ]);
      target.innerHTML = this._resultHtml(posture) + (topology.error
        ? `<div class="alert alert-info"><strong>Shared-disk topology unavailable</strong><div>${Utils.escapeHtml(topology.error.message)}</div></div>`
        : this._topologyHtml(topology)) + (placement.error
        ? `<div class="alert alert-info"><strong>Disk placement advisory unavailable</strong><div>${Utils.escapeHtml(placement.error.message)}</div></div>`
        : this._placementHtml(placement));
    }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`; }
  },

  destroy() { this._container = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = StoragePosturePage;
