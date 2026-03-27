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
      if (e.key === 'Escape' && !this._overlay.classList.contains('hidden')) {
        this.close();
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
  confirm(message, { title, confirmText, danger = false } = {}) {
    title = title || i18n.t('common.confirm');
    confirmText = confirmText || i18n.t('common.confirm');
    return new Promise((resolve) => {
      const html = `
        <div class="modal-header">
          <h3>${Utils.escapeHtml(title)}</h3>
          <button class="modal-close-btn" id="modal-x">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="modal-body">
          <p>${Utils.escapeHtml(message)}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">${i18n.t('common.cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-ok">
            ${Utils.escapeHtml(confirmText)}
          </button>
        </div>
      `;
      this.open(html, { width: '420px' });

      const ok = () => { this.close(); resolve(true); };
      const cancel = () => { this.close(); resolve(false); };

      this._content.querySelector('#modal-ok').addEventListener('click', ok);
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
};

window.Modal = Modal;
