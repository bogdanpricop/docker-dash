/* ═══════════════════════════════════════════════════
   components/modal.js — Modal Dialog
   ═══════════════════════════════════════════════════ */
'use strict';

const Modal = {
  _overlay: null,
  _content: null,
  _onClose: null,

  _init() {
    if (this._overlay) return;
    this._overlay = document.getElementById('modal-overlay');
    this._content = document.getElementById('modal-content');

    // v8.2.x post-audit a11y: announce modal as a dialog + add aria-modal so
    // screen readers announce the role and trap focus context. Title is
    // resolved per-open via aria-labelledby below.
    this._overlay.setAttribute('role', 'dialog');
    this._overlay.setAttribute('aria-modal', 'true');
    this._content.setAttribute('tabindex', '-1');
    this._content.setAttribute('role', 'document');

    // v8.7.16 a11y fix — start with `inert` so the closed overlay is fully
    // out of the focus/AT tree. inert auto-blurs any focused descendants
    // when set, which solved the "Blocked aria-hidden on an element because
    // its descendant retained focus" console warning that used to fire on
    // close() (we used to setAttribute('aria-hidden', 'true') BEFORE the
    // 300ms close animation finished, while a button inside was still
    // focused). aria-hidden is kept as the legacy fallback for browsers
    // older than Chrome 102 / Firefox 112 / Safari 15.5 (2022 cohort).
    if (this._overlay.classList.contains('hidden')) {
      this._overlay.setAttribute('inert', '');
    }

    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Close sub-modal first if open
        if (this._subOverlay && !this._subOverlay.classList.contains('hidden')) {
          this.closeSub();
          return;
        }
        if (!this._overlay.classList.contains('hidden')) {
          this.close();
        }
      }
    });
  },

  open(html, { width, onClose } = {}) {
    this._init();
    // Save the previously focused element so close() can restore focus —
    // without this, screen readers and keyboard users get dropped to the
    // body element on close.
    this._previouslyFocused = document.activeElement;

    this._content.innerHTML = typeof html === 'string' ? html : '';
    if (typeof html === 'object' && html.nodeType) {
      this._content.innerHTML = '';
      this._content.appendChild(html);
    }
    if (width) this._content.style.maxWidth = width;
    else this._content.style.maxWidth = '';
    this._onClose = onClose || null;

    // Hook the modal's primary heading to aria-labelledby so screen readers
    // announce "Dialog: <title>" instead of "Dialog" naked.
    const heading = this._content.querySelector('.modal-header h3, .modal-header h2');
    if (heading) {
      if (!heading.id) heading.id = 'dd-modal-heading-' + Math.random().toString(36).slice(2, 9);
      this._overlay.setAttribute('aria-labelledby', heading.id);
    } else {
      this._overlay.removeAttribute('aria-labelledby');
    }

    // Mark the close button with aria-label if it has only an icon child.
    const closeBtn = this._content.querySelector('.modal-close-btn');
    if (closeBtn && !closeBtn.getAttribute('aria-label')) {
      closeBtn.setAttribute('aria-label', 'Close dialog');
    }

    this._overlay.classList.remove('hidden');
    this._overlay.removeAttribute('inert');         // v8.7.16 — re-enable interaction + AT tree
    this._overlay.removeAttribute('aria-hidden');   // legacy fallback
    requestAnimationFrame(() => this._overlay.classList.add('modal-visible'));
    // Focus first interactive element
    const firstInput = this._content.querySelector('input, textarea, select, button');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
  },

  close() {
    if (!this._overlay) return;
    this._overlay.classList.remove('modal-visible');
    // v8.7.16 — `inert` auto-blurs any focused descendant BEFORE we hide,
    // which prevents the "aria-hidden on an element whose descendant
    // retained focus" console warning. aria-hidden kept as legacy fallback.
    this._overlay.setAttribute('inert', '');
    this._overlay.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      this._overlay.classList.add('hidden');
      this._content.innerHTML = '';
      if (this._onClose) this._onClose();
      this._onClose = null;
      // v8.2.x post-audit a11y: restore focus to the trigger element
      if (this._previouslyFocused && typeof this._previouslyFocused.focus === 'function') {
        try { this._previouslyFocused.focus(); } catch { /* element may have been removed */ }
      }
      this._previouslyFocused = null;
    }, 200);
  },

  // Convenience: confirmation dialog
  // `onMount(content)` runs once the dialog is in the DOM — the hook that lets a
  // caller attach listeners to its own `html: true` markup without inline
  // handlers, which CSP `script-src-attr 'none'` blocks. Added v8.94.0 for the
  // CLI preview row; optional, so existing callers are unaffected.
  confirm(message, { title, confirmText, danger = false, typeToConfirm, html = false, width = '420px', onMount } = {}) {
    title = title || i18n.t('common.confirm');
    confirmText = confirmText || i18n.t('common.confirm');
    return new Promise((resolve) => {
      const typeBlock = typeToConfirm
        ? `<div style="margin-top:12px"><p class="text-sm" style="color:var(--yellow)">Type <strong>${Utils.escapeHtml(typeToConfirm)}</strong> to confirm:</p><input type="text" class="form-control" id="modal-type-confirm" autocomplete="off" style="margin-top:6px"></div>`
        : '';
      const markup = `
        <div class="modal-header">
          <h3>${Utils.escapeHtml(title)}</h3>
          <button type="button" class="modal-close-btn" id="modal-x" aria-label="Close dialog">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="modal-body">
          <div>${html ? message : `<p>${Utils.escapeHtml(message)}</p>`}</div>
          ${typeBlock}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="modal-cancel">${i18n.t('common.cancel')}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-ok" ${typeToConfirm ? 'disabled' : ''}>
            ${Utils.escapeHtml(confirmText)}
          </button>
        </div>
      `;
      this.open(markup, { width });

      const ok = () => { this.close(); resolve(true); };
      const cancel = () => { this.close(); resolve(false); };

      const okBtn = this._content.querySelector('#modal-ok');
      if (typeToConfirm) {
        const input = this._content.querySelector('#modal-type-confirm');
        input.addEventListener('input', () => {
          okBtn.disabled = input.value !== typeToConfirm;
        });
      }

      okBtn.addEventListener('click', ok);
      this._content.querySelector('#modal-cancel').addEventListener('click', cancel);
      this._content.querySelector('#modal-x').addEventListener('click', cancel);
      if (onMount) { try { onMount(this._content); } catch { /* never block the dialog */ } }
      this._onClose = () => resolve(false);
    });
  },

  // Form dialog: opens with HTML, returns promise resolved with form data or null
  form(html, { title = '', width = '560px', onSubmit, onMount, submitLabel, confirmText } = {}) {
    const submitText = submitLabel || confirmText || i18n.t('common.save');
    const wrapper = `
      <div class="modal-header">
        <h3>${Utils.escapeHtml(title)}</h3>
        <button type="button" class="modal-close-btn" id="modal-x" aria-label="Close dialog">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="modal-body modal-form-body">${html}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="modal-cancel">${i18n.t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" id="modal-submit">${Utils.escapeHtml(submitText)}</button>
      </div>
    `;
    return new Promise((resolve) => {
      this.open(wrapper, { width });

      if (onMount) onMount(this._content);

      this._content.querySelector('#modal-x').addEventListener('click', () => { this.close(); resolve(null); });
      this._content.querySelector('#modal-cancel').addEventListener('click', () => { this.close(); resolve(null); });
      this._content.querySelector('#modal-submit').addEventListener('click', async () => {
        const data = onSubmit ? await onSubmit(this._content) : null;
        if (data !== false) {
          this.close();
          resolve(data);
        }
      });
      this._onClose = () => resolve(null);
    });
  },

  // ─── Stacked Sub-Modal (opens on top of current modal) ───
  _subOverlay: null,
  _subContent: null,
  _subOnClose: null,

  openSub(html, { width } = {}) {
    // Create sub-overlay if not exists
    if (!this._subOverlay) {
      this._subOverlay = document.createElement('div');
      this._subOverlay.id = 'modal-sub-overlay';
      this._subOverlay.className = 'modal-overlay hidden';
      this._subOverlay.style.zIndex = '10001';
      // v8.7.16 a11y fix — sub-overlay was previously missing role/aria-modal
      // (only the primary overlay had them set in _init). Screen readers
      // didn't know a nested dialog had opened. Also start `inert` so the
      // closed sub-overlay is out of the focus/AT tree, matching the
      // primary overlay's lifecycle.
      this._subOverlay.setAttribute('role', 'dialog');
      this._subOverlay.setAttribute('aria-modal', 'true');
      this._subOverlay.setAttribute('inert', '');
      this._subOverlay.setAttribute('aria-hidden', 'true');
      const content = document.createElement('div');
      content.id = 'modal-sub-content';
      content.className = 'modal-content';
      this._subOverlay.appendChild(content);
      document.body.appendChild(this._subOverlay);
      this._subOverlay.addEventListener('click', (e) => {
        if (e.target === this._subOverlay) this.closeSub();
      });
    }
    this._subContent = this._subOverlay.querySelector('#modal-sub-content');
    this._subContent.innerHTML = typeof html === 'string' ? html : '';
    if (width) this._subContent.style.maxWidth = width;
    else this._subContent.style.maxWidth = '';
    this._subOverlay.classList.remove('hidden');
    this._subOverlay.removeAttribute('inert');           // v8.7.16
    this._subOverlay.removeAttribute('aria-hidden');
    requestAnimationFrame(() => this._subOverlay.classList.add('modal-visible'));
    const firstInput = this._subContent.querySelector('input, textarea, select, button');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
    return this._subContent;
  },

  // Confirmation displayed above an existing form/dialog. Using the primary
  // confirm() here would replace the parent modal and discard its state.
  confirmSub(message, { title, confirmText, danger = false, typeToConfirm, html = false, width = '420px' } = {}) {
    title = title || i18n.t('common.confirm');
    confirmText = confirmText || i18n.t('common.confirm');
    return new Promise((resolve) => {
      const typeBlock = typeToConfirm
        ? `<div style="margin-top:12px"><p class="text-sm" style="color:var(--yellow)">Type <strong>${Utils.escapeHtml(typeToConfirm)}</strong> to confirm:</p><input type="text" class="form-control" id="modal-sub-type-confirm" autocomplete="off" style="margin-top:6px"></div>`
        : '';
      const content = this.openSub(`
        <div class="modal-header">
          <h3>${Utils.escapeHtml(title)}</h3>
          <button class="modal-close-btn" id="modal-sub-x" aria-label="Close dialog"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div>${html ? message : `<p>${Utils.escapeHtml(message)}</p>`}</div>
          ${typeBlock}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-sub-cancel">${i18n.t('common.cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-sub-ok" ${typeToConfirm ? 'disabled' : ''}>${Utils.escapeHtml(confirmText)}</button>
        </div>
      `, { width });

      const finish = (answer) => {
        this._subOnClose = null;
        this.closeSub();
        resolve(answer);
      };
      const okBtn = content.querySelector('#modal-sub-ok');
      if (typeToConfirm) {
        const input = content.querySelector('#modal-sub-type-confirm');
        input.addEventListener('input', () => { okBtn.disabled = input.value !== typeToConfirm; });
      }
      okBtn.addEventListener('click', () => finish(true));
      content.querySelector('#modal-sub-cancel').addEventListener('click', () => finish(false));
      content.querySelector('#modal-sub-x').addEventListener('click', () => finish(false));
      this._subOnClose = () => resolve(false);
    });
  },

  closeSub() {
    if (!this._subOverlay) return;
    this._subOverlay.classList.remove('modal-visible');
    // v8.7.16 — `inert` auto-blurs focused descendants BEFORE the close
    // animation finishes (mirrors the primary close()).
    this._subOverlay.setAttribute('inert', '');
    this._subOverlay.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      this._subOverlay.classList.add('hidden');
      if (this._subContent) this._subContent.innerHTML = '';
      const onClose = this._subOnClose;
      this._subOnClose = null;
      if (onClose) onClose();
    }, 200);
  },
};

window.Modal = Modal;
