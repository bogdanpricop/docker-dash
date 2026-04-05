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
    this._content.innerHTML = typeof html === 'string' ? html : '';
    if (typeof html === 'object' && html.nodeType) {
      this._content.innerHTML = '';
      this._content.appendChild(html);
    }
    if (width) this._content.style.maxWidth = width;
    else this._content.style.maxWidth = '';
    this._onClose = onClose || null;
    this._overlay.classList.remove('hidden');
    requestAnimationFrame(() => this._overlay.classList.add('modal-visible'));
    // Focus first input
    const firstInput = this._content.querySelector('input, textarea, select, button');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
  },

  close() {
    if (!this._overlay) return;
    this._overlay.classList.remove('modal-visible');
    setTimeout(() => {
      this._overlay.classList.add('hidden');
      this._content.innerHTML = '';
      if (this._onClose) this._onClose();
      this._onClose = null;
    }, 200);
  },

  // Convenience: confirmation dialog
  confirm(message, { title, confirmText, danger = false, typeToConfirm } = {}) {
    title = title || i18n.t('common.confirm');
    confirmText = confirmText || i18n.t('common.confirm');
    return new Promise((resolve) => {
      const typeBlock = typeToConfirm
        ? `<div style="margin-top:12px"><p class="text-sm" style="color:var(--yellow)">Type <strong>${Utils.escapeHtml(typeToConfirm)}</strong> to confirm:</p><input type="text" class="form-control" id="modal-type-confirm" autocomplete="off" style="margin-top:6px"></div>`
        : '';
      const html = `
        <div class="modal-header">
          <h3>${Utils.escapeHtml(title)}</h3>
          <button class="modal-close-btn" id="modal-x">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="modal-body">
          <p>${Utils.escapeHtml(message)}</p>
          ${typeBlock}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">${i18n.t('common.cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-ok" ${typeToConfirm ? 'disabled' : ''}>
            ${Utils.escapeHtml(confirmText)}
          </button>
        </div>
      `;
      this.open(html, { width: '420px' });

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
      this._onClose = () => resolve(false);
    });
  },

  // Form dialog: opens with HTML, returns promise resolved with form data or null
  form(html, { title = '', width = '560px', onSubmit, onMount } = {}) {
    const wrapper = `
      <div class="modal-header">
        <h3>${Utils.escapeHtml(title)}</h3>
        <button class="modal-close-btn" id="modal-x">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="modal-body">${html}</div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modal-cancel">${i18n.t('common.cancel')}</button>
        <button class="btn btn-primary" id="modal-submit">${i18n.t('common.save')}</button>
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

  openSub(html, { width } = {}) {
    // Create sub-overlay if not exists
    if (!this._subOverlay) {
      this._subOverlay = document.createElement('div');
      this._subOverlay.id = 'modal-sub-overlay';
      this._subOverlay.className = 'modal-overlay hidden';
      this._subOverlay.style.zIndex = '10001';
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
    requestAnimationFrame(() => this._subOverlay.classList.add('modal-visible'));
    const firstInput = this._subContent.querySelector('input, textarea, select, button');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
    return this._subContent;
  },

  closeSub() {
    if (!this._subOverlay) return;
    this._subOverlay.classList.remove('modal-visible');
    setTimeout(() => {
      this._subOverlay.classList.add('hidden');
      if (this._subContent) this._subContent.innerHTML = '';
    }, 200);
  },
};

window.Modal = Modal;
