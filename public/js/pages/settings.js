/* ═══════════════════════════════════════════════════
   pages/settings.js — Settings & Admin
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPage = {
  _tab: 'profile',
  _user: null,

  async render(container) {
    this._user = App.user;
    const isAdmin = this._user?.role === 'admin';

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-cog"></i> ${i18n.t('pages.settings.title')}</h2>
        <div class="page-actions">
          <button class="prune-help-btn" id="settings-help" title="${i18n.t('pages.settings.helpTooltip')}">?</button>
        </div>
      </div>
      <div class="tabs" id="settings-tabs">
        <button class="tab active" data-tab="profile">${i18n.t('pages.settings.tabProfile')}</button>
        ${isAdmin ? `<button class="tab" data-tab="users">${i18n.t('pages.settings.tabUsers')}</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="webhooks">${i18n.t('pages.settings.tabWebhooks')}</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="registries">${i18n.t('pages.settings.registriesTitle')}</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="git-credentials"><i class="fab fa-git-alt" style="margin-right:4px"></i> Git</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="notifications"><i class="fas fa-bell" style="margin-right:4px"></i> Notifications</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="workflows"><i class="fas fa-cogs" style="margin-right:4px"></i> Workflows</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="secrets"><i class="fas fa-key" style="margin-right:4px"></i> Secrets</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="log-forwarding"><i class="fas fa-share-alt" style="margin-right:4px"></i> Log Forwarding</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="ldap"><i class="fas fa-sitemap" style="margin-right:4px"></i> LDAP / AD</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="general">${i18n.t('pages.settings.tabGeneral')}</button>` : ''}
      </div>
      <div id="settings-content"></div>
    `;

    container.querySelector('#settings-help').addEventListener('click', () => this._showHelp());

    container.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        this._renderTab();
      });
    });

    await this._renderTab();
  },

  async _renderTab() {
    const el = document.getElementById('settings-content');
    if (!el) return;

    try {
      if (this._tab === 'profile') this._renderProfile(el);
      else if (this._tab === 'users') await this._renderUsers(el);
      else if (this._tab === 'webhooks') await this._renderWebhooks(el);
      else if (this._tab === 'registries') await this._renderRegistries(el);
      else if (this._tab === 'git-credentials') await this._renderGitCredentials(el);
      else if (this._tab === 'notifications') await this._renderNotificationChannels(el);
      else if (this._tab === 'workflows') await this._renderWorkflows(el);
      else if (this._tab === 'secrets') await this._renderSecrets(el);
      else if (this._tab === 'log-forwarding') await this._renderLogForwarding(el);
      else if (this._tab === 'ldap') await this._renderLdap(el);
      else if (this._tab === 'general') await this._renderGeneral(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  _renderProfile(el) {
    el.innerHTML = `
      <div class="card" style="max-width:500px">
        <div class="card-header"><h3>${i18n.t('pages.settings.yourProfile')}</h3></div>
        <div class="card-body">
          <table class="info-table">
            <tr><td>${i18n.t('pages.settings.username')}</td><td>${Utils.escapeHtml(this._user?.username || '')}</td></tr>
            <tr><td>${i18n.t('pages.settings.role')}</td><td><span class="badge badge-info">${this._user?.role || ''}</span></td></tr>
          </table>
          <hr class="divider">
          <h4>${i18n.t('pages.settings.changePassword')}</h4>
          <form id="pw-form">
            <div class="form-group">
              <label>${i18n.t('pages.settings.currentPassword')}</label>
              <input type="password" id="pw-current" class="form-control" required>
            </div>
            <div class="form-group">
              <label>${i18n.t('pages.settings.newPassword')}</label>
              <input type="password" id="pw-new" class="form-control" required minlength="8">
            </div>
            <div class="form-group">
              <label>${i18n.t('pages.settings.confirmPassword')}</label>
              <input type="password" id="pw-confirm" class="form-control" required>
            </div>
            <button type="submit" class="btn btn-primary">${i18n.t('pages.settings.changePassword')}</button>
          </form>
        </div>
      </div>
    `;

    el.querySelector('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = el.querySelector('#pw-current').value;
      const newPw = el.querySelector('#pw-new').value;
      const confirm = el.querySelector('#pw-confirm').value;

      if (newPw !== confirm) { Toast.error(i18n.t('pages.settings.passwordsMismatch')); return; }
      if (newPw.length < 8) { Toast.error(i18n.t('pages.settings.passwordTooShort')); return; }

      try {
        await Api.changePassword(current, newPw);
        Toast.success(i18n.t('pages.settings.passwordChanged'));
        el.querySelector('#pw-form').reset();
      } catch (err) { Toast.error(err.message); }
    });
  },

  async _renderUsers(el) {
    const users = await Api.getUsers();
    const items = users.users || users || [];

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>${i18n.t('pages.settings.userManagement')}</h3>
          <button class="btn btn-sm btn-primary" id="user-create"><i class="fas fa-plus"></i> ${i18n.t('pages.settings.newUser')}</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead><tr><th>${i18n.t('pages.settings.username')}</th><th>Email</th><th>${i18n.t('pages.settings.role')}</th><th>MFA</th><th>${i18n.t('common.status')}</th><th>${i18n.t('pages.settings.lastLogin')}</th><th>${i18n.t('common.actions')}</th></tr></thead>
            <tbody>${items.map(u => `
              <tr>
                <td class="mono">${Utils.escapeHtml(u.username)}</td>
                <td class="text-sm">${u.email ? Utils.escapeHtml(u.email) : '<span class="text-muted">—</span>'}</td>
                <td><span class="badge badge-info">${u.role}</span></td>
                <td>${u.totp_enabled
                  ? `<span class="badge badge-running" style="font-size:10px"><i class="fas fa-shield-alt" style="margin-right:3px"></i>TOTP</span>`
                  : '<span class="text-muted text-sm">Off</span>'}</td>
                <td>${u.is_active ? `<span class="text-green">${i18n.t('common.active')}</span>` : `<span class="text-muted">${i18n.t('common.inactive')}</span>`}</td>
                <td>${u.last_login_at ? Utils.timeAgo(u.last_login_at) : '—'}</td>
                <td>
                  <div class="action-btns">
                    <button class="action-btn" data-action="edit-user" data-id="${u.id}" title="${i18n.t('common.edit')}"><i class="fas fa-edit"></i></button>
                    <button class="action-btn" data-action="stack-perms" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Stack Permissions"><i class="fas fa-lock"></i></button>
                    <button class="action-btn" data-action="reset-password" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Reset Password"><i class="fas fa-key"></i></button>
                    ${!u.totp_enabled
                      ? `<button class="action-btn" data-action="setup-mfa" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Enable MFA"><i class="fas fa-shield-alt"></i></button>`
                      : `<button class="action-btn danger" data-action="disable-mfa" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Disable MFA"><i class="fas fa-unlock"></i></button>`}
                    ${u.email ? `<button class="action-btn" data-action="send-invite" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="${i18n.t('pages.settings.sendInvite')}"><i class="fas fa-envelope"></i></button>` : ''}
                    ${u.username !== 'admin' ? `<button class="action-btn danger" data-action="delete-user" data-id="${u.id}" title="${i18n.t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
      </div>
    `;

    el.querySelector('#user-create').addEventListener('click', () => this._createUserDialog());

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = parseInt(btn.dataset.id);
      const username = btn.dataset.username;
      if (action === 'edit-user') this._editUser(id);
      else if (action === 'stack-perms') this._editStackPermissions(id, username);
      else if (action === 'reset-password') this._resetPasswordDialog(id, username);
      else if (action === 'send-reset') this._sendResetEmail(id, username);
      else if (action === 'send-invite') this._sendInviteEmail(id, username);
      else if (action === 'delete-user') this._deleteUser(id);
      else if (action === 'setup-mfa') this._setupMfaDialog(id, username);
      else if (action === 'disable-mfa') this._disableMfaDialog(id, username);
    });
  },

  async _createUserDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>${i18n.t('pages.settings.username')}</label>
        <input type="text" id="nu-user" class="form-control" required>
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="nu-email" class="form-control" placeholder="${i18n.t('pages.settings.emailPlaceholder')}">
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.settings.passwordLabel')}</label>
        <input type="password" id="nu-pass" class="form-control" required minlength="8">
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.settings.roleLabel')}</label>
        <select id="nu-role" class="form-control">
          <option value="viewer">${i18n.t('pages.settings.viewer')}</option>
          <option value="operator">${i18n.t('pages.settings.operatorRole')}</option>
          <option value="admin">${i18n.t('pages.settings.admin')}</option>
        </select>
      </div>
    `, {
      title: i18n.t('pages.settings.createUserTitle'),
      width: '400px',
      onSubmit: (content) => {
        const username = content.querySelector('#nu-user').value.trim();
        const email = content.querySelector('#nu-email').value.trim();
        const password = content.querySelector('#nu-pass').value;
        const role = content.querySelector('#nu-role').value;
        if (!username || !password) { Toast.warning(i18n.t('pages.settings.allFieldsRequired')); return false; }
        return { username, email, password, role };
      }
    });

    if (result) {
      try {
        await Api.createUser(result);
        Toast.success(i18n.t('pages.settings.userCreated'));
        await this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _editUser(id) {
    try {
      const users = await Api.getUsers();
      const user = (users.users || users || []).find(u => u.id === id);
      if (!user) return;

      const result = await Modal.form(`
        <div class="form-group">
          <label>${i18n.t('pages.settings.username')}</label>
          <input type="text" id="eu-user" class="form-control" value="${Utils.escapeHtml(user.username)}" disabled>
        </div>
        <div class="form-group">
          <label>Email</label>
          <input type="email" id="eu-email" class="form-control" value="${Utils.escapeHtml(user.email || '')}" placeholder="${i18n.t('pages.settings.emailPlaceholder')}">
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.settings.roleLabel')}</label>
          <select id="eu-role" class="form-control">
            <option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>${i18n.t('pages.settings.viewer')}</option>
            <option value="operator" ${user.role === 'operator' ? 'selected' : ''}>${i18n.t('pages.settings.operatorRole')}</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>${i18n.t('pages.settings.admin')}</option>
          </select>
        </div>
        <div class="form-group">
          <label><input type="checkbox" id="eu-active" ${user.is_active ? 'checked' : ''}> ${i18n.t('pages.settings.activeLabel')}</label>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.settings.newPasswordHint')}</label>
          <input type="password" id="eu-pass" class="form-control" placeholder="${i18n.t('pages.settings.unchangedPlaceholder')}">
        </div>
      `, {
        title: i18n.t('pages.settings.editUserTitle'),
        width: '400px',
        onSubmit: (content) => {
          const data = {
            email: content.querySelector('#eu-email').value.trim(),
            role: content.querySelector('#eu-role').value,
            isActive: content.querySelector('#eu-active').checked ? 1 : 0,
          };
          const pw = content.querySelector('#eu-pass').value;
          if (pw) data.password = pw;
          return data;
        }
      });

      if (result) {
        await Api.updateUser(id, result);
        Toast.success(i18n.t('pages.settings.userUpdated'));
        await this._renderTab();
      }
    } catch (err) { Toast.error(err.message); }
  },

  async _editStackPermissions(userId, username) {
    try {
      const [permsRes, stacksRes] = await Promise.all([
        Api.getUserPermissions(userId),
        Api.getStacks().catch(() => []),
      ]);
      const perms = permsRes.permissions || [];
      const permsMap = {};
      for (const p of perms) permsMap[p.stack_name] = p.permission;

      // Also get running containers to discover stack names
      let stackNames = [];
      try {
        const containers = await Api.getContainers(true);
        const nameSet = new Set();
        for (const c of containers) {
          const stack = c.stack || c.labels?.['com.docker.compose.project'];
          if (stack) nameSet.add(stack);
        }
        stackNames = [...nameSet].sort();
      } catch { /* fallback */ }

      // Merge stack names from stacks endpoint
      if (Array.isArray(stacksRes)) {
        for (const s of stacksRes) {
          const name = s.name || s;
          if (name && !stackNames.includes(name)) stackNames.push(name);
        }
        stackNames.sort();
      }

      // Also include stacks from existing permissions not in current container list
      for (const p of perms) {
        if (!stackNames.includes(p.stack_name)) stackNames.push(p.stack_name);
      }

      const html = `
        <div class="modal-header">
          <h3><i class="fas fa-lock" style="margin-right:8px;color:var(--accent)"></i>Stack Permissions: ${Utils.escapeHtml(username)}</h3>
          <button class="modal-close-btn" id="sp-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          <p class="text-sm text-muted" style="margin-bottom:12px">
            Override global role for specific stacks. "Inherit" uses the global role.
          </p>
          ${stackNames.length === 0 ? '<div class="empty-msg">No stacks found</div>' : `
          <table class="data-table">
            <thead><tr><th>Stack</th><th>Permission</th><th></th></tr></thead>
            <tbody>
              ${stackNames.map(stack => {
                const current = permsMap[stack] || '';
                return `<tr data-stack="${Utils.escapeHtml(stack)}">
                  <td class="mono"><i class="fas fa-layer-group" style="margin-right:6px;opacity:0.5"></i>${Utils.escapeHtml(stack)}</td>
                  <td>
                    <select class="form-control form-control-sm sp-select" data-stack="${Utils.escapeHtml(stack)}" style="width:140px">
                      <option value="" ${!current ? 'selected' : ''}>Inherit</option>
                      <option value="none" ${current === 'none' ? 'selected' : ''}>None (hidden)</option>
                      <option value="view" ${current === 'view' ? 'selected' : ''}>View</option>
                      <option value="operate" ${current === 'operate' ? 'selected' : ''}>Operate</option>
                      <option value="admin" ${current === 'admin' ? 'selected' : ''}>Admin</option>
                    </select>
                  </td>
                  <td>${current ? '<span class="badge badge-warning" style="font-size:10px">Override</span>' : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="sp-cancel">Cancel</button>
          <button class="btn btn-primary" id="sp-save"><i class="fas fa-save" style="margin-right:4px"></i>Save Permissions</button>
        </div>
      `;

      Modal.open(html, { width: '520px' });
      const mc = Modal._content;
      mc.querySelector('#sp-close').addEventListener('click', () => Modal.close());
      mc.querySelector('#sp-cancel').addEventListener('click', () => Modal.close());

      mc.querySelector('#sp-save').addEventListener('click', async () => {
        try {
          const selects = mc.querySelectorAll('.sp-select');
          for (const sel of selects) {
            const stack = sel.dataset.stack;
            const val = sel.value;
            const had = permsMap[stack];

            if (val && val !== had) {
              await Api.setPermission({ stackName: stack, userId, permission: val });
            } else if (!val && had) {
              await Api.removePermission(stack, userId);
            }
          }
          Toast.success('Stack permissions updated');
          Modal.close();
        } catch (err) {
          Toast.error(err.message);
        }
      });
    } catch (err) { Toast.error(err.message); }
  },

  async _resetPasswordDialog(id, username) {
    if (!id || !username) { Toast.error(i18n.t('pages.settings.cannotReset')); return; }
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-key" style="margin-right:8px;color:var(--accent)"></i>${i18n.t('pages.settings.resetPasswordTitle', { username: Utils.escapeHtml(username) })}</h3>
        <button class="modal-close-btn" id="rp-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${i18n.t('pages.settings.newPasswordLabel')}</label>
          <input type="password" id="rp-new" class="form-control" placeholder="${i18n.t('pages.settings.minCharsPlaceholder')}" autofocus>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.settings.confirmPasswordLabel')}</label>
          <input type="password" id="rp-confirm" class="form-control">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="rp-cancel">${i18n.t('common.cancel')}</button>
        <button class="btn btn-primary" id="rp-submit"><i class="fas fa-key"></i> ${i18n.t('pages.settings.resetPassword')}</button>
      </div>
    `;
    Modal.open(html, { width: '400px' });

    Modal._content.querySelector('#rp-close').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#rp-cancel').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#rp-submit').addEventListener('click', async () => {
      const newPass = Modal._content.querySelector('#rp-new').value;
      const confirm = Modal._content.querySelector('#rp-confirm').value;

      if (!newPass || newPass.length < 8) { Toast.warning(i18n.t('pages.settings.passwordMinChars')); return; }
      if (newPass !== confirm) { Toast.warning(i18n.t('pages.settings.passwordsNoMatch')); return; }

      try {
        await Api.post('/auth/users/' + id + '/reset-password', { password: newPass });
        Modal.close();

        // If resetting own password → logout so user re-authenticates with new password
        if (id === App.user?.id) {
          Toast.success(i18n.t('pages.settings.passwordChangedRelogin'));
          setTimeout(async () => {
            try { await Api.logout(); } catch {}
            App.handleUnauthorized();
          }, 1500);
        } else {
          Toast.success(i18n.t('pages.settings.passwordResetFor', { username }));
        }
      } catch (err) { Toast.error(err.message); }
    });
  },

  async _sendResetEmail(id, username) {
    const ok = await Modal.confirm(
      i18n.t('pages.settings.sendResetConfirm', { username }),
      { confirmText: i18n.t('pages.settings.sendReset') }
    );
    if (!ok) return;
    try {
      await Api.sendPasswordReset(id, i18n.lang);
      Toast.success(i18n.t('pages.settings.resetEmailSent', { username }));
    } catch (err) {
      Toast.error(i18n.t('pages.settings.emailFailed', { message: err.message }));
    }
  },

  async _sendInviteEmail(id, username) {
    const ok = await Modal.confirm(
      i18n.t('pages.settings.sendInviteConfirm', { username }),
      { confirmText: i18n.t('pages.settings.sendInvite') }
    );
    if (!ok) return;
    try {
      await Api.sendInvitation(id, i18n.lang);
      Toast.success(i18n.t('pages.settings.inviteEmailSent', { username }));
    } catch (err) {
      Toast.error(i18n.t('pages.settings.emailFailed', { message: err.message }));
    }
  },

  async _deleteUser(id) {
    const ok = await Modal.confirm(i18n.t('pages.settings.deleteUserConfirm'), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try {
      await Api.deleteUser(id);
      Toast.success(i18n.t('pages.settings.userDeleted'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _setupMfaDialog(userId, username) {
    try {
      // Step 1: Setup — get secret and otpauth URI
      const setup = await Api.post('/auth/mfa/setup');
      if (setup.error) { Toast.error(setup.error); return; }

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.settings.enableMfaTitle', { username: Utils.escapeHtml(username) })}</h3>
          <button class="modal-close-btn" id="mfa-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <p class="text-sm text-muted" style="margin-bottom:12px">${i18n.t('pages.settings.mfaScanInstructions')}</p>

          <div style="text-align:center;margin:16px 0">
            <div style="background:#fff;display:inline-block;padding:16px;border-radius:8px">
              <canvas id="mfa-qr-canvas" width="200" height="200"></canvas>
            </div>
          </div>

          <div style="text-align:center;margin-bottom:16px">
            <details>
              <summary class="text-sm" style="color:var(--accent);cursor:pointer">${i18n.t('pages.settings.cantScan')}</summary>
              <div class="mono text-sm" style="margin-top:8px;padding:8px;background:var(--surface2);border-radius:4px;word-break:break-all">${Utils.escapeHtml(setup.secret)}</div>
            </details>
          </div>

          <div class="form-group">
            <label>${i18n.t('pages.settings.enterCode')}</label>
            <input type="text" id="mfa-verify-code" class="form-control" placeholder="000000" maxlength="6" pattern="[0-9]{6}" inputmode="numeric" style="text-align:center;font-size:20px;letter-spacing:6px;max-width:200px;margin:0 auto;display:block">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="mfa-cancel">${i18n.t('common.cancel')}</button>
          <button class="btn btn-primary" id="mfa-enable-btn"><i class="fas fa-check"></i> ${i18n.t('pages.settings.verifyAndEnable')}</button>
        </div>
      `, { width: '480px' });

      // Render QR code on canvas
      if (window.QR) QR.render(document.getElementById('mfa-qr-canvas'), setup.otpauthUri, 3);

      Modal._content.querySelector('#mfa-close').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#mfa-cancel').addEventListener('click', () => Modal.close());

      Modal._content.querySelector('#mfa-enable-btn').addEventListener('click', async () => {
        const code = Modal._content.querySelector('#mfa-verify-code').value.trim();
        if (!code || code.length !== 6) { Toast.error(i18n.t('pages.settings.enterTheCode')); return; }
        try {
          const result = await Api.post('/auth/mfa/enable', { code });
          if (result.error) { Toast.error(result.error); return; }

          // Show recovery codes
          Modal._content.querySelector('.modal-body').innerHTML = `
            <div style="text-align:center;margin-bottom:16px">
              <i class="fas fa-check-circle" style="font-size:48px;color:var(--green)"></i>
              <h3 style="margin:12px 0 4px">${i18n.t('pages.settings.mfaEnabled')}</h3>
              <p class="text-sm text-muted">${i18n.t('pages.settings.mfaEnabledDesc')}</p>
            </div>
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:16px;font-family:var(--mono);font-size:14px;line-height:2;text-align:center">
              ${result.recoveryCodes.map(c => `<div>${Utils.escapeHtml(c)}</div>`).join('')}
            </div>
          `;
          Modal._content.querySelector('.modal-footer').innerHTML = `
            <button class="btn btn-secondary" id="mfa-dl-codes"><i class="fas fa-download"></i> ${i18n.t('pages.settings.downloadCodes')}</button>
            <button class="btn btn-primary" id="mfa-done">${i18n.t('common.close')}</button>
          `;
          Modal._content.querySelector('#mfa-done').addEventListener('click', () => { Modal.close(); this._renderTab(); });
          Modal._content.querySelector('#mfa-dl-codes').addEventListener('click', () => {
            const blob = new Blob([result.recoveryCodes.join('\n')], { type: 'text/plain' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
            a.download = `docker-dash-recovery-codes-${username}.txt`; a.click();
          });

          Toast.success(i18n.t('pages.settings.mfaEnabledToast', { username }));
        } catch (err) { Toast.error(err.message); }
      });
    } catch (err) { Toast.error(err.message); }
  },

  async _disableMfaDialog(userId, username) {
    const ok = await Modal.confirm(
      i18n.t('pages.settings.disableMfaConfirm', { username }),
      { danger: true, confirmText: i18n.t('pages.settings.disableMfa') }
    );
    if (!ok) return;
    try {
      // Admin disabling MFA for another user — use admin endpoint
      await Api.delete(`/auth/users/${userId}/mfa`);
      Toast.success(i18n.t('pages.settings.mfaDisabled', { username }));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _renderWebhooks(el) {
    const data = await Api.getWebhooks();
    const items = data.webhooks || data || [];

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>${i18n.t('pages.settings.webhooks')}</h3>
          <button class="btn btn-sm btn-primary" id="wh-create"><i class="fas fa-plus"></i> ${i18n.t('pages.settings.newWebhook')}</button>
        </div>
        <div class="card-body">
          ${items.length === 0 ? `<div class="empty-msg">${i18n.t('pages.settings.noWebhooks')}</div>` : `
          <table class="data-table">
            <thead><tr><th>${i18n.t('common.name')}</th><th>${i18n.t('pages.settings.url')}</th><th>${i18n.t('pages.settings.events')}</th><th>${i18n.t('common.status')}</th><th>${i18n.t('common.actions')}</th></tr></thead>
            <tbody>${items.map(w => `
              <tr>
                <td>${Utils.escapeHtml(w.name)}</td>
                <td class="mono text-sm">${Utils.escapeHtml((w.url || '').substring(0, 50))}</td>
                <td class="text-sm">${Utils.escapeHtml(w.events || '')}</td>
                <td>${w.is_active ? `<span class="text-green">${i18n.t('common.active')}</span>` : `<span class="text-muted">${i18n.t('common.inactive')}</span>`}</td>
                <td>
                  <div class="action-btns">
                    <button class="action-btn" data-action="test-webhook" data-id="${w.id}" title="${i18n.t('common.test')}"><i class="fas fa-paper-plane"></i></button>
                    <button class="action-btn danger" data-action="delete-webhook" data-id="${w.id}" title="${i18n.t('common.delete')}"><i class="fas fa-trash"></i></button>
                  </div>
                </td>
              </tr>
            `).join('')}</tbody>
          </table>`}
        </div>
      </div>
    `;

    el.querySelector('#wh-create')?.addEventListener('click', () => this._createWebhookDialog());

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = parseInt(btn.dataset.id);
      if (action === 'test-webhook') this._testWebhook(id);
      else if (action === 'delete-webhook') this._deleteWebhook(id);
    });
  },

  async _createWebhookDialog() {
    const result = await Modal.form(`
      <div class="form-group"><label>${i18n.t('common.name')}</label><input type="text" id="wh-name" class="form-control" required></div>
      <div class="form-group"><label>${i18n.t('pages.settings.url')}</label><input type="url" id="wh-url" class="form-control" required placeholder="${i18n.t('pages.settings.urlPlaceholder')}"></div>
      <div class="form-group"><label>${i18n.t('pages.settings.eventsLabel')}</label><input type="text" id="wh-events" class="form-control" value="container.start,container.stop,alert.triggered"></div>
      <div class="form-group"><label>${i18n.t('pages.settings.secretLabel')}</label><input type="text" id="wh-secret" class="form-control"></div>
    `, {
      title: i18n.t('pages.settings.createWebhookTitle'),
      width: '480px',
      onSubmit: (content) => {
        const name = content.querySelector('#wh-name').value.trim();
        const url = content.querySelector('#wh-url').value.trim();
        if (!name || !url) { Toast.warning(i18n.t('pages.settings.nameUrlRequired')); return false; }
        return {
          name, url,
          events: content.querySelector('#wh-events').value,
          secret: content.querySelector('#wh-secret').value || undefined,
          is_active: 1,
        };
      }
    });

    if (result) {
      try {
        await Api.createWebhook(result);
        Toast.success(i18n.t('pages.settings.webhookCreated'));
        await this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _testWebhook(id) {
    try {
      await Api.testWebhook(id);
      Toast.success(i18n.t('pages.settings.testSent'));
    } catch (err) { Toast.error(err.message); }
  },

  async _deleteWebhook(id) {
    const ok = await Modal.confirm(i18n.t('pages.settings.deleteWebhookConfirm'), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try {
      await Api.deleteWebhook(id);
      Toast.success(i18n.t('pages.settings.webhookDeleted'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _renderRegistries(el) {
    try {
      const registries = await Api.getRegistries();
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-warehouse" style="margin-right:8px"></i>${i18n.t('pages.settings.registriesTitle')}</h3>
            <button class="btn btn-sm btn-primary" id="add-registry"><i class="fas fa-plus"></i> ${i18n.t('pages.settings.addRegistry')}</button>
          </div>
          <div class="card-body" style="padding:0">
            ${registries.length === 0 ? '<div class="empty-msg">' + i18n.t('pages.settings.noRegistries') + '</div>' : `
            <table class="data-table">
              <thead><tr><th style="text-align:left">Name</th><th>URL</th><th>Username</th><th>Last Used</th><th></th></tr></thead>
              <tbody>${registries.map(r => `
                <tr>
                  <td style="text-align:left"><strong>${Utils.escapeHtml(r.name)}</strong></td>
                  <td class="mono text-sm">${Utils.escapeHtml(r.url)}</td>
                  <td class="text-sm">${Utils.escapeHtml(r.username || '\u2014')}</td>
                  <td class="text-sm">${r.last_used_at ? Utils.timeAgo(r.last_used_at) : '\u2014'}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn" data-action="test-registry" data-reg-id="${r.id}" title="Test"><i class="fas fa-plug"></i></button>
                      <button class="action-btn" data-action="edit-registry" data-reg-id="${r.id}" title="Edit"><i class="fas fa-edit"></i></button>
                      <button class="action-btn danger" data-action="delete-registry" data-reg-id="${r.id}" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

      el.querySelector('#add-registry')?.addEventListener('click', () => this._addRegistryDialog());

      // Event delegation for registry action buttons
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const regId = parseInt(btn.dataset.regId);
        if (btn.dataset.action === 'test-registry') this._testRegistry(regId);
        else if (btn.dataset.action === 'edit-registry') this._editRegistry(regId);
        else if (btn.dataset.action === 'delete-registry') this._deleteRegistry(regId);
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _addRegistryDialog() {
    const result = await Modal.form(`
      <div class="form-group"><label>Name</label><input type="text" id="reg-name" class="form-control" placeholder="My Registry"></div>
      <div class="form-group"><label>URL</label><input type="text" id="reg-url" class="form-control" placeholder="https://registry.example.com"></div>
      <div class="form-group"><label>Username (optional)</label><input type="text" id="reg-user" class="form-control"></div>
      <div class="form-group"><label>Password (optional)</label><input type="password" id="reg-pass" class="form-control"></div>
    `, {
      title: i18n.t('pages.settings.addRegistryTitle'),
      width: '450px',
      onSubmit: (content) => ({
        name: content.querySelector('#reg-name').value.trim(),
        url: content.querySelector('#reg-url').value.trim(),
        username: content.querySelector('#reg-user').value.trim(),
        password: content.querySelector('#reg-pass').value,
      }),
    });

    if (result && result.name && result.url) {
      try {
        await Api.createRegistry(result);
        Toast.success(i18n.t('pages.settings.registryAdded'));
        this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _testRegistry(id) {
    // Find the row in the table to show inline feedback
    const el = document.getElementById('settings-content');
    const row = el?.querySelector(`[data-action="test-registry"][data-reg-id="${id}"]`)?.closest('tr');
    const btn = el?.querySelector(`[data-action="test-registry"][data-reg-id="${id}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    // Remove any previous result cell
    row?.querySelector('.test-result-cell')?.remove();

    try {
      // Test basic connectivity
      const result = await Api.testRegistry(id);

      // Attempt to fetch catalog to count repositories
      let repoInfo = '';
      let overallOk = result.ok;
      if (result.ok) {
        try {
          const repos = await Api.getRegistryCatalog(id);
          if (repos.length === 0) {
            overallOk = false;
            repoInfo = ' &mdash; 0 repositories (wrong URL, wrong credentials, or empty registry)';
          } else {
            repoInfo = ` &mdash; <strong>${repos.length}</strong> repositor${repos.length === 1 ? 'y' : 'ies'}`;
          }
        } catch {
          repoInfo = ' &mdash; catalog unavailable (private/restricted)';
        }
      }

      if (row) {
        const td = document.createElement('td');
        td.className = 'test-result-cell text-sm';
        td.colSpan = 1;
        if (overallOk) {
          td.innerHTML = `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Connected${repoInfo}</span>`;
        } else {
          const errMsg = result.ok ? repoInfo.replace(/^ &mdash; /, '') : Utils.escapeHtml(result.error || 'Failed');
          td.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${errMsg}</span>`;
        }
        // Insert before the actions column
        const actionsCell = row.querySelector('.action-btns')?.closest('td');
        row.insertBefore(td, actionsCell);
        setTimeout(() => td.remove(), 8000);
      } else {
        if (result.ok) Toast.success('Connected' + repoInfo.replace(/&mdash;/g, '—').replace(/<[^>]+>/g, ''));
        else Toast.error(result.error || 'Connection failed');
      }
    } catch (err) {
      if (row) {
        const td = document.createElement('td');
        td.className = 'test-result-cell text-sm';
        td.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</span>`;
        const actionsCell = row.querySelector('.action-btns')?.closest('td');
        row.insertBefore(td, actionsCell);
        setTimeout(() => td.remove(), 8000);
      } else {
        Toast.error(err.message);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plug"></i>'; }
    }
  },

  async _editRegistry(id) {
    // Load current registries to get data for this id
    let reg;
    try {
      const list = await Api.getRegistries();
      reg = list.find(r => r.id === id);
    } catch { reg = null; }
    if (!reg) { Toast.error('Registry not found'); return; }

    const result = await Modal.form(`
      <div class="form-group">
        <label>Name <span class="text-red">*</span></label>
        <input type="text" id="reg-name" class="form-control" value="${Utils.escapeHtml(reg.name)}">
      </div>
      <div class="form-group">
        <label>URL <span class="text-red">*</span></label>
        <input type="text" id="reg-url" class="form-control" value="${Utils.escapeHtml(reg.url)}">
      </div>
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="reg-user" class="form-control" value="${Utils.escapeHtml(reg.username || '')}">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="reg-pass" class="form-control" placeholder="Leave blank to keep current password" autocomplete="new-password">
        <small class="text-muted">Leave blank to keep the existing password unchanged.</small>
      </div>
    `, {
      title: `Edit Registry — ${Utils.escapeHtml(reg.name)}`,
      width: '450px',
      onSubmit: (content) => ({
        name: content.querySelector('#reg-name').value.trim(),
        url: content.querySelector('#reg-url').value.trim(),
        username: content.querySelector('#reg-user').value.trim(),
        password: content.querySelector('#reg-pass').value || undefined,
      }),
    });

    if (result && result.name && result.url) {
      try {
        await Api.updateRegistry(id, result);
        Toast.success(`Registry "${result.name}" updated`);
        this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _deleteRegistry(id) {
    const ok = await Modal.confirm(i18n.t('pages.settings.deleteRegistryConfirm'), { danger: true });
    if (!ok) return;
    try {
      await Api.deleteRegistry(id);
      Toast.success(i18n.t('pages.settings.registryDeleted'));
      this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _renderNotificationChannels(el) {
    try {
      const [channels, providers] = await Promise.all([
        Api.getNotificationChannels(),
        Api.getNotificationProviders(),
      ]);

      const providerIcons = { discord: 'fab fa-discord', slack: 'fab fa-slack', telegram: 'fab fa-telegram', ntfy: 'fas fa-bell', gotify: 'fas fa-bell', email: 'fas fa-envelope', webhook: 'fas fa-globe' };

      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-bell" style="margin-right:8px"></i>${i18n.t('pages.settings.notificationChannelsTitle')}</h3>
            <button class="btn btn-sm btn-primary" id="nc-create"><i class="fas fa-plus"></i> ${i18n.t('pages.settings.addChannel')}</button>
          </div>
          <div class="card-body" style="padding:0">
            ${channels.length === 0 ? '<div class="empty-msg">' + i18n.t('pages.settings.noChannels') + '</div>' : `
            <table class="data-table">
              <thead><tr><th style="text-align:left">Name</th><th>Provider</th><th>Status</th><th></th></tr></thead>
              <tbody>${channels.map(c => `
                <tr>
                  <td style="text-align:left"><i class="${providerIcons[c.provider] || 'fas fa-bell'}" style="margin-right:8px;color:var(--accent)"></i><strong>${Utils.escapeHtml(c.name)}</strong></td>
                  <td><span class="badge badge-info">${c.provider}</span></td>
                  <td>${c.is_active ? '<span class="text-green">Active</span>' : '<span class="text-muted">Inactive</span>'}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn" data-action="test-nc" data-id="${c.id}" title="Test"><i class="fas fa-paper-plane"></i></button>
                      <button class="action-btn danger" data-action="delete-nc" data-id="${c.id}" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

      el.querySelector('#nc-create')?.addEventListener('click', async () => {
        const providerOptions = providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

        const result = await Modal.form(`
          <div class="form-group">
            <label>Name *</label>
            <input type="text" id="nc-name" class="form-control" placeholder="e.g. Team Discord" required>
          </div>
          <div class="form-group">
            <label>Provider *</label>
            <select id="nc-provider" class="form-control">${providerOptions}</select>
          </div>
          <div id="nc-fields"></div>
        `, {
          title: i18n.t('pages.settings.addChannelTitle'),
          width: '480px',
          onSubmit: (content) => {
            const name = content.querySelector('#nc-name').value.trim();
            const provider = content.querySelector('#nc-provider').value;
            if (!name) { Toast.warning(i18n.t('pages.settings.nameRequired')); return false; }
            const config = {};
            content.querySelectorAll('[data-config-key]').forEach(input => {
              config[input.dataset.configKey] = input.value;
            });
            return { name, provider, config };
          },
          onOpen: (content) => {
            const renderFields = () => {
              const pid = content.querySelector('#nc-provider').value;
              const prov = providers.find(p => p.id === pid);
              const fieldsEl = content.querySelector('#nc-fields');
              fieldsEl.innerHTML = (prov?.fields || []).map(f => `
                <div class="form-group">
                  <label>${f.label}${f.required ? ' *' : ''}</label>
                  <input type="${f.type || 'text'}" data-config-key="${f.key}" class="form-control"
                    placeholder="${f.placeholder || ''}" ${f.required ? 'required' : ''}>
                </div>
              `).join('');
            };
            content.querySelector('#nc-provider').addEventListener('change', renderFields);
            renderFields();
          },
        });

        if (result) {
          try {
            await Api.createNotificationChannel(result);
            Toast.success(i18n.t('pages.settings.channelCreated'));
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });

      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id);
        if (btn.dataset.action === 'test-nc') {
          Toast.info(i18n.t('pages.settings.sendingTest'));
          try {
            const res = await Api.testNotificationChannel(id);
            if (res.ok) Toast.success(i18n.t('pages.settings.testSentSuccess'));
            else Toast.error(i18n.t('pages.settings.testFailed', { message: res.error || 'Unknown error' }));
          } catch (err) { Toast.error(err.message); }
        } else if (btn.dataset.action === 'delete-nc') {
          const ok = await Modal.confirm(i18n.t('pages.settings.deleteChannelConfirm'), { danger: true });
          if (!ok) return;
          try {
            await Api.deleteNotificationChannel(id);
            Toast.success(i18n.t('pages.settings.channelDeleted'));
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _renderGitCredentials(el) {
    try {
      const creds = await Api.getGitCredentials();
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fab fa-git-alt" style="margin-right:8px"></i>${i18n.t('pages.settings.gitCredentialsTitle')}</h3>
            <button class="btn btn-sm btn-primary" id="gc-create"><i class="fas fa-plus"></i> ${i18n.t('pages.settings.addCredential')}</button>
          </div>
          <div class="card-body" style="padding:0">
            ${creds.length === 0 ? '<div class="empty-msg">' + i18n.t('pages.settings.noCredentials') + '</div>' : `
            <table class="data-table">
              <thead><tr><th style="text-align:left">Name</th><th>Type</th><th>Username</th><th>Used By</th><th>Created</th><th></th></tr></thead>
              <tbody>${creds.map(c => `
                <tr>
                  <td style="text-align:left"><strong>${Utils.escapeHtml(c.name)}</strong></td>
                  <td><span class="badge badge-info">${c.auth_type === 'ssh_key' ? 'SSH Key' : c.auth_type === 'token' ? 'Token' : 'Basic'}</span></td>
                  <td class="mono text-sm">${c.username ? Utils.escapeHtml(c.username) : '\u2014'}</td>
                  <td>${c.usage_count} stack(s)</td>
                  <td class="text-sm">${Utils.timeAgo(c.created_at)}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn" data-action="edit-gc" data-id="${c.id}" title="Edit"><i class="fas fa-edit"></i></button>
                      <button class="action-btn danger" data-action="delete-gc" data-id="${c.id}" data-count="${c.usage_count}" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

      el.querySelector('#gc-create')?.addEventListener('click', () => this._createGitCredentialDialog());
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'edit-gc') this._editGitCredential(parseInt(btn.dataset.id));
        else if (btn.dataset.action === 'delete-gc') this._deleteGitCredential(parseInt(btn.dataset.id), parseInt(btn.dataset.count));
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _createGitCredentialDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>Name *</label>
        <input type="text" id="gc-name" class="form-control" placeholder="e.g. GitHub Personal" required>
      </div>
      <div class="form-group">
        <label>Auth Type *</label>
        <select id="gc-auth-type" class="form-control">
          <option value="token">Personal Access Token</option>
          <option value="basic">Username & Password</option>
          <option value="ssh_key">SSH Key</option>
        </select>
      </div>
      <div id="gc-token-fields">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="gc-username" class="form-control" value="x-access-token">
          <small class="text-muted">Use "x-access-token" for GitHub PATs, your username for GitLab</small>
        </div>
        <div class="form-group">
          <label>Token / Password *</label>
          <input type="password" id="gc-password" class="form-control" placeholder="ghp_...">
        </div>
      </div>
      <div id="gc-ssh-fields" style="display:none">
        <div class="form-group">
          <label>Private Key *</label>
          <textarea id="gc-ssh-key" class="form-control" rows="6" style="font-family:var(--mono);font-size:11px"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
          <small class="text-muted">Paste your SSH private key. It will be encrypted at rest.</small>
        </div>
      </div>
    `, {
      title: i18n.t('pages.settings.newCredentialTitle'),
      width: '480px',
      onSubmit: (content) => {
        const name = content.querySelector('#gc-name').value.trim();
        const auth_type = content.querySelector('#gc-auth-type').value;
        if (!name) { Toast.warning('Name is required'); return false; }

        const data = { name, auth_type };
        if (auth_type === 'ssh_key') {
          data.ssh_private_key = content.querySelector('#gc-ssh-key').value;
          if (!data.ssh_private_key) { Toast.warning('SSH private key is required'); return false; }
        } else {
          data.username = content.querySelector('#gc-username').value.trim();
          data.password = content.querySelector('#gc-password').value;
          if (!data.password) { Toast.warning('Token/password is required'); return false; }
        }
        return data;
      },
      onOpen: (content) => {
        const sel = content.querySelector('#gc-auth-type');
        sel.addEventListener('change', () => {
          content.querySelector('#gc-token-fields').style.display = sel.value === 'ssh_key' ? 'none' : '';
          content.querySelector('#gc-ssh-fields').style.display = sel.value === 'ssh_key' ? '' : 'none';
        });
      },
    });

    if (result) {
      try {
        await Api.createGitCredential(result);
        Toast.success(i18n.t('pages.settings.credentialCreated'));
        await this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _editGitCredential(id) {
    try {
      const creds = await Api.getGitCredentials();
      const cred = creds.find(c => c.id === id);
      if (!cred) return;

      const result = await Modal.form(`
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="gc-name" class="form-control" value="${Utils.escapeHtml(cred.name)}">
        </div>
        <div class="form-group">
          <label>Auth Type</label>
          <input type="text" class="form-control" value="${cred.auth_type === 'ssh_key' ? 'SSH Key' : cred.auth_type === 'token' ? 'Token' : 'Basic'}" disabled>
        </div>
        ${cred.auth_type !== 'ssh_key' ? `
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="gc-username" class="form-control" value="${Utils.escapeHtml(cred.username || '')}">
          </div>
          <div class="form-group">
            <label>New Token / Password</label>
            <input type="password" id="gc-password" class="form-control" placeholder="Leave blank to keep current">
          </div>
        ` : `
          <div class="form-group">
            <label>New Private Key</label>
            <textarea id="gc-ssh-key" class="form-control" rows="6" style="font-family:var(--mono);font-size:11px"
                      placeholder="Leave blank to keep current key"></textarea>
          </div>
          ${cred.ssh_public_key ? `<div class="form-group"><label>Current Public Key</label><div class="mono text-sm" style="word-break:break-all;padding:8px;background:var(--surface2);border-radius:4px">${Utils.escapeHtml(cred.ssh_public_key)}</div></div>` : ''}
        `}
      `, {
        title: i18n.t('pages.settings.editCredentialTitle'),
        width: '480px',
        onSubmit: (content) => {
          const data = {};
          const name = content.querySelector('#gc-name')?.value?.trim();
          if (name) data.name = name;
          const username = content.querySelector('#gc-username')?.value?.trim();
          if (username !== undefined) data.username = username;
          const password = content.querySelector('#gc-password')?.value;
          if (password) data.password = password;
          const sshKey = content.querySelector('#gc-ssh-key')?.value;
          if (sshKey) data.ssh_private_key = sshKey;
          return data;
        },
      });

      if (result) {
        await Api.updateGitCredential(id, result);
        Toast.success(i18n.t('pages.settings.credentialUpdated'));
        await this._renderTab();
      }
    } catch (err) { Toast.error(err.message); }
  },

  async _deleteGitCredential(id, usageCount) {
    if (usageCount > 0) {
      Toast.error(i18n.t('pages.settings.credentialInUse', { count: usageCount }));
      return;
    }
    const ok = await Modal.confirm(i18n.t('pages.settings.deleteCredentialConfirm'), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try {
      await Api.deleteGitCredential(id);
      Toast.success(i18n.t('pages.settings.credentialDeleted'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _renderWorkflows(el) {
    try {
      const [rules, templates] = await Promise.all([
        Api.getWorkflows(),
        Api.getWorkflowTemplates(),
      ]);

      const triggerIcons = {
        cpu_high: 'fa-microchip', mem_high: 'fa-memory', container_exit: 'fa-skull',
        container_unhealthy: 'fa-heartbeat', container_restart_loop: 'fa-redo',
        image_vulnerable: 'fa-shield-alt',
      };

      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-cogs" style="margin-right:8px"></i>${i18n.t('pages.settings.workflowsTitle')}</h3>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm btn-secondary" id="wf-templates"><i class="fas fa-magic"></i> ${i18n.t('pages.settings.fromTemplate')}</button>
              <button class="btn btn-sm btn-primary" id="wf-create"><i class="fas fa-plus"></i> ${i18n.t('pages.settings.newRule')}</button>
            </div>
          </div>
          <div class="card-body" style="padding:0">
            ${rules.length === 0 ? '<div class="empty-msg">' + i18n.t('pages.settings.noWorkflows') + '</div>' : `
            <table class="data-table">
              <thead><tr><th style="text-align:left">Name</th><th>Trigger</th><th>Action</th><th>Target</th><th>Fired</th><th>Status</th><th></th></tr></thead>
              <tbody>${rules.map(r => `
                <tr>
                  <td style="text-align:left"><strong>${Utils.escapeHtml(r.name)}</strong>${r.description ? `<div class="text-sm text-muted">${Utils.escapeHtml(r.description)}</div>` : ''}</td>
                  <td><i class="fas ${triggerIcons[r.trigger_type] || 'fa-bolt'}" style="margin-right:4px;color:var(--accent)"></i><span class="badge badge-info" style="font-size:10px">${r.trigger_type}</span></td>
                  <td><span class="badge" style="font-size:10px">${r.action_type}</span></td>
                  <td class="mono text-sm">${r.target === '*' ? 'All' : Utils.escapeHtml(r.target)}</td>
                  <td>${r.trigger_count}x</td>
                  <td>${r.is_active ? '<span class="text-green">Active</span>' : '<span class="text-muted">Disabled</span>'}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn" data-action="toggle-wf" data-id="${r.id}" data-active="${r.is_active}" title="${r.is_active ? 'Disable' : 'Enable'}"><i class="fas fa-${r.is_active ? 'pause' : 'play'}"></i></button>
                      <button class="action-btn danger" data-action="delete-wf" data-id="${r.id}" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

      // Templates button
      el.querySelector('#wf-templates')?.addEventListener('click', async () => {
        const html = templates.map(t => `
          <div class="card" style="margin-bottom:8px;cursor:pointer" data-tpl='${JSON.stringify(t).replace(/'/g, "&#39;")}'>
            <div class="card-body" style="padding:12px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <strong>${Utils.escapeHtml(t.name)}</strong>
                <div class="text-sm text-muted">${Utils.escapeHtml(t.description)}</div>
              </div>
              <button class="btn btn-sm btn-primary">Use</button>
            </div>
          </div>
        `).join('');

        Modal.open(`
          <div class="modal-header"><h3>${i18n.t('pages.settings.workflowTemplatesTitle')}</h3><button class="modal-close-btn" id="wf-tpl-close-x"><i class="fas fa-times"></i></button></div>
          <div class="modal-body">${html}</div>
        `, { width: '500px' });

        Modal._content.querySelector('#wf-tpl-close-x').addEventListener('click', () => Modal.close());

        Modal._content.querySelectorAll('[data-tpl]').forEach(card => {
          card.querySelector('.btn')?.addEventListener('click', async () => {
            const tpl = JSON.parse(card.dataset.tpl);
            try {
              await Api.createWorkflow({ ...tpl, target: '*' });
              Toast.success(i18n.t('pages.settings.workflowCreated'));
              Modal.close();
              this._renderTab();
            } catch (err) { Toast.error(err.message); }
          });
        });
      });

      // Create custom rule
      el.querySelector('#wf-create')?.addEventListener('click', async () => {
        const result = await Modal.form(`
          <div class="form-group"><label>Name *</label><input type="text" id="wf-name" class="form-control" required></div>
          <div class="form-group"><label>Description</label><input type="text" id="wf-desc" class="form-control"></div>
          <div class="form-group"><label>Trigger</label>
            <select id="wf-trigger" class="form-control">
              <option value="cpu_high">CPU High (&gt; threshold %)</option>
              <option value="mem_high">Memory High (&gt; threshold %)</option>
              <option value="container_exit">Container Crash (non-zero exit)</option>
              <option value="container_unhealthy">Health Check Failed</option>
              <option value="container_restart_loop">Restart Loop (&gt; N restarts)</option>
            </select>
          </div>
          <div class="form-group"><label>Action</label>
            <select id="wf-action" class="form-control">
              <option value="notify">Notify (all channels)</option>
              <option value="restart">Restart Container</option>
              <option value="stop">Stop Container</option>
            </select>
          </div>
          <div class="form-group"><label>Target Container</label><input type="text" id="wf-target" class="form-control" value="*" placeholder="* = all, or container name"></div>
          <div class="form-group"><label>Cooldown (seconds)</label><input type="number" id="wf-cooldown" class="form-control" value="300" min="60"></div>
        `, {
          title: i18n.t('pages.settings.newWorkflowTitle'), width: '480px',
          onSubmit: (c) => ({
            name: c.querySelector('#wf-name').value.trim(),
            description: c.querySelector('#wf-desc').value.trim(),
            trigger_type: c.querySelector('#wf-trigger').value,
            action_type: c.querySelector('#wf-action').value,
            target: c.querySelector('#wf-target').value.trim() || '*',
            cooldown_seconds: parseInt(c.querySelector('#wf-cooldown').value) || 300,
            trigger_config: {},
            action_config: {},
          }),
        });
        if (result && result.name) {
          try {
            await Api.createWorkflow(result);
            Toast.success(i18n.t('pages.settings.workflowCreated'));
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });

      // Toggle + delete
      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id);
        if (btn.dataset.action === 'toggle-wf') {
          await Api.updateWorkflow(id, { is_active: btn.dataset.active !== '1' });
          Toast.success(i18n.t('pages.settings.workflowUpdated'));
          this._renderTab();
        } else if (btn.dataset.action === 'delete-wf') {
          const ok = await Modal.confirm(i18n.t('pages.settings.deleteWorkflowConfirm'), { danger: true });
          if (!ok) return;
          await Api.deleteWorkflow(id);
          Toast.success(i18n.t('pages.settings.workflowDeleted'));
          this._renderTab();
        }
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Secrets Vault Tab ───────────────────────────────────
  async _renderSecrets(el) {
    try {
      const secrets = await Api.get('/secrets');
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-key" style="margin-right:8px"></i>Secrets Vault</h3>
            <button class="btn btn-sm btn-primary" id="secret-create"><i class="fas fa-plus"></i> Add Secret</button>
          </div>
          <div class="card-body">
            <p class="text-muted mb-md">Centralized encrypted secrets store. Values are encrypted at rest with AES-256-GCM.</p>
            ${secrets.length === 0
              ? '<div class="empty-msg">No secrets yet. Click "Add Secret" to create one.</div>'
              : `<table class="data-table">
                <thead><tr><th>Name</th><th>Description</th><th>Created</th><th>Actions</th></tr></thead>
                <tbody>${secrets.map(s => `
                  <tr>
                    <td class="mono">${Utils.escapeHtml(s.name)}</td>
                    <td class="text-sm">${s.description ? Utils.escapeHtml(s.description) : '<span class="text-muted">-</span>'}</td>
                    <td class="text-sm">${Utils.timeAgo(s.created_at)}</td>
                    <td>
                      <div class="action-btns">
                        <button class="action-btn" data-action="copy-secret" data-id="${s.id}" title="Copy value"><i class="fas fa-copy"></i></button>
                        <button class="action-btn" data-action="edit-secret" data-id="${s.id}" data-name="${Utils.escapeHtml(s.name)}" data-desc="${Utils.escapeHtml(s.description || '')}" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="action-btn danger" data-action="delete-secret" data-id="${s.id}" data-name="${Utils.escapeHtml(s.name)}" title="Delete"><i class="fas fa-trash"></i></button>
                      </div>
                    </td>
                  </tr>
                `).join('')}</tbody>
              </table>`}
          </div>
        </div>
      `;

      el.querySelector('#secret-create').addEventListener('click', async () => {
        const result = await Modal.form({
          title: 'Add Secret',
          fields: `
            <div class="form-group"><label>Name</label><input type="text" id="sec-name" class="form-control" placeholder="MY_SECRET_KEY" pattern="[a-zA-Z0-9_-]+" required></div>
            <div class="form-group"><label>Value</label><textarea id="sec-value" class="form-control" rows="3" required></textarea></div>
            <div class="form-group"><label>Description (optional)</label><input type="text" id="sec-desc" class="form-control" placeholder="What is this secret for?"></div>
          `,
          onSubmit: (c) => ({
            name: c.querySelector('#sec-name').value.trim(),
            value: c.querySelector('#sec-value').value,
            description: c.querySelector('#sec-desc').value.trim(),
          }),
        });
        if (result && result.name) {
          try {
            await Api.post('/secrets', result);
            Toast.success('Secret created');
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });

      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id);

        if (btn.dataset.action === 'copy-secret') {
          try {
            const secret = await Api.get('/secrets/' + id);
            await navigator.clipboard.writeText(secret.value);
            Toast.success('Secret value copied to clipboard');
          } catch (err) { Toast.error(err.message); }
        } else if (btn.dataset.action === 'edit-secret') {
          const result = await Modal.form({
            title: 'Edit Secret',
            fields: `
              <div class="form-group"><label>Name</label><input type="text" id="sec-name" class="form-control" value="${btn.dataset.name}" pattern="[a-zA-Z0-9_-]+" required></div>
              <div class="form-group"><label>New Value (leave empty to keep current)</label><textarea id="sec-value" class="form-control" rows="3"></textarea></div>
              <div class="form-group"><label>Description</label><input type="text" id="sec-desc" class="form-control" value="${btn.dataset.desc}"></div>
            `,
            onSubmit: (c) => {
              const data = { name: c.querySelector('#sec-name').value.trim(), description: c.querySelector('#sec-desc').value.trim() };
              const val = c.querySelector('#sec-value').value;
              if (val) data.value = val;
              return data;
            },
          });
          if (result && result.name) {
            try {
              await Api.put('/secrets/' + id, result);
              Toast.success('Secret updated');
              this._renderTab();
            } catch (err) { Toast.error(err.message); }
          }
        } else if (btn.dataset.action === 'delete-secret') {
          const ok = await Modal.confirm('Delete secret "' + btn.dataset.name + '"? This cannot be undone.', { danger: true });
          if (!ok) return;
          try {
            await Api.delete('/secrets/' + id);
            Toast.success('Secret deleted');
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });
    } catch (err) {
      el.innerHTML = '<div class="empty-msg">Error: ' + err.message + '</div>';
    }
  },

  // ─── Log Forwarding Tab ─────────────────────────────────
  async _renderLogForwarding(el) {
    try {
      const forwarders = await Api.get('/log-forwarders');
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-share-alt" style="margin-right:8px"></i>Log Forwarding</h3>
            <button class="btn btn-sm btn-primary" id="lf-create"><i class="fas fa-plus"></i> Add Forwarder</button>
          </div>
          <div class="card-body">
            <p class="text-muted mb-md">Forward container logs to external systems: Grafana Loki, Elasticsearch, HTTP webhooks, or Syslog.</p>
            ${forwarders.length === 0
              ? '<div class="empty-msg">No log forwarders configured.</div>'
              : `<table class="data-table">
                <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
                <tbody>${forwarders.map(f => `
                  <tr>
                    <td class="mono">${Utils.escapeHtml(f.name)}</td>
                    <td><span class="badge badge-info">${f.type}</span></td>
                    <td>${f.enabled ? '<span class="text-green">Enabled</span>' : '<span class="text-muted">Disabled</span>'}</td>
                    <td class="text-sm">${Utils.timeAgo(f.created_at)}</td>
                    <td>
                      <div class="action-btns">
                        <button class="action-btn" data-action="toggle-lf" data-id="${f.id}" data-enabled="${f.enabled}" title="${f.enabled ? 'Disable' : 'Enable'}"><i class="fas fa-${f.enabled ? 'pause' : 'play'}"></i></button>
                        <button class="action-btn" data-action="test-lf" data-id="${f.id}" title="Test"><i class="fas fa-vial"></i></button>
                        <button class="action-btn" data-action="edit-lf" data-id="${f.id}" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="action-btn danger" data-action="delete-lf" data-id="${f.id}" data-name="${Utils.escapeHtml(f.name)}" title="Delete"><i class="fas fa-trash"></i></button>
                      </div>
                    </td>
                  </tr>
                `).join('')}</tbody>
              </table>`}
          </div>
        </div>
      `;

      el.querySelector('#lf-create').addEventListener('click', async () => {
        const result = await Modal.form({
          title: 'Add Log Forwarder',
          fields: `
            <div class="form-group"><label>Name</label><input type="text" id="lf-name" class="form-control" required></div>
            <div class="form-group"><label>Type</label>
              <select id="lf-type" class="form-control">
                <option value="loki">Grafana Loki</option>
                <option value="elasticsearch">Elasticsearch</option>
                <option value="http">HTTP Webhook</option>
                <option value="syslog">Syslog</option>
              </select>
            </div>
            <div id="lf-config-fields">
              <div class="form-group"><label>URL</label><input type="url" id="lf-url" class="form-control" placeholder="http://loki:3100" required></div>
            </div>
            <div class="form-group"><label>Custom Headers (JSON, optional)</label><input type="text" id="lf-headers" class="form-control" placeholder='{"X-Token": "abc"}'></div>
          `,
          onSubmit: (c) => {
            const type = c.querySelector('#lf-type').value;
            const cfg = {};
            if (type === 'syslog') {
              cfg.host = c.querySelector('#lf-url').value.trim();
              cfg.port = parseInt(c.querySelector('#lf-headers').value) || 514;
              cfg.protocol = 'udp';
            } else {
              cfg.url = c.querySelector('#lf-url').value.trim();
              try { cfg.headers = JSON.parse(c.querySelector('#lf-headers').value || '{}'); } catch { cfg.headers = {}; }
              if (type === 'elasticsearch') cfg.index = 'docker-dash-logs';
            }
            return { name: c.querySelector('#lf-name').value.trim(), type, config: cfg };
          },
        });
        if (result && result.name) {
          try {
            await Api.post('/log-forwarders', result);
            Toast.success('Log forwarder created');
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });

      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id);

        if (btn.dataset.action === 'toggle-lf') {
          try {
            await Api.put('/log-forwarders/' + id, { enabled: btn.dataset.enabled !== '1' });
            Toast.success('Forwarder updated');
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        } else if (btn.dataset.action === 'test-lf') {
          try {
            Toast.info('Sending test log...');
            const result = await Api.post('/log-forwarders/' + id + '/test');
            Toast.success(result.message || 'Test successful');
          } catch (err) { Toast.error('Test failed: ' + err.message); }
        } else if (btn.dataset.action === 'edit-lf') {
          try {
            const fw = await Api.get('/log-forwarders/' + id);
            const isSyslog = fw.type === 'syslog';
            const result = await Modal.form({
              title: 'Edit Log Forwarder',
              fields: `
                <div class="form-group"><label>Name</label><input type="text" id="lf-name" class="form-control" value="${Utils.escapeHtml(fw.name)}" required></div>
                <div class="form-group"><label>Type</label><input type="text" class="form-control" value="${fw.type}" disabled></div>
                <div class="form-group"><label>${isSyslog ? 'Host' : 'URL'}</label><input type="text" id="lf-url" class="form-control" value="${Utils.escapeHtml(isSyslog ? (fw.config.host || '') : (fw.config.url || ''))}" required></div>
                <div class="form-group"><label>${isSyslog ? 'Port' : 'Headers (JSON)'}</label><input type="text" id="lf-extra" class="form-control" value="${Utils.escapeHtml(isSyslog ? String(fw.config.port || 514) : JSON.stringify(fw.config.headers || {}))}"></div>
              `,
              onSubmit: (c) => {
                const cfg = {};
                if (isSyslog) {
                  cfg.host = c.querySelector('#lf-url').value.trim();
                  cfg.port = parseInt(c.querySelector('#lf-extra').value) || 514;
                  cfg.protocol = fw.config.protocol || 'udp';
                } else {
                  cfg.url = c.querySelector('#lf-url').value.trim();
                  try { cfg.headers = JSON.parse(c.querySelector('#lf-extra').value || '{}'); } catch { cfg.headers = {}; }
                  if (fw.type === 'elasticsearch') cfg.index = fw.config.index || 'docker-dash-logs';
                }
                return { name: c.querySelector('#lf-name').value.trim(), config: cfg };
              },
            });
            if (result && result.name) {
              await Api.put('/log-forwarders/' + id, result);
              Toast.success('Forwarder updated');
              this._renderTab();
            }
          } catch (err) { Toast.error(err.message); }
        } else if (btn.dataset.action === 'delete-lf') {
          const ok = await Modal.confirm('Delete forwarder "' + btn.dataset.name + '"?', { danger: true });
          if (!ok) return;
          try {
            await Api.delete('/log-forwarders/' + id);
            Toast.success('Forwarder deleted');
            this._renderTab();
          } catch (err) { Toast.error(err.message); }
        }
      });
    } catch (err) {
      el.innerHTML = '<div class="empty-msg">Error: ' + err.message + '</div>';
    }
  },

  async _renderGeneral(el) {
    el.innerHTML = `
      <div class="card" style="max-width:600px">
        <div class="card-header"><h3>${i18n.t('pages.settings.generalSettings')}</h3></div>
        <div class="card-body">
          <p class="text-muted">${i18n.t('pages.settings.generalDesc')} ${i18n.t('pages.settings.currentEnv')}: <strong>${location.hostname.includes('dev') ? 'DEV' : location.hostname.includes('staging') ? 'STAGING' : 'PRODUCTION'}</strong></p>
          <hr class="divider">
          <table class="info-table">
            <tr><td>${i18n.t('pages.settings.appVersion')}</td><td><a href="#/whatsnew" style="color:var(--accent);text-decoration:none" id="settings-version">...</a></td></tr>
            <tr><td>${i18n.t('pages.settings.webSocket')}</td><td>${WS.isConnected ? `<span class="text-green">${i18n.t('pages.settings.wsConnected')}</span>` : `<span class="text-red">${i18n.t('pages.settings.wsDisconnected')}</span>`}</td></tr>
          </table>
        </div>
      </div>
    `;

    // Fetch version dynamically
    Api.get('/health').then(h => {
      const vEl = el.querySelector('#settings-version');
      if (vEl && h.version) vEl.innerHTML = `v${h.version} <i class="fas fa-bullhorn" style="font-size:10px"></i>`;
    }).catch(() => {});
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.settings.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.settings.help.intro')}</p>

        <h4><i class="fas fa-user"></i> ${i18n.t('pages.settings.help.profileTitle')}</h4>
        <p>${i18n.t('pages.settings.help.profileBody')}</p>

        <h4><i class="fas fa-users"></i> ${i18n.t('pages.settings.help.usersTitle')}</h4>
        <p>${i18n.t('pages.settings.help.usersBody')}</p>

        <h4><i class="fas fa-bell"></i> ${i18n.t('pages.settings.help.webhooksTitle')}</h4>
        <p>${i18n.t('pages.settings.help.webhooksBody')}</p>

        <h4><i class="fas fa-sliders-h"></i> ${i18n.t('pages.settings.help.generalTitle')}</h4>
        <p>${i18n.t('pages.settings.help.generalBody')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.settings.help.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '620px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  async _renderLdap(el) {
    let cfg = {};
    try { cfg = await Api.getLdapConfig(); } catch { cfg = { configured: false }; }

    const v = (field, fallback = '') => Utils.escapeHtml(String(cfg[field] ?? fallback));

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-sitemap" style="margin-right:8px;color:var(--accent)"></i>LDAP / Active Directory</h3>
          <span class="badge" style="font-size:11px;background:${cfg.enabled ? 'var(--green)' : 'var(--surface2)'};color:${cfg.enabled ? '#000' : 'var(--text-dim)'}">
            ${cfg.configured ? (cfg.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
          </span>
        </div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin-bottom:16px">
            Configure LDAP or Active Directory for SSO. Users who log in via LDAP are automatically provisioned with the default role. Local admin account is always available as fallback.
          </p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:700px">
            <div class="form-group" style="grid-column:1/2">
              <label>LDAP Host <span class="text-red">*</span></label>
              <input id="ldap-host" class="form-control" placeholder="ldap.company.com" value="${v('host')}">
            </div>
            <div class="form-group">
              <label>Port</label>
              <input id="ldap-port" type="number" class="form-control" placeholder="389" value="${v('port', '389')}">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label>Bind DN <span class="text-red">*</span></label>
              <input id="ldap-bind-dn" class="form-control" placeholder="cn=service,dc=company,dc=com" value="${v('bindDn')}">
              <small class="text-muted">Service account used to search the directory</small>
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label>Bind Password <span class="text-red">*</span></label>
              <input id="ldap-bind-pass" type="password" class="form-control" placeholder="${cfg.configured ? '(unchanged)' : 'Service account password'}" autocomplete="new-password">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label>Base DN <span class="text-red">*</span></label>
              <input id="ldap-base-dn" class="form-control" placeholder="dc=company,dc=com" value="${v('baseDn')}">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label>User Filter</label>
              <input id="ldap-user-filter" class="form-control" placeholder="(objectClass=person)" value="${v('userFilter')}">
              <small class="text-muted">LDAP filter to identify user objects. Leave blank for default.</small>
            </div>
            <div class="form-group">
              <label>UID Attribute</label>
              <input id="ldap-uid-attr" class="form-control" placeholder="uid" value="${v('uidAttr', 'uid')}">
              <small class="text-muted">uid (LDAP), sAMAccountName (AD)</small>
            </div>
            <div class="form-group">
              <label>Required Group (optional)</label>
              <input id="ldap-group" class="form-control" placeholder="cn=docker-dash,ou=groups,dc=..." value="${v('requiredGroup')}">
              <small class="text-muted">Only members of this group can log in</small>
            </div>
            <div class="form-group">
              <label>Default Role for new users</label>
              <select id="ldap-role" class="form-control">
                <option value="viewer" ${cfg.defaultRole === 'viewer' || !cfg.defaultRole ? 'selected' : ''}>Viewer</option>
                <option value="operator" ${cfg.defaultRole === 'operator' ? 'selected' : ''}>Operator</option>
                <option value="admin" ${cfg.defaultRole === 'admin' ? 'selected' : ''}>Admin</option>
              </select>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input id="ldap-tls" type="checkbox" ${cfg.tls ? 'checked' : ''}> Use LDAPS (TLS, port 636)
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px">
                <input id="ldap-skip-verify" type="checkbox" ${cfg.tlsSkipVerify ? 'checked' : ''}> Skip TLS certificate verification
              </label>
            </div>
          </div>

          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
            <button class="btn btn-secondary" id="ldap-test"><i class="fas fa-plug" style="margin-right:4px"></i>Test Connection</button>
            <button class="btn btn-primary" id="ldap-save"><i class="fas fa-save" style="margin-right:4px"></i>Save</button>
            ${cfg.configured ? `<button class="btn btn-danger" id="ldap-delete"><i class="fas fa-trash" style="margin-right:4px"></i>Remove LDAP</button>` : ''}
            ${cfg.configured ? `<button class="btn btn-secondary" id="ldap-users"><i class="fas fa-users" style="margin-right:4px"></i>Preview Directory Users</button>` : ''}
          </div>

          <div id="ldap-result" style="margin-top:14px"></div>
        </div>
      </div>
    `;

    const collect = () => ({
      host: el.querySelector('#ldap-host').value.trim(),
      port: el.querySelector('#ldap-port').value.trim(),
      bindDn: el.querySelector('#ldap-bind-dn').value.trim(),
      bindPassword: el.querySelector('#ldap-bind-pass').value,
      baseDn: el.querySelector('#ldap-base-dn').value.trim(),
      userFilter: el.querySelector('#ldap-user-filter').value.trim(),
      uidAttr: el.querySelector('#ldap-uid-attr').value.trim() || 'uid',
      requiredGroup: el.querySelector('#ldap-group').value.trim(),
      defaultRole: el.querySelector('#ldap-role').value,
      tls: el.querySelector('#ldap-tls').checked,
      tlsSkipVerify: el.querySelector('#ldap-skip-verify').checked,
      enabled: true,
    });

    const resultDiv = el.querySelector('#ldap-result');

    el.querySelector('#ldap-test')?.addEventListener('click', async () => {
      const data = collect();
      if (!data.host || !data.bindDn || !data.bindPassword || !data.baseDn) {
        resultDiv.innerHTML = `<div class="tip-box" style="color:var(--yellow)"><i class="fas fa-exclamation-triangle"></i> Fill in host, bind DN, bind password and base DN first.</div>`;
        return;
      }
      resultDiv.innerHTML = `<p class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Testing connection...</p>`;
      try {
        const res = await Api.testLdapConnection(data);
        resultDiv.innerHTML = `<div class="tip-box" style="color:var(--green)"><i class="fas fa-check-circle"></i> Connection successful — ${res.usersFound > 0 ? 'users found in directory' : 'directory reachable (no users matched filter)'}.</div>`;
      } catch (err) {
        resultDiv.innerHTML = `<div class="tip-box" style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div>`;
      }
    });

    el.querySelector('#ldap-save')?.addEventListener('click', async () => {
      const data = collect();
      if (!data.host || !data.bindDn || !data.baseDn) {
        Toast.warning('Fill in required fields (host, bind DN, base DN)');
        return;
      }
      try {
        await Api.saveLdapConfig(data);
        Toast.success('LDAP configuration saved');
        await this._renderLdap(el);
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#ldap-delete')?.addEventListener('click', async () => {
      if (!confirm('Remove LDAP configuration? Users provisioned via LDAP will keep their local accounts.')) return;
      try {
        await Api.deleteLdapConfig();
        Toast.success('LDAP configuration removed');
        await this._renderLdap(el);
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#ldap-users')?.addEventListener('click', async () => {
      resultDiv.innerHTML = `<p class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Fetching users...</p>`;
      try {
        const res = await Api.getLdapUsers();
        const rows = res.users.map(u => `
          <tr>
            <td>${Utils.escapeHtml(u.username)}</td>
            <td>${Utils.escapeHtml(u.displayName)}</td>
            <td>${Utils.escapeHtml(u.email)}</td>
            <td class="text-sm text-muted mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(u.dn)}</td>
          </tr>`).join('');
        resultDiv.innerHTML = `
          <div style="margin-top:4px;font-weight:600;margin-bottom:8px"><i class="fas fa-users" style="margin-right:6px;color:var(--accent)"></i>${res.total} users found</div>
          <div style="max-height:300px;overflow:auto">
            <table class="data-table">
              <thead><tr><th>Username</th><th>Display Name</th><th>Email</th><th>DN</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      } catch (err) {
        resultDiv.innerHTML = `<div class="tip-box" style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div>`;
      }
    });
  },

  destroy() {},
};

window.SettingsPage = SettingsPage;
