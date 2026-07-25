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
        ${isAdmin ? `<button class="tab" data-tab="access"><i class="fas fa-user-shield" style="margin-right:4px"></i> ${i18n.t('pages.settings.access.tab')}</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="webhooks">${i18n.t('pages.settings.tabWebhooks')}</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="registries">${i18n.t('pages.settings.registriesTitle')}</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="git-credentials"><i class="fab fa-git-alt" style="margin-right:4px"></i> Git</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="notifications"><i class="fas fa-bell" style="margin-right:4px"></i> Notifications</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="workflows"><i class="fas fa-cogs" style="margin-right:4px"></i> Workflows</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="secrets"><i class="fas fa-key" style="margin-right:4px"></i> Secrets</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="log-forwarding"><i class="fas fa-share-alt" style="margin-right:4px"></i> Log Forwarding</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="ldap"><i class="fas fa-sitemap" style="margin-right:4px"></i> LDAP / AD</button>` : ''}
        ${isAdmin ? `<button class="tab" data-tab="ai"><i class="fas fa-robot" style="margin-right:4px"></i> AI</button>` : ''}
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
      else if (this._tab === 'access') await this._renderAccess(el);
      else if (this._tab === 'webhooks') await this._renderWebhooks(el);
      else if (this._tab === 'registries') await this._renderRegistries(el);
      else if (this._tab === 'git-credentials') await this._renderGitCredentials(el);
      else if (this._tab === 'notifications') await this._renderNotificationChannels(el);
      else if (this._tab === 'workflows') await this._renderWorkflows(el);
      else if (this._tab === 'secrets') await this._renderSecrets(el);
      else if (this._tab === 'log-forwarding') await this._renderLogForwarding(el);
      else if (this._tab === 'ldap') await this._renderLdap(el);
      else if (this._tab === 'ai') await this._renderAiSettings(el);
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

  // Users tab moved to public/js/pages/settings-users.js.
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

  // Registries tab moved to public/js/pages/settings-registries.js.
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

  // Git Credentials tab moved to public/js/pages/settings-git.js.
  // Workflows tab moved to public/js/pages/settings-workflows.js.
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
  // Log Forwarding tab moved to public/js/pages/settings-logforwarding.js.
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

      <div class="card" style="max-width:600px;margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-arrow-up" style="color:var(--accent);margin-right:8px"></i>${i18n.t('updates.settingTitle')}</h3></div>
        <div class="card-body">
          <p class="text-muted text-sm" style="margin-bottom:14px">${i18n.t('updates.settingDesc')}</p>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:14px">
            <input type="checkbox" id="upd-enabled">
            <span>${i18n.t('updates.settingEnabled')}</span>
          </label>
          <div id="upd-status-row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-dim)">
            <span id="upd-status-text">…</span>
            <button class="btn btn-sm" id="upd-check-now"><i class="fas fa-sync"></i> ${i18n.t('updates.checkNow')}</button>
          </div>
        </div>
      </div>
    `;

    // Fetch version dynamically
    Api.get('/health').then(h => {
      const vEl = el.querySelector('#settings-version');
      if (vEl && h.version) vEl.innerHTML = `v${h.version} <i class="fas fa-bullhorn" style="font-size:10px"></i>`;
    }).catch(() => {});

    // Update-check section (v7.3.0)
    const renderUpdStatus = (status) => {
      const text = el.querySelector('#upd-status-text');
      if (!text || !status) return;
      const last = status.lastChecked
        ? new Date(status.lastChecked).toLocaleString()
        : i18n.t('updates.never');
      if (status.hasUpdate) {
        text.innerHTML = `<a href="#" id="upd-open-modal" style="color:var(--accent)"><i class="fas fa-arrow-up"></i> ${i18n.t('updates.modalTitle')}: ${Utils.escapeHtml(status.latest)}</a> · ${i18n.t('updates.lastChecked')}: ${Utils.escapeHtml(last)}`;
        text.querySelector('#upd-open-modal')?.addEventListener('click', (e) => {
          e.preventDefault();
          window.UpdateNotifier?.openModal();
        });
      } else if (status.enabled) {
        text.innerHTML = `<i class="fas fa-check" style="color:var(--green)"></i> ${i18n.t('updates.upToDate')} · ${i18n.t('updates.lastChecked')}: ${Utils.escapeHtml(last)}`;
      } else {
        text.innerHTML = `<i class="fas fa-pause" style="color:var(--text-dim)"></i> ${i18n.t('common.disabled')}`;
      }
    };

    try {
      const status = await Api.get('/system/update-check');
      el.querySelector('#upd-enabled').checked = !!status.enabled;
      renderUpdStatus(status);
    } catch { /* anonymous-only? unlikely on a settings page */ }

    el.querySelector('#upd-enabled').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      try {
        await window.UpdateNotifier.setEnabled(enabled);
        Toast.success(enabled ? i18n.t('common.enabled') : i18n.t('common.disabled'));
        const status = await Api.get('/system/update-check');
        renderUpdStatus(status);
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#upd-check-now').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('updates.checking')}`;
      try {
        const result = await window.UpdateNotifier.forceRefresh();
        renderUpdStatus(result.status);
        Toast.success(i18n.t('updates.refreshed'));
      } catch (err) {
        Toast.error(`${i18n.t('updates.checkFailed')}: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });
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

  // LDAP/AD tab moved to public/js/pages/settings-ldap.js (v8.2.x further-split).
  // AI Settings tab moved to public/js/pages/settings-ai.js (v8.2.x further-split).

  destroy() {},
};

// v8.2.x further-split: merge 7 extracted tab modules. settings.js dropped
// from 2037 → 572 LOC. Order alphabetical for readability.
if (typeof SettingsPageAccess !== 'undefined') Object.assign(SettingsPage, SettingsPageAccess);
if (typeof SettingsPageAi !== 'undefined') Object.assign(SettingsPage, SettingsPageAi);
if (typeof SettingsPageGit !== 'undefined') Object.assign(SettingsPage, SettingsPageGit);
if (typeof SettingsPageLdap !== 'undefined') Object.assign(SettingsPage, SettingsPageLdap);
if (typeof SettingsPageLogforwarding !== 'undefined') Object.assign(SettingsPage, SettingsPageLogforwarding);
if (typeof SettingsPageRegistries !== 'undefined') Object.assign(SettingsPage, SettingsPageRegistries);
if (typeof SettingsPageUsers !== 'undefined') Object.assign(SettingsPage, SettingsPageUsers);
if (typeof SettingsPageWorkflows !== 'undefined') Object.assign(SettingsPage, SettingsPageWorkflows);

window.SettingsPage = SettingsPage;
