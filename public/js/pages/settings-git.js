/* ═══════════════════════════════════════════════════
   pages/settings-git.js — Settings Git tab
   Extracted from settings.js v8.2.x further-split.
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPageGit = {
  _gitKnownHostsField(value = '') {
    return `<div class="form-group">
      <label>${i18n.t('pages.settings.gitKnownHostsLabel')} *</label>
      <textarea id="gc-known-hosts" class="form-control" rows="4" spellcheck="false">${Utils.escapeHtml(value)}</textarea>
      <small class="text-muted">${i18n.t('pages.settings.gitKnownHostsHint')}</small>
    </div>`;
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
        ${this._gitKnownHostsField()}
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
          data.ssh_known_hosts = content.querySelector('#gc-known-hosts').value.trim();
          if (!data.ssh_known_hosts) { Toast.warning(i18n.t('pages.settings.gitKnownHostsRequired')); return false; }
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
          ${this._gitKnownHostsField(cred.ssh_known_hosts || '')}
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
          if (cred.auth_type === 'ssh_key') {
            data.ssh_known_hosts = content.querySelector('#gc-known-hosts').value.trim();
            if (!data.ssh_known_hosts) { Toast.warning(i18n.t('pages.settings.gitKnownHostsRequired')); return false; }
          }
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

};

if (typeof window !== 'undefined') window.SettingsPageGit = SettingsPageGit;
