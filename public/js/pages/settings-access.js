/* ═══════════════════════════════════════════════════
   pages/settings-access.js — Teams & per-host access
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPageAccess = {
  _accessTargetType: 'host',
  _accessTargetId: null,
  _accessData: null,

  async _renderAccess(el) {
    const [teams, groups, hosts, usersRes, legacy] = await Promise.all([
      Api.listTeams(),
      Api.listHostGroups(),
      Api.getHosts(),
      Api.getUsers(),
      Api.getLegacyHostAccessDefault(),
    ]);
    const users = usersRes.users || usersRes || [];
    this._accessData = { teams, groups, hosts, users, legacy };

    let targets = this._accessTargetType === 'group' ? groups : hosts;
    if (!targets.length && this._accessTargetType === 'group' && hosts.length) {
      this._accessTargetType = 'host';
      targets = hosts;
    }
    if (!targets.some(t => t.id === this._accessTargetId)) {
      this._accessTargetId = targets[0]?.id || null;
    }
    const grants = this._accessTargetId
      ? (this._accessTargetType === 'group'
        ? await Api.listHostGroupPermissions(this._accessTargetId)
        : await Api.listHostPermissions(this._accessTargetId))
      : [];

    const t = (key) => i18n.t(`pages.settings.access.${key}`);
    const hostName = new Map(hosts.map(h => [h.id, h.name]));
    const memberNames = (ids) => (ids || []).map(id => hostName.get(id)).filter(Boolean);
    const subjectOptions = `
      <optgroup label="${Utils.escapeHtml(t('users'))}">
        ${users.map(u => `<option value="user:${u.id}">${Utils.escapeHtml(u.username)}</option>`).join('')}
      </optgroup>
      <optgroup label="${Utils.escapeHtml(t('teams'))}">
        ${teams.map(team => `<option value="team:${team.id}">${Utils.escapeHtml(team.name)}</option>`).join('')}
      </optgroup>`;

    el.innerHTML = `
      <div class="alert ${legacy.enabled ? 'alert-warning' : 'alert-success'}" style="margin-bottom:16px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <strong><i class="fas fa-shield-alt"></i> ${Utils.escapeHtml(t('legacyTitle'))}</strong>
            <div class="text-sm" style="margin-top:4px">${Utils.escapeHtml(legacy.enabled ? t('legacyEnabled') : t('legacyDisabled'))}</div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="access-legacy" ${legacy.enabled ? 'checked' : ''}>
            <span>${Utils.escapeHtml(t('legacyToggle'))}</span>
          </label>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;margin-bottom:16px">
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-users" style="margin-right:8px"></i>${Utils.escapeHtml(t('teams'))}</h3>
            <button class="btn btn-sm btn-primary" id="access-team-create"><i class="fas fa-plus"></i> ${Utils.escapeHtml(t('addTeam'))}</button>
          </div>
          <div class="card-body" style="padding:0">
            ${teams.length ? `<table class="data-table">
              <thead><tr><th>${Utils.escapeHtml(i18n.t('common.name'))}</th><th>${Utils.escapeHtml(t('members'))}</th><th>${Utils.escapeHtml(i18n.t('common.actions'))}</th></tr></thead>
              <tbody>${teams.map(team => `<tr>
                <td><strong>${Utils.escapeHtml(team.name)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(team.description || '')}</div></td>
                <td class="text-sm">${team.members.length ? team.members.map(m => Utils.escapeHtml(m.username)).join(', ') : '—'}</td>
                <td><div class="action-btns">
                  <button class="action-btn" data-access-action="team-edit" data-id="${team.id}" title="${Utils.escapeHtml(i18n.t('common.edit'))}"><i class="fas fa-edit"></i></button>
                  <button class="action-btn danger" data-access-action="team-delete" data-id="${team.id}" title="${Utils.escapeHtml(i18n.t('common.delete'))}"><i class="fas fa-trash"></i></button>
                </div></td>
              </tr>`).join('')}</tbody>
            </table>` : `<div class="empty-msg">${Utils.escapeHtml(t('noTeams'))}</div>`}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-layer-group" style="margin-right:8px"></i>${Utils.escapeHtml(t('hostGroups'))}</h3>
            <button class="btn btn-sm btn-primary" id="access-group-create"><i class="fas fa-plus"></i> ${Utils.escapeHtml(t('addHostGroup'))}</button>
          </div>
          <div class="card-body" style="padding:0">
            ${groups.length ? `<table class="data-table">
              <thead><tr><th>${Utils.escapeHtml(i18n.t('common.name'))}</th><th>${Utils.escapeHtml(t('hosts'))}</th><th>${Utils.escapeHtml(i18n.t('common.actions'))}</th></tr></thead>
              <tbody>${groups.map(group => `<tr>
                <td><strong>${Utils.escapeHtml(group.name)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(group.description || '')}</div></td>
                <td class="text-sm">${memberNames(group.member_host_ids).map(Utils.escapeHtml).join(', ') || '—'}</td>
                <td><div class="action-btns">
                  <button class="action-btn" data-access-action="group-edit" data-id="${group.id}" title="${Utils.escapeHtml(i18n.t('common.edit'))}"><i class="fas fa-edit"></i></button>
                  <button class="action-btn danger" data-access-action="group-delete" data-id="${group.id}" title="${Utils.escapeHtml(i18n.t('common.delete'))}"><i class="fas fa-trash"></i></button>
                </div></td>
              </tr>`).join('')}</tbody>
            </table>` : `<div class="empty-msg">${Utils.escapeHtml(t('noHostGroups'))}</div>`}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3><i class="fas fa-user-lock" style="margin-right:8px"></i>${Utils.escapeHtml(t('permissions'))}</h3></div>
        <div class="card-body">
          <p class="text-muted text-sm" style="margin-bottom:14px">${Utils.escapeHtml(t('permissionsDesc'))}</p>
          <div style="display:grid;grid-template-columns:140px minmax(180px,1fr) minmax(180px,1fr) 140px auto;gap:10px;align-items:end">
            <div class="form-group" style="margin:0"><label>${Utils.escapeHtml(t('targetType'))}</label>
              <select id="access-target-type" class="form-control">
                <option value="host" ${this._accessTargetType === 'host' ? 'selected' : ''}>${Utils.escapeHtml(t('host'))}</option>
                <option value="group" ${this._accessTargetType === 'group' ? 'selected' : ''}>${Utils.escapeHtml(t('hostGroup'))}</option>
              </select>
            </div>
            <div class="form-group" style="margin:0"><label>${Utils.escapeHtml(t('target'))}</label>
              <select id="access-target" class="form-control" ${targets.length ? '' : 'disabled'}>
                ${targets.map(target => `<option value="${target.id}" ${target.id === this._accessTargetId ? 'selected' : ''}>${Utils.escapeHtml(target.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="margin:0"><label>${Utils.escapeHtml(t('subject'))}</label>
              <select id="access-subject" class="form-control" ${(users.length || teams.length) ? '' : 'disabled'}>${subjectOptions}</select>
            </div>
            <div class="form-group" style="margin:0"><label>${Utils.escapeHtml(t('permission'))}</label>
              <select id="access-level" class="form-control">
                <option value="view">view</option><option value="operate">operate</option><option value="admin">admin</option>
              </select>
            </div>
            <button class="btn btn-primary" id="access-grant" ${this._accessTargetId && (users.length || teams.length) ? '' : 'disabled'}><i class="fas fa-plus"></i> ${Utils.escapeHtml(t('grant'))}</button>
          </div>

          <div style="margin-top:18px">
            ${grants.length ? `<table class="data-table">
              <thead><tr><th>${Utils.escapeHtml(t('subject'))}</th><th>${Utils.escapeHtml(t('permission'))}</th><th>${Utils.escapeHtml(i18n.t('common.actions'))}</th></tr></thead>
              <tbody>${grants.map(grant => `<tr>
                <td>${grant.user_id ? '<i class="fas fa-user"></i>' : '<i class="fas fa-users"></i>'} ${Utils.escapeHtml(grant.username || grant.team_name || '—')}</td>
                <td><span class="badge badge-info">${Utils.escapeHtml(grant.permission)}</span></td>
                <td><button class="action-btn danger" data-access-action="grant-delete" data-id="${grant.id}" title="${Utils.escapeHtml(t('revoke'))}"><i class="fas fa-times"></i></button></td>
              </tr>`).join('')}</tbody>
            </table>` : `<div class="empty-msg">${Utils.escapeHtml(t('noPermissions'))}</div>`}
          </div>
        </div>
      </div>`;

    el.querySelector('#access-legacy')?.addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      if (!enabled) {
        const ok = await Modal.confirm(t('disableLegacyConfirm'), { danger: true });
        if (!ok) { event.target.checked = true; return; }
      }
      try {
        await Api.setLegacyHostAccessDefault(enabled);
        Toast.success(t('legacyUpdated'));
        await this._renderTab();
      } catch (err) { Toast.error(err.message); }
    });
    el.querySelector('#access-team-create')?.addEventListener('click', () => this._accessTeamDialog());
    el.querySelector('#access-group-create')?.addEventListener('click', () => this._accessGroupDialog());
    el.querySelector('#access-target-type')?.addEventListener('change', async (event) => {
      this._accessTargetType = event.target.value;
      this._accessTargetId = null;
      await this._renderTab();
    });
    el.querySelector('#access-target')?.addEventListener('change', async (event) => {
      this._accessTargetId = Number.parseInt(event.target.value, 10);
      await this._renderTab();
    });
    el.querySelector('#access-grant')?.addEventListener('click', () => this._accessGrant());

    el.querySelectorAll('[data-access-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const id = Number.parseInt(button.dataset.id, 10);
        const action = button.dataset.accessAction;
        if (action === 'team-edit') return this._accessTeamDialog(teams.find(team => team.id === id));
        if (action === 'group-edit') return this._accessGroupDialog(groups.find(group => group.id === id));
        if (action === 'team-delete') return this._accessDeleteTeam(id);
        if (action === 'group-delete') return this._accessDeleteGroup(id);
        if (action === 'grant-delete') return this._accessRevoke(id);
      });
    });
  },

  async _accessTeamDialog(team = null) {
    const { users } = this._accessData;
    const selected = new Set((team?.members || []).map(member => member.id));
    const t = (key) => i18n.t(`pages.settings.access.${key}`);
    const result = await Modal.form(`
      <div class="form-group"><label>${Utils.escapeHtml(i18n.t('common.name'))}</label>
        <input id="access-team-name" class="form-control" maxlength="100" value="${Utils.escapeHtml(team?.name || '')}" required>
      </div>
      <div class="form-group"><label>${Utils.escapeHtml(t('description'))}</label>
        <textarea id="access-team-description" class="form-control" rows="2">${Utils.escapeHtml(team?.description || '')}</textarea>
      </div>
      <div class="form-group"><label>${Utils.escapeHtml(t('members'))}</label>
        <div style="max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:10px">
          ${users.map(user => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-team-member="${user.id}" ${selected.has(user.id) ? 'checked' : ''}><span>${Utils.escapeHtml(user.username)}</span><span class="text-muted text-sm">${Utils.escapeHtml(user.email || '')}</span></label>`).join('') || `<span class="text-muted">${Utils.escapeHtml(t('noUsers'))}</span>`}
        </div>
      </div>`, {
      title: team ? t('editTeam') : t('addTeam'),
      width: '520px',
      onSubmit: (content) => {
        const name = content.querySelector('#access-team-name').value.trim();
        if (!name) { Toast.warning(i18n.t('pages.settings.nameRequired')); return false; }
        return {
          name,
          description: content.querySelector('#access-team-description').value.trim(),
          memberIds: [...content.querySelectorAll('[data-team-member]:checked')].map(input => Number.parseInt(input.dataset.teamMember, 10)),
        };
      },
    });
    if (!result) return;
    try {
      if (team) await Api.updateTeam(team.id, result);
      else await Api.createTeam(result);
      Toast.success(t(team ? 'teamUpdated' : 'teamCreated'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _accessGroupDialog(group = null) {
    const { hosts } = this._accessData;
    const selected = new Set(group?.member_host_ids || []);
    const t = (key) => i18n.t(`pages.settings.access.${key}`);
    const result = await Modal.form(`
      <div class="form-group"><label>${Utils.escapeHtml(i18n.t('common.name'))}</label>
        <input id="access-group-name" class="form-control" maxlength="100" value="${Utils.escapeHtml(group?.name || '')}" required>
      </div>
      <div class="form-group"><label>${Utils.escapeHtml(t('description'))}</label>
        <textarea id="access-group-description" class="form-control" rows="2">${Utils.escapeHtml(group?.description || '')}</textarea>
      </div>
      <div class="form-group"><label>${Utils.escapeHtml(t('hosts'))}</label>
        <div style="max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:10px">
          ${hosts.map(host => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-group-host="${host.id}" ${selected.has(host.id) ? 'checked' : ''}><span>${Utils.escapeHtml(host.name)}</span><span class="text-muted text-sm">${Utils.escapeHtml(host.daemonType || 'docker')}</span></label>`).join('') || `<span class="text-muted">${Utils.escapeHtml(t('noHosts'))}</span>`}
        </div>
      </div>`, {
      title: group ? t('editHostGroup') : t('addHostGroup'),
      width: '520px',
      onSubmit: (content) => {
        const name = content.querySelector('#access-group-name').value.trim();
        if (!name) { Toast.warning(i18n.t('pages.settings.nameRequired')); return false; }
        return {
          name,
          description: content.querySelector('#access-group-description').value.trim(),
          hostIds: [...content.querySelectorAll('[data-group-host]:checked')].map(input => Number.parseInt(input.dataset.groupHost, 10)),
        };
      },
    });
    if (!result) return;
    try {
      if (group) await Api.updateHostGroup(group.id, result);
      else await Api.createHostGroup(result);
      Toast.success(t(group ? 'hostGroupUpdated' : 'hostGroupCreated'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _accessGrant() {
    const subject = document.getElementById('access-subject')?.value || '';
    const [kind, rawId] = subject.split(':');
    const subjectId = Number.parseInt(rawId, 10);
    if (!this._accessTargetId || !subjectId) return;
    const data = {
      permission: document.getElementById('access-level').value,
      [this._accessTargetType === 'group' ? 'hostGroupId' : 'hostId']: this._accessTargetId,
      [kind === 'team' ? 'teamId' : 'userId']: subjectId,
    };
    try {
      await Api.grantHostPermission(data);
      Toast.success(i18n.t('pages.settings.access.permissionGranted'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _accessDeleteTeam(id) {
    const t = (key) => i18n.t(`pages.settings.access.${key}`);
    if (!await Modal.confirm(t('deleteTeamConfirm'), { danger: true })) return;
    try { await Api.deleteTeam(id); Toast.success(t('teamDeleted')); await this._renderTab(); }
    catch (err) { Toast.error(err.message); }
  },

  async _accessDeleteGroup(id) {
    const t = (key) => i18n.t(`pages.settings.access.${key}`);
    if (!await Modal.confirm(t('deleteHostGroupConfirm'), { danger: true })) return;
    try { await Api.deleteHostGroup(id); Toast.success(t('hostGroupDeleted')); await this._renderTab(); }
    catch (err) { Toast.error(err.message); }
  },

  async _accessRevoke(id) {
    const t = (key) => i18n.t(`pages.settings.access.${key}`);
    if (!await Modal.confirm(t('revokeConfirm'), { danger: true })) return;
    try { await Api.revokeHostPermission(id); Toast.success(t('permissionRevoked')); await this._renderTab(); }
    catch (err) { Toast.error(err.message); }
  },
};
