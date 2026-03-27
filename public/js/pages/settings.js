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
        ${isAdmin ? `<button class="tab" data-tab="registries">Registries</button>` : ''}
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
            <thead><tr><th>${i18n.t('pages.settings.username')}</th><th>Email</th><th>${i18n.t('pages.settings.role')}</th><th>${i18n.t('common.status')}</th><th>${i18n.t('pages.settings.lastLogin')}</th><th>${i18n.t('common.actions')}</th></tr></thead>
            <tbody>${items.map(u => `
              <tr>
                <td class="mono">${Utils.escapeHtml(u.username)}</td>
                <td class="text-sm">${u.email ? Utils.escapeHtml(u.email) : '<span class="text-muted">—</span>'}</td>
                <td><span class="badge badge-info">${u.role}</span></td>
                <td>${u.is_active ? `<span class="text-green">${i18n.t('common.active')}</span>` : `<span class="text-muted">${i18n.t('common.inactive')}</span>`}</td>
                <td>${u.last_login_at ? Utils.timeAgo(u.last_login_at) : '—'}</td>
                <td>
                  <div class="action-btns">
                    <button class="action-btn" data-action="edit-user" data-id="${u.id}" title="${i18n.t('common.edit')}"><i class="fas fa-edit"></i></button>
                    ${u.email ? `<button class="action-btn" data-action="send-reset" data-id="${u.id}" data-username="${Utils.escapeHtml(u.username)}" title="${i18n.t('pages.settings.sendReset')}"><i class="fas fa-key"></i></button>` : ''}
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
      else if (action === 'send-reset') this._sendResetEmail(id, username);
      else if (action === 'send-invite') this._sendInviteEmail(id, username);
      else if (action === 'delete-user') this._deleteUser(id);
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
            <h3><i class="fas fa-warehouse" style="margin-right:8px"></i>Docker Registries</h3>
            <button class="btn btn-sm btn-primary" id="add-registry"><i class="fas fa-plus"></i> Add Registry</button>
          </div>
          <div class="card-body" style="padding:0">
            ${registries.length === 0 ? '<div class="empty-msg">No registries configured. Only Docker Hub (public) is available.</div>' : `
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
                      <button class="action-btn" onclick="SettingsPage._testRegistry(${r.id})" title="Test"><i class="fas fa-plug"></i></button>
                      <button class="action-btn" onclick="SettingsPage._editRegistry(${r.id})" title="Edit"><i class="fas fa-edit"></i></button>
                      <button class="action-btn danger" onclick="SettingsPage._deleteRegistry(${r.id})" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

      el.querySelector('#add-registry')?.addEventListener('click', () => this._addRegistryDialog());
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
      title: 'Add Docker Registry',
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
        Toast.success('Registry added');
        this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _testRegistry(id) {
    Toast.info('Testing connection...');
    try {
      const result = await Api.testRegistry(id);
      if (result.ok) Toast.success('Connection successful');
      else Toast.error('Connection failed: ' + (result.error || 'Unknown error'));
    } catch (err) { Toast.error(err.message); }
  },

  async _editRegistry(id) {
    Toast.info('Edit functionality coming soon');
  },

  async _deleteRegistry(id) {
    const ok = await Modal.confirm('Delete this registry?', { danger: true });
    if (!ok) return;
    try {
      await Api.deleteRegistry(id);
      Toast.success('Registry deleted');
      this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _renderGeneral(el) {
    el.innerHTML = `
      <div class="card" style="max-width:600px">
        <div class="card-header"><h3>${i18n.t('pages.settings.generalSettings')}</h3></div>
        <div class="card-body">
          <p class="text-muted">${i18n.t('pages.settings.generalDesc')} ${i18n.t('pages.settings.currentEnv')}: <strong>${location.hostname.includes('dev') ? 'DEV' : location.hostname.includes('staging') ? 'STAGING' : 'PRODUCTION'}</strong></p>
          <hr class="divider">
          <table class="info-table">
            <tr><td>${i18n.t('pages.settings.appVersion')}</td><td><a href="#/whatsnew" style="color:var(--accent);text-decoration:none">v2.1.0 <i class="fas fa-bullhorn" style="font-size:10px"></i></a></td></tr>
            <tr><td>${i18n.t('pages.settings.webSocket')}</td><td>${WS.isConnected ? `<span class="text-green">${i18n.t('pages.settings.wsConnected')}</span>` : `<span class="text-red">${i18n.t('pages.settings.wsDisconnected')}</span>`}</td></tr>
          </table>
        </div>
      </div>
    `;
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

  destroy() {},
};

window.SettingsPage = SettingsPage;
