/* Unified read-only template and image catalog. */
'use strict';

const VirtualizationCatalogPage = {
  _hosts: [],
  _hostId: null,
  _items: [],

  _kindLabel(kind) {
    return {
      vmTemplate: 'VM template', iso: 'ISO image', containerTemplate: 'Container template',
      diskImage: 'Disk image', contentLibraryItem: 'Content Library item',
    }[kind] || kind || 'Artifact';
  },

  _kindIcon(kind) {
    return { vmTemplate: 'fa-clone', iso: 'fa-compact-disc', containerTemplate: 'fa-box', diskImage: 'fa-hard-drive', contentLibraryItem: 'fa-book' }[kind] || 'fa-file';
  },

  _providerLabel(type) {
    return { proxmox: 'Proxmox VE', vsphere: 'VMware vSphere / ESXi', xen: 'Xen / XCP-ng' }[type] || type;
  },

  _searchText(item) {
    return `${item?.displayName || ''} ${item?.description || ''} ${item?.spec?.osType || ''} ${Object.values(item?.labels || {}).join(' ')}`.toLowerCase();
  },

  async render(container) {
    try {
      this._hosts = ((await Api.getHosts()) || []).filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType));
    } catch { this._hosts = []; }
    if (!this._hosts.length) {
      container.innerHTML = `<div class="page-header"><h1><i class="fas fa-images"></i> VM Catalog</h1></div>
        <div class="empty-msg"><i class="fas fa-images"></i>No supported virtualization endpoint is available.</div>`;
      return;
    }
    const selected = Api.getHostId();
    if (this._hosts.some(host => host.id === selected)) this._hostId = selected;
    if (!this._hosts.some(host => host.id === this._hostId)) this._hostId = this._hosts[0].id;
    container.innerHTML = `<div class="page-header">
      <div><h1><i class="fas fa-images"></i> VM Catalog</h1><div class="text-muted text-sm">Provider-neutral templates and installation media · read-only</div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="artifact-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(this._providerLabel(host.daemonType))}</option>`).join('')}</select>
        <button id="artifact-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>
      </div></div>
      <div class="alert alert-info text-sm" style="margin-bottom:16px"><strong>Inventory only.</strong> Native provider references are encrypted at rest and never returned by this API. Clone and create actions arrive in the next safety-gated batch.</div>
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <input id="artifact-search" class="form-control" style="max-width:360px" placeholder="Filter name, OS, description or tag">
        <select id="artifact-kind" class="form-control" style="width:auto"><option value="all">All artifact types</option>
          <option value="vmTemplate">VM templates</option><option value="iso">ISO images</option>
          <option value="containerTemplate">Container templates</option><option value="diskImage">Disk images</option>
          <option value="contentLibraryItem">Content Library items</option></select>
        <span id="artifact-count" class="text-muted text-sm"></span>
      </div>
      <div id="artifact-content"><div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading catalog…</div></div>`;
    container.querySelector('#artifact-host').addEventListener('change', event => {
      this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load();
    });
    container.querySelector('#artifact-refresh').addEventListener('click', () => this._load());
    container.querySelector('#artifact-search').addEventListener('input', () => this._renderItems());
    container.querySelector('#artifact-kind').addEventListener('change', () => this._renderItems());
    await this._load();
  },

  async _load() {
    const target = document.getElementById('artifact-content');
    if (!target) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading catalog…</div>';
    try {
      const envelope = await Api.getProviderArtifacts(this._hostId, { limit: 500 });
      this._items = envelope.items || [];
      this._renderItems();
    } catch (err) {
      this._items = [];
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderItems() {
    const target = document.getElementById('artifact-content');
    if (!target) return;
    const query = (document.getElementById('artifact-search')?.value || '').trim().toLowerCase();
    const kind = document.getElementById('artifact-kind')?.value || 'all';
    const items = this._items.filter(item => (kind === 'all' || item.kind === kind) && (!query || this._searchText(item).includes(query)));
    const count = document.getElementById('artifact-count');
    if (count) count.textContent = `${items.length} of ${this._items.length} artifact(s)`;
    if (!items.length) {
      target.innerHTML = '<div class="empty-msg"><i class="fas fa-search"></i>No artifacts match the current filters.</div>';
      return;
    }
    target.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">${items.map(item => `<article class="card" style="padding:16px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><strong style="overflow-wrap:anywhere"><i class="fas ${this._kindIcon(item.kind)}" style="color:var(--accent);margin-right:7px"></i>${Utils.escapeHtml(item.displayName)}</strong><span class="badge badge-info">${Utils.escapeHtml(this._kindLabel(item.kind))}</span></div>
      ${item.description ? `<p class="text-muted text-sm" style="margin:10px 0">${Utils.escapeHtml(item.description)}</p>` : ''}
      <div class="text-sm" style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px">
        <span><i class="fas fa-microchip"></i> ${item.spec?.cpuCount ?? '—'} vCPU</span>
        <span><i class="fas fa-memory"></i> ${item.spec?.memoryBytes != null ? Utils.formatBytes(item.spec.memoryBytes) : '—'}</span>
        <span><i class="fas fa-hard-drive"></i> ${item.spec?.sizeBytes != null ? Utils.formatBytes(item.spec.sizeBytes) : (Utils.escapeHtml(item.spec?.format || '—'))}</span>
        <span><i class="fas fa-location-dot"></i> ${Utils.escapeHtml(item.provenance?.storage || item.provenance?.pool || item.provenance?.node || 'Provider inventory')}</span>
      </div>
      <div class="text-muted text-sm" style="margin-top:12px">${Utils.escapeHtml(item.spec?.osType || item.spec?.version || 'OS/version not reported')} · seen ${Utils.escapeHtml(Utils.timeAgo(item.observedAt))}</div>
    </article>`).join('')}</div>`;
  },

  destroy() { this._items = []; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = VirtualizationCatalogPage;
