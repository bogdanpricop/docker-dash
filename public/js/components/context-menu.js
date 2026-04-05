'use strict';

const ContextMenu = {
  _el: null,

  show(event, items) {
    event.preventDefault();
    event.stopPropagation();
    this.hide();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = items.map(item => {
      if (item.type === 'separator') return '<div class="context-menu-sep"></div>';
      const disabledClass = item.disabled ? ' disabled' : '';
      const dangerClass = item.danger ? ' danger' : '';
      return `<div class="context-menu-item${disabledClass}${dangerClass}" data-action="${item.id || ''}">
        <i class="fas ${item.icon || 'fa-circle'}" style="width:16px;text-align:center;margin-right:8px;font-size:12px"></i>
        <span>${Utils.escapeHtml(item.label)}</span>
        ${item.shortcut ? `<span class="context-menu-shortcut">${item.shortcut}</span>` : ''}
      </div>`;
    }).join('');

    document.body.appendChild(menu);
    this._el = menu;

    // Position: try to keep in viewport
    const x = Math.min(event.clientX, window.innerWidth - 220);
    const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Wire click handlers
    menu.querySelectorAll('.context-menu-item:not(.disabled)').forEach((el, i) => {
      el.addEventListener('click', () => {
        this.hide();
        // find the matching non-separator item
        const actionItems = items.filter(it => it.type !== 'separator');
        if (actionItems[i]?.action) actionItems[i].action();
      });
    });

    // Close on click outside or Escape
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) { this.hide(); document.removeEventListener('mousedown', closeHandler); }
    };
    const escHandler = (e) => {
      if (e.key === 'Escape') { this.hide(); document.removeEventListener('keydown', escHandler); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', closeHandler);
      document.addEventListener('keydown', escHandler);
    }, 0);
  },

  hide() {
    if (this._el) { this._el.remove(); this._el = null; }
  },
};

window.ContextMenu = ContextMenu;
