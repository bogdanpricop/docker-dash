/* Account-specific shortcuts in the sidebar. Moving the original anchors
   keeps live badges, active-route styles and host availability attached. */
'use strict';

const NavPins = {
  _pages: [],
  _moved: [],
  _session: null,

  init(user) {
    this.reset();
    if (user?.id == null) return;
    const storageKey = 'dd-pinned-nav:account:' + user.id;
    this._session = { user, storageKey, revision: 0, pending: Promise.resolve() };
    try {
      this._pages = this._decode(localStorage.getItem(storageKey)) || [];
    } catch { /* storage unavailable */ }
    this._bindNavEvents();
    this.apply();
  },

  snapshot() {
    const session = this._session;
    return session && { session, revision: session.revision };
  },

  _isCurrent(snapshot) {
    return Boolean(snapshot && this._session === snapshot.session &&
      App.user === snapshot.session.user && snapshot.session.revision === snapshot.revision);
  },

  setFromServer(raw, snapshot) {
    // A response may arrive after a local edit or after the account changed.
    if (!this._isCurrent(snapshot)) return;
    const pages = raw === undefined ? [] : this._decode(raw);
    if (!pages || JSON.stringify(pages) === JSON.stringify(this._pages)) return;
    this._pages = pages;
    this._writeLocal(snapshot.session, JSON.stringify(pages));
    this.apply();
    this._renderManagerLists();
  },

  reset() {
    this._session = null;
    this._pages = [];
    this._restoreMoved();
    document.getElementById('nav-pinned')?.remove();
    if (document.getElementById('nav-pin-pinned-list')) Modal.close();
  },

  isPinned(page) {
    return this._pages.includes(page);
  },

  toggle(page) {
    if (!this._session || !this._isSafePage(page)) return;
    const idx = this._pages.indexOf(page);
    if (idx >= 0) this._pages.splice(idx, 1);
    else this._pages.push(page);
    this._save();
    this.apply();
  },

  _isSafePage(page) {
    return typeof page === 'string' && /^[a-z0-9-]+$/.test(page);
  },

  _decode(raw) {
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw);
      const pages = Array.isArray(value) ? value : value?.pages;
      if (!Array.isArray(pages)) return null;
      return [...new Set(pages.filter(page => this._isSafePage(page)))];
    } catch {
      return null;
    }
  },

  _writeLocal(session, value) {
    try {
      localStorage.setItem(session.storageKey, value);
    } catch { /* storage unavailable */ }
  },

  _save() {
    const session = this._session;
    const revision = ++session.revision;
    const snapshot = { session, revision };
    const value = JSON.stringify(this._pages);
    this._writeLocal(session, value);

    // Send one write at a time so a delayed request cannot restore an older
    // order. Skip intermediate snapshots and writes from a previous login.
    session.pending = session.pending.then(async () => {
      if (!this._isCurrent(snapshot)) return;
      try {
        await Api.saveUserPreference('pinnedNav', value);
      } catch {
        if (this._isCurrent(snapshot)) Toast.error(i18n.t('nav.pinnedSyncFailed'));
      }
    });
  },

  // ─── Rendering ───────────────────────────────────

  /**
   * Move the pinned entries into the "Pinned" container at the top of the
   * sidebar navigation.
   *
   * Called right after the sidebar markup is (re)built — standard, compose
   * simple or enterprise layout — so every layout ends up with the same
   * pinned block.
   */
  apply() {
    if (!this._session) return;
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;

    this._restoreMoved();

    const pinned = this._pages
      .map(page => this._findNavItem(page))
      .filter(Boolean);

    const body = nav.querySelector('#nav-pinned-body') || this._createSection(nav);

    // Capture home positions before moving anchors that may be siblings.
    const order = [...nav.querySelectorAll('.nav-item[data-page]')];
    for (const item of pinned) {
      item._pinnedHome = { parent: item.parentNode, next: item.nextSibling };
      item._pinnedOrder = order.indexOf(item);
    }
    for (const item of pinned) body.appendChild(item);
    this._moved = pinned;
    this.updateAvailability();
  },

  _createSection(nav) {
    const section = document.createElement('div');
    section.className = 'nav-pinned';
    section.id = 'nav-pinned';
    section.setAttribute('role', 'group');

    const head = document.createElement('div');
    head.className = 'nav-pinned-head';

    const label = document.createElement('span');
    label.className = 'nav-pinned-label';
    label.id = 'nav-pinned-label';
    head.appendChild(label);

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'nav-pinned-manage';
    manage.id = 'nav-pinned-manage';
    manage.innerHTML = '<i class="fas fa-pen-to-square" aria-hidden="true"></i>';
    manage.addEventListener('click', () => this.openManager());
    head.appendChild(manage);

    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nav-pinned-body';
    body.id = 'nav-pinned-body';
    const empty = document.createElement('div');
    empty.className = 'nav-pinned-empty';
    body.appendChild(empty);
    section.appendChild(body);

    nav.insertBefore(section, nav.firstChild);

    this.updateLabels();
    return body;
  },

  updateLabels() {
    const section = document.getElementById('nav-pinned');
    if (!section) return;
    section.setAttribute('aria-label', i18n.t('nav.pinned'));
    section.querySelector('#nav-pinned-label').textContent = i18n.t('nav.pinned');
    const manage = section.querySelector('#nav-pinned-manage');
    manage.title = i18n.t('nav.pinnedManage');
    manage.setAttribute('aria-label', manage.title);
    section.querySelector('.nav-pinned-empty').textContent = i18n.t('nav.pinnedEmpty');
  },

  updateAvailability() {
    const empty = document.querySelector('#nav-pinned .nav-pinned-empty');
    if (empty) empty.hidden = this._moved.some(item => getComputedStyle(item).display !== 'none');
  },

  /**
   * Put previously moved entries back where they came from.
   *
   * Restored in reverse document order: an entry recorded the sibling that
   * followed it, and that sibling may itself be a pinned entry. Undoing the
   * right-most move first guarantees the reference sibling is back in place
   * whenever it is used as the insertion point.
   */
  _restoreMoved() {
    const moved = this._moved
      .filter(item => item && item.isConnected && item._pinnedHome)
      .sort((a, b) => (b._pinnedOrder ?? 0) - (a._pinnedOrder ?? 0));

    for (const item of moved) {
      const home = item._pinnedHome;
      if (home.parent && home.parent.isConnected) {
        if (home.next && home.next.parentNode === home.parent) {
          home.parent.insertBefore(item, home.next);
        } else {
          home.parent.appendChild(item);
        }
      }
      delete item._pinnedHome;
      delete item._pinnedOrder;
    }
    this._moved = [];
  },

  _findNavItem(page) {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return null;
    return nav.querySelector(`.nav-item[data-page="${page}"]`);
  },

  // ─── Events ──────────────────────────────────────

  _bindNavEvents() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav || nav._navPinsBound) return;
    nav._navPinsBound = true;

    // Right-click a navigation entry to pin or unpin it. Delegated on the
    // container so it survives every sidebar rebuild.
    nav.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.nav-item[data-page]');
      const session = this._session;
      if (!item || !session) return;
      const page = item.getAttribute('data-page');
      if (!this._isSafePage(page)) return;
      e.preventDefault();
      const pinned = this.isPinned(page);
      ContextMenu.show(e, [
        {
          label: pinned ? i18n.t('nav.unpinAction') : i18n.t('nav.pinAction'),
          icon: 'fa-thumb-tack',
          action: () => { if (this._session === session) this.toggle(page); },
        },
        { type: 'separator' },
        {
          label: i18n.t('nav.pinnedManage'),
          icon: 'fa-pen-to-square',
          action: () => { if (this._session === session) this.openManager(); },
        },
      ]);
    });
  },

  // ─── Manager modal ───────────────────────────────

  /**
   * List the navigation entries and let the operator pin, unpin and reorder
   * them. Keyboard reachable, unlike the right-click shortcut.
   *
   * The modal is split in two: the pinned entries at the top — draggable to
   * change their order — and every other entry below.
   */
  openManager() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav || !this._session) return;

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-thumb-tack" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(i18n.t('nav.pinnedManage'))}</h3>
        <button type="button" class="modal-close-btn" id="modal-x" aria-label="Close dialog"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p class="text-sm text-muted" style="margin-bottom:12px">${Utils.escapeHtml(i18n.t('nav.pinnedHint'))}</p>
        <div class="nav-pin-section">
          <div class="nav-pin-section-label" id="nav-pin-pinned-label">${Utils.escapeHtml(i18n.t('nav.pinned'))}</div>
          <p class="text-sm text-muted nav-pin-order-hint" id="nav-pin-order-hint">${Utils.escapeHtml(i18n.t('nav.pinnedOrderHint'))}</p>
          <div class="nav-pin-list" id="nav-pin-pinned-list" role="list" aria-labelledby="nav-pin-pinned-label"></div>
        </div>
        <div class="nav-pin-section">
          <div class="nav-pin-section-label" id="nav-pin-other-label">${Utils.escapeHtml(i18n.t('nav.pinnedOthers'))}</div>
          <div class="nav-pin-list nav-pin-list-scroll" id="nav-pin-other-list" role="list" aria-labelledby="nav-pin-other-label"></div>
        </div>
        <div class="sr-only" id="nav-pin-live" role="status" aria-live="polite"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="modal-ok">${Utils.escapeHtml(i18n.t('common.close'))}</button>
      </div>
    `, { width: '520px' });

    const content = Modal._content;
    content.querySelector('#modal-x')?.addEventListener('click', () => Modal.close());
    content.querySelector('#modal-ok')?.addEventListener('click', () => Modal.close());
    this._renderManagerLists();
    this._bindManagerEvents();
  },

  /**
   * Every navigation entry the operator can pin, in sidebar order.
   * Entries hidden by capability or daemon gating are not pinnable.
   */
  _collectEntries() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return [];
    const seen = new Set();
    const entries = [];
    for (const el of nav.querySelectorAll('.nav-item[data-page]')) {
      const page = el.getAttribute('data-page');
      if (!this._isSafePage(page) || seen.has(page)) continue;
      if (getComputedStyle(el).display === 'none') continue;
      seen.add(page);
      const icon = el.querySelector('i');
      const text = el.querySelector('span');
      entries.push({
        page,
        iconClass: icon ? icon.className : 'fas fa-circle',
        name: text ? text.textContent.trim() : page,
      });
    }
    return entries;
  },

  /** Fill the pinned and the other list of the manager modal. */
  _renderManagerLists() {
    const content = Modal._content;
    if (!content) return;
    const pinnedList = content.querySelector('#nav-pin-pinned-list');
    const otherList = content.querySelector('#nav-pin-other-list');
    if (!pinnedList || !otherList) return;

    const entries = this._collectEntries();
    // The pinned entries keep their stored order — apply() moves them into
    // the pinned container in exactly that order.
    const pinned = entries.filter(entry => this.isPinned(entry.page));
    const others = entries.filter(entry => !this.isPinned(entry.page));

    pinnedList.innerHTML = pinned.length
      ? pinned.map((entry, index) => this._pinnedRow(entry, index, pinned.length)).join('')
      : `<div class="nav-pin-empty">${Utils.escapeHtml(i18n.t('nav.pinnedNone'))}</div>`;
    otherList.innerHTML = others.length
      ? others.map(entry => this._otherRow(entry)).join('')
      : `<div class="nav-pin-empty">${Utils.escapeHtml(i18n.t('nav.pinnedNone'))}</div>`;
  },

  _pinnedRow(entry, index, total) {
    const label = i18n.t('nav.pinReorderLabel', { name: entry.name, position: index + 1, total });
    return `
      <div class="nav-pin-row nav-pin-row-pinned" role="listitem" draggable="true" tabindex="0"
           data-pin-page="${Utils.escapeHtml(entry.page)}"
           aria-label="${Utils.escapeHtml(label)}"
           aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
        <i class="fas fa-grip-vertical nav-pin-grip" aria-hidden="true"></i>
        <i class="${Utils.escapeHtml(entry.iconClass)}" aria-hidden="true"></i>
        <span class="nav-pin-name">${Utils.escapeHtml(entry.name)}</span>
        <button type="button" class="btn btn-xs btn-secondary nav-pin-move" data-pin-move="up"
                aria-label="${Utils.escapeHtml(i18n.t('nav.pinMoveUp', { name: entry.name }))}" ${index === 0 ? 'disabled' : ''}>
          <i class="fas fa-chevron-up" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-xs btn-secondary nav-pin-move" data-pin-move="down"
                aria-label="${Utils.escapeHtml(i18n.t('nav.pinMoveDown', { name: entry.name }))}" ${index === total - 1 ? 'disabled' : ''}>
          <i class="fas fa-chevron-down" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-xs btn-secondary nav-pin-toggle"
                data-pin-toggle="${Utils.escapeHtml(entry.page)}" aria-pressed="true">
          ${Utils.escapeHtml(i18n.t('nav.unpinAction'))}
        </button>
      </div>`;
  },

  _otherRow(entry) {
    return `
      <div class="nav-pin-row" role="listitem" data-pin-page="${Utils.escapeHtml(entry.page)}">
        <i class="fas fa-grip-vertical nav-pin-grip nav-pin-grip-empty" aria-hidden="true"></i>
        <i class="${Utils.escapeHtml(entry.iconClass)}" aria-hidden="true"></i>
        <span class="nav-pin-name">${Utils.escapeHtml(entry.name)}</span>
        <button type="button" class="btn btn-xs btn-secondary nav-pin-toggle"
                data-pin-toggle="${Utils.escapeHtml(entry.page)}" aria-pressed="false">
          ${Utils.escapeHtml(i18n.t('nav.pinAction'))}
        </button>
      </div>`;
  },

  /**
   * Delegated handlers for the manager modal.
   *
   * Bound once on the modal content, so the rows can be re-rendered after
   * every pin, unpin and reorder without rebinding anything.
   */
  _bindManagerEvents() {
    const content = Modal._content;
    if (!content || content._navPinsBound) return;
    content._navPinsBound = true;

    content.addEventListener('click', (e) => {
      const move = e.target.closest('[data-pin-move]');
      if (move) {
        this._movePinnedRow(move.closest('.nav-pin-row-pinned'), move.dataset.pinMove === 'up' ? -1 : 1);
        return;
      }
      const btn = e.target.closest('[data-pin-toggle]');
      if (!btn) return;
      const page = btn.getAttribute('data-pin-toggle');
      this.toggle(page);
      this._renderManagerLists();
      content.querySelector(`[data-pin-toggle="${page}"]`)?.focus();
    });

    // ── Drag to reorder ──────────────────────────
    content.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.nav-pin-row-pinned');
      if (!row) return;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.pinPage);
    });

    content.addEventListener('dragend', (e) => {
      const row = e.target.closest('.nav-pin-row-pinned');
      if (row) row.classList.remove('dragging');
      content.querySelectorAll('.nav-pin-row-pinned').forEach(r => r.classList.remove('drag-over'));
    });

    content.addEventListener('dragover', (e) => {
      const row = e.target.closest('.nav-pin-row-pinned');
      if (!row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      content.querySelectorAll('.nav-pin-row-pinned').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });

    content.addEventListener('drop', (e) => {
      const row = e.target.closest('.nav-pin-row-pinned');
      if (!row) return;
      e.preventDefault();
      const list = row.closest('#nav-pin-pinned-list');
      const dragged = list?.querySelector('.nav-pin-row-pinned.dragging');
      if (!list || !dragged || dragged === row) return;
      const rows = [...list.querySelectorAll('.nav-pin-row-pinned')];
      const from = rows.indexOf(dragged);
      const to = rows.indexOf(row);
      if (from < 0 || to < 0) return;
      if (from < to) row.parentNode.insertBefore(dragged, row.nextSibling);
      else row.parentNode.insertBefore(dragged, row);
      this._commitPinnedOrder(list, dragged.dataset.pinPage);
    });

    // ── Keyboard reordering ──────────────────────
    // Alt with the arrow keys moves the focused pinned entry. Dragging
    // alone would leave keyboard users without a way to set the order.
    content.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      const row = e.target.closest('.nav-pin-row-pinned');
      if (!row) return;
      e.preventDefault();
      this._movePinnedRow(row, e.key === 'ArrowUp' ? -1 : 1);
    });
  },

  _movePinnedRow(row, direction) {
    const list = row?.closest('#nav-pin-pinned-list');
    if (!list) return;
    const rows = [...list.querySelectorAll('.nav-pin-row-pinned')];
    const target = rows[rows.indexOf(row) + direction];
    if (!target) return;
    if (direction < 0) target.before(row);
    else target.after(row);
    row.focus();
    this._commitPinnedOrder(list, row.dataset.pinPage);
  },

  /**
   * Store the order the modal rows now have and repaint the sidebar.
   *
   * Pages that the current layout does not show keep their place in the
   * stored order — only the listed pages are permuted.
   */
  _commitPinnedOrder(list, movedPage) {
    const order = [...list.querySelectorAll('.nav-pin-row-pinned')].map(r => r.dataset.pinPage);
    this._applyPinnedOrder(order);
    this._refreshPinnedRowLabels(list);
    const name = this._entryName(movedPage);
    const position = order.indexOf(movedPage) + 1;
    const live = document.getElementById('nav-pin-live');
    if (live) {
      live.textContent = i18n.t('nav.pinnedReordered', { name, position, total: order.length });
    }
  },

  _applyPinnedOrder(order) {
    if (!this._session) return;
    const known = new Set(this._pages);
    // Only pages that are actually pinned can take part in the permutation.
    const listed = [...new Set(order.filter(page => known.has(page)))];
    if (!listed.length) return;
    const listedSet = new Set(listed);
    let index = 0;
    // Permute the listed pages in place: the pages this layout does not
    // show keep the slot they had in the stored order.
    const next = this._pages.map(page => (listedSet.has(page) ? listed[index++] : page));
    if (JSON.stringify(next) === JSON.stringify(this._pages)) return;
    this._pages = next;
    this._save();
    this.apply();
  },

  /** Refresh the position labels after a reorder. */
  _refreshPinnedRowLabels(list) {
    const rows = [...list.querySelectorAll('.nav-pin-row-pinned')];
    rows.forEach((row, index) => {
      const page = row.dataset.pinPage;
      const name = this._entryName(page);
      row.setAttribute('aria-label', i18n.t('nav.pinReorderLabel', { name, position: index + 1, total: rows.length }));
      row.querySelector('[data-pin-move="up"]').disabled = index === 0;
      row.querySelector('[data-pin-move="down"]').disabled = index === rows.length - 1;
    });
  },

  _entryName(page) {
    const nav = document.getElementById('sidebar-nav');
    const el = nav?.querySelector(`.nav-item[data-page="${page}"]`);
    const text = el?.querySelector('span');
    return text ? text.textContent.trim() : page;
  },

};

window.NavPins = NavPins;
