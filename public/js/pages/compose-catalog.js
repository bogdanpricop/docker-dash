/* Signed, immutable OCI Compose blueprint catalog. */
'use strict';

const ComposeCatalogPage = {
  _container: null,
  _items: [],
  _hosts: [],
  _registries: [],
  _filters: { query: '', lifecycle: '' },

  _isAdmin() {
    return App.user?.role === 'admin' || App.user?.roles?.includes('admin');
  },

  _badge(state) {
    if (['active', 'published', 'succeeded'].includes(state)) return 'badge-success';
    if (['retired', 'failed'].includes(state)) return 'badge-danger';
    return 'badge-warning';
  },

  _short(value) {
    return value ? `${String(value).slice(0, 19)}…` : 'not published';
  },

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      const [catalog, hosts, registries] = await Promise.all([
        Api.getComposeBlueprints({ includeAll: this._isAdmin() ? 'true' : undefined }),
        Api.getHosts(),
        this._isAdmin() ? Api.getRegistries() : Promise.resolve([]),
      ]);
      this._items = catalog.items || [];
      this._hosts = (hosts || []).filter(host => host.isActive && ['docker', 'podman'].includes(host.daemonType || 'docker'));
      this._registries = Array.isArray(registries) ? registries : registries.registries || [];
      this._paint();
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><i class="fas fa-cubes"></i><h3>Compose Catalog</h3><p>${Utils.escapeHtml(error.message)}</p></div>`;
    }
  },

  _filtered() {
    const query = this._filters.query.toLowerCase();
    return this._items.filter(item => (!this._filters.lifecycle || item.lifecycle === this._filters.lifecycle)
      && (!query || `${item.name} ${item.slug} ${item.category} ${item.owner} ${item.description}`.toLowerCase().includes(query)));
  },

  _paint() {
    const items = this._filtered();
    const summary = this._items.reduce((out, item) => {
      out[item.lifecycle] = (out[item.lifecycle] || 0) + 1;
      return out;
    }, {});
    this._container.innerHTML = `<div class="control-surface">
      <div class="page-header"><div>
        <h1 class="page-title"><i class="fas fa-cubes" style="color:var(--accent);margin-right:10px"></i>Compose Catalog</h1>
        <p class="page-subtitle">Signed, digest-pinned application blueprints with typed parameters and secret-reference admission.</p>
      </div><div class="page-actions">
        <button class="btn btn-secondary" id="compose-catalog-refresh"><i class="fas fa-rotate"></i> Refresh</button>
        ${this._isAdmin() ? '<button class="btn btn-primary" id="compose-catalog-create"><i class="fas fa-plus"></i> New blueprint</button>' : ''}
      </div></div>
      <div class="alert alert-info text-sm"><strong>Safe hand-off.</strong> Instantiation creates a pinned OCI Compose application only. Deployment still requires a fresh dry-run plan and explicit confirmation in Git Stacks → OCI Apps.</div>
      <div class="info-grid">
        ${this._stat('fa-cubes', 'Total', this._items.length)}
        ${this._stat('fa-circle-check', 'Active', summary.active || 0)}
        ${this._stat('fa-triangle-exclamation', 'Deprecated', summary.deprecated || 0)}
        ${this._stat('fa-pen-ruler', 'Draft', summary.draft || 0)}
      </div>
      <div class="card" style="padding:12px;margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="sr-only" for="compose-catalog-search">Search catalog</label>
        <input id="compose-catalog-search" class="form-control" style="max-width:360px" placeholder="Search name, owner, category…" value="${Utils.escapeHtml(this._filters.query)}">
        <label class="sr-only" for="compose-catalog-lifecycle">Lifecycle</label>
        <select id="compose-catalog-lifecycle" class="form-control" style="width:auto"><option value="">All lifecycle states</option>${['draft', 'active', 'deprecated', 'retired'].map(state => `<option value="${state}"${this._filters.lifecycle === state ? ' selected' : ''}>${state}</option>`).join('')}</select>
        <span class="text-muted text-sm" aria-live="polite">${items.length} of ${this._items.length} blueprint(s)</span>
      </div>
      <div id="compose-catalog-items">${items.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">${items.map(item => this._card(item)).join('')}</div>` : '<div class="empty-msg"><i class="fas fa-search"></i>No blueprints match the current filters.</div>'}</div>
    </div>`;
    this._bind();
  },

  _stat(icon, label, value) {
    return `<div class="info-item"><div class="info-label"><i class="fas ${icon}" style="margin-right:5px"></i>${label}</div><div class="info-value">${value}</div></div>`;
  },

  _card(item) {
    const version = item.currentVersion;
    const trust = version?.provenance?.trust || {};
    return `<article class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div><strong style="font-size:16px">${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs text-muted">${Utils.escapeHtml(item.slug)}</div></div>
        <span class="badge ${this._badge(item.lifecycle)}">${Utils.escapeHtml(item.lifecycle)}</span>
      </div>
      <p class="text-sm text-muted" style="margin:0;min-height:34px">${Utils.escapeHtml(item.description || 'No description')}</p>
      <div class="text-sm" style="display:grid;gap:6px">
        <div><i class="fas fa-tag"></i> ${Utils.escapeHtml(item.category)} · ${Utils.escapeHtml(item.owner)} · ${Utils.escapeHtml(item.supportLevel || 'supported')}</div>
        <div><i class="fas fa-code-branch"></i> ${version ? `v${Utils.escapeHtml(version.version)}` : 'No published version'}</div>
        <div class="mono text-xs" title="${Utils.escapeHtml(version?.digest || '')}"><i class="fas fa-thumbtack"></i> ${Utils.escapeHtml(this._short(version?.digest))}</div>
        <div><i class="fas fa-shield-halved"></i> ${trust.cryptographicallyVerified ? '<span class="badge badge-success">Cosign verified</span>' : '<span class="badge badge-warning">Not publishable</span>'}</div>
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:auto">
        ${version && item.lifecycle === 'active' ? `<button class="btn btn-sm btn-primary" data-compose-instantiate="${item.id}"><i class="fas fa-wand-magic-sparkles"></i> Instantiate</button>` : ''}
        <button class="btn btn-sm btn-secondary" data-compose-history="${item.id}"><i class="fas fa-clock-rotate-left"></i> History</button>
        ${this._isAdmin() ? `<button class="btn btn-sm btn-secondary" data-compose-manage="${item.id}"><i class="fas fa-gear"></i> Manage</button>` : ''}
      </div>
    </article>`;
  },

  _bind() {
    this._container.querySelector('#compose-catalog-refresh')?.addEventListener('click', () => this.render(this._container));
    this._container.querySelector('#compose-catalog-create')?.addEventListener('click', () => this._createBlueprint());
    const update = event => {
      this._filters = {
        query: this._container.querySelector('#compose-catalog-search').value.trim(),
        lifecycle: this._container.querySelector('#compose-catalog-lifecycle').value,
      };
      const restore = event.target.id === 'compose-catalog-search';
      this._paint();
      if (restore) {
        const input = this._container.querySelector('#compose-catalog-search');
        input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
      }
    };
    this._container.querySelector('#compose-catalog-search')?.addEventListener('input', Utils.debounce(update, 150));
    this._container.querySelector('#compose-catalog-lifecycle')?.addEventListener('change', update);
    this._container.querySelectorAll('[data-compose-instantiate]').forEach(button => button.addEventListener('click', () => this._instantiate(Number(button.dataset.composeInstantiate))));
    this._container.querySelectorAll('[data-compose-history]').forEach(button => button.addEventListener('click', () => this._history(Number(button.dataset.composeHistory))));
    this._container.querySelectorAll('[data-compose-manage]').forEach(button => button.addEventListener('click', () => this._manage(Number(button.dataset.composeManage))));
  },

  async _createBlueprint() {
    const result = await Modal.form(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group"><label for="compose-blueprint-name">Name</label><input id="compose-blueprint-name" class="form-control" maxlength="120" placeholder="Internal web application"></div>
      <div class="form-group"><label for="compose-blueprint-slug">Slug</label><input id="compose-blueprint-slug" class="form-control mono" maxlength="80" placeholder="internal-web-app"></div>
      <div class="form-group"><label for="compose-blueprint-category">Category</label><input id="compose-blueprint-category" class="form-control" value="application" maxlength="80"></div>
      <div class="form-group"><label for="compose-blueprint-owner">Owner</label><input id="compose-blueprint-owner" class="form-control" maxlength="120" placeholder="platform-team"></div>
      <div class="form-group"><label for="compose-blueprint-support">Support level</label><select id="compose-blueprint-support" class="form-control"><option value="supported">Supported</option><option value="critical">Critical</option><option value="community">Community</option></select></div>
    </div><div class="form-group"><label for="compose-blueprint-description">Description</label><textarea id="compose-blueprint-description" class="form-control" maxlength="2000" rows="3"></textarea></div>`, {
      title: 'New Compose blueprint', confirmText: 'Create draft', width: '680px',
      onSubmit: root => ({
        name: root.querySelector('#compose-blueprint-name').value.trim(),
        slug: root.querySelector('#compose-blueprint-slug').value.trim(),
        category: root.querySelector('#compose-blueprint-category').value.trim(),
        owner: root.querySelector('#compose-blueprint-owner').value.trim(),
        supportLevel: root.querySelector('#compose-blueprint-support').value,
        description: root.querySelector('#compose-blueprint-description').value.trim(),
      }),
    });
    if (!result) return;
    try { await Api.createComposeBlueprint(result); Toast.success('Blueprint draft created'); await this.render(this._container); }
    catch (error) { Toast.error(error.message); }
  },

  _versionRows(detail) {
    return (detail.versions || []).map((version, index, versions) => {
      const trust = version.provenance?.trust || {};
      const actions = [];
      if (version.state === 'draft') actions.push(`<button type="button" class="btn btn-xs btn-primary" data-compose-version-state="${version.id}" data-state="published">Publish</button>`);
      if (version.state === 'published') actions.push(`<button type="button" class="btn btn-xs btn-secondary" data-compose-version-state="${version.id}" data-state="deprecated">Deprecate</button>`);
      if (version.state === 'deprecated') {
        actions.push(`<button type="button" class="btn btn-xs btn-secondary" data-compose-version-state="${version.id}" data-state="published">Restore</button>`);
        actions.push(`<button type="button" class="btn btn-xs btn-danger" data-compose-version-state="${version.id}" data-state="retired">Retire</button>`);
      }
      if (versions[index + 1]) actions.push(`<button type="button" class="btn btn-xs btn-secondary" data-compose-version-diff="${version.id}" data-compose-version-baseline="${versions[index + 1].id}">Diff</button>`);
      const action = actions.length ? `<div class="btn-group">${actions.join('')}</div>` : '—';
      return `<tr><td><strong>v${Utils.escapeHtml(version.version)}</strong><div class="mono text-xs text-muted">${Utils.escapeHtml(this._short(version.digest))}</div></td><td><span class="badge ${this._badge(version.state)}">${Utils.escapeHtml(version.state)}</span></td><td>${trust.cryptographicallyVerified ? '<span class="badge badge-success">verified</span>' : '<span class="badge badge-warning">unverified</span>'}</td><td>${action}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="text-muted">No immutable versions yet.</td></tr>';
  },

  async _manage(id) {
    try {
      const detail = await Api.getComposeBlueprint(id, true);
      const lifecycle = detail.blueprint.lifecycle;
      const result = await Modal.form(`<div class="alert alert-info text-sm">Publishing is fail-closed: the artifact must resolve to SHA-256 and pass Cosign verification against an explicit signer identity regexp.</div>
        <div style="overflow:auto;max-height:220px"><table class="data-table"><thead><tr><th>Version</th><th>State</th><th>Trust</th><th>Lifecycle</th></tr></thead><tbody>${this._versionRows(detail)}</tbody></table></div>
        <div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap">
          ${lifecycle === 'deprecated' ? `<button type="button" class="btn btn-sm btn-danger" id="compose-retire-blueprint">Retire blueprint</button>` : ''}
        </div><hr class="divider"><h4>Create immutable version</h4>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
          <div class="form-group"><label for="compose-version">Semantic version</label><input id="compose-version" class="form-control" placeholder="1.0.0"></div>
          <div class="form-group"><label for="compose-registry">Registry</label><select id="compose-registry" class="form-control">${this._registries.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label for="compose-repository">OCI repository</label><input id="compose-repository" class="form-control" placeholder="platform/web-compose"></div>
          <div class="form-group"><label for="compose-source-ref">Tag or digest</label><input id="compose-source-ref" class="form-control" value="latest"></div>
          <div class="form-group"><label for="compose-signer">Cosign signer identity regexp</label><input id="compose-signer" class="form-control" placeholder="^https://github.com/acme/"></div>
          <div class="form-group"><label for="compose-min-version">Minimum Compose version</label><input id="compose-min-version" class="form-control" value="2.34.0"></div>
        </div>
        <div class="form-group"><label for="compose-schema">Parameter schema (JSON)</label><textarea id="compose-schema" class="form-control mono" rows="6">{&quot;parameters&quot;:[]}</textarea><small class="text-muted">Types: string, integer, boolean, enum, secret_ref. Secret keys must end in Ref or Reference.</small></div>
        <div class="form-group"><label for="compose-template">Compose override template (YAML)</label><textarea id="compose-template" class="form-control mono" rows="7" placeholder="services:&#10;  web:&#10;    ports:&#10;      - '{{parameter.port}}'"></textarea><small class="text-muted">Each placeholder must occupy its complete YAML scalar.</small></div>
        <div class="form-group"><label for="compose-compatibility">Compatibility (JSON)</label><textarea id="compose-compatibility" class="form-control mono" rows="4">{&quot;daemonTypes&quot;:[&quot;docker&quot;,&quot;podman&quot;],&quot;architectures&quot;:[&quot;amd64&quot;],&quot;environments&quot;:[&quot;development&quot;,&quot;staging&quot;,&quot;production&quot;],&quot;minimumComposeVersion&quot;:&quot;2.34.0&quot;,&quot;requiresCosign&quot;:true}</textarea></div>
        <div class="form-group"><label for="compose-operational-profile">Operational profile (JSON)</label><textarea id="compose-operational-profile" class="form-control mono" rows="5">{&quot;healthcheck&quot;:{&quot;required&quot;:true,&quot;services&quot;:[],&quot;timeoutSeconds&quot;:120},&quot;backupRestore&quot;:{&quot;mode&quot;:&quot;stateless&quot;,&quot;volumeHints&quot;:[],&quot;runbookUrl&quot;:null},&quot;resources&quot;:{&quot;cpuMillicores&quot;:0,&quot;memoryMiB&quot;:0,&quot;storageGiB&quot;:0}}</textarea><small class="text-muted">Curated health expectations, backup/restore guidance and capacity estimates; these are disclosed hints, not provider mutations.</small></div>
        <div class="form-group"><label for="compose-changelog">Changelog</label><textarea id="compose-changelog" class="form-control" rows="3" maxlength="4000"></textarea></div>`, {
        title: `Manage ${Utils.escapeHtml(detail.blueprint.name)}`, confirmText: 'Resolve and create version', width: '960px',
        onMount: root => {
          root.querySelectorAll('[data-compose-version-state]').forEach(button => button.addEventListener('click', async () => {
            try {
              await Api.transitionComposeBlueprintVersion(id, Number(button.dataset.composeVersionState), button.dataset.state);
              Toast.success(`Version ${button.dataset.state}`); root.querySelector('#modal-cancel')?.click(); await this.render(this._container);
            } catch (error) { Toast.error(error.message); }
          }));
          root.querySelectorAll('[data-compose-version-diff]').forEach(button => button.addEventListener('click', async () => {
            try {
              const diff = await Api.diffComposeBlueprintVersion(id, Number(button.dataset.composeVersionDiff), Number(button.dataset.composeVersionBaseline));
              const fields = diff.changedFields.length ? diff.changedFields.map(field => `<span class="badge badge-info">${Utils.escapeHtml(field)}</span>`).join(' ') : '<span class="badge badge-success">No material changes</span>';
              await Modal.confirmSub(`<div class="alert alert-info text-sm">Catalog comparison only. Restoring an older version changes the catalog default; deployed applications remain unchanged until their own reviewed OCI plan is applied.</div><table class="info-table"><tr><td>From</td><td>v${Utils.escapeHtml(diff.from.version)} · <span class="mono text-xs">${Utils.escapeHtml(this._short(diff.from.digest))}</span></td></tr><tr><td>To</td><td>v${Utils.escapeHtml(diff.to.version)} · <span class="mono text-xs">${Utils.escapeHtml(this._short(diff.to.digest))}</span></td></tr><tr><td>Changed</td><td>${fields}</td></tr><tr><td>Parameters</td><td>+${diff.parameters.added.length} / −${diff.parameters.removed.length} / ~${diff.parameters.changed.length}</td></tr></table>`, { title: 'Immutable version diff', confirmText: 'Close', html: true, width: '680px' });
            } catch (error) { Toast.error(error.message); }
          }));
          root.querySelector('#compose-retire-blueprint')?.addEventListener('click', async () => {
            try { await Api.transitionComposeBlueprint(id, 'retired'); Toast.success('Blueprint retired'); root.querySelector('#modal-cancel')?.click(); await this.render(this._container); }
            catch (error) { Toast.error(error.message); }
          });
        },
        onSubmit: root => {
          try {
            return {
              version: root.querySelector('#compose-version').value.trim(),
              registryId: Number(root.querySelector('#compose-registry').value),
              repository: root.querySelector('#compose-repository').value.trim(),
              sourceRef: root.querySelector('#compose-source-ref').value.trim(),
              signaturePolicy: 'cosign', signerPattern: root.querySelector('#compose-signer').value.trim(),
              parameterSchema: JSON.parse(root.querySelector('#compose-schema').value),
              overrideTemplate: root.querySelector('#compose-template').value,
              compatibility: JSON.parse(root.querySelector('#compose-compatibility').value),
              operationalProfile: JSON.parse(root.querySelector('#compose-operational-profile').value),
              changelog: root.querySelector('#compose-changelog').value.trim(),
            };
          } catch { Toast.error('Parameter schema and compatibility must be valid JSON'); return false; }
        },
      });
      if (!result) return;
      const created = await Api.createComposeBlueprintVersion(id, result);
      Toast.success(`Version ${created.version.version} created and verified`);
      if (await Modal.confirm('Publish this verified immutable version now?', { confirmText: 'Publish' })) {
        await Api.transitionComposeBlueprintVersion(id, created.version.id, 'published');
        Toast.success('Version published and blueprint activated');
      }
      await this.render(this._container);
    } catch (error) { Toast.error(error.message); }
  },

  _parameterFields(schema) {
    return (schema.parameters || []).map(parameter => {
      const required = parameter.required ? ' required' : '';
      const value = Object.hasOwn(parameter, 'default') ? String(parameter.default) : '';
      let input;
      if (parameter.type === 'boolean') input = `<select class="form-control" data-compose-parameter="${Utils.escapeHtml(parameter.key)}" data-type="boolean"><option value="false">false</option><option value="true"${parameter.default === true ? ' selected' : ''}>true</option></select>`;
      else if (parameter.type === 'enum') input = `<select class="form-control" data-compose-parameter="${Utils.escapeHtml(parameter.key)}" data-type="enum">${parameter.options.map(option => `<option value="${Utils.escapeHtml(option)}"${option === parameter.default ? ' selected' : ''}>${Utils.escapeHtml(option)}</option>`).join('')}</select>`;
      else input = `<input class="form-control" data-compose-parameter="${Utils.escapeHtml(parameter.key)}" data-type="${Utils.escapeHtml(parameter.type)}" type="${parameter.type === 'integer' ? 'number' : 'text'}" value="${Utils.escapeHtml(value)}" placeholder="${parameter.type === 'secret_ref' ? '&#36;{ENV_SECRET}' : ''}"${required}>`;
      return `<div class="form-group"><label>${Utils.escapeHtml(parameter.label)}${parameter.required ? ' *' : ''}</label>${input}${parameter.description ? `<small class="text-muted">${Utils.escapeHtml(parameter.description)}</small>` : ''}</div>`;
    }).join('') || '<div class="text-muted text-sm">This blueprint has no parameters.</div>';
  },

  async _instantiate(id) {
    try {
      const detail = await Api.getComposeBlueprint(id, false);
      const version = detail.blueprint.currentVersion;
      if (!version) throw new Error('No published version is available');
      if (!this._hosts.length) throw new Error('No active Docker or Podman host is available');
      const result = await Modal.form(`<div class="alert alert-info text-sm">Version <strong>${Utils.escapeHtml(version.version)}</strong> · <span class="mono">${Utils.escapeHtml(this._short(version.digest))}</span>. Secret values are rejected; use approved manager or environment references.</div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
          <div class="form-group"><label for="compose-instance-name">Instance name</label><input id="compose-instance-name" class="form-control" placeholder="team-app"></div>
          <div class="form-group"><label for="compose-project-name">Compose project</label><input id="compose-project-name" class="form-control" placeholder="Defaults to instance name"></div>
          <div class="form-group"><label for="compose-target-host">Target host</label><select id="compose-target-host" class="form-control">${this._hosts.map(host => `<option value="${host.id}">${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType || 'docker')}</option>`).join('')}</select></div>
          <div class="form-group"><label for="compose-environment">Environment</label><select id="compose-environment" class="form-control">${(version.compatibility.environments || []).map(environment => `<option value="${environment}">${environment}</option>`).join('')}</select></div>
        </div><hr class="divider"><h4>Parameters</h4><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">${this._parameterFields(version.parameterSchema)}</div>`, {
        title: `Instantiate ${Utils.escapeHtml(detail.blueprint.name)}`, confirmText: 'Preview safe override', width: '820px',
        onSubmit: root => {
          const parameters = {};
          root.querySelectorAll('[data-compose-parameter]').forEach(input => {
            if (input.value === '') return;
            parameters[input.dataset.composeParameter] = input.dataset.type === 'integer' ? Number(input.value)
              : input.dataset.type === 'boolean' ? input.value === 'true' : input.value;
          });
          const instanceName = root.querySelector('#compose-instance-name').value.trim();
          return { hostId: Number(root.querySelector('#compose-target-host').value), instanceName,
            projectName: root.querySelector('#compose-project-name').value.trim() || instanceName,
            environment: root.querySelector('#compose-environment').value, parameters };
        },
      });
      if (!result) return;
      const preview = await Api.previewComposeBlueprint(id, version.id, result);
      const review = `<div class="alert alert-warning text-sm"><strong>No deployment occurs in this step.</strong> Confirming creates only the OCI application definition.</div>
        <table class="info-table"><tr><td>Host</td><td>${Utils.escapeHtml(preview.host.name)}</td></tr><tr><td>Project</td><td>${Utils.escapeHtml(preview.projectName)}</td></tr><tr><td>Environment</td><td>${Utils.escapeHtml(preview.environment)}</td></tr><tr><td>Plan hash</td><td class="mono text-xs">${Utils.escapeHtml(preview.planHash)}</td></tr><tr><td>Parameters hash</td><td class="mono text-xs">${Utils.escapeHtml(preview.parametersHash)}</td></tr></table>
        <h4>Rendered secret-safe override</h4><pre style="max-height:260px;overflow:auto">${Utils.escapeHtml(preview.renderedOverride || '# No local override')}</pre>`;
      if (!await Modal.confirm(review, { title: 'Review blueprint instantiation', confirmText: 'Create OCI application', html: true, width: '760px' })) return;
      const idempotencyKey = globalThis.crypto?.randomUUID ? `compose-blueprint-${crypto.randomUUID()}` : `compose-blueprint-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const created = await Api.instantiateComposeBlueprint(id, version.id, { ...result, planHash: preview.planHash, idempotencyKey });
      Toast.success(`OCI application ${created.artifact.name} created; review its dry-run plan before deploy`);
      location.hash = '#/git-stacks';
    } catch (error) { Toast.error(error.message); }
  },

  async _history(id) {
    try {
      const result = await Api.getComposeBlueprintInstantiations(id);
      const rows = result.instantiations.map(item => `<tr><td>#${item.id}<div class="text-xs text-muted">${new Date(item.createdAt).toLocaleString()}</div></td><td>${Utils.escapeHtml(item.instanceName)}<div class="text-xs text-muted">${Utils.escapeHtml(item.environment)} · host #${item.hostId}</div></td><td><span class="badge ${this._badge(item.state)}">${Utils.escapeHtml(item.state)}</span></td><td class="mono text-xs" title="${Utils.escapeHtml(item.planHash)}">${Utils.escapeHtml(this._short(item.planHash))}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">No instantiations recorded.</td></tr>';
      await Modal.confirm(`<div class="alert alert-info text-sm">History stores deterministic hashes, never raw parameter values or secret references.</div><div style="overflow:auto"><table class="data-table"><thead><tr><th>Run</th><th>Instance</th><th>State</th><th>Plan</th></tr></thead><tbody>${rows}</tbody></table></div>`, { title: `${Utils.escapeHtml(result.blueprint.name)} history`, confirmText: 'Close', html: true, width: '780px' });
    } catch (error) { Toast.error(error.message); }
  },

  destroy() {
    this._container = null;
    this._items = [];
    this._hosts = [];
    this._registries = [];
  },
};

if (typeof window !== 'undefined') window.ComposeCatalogPage = ComposeCatalogPage;
if (typeof module !== 'undefined' && module.exports) module.exports = ComposeCatalogPage;
