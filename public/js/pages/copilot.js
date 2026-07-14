/* ═══════════════════════════════════════════════════
   pages/copilot.js — Ops Copilot (v8.9.43)
   ═══════════════════════════════════════════════════ */
'use strict';

// Local-first ops/security advisor. Tier 1 briefing (rule-based, always works).
// Tier 2 optional bring-your-own LLM (local Ollama / any OpenAI-compatible) for a
// narrative + Q&A. Advise-only. Nothing leaves the box unless you point it at a
// remote endpoint. Alpha page → English.

const CopilotPage = {
  _brief: null, _chat: [],

  _SEV: { critical: '#f85149', high: '#db6d28', medium: '#d29922', low: '#388bfd', info: '#8b949e' },

  async render(container) {
    this._isAdmin = (window.App && App.user && App.user.role) === 'admin';
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-wand-magic-sparkles"></i> Copilot <span class="badge badge-warning">alpha</span></h2>
          <div class="page-subtitle">Cross-layer security &amp; ops advisor. Rule-based by default; bring your own LLM for narrative + Q&amp;A. No telemetry.</div>
        </div>
        <div class="page-actions" style="align-items:center">
          ${this._isAdmin ? '<button class="btn btn-sm btn-secondary" id="cp-config"><i class="fas fa-gear"></i> LLM settings</button>' : ''}
          <button class="btn btn-sm btn-secondary" id="cp-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="cp-content"><div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Assessing…</div></div>
    `;
    container.querySelector('#cp-refresh').addEventListener('click', () => this._load(true));
    container.querySelector('#cp-config')?.addEventListener('click', () => this._configDialog());
    await this._loadHistory();
    await this._load(false);
  },

  // Restore prior turns on page load (admin-only endpoint — same auth as ask).
  async _loadHistory() {
    if (!this._isAdmin) return;
    try {
      const rows = await Api.getCopilotHistory();
      this._chat = (rows || []).map(r => ({ role: r.role, content: r.content }));
    } catch { /* non-fatal — conversation just starts empty */ }
  },

  async _clearHistory() {
    const ok = await Modal.confirm('Clear the copilot conversation history? This cannot be undone.', { danger: true, confirmText: 'Clear history' });
    if (!ok) return;
    try {
      await Api.clearCopilotHistory();
      this._chat = [];
      this._renderTranscript();
      Toast.success('Copilot history cleared');
    } catch (err) { Toast.error(err.message); }
  },

  async _load(fresh) {
    const el = document.getElementById('cp-content');
    if (!el) return;
    el.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Assessing…</div>';
    try { this._brief = await Api.getCopilotBriefing(fresh); this._render(); }
    catch (err) { el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`; }
  },

  _render() {
    const b = this._brief;
    const el = document.getElementById('cp-content');
    el.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-body">
          <div style="font-size:15px;font-weight:600;margin-bottom:6px"><i class="fas fa-clipboard-list" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(b.summary || '')}</div>
          ${b.narrative ? `<div style="white-space:pre-wrap;font-size:14px;line-height:1.5;border-left:3px solid var(--accent);padding-left:12px;margin-top:8px">${Utils.escapeHtml(b.narrative)}</div>`
            : (b.llmEnabled ? (b.llmError ? `<div class="alert alert-warning" style="font-size:12px;margin-top:8px">LLM narrative unavailable: ${Utils.escapeHtml(b.llmError)}</div>` : '')
              : '<div class="text-dim text-sm" style="margin-top:6px">Tip: configure an LLM endpoint (LLM settings) for a narrative briefing and Q&amp;A. The recommendations below work without it.</div>')}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3><i class="fas fa-list-check text-dim" style="margin-right:8px"></i>Recommended actions</h3></div>
        <div class="card-body" style="padding:0">
          ${(b.recommendations || []).length === 0 ? '<div class="empty-msg"><i class="fas fa-circle-check" style="color:var(--green)"></i> Nothing pressing — your estate looks clean.</div>'
            : `<table class="data-table"><thead><tr><th style="width:80px">Sev</th><th>What</th><th>Why</th><th style="width:150px"></th></tr></thead>
              <tbody>${b.recommendations.map((r, i) => `
                <tr>
                  <td><span class="badge" style="background:${this._SEV[r.severity] || '#8b949e'};color:#fff">${Utils.escapeHtml(r.severity)}</span></td>
                  <td><strong>${Utils.escapeHtml(r.title)}</strong>${r.host ? `<div class="text-sm text-dim">${Utils.escapeHtml(r.host)}</div>` : ''}</td>
                  <td class="text-sm text-dim">${Utils.escapeHtml(r.why || '')}</td>
                  <td style="text-align:right;white-space:nowrap">
                    ${(r.fixAction && this._isAdmin) ? `<button class="btn btn-xs btn-primary" data-cp-fix="${i}"><i class="fas fa-wand-magic-sparkles"></i> Apply fix</button> ` : ''}
                    ${r.link ? `<a class="btn btn-xs btn-secondary" href="${Utils.escapeHtml(r.link)}"><i class="fas fa-arrow-right"></i> ${Utils.escapeHtml(r.action || 'Open')}</a>` : ''}
                  </td>
                </tr>`).join('')}</tbody></table>`}
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <h3><i class="fas fa-comments text-dim" style="margin-right:8px"></i>Ask the copilot</h3>
          ${(this._isAdmin && this._chat.length > 0) ? '<button class="btn btn-xs btn-secondary" id="cp-clear-history"><i class="fas fa-trash"></i> Clear history</button>' : ''}
        </div>
        <div class="card-body">
          ${!b.llmEnabled ? '<div class="text-dim text-sm">Configure an LLM endpoint (LLM settings) to ask questions over your estate. Everything stays local if you point it at Ollama.</div>'
            : `<div id="cp-transcript" style="max-height:320px;overflow:auto;margin-bottom:10px"></div>
              <div style="display:flex;gap:8px">
                <input type="text" id="cp-q" class="form-control" placeholder="e.g. what should I fix first? is anything reachable from the internet?" ${this._isAdmin ? '' : 'disabled'}>
                <button class="btn btn-primary" id="cp-send" ${this._isAdmin ? '' : 'disabled'}><i class="fas fa-paper-plane"></i></button>
              </div>
              ${this._isAdmin ? '' : '<div class="text-dim text-sm" style="margin-top:6px">Viewers can read the briefing; asking is admin-only.</div>'}`}
        </div>
      </div>
    `;
    this._renderTranscript();
    el.querySelector('#cp-send')?.addEventListener('click', () => this._ask());
    el.querySelector('#cp-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._ask(); });
    el.querySelector('#cp-clear-history')?.addEventListener('click', () => this._clearHistory());
    el.querySelectorAll('[data-cp-fix]').forEach(btn => btn.addEventListener('click', () => this._applyFix(parseInt(btn.getAttribute('data-cp-fix'), 10), btn)));
  },

  async _applyFix(idx, btn) {
    const rec = (this._brief.recommendations || [])[idx];
    if (!rec || !rec.fixAction) return;
    const ok = await Modal.confirm(`Apply the safe fix for “${rec.title}”? (Goes through the firewall lockout guard.)`, { confirmText: 'Apply fix' });
    if (!ok) return;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    try {
      const r = await Api.remediatePosture(rec.fixAction);
      if (r && r.ok === false) { Toast.error(r.error || 'Fix failed'); }
      else { Toast.success('Fix applied'); }
      await this._load(true);
    } catch (err) { Toast.error(err.message); if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Apply fix'; } }
  },

  _renderTranscript() {
    const t = document.getElementById('cp-transcript');
    if (!t) return;
    t.innerHTML = this._chat.map(m => `
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:var(--text-dim)">${m.role === 'user' ? 'You' : 'Copilot'}</div>
        <div style="white-space:pre-wrap;${m.role === 'user' ? 'font-weight:600' : ''}">${Utils.escapeHtml(m.content)}</div>
      </div>`).join('');
    t.scrollTop = t.scrollHeight;
  },

  async _ask() {
    const input = document.getElementById('cp-q');
    const q = input && input.value.trim();
    if (!q) return;
    input.value = '';
    this._chat.push({ role: 'user', content: q });
    this._chat.push({ role: 'assistant', content: '…' });
    this._renderTranscript();
    try {
      const r = await Api.askCopilot(q);
      this._chat[this._chat.length - 1] = { role: 'assistant', content: r.answer || r.error || '(no answer)' };
    } catch (err) { this._chat[this._chat.length - 1] = { role: 'assistant', content: `Error: ${err.message}` }; }
    this._renderTranscript();
  },

  async _configDialog() {
    let cur = { enabled: false, base_url: '', model: '', hasKey: false };
    try { cur = await Api.getCopilotConfig(); } catch { /* ignore */ }
    const result = await Modal.form(`
      <div class="alert alert-warning" style="font-size:12px"><i class="fas fa-shield-halved"></i> The copilot sends a secret-free context bundle (host names, findings, counts) ONLY to the endpoint you set. Point it at a <b>local Ollama</b> and nothing leaves your box; a cloud endpoint sends that data to that provider. docker-dash never phones home.</div>
      <label style="display:flex;align-items:center;gap:8px;margin:8px 0"><input type="checkbox" id="cp-en" ${cur.enabled ? 'checked' : ''}> Enable LLM (narrative + Q&amp;A)</label>
      <div class="form-group"><label>Base URL <span class="text-muted">(include the API prefix)</span></label>
        <input type="text" id="cp-url" class="form-control" placeholder="http://host.docker.internal:11434/v1" value="${Utils.escapeHtml(cur.base_url || '')}"></div>
      <div class="form-group"><label>Model</label>
        <input type="text" id="cp-model" class="form-control" placeholder="llama3.1  /  gpt-4o-mini  /  qwen2.5" value="${Utils.escapeHtml(cur.model || '')}"></div>
      <div class="form-group"><label>API key ${cur.hasKey ? '<span class="badge badge-running">stored</span>' : '<span class="text-muted">(optional — Ollama needs none)</span>'}</label>
        <input type="password" id="cp-key" class="form-control" placeholder="${cur.hasKey ? '•••••• (leave blank to keep)' : 'sk-… (only for cloud endpoints)'}"></div>
      ${cur.hasKey ? '<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="cp-clear"> Clear the stored API key</label>' : ''}
      <div style="margin-top:8px"><button type="button" class="btn btn-sm btn-secondary" id="cp-test"><i class="fas fa-plug"></i> Test connection</button> <span id="cp-test-out" style="font-size:13px;margin-left:8px"></span></div>
    `, {
      title: 'Copilot LLM settings', width: '600px',
      onSubmit: (c) => ({
        enabled: c.querySelector('#cp-en').checked,
        base_url: c.querySelector('#cp-url').value.trim(),
        model: c.querySelector('#cp-model').value.trim(),
        api_key: c.querySelector('#cp-key').value.trim(),
        clearKey: !!(c.querySelector('#cp-clear') && c.querySelector('#cp-clear').checked),
      }),
      onMount: (c) => {
        c.querySelector('#cp-test')?.addEventListener('click', async () => {
          // Save first (so test uses the entered values), then test.
          const out = c.querySelector('#cp-test-out'); out.textContent = 'Saving + testing…';
          try {
            await Api.setCopilotConfig({ enabled: c.querySelector('#cp-en').checked, base_url: c.querySelector('#cp-url').value.trim(), model: c.querySelector('#cp-model').value.trim(), api_key: c.querySelector('#cp-key').value.trim() });
            const r = await Api.testCopilotConfig();
            out.innerHTML = r && r.ok ? `<span style="color:var(--green)">OK: ${Utils.escapeHtml(r.sample || '')}</span>` : `<span style="color:var(--red)">${Utils.escapeHtml((r && r.error) || 'failed')}</span>`;
          } catch (e) { out.innerHTML = `<span style="color:var(--red)">${Utils.escapeHtml(e.message)}</span>`; }
        });
      },
    });
    if (!result) return;
    try { await Api.setCopilotConfig(result); Toast.success('Copilot settings saved'); await this._load(true); }
    catch (err) { Toast.error(err.message); }
  },

  destroy() {},
};

window.CopilotPage = CopilotPage;
