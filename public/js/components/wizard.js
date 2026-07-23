/* ═══════════════════════════════════════════════════
   components/wizard.js — Wizard shell primitive (v8.15.0)
   ═══════════════════════════════════════════════════ */
'use strict';

// The ONE new shared UI primitive for the Onboarding & Provisioning Wizard
// (plans/onboarding-ux.md §1.2). A thin, framework-free state machine +
// full-viewport shell renderer — NOT a form library and NOT domain-aware.
// It owns: step navigation, the stepper rail (+ mobile segmented progress
// bar), the sticky footer (Back/Next/Save & exit), per-step validation
// gating, focus management (heading-first), and a debounced persist hook.
// Each step supplies its own render()/validate() — Wizard never touches
// onboarding fields directly.
//
// Wizard.open({ steps, state, runId, tenantId, startIndex, persist, onFinish,
//               onExit, title, pill, banner })
//   steps[]  = { key, title, help, icon, active(state), optional(state),
//                render(bodyEl, state, wiz), validate(state) -> {ok,errors,warnings},
//                onEnter(state, wiz), onLeave(state), footer(state) -> {
//                  hideBack, hideNext, hideSaveExit, nextDisabled, nextLabel } }
//   pill(state)   -> { text, className } | null   (header mode pill; optional)
//   banner(state) -> html string | null            (persistent banner strip; optional)
//
// Re-render loop mirrors the codebase's existing bespoke wizards
// (pages/ssh-key-deployer.js `_render()`, app.js `_showOnboardingWizard`
// `render()`): clear body -> step.render() -> wire listeners.

const Wizard = {
  _overlay: null,
  _els: {},
  _steps: [],
  _state: null,
  _stepIndex: 0,
  _visited: {},
  _runId: null,
  _tenantId: null,
  _persist: null,
  _onFinish: null,
  _onExit: null,
  _title: '',
  _pillFn: null,
  _bannerFn: null,
  _persistTimer: null,
  _keydownHandler: null,
  _renderToken: 0,

  open(config) {
    this.close(); // defensive: never stack two wizard overlays
    this._steps = (config && config.steps) || [];
    this._state = (config && config.state) || {};
    this._runId = (config && config.runId) || null;
    this._tenantId = (config && config.tenantId) || null;
    this._persist = typeof (config && config.persist) === 'function' ? config.persist : null;
    this._onFinish = typeof (config && config.onFinish) === 'function' ? config.onFinish : () => {};
    this._onExit = typeof (config && config.onExit) === 'function' ? config.onExit : () => {};
    this._title = (config && config.title) || i18n.t('pages.onboarding.shell.title');
    this._pillFn = typeof (config && config.pill) === 'function' ? config.pill : null;
    this._bannerFn = typeof (config && config.banner) === 'function' ? config.banner : null;
    this._visited = {};

    this._buildShell();

    const active = this._activeSteps();
    let idx = 0;
    const start = config && config.startIndex;
    if (typeof start === 'number') idx = start;
    else if (typeof start === 'string') {
      const found = active.findIndex((s) => s.key === start);
      if (found >= 0) idx = found;
    }
    this._stepIndex = Math.max(0, Math.min(idx, active.length - 1));
    this._render();
  },

  close() {
    if (this._keydownHandler) { document.removeEventListener('keydown', this._keydownHandler); this._keydownHandler = null; }
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (this._overlay) { this._overlay.remove(); this._overlay = null; }
  },

  // Steps read/mutate this directly (passed by reference into render/validate).
  get state() { return this._state; },
  get runId() { return this._runId; },
  set runId(v) { this._runId = v; },

  /** Force a full re-render of the current step (e.g. after async row updates). */
  render() { this._render(); },
  next() { return this._next(); },
  back() { return this._back(); },
  saveExit() { return this._saveExit(); },
  /** Jump straight to a step by key without validating (used by resume flows). */
  goTo(key) {
    const active = this._activeSteps();
    const found = active.findIndex((s) => s.key === key);
    if (found < 0) return;
    this._stepIndex = found;
    this._render();
  },

  // ── shell scaffold ──────────────────────────────────────────────────────
  _buildShell() {
    const overlay = document.createElement('div');
    overlay.className = 'wiz-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="wiz-shell">
        <div class="wiz-banner" id="wiz-banner" style="display:none"></div>
        <div class="wiz-header">
          <div class="wiz-header-title">
            <i class="fas fa-rocket"></i>
            <h1 id="wiz-heading-title">${Utils.escapeHtml(this._title)}</h1>
            <span class="badge" id="wiz-mode-pill" style="display:none"></span>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" id="wiz-save-exit">
            <i class="fas fa-right-from-bracket"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.shell.saveExit'))}
          </button>
        </div>
        <div class="wiz-progress" id="wiz-progress" role="progressbar" aria-valuemin="1"></div>
        <div class="wiz-body-row">
          <ol class="wiz-rail" id="wiz-rail"></ol>
          <div class="wiz-body" id="wiz-body"></div>
        </div>
        <div class="wiz-footer" id="wiz-footer">
          <button type="button" class="btn btn-secondary" id="wiz-back">
            <i class="fas fa-arrow-left"></i> ${Utils.escapeHtml(i18n.t('pages.onboarding.shell.back'))}
          </button>
          <div class="wiz-step-counter" id="wiz-step-counter"></div>
          <button type="button" class="btn btn-secondary" id="wiz-skip" style="display:none">
            ${Utils.escapeHtml(i18n.t('pages.onboarding.shell.skip'))}
          </button>
          <button type="button" class="btn btn-primary" id="wiz-next">
            ${Utils.escapeHtml(i18n.t('pages.onboarding.shell.next'))} <i class="fas fa-arrow-right"></i>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._els = {
      banner: overlay.querySelector('#wiz-banner'),
      title: overlay.querySelector('#wiz-heading-title'),
      modePill: overlay.querySelector('#wiz-mode-pill'),
      progress: overlay.querySelector('#wiz-progress'),
      rail: overlay.querySelector('#wiz-rail'),
      body: overlay.querySelector('#wiz-body'),
      footer: overlay.querySelector('#wiz-footer'),
      back: overlay.querySelector('#wiz-back'),
      next: overlay.querySelector('#wiz-next'),
      saveExit: overlay.querySelector('#wiz-save-exit'),
      stepCounter: overlay.querySelector('#wiz-step-counter'),
      skip: overlay.querySelector('#wiz-skip'),
    };
    overlay.setAttribute('aria-labelledby', 'wiz-heading-title');

    this._els.back.addEventListener('click', () => this._back());
    this._els.next.addEventListener('click', () => this._next());
    this._els.saveExit.addEventListener('click', () => this._saveExit());
    this._els.skip.addEventListener('click', () => this._skip());

    // Esc focuses Save & exit instead of closing (deliberate — mirrors
    // _showSetupWizard's "no accidental abandon" behaviour, plans/onboarding-ux.md §5.1).
    this._keydownHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._els.saveExit.focus(); }
    };
    document.addEventListener('keydown', this._keydownHandler);
  },

  // ── step bookkeeping ─────────────────────────────────────────────────────
  _activeSteps() {
    return this._steps.filter((s) => typeof s.active !== 'function' || s.active(this._state));
  },
  _currentStep() { return this._activeSteps()[this._stepIndex]; },

  _stepApi() {
    return {
      state: this._state,
      runId: this._runId,
      tenantId: this._tenantId,
      next: () => this._next(),
      back: () => this._back(),
      render: () => this._render(),
      goTo: (key) => this.goTo(key),
      schedulePersist: () => this._schedulePersist(),
      setRunId: (id) => { this._runId = id; },
    };
  },

  // ── main render loop ─────────────────────────────────────────────────────
  async _render() {
    const token = ++this._renderToken;
    const steps = this._activeSteps();
    const step = steps[this._stepIndex];
    if (!step || !this._overlay) return;

    // Mode pill + banner (domain-supplied, kept optional so Wizard itself
    // stays domain-agnostic).
    if (this._pillFn) {
      const pill = this._pillFn(this._state);
      if (pill && pill.text) {
        this._els.modePill.textContent = pill.text;
        this._els.modePill.className = `badge ${pill.className || ''}`;
        this._els.modePill.style.display = '';
      } else {
        this._els.modePill.style.display = 'none';
      }
    }
    if (this._bannerFn) {
      const html = this._bannerFn(this._state);
      if (html) { this._els.banner.innerHTML = html; this._els.banner.style.display = ''; }
      else { this._els.banner.style.display = 'none'; this._els.banner.innerHTML = ''; }
    }

    // Segmented mobile progress bar + a11y progressbar attrs.
    this._els.progress.setAttribute('aria-valuenow', String(this._stepIndex + 1));
    this._els.progress.setAttribute('aria-valuemax', String(steps.length));
    this._els.progress.innerHTML = steps.map((s, i) => {
      const cls = i < this._stepIndex ? 'is-done' : i === this._stepIndex ? 'is-active' : '';
      return `<span class="wiz-progress-seg ${cls}"></span>`;
    }).join('');

    // Rail.
    this._els.rail.innerHTML = steps.map((s, i) => {
      let statusClass = this._visited[s.key] ? `is-${this._visited[s.key]}` : '';
      if (i === this._stepIndex) statusClass = 'is-active';
      const clickable = i < this._stepIndex;
      const glyph = i === this._stepIndex ? '●'
        : this._visited[s.key] === 'error' ? '✕'
        : this._visited[s.key] === 'warn' ? '⚠'
        : this._visited[s.key] === 'done' ? '✓' : '○';
      const label = i18n.t('pages.onboarding.shell.railLabel', { n: i + 1, title: s.title, state: statusClass ? statusClass.replace('is-', '') : 'pending' });
      return `<li class="wiz-rail-item ${statusClass}" data-idx="${i}" ${clickable ? '' : 'aria-disabled="true"'}
                ${i === this._stepIndex ? 'aria-current="step"' : ''} aria-label="${Utils.escapeHtml(label)}" tabindex="${clickable ? '0' : '-1'}">
                <span class="wiz-rail-glyph">${glyph}</span><span class="wiz-rail-text">${Utils.escapeHtml(s.title)}</span>
              </li>`;
    }).join('');
    this._els.rail.querySelectorAll('.wiz-rail-item').forEach((li) => {
      const i = parseInt(li.getAttribute('data-idx'), 10);
      if (i >= this._stepIndex) return; // future/current: not clickable
      const jump = () => { this._stepIndex = i; this._render(); };
      li.addEventListener('click', jump);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
    });

    // Body.
    this._els.body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wiz-step';
    wrap.innerHTML = `
      <h2 class="wiz-step-title" id="wiz-step-heading" tabindex="-1">${Utils.escapeHtml(step.title)}</h2>
      ${step.help ? `<p class="wiz-step-help">${Utils.escapeHtml(step.help)}</p>` : ''}
      <div id="wiz-step-messages" aria-live="polite"></div>
      <div class="wiz-step-body" id="wiz-step-body"></div>
    `;
    this._els.body.appendChild(wrap);
    const stepBodyEl = wrap.querySelector('#wiz-step-body');

    if (typeof step.onEnter === 'function') {
      try { await step.onEnter(this._state, this._stepApi()); } catch (err) { console.error('[Wizard] onEnter failed:', err.message); }
    }
    if (token !== this._renderToken) return; // superseded by a newer render
    try { step.render(stepBodyEl, this._state, this._stepApi()); } catch (err) {
      stepBodyEl.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }

    // Debounced persist on any edit within the step body.
    stepBodyEl.addEventListener('input', () => this._schedulePersist());
    stepBodyEl.addEventListener('change', () => this._schedulePersist());

    // Footer per-step overrides.
    const cfg = (typeof step.footer === 'function') ? (step.footer(this._state) || {}) : {};
    this._els.back.style.display = (this._stepIndex === 0 || cfg.hideBack) ? 'none' : '';
    this._els.next.style.display = cfg.hideNext ? 'none' : '';
    this._els.next.disabled = !!cfg.nextDisabled;
    const isLast = this._stepIndex === steps.length - 1;
    const nextLabel = cfg.nextLabel || (isLast ? i18n.t('pages.onboarding.shell.finish') : i18n.t('pages.onboarding.shell.next'));
    this._els.next.innerHTML = `${Utils.escapeHtml(nextLabel)} <i class="fas fa-arrow-right"></i>`;
    this._els.saveExit.style.display = cfg.hideSaveExit ? 'none' : '';
    this._els.stepCounter.textContent = i18n.t('pages.onboarding.shell.stepCounter', { current: this._stepIndex + 1, total: steps.length });
    const isOptional = typeof step.optional === 'function' && step.optional(this._state) && this._visited[step.key] !== 'done';
    this._els.skip.style.display = (isOptional && !cfg.hideNext) ? '' : 'none';

    // Focus the heading (screen-reader step announcement), unless the step
    // asked to keep focus where it is (e.g. mid-typing after a live update).
    if (!cfg.keepFocus) {
      const heading = wrap.querySelector('#wiz-step-heading');
      if (heading) setTimeout(() => { try { heading.focus(); } catch { /* detached */ } }, 20);
    }
  },

  // ── navigation ───────────────────────────────────────────────────────────
  async _next() {
    const step = this._currentStep();
    if (!step) return;
    this._els.next.disabled = true;
    try {
      const result = (typeof step.validate === 'function') ? await step.validate(this._state) : { ok: true };
      if (!result || result.ok === false) {
        this._visited[step.key] = 'error';
        this._showMessages((result && result.errors) || [i18n.t('pages.onboarding.errors.generic')], 'error');
        this._focusFirstInvalid();
        this._paintRailStatus();
        return;
      }
      if (result.warnings && result.warnings.length) {
        this._visited[step.key] = 'warn';
        this._showMessages(result.warnings, 'warning');
      } else {
        this._visited[step.key] = 'done';
        this._showMessages([], 'warning');
      }
      this._paintRailStatus();
      if (typeof step.onLeave === 'function') { try { await step.onLeave(this._state); } catch { /* non-fatal */ } }
      await this._persistNow();

      const steps = this._activeSteps();
      if (this._stepIndex < steps.length - 1) {
        this._stepIndex++;
        await this._render();
      } else {
        this._onFinish(this._state);
      }
    } finally {
      this._els.next.disabled = false;
    }
  },

  _back() {
    if (this._stepIndex === 0) return;
    this._stepIndex--;
    this._render();
  },

  /** Bypass validate() entirely for a step marked optional(state) === true. */
  async _skip() {
    const step = this._currentStep();
    if (!step) return;
    this._visited[step.key] = 'warn';
    await this._persistNow();
    const steps = this._activeSteps();
    if (this._stepIndex < steps.length - 1) { this._stepIndex++; await this._render(); }
    else { this._onFinish(this._state); }
  },

  async _saveExit() {
    await this._persistNow();
    const state = this._state;
    this.close();
    this._onExit(state);
  },

  _paintRailStatus() {
    const li = this._els.rail.querySelector(`[data-idx="${this._stepIndex}"]`);
    if (!li) return;
    const status = this._visited[this._currentStep().key];
    li.classList.remove('is-error', 'is-warn', 'is-done');
    if (status) li.classList.add(`is-${status}`);
  },

  _showMessages(list, kind) {
    const el = this._overlay && this._overlay.querySelector('#wiz-step-messages');
    if (!el) return;
    if (!list || !list.length) { el.innerHTML = ''; return; }
    const isError = kind === 'error';
    const color = isError ? 'var(--red)' : 'var(--yellow)';
    const icon = isError ? 'fa-circle-exclamation' : 'fa-triangle-exclamation';
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.innerHTML = `
      <div class="wiz-msg-box" style="border-left:3px solid ${color};background:${isError ? 'var(--red-dim)' : 'var(--yellow-dim)'}">
        ${list.map((m) => `<div style="color:${color}"><i class="fas ${icon}"></i> ${Utils.escapeHtml(m)}</div>`).join('')}
      </div>
    `;
  },

  _focusFirstInvalid() {
    const body = this._overlay && this._overlay.querySelector('#wiz-step-body');
    if (!body) return;
    const invalid = body.querySelector('.is-invalid, [aria-invalid="true"]');
    if (invalid) { try { invalid.focus(); } catch { /* ignore */ } return; }
    const msgs = this._overlay.querySelector('#wiz-step-messages');
    if (msgs) { msgs.setAttribute('tabindex', '-1'); try { msgs.focus(); } catch { /* ignore */ } }
  },

  // ── persistence (debounced 800ms + on-Next + on Save&exit) ──────────────
  _schedulePersist() {
    if (!this._persist) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._persistNow(), 800);
  },
  async _persistNow() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (!this._persist) return;
    try { await this._persist(this._state, this._stepIndex); } catch (err) { console.warn('[Wizard] persist failed:', err.message); }
  },
};

window.Wizard = Wizard;
