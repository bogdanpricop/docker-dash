/* ═══════════════════════════════════════════════════
   pages/profile.js — User Profile Page
   ═══════════════════════════════════════════════════ */
'use strict';

const ProfilePage = {
  _user: null,

  async render(container) {
    try {
      const me = await Api.me();
      this._user = me.user || me;
      this._user.totpEnabled = this._user.totpEnabled || me.mfaEnabled;
    } catch {
      this._user = App.user;
    }

    const u = this._user;
    const initial = (u?.username || '?')[0].toUpperCase();
    const roleBadge = u?.role === 'admin' ? 'badge-running' :
                      u?.role === 'operator' ? 'badge-warning' : 'badge-info';

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-user-circle"></i> ${i18n.t('pages.profile.title')}</h2>
      </div>

      <div class="info-grid">
        <!-- Profile Card -->
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-id-badge" style="margin-right:8px;opacity:0.6"></i>${i18n.t('pages.profile.accountInfo')}</h3></div>
          <div class="card-body" style="display:flex;gap:24px;align-items:flex-start">
            <div class="profile-avatar">${initial}</div>
            <div style="flex:1">
              <table class="info-table">
                <tr><td>${i18n.t('pages.profile.username')}</td><td><strong>${Utils.escapeHtml(u?.username || '')}</strong></td></tr>
                <tr><td>${i18n.t('pages.profile.role')}</td><td><span class="badge ${roleBadge}">${u?.role || ''}</span></td></tr>
                <tr><td>${i18n.t('pages.profile.userId')}</td><td class="mono">${u?.id || '-'}</td></tr>
              </table>
            </div>
          </div>
        </div>

        <!-- Change Password Card -->
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-key" style="margin-right:8px;opacity:0.6"></i>${i18n.t('pages.profile.changePassword')}</h3></div>
          <div class="card-body">
            <form id="profile-pw-form">
              <div class="form-group">
                <label>${i18n.t('pages.profile.currentPassword')}</label>
                <input type="password" id="profile-pw-current" required autocomplete="current-password">
              </div>
              <div class="form-group">
                <label>${i18n.t('pages.profile.newPassword')}</label>
                <input type="password" id="profile-pw-new" required minlength="8" autocomplete="new-password">
              </div>
              <div class="form-group">
                <label>${i18n.t('pages.profile.confirmPassword')}</label>
                <input type="password" id="profile-pw-confirm" required autocomplete="new-password">
              </div>
              <div id="profile-pw-error" class="login-error hidden" style="margin-bottom:12px"></div>
              <button type="submit" class="btn btn-primary">
                <i class="fas fa-save"></i> ${i18n.t('pages.profile.updatePassword')}
              </button>
            </form>
          </div>
        </div>
      </div>

      <!-- MFA / Two-Factor Authentication -->
      <div class="card" id="profile-mfa-card">
        <div class="card-header">
          <h3><i class="fas fa-shield-alt" style="margin-right:8px;color:var(--accent)"></i>Two-Factor Authentication</h3>
        </div>
        <div class="card-body">
          ${u?.totpEnabled
            ? `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
                <span class="badge badge-running"><i class="fas fa-check" style="margin-right:4px"></i>MFA Enabled</span>
                ${u?.mfaEnrolledAt ? `<span class="text-sm text-muted">since ${Utils.formatDate(u.mfaEnrolledAt)}</span>` : ''}
              </div>
              <p class="text-sm text-muted" style="margin-bottom:12px">Your account is protected with TOTP two-factor authentication.</p>
              <button class="btn btn-sm btn-danger" id="profile-mfa-disable"><i class="fas fa-unlock"></i> Disable MFA</button>`
            : `<p class="text-sm text-muted" style="margin-bottom:12px">Add an extra layer of security by enabling two-factor authentication with an authenticator app (Google Authenticator, Authy, 1Password).</p>
              <button class="btn btn-sm btn-primary" id="profile-mfa-enable"><i class="fas fa-shield-alt"></i> Enable MFA</button>`}
        </div>
      </div>

      <!-- Active Sessions Info -->
      <div class="card mt-2" style="max-width:700px">
        <div class="card-header"><h3><i class="fas fa-shield-alt" style="margin-right:8px;opacity:0.6"></i>${i18n.t('pages.profile.security')}</h3></div>
        <div class="card-body">
          <table class="info-table">
            <tr><td>${i18n.t('pages.profile.browser')}</td><td class="mono text-sm">${Utils.escapeHtml(navigator.userAgent.split(') ').pop() || navigator.userAgent)}</td></tr>
            <tr><td>${i18n.t('pages.profile.language')}</td><td>${i18n.lang === 'ro' ? 'Română' : 'English'}</td></tr>
            <tr><td>${i18n.t('pages.profile.theme')}</td><td>${document.documentElement.getAttribute('data-theme') === 'light' ? i18n.t('pages.profile.themeLight') : i18n.t('pages.profile.themeDark')}</td></tr>
          </table>
        </div>
      </div>
    `;

    // Bind password form
    const form = container.querySelector('#profile-pw-form');
    const errEl = container.querySelector('#profile-pw-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.classList.add('hidden');

      const currentPassword = document.getElementById('profile-pw-current').value;
      const newPassword = document.getElementById('profile-pw-new').value;
      const confirmPassword = document.getElementById('profile-pw-confirm').value;

      if (newPassword !== confirmPassword) {
        errEl.textContent = i18n.t('pages.profile.passwordsMismatch');
        errEl.classList.remove('hidden');
        return;
      }
      if (newPassword.length < 8) {
        errEl.textContent = i18n.t('pages.profile.passwordTooShort');
        errEl.classList.remove('hidden');
        return;
      }

      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}`;

      try {
        await Api.post('/auth/change-password', { currentPassword, newPassword });
        Toast.success(i18n.t('pages.profile.passwordChanged'));
        form.reset();
      } catch (err) {
        errEl.textContent = err.message || i18n.t('pages.profile.changeFailed');
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-save"></i> ${i18n.t('pages.profile.updatePassword')}`;
      }
    });

    // MFA enable button (profile — for own account)
    const mfaEnableBtn = container.querySelector('#profile-mfa-enable');
    if (mfaEnableBtn) {
      mfaEnableBtn.addEventListener('click', async () => {
        try {
          const setup = await Api.post('/auth/mfa/setup');
          if (setup.error) { Toast.error(setup.error); return; }

          Modal.open(`
            <div class="modal-header">
              <h3><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px"></i>Enable Two-Factor Authentication</h3>
              <button class="modal-close-btn" id="mfa-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
              <p class="text-sm text-muted" style="margin-bottom:12px">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
              <div style="text-align:center;margin:16px 0">
                <div style="background:#fff;display:inline-block;padding:16px;border-radius:8px">
                  <img id="mfa-qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setup.otpauthUri)}" alt="QR Code" width="200" height="200">
                </div>
              </div>
              <details><summary class="text-sm" style="color:var(--accent);cursor:pointer">Can't scan? Enter manually</summary>
                <div class="mono text-sm" style="margin-top:8px;padding:8px;background:var(--surface2);border-radius:4px;word-break:break-all">${Utils.escapeHtml(setup.secret)}</div>
              </details>
              <div class="form-group" style="margin-top:12px">
                <label>6-digit code</label>
                <input type="text" id="mfa-code" class="form-control" placeholder="000000" maxlength="6" inputmode="numeric" style="text-align:center;font-size:20px;letter-spacing:6px;max-width:200px;margin:0 auto;display:block">
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" id="mfa-cancel">${i18n.t('common.cancel')}</button>
              <button class="btn btn-primary" id="mfa-verify"><i class="fas fa-check"></i> Verify & Enable</button>
            </div>
          `, { width: '480px' });

          Modal._content.querySelector('#mfa-close').addEventListener('click', () => Modal.close());
          Modal._content.querySelector('#mfa-cancel').addEventListener('click', () => Modal.close());
          Modal._content.querySelector('#mfa-verify').addEventListener('click', async () => {
            const code = Modal._content.querySelector('#mfa-code').value.trim();
            if (!code || code.length !== 6) { Toast.error('Enter 6-digit code'); return; }
            try {
              const result = await Api.post('/auth/mfa/enable', { code });
              if (result.error) { Toast.error(result.error); return; }
              Modal._content.querySelector('.modal-body').innerHTML = `
                <div style="text-align:center;margin-bottom:16px">
                  <i class="fas fa-check-circle" style="font-size:48px;color:var(--green)"></i>
                  <h3 style="margin:12px 0 4px">MFA Enabled!</h3>
                  <p class="text-sm text-muted">Save these recovery codes:</p>
                </div>
                <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:16px;font-family:var(--mono);font-size:14px;line-height:2;text-align:center">
                  ${result.recoveryCodes.map(c => `<div>${Utils.escapeHtml(c)}</div>`).join('')}
                </div>`;
              Modal._content.querySelector('.modal-footer').innerHTML = `<button class="btn btn-primary" id="mfa-done">${i18n.t('common.close')}</button>`;
              Modal._content.querySelector('#mfa-done').addEventListener('click', () => { Modal.close(); App.navigate('/profile'); });
            } catch (err) { Toast.error(err.message); }
          });
        } catch (err) { Toast.error(err.message); }
      });
    }

    // MFA disable button (profile — own account, requires password)
    const mfaDisableBtn = container.querySelector('#profile-mfa-disable');
    if (mfaDisableBtn) {
      mfaDisableBtn.addEventListener('click', async () => {
        const result = await Modal.form(`
          <div class="form-group">
            <label>Enter your password to disable MFA</label>
            <input type="password" id="mfa-dis-pass" class="form-control" required>
          </div>
        `, { title: 'Disable MFA', width: '400px', onSubmit: c => c.querySelector('#mfa-dis-pass').value || false });
        if (!result) return;
        try {
          await Api.post('/auth/mfa/disable', { password: result });
          Toast.success('MFA disabled');
          App.navigate('/profile');
        } catch (err) { Toast.error(err.message); }
      });
    }
  },

  destroy() {},
};

window.ProfilePage = ProfilePage;
