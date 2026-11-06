/* ═══════════════════════════════════════════════════
   pages/settings-users.js — Settings Users tab
   Extracted from settings.js v8.2.x further-split.
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPageUsers = {
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
                <td class="mono">${Utils.escapeHtml(u.username)} <span class="badge badge-info">${({ local: 'Local', oidc: 'OIDC', proxy: 'Proxy SSO', ldap: 'LDAP', scim: 'SCIM', sso_legacy: 'SSO (legacy)' })[u.auth_source] || '—'}</span></td>
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
                    ${u.auth_source === 'local' ? `<button class="action-btn" data-action="reset-password" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Reset Password"><i class="fas fa-key"></i></button>` : ''}
                    ${!u.totp_enabled
                      ? `<button class="action-btn" data-action="setup-mfa" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Enable MFA"><i class="fas fa-shield-alt"></i></button>`
                      : `<button class="action-btn danger" data-action="disable-mfa" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="Disable MFA"><i class="fas fa-unlock"></i></button>`}
                    ${u.email && u.auth_source === 'local' ? `<button class="action-btn" data-action="send-invite" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="${i18n.t('pages.settings.sendInvite')}"><i class="fas fa-envelope"></i></button>` : ''}
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

};

if (typeof window !== 'undefined') window.SettingsPageUsers = SettingsPageUsers;
