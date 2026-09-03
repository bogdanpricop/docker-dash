/* ═══════════════════════════════════════════════════
   Governance — V4.6a projects, scoped roles and quotas
   ═══════════════════════════════════════════════════ */
'use strict';

const GovernancePage = {
  _container: null,
  _catalog: null,
  _projects: [],
  _scopes: [],
  _subjects: { users: [], teams: [] },
  _tab: 'projects',

  async render(container) {
    this._container = container;
    container.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      const [catalog, projects, scopes] = await Promise.all([
        Api.getGovernanceCatalog(),
        Api.listGovernanceProjects(),
        Api.listGovernanceScopes(),
      ]);
      this._catalog = catalog;
      this._projects = projects.projects || [];
      this._scopes = scopes.scopes || [];
      try { this._subjects = await Api.getGovernanceSubjects(); }
      catch { this._subjects = { users: [], teams: [] }; }
      this._paint();
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><i class="fas fa-shield-alt"></i><h3>${i18n.t('pages.governance.loadFailed')}</h3><p>${Utils.escapeHtml(error.message)}</p></div>`;
    }
  },

  destroy() {
    this._container = null;
  },

  _paint() {
    const customRoles = (this._catalog.roles || []).filter(role => !role.isBuiltin).length;
    const siteScopes = this._scopes.filter(scope => scope.type === 'site').length;
    const canCreateProject = this._catalog.globalAdmin || this._scopes.some(scope => scope.effectivePermissions?.includes('project.create'));
    this._container.innerHTML = `<div class="control-surface">
      <div class="page-header" style="align-items:flex-start">
        <div>
          <h1 class="page-title"><i class="fas fa-building-shield" style="color:var(--accent);margin-right:10px"></i>${i18n.t('pages.governance.title')}</h1>
          <p class="page-subtitle">${i18n.t('pages.governance.subtitle')}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary" id="gov-accept"><i class="fas fa-ticket"></i> ${i18n.t('pages.governance.acceptInvitation')}</button>
          ${canCreateProject ? `<button class="btn btn-primary" id="gov-new-project"><i class="fas fa-plus"></i> ${i18n.t('pages.governance.newProject')}</button>` : ''}
        </div>
      </div>
      <div class="info-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:16px">
        ${this._stat('fa-folder-tree', i18n.t('pages.governance.projects'), this._projects.length)}
        ${this._stat('fa-user-shield', i18n.t('pages.governance.customRoles'), customRoles)}
        ${this._stat('fa-sitemap', i18n.t('pages.governance.sitesAndScopes'), `${siteScopes} / ${this._scopes.length}`)}
      </div>
      <div class="tabs control-tabs" role="tablist" aria-label="${Utils.escapeHtml(i18n.t('pages.governance.title'))}">
        ${this._tabButton('projects', 'fa-folder-tree', i18n.t('pages.governance.projects'))}
        ${this._tabButton('roles', 'fa-user-shield', i18n.t('pages.governance.roles'))}
        ${this._tabButton('scopes', 'fa-sitemap', i18n.t('pages.governance.scopes'))}
      </div>
      <div id="gov-tab-content" role="tabpanel" tabindex="0">${this._tabContent()}</div></div>`;
    this._bind();
  },

  _stat(icon, label, value) {
    return `<div class="info-item"><div class="info-label"><i class="fas ${icon}" style="margin-right:5px"></i>${label}</div><div class="info-value">${Utils.escapeHtml(String(value))}</div></div>`;
  },

  _tabButton(tab, icon, label) {
    const active = this._tab === tab;
    return `<button type="button" class="tab ${active ? 'active' : ''}" data-gov-tab="${tab}" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</button>`;
  },

  _tabContent() {
    if (this._tab === 'roles') return this._rolesTable();
    if (this._tab === 'scopes') return this._scopesTable();
    return this._projectsTable();
  },

  _projectsTable() {
    if (!this._projects.length) return `<div class="empty-state"><i class="fas fa-folder-open"></i><h3>${i18n.t('pages.governance.noProjects')}</h3></div>`;
    return `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr>
      <th>${i18n.t('pages.governance.project')}</th><th>${i18n.t('common.status')}</th><th>${i18n.t('pages.governance.owner')}</th>
      <th>${i18n.t('pages.governance.cpuQuota')}</th><th>${i18n.t('pages.governance.memoryQuota')}</th><th>${i18n.t('pages.governance.storageQuota')}</th>
      <th>${i18n.t('common.actions')}</th></tr></thead><tbody>${this._projects.map(project => `
      <tr>
        <td><strong>${Utils.escapeHtml(project.name)}</strong><div class="text-muted text-xs mono">${Utils.escapeHtml(project.slug)}</div></td>
        <td><span class="badge ${project.status === 'active' ? 'badge-success' : 'badge-warning'}">${Utils.escapeHtml(project.status)}</span></td>
        <td>${Utils.escapeHtml(project.owner?.username || '—')}<div class="text-muted text-xs">${project.memberCount} ${i18n.t('pages.governance.members')}</div></td>
        <td>${this._quotaCell(project.quotas.cpu_millicores, 'cpu')}</td>
        <td>${this._quotaCell(project.quotas.memory_bytes, 'bytes')}</td>
        <td>${this._quotaCell(project.quotas.storage_bytes, 'bytes')}</td>
        <td><button class="btn btn-sm btn-secondary" data-gov-project="${project.id}"><i class="fas fa-sliders"></i> ${i18n.t('pages.governance.manage')}</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  },

  _quotaCell(quota, kind) {
    const format = value => kind === 'bytes' ? Utils.formatBytes(value || 0) : `${((value || 0) / 1000).toFixed(1)} CPU`;
    const limit = quota.hardLimit ?? quota.softLimit;
    const pct = limit ? Math.min(100, Math.round((quota.used / limit) * 100)) : 0;
    const color = quota.state === 'hard-exceeded' ? 'var(--red)' : quota.state === 'soft-exceeded' ? 'var(--yellow)' : 'var(--accent)';
    return `<div class="text-sm mono">${format(quota.used)} / ${limit == null ? '∞' : format(limit)}</div>
      <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;margin-top:5px"><div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div></div>`;
  },

  _rolesTable() {
    const canManage = this._catalog.globalAdmin;
    return `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">${canManage ? `<button class="btn btn-primary btn-sm" id="gov-new-role"><i class="fas fa-plus"></i> ${i18n.t('pages.governance.newRole')}</button>` : ''}</div>
      <div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>${i18n.t('pages.governance.role')}</th><th>${i18n.t('pages.governance.permissions')}</th><th>${i18n.t('pages.governance.bindings')}</th><th>${i18n.t('common.actions')}</th></tr></thead><tbody>
      ${(this._catalog.roles || []).map(role => `<tr>
        <td><strong>${Utils.escapeHtml(role.name)}</strong> ${role.isBuiltin ? `<span class="badge badge-info">${i18n.t('pages.governance.builtIn')}</span>` : ''}<div class="text-xs text-muted">${Utils.escapeHtml(role.description || role.slug)}</div></td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">${role.permissions.slice(0, 5).map(permission => `<span class="badge badge-secondary mono">${Utils.escapeHtml(permission)}</span>`).join('')}${role.permissions.length > 5 ? `<span class="text-muted text-xs">+${role.permissions.length - 5}</span>` : ''}</div></td>
        <td>${role.bindingCount || 0}</td>
        <td>${canManage && !role.isBuiltin ? `<button class="action-btn" data-gov-edit-role="${role.id}" title="${i18n.t('common.edit')}"><i class="fas fa-edit"></i></button><button class="action-btn danger" data-gov-delete-role="${role.id}" title="${i18n.t('common.delete')}"><i class="fas fa-trash"></i></button>` : '—'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  },

  _scopesTable() {
    const canAdd = this._catalog.globalAdmin || this._scopes.some(scope => scope.effectivePermissions?.includes('scope.manage'));
    return `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">${canAdd ? `<button class="btn btn-primary btn-sm" id="gov-new-scope"><i class="fas fa-plus"></i> ${i18n.t('pages.governance.newScope')}</button>` : ''}</div>
      <div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>${i18n.t('pages.governance.scope')}</th><th>${i18n.t('pages.governance.type')}</th><th>${i18n.t('pages.governance.parent')}</th><th>${i18n.t('pages.governance.yourPermissions')}</th><th>${i18n.t('common.actions')}</th></tr></thead><tbody>
      ${this._scopes.map(scope => `<tr>
        <td><strong>${Utils.escapeHtml(scope.name)}</strong><div class="text-xs text-muted mono">${Utils.escapeHtml(scope.key)}</div></td>
        <td><span class="badge badge-info">${Utils.escapeHtml(scope.type)}</span></td><td>${Utils.escapeHtml(scope.parentName || '—')}</td>
        <td class="text-xs">${scope.effectivePermissions?.length || 0}</td>
        <td>${scope.effectivePermissions?.includes('binding.manage') || this._catalog.globalAdmin ? `<button class="btn btn-sm btn-secondary" data-gov-scope="${scope.id}"><i class="fas fa-user-lock"></i> ${i18n.t('pages.governance.delegate')}</button>` : '—'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  },

  _bind() {
    this._container.querySelectorAll('[data-gov-tab]').forEach(button => button.addEventListener('click', () => {
      this._tab = button.dataset.govTab;
      this._paint();
    }));
    this._container.querySelector('#gov-new-project')?.addEventListener('click', () => this._createProject());
    this._container.querySelector('#gov-accept')?.addEventListener('click', () => this._acceptInvitation());
    this._container.querySelector('#gov-new-role')?.addEventListener('click', () => this._roleForm());
    this._container.querySelector('#gov-new-scope')?.addEventListener('click', () => this._scopeForm());
    this._container.querySelectorAll('[data-gov-project]').forEach(button => button.addEventListener('click', () => this._openProject(button.dataset.govProject)));
    this._container.querySelectorAll('[data-gov-edit-role]').forEach(button => button.addEventListener('click', () => {
      const role = this._catalog.roles.find(item => item.id === Number(button.dataset.govEditRole));
      this._roleForm(role);
    }));
    this._container.querySelectorAll('[data-gov-delete-role]').forEach(button => button.addEventListener('click', () => this._deleteRole(button.dataset.govDeleteRole)));
    this._container.querySelectorAll('[data-gov-scope]').forEach(button => button.addEventListener('click', () => this._scopeBindings(button.dataset.govScope)));
  },

  _parentOptions(permission) {
    return this._scopes.filter(scope => this._catalog.globalAdmin || scope.effectivePermissions?.includes(permission))
      .map(scope => `<option value="${scope.id}">${Utils.escapeHtml(scope.name)} (${scope.type})</option>`).join('');
  },

  async _createProject() {
    const result = await Modal.form(`
      <div class="form-group"><label>${i18n.t('pages.governance.name')}</label><input id="gov-name" class="form-control" maxlength="100"></div>
      <div class="form-group"><label>Slug</label><input id="gov-slug" class="form-control" placeholder="platform-team"></div>
      <div class="form-group"><label>${i18n.t('pages.governance.parentScope')}</label><select id="gov-parent" class="form-control">${this._parentOptions('project.create')}</select></div>
      <div class="form-row"><div class="form-group"><label>${i18n.t('pages.governance.kind')}</label><select id="gov-kind" class="form-control"><option value="internal">internal</option><option value="client">client</option><option value="plant">plant</option></select></div>
      <div class="form-group"><label>${i18n.t('pages.governance.usageMode')}</label><select id="gov-mode" class="form-control"><option value="production">production</option><option value="trial">trial</option><option value="demo">demo</option></select></div></div>`, {
      title: i18n.t('pages.governance.newProject'),
      onSubmit: async content => this._submit(async () => Api.createGovernanceProject({
        name: content.querySelector('#gov-name').value,
        slug: content.querySelector('#gov-slug').value,
        parentScopeId: Number(content.querySelector('#gov-parent').value),
        kind: content.querySelector('#gov-kind').value,
        usageMode: content.querySelector('#gov-mode').value,
      })),
    });
    if (result) await this.render(this._container);
  },

  async _acceptInvitation() {
    const result = await Modal.form(`<div class="form-group"><label>${i18n.t('pages.governance.invitationToken')}</label><textarea id="gov-token" class="form-control mono" rows="4" autocomplete="off"></textarea></div>`, {
      title: i18n.t('pages.governance.acceptInvitation'),
      onSubmit: content => this._submit(() => Api.acceptGovernanceInvitation(content.querySelector('#gov-token').value.trim())),
    });
    if (result) { Toast.success(i18n.t('pages.governance.invitationAccepted')); await this.render(this._container); }
  },

  _permissionChecks(selected = []) {
    const selectedSet = new Set(selected);
    return (this._catalog.permissions || []).map(permission => `<label style="display:flex;gap:8px;align-items:flex-start;padding:6px;border-bottom:1px solid var(--border)"><input type="checkbox" data-gov-permission value="${Utils.escapeHtml(permission.key)}" ${selectedSet.has(permission.key) ? 'checked' : ''}><span><strong class="mono text-sm">${Utils.escapeHtml(permission.key)}</strong><br><span class="text-xs text-muted">${Utils.escapeHtml(permission.description)}</span></span></label>`).join('');
  },

  async _roleForm(role = null) {
    const result = await Modal.form(`
      <div class="form-row"><div class="form-group"><label>${i18n.t('pages.governance.name')}</label><input id="gov-role-name" class="form-control" value="${Utils.escapeHtml(role?.name || '')}"></div>
      <div class="form-group"><label>Slug</label><input id="gov-role-slug" class="form-control" value="${Utils.escapeHtml(role?.slug || '')}" ${role ? 'disabled' : ''}></div></div>
      <div class="form-group"><label>${i18n.t('pages.governance.description')}</label><input id="gov-role-description" class="form-control" value="${Utils.escapeHtml(role?.description || '')}"></div>
      <label>${i18n.t('pages.governance.permissions')}</label><div style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:6px">${this._permissionChecks(role?.permissions)}</div>`, {
      title: role ? i18n.t('pages.governance.editRole') : i18n.t('pages.governance.newRole'), width: '720px',
      onSubmit: content => this._submit(() => {
        const body = {
          name: content.querySelector('#gov-role-name').value,
          description: content.querySelector('#gov-role-description').value,
          permissions: [...content.querySelectorAll('[data-gov-permission]:checked')].map(input => input.value),
        };
        if (!role) body.slug = content.querySelector('#gov-role-slug').value;
        return role ? Api.updateGovernanceRole(role.id, body) : Api.createGovernanceRole(body);
      }),
    });
    if (result) await this.render(this._container);
  },

  async _deleteRole(id) {
    const ok = await Modal.confirm(i18n.t('pages.governance.deleteRoleConfirm'), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try { await Api.deleteGovernanceRole(id); Toast.success(i18n.t('pages.governance.roleDeleted')); await this.render(this._container); }
    catch (error) { Toast.error(error.message); }
  },

  async _scopeForm() {
    const result = await Modal.form(`
      <div class="form-group"><label>${i18n.t('pages.governance.parentScope')}</label><select id="gov-scope-parent" class="form-control">${this._parentOptions('scope.manage')}</select></div>
      <div class="form-row"><div class="form-group"><label>${i18n.t('pages.governance.type')}</label><select id="gov-scope-type" class="form-control"><option value="site">site</option><option value="provider">provider</option><option value="cluster">cluster</option><option value="resource">resource</option></select></div>
      <div class="form-group"><label>${i18n.t('pages.governance.name')}</label><input id="gov-scope-name" class="form-control"></div></div>
      <div class="form-group"><label>${i18n.t('pages.governance.key')}</label><input id="gov-scope-key" class="form-control" placeholder="bucharest-dc"></div>`, {
      title: i18n.t('pages.governance.newScope'),
      onSubmit: content => this._submit(() => Api.createGovernanceScope({
        parentId: Number(content.querySelector('#gov-scope-parent').value),
        type: content.querySelector('#gov-scope-type').value,
        name: content.querySelector('#gov-scope-name').value,
        key: content.querySelector('#gov-scope-key').value,
      })),
    });
    if (result) await this.render(this._container);
  },

  _subjectOptions() {
    return [
      ...(this._subjects.users || []).map(user => `<option value="u:${user.id}">${Utils.escapeHtml(user.username)} (${Utils.escapeHtml(user.email || 'no email')})</option>`),
      ...(this._subjects.teams || []).map(team => `<option value="t:${team.id}">${i18n.t('pages.governance.team')}: ${Utils.escapeHtml(team.name)}</option>`),
    ].join('');
  },

  async _scopeBindings(scopeId) {
    try {
      const response = await Api.listGovernanceBindings(scopeId);
      const scope = this._scopes.find(item => item.id === Number(scopeId));
      Modal.open(`<div class="modal-header"><h3>${i18n.t('pages.governance.delegationFor', { scope: scope?.name || scopeId })}</h3><button class="modal-close-btn" id="gov-bind-close"><i class="fas fa-times"></i></button></div>
        <div class="modal-body"><div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn btn-primary btn-sm" id="gov-add-binding"><i class="fas fa-plus"></i> ${i18n.t('pages.governance.addDelegation')}</button></div>
        <table class="data-table"><thead><tr><th>${i18n.t('pages.governance.subject')}</th><th>${i18n.t('pages.governance.role')}</th><th>${i18n.t('pages.governance.expiry')}</th><th></th></tr></thead><tbody>${(response.bindings || []).map(binding => `<tr><td>${Utils.escapeHtml(binding.username || binding.teamName || '—')}</td><td>${Utils.escapeHtml(binding.roleName)}</td><td>${binding.expiresAt ? new Date(binding.expiresAt).toLocaleString() : '∞'}</td><td><button class="action-btn danger" data-remove-binding="${binding.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('') || `<tr><td colspan="4" class="text-muted">${i18n.t('pages.governance.noBindings')}</td></tr>`}</tbody></table></div>`);
      Modal._content.querySelector('#gov-bind-close').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#gov-add-binding').addEventListener('click', () => { Modal.close(); setTimeout(() => this._bindingForm(scopeId), 220); });
      Modal._content.querySelectorAll('[data-remove-binding]').forEach(button => button.addEventListener('click', async () => {
        try { await Api.deleteGovernanceBinding(button.dataset.removeBinding); Toast.success(i18n.t('pages.governance.delegationRemoved')); Modal.close(); }
        catch (error) { Toast.error(error.message); }
      }));
    } catch (error) { Toast.error(error.message); }
  },

  async _bindingForm(scopeId) {
    const result = await Modal.form(`
      <div class="form-group"><label>${i18n.t('pages.governance.subject')}</label><select id="gov-binding-subject" class="form-control">${this._subjectOptions()}</select></div>
      <div class="form-group"><label>${i18n.t('pages.governance.role')}</label><select id="gov-binding-role" class="form-control">${(this._catalog.roles || []).map(role => `<option value="${role.id}">${Utils.escapeHtml(role.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label>${i18n.t('pages.governance.expiryOptional')}</label><input id="gov-binding-expiry" class="form-control" type="datetime-local"></div>`, {
      title: i18n.t('pages.governance.addDelegation'),
      onSubmit: content => this._submit(() => {
        const [kind, id] = content.querySelector('#gov-binding-subject').value.split(':');
        const expiry = content.querySelector('#gov-binding-expiry').value;
        return Api.createGovernanceBinding({
          scopeId: Number(scopeId), roleId: Number(content.querySelector('#gov-binding-role').value),
          userId: kind === 'u' ? Number(id) : null, teamId: kind === 't' ? Number(id) : null,
          expiresAt: expiry ? new Date(expiry).toISOString() : null,
        });
      }),
    });
    if (result) Toast.success(i18n.t('pages.governance.delegationSaved'));
  },

  async _openProject(projectId) {
    try {
      const { project } = await Api.getGovernanceProject(projectId);
      const can = permission => project.permissions.includes(permission) || this._catalog.globalAdmin;
      const invitationsResponse = can('project.invitations.manage')
        ? await Api.listGovernanceInvitations(projectId)
        : { invitations: [] };
      const quotaRows = ['cpu_millicores', 'memory_bytes', 'storage_bytes'].map(metric => {
        const quota = project.quotas[metric];
        return `<tr><td>${Utils.escapeHtml(metric)}</td><td class="mono">${quota.used.toLocaleString()}</td><td class="mono">${quota.softLimit == null ? '∞' : quota.softLimit.toLocaleString()}</td><td class="mono">${quota.hardLimit == null ? '∞' : quota.hardLimit.toLocaleString()}</td><td><span class="badge ${quota.state === 'within-limit' ? 'badge-success' : 'badge-warning'}">${quota.state}</span></td></tr>`;
      }).join('');
      Modal.open(`<div class="modal-header"><div><h3>${Utils.escapeHtml(project.name)}</h3><div class="text-xs text-muted">${Utils.escapeHtml(project.usageMode)} · ${Utils.escapeHtml(project.status)}</div></div><button class="modal-close-btn" id="gov-project-close"><i class="fas fa-times"></i></button></div>
        <div class="modal-body">
          <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">
            ${can('project.update') ? `<button class="btn btn-sm btn-secondary" id="gov-project-lifecycle"><i class="fas ${project.status === 'active' ? 'fa-pause' : 'fa-play'}"></i> ${i18n.t(project.status === 'active' ? 'pages.governance.suspend' : 'pages.governance.activate')}</button>` : ''}
            ${can('project.quotas.manage') ? `<button class="btn btn-sm btn-secondary" id="gov-project-quota"><i class="fas fa-gauge"></i> ${i18n.t('pages.governance.setQuotas')}</button>` : ''}
            ${can('project.members.manage') ? `<button class="btn btn-sm btn-secondary" id="gov-project-member"><i class="fas fa-user-plus"></i> ${i18n.t('pages.governance.addMember')}</button>` : ''}
            ${can('project.ownership.transfer') ? `<button class="btn btn-sm btn-secondary" id="gov-project-owner"><i class="fas fa-crown"></i> ${i18n.t('pages.governance.transferOwner')}</button>` : ''}
            ${can('project.invitations.manage') ? `<button class="btn btn-sm btn-secondary" id="gov-project-invite"><i class="fas fa-envelope"></i> ${i18n.t('pages.governance.invite')}</button>` : ''}
            ${can('project.resources.manage') ? `<button class="btn btn-sm btn-primary" id="gov-project-resource"><i class="fas fa-link"></i> ${i18n.t('pages.governance.assignResource')}</button>` : ''}
          </div>
          <h4>${i18n.t('pages.governance.quotasAndUsage')}</h4><div style="overflow:auto"><table class="data-table"><thead><tr><th>${i18n.t('pages.governance.metric')}</th><th>${i18n.t('pages.governance.used')}</th><th>Soft</th><th>Hard</th><th>${i18n.t('common.status')}</th></tr></thead><tbody>${quotaRows}</tbody></table></div>
          <h4 style="margin-top:18px">${i18n.t('pages.governance.members')}</h4><div style="overflow:auto"><table class="data-table"><tbody>${project.members.map(member => `<tr><td>${Utils.escapeHtml(member.username)} ${member.isOwner ? '<i class="fas fa-crown" style="color:var(--yellow)"></i>' : ''}</td><td>${Utils.escapeHtml(member.role)}</td><td>${Utils.escapeHtml(member.email || '—')}</td>${can('project.members.manage') && !member.isOwner ? `<td><button class="action-btn danger" data-remove-member="${member.id}"><i class="fas fa-trash"></i></button></td>` : '<td></td>'}</tr>`).join('')}</tbody></table></div>
          <h4 style="margin-top:18px">${i18n.t('pages.governance.assignedResources')}</h4><div style="overflow:auto"><table class="data-table"><tbody>${project.resources.map(resource => `<tr><td><strong>${Utils.escapeHtml(resource.displayName)}</strong><div class="text-xs text-muted mono">${Utils.escapeHtml(resource.resourceType)} · ${Utils.escapeHtml(resource.resourceKey)}</div></td><td>${(resource.cpuMillicores / 1000).toFixed(1)} CPU</td><td>${Utils.formatBytes(resource.memoryBytes)}</td><td>${Utils.formatBytes(resource.storageBytes)}</td>${can('project.resources.manage') ? `<td><button class="action-btn danger" data-remove-resource="${resource.id}"><i class="fas fa-unlink"></i></button></td>` : '<td></td>'}</tr>`).join('') || `<tr><td class="text-muted">${i18n.t('pages.governance.noResources')}</td></tr>`}</tbody></table></div>
          <h4 style="margin-top:18px">${i18n.t('pages.governance.invitations')}</h4><div style="display:flex;gap:5px;flex-wrap:wrap">${(invitationsResponse.invitations || []).map(invitation => `<span class="badge ${invitation.state === 'pending' ? 'badge-info' : 'badge-secondary'}">${Utils.escapeHtml(invitation.email || '@' + invitation.emailDomain)} · ${Utils.escapeHtml(invitation.role)} · ${Utils.escapeHtml(invitation.state)}</span>`).join('') || `<span class="text-muted text-sm">${i18n.t('pages.governance.noInvitations')}</span>`}</div>
        </div>`, { width: '980px' });
      Modal._content.querySelector('#gov-project-close').addEventListener('click', () => Modal.close());
      const reopen = action => { Modal.close(); setTimeout(() => action(project), 220); };
      Modal._content.querySelector('#gov-project-lifecycle')?.addEventListener('click', () => reopen(p => this._toggleProjectStatus(p)));
      Modal._content.querySelector('#gov-project-quota')?.addEventListener('click', () => reopen(p => this._quotaForm(p)));
      Modal._content.querySelector('#gov-project-member')?.addEventListener('click', () => reopen(p => this._memberForm(p)));
      Modal._content.querySelector('#gov-project-owner')?.addEventListener('click', () => reopen(p => this._ownerForm(p)));
      Modal._content.querySelector('#gov-project-invite')?.addEventListener('click', () => reopen(p => this._inviteForm(p)));
      Modal._content.querySelector('#gov-project-resource')?.addEventListener('click', () => reopen(p => this._resourceForm(p)));
      Modal._content.querySelectorAll('[data-remove-member]').forEach(button => button.addEventListener('click', async () => {
        try { await Api.removeGovernanceProjectMember(project.id, button.dataset.removeMember); Toast.success(i18n.t('pages.governance.memberRemoved')); Modal.close(); await this.render(this._container); }
        catch (error) { Toast.error(error.message); }
      }));
      Modal._content.querySelectorAll('[data-remove-resource]').forEach(button => button.addEventListener('click', async () => {
        try { await Api.unassignGovernanceProjectResource(project.id, button.dataset.removeResource); Toast.success(i18n.t('pages.governance.resourceRemoved')); Modal.close(); await this.render(this._container); }
        catch (error) { Toast.error(error.message); }
      }));
    } catch (error) { Toast.error(error.message); }
  },

  async _toggleProjectStatus(project) {
    const nextStatus = project.status === 'active' ? 'suspended' : 'active';
    if (nextStatus === 'suspended') {
      const confirmed = await Modal.confirm(i18n.t('pages.governance.suspendConfirm'), {
        danger: true,
        confirmText: i18n.t('pages.governance.suspend'),
      });
      if (!confirmed) return;
    }
    try {
      await Api.updateGovernanceProject(project.id, { status: nextStatus });
      Toast.success(i18n.t('pages.governance.projectStatusUpdated'));
      await this.render(this._container);
    } catch (error) {
      Toast.error(error.message);
    }
  },

  async _quotaForm(project) {
    const value = (metric, field, divisor = 1) => {
      const raw = project.quotas[metric][field];
      return raw == null ? '' : raw / divisor;
    };
    const gib = 1024 ** 3;
    const result = await Modal.form(`
      <p class="text-muted text-sm">${i18n.t('pages.governance.quotaHelp')}</p>
      ${this._quotaInputs('CPU', 'cpu', value('cpu_millicores', 'softLimit', 1000), value('cpu_millicores', 'hardLimit', 1000), 'cores')}
      ${this._quotaInputs('RAM', 'memory', value('memory_bytes', 'softLimit', gib), value('memory_bytes', 'hardLimit', gib), 'GiB')}
      ${this._quotaInputs(i18n.t('pages.governance.storage'), 'storage', value('storage_bytes', 'softLimit', gib), value('storage_bytes', 'hardLimit', gib), 'GiB')}`, {
      title: i18n.t('pages.governance.setQuotas'),
      onSubmit: content => this._submit(() => Api.setGovernanceProjectQuotas(project.id, {
        cpu_millicores: this._limits(content, 'cpu', 1000),
        memory_bytes: this._limits(content, 'memory', gib),
        storage_bytes: this._limits(content, 'storage', gib),
      })),
    });
    if (result) { await this.render(this._container); Toast.success(i18n.t('pages.governance.quotasSaved')); }
  },

  _quotaInputs(label, key, soft, hard, unit) {
    return `<div class="form-row"><div class="form-group"><label>${label} soft (${unit})</label><input id="gov-${key}-soft" class="form-control" type="number" min="0" step="0.1" value="${soft}"></div><div class="form-group"><label>${label} hard (${unit})</label><input id="gov-${key}-hard" class="form-control" type="number" min="0" step="0.1" value="${hard}"></div></div>`;
  },

  _limits(content, key, multiplier) {
    const convert = id => {
      const value = content.querySelector(id).value;
      return value === '' ? null : Math.round(Number(value) * multiplier);
    };
    return { softLimit: convert(`#gov-${key}-soft`), hardLimit: convert(`#gov-${key}-hard`) };
  },

  async _memberForm(project) {
    const result = await Modal.form(`<div class="form-group"><label>${i18n.t('pages.governance.user')}</label><select id="gov-member-user" class="form-control">${(this._subjects.users || []).map(user => `<option value="${user.id}">${Utils.escapeHtml(user.username)} (${Utils.escapeHtml(user.email || 'no email')})</option>`).join('')}</select></div><div class="form-group"><label>${i18n.t('pages.governance.role')}</label><select id="gov-member-role" class="form-control"><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select></div>`, {
      title: i18n.t('pages.governance.addMember'),
      onSubmit: content => this._submit(() => Api.setGovernanceProjectMember(project.id, { userId: Number(content.querySelector('#gov-member-user').value), role: content.querySelector('#gov-member-role').value })),
    });
    if (result) { await this.render(this._container); Toast.success(i18n.t('pages.governance.memberSaved')); }
  },

  async _ownerForm(project) {
    const result = await Modal.form(`<p class="text-muted text-sm">${i18n.t('pages.governance.transferOwnerHelp')}</p><div class="form-group"><label>${i18n.t('pages.governance.newOwner')}</label><select id="gov-owner-user" class="form-control">${(this._subjects.users || []).map(user => `<option value="${user.id}">${Utils.escapeHtml(user.username)}</option>`).join('')}</select></div>`, {
      title: i18n.t('pages.governance.transferOwner'), confirmText: i18n.t('pages.governance.transfer'),
      onSubmit: content => this._submit(() => Api.transferGovernanceProjectOwner(project.id, Number(content.querySelector('#gov-owner-user').value))),
    });
    if (result) { await this.render(this._container); Toast.success(i18n.t('pages.governance.ownerTransferred')); }
  },

  async _inviteForm(project) {
    const result = await Modal.form(`<div class="form-group"><label>Email</label><input id="gov-invite-email" class="form-control" type="email" placeholder="user@example.com"></div><div class="form-group"><label>${i18n.t('pages.governance.orDomain')}</label><input id="gov-invite-domain" class="form-control" placeholder="example.com"></div><div class="form-row"><div class="form-group"><label>${i18n.t('pages.governance.role')}</label><select id="gov-invite-role" class="form-control"><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select></div><div class="form-group"><label>${i18n.t('pages.governance.validHours')}</label><input id="gov-invite-ttl" class="form-control" type="number" value="72" min="1" max="720"></div></div>`, {
      title: i18n.t('pages.governance.invite'),
      onSubmit: content => this._submit(() => Api.createGovernanceInvitation(project.id, {
        email: content.querySelector('#gov-invite-email').value || null,
        emailDomain: content.querySelector('#gov-invite-domain').value || null,
        role: content.querySelector('#gov-invite-role').value,
        ttlHours: Number(content.querySelector('#gov-invite-ttl').value),
      })),
    });
    if (result?.invitation?.token) {
      Modal.open(`<div class="modal-header"><h3>${i18n.t('pages.governance.invitationCreated')}</h3><button class="modal-close-btn" id="gov-token-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><p class="text-muted">${i18n.t('pages.governance.tokenShownOnce')}</p><textarea class="form-control mono" rows="5" readonly>${Utils.escapeHtml(result.invitation.token)}</textarea></div>`);
      Modal._content.querySelector('#gov-token-close').addEventListener('click', () => { Modal.close(); this.render(this._container); });
    }
  },

  async _resourceForm(project) {
    const result = await Modal.form(`
      <p class="text-muted text-sm">${i18n.t('pages.governance.resourceAccountingHelp')}</p>
      <div class="form-row"><div class="form-group"><label>${i18n.t('pages.governance.resourceType')}</label><input id="gov-resource-type" class="form-control" placeholder="vm"></div><div class="form-group"><label>${i18n.t('pages.governance.resourceKey')}</label><input id="gov-resource-key" class="form-control" placeholder="provider-uuid"></div></div>
      <div class="form-group"><label>${i18n.t('pages.governance.displayName')}</label><input id="gov-resource-name" class="form-control"></div>
      <div class="form-row"><div class="form-group"><label>CPU cores</label><input id="gov-resource-cpu" class="form-control" type="number" min="0" step="0.1" value="0"></div><div class="form-group"><label>RAM GiB</label><input id="gov-resource-memory" class="form-control" type="number" min="0" step="0.1" value="0"></div><div class="form-group"><label>${i18n.t('pages.governance.storage')} GiB</label><input id="gov-resource-storage" class="form-control" type="number" min="0" step="0.1" value="0"></div></div>`, {
      title: i18n.t('pages.governance.assignResource'),
      onSubmit: content => this._submit(() => Api.assignGovernanceProjectResource(project.id, {
        resourceType: content.querySelector('#gov-resource-type').value,
        resourceKey: content.querySelector('#gov-resource-key').value,
        displayName: content.querySelector('#gov-resource-name').value,
        cpuMillicores: Math.round(Number(content.querySelector('#gov-resource-cpu').value) * 1000),
        memoryBytes: Math.round(Number(content.querySelector('#gov-resource-memory').value) * (1024 ** 3)),
        storageBytes: Math.round(Number(content.querySelector('#gov-resource-storage').value) * (1024 ** 3)),
      })),
    });
    if (result) {
      if (result.warnings?.length) Toast.warning(i18n.t('pages.governance.softQuotaWarning'));
      else Toast.success(i18n.t('pages.governance.resourceAssigned'));
      await this.render(this._container);
    }
  },

  async _submit(operation) {
    try { return await operation(); }
    catch (error) { Toast.error(error.message); return false; }
  },
};

window.GovernancePage = GovernancePage;
