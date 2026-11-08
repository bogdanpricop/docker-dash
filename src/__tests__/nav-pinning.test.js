'use strict';

const fs = require('fs');
const path = require('path');

const readPublic = relative => fs.readFileSync(path.join(__dirname, '..', '..', 'public', relative), 'utf8');

describe('Pinned navigation entries', () => {
  test('the sidebar loads the pinning component before app.js', () => {
    const html = readPublic('index.html');
    const pins = html.indexOf('/js/components/nav-pins.js');
    const app = html.indexOf('/js/app.js');
    expect(pins).toBeGreaterThan(-1);
    expect(pins).toBeLessThan(app);
  });

  test('the pinning component moves entries into a pinned group at the top of the nav', () => {
    const pins = readPublic('js/components/nav-pins.js');
    expect(pins).toContain("'use strict'");
    expect(pins).toContain('window.NavPins = NavPins');
    // The pinned block is inserted before the first navigation entry.
    expect(pins).toContain("nav.insertBefore(section, nav.firstChild)");
    // Entries are moved, not cloned, so ids and live badges survive.
    expect(pins).toContain('body.appendChild(item)');
    expect(pins).toContain('_pinnedHome');
  });

  test('pinning is reachable by right-click and by a keyboard-reachable manager', () => {
    const pins = readPublic('js/components/nav-pins.js');
    expect(pins).toContain("nav.addEventListener('contextmenu'");
    expect(pins).toContain('openManager()');
    expect(pins).toContain('data-pin-toggle');
    expect(pins).toContain('aria-pressed');
  });

  test('pins persist per user in localStorage and in user preferences', () => {
    const pins = readPublic('js/components/nav-pins.js');
    expect(pins).toContain("STORAGE_KEY: 'dd-pinned-nav'");
    expect(pins).toContain("PREF_KEY: 'pinnedNav'");
    expect(pins).toContain('Api.saveUserPreference');
    expect(pins).toContain('localStorage.setItem');
    // The local copy is keyed by the signed-in operator.
    expect(pins).toContain(':${this._username}');
    // Both copies carry a timestamp so the newer one wins on a merge.
    expect(pins).toContain('updatedAt');
  });

  test('a malformed or unsafe server payload never becomes a pinned entry', () => {
    const pins = readPublic('js/components/nav-pins.js');
    // Only plain page names are accepted.
    expect(pins).toContain('/^[a-z0-9-]+$/i.test(page)');
    // A malformed payload is ignored rather than applied.
    expect(pins).toContain('malformed preference');
  });

  test('the app applies pins on boot, on every sidebar rebuild and on language change', () => {
    const app = readPublic('js/app.js');
    expect(app).toContain('NavPins.init(this.user?.username)');
    expect(app).toContain('NavPins.apply()');
    expect(app).toContain('NavPins.setHeaderLabel()');
    expect(app).toContain('NavPins.setFromServer(prefs.pinnedNav, this.user?.username)');
  });

  test('the pinned caption uses its own i18n key so the section label order is untouched', () => {
    const pins = readPublic('js/components/nav-pins.js');
    expect(pins).toContain("i18n.t('nav.pinned')");
    // A .nav-section-label would shift the index-based Resources/Operations/Admin mapping.
    expect(pins).not.toContain("'nav-section-label'");
  });

  test('the pinned group and the manager modal are styled', () => {
    const css = readPublic('css/app.css');
    expect(css).toContain('.nav-pinned');
    expect(css).toContain('.nav-pinned-head');
    expect(css).toContain('.nav-pinned-manage');
    expect(css).toContain('.nav-pin-list');
    expect(css).toContain('.nav-pin-row');
  });

  test('every pinned string is translated in English and Romanian', () => {
    const en = readPublic('js/i18n/en.js');
    const ro = readPublic('js/i18n/ro.js');
    for (const key of ['pinned', 'pinnedManage', 'pinnedEmpty', 'pinnedHint', 'pinAction', 'unpinAction']) {
      expect(en).toContain(`${key}:`);
      expect(ro).toContain(`${key}:`);
    }
  });

  test('the manager modal lets the operator reorder the pinned entries by dragging', () => {
    const pins = readPublic('js/components/nav-pins.js');
    // The pinned rows are the draggable ones.
    expect(pins).toContain('nav-pin-row-pinned');
    expect(pins).toContain('draggable="true"');
    expect(pins).toContain("content.addEventListener('dragstart'");
    expect(pins).toContain("content.addEventListener('dragover'");
    expect(pins).toContain("content.addEventListener('drop'");
    expect(pins).toContain("content.addEventListener('dragend'");
    // The drop result is stored and repainted.
    expect(pins).toContain('_commitPinnedOrder');
    expect(pins).toContain('_applyPinnedOrder');
  });

  test('reordering is reachable from the keyboard too', () => {
    const pins = readPublic('js/components/nav-pins.js');
    expect(pins).toContain("content.addEventListener('keydown'");
    expect(pins).toContain('e.altKey');
    expect(pins).toContain('ArrowUp');
    expect(pins).toContain('ArrowDown');
    // The shortcut is advertised to assistive technology.
    expect(pins).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"');
  });

  test('a reorder keeps the pinned entries that the current layout does not show', () => {
    const pins = readPublic('js/components/nav-pins.js');
    // The permutation only replaces the listed pages; the others keep their slot.
    expect(pins).toContain('const next = this._pages.map(page => (listedSet.has(page) ? listed[index++] : page));');
    // Only pages that are actually pinned may take part in the permutation.
    expect(pins).toContain('known.has(page)');
  });

  test('the reorder is announced and the position labels follow the new order', () => {
    const pins = readPublic('js/components/nav-pins.js');
    expect(pins).toContain("role=\"status\" aria-live=\"polite\"");
    expect(pins).toContain('_refreshPinnedRowLabels');
    expect(pins).toContain('nav.pinnedReordered');
    expect(pins).toContain('nav.pinReorderLabel');
  });

  test('every reorder string is translated in English and Romanian', () => {
    const en = readPublic('js/i18n/en.js');
    const ro = readPublic('js/i18n/ro.js');
    for (const key of ['pinnedOthers', 'pinnedNone', 'pinnedOrderHint', 'pinReorderLabel', 'pinnedReordered']) {
      expect(en).toContain(`${key}:`);
      expect(ro).toContain(`${key}:`);
    }
  });

  test('the drag affordance is styled', () => {
    const css = readPublic('css/app.css');
    expect(css).toContain('.nav-pin-grip');
    expect(css).toContain('.nav-pin-row-pinned');
    expect(css).toContain('.nav-pin-row-pinned.dragging');
    expect(css).toContain('.nav-pin-row-pinned.drag-over');
    expect(css).toContain('.nav-pin-section-label');
  });
});
