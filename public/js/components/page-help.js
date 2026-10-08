'use strict';

/* ═══════════════════════════════════════════════════
   components/page-help.js — the "?" button every page carries
   ═══════════════════════════════════════════════════

   Convention: every routed page has a "?" button in its header that opens a
   detailed description of what the page does and what each action means.

   Nine pages implemented that by hand, each with ~30 lines of duplicated modal
   markup and its own i18n keys; the other 51 simply never got one. Rather than
   repeat the boilerplate 51 more times, the button is injected here, after the
   router renders a page, and the prose lives in one registry (help-content.js).

   Adding help to a new page is therefore a content edit, not a code edit — and
   a page that ships without an entry shows no button rather than an empty one.

   Pages that already hand-rolled their own help keep it: the injector backs off
   when it finds an existing .prune-help-btn. Migrating those nine onto this
   component is a separate change; they work today.
*/

const PageHelp = {
  _observer: null,

  /**
   * Inject the "?" button for a route, if content exists for it.
   * Called by the router after every page render.
   *
   * 19 pages reassign container.innerHTML after their initial render — when data
   * arrives, when a tab changes, on a refresh timer. Injecting once would put the
   * button on those pages only until the next repaint. So the injection is
   * repeated whenever the container's subtree changes; `_inject` is a no-op once
   * a button is present, so the observer settles immediately instead of looping.
   *
   * @param {string} route  page registry key, e.g. 'posture'
   * @param {HTMLElement} container the page container
   */
  mount(route, container) {
    this._disconnect();
    if (!container || !route || !this.has(route)) return;
    this._inject(route, container);
    this._observer = new MutationObserver(() => this._inject(route, container));
    this._observer.observe(container, { childList: true, subtree: true });
  },

  /** Stop watching the previous page. Called on every route change. */
  _disconnect() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
  },

  _inject(route, container) {
    if (!container.isConnected) { this._disconnect(); return; }

    const existing = container.querySelector('.prune-help-btn');
    if (existing) {
      const owner = existing.dataset ? existing.dataset.pageHelp : null;
      // No marker means the page hand-rolled its own button — leave it alone.
      if (!owner) return;
      // Ours, and for this route — nothing to do.
      if (owner === route) return;
      // Ours, but bound to the previous route. This happens on every navigation:
      // the outgoing page's observer is still live while the incoming page writes
      // its header, so it injects first and binds the wrong route. Replace it,
      // otherwise the button opens the help for the page you just left.
      existing.remove();
    }

    const header = container.querySelector('.page-header');
    if (!header) return;

    let actions = header.querySelector('.page-actions');
    if (!actions) {
      // 23 of the 60 pages have no actions container. Creating one keeps the
      // button in the same place on every page instead of letting it land
      // wherever the header happens to end.
      actions = document.createElement('div');
      actions.className = 'page-actions';
      header.appendChild(actions);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prune-help-btn';
    // Marks the button as ours and records which route it opens, so a stale one
    // left by the outgoing page can be told apart from a hand-rolled one.
    btn.dataset.pageHelp = route;
    btn.textContent = '?';
    btn.title = i18n.t('pageHelp.tooltip');
    btn.setAttribute('aria-label', i18n.t('pageHelp.tooltip'));
    btn.addEventListener('click', () => this.open(route));
    actions.insertBefore(btn, actions.firstChild);
  },

  has(route) {
    return !!(typeof HelpContent !== 'undefined' && HelpContent[route]);
  },

  /**
   * Resolve the entry for the active language, falling back to English.
   * Help prose lives beside the component rather than in i18n/*.js for the same
   * reason how-to guides live in markdown: it is long-form content, not labels.
   */
  _entry(route) {
    const record = (typeof HelpContent !== 'undefined' && HelpContent[route]) || null;
    if (!record) return null;
    const lang = (typeof i18n !== 'undefined' && i18n.lang) || 'en';
    return record[lang] || record.en || null;
  },

  open(route) {
    const entry = this._entry(route);
    if (!entry) return;

    const esc = Utils.escapeHtml;
    const sections = (entry.sections || []).map(s => `
      <h4><i class="fas ${esc(s.icon || 'fa-circle-info')}"></i> ${esc(s.title)}</h4>
      <p>${esc(s.body)}</p>
    `).join('');

    const tip = entry.tip
      ? `<div class="tip-box"><i class="fas fa-lightbulb"></i> ${esc(entry.tip)}</div>`
      : '';

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas ${esc(entry.icon || 'fa-circle-info')}" style="color:var(--accent);margin-right:8px"></i>${esc(entry.title)}</h3>
        <button type="button" class="modal-close-btn" id="modal-x" aria-label="${esc(i18n.t('common.close'))}">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${esc(entry.intro)}</p>
        ${sections}
        ${tip}
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" id="modal-ok">${esc(i18n.t('common.understood'))}</button>
      </div>
    `, { width: '640px' });

    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },
};
