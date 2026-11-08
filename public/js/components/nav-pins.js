/* ═══════════════════════════════════════════════════
   components/nav-pins.js — Pinned sidebar entries

   Lets the operator pin navigation entries so they surface at the top of the
   left navigation, under a "Pinned" category.

   Pinned entries are the ORIGINAL nav anchors moved into the pinned
   container — never clones. One element per page keeps live badges
   (container count, alert count), the active-route highlight, the
   capability/daemon gating and the per-page element ids intact.

   State is stored per user: localStorage for an instant first paint plus the
   server-side user_preferences row (`pinnedNav`) so pins follow the account
   across browsers. Both copies carry a timestamp and the newer one wins, so a
   pin made on another device arrives here and a failed server write does not
   drop the pins of this session.
   ═══════════════════════════════════════════════════ */
'use strict';

const NavPins = {
  STORAGE_KEY: 'dd-pinned-nav',
  PREF_KEY: 'pinnedNav',

  _pages: [],        // pinned page names, in pin order
  _moved: [],        // nav anchors currently living in the pinned container
  _username: '',     // localStorage is per user — the pins of one operator
                     // must not leak into another operator's session
  _serverRaw: null,  // server copy, kept until the local state is known
  _serverUser: '',   // the operator the server copy belongs to
  _updatedAt: 0,     // when the local copy was last changed
  _ready: false,

  // ─── Lifecycle ───────────────────────────────────

  init(username) {
    this._username = username || '';
    const local = this._readLocal();
    this._pages = local.pages;
    this._updatedAt = local.updatedAt;
    // The server copy may have arrived before the local state was known.
    // Merging here keeps the account the source of truth. A copy fetched for
    // another operator is discarded — the preferences are per account.
    if (this._serverRaw && (!this._serverUser || this._serverUser === this._username)) {
      this._applyServer(this._serverRaw);
    }
    this._ready = true;
    this._bindNavEvents();
    this.apply();
  },

  /**
   * Re-read the pinned set from the server copy and repaint the sidebar.
   * The username identifies the account the copy belongs to.
   */
  setFromServer(raw, username) {
    // The preferences are per account. A copy that belongs to another
    // operator — a late response after a logout — must not be applied.
    if (username && this._username && username !== this._username) return;
    this._serverRaw = raw;
    this._serverUser = username || '';
    // Before init() there is no local state to compare against and no
    // username to key the local copy under — init() picks the value up.
    if (!this._ready) return;
    this._applyServer(raw);
  },

  /**
   * Merge the server copy into the local state.
   *
   * Both copies carry a timestamp and the newer one wins: a pin made on
   * another device reaches this session, while a local change whose server
   * write failed is not dropped when the older server copy arrives.
   */
  _applyServer(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // malformed preference — keep the local set
    }
    const server = this._decode(parsed);
    if (!server) return;
    if (server.updatedAt < this._updatedAt) {
      // The local copy is newer — push it up so the account catches up.
      this._save();
      return;
    }
    this._updatedAt = server.updatedAt;
    if (JSON.stringify(server.pages) !== JSON.stringify(this._pages)) {
      this._pages = server.pages;
      this.apply();
    }
    this._writeLocal();
  },

  /** Forget the current pins — used when the session ends. */
  reset() {
    this._restoreMoved();
    this._pages = [];
    this._serverRaw = null;
    this._serverUser = '';
    this._updatedAt = 0;
    this._ready = false;
  },

  // ─── State ───────────────────────────────────────

  isPinned(page) {
    return this._pages.includes(page);
  },

  toggle(page) {
    if (!this._isSafePage(page)) return;
    const idx = this._pages.indexOf(page);
    if (idx >= 0) this._pages.splice(idx, 1);
    else this._pages.push(page);
    this._updatedAt = Date.now();
    this._save();
    this.apply();
  },

  _isSafePage(page) {
    return typeof page === 'string' && /^[a-z0-9-]+$/i.test(page);
  },

  _storageKey() {
    return `${this.STORAGE_KEY}${this._username ? `:${this._username}` : ''}`;
  },

  /**
   * Normalise a stored value into { pages, updatedAt }.
   *
   * Accepts the object form written by this version and the bare array form
   * of an earlier revision, so an existing preference is never discarded.
   */
  _decode(value) {
    if (Array.isArray(value)) {
      return { pages: value.filter(p => typeof p === 'string' && this._isSafePage(p)), updatedAt: 0 };
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.pages)) return null;
    return {
      pages: value.pages.filter(p => typeof p === 'string' && this._isSafePage(p)),
      updatedAt: Number(value.updatedAt) || 0,
    };
  },

  _readLocal() {
    try {
      const raw = localStorage.getItem(this._storageKey());
      if (!raw) return { pages: [], updatedAt: 0 };
      return this._decode(JSON.parse(raw)) || { pages: [], updatedAt: 0 };
    } catch {
      return { pages: [], updatedAt: 0 };
    }
  },

  _writeLocal() {
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify({ pages: this._pages, updatedAt: this._updatedAt }));
    } catch { /* private mode / quota — the server copy still holds the pins */ }
  },

  _save() {
    this._writeLocal();
    if (typeof Api !== 'undefined' && typeof Api.saveUserPreference === 'function') {
      Api.saveUserPreference(this.PREF_KEY, JSON.stringify({ pages: this._pages, updatedAt: this._updatedAt }))
        .catch(() => { /* keep the local copy — the pins stay until the next write */ });
    }
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
    if (!this._ready) return;
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;

    this._restoreMoved();

    const pinned = this._pages
      .map(page => this._findNavItem(page))
      .filter(Boolean);

    const section = document.createElement('div');
    section.className = 'nav-pinned';
    section.id = 'nav-pinned';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', i18n.t('nav.pinned'));

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
    manage.title = i18n.t('nav.pinnedManage');
    manage.setAttribute('aria-label', i18n.t('nav.pinnedManage'));
    manage.innerHTML = '<i class="fas fa-pen-to-square" aria-hidden="true"></i>';
    manage.addEventListener('click', () => this.openManager());
    head.appendChild(manage);

    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nav-pinned-body';
    body.id = 'nav-pinned-body';
    if (!pinned.length) {
      const empty = document.createElement('div');
      empty.className = 'nav-pinned-empty';
      empty.textContent = i18n.t('nav.pinnedEmpty');
      body.appendChild(empty);
    }
    section.appendChild(body);

    nav.insertBefore(section, nav.firstChild);

    // Capture every home position BEFORE moving anything: the sibling that
    // follows an entry may itself be a pinned entry, and it has to be
    // recorded while it is still in place.
    const order = [...nav.querySelectorAll('.nav-item[data-page]')];
    for (const item of pinned) {
      item._pinnedHome = { parent: item.parentNode, next: item.nextSibling };
      item._pinnedOrder = order.indexOf(item);
    }
    for (const item of pinned) body.appendChild(item);
    this._moved = pinned;

    this.setHeaderLabel();
  },

  /** Keep the "Pinned" caption in sync with the active language. */
  setHeaderLabel() {
    const label = document.getElementById('nav-pinned-label');
    if (label) label.textContent = i18n.t('nav.pinned');
    const section = document.getElementById('nav-pinned');
    if (section) section.setAttribute('aria-label', i18n.t('nav.pinned'));
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

    const nav = document.getElementById('sidebar-nav');
    const existing = nav?.querySelector('#nav-pinned');
    if (existing) existing.remove();
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
      if (!item) return;
      const page = item.getAttribute('data-page');
      if (!this._isSafePage(page)) return;
      e.preventDefault();
      const pinned = this.isPinned(page);
      ContextMenu.show(e, [
        {
          label: pinned ? i18n.t('nav.unpinAction') : i18n.t('nav.pinAction'),
          icon: 'fa-thumb-tack',
          action: () => this.toggle(page),
        },
        { type: 'separator' },
        {
          label: i18n.t('nav.pinnedManage'),
          icon: 'fa-pen-to-square',
          action: () => this.openManager(),
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
    if (!nav) return;

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
      const btn = e.target.closest('[data-pin-toggle]');
      if (!btn) return;
      const page = btn.getAttribute('data-pin-toggle');
      this.toggle(page);
      this._renderManagerLists();
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
      const list = row.closest('#nav-pin-pinned-list');
      if (!list) return;
      const rows = [...list.querySelectorAll('.nav-pin-row-pinned')];
      const index = rows.indexOf(row);
      const target = e.key === 'ArrowUp' ? index - 1 : index + 1;
      if (target < 0 || target >= rows.length) return;
      if (e.key === 'ArrowUp') list.insertBefore(row, rows[target]);
      else list.insertBefore(rows[target], row);
      row.focus();
      this._commitPinnedOrder(list, row.dataset.pinPage);
    });
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
    const known = new Set(this._pages);
    // Only pages that are actually pinned can take part in the permutation.
    const listed = order.filter(page => this._isSafePage(page) && known.has(page));
    if (!listed.length) return;
    const listedSet = new Set(listed);
    let index = 0;
    // Permute the listed pages in place: the pages this layout does not
    // show keep the slot they had in the stored order.
    const next = this._pages.map(page => (listedSet.has(page) ? listed[index++] : page));
    if (JSON.stringify(next) === JSON.stringify(this._pages)) return;
    this._pages = next;
    this._updatedAt = Date.now();
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
