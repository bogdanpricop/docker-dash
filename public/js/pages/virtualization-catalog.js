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

  _canProvision() {
    return App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
  },

  _idempotencyKey() {
    if (globalThis.crypto?.randomUUID) return `vm-provision-${crypto.randomUUID()}`;
    return `vm-provision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  },

  _planHtml(plan) {
    return `<div class="text-sm">
      ${plan.blockers?.length ? `<div class="alert alert-danger"><strong>Provisioning blocked</strong><ul style="margin:8px 0 0 18px">${plan.blockers.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="card" style="padding:12px;display:grid;gap:7px">
        <div><strong>Template:</strong> ${Utils.escapeHtml(plan.artifact.displayName)}</div>
        <div><strong>New VM:</strong> ${Utils.escapeHtml(plan.name)}</div>
        <div><strong>Clone:</strong> ${Utils.escapeHtml(plan.mode.effective)}${plan.mode.requested === 'auto' ? ' (provider default)' : ''}</div>
        <div><strong>Storage:</strong> ${Utils.escapeHtml((plan.placement.candidates || []).find(item => item.id === plan.placement.selected.storageId)?.displayName || 'Provider/source default')}</div>
        <div><strong>Power after create:</strong> Off</div>
      </div>
      ${plan.warnings?.length ? `<ul style="margin:12px 0 0 18px">${plan.warnings.map(item => `<li>${Utils.escapeHtml(item.reason)}</li>`).join('')}</ul>` : ''}
    </div>`;
  },

  async _provision(item) {
    const input = await Modal.form(`<label class="form-label" for="provision-name">New VM name</label>
      <input id="provision-name" class="form-control" maxlength="80" autocomplete="off" placeholder="app-01">
      <label class="form-label" for="provision-mode" style="margin-top:12px">Clone mode</label>
      <select id="provision-mode" class="form-control"><option value="auto">Automatic (recommended)</option><option value="full">Full independent copy</option><option value="linked">Linked/thin clone</option></select>
      <div class="alert alert-info text-sm" style="margin-top:14px">The VM is created powered off. Provider placement and name conflicts are revalidated before submit.</div>`, {
      title: `Create from ${item.displayName}`, submitLabel: 'Check placement', width: '560px',
      onSubmit: root => {
        const name = root.querySelector('#provision-name').value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
          Toast.error('Use 1-80 letters, numbers, dot, underscore or hyphen'); return false;
        }
        return { name, mode: root.querySelector('#provision-mode').value };
      },
    });
    if (!input) return;
    try {
      let plan = await Api.preflightProviderVMProvision(this._hostId, item.id, input);
      if (plan.allowed && plan.placement?.candidates?.length) {
        const placement = await Modal.form(`<label class="form-label" for="provision-storage">Target storage</label>
          <select id="provision-storage" class="form-control"><option value="">Provider/source default</option>${plan.placement.candidates.map(candidate => `<option value="${candidate.id}">${Utils.escapeHtml(candidate.displayName)}${candidate.freeBytes != null ? ` · ${Utils.formatBytes(candidate.freeBytes)} free` : ''}</option>`).join('')}</select>`, {
          title: 'Choose clone placement', submitLabel: 'Review preflight', width: '520px',
          onSubmit: root => ({ storageId: root.querySelector('#provision-storage').value || null }),
        });
        if (!placement) return;
        Object.assign(input, placement);
        plan = await Api.preflightProviderVMProvision(this._hostId, item.id, input);
      }
      if (!plan.allowed) {
        await Modal.confirm(this._planHtml(plan), { title: 'Create-from-template preflight', confirmText: 'Close', html: true, width: '660px' });
        return;
      }
      const confirmed = await Modal.confirm(this._planHtml(plan), {
        title: `Create ${plan.name}`, confirmText: 'Queue VM creation', danger: true,
        typeToConfirm: plan.confirmation.expected, html: true, width: '660px',
      });
      if (!confirmed) return;
      const result = await Api.submitProviderVMProvision(this._hostId, item.id, {
        ...input, planHash: plan.planHash, confirm: true, confirmName: plan.confirmation.expected,
      }, this._idempotencyKey());
      Toast.success(`VM ${plan.name} queued for creation`);
      location.hash = `#/activity/${result.operation.id}`;
    } catch (err) { Toast.error(err.message); }
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
      <div><h1><i class="fas fa-images"></i> VM Catalog</h1><div class="text-muted text-sm">Provider-neutral templates, installation media and safety-gated VM creation</div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="artifact-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(this._providerLabel(host.daemonType))}</option>`).join('')}</select>
        <button id="artifact-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>
      </div></div>
      <div class="alert alert-info text-sm" style="margin-bottom:16px"><strong>Opaque provider identities.</strong> Native references stay encrypted at rest. VM creation requires admin access, live preflight, typed target-name confirmation and a durable provider task.</div>
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
      ${item.kind === 'vmTemplate' && this._canProvision() ? `<button class="btn btn-sm btn-primary" data-provision-artifact="${item.id}" style="margin-top:13px"><i class="fas fa-clone"></i> Create VM</button>` : ''}
    </article>`).join('')}</div>`;
    target.querySelectorAll('[data-provision-artifact]').forEach(button => button.addEventListener('click', () => {
      const item = this._items.find(candidate => candidate.id === button.dataset.provisionArtifact);
      if (item) this._provision(item);
    }));
  },

  destroy() { this._items = []; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = VirtualizationCatalogPage;
