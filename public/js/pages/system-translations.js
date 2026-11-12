/* ═══════════════════════════════════════════════════
   pages/system-translations.js — Translations tab (v6.11.0)

   Extracted from system.js in the v8.2.x further-split refactor.
   Google Translate + DeepL integration, quota tracking, runtime DB
   overrides applied on login (no file download / git commit / rebuild).
   AES-GCM encrypted API keys, hash-chained audit trail.

   5 methods: _renderTranslations / _renderTranslationsProviders /
   _renderTranslationsUsage / _renderTranslationsTranslate /
   _renderTranslationsReview. Merged into SystemPage at module load via
   Object.assign at the bottom of system.js.
   ═══════════════════════════════════════════════════ */
'use strict';

const SystemPageTranslations = {
  async _renderTranslations(el) {
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="card-body" style="padding:12px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-sm ${this._tTab === 'providers' || !this._tTab ? 'btn-primary' : 'btn-secondary'}" data-ttab="providers"><i class="fas fa-key" style="margin-right:4px"></i>Providers</button>
            <button class="btn btn-sm ${this._tTab === 'usage' ? 'btn-primary' : 'btn-secondary'}" data-ttab="usage"><i class="fas fa-chart-line" style="margin-right:4px"></i>Usage</button>
            <button class="btn btn-sm ${this._tTab === 'translate' ? 'btn-primary' : 'btn-secondary'}" data-ttab="translate"><i class="fas fa-language" style="margin-right:4px"></i>Translate</button>
            <button class="btn btn-sm ${this._tTab === 'review' ? 'btn-primary' : 'btn-secondary'}" data-ttab="review"><i class="fas fa-check-double" style="margin-right:4px"></i>Review &amp; Export</button>
          </div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-dim)">
            <i class="fas fa-info-circle" style="margin-right:6px"></i>
            Auto-translate i18n gaps using Google Translate + DeepL free tiers (500k chars / month each). Review each translation before exporting to a locale file.
          </div>
        </div>
      </div>
      <div id="translations-panel"></div>
    `;
    el.querySelectorAll('[data-ttab]').forEach(b => b.addEventListener('click', () => {
      this._tTab = b.dataset.ttab;
      this._renderTranslations(el);
    }));

    const panel = el.querySelector('#translations-panel');
    const tab = this._tTab || 'providers';
    if (tab === 'providers') await this._renderTranslationsProviders(panel);
    else if (tab === 'usage') await this._renderTranslationsUsage(panel);
    else if (tab === 'translate') await this._renderTranslationsTranslate(panel);
    else if (tab === 'review') await this._renderTranslationsReview(panel);
  },

  async _renderTranslationsProviders(el) {
    el.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading…</div>`;
    // Brand colours — kept hex because these are vendor brand identities,
    // not theme tokens. Don't move to :root (they would confuse a dark/light swap).
    const BRAND_COLOR = { google: '#4285f4', deepl: '#0f2b46' };
    try {
      const { providers } = await Api.translationsProviders();
      const byName = Object.fromEntries(providers.map(p => [p.provider, p]));
      const card = (providerName, displayName, signupUrl) => {
        const p = byName[providerName];
        return `
          <div class="card" style="margin:0">
            <div class="card-header"><h3 style="margin:0"><i class="fas ${providerName === 'google' ? 'fa-google' : 'fa-language'}" style="margin-right:8px;color:${BRAND_COLOR[providerName] || 'var(--text-dim)'}"></i>${displayName}</h3>
              ${p ? `<span class="badge ${p.is_active ? 'badge-running' : 'badge-stopped'}" style="font-size:10px">${p.is_active ? 'active' : 'disabled'}</span>` : '<span class="badge badge-warning" style="font-size:10px">not configured</span>'}
            </div>
            <div class="card-body">
              <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;margin-bottom:10px">
                <label style="font-size:12px">API key:</label>
                <input type="password" class="tprov-key" data-provider="${providerName}" placeholder="${p ? '•••••••• (stored, paste new to rotate)' : 'Paste API key'}" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
                <label style="font-size:12px">Monthly limit:</label>
                <input type="number" class="tprov-limit" data-provider="${providerName}" value="${p?.monthly_limit || 500000}" min="1000" step="10000" style="width:180px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
                <label style="font-size:12px">Notes:</label>
                <input type="text" class="tprov-notes" data-provider="${providerName}" value="${Utils.escapeHtml(p?.notes || '')}" placeholder="optional" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn btn-sm btn-primary tprov-save" data-provider="${providerName}"><i class="fas fa-save" style="margin-right:4px"></i>${p ? 'Update' : 'Save'}</button>
                ${p ? `<button class="btn btn-sm btn-secondary tprov-test" data-id="${p.id}"><i class="fas fa-vial" style="margin-right:4px"></i>Test</button>` : ''}
                ${p ? `<button class="btn btn-sm btn-secondary tprov-toggle" data-id="${p.id}" data-active="${p.is_active}"><i class="fas fa-power-off" style="margin-right:4px"></i>${p.is_active ? 'Disable' : 'Enable'}</button>` : ''}
                ${p ? `<button class="btn btn-sm btn-danger tprov-delete" data-id="${p.id}"><i class="fas fa-trash"></i></button>` : ''}
                <a ${Utils.externalLinkAttributes(signupUrl)} style="align-self:center;font-size:11px;color:var(--accent);text-decoration:none;margin-left:auto">Get free API key ↗</a>
              </div>
              <div class="tprov-status" data-provider="${providerName}" style="margin-top:10px;font-size:12px"></div>
            </div>
          </div>`;
      };

      el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          ${card('google', 'Google Translate', 'https://cloud.google.com/translate/docs/setup')}
          ${card('deepl', 'DeepL', 'https://www.deepl.com/pro#developer')}
        </div>`;

      const setStatus = (provider, html, color = 'var(--text-dim)') => {
        const s = el.querySelector(`.tprov-status[data-provider="${provider}"]`);
        if (s) s.innerHTML = `<span style="color:${color}">${html}</span>`;
      };

      el.querySelectorAll('.tprov-save').forEach(b => b.addEventListener('click', async () => {
        const provider = b.dataset.provider;
        const apiKey = el.querySelector(`.tprov-key[data-provider="${provider}"]`).value.trim();
        const monthlyLimit = parseInt(el.querySelector(`.tprov-limit[data-provider="${provider}"]`).value, 10) || 500000;
        const notes = el.querySelector(`.tprov-notes[data-provider="${provider}"]`).value.trim();
        if (!apiKey) { setStatus(provider, 'API key required', 'var(--red)'); return; }
        try {
          await Api.translationsUpsertProvider({ provider, apiKey, monthlyLimit, notes });
          Toast.success(`${provider} provider saved`);
          this._renderTranslationsProviders(el);
        } catch (err) { setStatus(provider, 'Failed: ' + err.message, 'var(--red)'); }
      }));
      el.querySelectorAll('.tprov-test').forEach(b => b.addEventListener('click', async () => {
        const provider = b.closest('.card').querySelector('.tprov-status').dataset.provider;
        setStatus(provider, '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>Testing…');
        try {
          const r = await Api.translationsTestProvider(parseInt(b.dataset.id, 10));
          setStatus(provider, '<i class="fas fa-check-circle" style="color:var(--green);margin-right:4px"></i>Key valid', 'var(--green)');
        } catch (err) { setStatus(provider, '<i class="fas fa-times-circle" style="color:var(--red);margin-right:4px"></i>' + Utils.escapeHtml(err.message), 'var(--red)'); }
      }));
      el.querySelectorAll('.tprov-toggle').forEach(b => b.addEventListener('click', async () => {
        try {
          await Api.translationsPatchProvider(parseInt(b.dataset.id, 10), { isActive: b.dataset.active !== 'true' });
          this._renderTranslationsProviders(el);
        } catch (err) { Toast.error(err.message); }
      }));
      el.querySelectorAll('.tprov-delete').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this provider? The API key will be forgotten. Usage history is preserved.')) return;
        try {
          await Api.translationsDeleteProvider(parseInt(b.dataset.id, 10));
          this._renderTranslationsProviders(el);
        } catch (err) { Toast.error(err.message); }
      }));
    } catch (err) {
      el.innerHTML = `<div class="empty-msg is-error">Failed: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _renderTranslationsUsage(el) {
    el.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading…</div>`;
    try {
      const { usage, yearMonth } = await Api.translationsUsage();
      if (usage.length === 0) {
        el.innerHTML = `<div class="empty-msg"><i class="fas fa-info-circle"></i><p>No providers configured yet. Go to Providers tab to add Google or DeepL.</p></div>`;
        return;
      }
      const bar = (u) => {
        const warn = u.percent >= 80;
        const danger = u.percent >= 100;
        const color = danger ? 'var(--red)' : warn ? 'var(--yellow)' : 'var(--accent)';
        return `
          <div class="card" style="margin:0">
            <div class="card-header"><h3 style="margin:0">${Utils.escapeHtml(u.provider)}</h3>
              <span class="badge ${u.isActive ? 'badge-running' : 'badge-stopped'}" style="font-size:10px">${u.isActive ? 'active' : 'disabled'}</span>
            </div>
            <div class="card-body">
              <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
                <span style="font-size:24px;font-weight:700;color:${color}">${u.used.toLocaleString()}</span>
                <span style="color:var(--text-dim)">/ ${u.limit.toLocaleString()} chars</span>
                <span style="margin-left:auto;font-size:12px;color:var(--text-dim)">${u.percent}%</span>
              </div>
              <div style="height:10px;background:var(--surface2);border-radius:5px;overflow:hidden">
                <div style="height:100%;width:${Math.min(100, u.percent)}%;background:${color};transition:width 0.3s"></div>
              </div>
              <div style="margin-top:8px;font-size:12px;color:var(--text-dim)">
                <i class="fas ${danger ? 'fa-exclamation-triangle' : warn ? 'fa-exclamation-circle' : 'fa-check-circle'}" style="color:${color};margin-right:4px"></i>
                ${danger ? 'Quota exceeded — translations will be refused until next month or limit bump' : warn ? `Only ${u.remaining.toLocaleString()} chars left this month` : `${u.remaining.toLocaleString()} chars remaining`}
              </div>
            </div>
          </div>`;
      };
      el.innerHTML = `
        <div style="margin-bottom:12px;font-size:13px"><i class="fas fa-calendar-alt" style="margin-right:6px"></i>Usage for <strong>${yearMonth}</strong> (resets on the 1st of next month)</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
          ${usage.map(bar).join('')}
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-msg is-error">Failed: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _renderTranslationsTranslate(el) {
    el.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading languages…</div>`;
    try {
      const [{ languages }, { providers }] = await Promise.all([
        Api.translationsLanguages(),
        Api.translationsProviders(),
      ]);
      const activeProviders = providers.filter(p => p.is_active);
      if (activeProviders.length === 0) {
        el.innerHTML = `<div class="empty-msg"><i class="fas fa-info-circle"></i><p>No active providers. Configure Google or DeepL in the Providers tab first.</p></div>`;
        return;
      }
      const nonEn = languages.filter(l => l.lang !== 'en');

      el.innerHTML = `
        <div class="card" style="margin-bottom:14px">
          <div class="card-body">
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <label style="font-size:13px">Language:</label>
              <select id="t-lang" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
                ${nonEn.map(l => `<option value="${l.lang}">${l.lang.toUpperCase()} — ${l.missing} missing (${l.coverage}% covered)</option>`).join('')}
              </select>
              <label style="font-size:13px;margin-left:10px">Provider:</label>
              <select id="t-provider" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
                ${activeProviders.map(p => `<option value="${p.provider}">${p.provider}</option>`).join('')}
              </select>
              <button class="btn btn-sm btn-primary" id="t-load-missing" style="margin-left:auto"><i class="fas fa-list" style="margin-right:4px"></i>Load missing keys</button>
            </div>
          </div>
        </div>
        <div id="t-missing-panel"></div>
      `;

      el.querySelector('#t-load-missing').addEventListener('click', async () => {
        const lang = el.querySelector('#t-lang').value;
        const panel = el.querySelector('#t-missing-panel');
        panel.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading missing keys…</div>`;
        try {
          const { missing } = await Api.translationsMissing(lang);
          if (missing.length === 0) {
            panel.innerHTML = `<div class="empty-msg"><i class="fas fa-check-circle" style="color:var(--green)"></i><p>No missing keys — <strong>${lang.toUpperCase()}</strong> is fully translated.</p></div>`;
            return;
          }
          const totalChars = missing.reduce((s, m) => s + (m.source_text || '').length, 0);
          panel.innerHTML = `
            <div style="margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <span class="text-sm"><strong>${missing.length}</strong> missing keys · ${totalChars.toLocaleString()} chars total</span>
              <label style="margin-left:auto;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px" title="Skip the Review step — translations go live immediately. Turn off if you want to check each one before it ships.">
                <input type="checkbox" id="t-auto-accept" checked><span>Auto-accept (apply live)</span>
              </label>
              <button class="btn btn-sm btn-secondary" id="t-select-all">Select all</button>
              <button class="btn btn-sm btn-secondary" id="t-select-none">None</button>
              <button class="btn btn-sm btn-primary" id="t-translate"><i class="fas fa-language" style="margin-right:4px"></i>Translate selected</button>
            </div>
            <div id="t-progress" style="display:none;margin-bottom:10px;padding:10px;background:var(--bg-dim);border-radius:6px">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px">
                <span id="t-progress-label"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Translating…</span>
                <span id="t-progress-stats" style="margin-left:auto;color:var(--text-dim)"></span>
                <button class="btn btn-xs btn-danger" id="t-cancel" title="Stop after current batch"><i class="fas fa-stop" style="margin-right:4px"></i>Cancel</button>
              </div>
              <div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden">
                <div id="t-progress-bar" style="height:100%;width:0;background:var(--accent);transition:width 0.2s"></div>
              </div>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:var(--bg-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px;width:30px"><input type="checkbox" id="t-check-all" checked></th>
                <th style="padding:6px;text-align:left">Key</th>
                <th style="padding:6px;text-align:left">English source</th>
                <th style="padding:6px;text-align:right;width:60px">Chars</th>
                <th style="padding:6px;text-align:left;width:120px">Cached</th>
              </tr></thead>
              <tbody>
              ${missing.map(m => `
                <tr style="border-bottom:1px solid var(--surface2)">
                  <td style="padding:6px"><input type="checkbox" class="t-key-cb" value="${Utils.escapeHtml(m.key)}" checked></td>
                  <td style="padding:6px;font-family:var(--mono);font-size:11px">${Utils.escapeHtml(m.key)}</td>
                  <td style="padding:6px">${Utils.escapeHtml(m.source_text)}</td>
                  <td style="padding:6px;text-align:right">${(m.source_text || '').length}</td>
                  <td style="padding:6px">${m.cached ? `<span class="badge" style="font-size:10px;background:rgba(74,222,128,0.15);color:var(--green)">${Utils.escapeHtml(m.cached.status)}</span>` : '<span class="text-muted">—</span>'}</td>
                </tr>`).join('')}
              </tbody>
            </table>`;

          // Master checkbox toggles all rows
          panel.querySelector('#t-check-all').addEventListener('change', (e) => {
            panel.querySelectorAll('.t-key-cb').forEach(cb => cb.checked = e.target.checked);
          });
          panel.querySelector('#t-select-all').addEventListener('click', () => {
            panel.querySelectorAll('.t-key-cb').forEach(cb => cb.checked = true);
            panel.querySelector('#t-check-all').checked = true;
          });
          panel.querySelector('#t-select-none').addEventListener('click', () => {
            panel.querySelectorAll('.t-key-cb').forEach(cb => cb.checked = false);
            panel.querySelector('#t-check-all').checked = false;
          });

          // v6.11.2: chunked batch translate with progress bar. No arbitrary UI cap —
          // internally sends 50 keys per API call (Google v2 + DeepL Free limit),
          // keeps going across batches until done, quota-exceeded, or user cancels.
          panel.querySelector('#t-translate').addEventListener('click', async () => {
            const selected = [...panel.querySelectorAll('.t-key-cb:checked')].map(cb => cb.value);
            if (selected.length === 0) { Toast.warning('Select at least one key'); return; }
            const provider = el.querySelector('#t-provider').value;
            const autoAccept = panel.querySelector('#t-auto-accept').checked;
            const btn = panel.querySelector('#t-translate');
            const progressEl = panel.querySelector('#t-progress');
            const progressBar = panel.querySelector('#t-progress-bar');
            const progressLabel = panel.querySelector('#t-progress-label');
            const progressStats = panel.querySelector('#t-progress-stats');
            const cancelBtn = panel.querySelector('#t-cancel');

            const BATCH_SIZE = 50;
            const batches = [];
            for (let i = 0; i < selected.length; i += BATCH_SIZE) batches.push(selected.slice(i, i + BATCH_SIZE));

            this._translationsCancelled = false;
            cancelBtn.onclick = () => { this._translationsCancelled = true; };

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>Translating…';
            progressEl.style.display = '';

            let totalTranslated = 0;
            let totalChars = 0;
            let lastError = null;
            try {
              for (let i = 0; i < batches.length; i++) {
                if (this._translationsCancelled) break;
                const chunk = batches[i];
                progressLabel.innerHTML = `<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Batch ${i + 1} of ${batches.length} (${chunk.length} keys)…`;
                progressStats.textContent = `${totalTranslated.toLocaleString()} / ${selected.length.toLocaleString()} translated · ${totalChars.toLocaleString()} chars used`;
                progressBar.style.width = `${Math.round((i / batches.length) * 100)}%`;
                try {
                  const r = await Api.translationsBatch({ provider, language: lang, keys: chunk, autoAccept });
                  totalTranslated += r.translated.length;
                  totalChars += r.chars;
                  // Apply live per batch if auto-accept so user sees UI updating
                  if (r.autoAccepted) await i18n.loadOverrides(lang);
                } catch (err) {
                  lastError = err;
                  break;  // stop on first failure (quota, network, etc.)
                }
              }
              progressBar.style.width = '100%';
              const label = this._translationsCancelled ? 'Cancelled' : lastError ? 'Stopped at error' : 'Done';
              progressLabel.innerHTML = `<i class="fas ${lastError ? 'fa-exclamation-triangle' : 'fa-check-circle'}" style="color:${lastError ? 'var(--red)' : 'var(--green)'};margin-right:6px"></i>${label}`;
              progressStats.textContent = `${totalTranslated.toLocaleString()} / ${selected.length.toLocaleString()} translated · ${totalChars.toLocaleString()} chars used`;
              cancelBtn.style.display = 'none';

              if (lastError) {
                Toast.error(lastError.message);
              } else if (totalTranslated > 0) {
                const live = autoAccept ? ' — live now' : '. Review in the Review tab.';
                Toast.success(`Translated ${totalTranslated} keys (${totalChars.toLocaleString()} chars via ${provider})${live}`);
              }

              // After 2s, if no error, jump to Review tab so user can see results
              if (!lastError && !this._translationsCancelled && totalTranslated > 0) {
                setTimeout(() => {
                  this._tTab = 'review';
                  this._renderTranslations(document.getElementById('sys-content'));
                }, 1500);
              }
            } finally {
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-language" style="margin-right:4px"></i>Translate selected';
            }
          });
        } catch (err) { panel.innerHTML = `<div class="empty-msg is-error">Failed: ${Utils.escapeHtml(err.message)}</div>`; }
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg is-error">Failed: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _renderTranslationsReview(el) {
    el.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Loading…</div>`;
    try {
      const { languages } = await Api.translationsLanguages();
      const nonEn = languages.filter(l => l.lang !== 'en');
      if (!this._reviewLang) this._reviewLang = nonEn[0]?.lang || 'ro';
      if (!this._reviewStatus) this._reviewStatus = 'pending';

      const { items } = await Api.translationsList({ language: this._reviewLang, status: this._reviewStatus });

      el.innerHTML = `
        <div class="card" style="margin-bottom:14px">
          <div class="card-body">
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <label style="font-size:13px">Language:</label>
              <select id="r-lang" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
                ${nonEn.map(l => `<option value="${l.lang}" ${l.lang === this._reviewLang ? 'selected' : ''}>${l.lang.toUpperCase()}</option>`).join('')}
              </select>
              <label style="font-size:13px;margin-left:10px">Status:</label>
              <select id="r-status" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)">
                <option value="pending" ${this._reviewStatus === 'pending' ? 'selected' : ''}>Pending</option>
                <option value="accepted" ${this._reviewStatus === 'accepted' ? 'selected' : ''}>Accepted</option>
                <option value="rejected" ${this._reviewStatus === 'rejected' ? 'selected' : ''}>Rejected</option>
                <option value="applied" ${this._reviewStatus === 'applied' ? 'selected' : ''}>Applied</option>
              </select>
              <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
                <span style="font-size:11px;color:var(--text-dim)">Accepted translations are live now — exports are optional for git contribution:</span>
                <a class="btn btn-sm btn-secondary" href="${Api.translationsExportUrl(this._reviewLang)}" download title="Download a merged ${this._reviewLang}.js file — useful if you want to commit to a forked source tree"><i class="fas fa-download" style="margin-right:4px"></i>Export ${this._reviewLang}.js</a>
              </div>
            </div>
          </div>
        </div>
        <div id="r-list">
          ${items.length === 0 ? '<div class="empty-msg"><i class="fas fa-info-circle"></i><p>No translations in this status.</p></div>' : `
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:var(--bg-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px;text-align:left">Key</th>
                <th style="padding:6px;text-align:left">English</th>
                <th style="padding:6px;text-align:left">Translation</th>
                <th style="padding:6px;text-align:left;width:70px">Provider</th>
                <th style="width:160px"></th>
              </tr></thead>
              <tbody>
              ${items.map(it => `
                <tr style="border-bottom:1px solid var(--surface2)" data-id="${it.id}">
                  <td style="padding:6px;font-family:var(--mono);font-size:10px">${Utils.escapeHtml(it.key)}</td>
                  <td style="padding:6px">${Utils.escapeHtml(it.source_text)}</td>
                  <td style="padding:6px"><input type="text" class="r-edit" value="${Utils.escapeHtml(it.translated_text)}" style="width:100%;padding:4px;border:1px solid var(--border);border-radius:3px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px"></td>
                  <td style="padding:6px;font-size:10px;color:var(--text-dim)">${Utils.escapeHtml(it.provider)}</td>
                  <td style="padding:6px;text-align:right">
                    <button class="btn btn-xs btn-primary r-accept" title="Accept + save edits"><i class="fas fa-check"></i></button>
                    <button class="btn btn-xs btn-secondary r-reject" title="Reject"><i class="fas fa-times"></i></button>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>`}
        </div>
      `;

      const reload = () => this._renderTranslationsReview(el);
      el.querySelector('#r-lang').addEventListener('change', e => { this._reviewLang = e.target.value; reload(); });
      el.querySelector('#r-status').addEventListener('change', e => { this._reviewStatus = e.target.value; reload(); });
      // v6.11.1 removed the "Mark as applied" button; it was tied to the export
      // flow which is now optional. Leaving the orphan listener caused a null-ref
      // crash when the Review panel opened. Fixed in v6.11.2.
      el.querySelectorAll('.r-accept').forEach(b => b.addEventListener('click', async () => {
        const tr = b.closest('tr');
        const id = tr.dataset.id;
        const text = tr.querySelector('.r-edit').value;
        try {
          await Api.translationsPatch(id, { status: 'accepted', translated_text: text });
          // v6.11.1: Hot-reload i18n so the newly-accepted string is live immediately,
          // not on next page refresh. Keeps the "I clicked Accept; why isn't it changing?"
          // confusion away.
          await i18n.loadOverrides(this._reviewLang);
          reload();
        } catch (err) { Toast.error(err.message); }
      }));
      el.querySelectorAll('.r-reject').forEach(b => b.addEventListener('click', async () => {
        const id = b.closest('tr').dataset.id;
        try { await Api.translationsPatch(id, { status: 'rejected' }); reload(); }
        catch (err) { Toast.error(err.message); }
      }));
    } catch (err) {
      el.innerHTML = `<div class="empty-msg is-error">Failed: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

};

if (typeof window !== 'undefined') window.SystemPageTranslations = SystemPageTranslations;
