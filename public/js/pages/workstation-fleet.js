/* Workstation fleet — generic bootc + Foreman/Katello control plane */
'use strict';

const WorkstationFleetPage = {
  _container: null,
  _data: null,
  _registries: [],
  _edgeSites: [],
  _filters: { search: '', status: '', posture: '', drift: '', siteId: '', hostGroup: '', channel: '' },

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      const [data, registries, edge] = await Promise.all([
        Api.getWorkstationFleetOverview(),
        Api.getRegistries().catch(() => []),
        Api.getEdgeOverview().catch(() => ({ sites: [] })),
      ]);
      this._data = data;
      this._registries = Array.isArray(registries) ? registries : registries.registries || [];
      this._edgeSites = edge.sites || [];
      this._paint();
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><i class="fas fa-laptop-code"></i><h3>Workstation Fleet</h3><p>${Utils.escapeHtml(error.message)}</p></div>`;
    }
  },

  _badge(state) {
    if (['pass', 'online', 'success', 'succeeded', 'verified', 'stable'].includes(state)) return 'badge-success';
    if (['fail', 'failed', 'offline', 'error', 'rejected', 'verification_failed'].includes(state)) return 'badge-danger';
    return 'badge-warning';
  },

  _shortDigest(value) { return value ? `${value.slice(0, 19)}…` : 'not reported'; },

  _filteredDevices() {
    const filters = this._filters;
    return (this._data.devices || []).filter(device => {
      const haystack = [device.name, device.organization, device.location, device.hostGroup,
        device.osName, device.ipAddress, device.bootcDigest].join(' ').toLowerCase();
      const drift = device.posture?.checks?.find(check => check.key === 'image_drift')?.state || 'unknown';
      return (!filters.search || haystack.includes(filters.search.toLowerCase()))
        && (!filters.status || device.status === filters.status)
        && (!filters.posture || device.posture?.state === filters.posture)
        && (!filters.drift || drift === filters.drift)
        && (!filters.siteId || device.edgeSiteId === Number(filters.siteId))
        && (!filters.hostGroup || device.hostGroup === filters.hostGroup)
        && (!filters.channel || device.imageChannel === filters.channel);
    });
  },

  _paint() {
    const data = this._data || {};
    const summary = data.summary || {};
    const devices = this._filteredDevices();
    const mutationEnabled = data.contract?.remoteMutationsEnabled === true;
    this._container.innerHTML = `<div class="control-surface">
      <div class="page-header"><div>
        <h1 class="page-title"><i class="fas fa-laptop-code" style="color:var(--accent);margin-right:10px"></i>Workstation Fleet</h1>
        <p class="page-subtitle">Digest-bound bootc images, Foreman/Katello inventory and guarded workstation lifecycle.</p>
      </div><div class="page-actions">
        <button class="btn btn-secondary" id="wf-refresh"><i class="fas fa-rotate"></i> Refresh</button>
        <button class="btn btn-secondary" id="wf-add-connection"><i class="fas fa-plug"></i> Add Foreman</button>
        <button class="btn btn-primary" id="wf-inspect-artifact"><i class="fas fa-shield-halved"></i> Inspect bootc image</button>
      </div></div>
      <div class="alert ${mutationEnabled ? 'alert-warning' : 'alert-info'}">
        Foreman inventory synchronization is read-only. Registry artifacts are pinned by digest.
        Remote jobs are <strong>${mutationEnabled ? 'enabled for explicitly allowlisted templates' : 'disabled by default'}</strong>.
      </div>
      <div class="info-grid">
        ${this._stat('fa-plug','Connections',summary.connections || 0)}
        ${this._stat('fa-laptop','Workstations',summary.workstations || 0)}
        ${this._stat('fa-signal','Online',summary.online || 0)}
        ${this._stat('fa-link-slash','Offline',summary.offline || 0)}
        ${this._stat('fa-box-archive','Bootc artifacts',summary.artifacts || 0)}
        ${this._stat('fa-code-compare','Drifted',summary.drifted || 0)}
        ${this._stat('fa-circle-check','Compliant',summary.posture?.pass || 0)}
        ${this._stat('fa-triangle-exclamation','Posture failures',summary.posture?.fail || 0)}
      </div>

      <div class="card" style="overflow:auto"><div class="card-header"><h3>Foreman / Katello connections</h3></div>
        <table class="data-table"><thead><tr><th>Name</th><th>Endpoint</th><th>TLS / auth</th><th>Last sync</th><th>Actions</th></tr></thead><tbody>
          ${(data.connections || []).map(connection => `<tr>
            <td><strong>${Utils.escapeHtml(connection.name)}</strong><div class="text-xs text-muted">#${connection.id} · ${connection.enabled ? 'enabled' : 'disabled'}</div></td>
            <td class="mono text-sm">${Utils.escapeHtml(connection.baseUrl)}</td>
            <td>${connection.tlsVerify ? 'verified TLS' : 'TLS verification off'}<div class="text-xs text-muted">${Utils.escapeHtml(connection.authType)} · secret ${connection.hasSecret ? 'stored' : 'absent'}</div></td>
            <td><span class="badge ${this._badge(connection.lastSyncState)}">${Utils.escapeHtml(connection.lastSyncState || 'never')}</span><div class="text-xs text-muted">${connection.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleString() : 'not synchronized'}</div></td>
            <td><div class="btn-group">
              <button class="btn btn-sm btn-secondary" data-wf-test="${connection.id}" aria-label="Test ${Utils.escapeHtml(connection.name)}"><i class="fas fa-vial"></i></button>
              <button class="btn btn-sm btn-secondary" data-wf-sync="${connection.id}" aria-label="Synchronize ${Utils.escapeHtml(connection.name)}"><i class="fas fa-rotate"></i></button>
              <button class="btn btn-sm btn-secondary" data-wf-map="${connection.id}" aria-label="Map ${Utils.escapeHtml(connection.name)}"><i class="fas fa-map-location-dot"></i></button>
              <button class="btn btn-sm btn-secondary" data-wf-edit="${connection.id}" aria-label="Edit ${Utils.escapeHtml(connection.name)}"><i class="fas fa-pen"></i></button>
              <button class="btn btn-sm btn-danger" data-wf-delete="${connection.id}" aria-label="Delete ${Utils.escapeHtml(connection.name)}"><i class="fas fa-trash"></i></button>
            </div></td></tr>`).join('') || this._empty('No Foreman connections configured', 5)}
        </tbody></table>
      </div>

      <div class="card" style="overflow:auto"><div class="card-header"><h3>Foreman to Edge mappings</h3></div>
        <table class="data-table"><thead><tr><th>Connection</th><th>Foreman source</th><th>Edge target</th><th>Action</th></tr></thead><tbody>
          ${(data.mappings || []).map(mapping => { const connection = data.connections.find(item => item.id === mapping.connectionId); return `<tr>
            <td>${Utils.escapeHtml(connection?.name || `#${mapping.connectionId}`)}</td>
            <td><span class="badge badge-info">${Utils.escapeHtml(mapping.sourceKind)}</span> ${Utils.escapeHtml(mapping.sourceRef)}</td>
            <td>${mapping.edgeSiteId ? `site #${mapping.edgeSiteId}` : 'metadata only'}<div class="text-xs text-muted">${Utils.escapeHtml(mapping.scopeRef || 'no scope reference')}</div></td>
            <td><button class="btn btn-sm btn-danger" data-wf-delete-map="${mapping.id}" aria-label="Delete mapping ${Utils.escapeHtml(mapping.sourceRef)}"><i class="fas fa-trash"></i></button></td></tr>`; }).join('') || this._empty('No Foreman mappings configured', 4)}
        </tbody></table>
      </div>

      <div class="card" style="overflow:auto"><div class="card-header"><h3>Approved bootc artifacts</h3></div>
        <table class="data-table"><thead><tr><th>Artifact</th><th>Identity</th><th>Trust / SBOM</th><th>Channel</th><th>Action</th></tr></thead><tbody>
          ${(data.artifacts || []).map(artifact => `<tr>
            <td><strong>${Utils.escapeHtml(artifact.name)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(artifact.repository)}:${Utils.escapeHtml(artifact.sourceRef)}</div></td>
            <td class="mono text-sm" title="${Utils.escapeHtml(artifact.digest)}">${this._shortDigest(artifact.digest)}<div class="text-xs text-muted">${Utils.escapeHtml(artifact.osName || 'OS unknown')} ${Utils.escapeHtml(artifact.osVersion || '')} · ${Utils.escapeHtml(artifact.architecture || 'arch unknown')}</div></td>
            <td><span class="badge ${this._badge(artifact.signatureState)}">${Utils.escapeHtml(artifact.signatureState)}</span><div class="text-xs text-muted">${artifact.sbomRefs.length} SBOM refs · ${Utils.escapeHtml(artifact.signer || 'signer unknown')}</div></td>
            <td><span class="badge ${this._badge(artifact.channel)}">${Utils.escapeHtml(artifact.channel)}</span><div class="text-xs text-muted">${artifact.promotionCount || 0} recorded transition(s)</div></td>
            <td><div class="btn-group"><button class="btn btn-sm btn-secondary" data-wf-history="${artifact.id}"><i class="fas fa-clock-rotate-left"></i> History</button><button class="btn btn-sm btn-secondary" data-wf-promote="${artifact.id}"><i class="fas fa-arrow-up-right-dots"></i> Change channel</button></div></td></tr>`).join('') || this._empty('No bootc artifacts inspected', 5)}
        </tbody></table>
      </div>

      <div class="card"><div class="card-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h3 style="margin-right:auto">Workstations <span class="text-muted text-sm">${devices.length}/${(data.devices || []).length}</span></h3>
        <label class="sr-only" for="wf-search">Search workstations</label><input id="wf-search" class="form-control form-control-sm" style="width:240px" placeholder="Search name, site, group, digest…" value="${Utils.escapeHtml(this._filters.search)}">
        ${this._select('wf-status','Status',['online','offline','error','building','unknown'],this._filters.status)}
        ${this._select('wf-posture','Posture',['pass','warning','fail','unknown'],this._filters.posture)}
        ${this._select('wf-drift','Drift',['pass','warning','fail','unknown'],this._filters.drift)}
        ${this._valueSelect('wf-site','Site',this._edgeSites.map(site => [String(site.id), site.name]),this._filters.siteId)}
        ${this._valueSelect('wf-group','Group',[...new Set((data.devices || []).map(item => item.hostGroup).filter(Boolean))].sort().map(value => [value,value]),this._filters.hostGroup)}
        ${this._select('wf-channel','Channel',['held','canary','stable','unapproved'],this._filters.channel)}
      </div><div style="overflow:auto"><table class="data-table"><thead><tr><th>Workstation</th><th>Site / group</th><th>Image</th><th>Security posture</th><th>Lifecycle</th><th>Action</th></tr></thead><tbody>
        ${devices.map(device => { const drift = device.posture.checks.find(check => check.key === 'image_drift')?.state || 'unknown'; return `<tr>
          <td><strong>${Utils.escapeHtml(device.name)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(device.ipAddress || 'no IP')} · ${Utils.escapeHtml(device.osName || 'OS unknown')}</div><span class="badge ${this._badge(device.status)}">${Utils.escapeHtml(device.status)}</span></td>
          <td>${Utils.escapeHtml(device.location || 'unmapped')}<div class="text-xs text-muted">${Utils.escapeHtml(device.hostGroup || 'no host group')} · site ${device.edgeSiteId || '—'}</div></td>
          <td class="mono text-sm" title="${Utils.escapeHtml(device.bootcDigest || '')}">${this._shortDigest(device.bootcDigest)}<div class="text-xs text-muted"><span class="badge ${this._badge(device.imageChannel)}">${Utils.escapeHtml(device.imageChannel)}</span> · drift <span class="badge ${this._badge(drift)}">${drift}</span></div></td>
          <td><span class="badge ${this._badge(device.posture.state)}">${Utils.escapeHtml(device.posture.state)}</span> ${device.posture.score == null ? '—' : `${device.posture.score}%`}<div class="text-xs text-muted">SB ${this._evidence(device.secureBoot)} · TPM ${this._evidence(device.tpmPresent)} · LUKS ${this._evidence(device.diskEncrypted)} · SELinux ${Utils.escapeHtml(device.selinuxState)}</div></td>
          <td>${Utils.escapeHtml(device.lifecycleEnvironment || 'unknown')}<div class="text-xs text-muted">${Utils.escapeHtml(device.contentView || 'no content view')} · ${device.patchAgeDays == null ? 'patch age unknown' : `${device.patchAgeDays}d patch age`}</div></td>
          <td><button class="btn btn-sm btn-secondary" data-wf-plan="${device.id}"><i class="fas fa-list-check"></i> Plan</button></td></tr>`; }).join('') || this._empty('No workstations match the filters', 6)}
      </tbody></table></div></div>

      <div class="card" style="overflow:auto"><div class="card-header"><h3>Guarded update and rollback plans</h3></div>
        <table class="data-table"><thead><tr><th>Plan</th><th>Digests</th><th>Controls</th><th>State</th><th>Action</th></tr></thead><tbody>
          ${(data.plans || []).map(plan => `<tr>
            <td><strong>#${plan.id} · ${Utils.escapeHtml(plan.action)}</strong><div class="text-xs text-muted">device #${plan.deviceId} · ${Utils.escapeHtml(plan.channel)}</div></td>
            <td class="mono text-xs">${this._shortDigest(plan.previousDigest)} → ${this._shortDigest(plan.targetDigest)}</td>
            <td>${Utils.escapeHtml(plan.remoteJobTemplateId)}<div class="text-xs text-muted">${Utils.escapeHtml(plan.approvalRef)} · ${Utils.escapeHtml(plan.maintenanceWindowRef)}</div></td>
            <td><span class="badge ${this._badge(plan.state)}">${Utils.escapeHtml(plan.state)}</span><div class="text-xs text-muted">${plan.taskRef ? `task ${Utils.escapeHtml(plan.taskRef)}` : plan.state === 'planned' ? `expires ${new Date(plan.expiresAt).toLocaleTimeString()}` : Utils.escapeHtml(plan.errorMessage || `completed ${plan.completedAt || ''}`)}</div></td>
            <td>${plan.state === 'planned' ? `<div class="btn-group"><button class="btn btn-sm btn-secondary" data-wf-preflight="${plan.id}"><i class="fas fa-clipboard-check"></i> Preflight</button><button class="btn btn-sm btn-secondary" data-wf-cancel="${plan.id}"><i class="fas fa-ban"></i> Cancel</button><button class="btn btn-sm btn-danger" data-wf-execute="${plan.id}" ${mutationEnabled ? '' : 'disabled title="Enable the guarded Foreman mutation flag first"'}><i class="fas fa-play"></i> Execute</button></div>` : plan.state === 'running' ? `<button class="btn btn-sm btn-secondary" data-wf-reconcile="${plan.id}"><i class="fas fa-rotate"></i> Reconcile</button>` : '—'}</td></tr>`).join('') || this._empty('No update or rollback plans', 5)}
        </tbody></table>
      </div>
    </div>`;
    this._bind();
  },

  _stat(icon, label, value) { return `<div class="info-item"><div class="info-label"><i class="fas ${icon}" style="margin-right:5px"></i>${label}</div><div class="info-value">${value}</div></div>`; },
  _empty(textValue, colspan) { return `<tr><td colspan="${colspan}" class="text-muted">${textValue}</td></tr>`; },
  _evidence(value) { return value == null ? '?' : value ? '✓' : '✕'; },
  _select(id, label, values, selected) { return `<label class="sr-only" for="${id}">${label}</label><select id="${id}" class="form-control form-control-sm" style="width:130px"><option value="">All ${label.toLowerCase()}</option>${values.map(value => `<option value="${value}" ${selected === value ? 'selected' : ''}>${value}</option>`).join('')}</select>`; },
  _valueSelect(id, label, values, selected) { return `<label class="sr-only" for="${id}">${label}</label><select id="${id}" class="form-control form-control-sm" style="width:150px"><option value="">All ${label.toLowerCase()}</option>${values.map(([value,name]) => `<option value="${Utils.escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${Utils.escapeHtml(name)}</option>`).join('')}</select>`; },

  _bind() {
    this._container.querySelector('#wf-refresh')?.addEventListener('click', () => this.render(this._container));
    this._container.querySelector('#wf-add-connection')?.addEventListener('click', () => this._connectionDialog());
    this._container.querySelector('#wf-inspect-artifact')?.addEventListener('click', () => this._artifactDialog());
    const updateFilters = event => {
      const restoreSearch = event?.target?.id === 'wf-search';
      this._filters = { search: this._container.querySelector('#wf-search').value.trim(),
        status: this._container.querySelector('#wf-status').value, posture: this._container.querySelector('#wf-posture').value,
        drift: this._container.querySelector('#wf-drift').value, siteId: this._container.querySelector('#wf-site').value,
        hostGroup: this._container.querySelector('#wf-group').value, channel: this._container.querySelector('#wf-channel').value };
      this._paint();
      if (restoreSearch) {
        const search = this._container.querySelector('#wf-search');
        search?.focus();
        search?.setSelectionRange(search.value.length, search.value.length);
      }
    };
    this._container.querySelector('#wf-search')?.addEventListener('input', Utils.debounce(updateFilters, 150));
    ['#wf-status','#wf-posture','#wf-drift','#wf-site','#wf-group','#wf-channel'].forEach(selector => this._container.querySelector(selector)?.addEventListener('change', updateFilters));
    this._container.querySelectorAll('[data-wf-test]').forEach(button => button.addEventListener('click', () => this._testConnection(Number(button.dataset.wfTest))));
    this._container.querySelectorAll('[data-wf-sync]').forEach(button => button.addEventListener('click', () => this._syncConnection(Number(button.dataset.wfSync))));
    this._container.querySelectorAll('[data-wf-map]').forEach(button => button.addEventListener('click', () => this._mappingDialog(Number(button.dataset.wfMap))));
    this._container.querySelectorAll('[data-wf-edit]').forEach(button => button.addEventListener('click', () => this._connectionDialog(Number(button.dataset.wfEdit))));
    this._container.querySelectorAll('[data-wf-delete]').forEach(button => button.addEventListener('click', () => this._deleteConnection(Number(button.dataset.wfDelete))));
    this._container.querySelectorAll('[data-wf-delete-map]').forEach(button => button.addEventListener('click', () => this._deleteMapping(Number(button.dataset.wfDeleteMap))));
    this._container.querySelectorAll('[data-wf-history]').forEach(button => button.addEventListener('click', () => this._promotionHistory(Number(button.dataset.wfHistory))));
    this._container.querySelectorAll('[data-wf-promote]').forEach(button => button.addEventListener('click', () => this._promotionDialog(Number(button.dataset.wfPromote))));
    this._container.querySelectorAll('[data-wf-plan]').forEach(button => button.addEventListener('click', () => this._planDialog(Number(button.dataset.wfPlan))));
    this._container.querySelectorAll('[data-wf-preflight]').forEach(button => button.addEventListener('click', () => this._preflight(Number(button.dataset.wfPreflight))));
    this._container.querySelectorAll('[data-wf-cancel]').forEach(button => button.addEventListener('click', () => this._cancelPlan(Number(button.dataset.wfCancel))));
    this._container.querySelectorAll('[data-wf-execute]').forEach(button => button.addEventListener('click', () => this._executeDialog(Number(button.dataset.wfExecute))));
    this._container.querySelectorAll('[data-wf-reconcile]').forEach(button => button.addEventListener('click', () => this._reconcile(Number(button.dataset.wfReconcile))));
  },

  async _reload(message) { if (message) Toast.success(message); await this.render(this._container); },

  async _connectionDialog(id = null) {
    const connection = id ? this._data.connections.find(item => item.id === id) : null;
    const result = await Modal.form(`<div class="form-grid">
      <div class="form-group"><label for="wf-conn-name">Name</label><input id="wf-conn-name" class="form-control" maxlength="120" required value="${Utils.escapeHtml(connection?.name || '')}"></div>
      <div class="form-group"><label for="wf-conn-url">HTTPS endpoint</label><input id="wf-conn-url" class="form-control" type="url" required placeholder="https://foreman.example.org" value="${Utils.escapeHtml(connection?.baseUrl || '')}"></div>
      <div class="form-group"><label for="wf-conn-auth">Authentication</label><select id="wf-conn-auth" class="form-control"><option value="token">Bearer token</option><option value="basic" ${connection?.authType === 'basic' ? 'selected' : ''}>Basic</option></select></div>
      <div class="form-group"><label for="wf-conn-user">Username</label><input id="wf-conn-user" class="form-control" maxlength="255" value="${Utils.escapeHtml(connection?.username || '')}"></div>
      <div class="form-group"><label for="wf-conn-secret">${connection ? 'Replace secret (leave empty to keep)' : 'Secret'}</label><input id="wf-conn-secret" class="form-control" type="password" autocomplete="new-password"></div>
      <div class="form-group"><label><input id="wf-conn-tls" type="checkbox" ${connection?.tlsVerify === false ? '' : 'checked'}> Verify TLS certificate</label></div>
      <div class="form-group"><label><input id="wf-conn-enabled" type="checkbox" ${connection?.enabled === false ? '' : 'checked'}> Enable inventory synchronization</label></div>
      <div class="form-group" style="grid-column:1/-1"><label for="wf-conn-ca">Custom CA PEM (optional)</label><textarea id="wf-conn-ca" class="form-control mono" rows="5" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
      ${connection?.hasCustomCa ? '<div class="form-group" style="grid-column:1/-1"><label><input id="wf-conn-clear-ca" type="checkbox"> Remove the stored custom CA</label></div>' : ''}
    </div>`, { title: connection ? 'Edit Foreman connection' : 'Add Foreman connection', confirmText: 'Save connection', width: '760px',
      onSubmit: async content => {
        const body = { id: connection?.id, name: content.querySelector('#wf-conn-name').value.trim(),
          baseUrl: content.querySelector('#wf-conn-url').value.trim(), authType: content.querySelector('#wf-conn-auth').value,
          username: content.querySelector('#wf-conn-user').value.trim(), tlsVerify: content.querySelector('#wf-conn-tls').checked,
          enabled: content.querySelector('#wf-conn-enabled').checked };
        const caPem = content.querySelector('#wf-conn-ca').value.trim();
        if (caPem || content.querySelector('#wf-conn-clear-ca')?.checked) body.caPem = caPem;
        const secret = content.querySelector('#wf-conn-secret').value;
        if (secret) body.secret = secret;
        try { return Api.saveForemanConnection(body); } catch (error) { Toast.error(error.message); return false; }
      } });
    if (result) await this._reload('Foreman connection saved');
  },

  async _testConnection(id) {
    try { const result = await Api.testForemanConnection(id); Toast.success(`Foreman available${result.version ? ` · ${result.version}` : ''}`); }
    catch (error) { Toast.error(error.message); }
  },

  async _syncConnection(id) {
    try { const result = await Api.syncForemanConnection(id); await this._reload(`Synchronized ${result.run.counts.workstations} workstations`); }
    catch (error) { Toast.error(error.message); }
  },

  async _deleteConnection(id) {
    const connection = this._data.connections.find(item => item.id === id);
    if (!await Modal.confirm(`Delete <strong>${Utils.escapeHtml(connection?.name || String(id))}</strong>, its synchronized inventory, sync history and terminal workflow records? Planned or running workflows must be closed first.`, { title: 'Delete Foreman connection', confirmText: 'Delete', danger: true })) return;
    try { await Api.deleteForemanConnection(id); await this._reload('Foreman connection deleted'); } catch (error) { Toast.error(error.message); }
  },

  async _mappingDialog(connectionId) {
    const sourceRefs = [...new Set((this._data.devices || []).filter(item => item.connectionId === connectionId)
      .flatMap(item => [item.location, item.hostGroup]).filter(Boolean))].sort();
    const result = await Modal.form(`<div class="form-group"><label for="wf-map-kind">Foreman source</label><select id="wf-map-kind" class="form-control"><option value="location">Location</option><option value="host_group">Host group</option></select></div>
      <div class="form-group"><label for="wf-map-source">Exact source name</label><input id="wf-map-source" class="form-control" list="wf-map-sources" required maxlength="512"><datalist id="wf-map-sources">${sourceRefs.map(value => `<option value="${Utils.escapeHtml(value)}"></option>`).join('')}</datalist></div>
      <div class="form-group"><label for="wf-map-site">Edge Site</label><select id="wf-map-site" class="form-control"><option value="">Metadata only</option>${this._edgeSites.map(site => `<option value="${site.id}">${Utils.escapeHtml(site.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label for="wf-map-scope">Scope reference (optional)</label><input id="wf-map-scope" class="form-control" placeholder="site/bucharest"></div>`,
    { title: 'Map Foreman inventory', confirmText: 'Save mapping', onSubmit: async content => {
      try { return Api.saveForemanMapping(connectionId, { sourceKind: content.querySelector('#wf-map-kind').value,
        sourceRef: content.querySelector('#wf-map-source').value.trim(), edgeSiteId: Number(content.querySelector('#wf-map-site').value) || null,
        scopeRef: content.querySelector('#wf-map-scope').value.trim() || null }); } catch (error) { Toast.error(error.message); return false; }
    } });
    if (result) await this._reload('Foreman mapping saved');
  },

  async _deleteMapping(id) {
    const mapping = this._data.mappings.find(item => item.id === id);
    if (!await Modal.confirm(`Delete mapping for <strong>${Utils.escapeHtml(mapping?.sourceRef || String(id))}</strong>?`,
      { title: 'Delete Foreman mapping', confirmText: 'Delete', danger: true })) return;
    try { await Api.deleteForemanMapping(id); await this._reload('Foreman mapping deleted'); }
    catch (error) { Toast.error(error.message); }
  },

  async _artifactDialog() {
    if (!this._registries.length) { Toast.error('Configure a registry before inspecting bootc images'); return; }
    const result = await Modal.form(`<div class="form-grid">
      <div class="form-group"><label for="wf-artifact-name">Artifact name</label><input id="wf-artifact-name" class="form-control" required maxlength="255"></div>
      <div class="form-group"><label for="wf-artifact-registry">Registry</label><select id="wf-artifact-registry" class="form-control">${this._registries.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label for="wf-artifact-repo">Repository</label><input id="wf-artifact-repo" class="form-control" required placeholder="eu-os/workspace-image"></div>
      <div class="form-group"><label for="wf-artifact-ref">Tag or digest</label><input id="wf-artifact-ref" class="form-control" required value="latest"></div>
      <div class="form-group"><label for="wf-artifact-policy">Trust policy</label><select id="wf-artifact-policy" class="form-control"><option value="cosign">Cryptographic Cosign verification</option><option value="annotation">Signature metadata only</option><option value="none">Digest only (held channel)</option></select></div>
      <div class="form-group"><label for="wf-artifact-signer">Signer identity regexp (required for Cosign)</label><input id="wf-artifact-signer" class="form-control" maxlength="256" placeholder="^https://github.com/organization/repository/"></div>
    </div><div class="alert alert-info text-sm">The tag is resolved to a digest. Only images declaring bootc compatibility are accepted.</div>`,
    { title: 'Inspect bootc OCI image', confirmText: 'Inspect and save', width: '760px', onSubmit: async content => {
      const signaturePolicy = content.querySelector('#wf-artifact-policy').value;
      const signerPattern = content.querySelector('#wf-artifact-signer').value.trim();
      if (signaturePolicy === 'cosign' && !signerPattern) { Toast.error('A signer identity regexp is required for Cosign'); return false; }
      try { return Api.inspectBootcArtifact({ name: content.querySelector('#wf-artifact-name').value.trim(),
        registryId: Number(content.querySelector('#wf-artifact-registry').value), repository: content.querySelector('#wf-artifact-repo').value.trim(),
        sourceRef: content.querySelector('#wf-artifact-ref').value.trim(), signaturePolicy,
        signerPattern: signerPattern || null }); } catch (error) { Toast.error(error.message); return false; }
    } });
    if (result) await this._reload('Bootc artifact inspected and pinned');
  },

  async _promotionHistory(id) {
    const artifact = this._data.artifacts.find(item => item.id === id);
    let history;
    try { history = await Api.getBootcArtifactPromotions(id, { limit: 100, offset: 0 }); }
    catch (error) { Toast.error(error.message); return; }
    const rows = (history.promotions || []).map(item => `<tr>
      <td>${Utils.escapeHtml(item.fromChannel)} → <strong>${Utils.escapeHtml(item.toChannel)}</strong></td>
      <td>${Utils.escapeHtml(item.reason)}</td>
      <td class="mono text-xs" title="${Utils.escapeHtml(item.evidenceHash)}">${this._shortDigest(item.evidenceHash)}</td>
      <td>${Utils.escapeHtml(item.promotedAt || 'unknown')}<div class="text-xs text-muted">operator #${item.promotedBy || '—'}</div></td>
    </tr>`).join('') || this._empty('No channel transitions recorded', 4);
    const boundedNotice = history.total > (history.promotions || []).length
      ? `<p class="text-xs text-muted">Showing the latest ${(history.promotions || []).length} of ${history.total} transitions.</p>` : '';
    await Modal.confirm(`<p><strong>${Utils.escapeHtml(artifact?.name || String(id))}</strong></p>
      <p class="mono text-xs">${Utils.escapeHtml(artifact?.digest || '')}</p>
      ${boundedNotice}<table class="data-table"><thead><tr><th>Transition</th><th>Evidence / reason</th><th>Evidence hash</th><th>Recorded</th></tr></thead><tbody>${rows}</tbody></table>`,
    { title: 'Artifact channel history', confirmText: 'Close', html: true, width: '900px' });
  },

  async _promotionDialog(id) {
    const artifact = this._data.artifacts.find(item => item.id === id);
    const result = await Modal.form(`<p><strong>${Utils.escapeHtml(artifact.name)}</strong></p><p class="mono text-xs">${Utils.escapeHtml(artifact.digest)}</p>
      <div class="form-group"><label for="wf-promote-channel">Target channel</label><select id="wf-promote-channel" class="form-control"><option value="held">held</option><option value="canary">canary</option><option value="stable">stable</option></select></div>
      <div class="form-group"><label for="wf-promote-reason">Evidence / reason</label><textarea id="wf-promote-reason" class="form-control" rows="4" required maxlength="1000"></textarea></div>`,
    { title: 'Change artifact channel', confirmText: 'Apply local policy', onSubmit: async content => {
      try { return Api.promoteBootcArtifact(id, { channel: content.querySelector('#wf-promote-channel').value,
        reason: content.querySelector('#wf-promote-reason').value.trim() }); } catch (error) { Toast.error(error.message); return false; }
    } });
    if (result) await this._reload('Artifact channel updated');
  },

  async _planDialog(deviceId) {
    const approved = this._data.artifacts.filter(item => ['canary','stable'].includes(item.channel) && item.signatureState === 'verified');
    if (!approved.length) { Toast.error('Promote a cryptographically verified artifact to canary or stable first'); return; }
    const templates = this._data.contract?.allowedRemoteJobTemplates || [];
    const templateControl = templates.length
      ? `<select id="wf-plan-template" class="form-control">${templates.map(value => `<option value="${Utils.escapeHtml(value)}">Foreman template #${Utils.escapeHtml(value)}</option>`).join('')}</select>`
      : '<input id="wf-plan-template" class="form-control" required inputmode="numeric" pattern="[0-9]+" placeholder="e.g. 101">';
    const result = await Modal.form(`<div class="form-group"><label for="wf-plan-action">Action</label><select id="wf-plan-action" class="form-control"><option value="update">Update</option><option value="rollback">Rollback</option></select></div>
      <div class="form-group"><label for="wf-plan-artifact">Target artifact</label><select id="wf-plan-artifact" class="form-control">${approved.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)} · ${item.channel} · ${this._shortDigest(item.digest)}</option>`).join('')}</select></div>
      <div class="form-group"><label for="wf-plan-template">Exact Foreman job template ID</label>${templateControl}</div>
      <div class="form-group"><label for="wf-plan-window">Maintenance window reference</label><input id="wf-plan-window" class="form-control" required placeholder="MW-2026-08-05"></div>
      <div class="form-group"><label for="wf-plan-approval">Approval/change reference</label><input id="wf-plan-approval" class="form-control" required placeholder="CHG-0001"></div>
      <div class="form-group"><label for="wf-plan-idempotency">Idempotency key</label><input id="wf-plan-idempotency" class="form-control mono" required value="wf-${deviceId}-${Date.now()}"></div>`,
    { title: 'Create guarded workstation plan', confirmText: 'Create plan', onSubmit: async content => {
      try { return Api.createWorkstationPlan(deviceId, { action: content.querySelector('#wf-plan-action').value,
        artifactId: Number(content.querySelector('#wf-plan-artifact').value), remoteJobTemplateId: content.querySelector('#wf-plan-template').value.trim(),
        maintenanceWindowRef: content.querySelector('#wf-plan-window').value.trim(), approvalRef: content.querySelector('#wf-plan-approval').value.trim(),
        idempotencyKey: content.querySelector('#wf-plan-idempotency').value.trim() }); } catch (error) { Toast.error(error.message); return false; }
    } });
    if (result) await this._reload('Guarded workstation plan created');
  },

  async _cancelPlan(id) {
    const plan = this._data.plans.find(item => item.id === id);
    const result = await Modal.form(`<div class="alert alert-info">This cancels only the local, unsubmitted plan. No Foreman call is made.</div>
      <div class="form-group"><label for="wf-cancel-reason">Cancellation reason</label><textarea id="wf-cancel-reason" class="form-control" rows="4" maxlength="500" required></textarea></div>`,
    { title: `Cancel workstation plan #${plan?.id || id}`, confirmText: 'Cancel plan', danger: true, onSubmit: async content => {
      try { return Api.cancelWorkstationPlan(id, { reason: content.querySelector('#wf-cancel-reason').value.trim() }); }
      catch (error) { Toast.error(error.message); return false; }
    } });
    if (result) await this._reload('Workstation plan cancelled locally');
  },

  async _executeDialog(id) {
    let preflight;
    try { preflight = await Api.preflightWorkstationPlan(id); }
    catch (error) { Toast.error(error.message); return; }
    if (!preflight.ready) { await this._showPreflight(preflight); return; }
    const plan = this._data.plans.find(item => item.id === id);
    const device = this._data.devices.find(item => item.id === plan.deviceId);
    const result = await Modal.form(`<div class="alert alert-warning">This submits an allowlisted remote job to Foreman. The workflow is not successful until post-read observes the exact target digest.</div>
      <p class="mono text-xs">${Utils.escapeHtml(plan.previousDigest)} → ${Utils.escapeHtml(plan.targetDigest)}</p>
      <div class="form-group"><label for="wf-execute-confirm">Type workstation name: <strong>${Utils.escapeHtml(device?.name || '')}</strong></label><input id="wf-execute-confirm" class="form-control" required autocomplete="off"></div>`,
    { title: `${plan.action} workstation`, confirmText: 'Submit remote job', danger: true, onSubmit: async content => {
      try { return Api.executeWorkstationPlan(id, { planHash: plan.planHash,
        confirmation: content.querySelector('#wf-execute-confirm').value.trim() }); } catch (error) { Toast.error(error.message); return false; }
    } });
    if (result) await this._reload('Foreman remote job submitted');
  },

  async _preflight(id) {
    try { await this._showPreflight(await Api.preflightWorkstationPlan(id)); }
    catch (error) { Toast.error(error.message); }
  },

  async _showPreflight(result) {
    const rows = (result.checks || []).map(check => `<tr><td>${Utils.escapeHtml(check.key)}</td><td><span class="badge ${check.state === 'pass' ? 'badge-success' : 'badge-danger'}">${Utils.escapeHtml(check.state)}</span></td><td>${Utils.escapeHtml(check.message)}</td></tr>`).join('');
    await Modal.confirm(`<div class="alert ${result.ready ? 'alert-success' : 'alert-warning'}">${result.ready ? 'All deterministic controls passed. Execution still requires the exact plan hash and typed workstation confirmation.' : `${result.blockers.length} blocker(s) must be resolved before execution.`}</div><table class="data-table"><thead><tr><th>Control</th><th>State</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table><p class="text-xs text-muted" style="margin-top:12px">Preflight is local and read-only; upstream network calls: ${result.networkCallsStarted || 0}.</p>`,
      { title: `Workstation plan #${result.plan.id} preflight`, confirmText: 'Close', html: true, width: '820px' });
  },

  async _reconcile(id) {
    try { const result = await Api.reconcileWorkstationPlan(id); await this._reload(`Workflow state: ${result.plan.state}`); }
    catch (error) { Toast.error(error.message); }
  },
};

window.WorkstationFleetPage = WorkstationFleetPage;
