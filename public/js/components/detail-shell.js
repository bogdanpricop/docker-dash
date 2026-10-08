/* ═══════════════════════════════════════════════════
   components/detail-shell.js — Reusable tabbed detail view
   ═══════════════════════════════════════════════════
   Phase 3 (deep-spec-standardized-detail-views.md). One shell for every
   resource detail view (container/image/volume/network/stack) so they share
   header + tab-bar + lazy-render + deep-link + keyboard behaviour instead of
   each page re-inventing it.

   NON-reactive by design (Phase 4 owns reactivity). A tab's content is
   rendered on first activation; tabs flagged `live: true` (streams: logs,
   stats, terminal) get re-rendered on every entry and torn down via onLeave
   on every exit. Hash sync uses history.replaceState so it never triggers the
   app router's full-page reload.

   Usage:
     const shell = DetailShell.create({ ... });
     shell.mount(containerEl);
     // page.destroy() should call shell.destroy()
*/
'use strict';

const DetailShell = {
  /** @returns {object} shell instance */
  create(opts) {
    return _createShell(opts || {});
  },
};

/**
 * DOM-independent decision logic, factored out so it is unit-testable in a
 * plain Node environment (the project's Jest runs without jsdom). The DOM glue
 * in _createShell delegates to these; the wiring itself is covered by the
 * per-page Puppeteer regression in Phase 3.1+.
 */
const _pure = {
  standardTabKeys: Object.freeze(['overview', 'actions', 'tasks', 'events', 'audit']),

  /** Put the shared operational contract first and preserve resource-specific tabs after it. */
  standardizeTabs(tabs = []) {
    const input = tabs.filter(tab => tab && tab.key);
    const byKey = new Map(input.map(tab => [tab.key, tab]));
    const labels = { overview: 'Overview', actions: 'Actions', tasks: 'Tasks', events: 'Events', audit: 'Audit' };
    const icons = { overview: 'fa-info-circle', actions: 'fa-bolt', tasks: 'fa-tasks', events: 'fa-stream', audit: 'fa-history' };
    const standard = this.standardTabKeys.map(key => byKey.get(key) || {
      key, label: labels[key], icon: icons[key], unavailable: true,
    });
    return standard.concat(input.filter(tab => !this.standardTabKeys.includes(tab.key)));
  },

  actionExplanation(decision) {
    if (decision?.available) return 'Available';
    const blockers = (decision?.blockers || [])
      .map(blocker => blocker.message || blocker.reason).filter(Boolean);
    return [...new Set(blockers)].join(' · ') || 'Action is unavailable';
  },

  /** Resolve which tab should be active on first mount. */
  initialTab({ hash = '', tabKeys = [], defaultTab = null, hashRouting = false, id = null } = {}) {
    if (hashRouting && id != null) {
      const parts = String(hash).replace(/^#/, '').split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (last && tabKeys.includes(last) && last !== String(id)) return last;
    }
    if (defaultTab && tabKeys.includes(defaultTab)) return defaultTab;
    return tabKeys.length ? tabKeys[0] : null;
  },

  /** Build the deep-link hash for a tab (null when hash routing isn't applicable). */
  buildHash(resourceKey, id, key) {
    if (resourceKey == null || id == null) return null;
    return `#/${resourceKey}/${id}/${key}`;
  },

  /** Wrap-around index for ←/→ keyboard tab navigation. */
  nextIndex(currentIdx, delta, len) {
    if (len <= 0 || currentIdx < 0) return currentIdx;
    return (currentIdx + delta + len) % len;
  },

  /** A tab renders on first activation, and again every entry when live (streams). */
  shouldRender(isRendered, isLive) {
    return !isRendered || !!isLive;
  },
};
DetailShell._pure = _pure;

function _esc(v) {
  if (window.Utils && typeof Utils.escapeHtml === 'function') return Utils.escapeHtml(v);
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function _resolve(fnOrVal) {
  return typeof fnOrVal === 'function' ? fnOrVal() : fnOrVal;
}

function _createShell(opts) {
  const tabs = (opts.standardTabs ? _pure.standardizeTabs(opts.tabs || []) : (opts.tabs || []))
    .filter(t => t && t.key)
    .map(tab => tab.unavailable ? {
      ...tab,
      render: panel => { panel.innerHTML = `<div class="empty-msg"><i class="fas fa-ban"></i>${_esc(tab.label)} is not available for this resource.</div>`; },
    } : tab);
  const tabByKey = {};
  for (const t of tabs) tabByKey[t.key] = t;

  const state = {
    root: null,
    tabBar: null,
    panelsWrap: null,
    panels: {},        // key -> panel element
    rendered: new Set(),
    activeKey: null,
    keydownHandler: null,
    clickHandler: null,
    destroyed: false,
  };

  function _initialTab() {
    return _pure.initialTab({
      hash: location.hash, tabKeys: tabs.map(t => t.key),
      defaultTab: opts.defaultTab, hashRouting: opts.hashRouting, id: opts.id,
    });
  }

  function _syncHash(key) {
    if (!opts.hashRouting) return;
    const next = _pure.buildHash(opts.resourceKey, opts.id, key);
    if (next && location.hash !== next) {
      // replaceState does NOT fire hashchange → app router won't reload the page.
      history.replaceState(null, '', next);
    }
  }

  function _renderHeader() {
    const h = opts.header || {};
    const icon = h.icon ? `<i class="fas ${_esc(h.icon)}"></i> ` : '';
    const title = _esc(_resolve(h.title));
    const subtitle = h.subtitle != null ? `<div class="detail-shell-subtitle">${_esc(_resolve(h.subtitle))}</div>` : '';
    let pill = '';
    if (h.statusPill) {
      const p = _resolve(h.statusPill) || {};
      if (p.text) pill = `<span class="pill ${_esc(p.cls || '')}">${_esc(p.text)}</span>`;
    }
    const head = document.createElement('div');
    head.className = 'detail-shell-header';
    head.innerHTML = `
      <div class="detail-shell-headmain">
        <h2 class="detail-shell-title">${icon}${title} ${pill}</h2>
        ${subtitle}
      </div>
      <div class="detail-shell-actions"></div>
    `;
    if (typeof h.actions === 'function') {
      h.actions(head.querySelector('.detail-shell-actions'));
    }
    return head;
  }

  function _renderTabBar() {
    const bar = document.createElement('div');
    bar.className = 'tabs detail-shell-tabs';
    bar.setAttribute('role', 'tablist');
    bar.innerHTML = tabs.map((t, i) => {
      const ic = t.icon ? `<i class="fas ${_esc(t.icon)}" style="margin-right:6px"></i>` : '';
      return `<button class="tab" role="tab" data-tab="${_esc(t.key)}" tabindex="${i === 0 ? '0' : '-1'}">${ic}${_esc(t.label || t.key)}</button>`;
    }).join('');
    return bar;
  }

  function _activate(key, { focus = false } = {}) {
    if (state.destroyed) return;
    const tab = tabByKey[key];
    if (!tab) return;
    if (key === state.activeKey) {
      if (focus) state.tabBar.querySelector(`[data-tab="${cssEsc(key)}"]`)?.focus();
      return;
    }

    // Leave the previous tab (stream teardown etc.)
    const prev = state.activeKey ? tabByKey[state.activeKey] : null;
    if (prev) {
      const prevPanel = state.panels[prev.key];
      if (typeof prev.onLeave === 'function') {
        try { prev.onLeave(prevPanel); } catch (e) { _warn(prev.key, 'onLeave', e); }
      }
      prevPanel.style.display = 'none';
      _setTabActive(prev.key, false);
    }

    const panel = state.panels[key];
    panel.style.display = '';
    _setTabActive(key, true);

    // Render on first activation; re-render every entry for live (streaming) tabs.
    if (_pure.shouldRender(state.rendered.has(key), tab.live)) {
      panel.innerHTML = '';
      try { tab.render(panel); } catch (e) { _warn(key, 'render', e); panel.innerHTML = `<div class="empty-msg">Failed to render tab.</div>`; }
      state.rendered.add(key);
    }

    state.activeKey = key;
    if (focus) state.tabBar.querySelector(`[data-tab="${cssEsc(key)}"]`)?.focus();
    _syncHash(key);
    if (typeof opts.onTabChange === 'function') {
      try { opts.onTabChange(key); } catch { /* non-fatal */ }
    }
  }

  function _setTabActive(key, active) {
    const btn = state.tabBar.querySelector(`[data-tab="${cssEsc(key)}"]`);
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
    const panel = state.panels[key];
    if (panel) panel.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function cssEsc(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function _warn(key, phase, e) {
    if (window.console) console.warn(`[DetailShell] tab "${key}" ${phase} failed:`, e && e.message ? e.message : e);
  }

  function _onKeydown(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const idx = tabs.findIndex(t => t.key === state.activeKey);
    if (idx === -1) return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const nextIdx = _pure.nextIndex(idx, delta, tabs.length);
    _activate(tabs[nextIdx].key, { focus: true });
  }

  function _onClick(e) {
    const btn = e.target.closest('[data-tab]');
    if (btn && state.tabBar.contains(btn)) _activate(btn.dataset.tab, { focus: true });
  }

  return {
    mount(container) {
      if (!container) throw new Error('DetailShell.mount requires a container element');
      const root = document.createElement('div');
      root.className = 'detail-shell';
      state.root = root;

      if (opts.header) root.appendChild(_renderHeader());
      if (typeof opts.metaStrip === 'function') {
        const strip = document.createElement('div');
        strip.className = 'detail-shell-meta';
        opts.metaStrip(strip);
        root.appendChild(strip);
      }

      state.tabBar = _renderTabBar();
      root.appendChild(state.tabBar);

      state.panelsWrap = document.createElement('div');
      state.panelsWrap.className = 'detail-shell-panels';
      for (const t of tabs) {
        const panel = document.createElement('div');
        panel.className = 'detail-shell-panel tab-content';
        panel.setAttribute('role', 'tabpanel');
        panel.dataset.panel = t.key;
        panel.style.display = 'none';
        state.panels[t.key] = panel;
        state.panelsWrap.appendChild(panel);
      }
      root.appendChild(state.panelsWrap);

      state.clickHandler = _onClick;
      state.keydownHandler = _onKeydown;
      state.tabBar.addEventListener('click', state.clickHandler);
      state.tabBar.addEventListener('keydown', state.keydownHandler);

      container.appendChild(root);

      const initial = _initialTab();
      if (initial) _activate(initial);
      return this;
    },

    switchTo(key) { _activate(key); return this; },

    /** Force re-render of a tab's panel (default: active tab). */
    refresh(key) {
      const k = key || state.activeKey;
      if (!k || !tabByKey[k]) return;
      const panel = state.panels[k];
      if (!panel) return;
      panel.innerHTML = '';
      try { tabByKey[k].render(panel); } catch (e) { _warn(k, 'render', e); }
      state.rendered.add(k);
    },

    getActiveTab() { return state.activeKey; },

    destroy() {
      if (state.destroyed) return;
      const active = state.activeKey ? tabByKey[state.activeKey] : null;
      if (active && typeof active.onLeave === 'function') {
        try { active.onLeave(state.panels[active.key]); } catch { /* teardown best-effort */ }
      }
      if (state.tabBar) {
        state.tabBar.removeEventListener('click', state.clickHandler);
        state.tabBar.removeEventListener('keydown', state.keydownHandler);
      }
      if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
      state.destroyed = true;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DetailShell;
}
