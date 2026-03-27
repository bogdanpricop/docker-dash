/* ═══════════════════════════════════════════════════
   i18n.js — Internationalization Engine

   Translations are in separate files: /js/i18n/{code}.js
   Each file calls i18n.register(code, label, name, translations)

   To add a new language:
   1. Copy /js/i18n/en.js to /js/i18n/{code}.js
   2. Translate all values (keep keys in English)
   3. Change the register() call: i18n.register('{code}', '{CODE}', '{Native Name}', { ... })
   4. Add <script src="/js/i18n/{code}.js"> in index.html (before i18n.js is NOT required, after is fine)
   5. That's it — the language appears automatically in the selector

   See CONTRIBUTING.md for full instructions.
   ═══════════════════════════════════════════════════ */
'use strict';

const i18n = {
  _lang: 'en',
  _fallback: 'en',
  _translations: {},
  _languages: [], // { code, label, name }

  /** Register a language. Called by each /js/i18n/{code}.js file. */
  register(code, label, name, translations) {
    this._translations[code] = translations;
    // Avoid duplicates
    if (!this._languages.find(l => l.code === code)) {
      this._languages.push({ code, label, name });
    }
  },

  init() {
    const saved = localStorage.getItem('dd-lang');
    if (saved && this._translations[saved]) this._lang = saved;
    document.documentElement.lang = this._lang;
  },

  get lang() { return this._lang; },

  setLang(lang) {
    if (!this._translations[lang]) return;
    this._lang = lang;
    localStorage.setItem('dd-lang', lang);
    document.documentElement.lang = lang;
  },

  t(key, params) {
    let val = this._resolve(this._translations[this._lang], key);
    if (val === undefined) val = this._resolve(this._translations[this._fallback], key);
    if (val === undefined) { console.warn(`[i18n] Missing: "${key}"`); return key; }
    if (params && typeof val === 'string') {
      val = val.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] !== undefined ? params[k] : `{{${k}}}`);
    }
    return val;
  },

  _resolve(obj, key) {
    if (!obj) return undefined;
    const parts = key.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  },

  /** Get all registered languages */
  get languages() {
    return this._languages;
  },

  /** Get the next language code (for cycling through languages) */
  nextLang() {
    const idx = this._languages.findIndex(l => l.code === this._lang);
    const next = this._languages[(idx + 1) % this._languages.length];
    return next?.code || 'en';
  },
};

window.i18n = i18n;
