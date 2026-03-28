/* ═══════════════════════════════════════════════════
   app.js — Main Application (Router + Auth + Boot)
   ═══════════════════════════════════════════════════ */
'use strict';

const App = {
  user: null,
  _currentPage: null,
  _currentPageName: null,

  // Page registry
  _pages: {
    dashboard:  () => DashboardPage,
    containers: () => ContainersPage,
    images:     () => ImagesPage,
    volumes:    () => VolumesPage,
    networks:   () => NetworksPage,
    alerts:     () => AlertsPage,
    security:   () => SecurityPage,
    system:     () => SystemPage,
    firewall:   () => FirewallPage,
    hosts:      () => HostsPage,
    about:      () => AboutPage,
    whatsnew:   () => WhatsNewPage,
    'git-stacks': () => GitStacksPage,
    compare:    () => ComparePage,
    insights:   () => InsightsPage,
    settings:   () => SettingsPage,
    profile:    () => ProfilePage,
  },

  async init() {
    i18n.init();
    Utils.configureChartDefaults();

    // Check if already authenticated
    try {
      const me = await Api.me();
      this.user = me.user || me;
      this._securityFlags = {
        setupRequired: me.setupRequired,
        mustChangePassword: me.mustChangePassword,
        defaultAdminActive: me.defaultAdminActive,
      };
      this._showApp();
      // Show setup wizard only if password change is required
      if (me.mustChangePassword) {
        setTimeout(() => this._showSetupWizard(), 500);
      } else if (me.defaultAdminActive) {
        setTimeout(() => this._showSecurityBanner(), 500);
      }
    } catch {
      this._showLogin();
    }
  },

  // ─── Auth ──────────────────────────────────────

  _showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-shell').classList.add('hidden');
    WS.disconnect();

    const form = document.getElementById('login-form');
    const errEl = document.getElementById('login-error');

    // Clone to remove old listeners
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);

    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.classList.add('hidden');

      const username = newForm.querySelector('#login-user').value.trim();
      const password = newForm.querySelector('#login-pass').value;
      const btn = newForm.querySelector('#login-btn');

      if (!username || !password) {
        errEl.textContent = i18n.t('login.enterCredentials');
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('login.signingIn')}`;

      try {
        const res = await Api.login(username, password);
        this.user = res.user;
        this._loginPassword = password; // Temp store for setup wizard password change
        this._securityFlags = {
          setupRequired: res.setupRequired,
          mustChangePassword: res.mustChangePassword,
          defaultAdminActive: res.defaultAdminActive,
        };
        newForm.reset();
        this._showApp();
        if (res.mustChangePassword) {
          setTimeout(() => this._showSetupWizard(), 500);
        } else if (res.defaultAdminActive) {
          setTimeout(() => this._showSecurityBanner(), 500);
        }
      } catch (err) {
        errEl.textContent = err.message || i18n.t('login.invalidCredentials');
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${i18n.t('login.signIn')}`;
      }
    });
  },

  _showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    // Update user display
    const userDisplay = document.getElementById('username-display');
    if (userDisplay) userDisplay.textContent = this.user?.username || '';

    // Make user-info clickable to navigate to profile
    const userInfo = document.getElementById('user-info');
    if (userInfo && !userInfo._bound) {
      userInfo._bound = true;
      userInfo.style.cursor = 'pointer';
      userInfo.title = i18n.t('nav.profile');
      userInfo.addEventListener('click', () => this.navigate('/profile'));
    }

    // Make version clickable → What's New
    const versionEl = document.getElementById('sidebar-version');
    if (versionEl && !versionEl._bound) {
      versionEl._bound = true;
      versionEl.style.cursor = 'pointer';
      versionEl.title = "What's New";
      versionEl.addEventListener('click', () => this.navigate('/whatsnew'));
    }

    // Restore host context
    Api.restoreHost();

    // Initialize host selector
    this._initHostSelector();

    // Connect WebSocket
    WS.connect();

    // Setup sidebar
    this._initSidebar();

    // Setup logout
    document.getElementById('logout-btn').addEventListener('click', () => this._logout());

    // Setup theme toggle
    this._initThemeToggle();

    // Setup language toggle
    this._initLangToggle();

    // Setup notifications
    this._initNotifications();

    // Update static UI labels
    this._updateStaticUI();

    // Start router
    this._initRouter();

    // Show welcome modal for first-time users (once per user)
    this._showWelcomeIfNeeded();
  },

  _showWelcomeIfNeeded() {
    const key = `dd-welcome-shown-${this.user?.id || 0}`;
    if (localStorage.getItem(key)) return;
    // Don't show if setup wizard was just completed
    if (this._securityFlags?.setupRequired || this._securityFlags?.mustChangePassword) return;

    setTimeout(() => {
      const html = `
        <div class="modal-header">
          <h3 style="margin:0">Welcome to Docker Dash</h3>
          <button class="modal-close-btn" id="welcome-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="line-height:1.7">
          <p>Here are some tips to get started:</p>
          <div style="display:flex;flex-direction:column;gap:12px;margin:16px 0">
            <div style="display:flex;align-items:center;gap:12px">
              <i class="fas fa-keyboard" style="font-size:20px;color:var(--accent);min-width:28px;text-align:center"></i>
              <div><strong>Ctrl+K</strong> — Command palette. Search and navigate anywhere instantly.</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <i class="fas fa-moon" style="font-size:20px;color:var(--accent);min-width:28px;text-align:center"></i>
              <div><strong>Theme toggle</strong> — Switch dark/light mode from the sidebar footer.</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <i class="fas fa-globe" style="font-size:20px;color:var(--accent);min-width:28px;text-align:center"></i>
              <div><strong>Language</strong> — Change language from the sidebar footer (EN/RO/DE).</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <i class="fas fa-toolbox" style="font-size:20px;color:var(--accent);min-width:28px;text-align:center"></i>
              <div><strong>Tools</strong> — System > Tools tab has docker run converter, AI diagnostics, and proxy label generator.</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              <i class="fab fa-git-alt" style="font-size:20px;color:var(--accent);min-width:28px;text-align:center"></i>
              <div><strong>Git Stacks</strong> — Deploy and auto-update Docker Compose stacks from Git repositories.</div>
            </div>
          </div>
          <p class="text-muted text-sm">Check <a href="#/whatsnew" style="color:var(--accent)">What's New</a> for the full changelog, or visit <a href="#/settings" style="color:var(--accent)">Settings</a> to configure notifications and credentials.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="welcome-ok">Get Started</button>
        </div>
      `;
      Modal.open(html, { width: '520px' });
      const close = () => { Modal.close(); localStorage.setItem(key, '1'); };
      Modal._content.querySelector('#welcome-x')?.addEventListener('click', close);
      Modal._content.querySelector('#welcome-ok')?.addEventListener('click', close);
    }, 1000);
  },

  _initThemeToggle() {
    const btn = document.getElementById('theme-toggle');
    const icon = document.getElementById('theme-icon');
    if (!btn || btn._bound) return;
    btn._bound = true;

    // Restore saved theme or detect OS preference
    const saved = localStorage.getItem('dd-theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      document.documentElement.setAttribute('data-theme', 'light');
    }

    this._updateThemeIcon(icon);

    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      if (next === 'dark') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', next);
      }
      localStorage.setItem('dd-theme', next);
      this._updateThemeIcon(icon);
    });
  },

  _updateThemeIcon(icon) {
    if (!icon) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    icon.className = isLight ? 'fas fa-moon' : 'fas fa-sun';
  },

  _initLangToggle() {
    const btn = document.getElementById('lang-toggle');
    const code = document.getElementById('lang-code');
    const dropdown = document.getElementById('lang-dropdown');
    if (!btn || btn._bound) return;
    btn._bound = true;

    const currentLang = i18n.languages.find(l => l.code === i18n.lang);
    code.textContent = currentLang?.label || i18n.lang.toUpperCase();
    btn.title = currentLang?.name || 'Language';

    // Build dropdown
    const renderDropdown = () => {
      dropdown.innerHTML = i18n.languages.map(l => `
        <div class="lang-option ${l.code === i18n.lang ? 'active' : ''}" data-lang="${l.code}">
          <span class="lang-option-label">${l.label}</span>
          <span class="lang-option-name">${l.name}</span>
          ${l.code === i18n.lang ? '<i class="fas fa-check" style="margin-left:auto;font-size:10px;color:var(--accent)"></i>' : ''}
        </div>
      `).join('');

      dropdown.querySelectorAll('.lang-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const lang = opt.dataset.lang;
          i18n.setLang(lang);
          const l = i18n.languages.find(x => x.code === lang);
          code.textContent = l?.label || lang.toUpperCase();
          btn.title = l?.name || lang;
          dropdown.classList.add('hidden');
          this._updateStaticUI();
          if (this._currentPage?.destroy) this._currentPage.destroy();
          this._route();
        });
      });
    };

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden');
      if (isHidden) renderDropdown();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.classList.add('hidden');
      }
    });
  },

  _updateStaticUI() {
    // Sidebar nav labels
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      const page = item.dataset.page;
      const span = item.querySelector('span');
      if (span && page) span.textContent = i18n.t('nav.' + page);
    });
    // Notification dropdown
    const notifHeader = document.querySelector('.notif-dropdown-header > span');
    if (notifHeader) notifHeader.textContent = i18n.t('notifications.title');
    const readAllBtn = document.getElementById('notif-read-all');
    if (readAllBtn) readAllBtn.textContent = i18n.t('notifications.markAllRead');
    // Login form labels
    const loginUserLabel = document.querySelector('label[for="login-user"]');
    if (loginUserLabel) loginUserLabel.textContent = i18n.t('login.username');
    const loginPassLabel = document.querySelector('label[for="login-pass"]');
    if (loginPassLabel) loginPassLabel.textContent = i18n.t('login.password');
    const loginUserInput = document.getElementById('login-user');
    if (loginUserInput) loginUserInput.placeholder = i18n.t('login.userPlaceholder');
    const loginPassInput = document.getElementById('login-pass');
    if (loginPassInput) loginPassInput.placeholder = i18n.t('login.passPlaceholder');
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn && !loginBtn.disabled) loginBtn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${i18n.t('login.signIn')}`;
  },

  // ─── Setup Wizard & Security ────────────────

  _showSetupWizard() {
    const isDefault = this.user?.username === 'admin';
    const mustChange = this._securityFlags?.mustChangePassword;

    const html = `
      <div class="modal-header" style="background:var(--accent);color:#fff;border-radius:var(--radius) var(--radius) 0 0;padding:16px 20px">
        <h3 style="margin:0"><i class="fas fa-shield-alt" style="margin-right:8px"></i>Initial Security Setup</h3>
      </div>
      <div class="modal-body">
        <div style="background:var(--surface2);border-radius:var(--radius-sm);padding:12px 16px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <i class="fas fa-user-circle" style="font-size:20px;color:var(--accent)"></i>
            <span>Logged in as: <strong>${Utils.escapeHtml(this.user?.username || '?')}</strong> (${Utils.escapeHtml(this.user?.role || '?')})</span>
          </div>
          <p style="margin:0;line-height:1.6"><i class="fas fa-exclamation-triangle" style="color:var(--yellow);margin-right:6px"></i>
          ${isDefault
            ? '<strong>You are using the default admin account.</strong> For security, please change your password immediately. We also recommend creating a personal admin account and disabling this default one.'
            : '<strong>A password change is required.</strong> Please set a new secure password.'
          }</p>
        </div>

        ${(!this._loginPassword) ? `
        <div class="form-group">
          <label><strong>Current Password</strong></label>
          <input type="password" id="setup-current-pass" class="form-control" placeholder="Enter your current password">
        </div>
        ` : ''}
        <div class="form-group">
          <label><strong>New Password</strong> <span class="text-sm text-muted">(for "${Utils.escapeHtml(this.user?.username || '')}")</span></label>
          <input type="password" id="setup-new-pass" class="form-control" placeholder="Minimum 8 characters, at least 1 number">
        </div>
        <div class="form-group">
          <label><strong>Confirm Password</strong></label>
          <input type="password" id="setup-confirm-pass" class="form-control" placeholder="Repeat new password">
        </div>
        <div id="setup-pass-error" class="text-sm" style="color:var(--red);display:none;margin-bottom:12px"></div>

        ${isDefault ? `
        <hr style="border-color:var(--border);margin:16px 0">
        <div style="margin-bottom:12px">
          <label><strong>Optional: Create Personal Admin Account</strong></label>
          <p class="text-sm text-muted" style="margin:4px 0 12px">Recommended — then you can disable the default "admin" account.</p>
        </div>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="setup-username" class="form-control" placeholder="your.name">
        </div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" id="setup-display" class="form-control" placeholder="Your Full Name">
        </div>
        <div class="form-group">
          <label>Email (optional)</label>
          <input type="email" id="setup-email" class="form-control" placeholder="you@example.com">
        </div>
        ` : ''}
      </div>
      <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center">
        <span class="text-sm text-muted"><i class="fas fa-lock"></i> This step is required for security</span>
        <button class="btn btn-primary" id="setup-submit"><i class="fas fa-check"></i> Save & Continue</button>
      </div>
    `;

    Modal.open(html, { width: '520px' });

    // Prevent closing without completing
    Modal._onClose = () => {
      if (this._securityFlags?.mustChangePassword) {
        Toast.warning('You must change your password before continuing.');
        setTimeout(() => this._showSetupWizard(), 300);
      }
    };

    const submitBtn = Modal._content.querySelector('#setup-submit');
    const errEl = Modal._content.querySelector('#setup-pass-error');

    submitBtn.addEventListener('click', async () => {
      const newPass = Modal._content.querySelector('#setup-new-pass').value;
      const confirmPass = Modal._content.querySelector('#setup-confirm-pass').value;

      // Validate
      if (!newPass) { errEl.textContent = 'Password is required'; errEl.style.display = ''; return; }
      if (newPass.length < 8) { errEl.textContent = 'Password must be at least 8 characters'; errEl.style.display = ''; return; }
      if (!/\d/.test(newPass)) { errEl.textContent = 'Password must contain at least one number'; errEl.style.display = ''; return; }
      if (newPass !== confirmPass) { errEl.textContent = 'Passwords do not match'; errEl.style.display = ''; return; }
      errEl.style.display = 'none';

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

      try {
        // Get current password
        const currentPassEl = Modal._content.querySelector('#setup-current-pass');
        const currentPass = this._loginPassword || currentPassEl?.value || '';
        if (!currentPass) {
          errEl.textContent = 'Current password is required';
          errEl.style.display = '';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fas fa-check"></i> Save & Continue';
          return;
        }
        // Mark setup complete BEFORE password change (password change invalidates session)
        try { await Api.post('/auth/complete-setup'); } catch {}

        await Api.changePassword(currentPass, newPass);

        // Create personal admin if fields filled
        const usernameEl = Modal._content.querySelector('#setup-username');
        if (usernameEl) {
          const newUsername = usernameEl.value.trim();
          if (newUsername) {
            const displayName = Modal._content.querySelector('#setup-display')?.value.trim() || newUsername;
            const email = Modal._content.querySelector('#setup-email')?.value.trim() || '';
            try {
              await Api.createUser({ username: newUsername, displayName, email, password: newPass, role: 'admin' });
              Toast.success(`Admin account "${newUsername}" created. You can now disable the default "admin" account in Settings → Users.`);
            } catch (err) {
              Toast.warning(`Personal account creation failed: ${err.message}. You can create it later in Settings.`);
            }
          }
        }

        this._securityFlags.mustChangePassword = false;
        this._securityFlags.setupRequired = false;

        Modal._onClose = null;
        Modal.close();
        Toast.success('Password changed successfully. Logging out — please sign in with your new password.');

        // Force re-login with new password
        setTimeout(() => this._logout(), 1500);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = '';
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-check"></i> Save & Continue';
      }
    });
  },

  _showSecurityBanner() {
    // Show warning if default admin is still active
    if (!this._securityFlags?.defaultAdminActive) return;
    const existing = document.getElementById('security-banner');
    if (existing) return;

    const banner = document.createElement('div');
    banner.id = 'security-banner';
    banner.style.cssText = 'background:var(--yellow);color:#000;padding:8px 16px;font-size:12px;display:flex;align-items:center;gap:8px;position:sticky;top:0;z-index:100';
    banner.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i>
      <span><strong>Security:</strong> The default "admin" account is still active. <a href="#/settings" style="color:#000;text-decoration:underline">Go to Settings → Users</a> to disable it.</span>
      <button id="dismiss-sec-banner" style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:14px;color:#000"><i class="fas fa-times"></i></button>
    `;
    const main = document.getElementById('main-content');
    if (main) main.prepend(banner);

    banner.querySelector('#dismiss-sec-banner').addEventListener('click', () => banner.remove());
  },

  async _initHostSelector() {
    try {
      const hosts = await Api.getHosts();
      const selector = document.getElementById('host-selector');
      const select = document.getElementById('host-select');
      if (!selector || !select) return;

      if (hosts.length <= 1) {
        selector.style.display = 'none';
        return;
      }

      selector.style.display = '';
      select.innerHTML = hosts.map(h => {
        const status = h.healthy === true ? '🟢' : h.healthy === false ? '🔴' : '🟡';
        return `<option value="${h.id}" ${Api.getHostId() === h.id || (Api.getHostId() === 0 && h.isDefault) ? 'selected' : ''}>${status} ${Utils.escapeHtml(h.name)}</option>`;
      }).join('');

      if (!select._bound) {
        select._bound = true;
        select.addEventListener('change', () => {
          Api.setHost(parseInt(select.value) || 0);
          // Reload current page to reflect new host
          if (this._currentPage?.destroy) this._currentPage.destroy();
          this._route();
        });
      }

      // Listen for external host changes
      window.addEventListener('hostChanged', () => {
        this._initHostSelector();
      });
    } catch {
      // Multi-host not available or error — hide selector
      const selector = document.getElementById('host-selector');
      if (selector) selector.style.display = 'none';
    }
  },

  async _logout() {
    try { await Api.logout(); } catch { /* ignore */ }
    this.user = null;
    this._loginPassword = null;
    this._securityFlags = null;
    WS.disconnect();
    if (this._notifTimer) { clearInterval(this._notifTimer); this._notifTimer = null; }
    if (this._currentPage?.destroy) this._currentPage.destroy();
    this._currentPage = null;
    this._showLogin();
  },

  handleUnauthorized() {
    this.user = null;
    WS.disconnect();
    this._showLogin();
  },

  // ─── Router ────────────────────────────────────

  _initRouter() {
    window.addEventListener('hashchange', () => this._route());
    this._route();
  },

  _route() {
    const hash = location.hash.slice(1) || '/';
    const parts = hash.split('/').filter(Boolean);
    const pageName = parts[0] || 'dashboard';
    const params = {};

    // Parse: /containers/{id}
    if (parts.length > 1) {
      params.id = parts.slice(1).join('/');
    }

    this._loadPage(pageName, params);
  },

  navigate(path) {
    location.hash = path;
  },

  async _loadPage(pageName, params) {
    // Destroy previous page
    if (this._currentPage?.destroy) {
      this._currentPage.destroy();
    }

    // Update sidebar active state
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === pageName);
    });

    const pageFactory = this._pages[pageName];
    if (!pageFactory) {
      document.getElementById('page-content').innerHTML =
        `<div class="empty-msg">${i18n.t('common.pageNotFound', { page: Utils.escapeHtml(pageName) })}</div>`;
      return;
    }

    const container = document.getElementById('page-content');
    container.innerHTML = `<div class="page-loading"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div>`;

    try {
      const page = pageFactory();
      this._currentPage = page;
      this._currentPageName = pageName;
      await page.render(container, params);

      // Enhance accessibility: add ARIA roles to tabs and icon-only buttons
      document.querySelectorAll('.tabs').forEach(t => {
        t.setAttribute('role', 'tablist');
        t.querySelectorAll('.tab').forEach(tab => tab.setAttribute('role', 'tab'));
      });
      document.querySelectorAll('.action-btn:not([aria-label])').forEach(btn => {
        const title = btn.getAttribute('title');
        if (title) btn.setAttribute('aria-label', title);
        else {
          const icon = btn.querySelector('i');
          if (icon) {
            const cls = icon.className;
            if (cls.includes('fa-edit')) btn.setAttribute('aria-label', 'Edit');
            else if (cls.includes('fa-trash')) btn.setAttribute('aria-label', 'Delete');
            else if (cls.includes('fa-play')) btn.setAttribute('aria-label', 'Start');
            else if (cls.includes('fa-stop')) btn.setAttribute('aria-label', 'Stop');
            else if (cls.includes('fa-sync')) btn.setAttribute('aria-label', 'Restart');
            else if (cls.includes('fa-plug')) btn.setAttribute('aria-label', 'Test');
            else if (cls.includes('fa-paper-plane')) btn.setAttribute('aria-label', 'Send');
            else if (cls.includes('fa-undo')) btn.setAttribute('aria-label', 'Rollback');
            else if (cls.includes('fa-copy')) btn.setAttribute('aria-label', 'Copy');
          }
        }
      });
    } catch (err) {
      console.error(`Error loading page ${pageName}:`, err);
      container.innerHTML = `<div class="empty-msg">
        <i class="fas fa-exclamation-triangle"></i>
        <p>${i18n.t('common.errorLoading', { message: Utils.escapeHtml(err.message) })}</p>
        <button class="btn btn-sm btn-primary" onclick="App._route()">${i18n.t('common.retry')}</button>
      </div>`;
    }
  },

  // ─── Sidebar ───────────────────────────────────

  _initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const logo = document.querySelector('.sidebar-logo');

    const doToggle = () => {
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
    };

    if (toggle && !toggle._bound) {
      toggle._bound = true;
      toggle.addEventListener('click', doToggle);
    }

    // Logo also toggles sidebar (only way when collapsed since hamburger is hidden)
    if (logo && !logo._bound) {
      logo._bound = true;
      logo.style.cursor = 'pointer';
      logo.addEventListener('click', doToggle);
    }

    // Restore state
    if (localStorage.getItem('sidebar-collapsed') === 'true') {
      sidebar.classList.add('collapsed');
    }

    // Mobile: add hamburger header + overlay
    if (window.innerWidth <= 768) {
      if (!document.querySelector('.mobile-header')) {
        const header = document.createElement('div');
        header.className = 'mobile-header';
        header.innerHTML = `<i class="fas fa-bars mobile-hamburger" id="mobile-menu-btn"></i><span class="mobile-title">Docker Dash</span>`;
        document.querySelector('.main-content')?.prepend(header);

        const overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        overlay.id = 'sidebar-overlay';
        document.body.appendChild(overlay);

        document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
          sidebar.classList.toggle('mobile-open');
          overlay.style.display = sidebar.classList.contains('mobile-open') ? 'block' : 'none';
        });
        overlay.addEventListener('click', () => {
          sidebar.classList.remove('mobile-open');
          overlay.style.display = 'none';
        });
        // Close sidebar on nav click
        sidebar.querySelectorAll('.nav-item').forEach(item => {
          item.addEventListener('click', () => {
            sidebar.classList.remove('mobile-open');
            overlay.style.display = 'none';
          });
        });
      }
    }
  },

  // ─── Notifications ────────────────────────────

  _notifTimer: null,

  _initNotifications() {
    const bell = document.getElementById('notif-bell');
    const dropdown = document.getElementById('notif-dropdown');
    const readAllBtn = document.getElementById('notif-read-all');

    if (!bell || bell._bound) return;
    bell._bound = true;

    // Toggle dropdown
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden');
      if (isHidden) this._loadNotifications();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== bell) {
        dropdown.classList.add('hidden');
      }
    });

    // Mark all read
    if (readAllBtn) {
      readAllBtn.addEventListener('click', async () => {
        try {
          await Api.markAllNotificationsRead();
          const countEl = document.getElementById('notif-count');
          if (countEl) { countEl.textContent = '0'; countEl.classList.add('hidden'); }
          // Refresh list
          this._loadNotifications();
        } catch (err) { console.error('Mark read failed:', err); }
      });
    }

    // Poll for notification count
    this._refreshNotifCount();
    this._notifTimer = setInterval(() => this._refreshNotifCount(), 30000);
  },

  async _refreshNotifCount() {
    try {
      const data = await Api.getNotificationCount();
      const count = data.count || data.unread || 0;
      const countEl = document.getElementById('notif-count');
      if (countEl) {
        countEl.textContent = count;
        countEl.classList.toggle('hidden', count === 0);
      }
    } catch { /* ignore */ }
  },

  async _loadNotifications() {
    const listEl = document.getElementById('notif-list');
    if (!listEl) return;

    try {
      const data = await Api.get('/notifications?limit=20');
      const items = data.notifications || data || [];

      if (items.length === 0) {
        listEl.innerHTML = `<div class="empty-msg" style="padding:24px;font-size:12px">${i18n.t('notifications.empty')}</div>`;
        return;
      }

      listEl.innerHTML = items.map(n => {
        const severity = n.severity || n.type || 'info';
        const iconClass = severity === 'error' ? 'fa-exclamation-circle' :
                          severity === 'warning' ? 'fa-exclamation-triangle' :
                          severity === 'success' ? 'fa-check-circle' : 'fa-info-circle';
        return `
          <div class="notif-item ${n.read ? '' : 'unread'}">
            <div class="notif-icon ${severity}"><i class="fas ${iconClass}"></i></div>
            <div class="notif-body">
              <div class="notif-title">${Utils.escapeHtml(n.title || n.message || '')}</div>
              <div class="notif-text">${Utils.escapeHtml(n.body || n.details || '')}</div>
            </div>
            <div class="notif-time">${Utils.timeAgo(n.created_at || n.timestamp || '')}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="empty-msg" style="padding:24px;font-size:12px">${i18n.t('notifications.failedToLoad')}</div>`;
    }
  },

  // ─── Keyboard Shortcuts ────────────────────────

  _initShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K / Cmd+K — Command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this._toggleCommandPalette();
        return;
      }

      // Skip if typing in an input
      if (e.target.matches('input, textarea, select')) return;

      if (e.key === 'r' || e.key === 'R') {
        if (this._currentPage?.destroy) this._currentPage.destroy();
        this._route();
      }

      // ? — Show keyboard shortcuts help
      if (e.key === '?') {
        this._showShortcutsHelp();
      }

      // g then d/c/i/s — vim-style navigation
      if (e.key === 'g' && !this._gPressed) {
        this._gPressed = true;
        setTimeout(() => { this._gPressed = false; }, 500);
        return;
      }
      if (this._gPressed) {
        this._gPressed = false;
        const nav = { d: '#/', c: '#/containers', i: '#/images', s: '#/system', n: '#/networks', a: '#/alerts', h: '#/hosts', g: '#/git-stacks', p: '#/insights' };
        if (nav[e.key]) { location.hash = nav[e.key]; return; }
      }
    });
  },

  // ─── Command Palette (Ctrl+K) ─────────────────

  _cmdPaletteOpen: false,
  _cmdSelectedIdx: 0,

  _getCommands() {
    const cmds = [
      { icon: 'fa-chart-pie', label: i18n.t('nav.dashboard'), action: () => this.navigate('/'), section: 'nav' },
      { icon: 'fa-cube', label: i18n.t('nav.containers'), action: () => this.navigate('/containers'), section: 'nav' },
      { icon: 'fa-layer-group', label: i18n.t('nav.images'), action: () => this.navigate('/images'), section: 'nav' },
      { icon: 'fa-database', label: i18n.t('nav.volumes'), action: () => this.navigate('/volumes'), section: 'nav' },
      { icon: 'fa-network-wired', label: i18n.t('nav.networks'), action: () => this.navigate('/networks'), section: 'nav' },
      { icon: 'fa-shield-alt', label: i18n.t('nav.security'), action: () => this.navigate('/security'), section: 'nav' },
      { icon: 'fa-bell', label: i18n.t('nav.alerts'), action: () => this.navigate('/alerts'), section: 'nav' },
      { icon: 'fa-server', label: i18n.t('nav.system'), action: () => this.navigate('/system'), section: 'nav' },
      { icon: 'fa-shield-alt', label: i18n.t('nav.firewall'), action: () => this.navigate('/firewall'), section: 'nav' },
      { icon: 'fa-server', label: i18n.t('nav.hosts'), action: () => this.navigate('/hosts'), section: 'nav' },
      { icon: 'fa-info-circle', label: i18n.t('nav.about'), action: () => this.navigate('/about'), section: 'nav' },
      { icon: 'fa-cog', label: i18n.t('nav.settings'), action: () => this.navigate('/settings'), section: 'nav' },
      { icon: 'fa-user-circle', label: i18n.t('nav.profile'), action: () => this.navigate('/profile'), section: 'nav' },
      { icon: 'fa-sync-alt', label: i18n.t('common.refresh'), action: () => { if (this._currentPage?.destroy) this._currentPage.destroy(); this._route(); }, shortcut: 'R', section: 'action' },
      { icon: 'fa-broom', label: 'System Prune', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="prune"]')?.click(), 300); }, section: 'action' },
      { icon: 'fa-download', label: i18n.t('pages.system.checkUpdates'), action: () => { this.navigate('/system'); }, section: 'action' },
      { icon: 'fa-sign-out-alt', label: 'Logout', action: () => this._logout(), section: 'action' },
    ];
    return cmds;
  },

  _showShortcutsHelp() {
    const shortcuts = [
      { keys: 'Ctrl+K', desc: 'Command palette — search and navigate anywhere' },
      { keys: '?', desc: 'This shortcuts help' },
      { keys: 'R', desc: 'Refresh current page' },
      { keys: 'g d', desc: 'Go to Dashboard' },
      { keys: 'g c', desc: 'Go to Containers' },
      { keys: 'g i', desc: 'Go to Images' },
      { keys: 'g n', desc: 'Go to Networks' },
      { keys: 'g s', desc: 'Go to System' },
      { keys: 'g a', desc: 'Go to Alerts' },
      { keys: 'g h', desc: 'Go to Hosts' },
      { keys: 'g g', desc: 'Go to Git Stacks' },
      { keys: 'g p', desc: 'Go to Insights' },
      { keys: 'Esc', desc: 'Close modal / dialog' },
    ];

    const html = `
      <div class="modal-header">
        <h3 style="margin:0"><i class="fas fa-keyboard" style="margin-right:8px;color:var(--accent)"></i>Keyboard Shortcuts</h3>
        <button class="modal-close-btn" id="shortcuts-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <table class="data-table" style="margin:0">
          <thead><tr><th style="text-align:left;width:120px">Shortcut</th><th style="text-align:left">Action</th></tr></thead>
          <tbody>
            ${shortcuts.map(s => `<tr><td><kbd style="background:var(--surface3);padding:2px 8px;border-radius:4px;font-family:var(--mono);font-size:12px">${s.keys}</kbd></td><td>${s.desc}</td></tr>`).join('')}
          </tbody>
        </table>
        <p class="text-muted text-sm" style="margin-top:12px">Shortcuts work when not typing in an input field.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="shortcuts-ok">Got it</button>
      </div>
    `;
    Modal.open(html, { width: '480px' });
    Modal._content.querySelector('#shortcuts-x')?.addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#shortcuts-ok')?.addEventListener('click', () => Modal.close());
  },

  _toggleCommandPalette() {
    if (this._cmdPaletteOpen) {
      this._closeCommandPalette();
    } else {
      this._openCommandPalette();
    }
  },

  _openCommandPalette() {
    if (this._cmdPaletteOpen) return;
    this._cmdPaletteOpen = true;
    this._cmdSelectedIdx = 0;

    const overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';
    overlay.id = 'cmd-palette-overlay';

    overlay.innerHTML = `
      <div class="cmd-palette">
        <input type="text" class="cmd-palette-input" id="cmd-input" placeholder="${i18n.t('cmdPalette.placeholder')}" autocomplete="off">
        <div class="cmd-palette-results" id="cmd-results"></div>
        <div class="cmd-palette-footer">
          <span><kbd>↑↓</kbd> ${i18n.t('cmdPalette.navigate')}</span>
          <span><kbd>↵</kbd> ${i18n.t('cmdPalette.select')}</span>
          <span><kbd>Esc</kbd> ${i18n.t('cmdPalette.close')}</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = document.getElementById('cmd-input');
    const results = document.getElementById('cmd-results');

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeCommandPalette();
    });

    // Render all commands initially
    this._renderCmdResults('');

    // Input events
    input.addEventListener('input', () => {
      this._cmdSelectedIdx = 0;
      this._renderCmdResults(input.value);
    });

    input.addEventListener('keydown', (e) => {
      const items = results.querySelectorAll('.cmd-palette-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._cmdSelectedIdx = Math.min(this._cmdSelectedIdx + 1, items.length - 1);
        this._highlightCmd(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._cmdSelectedIdx = Math.max(this._cmdSelectedIdx - 1, 0);
        this._highlightCmd(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[this._cmdSelectedIdx]) items[this._cmdSelectedIdx].click();
      } else if (e.key === 'Escape') {
        this._closeCommandPalette();
      }
    });

    input.focus();
  },

  _renderCmdResults(query) {
    const results = document.getElementById('cmd-results');
    if (!results) return;

    let commands = this._getCommands();
    if (query) {
      const q = query.toLowerCase();
      commands = commands.filter(c => c.label.toLowerCase().includes(q));
    }

    if (commands.length === 0) {
      results.innerHTML = `<div class="cmd-palette-empty">${i18n.t('cmdPalette.noResults')}</div>`;
      return;
    }

    results.innerHTML = commands.map((c, i) => `
      <div class="cmd-palette-item ${i === this._cmdSelectedIdx ? 'selected' : ''}" data-idx="${i}">
        <i class="fas ${c.icon}"></i>
        <span class="cmd-label">${Utils.escapeHtml(c.label)}</span>
        ${c.shortcut ? `<span class="cmd-shortcut">${c.shortcut}</span>` : ''}
      </div>
    `).join('');

    results.querySelectorAll('.cmd-palette-item').forEach((item, idx) => {
      item.addEventListener('click', () => {
        const cmd = commands[idx];
        this._closeCommandPalette();
        if (cmd?.action) cmd.action();
      });
      item.addEventListener('mouseenter', () => {
        this._cmdSelectedIdx = idx;
        this._highlightCmd(results.querySelectorAll('.cmd-palette-item'));
      });
    });
  },

  _highlightCmd(items) {
    items.forEach((el, i) => el.classList.toggle('selected', i === this._cmdSelectedIdx));
    items[this._cmdSelectedIdx]?.scrollIntoView({ block: 'nearest' });
  },

  _closeCommandPalette() {
    this._cmdPaletteOpen = false;
    const overlay = document.getElementById('cmd-palette-overlay');
    if (overlay) overlay.remove();
  },
};

// ─── Bootstrap ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  App._initShortcuts();
});

window.App = App;
