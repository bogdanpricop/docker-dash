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
                <input type="password" id="profile-pw-new" required minlength="6" autocomplete="new-password">
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
      if (newPassword.length < 6) {
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
  },

  destroy() {},
};

window.ProfilePage = ProfilePage;
