/* ═══════════════════════════════════════════════════
   app.js — Main Application (Router + Auth + Boot)
   ═══════════════════════════════════════════════════ */
'use strict';

const App = {
  user: null,
  _currentPage: null,
  _currentPageName: null,
  _uiMode: 'standard',

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
    'cost-optimizer': () => CostOptimizerPage,
    'dependency-map': () => DependencyMapPage,
    settings:   () => SettingsPage,
    profile:    () => ProfilePage,
    notifications: () => NotificationsPage,
    stacks:     () => StacksPage,
    swarm:      () => SwarmPage,
    'api-playground': () => ApiPlaygroundPage,
    'multi-host':     () => MultiHostPage,
    'logs':           () => LogsPage,
    'timeline':       () => TimelinePage,
    'howto':          () => HowToPage,
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

    // Check if OIDC is enabled and show SSO button
    this._initOidcButton();

    // Load and display login banner (MOTD) if set
    this._loadLoginMotd();

    const form = document.getElementById('login-form');

    // Clone to remove old listeners
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);

    // IMPORTANT: re-query errEl from the NEW form (old ref is detached from DOM)
    const errEl = newForm.querySelector('#login-error');

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

        // MFA required — show TOTP input
        if (res.mfaRequired) {
          btn.disabled = false;
          btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> ${i18n.t('login.signIn')}`;
          this._showMfaPrompt(res.mfaToken, newForm, errEl);
          return;
        }

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

  async _initOidcButton() {
    const section = document.getElementById('oidc-section');
    const btn = document.getElementById('oidc-login-btn');
    if (!section || !btn) return;

    try {
      const result = await fetch('/api/auth/oidc/enabled').then(r => r.json());
      if (result.enabled) {
        section.classList.remove('hidden');
        // Remove old listener by cloning
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', async () => {
          newBtn.disabled = true;
          newBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Redirecting...';
          try {
            const loginRes = await fetch('/api/auth/oidc/login').then(r => r.json());
            if (loginRes.url) {
              window.location.href = loginRes.url;
            } else {
              newBtn.disabled = false;
              newBtn.innerHTML = '<i class="fas fa-shield-alt"></i> Sign in with SSO';
            }
          } catch (err) {
            newBtn.disabled = false;
            newBtn.innerHTML = '<i class="fas fa-shield-alt"></i> Sign in with SSO';
          }
        });
      } else {
        section.classList.add('hidden');
      }
    } catch {
      section.classList.add('hidden');
    }
  },

  _motdLoading: false,

  async _loadLoginMotd() {
    // Prevent concurrent/duplicate loads
    if (this._motdLoading) return;
    this._motdLoading = true;

    // Remove ALL existing MOTD elements
    document.querySelectorAll('#login-motd').forEach(el => el.remove());

    try {
      const { motd } = await Api.getMotd();
      if (motd) {
        // Double-check no MOTD was added while we were fetching
        document.querySelectorAll('#login-motd').forEach(el => el.remove());

        const motdEl = document.createElement('div');
        motdEl.id = 'login-motd';
        motdEl.style.cssText = 'margin-bottom:16px;padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);font-size:13px;color:var(--text);max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;';
        motdEl.textContent = motd;
        const loginCard = document.querySelector('.login-card');
        const loginForm = loginCard?.querySelector('form');
        if (loginCard && loginForm) loginCard.insertBefore(motdEl, loginForm);
      }
    } catch { /* silently skip */ }
    finally { this._motdLoading = false; }
  },

  _showMfaPrompt(mfaToken, form, errEl) {
    // Hide username/password fields, show TOTP input
    const formGroups = form.querySelectorAll('.form-group');
    formGroups.forEach(g => g.style.display = 'none');
    const forgotEl = form.querySelector('#login-forgot');
    if (forgotEl) forgotEl.style.display = 'none';

    // Create MFA input UI
    const mfaDiv = document.createElement('div');
    mfaDiv.id = 'mfa-section';
    mfaDiv.innerHTML = `
      <div style="text-align:center;margin-bottom:16px">
        <i class="fas fa-shield-alt" style="font-size:32px;color:var(--accent)"></i>
        <h3 style="margin:8px 0 4px">${i18n.t('login.mfaTitle')}</h3>
        <p class="text-sm text-muted">${i18n.t('login.mfaSubtitle')}</p>
      </div>
      <div class="form-group">
        <input type="text" id="mfa-code" class="form-control" placeholder="000000"
          maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code"
          style="text-align:center;font-size:24px;letter-spacing:8px;font-weight:bold">
      </div>
      <div style="text-align:center;margin-top:8px">
        <a href="#" id="mfa-use-recovery" class="text-sm" style="color:var(--accent)">${i18n.t('login.mfaUseRecovery')}</a>
      </div>
    `;
    form.insertBefore(mfaDiv, errEl);

    const codeInput = mfaDiv.querySelector('#mfa-code');
    codeInput.focus();

    // Replace form submit handler for MFA
    const newHandler = async (e) => {
      e.preventDefault();
      errEl.classList.add('hidden');
      const code = codeInput.value.trim();
      if (!code || code.length < 6) {
        errEl.textContent = i18n.t('login.mfaEnterCode');
        errEl.classList.remove('hidden');
        return;
      }

      const btn = form.querySelector('#login-btn');
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('login.mfaVerifying')}`;

      try {
        const res = await Api.post('/auth/mfa/verify', { mfaToken, code });
        if (res.token) {
          Api._bearerToken = res.token;
          try { sessionStorage.setItem('dd_token', res.token); } catch {}
        }
        this.user = res.user;
        this._securityFlags = {
          setupRequired: res.setupRequired,
          mustChangePassword: res.mustChangePassword,
          defaultAdminActive: res.defaultAdminActive,
        };
        form.reset();
        mfaDiv.remove();
        formGroups.forEach(g => g.style.display = '');
        if (forgotEl) forgotEl.style.display = '';
        this._showApp();
      } catch (err) {
        errEl.textContent = err.message || i18n.t('login.mfaInvalidCode');
        errEl.classList.remove('hidden');
        codeInput.value = '';
        codeInput.focus();
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> Verify`;
      }
    };

    // Replace submit listener
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    // Re-get elements from new form
    const newMfaDiv = newForm.querySelector('#mfa-section');
    const newErrEl = newForm.querySelector('#login-error');
    const newCodeInput = newForm.querySelector('#mfa-code');
    newCodeInput.focus();

    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      newErrEl.classList.add('hidden');
      const code = newCodeInput.value.trim();
      const isRecovery = newForm.querySelector('#mfa-recovery-input');

      if (isRecovery) {
        const recoveryCode = isRecovery.value.trim();
        if (!recoveryCode) { newErrEl.textContent = i18n.t('login.mfaEnterRecovery'); newErrEl.classList.remove('hidden'); return; }
        const btn = newForm.querySelector('#login-btn');
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('login.mfaVerifying')}`;
        try {
          const res = await Api.post('/auth/mfa/recovery', { mfaToken, recoveryCode });
          if (res.token) { Api._bearerToken = res.token; try { sessionStorage.setItem('dd_token', res.token); } catch {} }
          this.user = res.user;
          this._securityFlags = { setupRequired: res.setupRequired, mustChangePassword: res.mustChangePassword, defaultAdminActive: res.defaultAdminActive };
          this._showApp();
        } catch (err) { newErrEl.textContent = err.message || i18n.t('login.mfaInvalidRecovery'); newErrEl.classList.remove('hidden'); }
        finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Verify'; }
        return;
      }

      if (!code || code.length < 6) { newErrEl.textContent = i18n.t('login.mfaEnterCode'); newErrEl.classList.remove('hidden'); return; }
      const btn = newForm.querySelector('#login-btn');
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('login.mfaVerifying')}`;
      try {
        const res = await Api.post('/auth/mfa/verify', { mfaToken, code });
        if (res.token) { Api._bearerToken = res.token; try { sessionStorage.setItem('dd_token', res.token); } catch {} }
        this.user = res.user;
        this._securityFlags = { setupRequired: res.setupRequired, mustChangePassword: res.mustChangePassword, defaultAdminActive: res.defaultAdminActive };
        this._showApp();
      } catch (err) { newErrEl.textContent = err.message || i18n.t('login.mfaInvalidCode'); newErrEl.classList.remove('hidden'); newCodeInput.value = ''; newCodeInput.focus(); }
      finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Verify'; }
    });

    // Recovery code link
    newForm.querySelector('#mfa-use-recovery')?.addEventListener('click', (e) => {
      e.preventDefault();
      const codeGroup = newMfaDiv.querySelector('.form-group');
      codeGroup.innerHTML = `
        <label class="text-sm">Recovery Code</label>
        <input type="text" id="mfa-recovery-input" class="form-control" placeholder="Enter recovery code" style="text-align:center;font-size:16px">
      `;
      newMfaDiv.querySelector('#mfa-use-recovery').textContent = i18n.t('login.mfaUseAuthenticator');
      newMfaDiv.querySelector('#mfa-use-recovery').addEventListener('click', (e2) => {
        e2.preventDefault();
        codeGroup.innerHTML = `
          <input type="text" id="mfa-code" class="form-control" placeholder="000000"
            maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code"
            style="text-align:center;font-size:24px;letter-spacing:8px;font-weight:bold">
        `;
        newMfaDiv.querySelector('#mfa-use-recovery').textContent = i18n.t('login.mfaUseRecovery');
      });
      newForm.querySelector('#mfa-recovery-input')?.focus();
    });

    // Update button text
    const loginBtn = newForm.querySelector('#login-btn');
    loginBtn.innerHTML = '<i class="fas fa-shield-alt"></i> Verify';
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

    // Update sidebar container count from live stats
    // Update sidebar connection status
    WS.on('connected', () => {
      const dot = document.getElementById('status-dot');
      const txt = document.getElementById('status-text');
      if (dot) dot.style.background = 'var(--green)';
      if (txt) txt.textContent = 'Connected';
    });

    WS.on('stats:overview', (data) => {
      const badge = document.getElementById('container-count');
      if (badge && data?.containers) {
        const running = data.containers.filter(c => c.state === 'running' || c.cpu !== undefined).length;
        const total = data.containers.length;
        badge.textContent = `${running}/${total}`;
        badge.classList.remove('hidden');
        badge.style.color = running === total ? 'var(--green)' : running > 0 ? 'var(--text)' : 'var(--red)';
      }
    });
    WS.subscribe('stats:overview');

    // Setup sidebar
    this._initSidebar();

    // Setup logout
    document.getElementById('logout-btn').addEventListener('click', () => this._logout());

    // Setup theme toggle
    this._initThemeToggle();

    // Setup UI mode toggle (standard / enterprise)
    this._initUiModeToggle();

    // Setup density toggle (comfortable / compact / dense)
    this._initDensityToggle();

    // Initialize task bar (Enterprise mode only)
    TaskBar.init();

    // Sync preferences from server (fire-and-forget, localStorage wins for instant display)
    this._syncUserPreferences();

    // Setup language toggle
    this._initLangToggle();

    // Setup notifications
    this._initNotifications();

    // Update static UI labels
    this._updateStaticUI();

    // Start router
    this._initRouter();

    // Apply sidebar layout for saved UI mode (router sets _currentPageName first)
    this._renderSidebarForMode(this._uiMode);

    // Show welcome modal for first-time users (once per user)
    this._showWelcomeIfNeeded();

    // Show onboarding wizard for fresh installs (few containers)
    setTimeout(() => this._checkOnboarding(), 800);
  },

  async _checkOnboarding() {
    // Only show once — check localStorage
    if (localStorage.getItem('dd-onboarding-done')) return;

    // Check if this is a fresh install (few containers)
    try {
      const containers = await Api.getContainers(true);
      if (containers.length > 3) { localStorage.setItem('dd-onboarding-done', '1'); return; }
    } catch { return; }

    this._showOnboardingWizard();
  },

  _showOnboardingWizard() {
    const overlay = document.createElement('div');
    overlay.id = 'onboarding-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:11000;display:flex;align-items:center;justify-content:center';

    let step = 0;
    const steps = [
      {
        title: 'Welcome to Docker Dash! 🐳',
        icon: 'fa-hand-sparkles',
        content: `
          <p style="font-size:15px;margin-bottom:16px">Your self-hosted Docker management dashboard is ready.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0">
            <div style="padding:12px;background:var(--surface3);border-radius:var(--radius)">
              <i class="fas fa-cube" style="color:var(--accent);margin-right:6px"></i><strong>Containers</strong>
              <p class="text-sm text-muted" style="margin:4px 0 0">Manage, monitor, and debug containers</p>
            </div>
            <div style="padding:12px;background:var(--surface3);border-radius:var(--radius)">
              <i class="fas fa-shield-alt" style="color:var(--green);margin-right:6px"></i><strong>Security</strong>
              <p class="text-sm text-muted" style="margin:4px 0 0">Vulnerability scanning with Trivy/Grype</p>
            </div>
            <div style="padding:12px;background:var(--surface3);border-radius:var(--radius)">
              <i class="fas fa-code-branch" style="color:var(--yellow);margin-right:6px"></i><strong>GitOps</strong>
              <p class="text-sm text-muted" style="margin:4px 0 0">Deploy from Git repos with auto-update</p>
            </div>
            <div style="padding:12px;background:var(--surface3);border-radius:var(--radius)">
              <i class="fas fa-flask" style="color:var(--red);margin-right:6px"></i><strong>Sandbox</strong>
              <p class="text-sm text-muted" style="margin:4px 0 0">Test images risk-free with auto-cleanup</p>
            </div>
          </div>
        `,
      },
      {
        title: 'Quick Start Tips',
        icon: 'fa-lightbulb',
        content: `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div style="display:flex;align-items:flex-start;gap:12px;padding:10px;background:var(--surface3);border-radius:var(--radius)">
              <span style="background:var(--accent);color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">1</span>
              <div><strong>Deploy a stack</strong><p class="text-sm text-muted" style="margin:2px 0 0">Go to Containers → Templates to deploy pre-configured apps (Nginx, Redis, Postgres, etc.)</p></div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:12px;padding:10px;background:var(--surface3);border-radius:var(--radius)">
              <span style="background:var(--accent);color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">2</span>
              <div><strong>Scan for vulnerabilities</strong><p class="text-sm text-muted" style="margin:2px 0 0">Go to Security → Scan All to check your images for CVEs</p></div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:12px;padding:10px;background:var(--surface3);border-radius:var(--radius)">
              <span style="background:var(--accent);color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">3</span>
              <div><strong>Set up alerts</strong><p class="text-sm text-muted" style="margin:2px 0 0">Go to Alerts to get notified when containers crash or resources spike</p></div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:12px;padding:10px;background:var(--surface3);border-radius:var(--radius)">
              <span style="background:var(--accent);color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">4</span>
              <div><strong>Try keyboard shortcuts</strong><p class="text-sm text-muted" style="margin:2px 0 0">Press <kbd style="background:var(--surface2);padding:1px 4px;border-radius:3px;font-size:10px">?</kbd> anywhere to see all shortcuts</p></div>
            </div>
          </div>
        `,
      },
      {
        title: 'Enterprise Mode Available',
        icon: 'fa-building',
        content: `
          <p style="margin-bottom:12px">Docker Dash has two interface modes:</p>
          <div style="display:flex;gap:12px">
            <div style="flex:1;padding:14px;background:var(--surface3);border-radius:var(--radius);border:2px solid var(--border)">
              <div style="font-weight:700;margin-bottom:6px"><i class="fas fa-rocket" style="margin-right:6px;color:var(--accent)"></i>Standard</div>
              <p class="text-sm text-muted">Clean, simple, familiar. Perfect for daily use.</p>
            </div>
            <div style="flex:1;padding:14px;background:var(--surface3);border-radius:var(--radius);border:2px solid var(--accent)">
              <div style="font-weight:700;margin-bottom:6px"><i class="fas fa-building" style="margin-right:6px;color:var(--accent)"></i>Enterprise</div>
              <p class="text-sm text-muted">Dense layout, right-click menus, task bar, pagination. Power-user mode.</p>
            </div>
          </div>
          <p class="text-sm text-muted" style="margin-top:12px">Toggle anytime with the <i class="fas fa-rocket"></i> icon in the sidebar footer.</p>
        `,
      },
    ];

    const render = () => {
      const s = steps[step];
      overlay.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:32px;max-width:560px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
          <div style="display:flex;gap:6px;margin-bottom:20px">
            ${steps.map((_, i) => `<div style="flex:1;height:4px;border-radius:2px;background:${i <= step ? 'var(--accent)' : 'var(--surface3)'}"></div>`).join('')}
          </div>
          <h2 style="margin:0 0 16px;color:var(--text-bright)"><i class="fas ${s.icon}" style="margin-right:10px;color:var(--accent)"></i>${s.title}</h2>
          ${s.content}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px">
            <button id="ob-skip" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:13px">Skip tour</button>
            <div style="display:flex;gap:8px">
              ${step > 0 ? '<button class="btn btn-secondary" id="ob-back"><i class="fas fa-arrow-left"></i> Back</button>' : ''}
              ${step < steps.length - 1
                ? '<button class="btn btn-primary" id="ob-next">Next <i class="fas fa-arrow-right"></i></button>'
                : '<button class="btn btn-accent" id="ob-finish"><i class="fas fa-check"></i> Get Started</button>'}
            </div>
          </div>
        </div>
      `;

      const close = () => { overlay.remove(); localStorage.setItem('dd-onboarding-done', '1'); };
      overlay.querySelector('#ob-skip')?.addEventListener('click', close);
      overlay.querySelector('#ob-back')?.addEventListener('click', () => { step--; render(); });
      overlay.querySelector('#ob-next')?.addEventListener('click', () => { step++; render(); });
      overlay.querySelector('#ob-finish')?.addEventListener('click', close);
    };

    document.body.appendChild(overlay);
    render();
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
      // Update chart colors for new theme
      Utils.configureChartDefaults();
      // Save to server (fire-and-forget)
      Api.saveUserPreference('theme', next).catch(() => {});
    });

    // Auto-detect OS theme changes (if user hasn't manually set)
    window.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener('change', (e) => {
      if (!localStorage.getItem('dd-theme')) {
        document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
        this._updateThemeIcon(icon);
        Utils.configureChartDefaults();
      }
    });
  },

  _updateThemeIcon(icon) {
    if (!icon) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    icon.className = isLight ? 'fas fa-moon' : 'fas fa-sun';
  },

  _initUiModeToggle() {
    const btn = document.getElementById('uimode-toggle');
    const icon = document.getElementById('uimode-icon');
    if (!btn) return;

    this._uiMode = document.documentElement.getAttribute('data-uimode') || 'standard';
    this._updateUiModeIcon(icon);

    btn.addEventListener('click', () => {
      const next = this._uiMode === 'standard' ? 'enterprise' : 'standard';
      this._uiMode = next;
      if (next === 'enterprise') {
        document.documentElement.setAttribute('data-uimode', 'enterprise');
      } else {
        document.documentElement.removeAttribute('data-uimode');
      }
      localStorage.setItem('dd-uimode', next);
      this._updateUiModeIcon(icon);
      this._renderSidebarForMode(next);
      TaskBar._updateVisibility();
      Api.saveUserPreference('uiMode', next).catch(() => {});
    });
  },

  _updateUiModeIcon(icon) {
    if (!icon) return;
    icon.className = this._uiMode === 'enterprise' ? 'fas fa-building' : 'fas fa-rocket';
    icon.title = this._uiMode === 'enterprise' ? 'Switch to Standard mode' : 'Switch to Enterprise mode';
  },

  _initDensityToggle() {
    const btn = document.getElementById('density-toggle');
    if (!btn) return;

    const densities = ['comfortable', 'compact', 'dense'];
    const icons = { comfortable: 'fa-align-justify', compact: 'fa-bars', dense: 'fa-grip-lines' };
    const labels = { comfortable: 'Comfortable', compact: 'Compact', dense: 'Dense' };

    let current = localStorage.getItem('dd-density') || 'comfortable';
    if (current !== 'comfortable') document.documentElement.setAttribute('data-density', current);
    this._updateDensityIcon(btn, current, icons, labels);

    btn.addEventListener('click', () => {
      const idx = (densities.indexOf(current) + 1) % densities.length;
      current = densities[idx];
      if (current === 'comfortable') {
        document.documentElement.removeAttribute('data-density');
      } else {
        document.documentElement.setAttribute('data-density', current);
      }
      localStorage.setItem('dd-density', current);
      this._updateDensityIcon(btn, current, icons, labels);
      Api.saveUserPreference('density', current).catch(() => {});
    });
  },

  _updateDensityIcon(btn, density, icons, labels) {
    const icon = btn.querySelector('i');
    if (icon) icon.className = `fas ${icons[density]}`;
    btn.title = `Density: ${labels[density]}`;
  },

  _renderSidebarForMode(mode) {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;

    if (mode === 'enterprise') {
      // Save the original HTML so we can restore it perfectly
      if (!this._standardNavHTML) {
        this._standardNavHTML = nav.innerHTML;
      }

      // Enterprise grouping (ESXi-inspired)
      const enterpriseGroups = [
        { label: null,          items: ['dashboard'] },
        { label: 'Compute',     items: ['multi-host', 'containers', 'stacks', 'swarm'] },
        { label: 'Storage',     items: ['images', 'volumes'] },
        { label: 'Networking',  items: ['networks', 'firewall', 'dependency-map'] },
        { label: 'Monitor',     items: ['insights', 'alerts', 'cost-optimizer', 'security', 'logs', 'timeline'] },
        { label: 'Operations',  items: ['system', 'workflows'] },
        { label: 'Admin',       items: ['hosts', 'settings', 'compare', 'api-playground', 'howto', 'about', 'whatsnew'] },
      ];

      // Collect all existing nav items by data-page
      const navItems = {};
      nav.querySelectorAll('.nav-item').forEach(item => {
        const page = item.getAttribute('data-page');
        if (page) navItems[page] = item.outerHTML;
      });

      // Build enterprise nav HTML
      let html = '';
      enterpriseGroups.forEach(group => {
        if (group.label) {
          const labelKey = 'section' + group.label; // e.g. sectionCompute
          const labelRaw = i18n.t('nav.' + labelKey);
          const labelText = (labelRaw === 'nav.' + labelKey) ? group.label : labelRaw;
          html += `<div class="nav-section-label" data-enterprise-section="${group.label}"><span>${labelText}</span></div>`;
        }
        group.items.forEach(page => {
          if (navItems[page]) html += navItems[page];
        });
      });

      nav.innerHTML = html;
    } else {
      // Restore standard sidebar
      if (this._standardNavHTML) {
        nav.innerHTML = this._standardNavHTML;
      }
    }

    // Re-apply active state and re-translate nav item labels
    // Fall back to URL hash if _currentPageName not yet set (async page load in progress)
    const hashPage = (location.hash.slice(1) || '/').split('/').filter(Boolean)[0] || 'dashboard';
    const currentPage = this._currentPageName || hashPage;
    nav.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-page') === currentPage);
      const page = item.getAttribute('data-page');
      const span = item.querySelector('span');
      if (span && page) span.textContent = i18n.t('nav.' + page);
    });
    // Re-translate section labels in the current mode
    nav.querySelectorAll('.nav-section-label span').forEach(span => {
      const section = span.closest('[data-enterprise-section]');
      if (section) {
        const label = section.getAttribute('data-enterprise-section');
        const key = 'section' + label;
        const raw = i18n.t('nav.' + key);
        span.textContent = (raw === 'nav.' + key) ? label : raw;
      }
    });
  },

  async _syncUserPreferences() {
    try {
      const prefs = await Api.getUserPreferences();
      // Theme: server overrides localStorage only if localStorage has no value (new device)
      // or if values differ and we want server to be source of truth across devices
      if (prefs.theme) {
        const local = localStorage.getItem('dd-theme');
        if (!local || local !== prefs.theme) {
          localStorage.setItem('dd-theme', prefs.theme);
          if (prefs.theme === 'dark') {
            document.documentElement.removeAttribute('data-theme');
          } else {
            document.documentElement.setAttribute('data-theme', prefs.theme);
          }
          const icon = document.getElementById('theme-icon');
          this._updateThemeIcon(icon);
          Utils.configureChartDefaults();
        }
      }
      // Language: sync from server if available
      if (prefs.lang && prefs.lang !== i18n.lang) {
        localStorage.setItem('dd-lang', prefs.lang);
        i18n.setLanguage(prefs.lang);
      }
      // UI Mode: sync from server if it differs from localStorage
      if (prefs.uiMode && prefs.uiMode !== (localStorage.getItem('dd-uimode') || 'standard')) {
        const mode = prefs.uiMode;
        localStorage.setItem('dd-uimode', mode);
        if (mode === 'enterprise') {
          document.documentElement.setAttribute('data-uimode', 'enterprise');
        } else {
          document.documentElement.removeAttribute('data-uimode');
        }
        this._uiMode = mode;
        this._updateUiModeIcon(document.getElementById('uimode-icon'));
        this._renderSidebarForMode(mode);
      }
      // Density: sync from server if it differs from localStorage
      if (prefs.density && prefs.density !== (localStorage.getItem('dd-density') || 'comfortable')) {
        const d = prefs.density;
        localStorage.setItem('dd-density', d);
        if (d === 'comfortable') document.documentElement.removeAttribute('data-density');
        else document.documentElement.setAttribute('data-density', d);
        this._updateDensityIcon(document.getElementById('density-toggle'), d,
          { comfortable: 'fa-align-justify', compact: 'fa-bars', dense: 'fa-grip-lines' },
          { comfortable: 'Comfortable', compact: 'Compact', dense: 'Dense' });
      }
      // Accent color: sync from server across devices
      if (prefs.accent && prefs.accent !== localStorage.getItem('dd-accent')) {
        const a = prefs.accent;
        localStorage.setItem('dd-accent', a);
        document.documentElement.style.setProperty('--accent', a);
        document.documentElement.style.setProperty('--accent-hover', a);
        document.documentElement.style.setProperty('--accent-dim', a + '26');
      }
    } catch {
      // Preferences table may not exist yet (migration pending) — ignore silently
    }
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
    if (i18n.lang === 'tlh') code.style.fontFamily = "'Klingon', sans-serif";
    else code.style.fontFamily = '';

    // Restore Klingon mode if it was the saved language
    if (i18n.lang === 'tlh' && window.KlingonFX) {
      document.body.classList.add('klingon-mode');
    }

    // Build dropdown
    const renderDropdown = () => {
      dropdown.innerHTML = i18n.languages.map(l => `
        <div class="lang-option ${l.code === i18n.lang ? 'active' : ''}" data-lang="${l.code}">
          <span class="lang-option-label">${l.label}</span>
          <span class="lang-option-name" ${l.code === 'tlh' ? 'style="font-family:\'Klingon\',sans-serif;letter-spacing:2px;color:#cc0000"' : ''}>${l.name}</span>
          ${l.code === i18n.lang ? '<i class="fas fa-check" style="margin-left:auto;font-size:10px;color:var(--accent)"></i>' : ''}
        </div>
      `).join('');

      dropdown.querySelectorAll('.lang-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const prevLang = i18n.lang;
          const lang = opt.dataset.lang;
          i18n.setLang(lang);
          // Save language preference to server (fire-and-forget)
          Api.saveUserPreference('lang', lang).catch(() => {});
          const l = i18n.languages.find(x => x.code === lang);
          code.textContent = l?.label || lang.toUpperCase();
          code.style.fontFamily = lang === 'tlh' ? "'Klingon', sans-serif" : '';
          btn.title = l?.name || lang;
          dropdown.classList.add('hidden');

          // Klingon easter egg
          if (lang === 'tlh' && prevLang !== 'tlh' && window.KlingonFX) {
            KlingonFX.activate();
          } else if (prevLang === 'tlh' && lang !== 'tlh' && window.KlingonFX) {
            KlingonFX.deactivate();
          }

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
    // Sidebar section labels — handle both standard and enterprise modes
    document.querySelectorAll('.nav-section-label').forEach(label => {
      const span = label.querySelector('span');
      if (!span) return;
      const enterpriseSection = label.getAttribute('data-enterprise-section');
      if (enterpriseSection) {
        // Enterprise mode label — translate using sectionCompute, sectionStorage, etc.
        const key = 'section' + enterpriseSection;
        const raw = i18n.t('nav.' + key);
        span.textContent = (raw === 'nav.' + key) ? enterpriseSection : raw;
      } else {
        // Standard mode — use index-based keys (Resources, Operations, Admin)
        const sectionKeys = ['sectionResources', 'sectionOperations', 'sectionAdmin'];
        const allStandardLabels = Array.from(document.querySelectorAll('.nav-section-label:not([data-enterprise-section]) span'));
        const idx = allStandardLabels.indexOf(span);
        if (idx >= 0 && sectionKeys[idx]) span.textContent = i18n.t('nav.' + sectionKeys[idx]);
      }
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
    const loginForgot = document.getElementById('login-forgot');
    if (loginForgot) loginForgot.textContent = i18n.t('login.forgotPassword');
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
        const envTag = h.environment && h.environment !== 'development' ? ` [${h.environment.substring(0, 4).toUpperCase()}]` : '';
        return `<option value="${h.id}" ${Api.getHostId() === h.id || (Api.getHostId() === 0 && h.isDefault) ? 'selected' : ''}>${status} ${Utils.escapeHtml(h.name)}${envTag}</option>`;
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
    // Restore sidebar to standard layout so the next login snapshots the correct HTML
    if (this._standardNavHTML) {
      const nav = document.querySelector('.sidebar-nav');
      if (nav) nav.innerHTML = this._standardNavHTML;
    }
    this._standardNavHTML = null;
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
        <button class="btn btn-sm btn-primary" id="page-retry-btn">${i18n.t('common.retry')}</button>
      </div>`;
      container.querySelector('#page-retry-btn')?.addEventListener('click', () => App._route());
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
      const data = await Api.getNotifications({ limit: 20 });
      const items = data.items || data.notifications || data || [];

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
          <div class="notif-item ${n.is_read || n.read ? '' : 'unread'}">
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

  _gPressed: false,

  _initShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K / Cmd+K — Command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this._toggleCommandPalette();
        return;
      }

      // Skip if typing in an input
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'r' || e.key === 'R') {
        if (this._currentPage?.destroy) this._currentPage.destroy();
        this._route();
        return;
      }

      // ? — Show keyboard shortcuts overlay
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this._showShortcutsOverlay();
        return;
      }

      // / — Focus search box on current page
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        const search = document.querySelector('.search-box input') ||
                       document.querySelector('#container-search') ||
                       document.querySelector('#image-search') ||
                       document.querySelector('input[type="search"]');
        if (search) { e.preventDefault(); search.focus(); }
        return;
      }

      // g then d/c/i/v/n/s/m/a/h — vim-style navigation
      if (e.key === 'g' && !this._gPressed) {
        this._gPressed = true;
        setTimeout(() => { this._gPressed = false; }, 1000);
        return;
      }
      if (this._gPressed) {
        this._gPressed = false;
        const routes = {
          d: '/',
          c: '/containers',
          i: '/images',
          v: '/volumes',
          n: '/networks',
          s: '/stacks',
          m: '/multi-host',
          a: '/alerts',
          h: '/hosts',
          y: '/system',
          g: '/git-stacks',
          p: '/insights',
        };
        if (routes[e.key]) { e.preventDefault(); App.navigate(routes[e.key]); }
        return;
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
      { icon: 'fa-bell', label: 'Notifications', action: () => this.navigate('/notifications'), section: 'nav' },
      { icon: 'fa-layer-group', label: 'Stacks', action: () => this.navigate('/stacks'), section: 'nav' },
      { icon: 'fa-flask', label: 'API Playground', action: () => this.navigate('/api-playground'), section: 'nav' },
      { icon: 'fa-dollar-sign', label: 'Cost Optimizer', action: () => this.navigate('/cost-optimizer'), section: 'nav' },
      { icon: 'fa-project-diagram', label: 'Dependency Map', action: () => this.navigate('/dependency-map'), section: 'nav' },
      { icon: 'fa-book', label: 'How-To Guides', action: () => this.navigate('/howto'), section: 'nav' },
      { icon: 'fa-history', label: 'Event Timeline', action: () => this.navigate('/timeline'), section: 'nav' },
      { icon: 'fa-file-alt', label: 'Log Explorer', action: () => this.navigate('/logs'), section: 'nav' },
      { icon: 'fa-globe', label: 'Multi-Host Overview', action: () => this.navigate('/multi-host'), section: 'nav' },
      // Docker tools
      { icon: 'fa-terminal', label: 'docker run → Compose', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-tags', label: 'Reverse Proxy Labels (Traefik/Caddy)', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-robot', label: 'AI Log Analysis', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      // Security tools
      { icon: 'fa-key', label: 'Password Generator', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-shield-alt', label: 'Password Strength Checker', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-hashtag', label: 'Hash Generator (SHA-256)', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      // Network tools
      { icon: 'fa-network-wired', label: 'IP/Subnet Calculator', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-link', label: 'URL Encoder/Decoder', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      // Converters
      { icon: 'fa-exchange-alt', label: 'Base64 Encode/Decode', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-code', label: 'JSON Formatter', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-clock', label: 'Epoch/Date Converter', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-hdd', label: 'Storage Unit Converter', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      // Text tools
      { icon: 'fa-asterisk', label: 'Regex Tester', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-columns', label: 'Text Diff', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-paragraph', label: 'Lorem Ipsum Generator', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      // Reference
      { icon: 'fa-globe', label: 'HTTP Status Codes Reference', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-server', label: 'Port Reference', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      // Converters extra
      { icon: 'fa-file-code', label: 'HTML → Markdown', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-file-alt', label: 'Markdown → HTML', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="tools"]')?.click(), 300); }, section: 'tools' },
      { icon: 'fa-sync-alt', label: i18n.t('common.refresh'), action: () => { if (this._currentPage?.destroy) this._currentPage.destroy(); this._route(); }, shortcut: 'R', section: 'action' },
      { icon: 'fa-broom', label: 'System Prune', action: () => { this.navigate('/system'); setTimeout(() => document.querySelector('[data-tab="prune"]')?.click(), 300); }, section: 'action' },
      { icon: 'fa-download', label: i18n.t('pages.system.checkUpdates'), action: () => { this.navigate('/system'); }, section: 'action' },
      { icon: 'fa-sign-out-alt', label: 'Logout', action: () => this._logout(), section: 'action' },
    ];
    return cmds;
  },

  _showShortcutsHelp() {
    this._showShortcutsOverlay();
  },

  _showShortcutsOverlay() {
    // Remove existing overlay
    document.getElementById('shortcuts-overlay')?.remove();

    const globalShortcuts = [
      { key: 'Ctrl+K', desc: 'Command palette' },
      { key: '?', desc: 'Show this help' },
      { key: '/', desc: 'Focus search' },
      { key: 'R', desc: 'Refresh current page' },
      { key: 'Esc', desc: 'Close modal / overlay' },
      { key: 'g → d', desc: 'Go to Dashboard' },
      { key: 'g → c', desc: 'Go to Containers' },
      { key: 'g → i', desc: 'Go to Images' },
      { key: 'g → v', desc: 'Go to Volumes' },
      { key: 'g → n', desc: 'Go to Networks' },
      { key: 'g → s', desc: 'Go to Stacks' },
      { key: 'g → m', desc: 'Go to Multi-Host' },
      { key: 'g → a', desc: 'Go to Alerts' },
      { key: 'g → h', desc: 'Go to Hosts' },
      { key: 'g → y', desc: 'Go to System' },
      { key: 'g → p', desc: 'Go to Insights' },
    ];

    const containerShortcuts = [
      { key: '↑ / ↓', desc: 'Navigate container rows' },
      { key: 'Enter', desc: 'Open container detail' },
      { key: 'r', desc: 'Restart focused container' },
      { key: 's', desc: 'Start / Stop focused container' },
      { key: 'l', desc: 'Open Logs tab' },
      { key: 'RMB', desc: 'Context menu on any row' },
    ];

    const kbdStyle = 'background:var(--surface3);border:1px solid var(--border);border-radius:3px;padding:1px 6px;font-size:11px;color:var(--text-bright);font-family:var(--mono);min-width:32px;text-align:center;white-space:nowrap';

    const overlay = document.createElement('div');
    overlay.id = 'shortcuts-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10500;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px 32px;max-width:640px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.5)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="margin:0;color:var(--text-bright)"><i class="fas fa-keyboard" style="margin-right:8px;color:var(--accent)"></i>Keyboard Shortcuts</h3>
          <button id="shortcuts-close" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:18px"><i class="fas fa-times"></i></button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
          <div>
            <h4 style="color:var(--accent);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px">Global</h4>
            ${globalShortcuts.map(s => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px;gap:8px">
                <span style="color:var(--text)">${s.desc}</span>
                <kbd style="${kbdStyle}">${s.key}</kbd>
              </div>
            `).join('')}
          </div>
          <div>
            <h4 style="color:var(--accent);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px">Containers Page</h4>
            ${containerShortcuts.map(s => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px;gap:8px">
                <span style="color:var(--text)">${s.desc}</span>
                <kbd style="${kbdStyle}">${s.key}</kbd>
              </div>
            `).join('')}
          </div>
        </div>
        <div style="margin-top:16px;text-align:center;color:var(--text-dim);font-size:11px">
          Press <kbd style="${kbdStyle}">Esc</kbd> or click outside to close &nbsp;·&nbsp; Shortcuts are inactive while typing in an input
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#shortcuts-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
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

    // Build static commands section HTML
    const renderStaticItems = (cmds, offset = 0) => cmds.map((c, i) => `
      <div class="cmd-palette-item ${(offset + i) === this._cmdSelectedIdx ? 'selected' : ''}" data-idx="${offset + i}">
        <i class="fas ${c.icon}"></i>
        <span class="cmd-label">${Utils.escapeHtml(c.label)}</span>
        ${c.shortcut ? `<span class="cmd-shortcut">${c.shortcut}</span>` : ''}
      </div>
    `).join('');

    const wireItems = (container, allCmds) => {
      container.querySelectorAll('.cmd-palette-item').forEach((item) => {
        const idx = parseInt(item.dataset.idx, 10);
        item.addEventListener('click', () => {
          const cmd = allCmds[idx];
          this._closeCommandPalette();
          if (cmd?.action) cmd.action();
        });
        item.addEventListener('mouseenter', () => {
          this._cmdSelectedIdx = idx;
          this._highlightCmd(container.querySelectorAll('.cmd-palette-item'));
        });
      });
    };

    if (commands.length === 0 && (!query || query.length < 2)) {
      results.innerHTML = `<div class="cmd-palette-empty">${i18n.t('cmdPalette.noResults')}</div>`;
      return;
    }

    // Show static commands immediately
    results.innerHTML = commands.length > 0
      ? `<div class="cmd-palette-section-label" style="padding:4px 12px 2px;font-size:10px;text-transform:uppercase;color:var(--text-dim);font-weight:600">Navigation</div>` + renderStaticItems(commands)
      : '';

    wireItems(results, commands);

    // If query is long enough, also do async Docker resource search
    if (query && query.length >= 2) {
      const searchSection = document.createElement('div');
      searchSection.id = 'cmd-search-section';
      searchSection.innerHTML = `<div style="padding:8px 12px;color:var(--text-dim);font-size:12px"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Searching resources...</div>`;
      results.appendChild(searchSection);

      clearTimeout(this._cmdSearchTimer);
      this._cmdSearchTimer = setTimeout(async () => {
        try {
          const data = await Api.globalSearch(query);
          const hits = data.results || [];
          const sec = document.getElementById('cmd-search-section');
          if (!sec) return;

          if (hits.length === 0) {
            if (commands.length === 0) {
              results.innerHTML = `<div class="cmd-palette-empty">${i18n.t('cmdPalette.noResults')}</div>`;
            } else {
              sec.remove();
            }
            return;
          }

          const typeIcons = { container: 'fa-cube', image: 'fa-layer-group', volume: 'fa-database', network: 'fa-network-wired', 'git-stack': 'fa-git-alt', audit: 'fa-clipboard-list' };
          const typeColors = { container: 'var(--accent)', image: 'var(--green)', volume: 'var(--yellow)', network: 'var(--purple, #a855f7)', 'git-stack': 'var(--orange, #f97316)', audit: 'var(--text-dim)' };

          // Group by type
          const grouped = {};
          hits.forEach(r => { (grouped[r.type] = grouped[r.type] || []).push(r); });

          // Build search result commands so keyboard nav still works
          const searchCmds = hits.map(r => ({
            icon: typeIcons[r.type] || 'fa-circle',
            label: r.name || r.id,
            action: () => {
              if (r.url) {
                if (r.url.startsWith('#')) location.hash = r.url;
                else App.navigate(r.url);
              }
            },
          }));

          const baseOffset = commands.length;
          let html = `<div class="cmd-palette-section-label" style="padding:4px 12px 2px;font-size:10px;text-transform:uppercase;color:var(--text-dim);font-weight:600">Resources</div>`;
          let globalIdx = baseOffset;
          Object.entries(grouped).forEach(([type, items]) => {
            html += `<div style="padding:2px 12px 1px;font-size:9px;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.05em">${type}s</div>`;
            items.forEach(r => {
              const icon = typeIcons[type] || 'fa-circle';
              const color = typeColors[type] || 'var(--text-dim)';
              const isSelected = globalIdx === this._cmdSelectedIdx;
              html += `<div class="cmd-palette-item ${isSelected ? 'selected' : ''}" data-idx="${globalIdx}" style="display:flex;align-items:center;gap:8px;padding:7px 12px">
                <i class="fas ${icon}" style="color:${color};width:14px;text-align:center;flex-shrink:0"></i>
                <span class="cmd-label" style="flex:1">${Utils.escapeHtml(r.name || r.id)}</span>
                <span style="font-size:10px;color:var(--text-dim);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis">${Utils.escapeHtml(r.detail || '')}</span>
              </div>`;
              globalIdx++;
            });
          });

          sec.innerHTML = html;

          // Wire only the newly added search result items
          wireItems(sec, searchCmds.map((cmd, i) => ({ ...cmd, _offset: baseOffset + i })));
          // Patch wireItems for search section: use actual searchCmds lookup by (idx - baseOffset)
          sec.querySelectorAll('.cmd-palette-item').forEach(item => {
            const idx = parseInt(item.dataset.idx, 10);
            // Remove and re-add click listener with correct command lookup
            const newItem = item.cloneNode(true);
            item.replaceWith(newItem);
            newItem.addEventListener('click', () => {
              const cmd = searchCmds[idx - baseOffset];
              this._closeCommandPalette();
              if (cmd?.action) cmd.action();
            });
            newItem.addEventListener('mouseenter', () => {
              this._cmdSelectedIdx = idx;
              this._highlightCmd(results.querySelectorAll('.cmd-palette-item'));
            });
          });
        } catch {
          const sec = document.getElementById('cmd-search-section');
          if (sec) sec.remove();
        }
      }, 250);
    }
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
