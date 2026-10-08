/* ═══════════════════════════════════════════════════
   pages/settings-ldap.js — Settings Ldap tab
   Extracted from settings.js v8.2.x further-split.
   ═══════════════════════════════════════════════════ */
'use strict';

const SettingsPageLdap = {
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
              <label for="ldap-tls">${i18n.t('pages.settings.ldapTransportLabel')}</label>
              <select id="ldap-tls" class="form-control">
                <option value="starttls" ${!cfg.tls ? 'selected' : ''}>StartTLS (389)</option>
                <option value="ldaps" ${cfg.tls ? 'selected' : ''}>LDAPS (636)</option>
              </select>
              <small class="text-muted">${i18n.t('pages.settings.ldapTlsHint')}</small>
              <small><a href="#/howto/ldap-tls">${i18n.t('pages.settings.ldapTlsGuide')}</a></small>
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label for="ldap-ca">${i18n.t('pages.hosts.providerCaLabel')}</label>
              <textarea id="ldap-ca" class="form-control" rows="4" spellcheck="false" placeholder="${cfg.caCertPresent ? i18n.t('pages.settings.ldapCaUnchanged') : '-----BEGIN CERTIFICATE-----'}"></textarea>
              <label><input id="ldap-ca-clear" type="checkbox"> ${i18n.t('pages.hosts.providerCaClear')}</label>
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
      tls: el.querySelector('#ldap-tls').value === 'ldaps',
      tlsSkipVerify: false,
      caCert: el.querySelector('#ldap-ca-clear').checked ? null : el.querySelector('#ldap-ca').value.trim() || undefined,
      enabled: true,
    });

    el.querySelector('#ldap-tls').addEventListener('change', () => {
      const port = el.querySelector('#ldap-port');
      if (!port.value || ['389', '636'].includes(port.value)) port.value = el.querySelector('#ldap-tls').value === 'ldaps' ? '636' : '389';
    });
    const resultDiv = el.querySelector('#ldap-result');

    el.querySelector('#ldap-test')?.addEventListener('click', async () => {
      const data = collect();
      if (!data.host || !data.bindDn || (!data.bindPassword && !cfg.configured) || !data.baseDn) {
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

  // ─── AI Settings (v8.0.0) ──────────────────────────
  // BYOK + off-by-default. Provider abstraction (Anthropic / OpenAI / Ollama).
  // The "what gets sent" privacy panel is non-negotiable per the deep-spec.
};

if (typeof window !== 'undefined') window.SettingsPageLdap = SettingsPageLdap;
