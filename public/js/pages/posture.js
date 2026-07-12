/* ═══════════════════════════════════════════════════
   pages/posture.js — Security Posture (v8.9.37)
   ═══════════════════════════════════════════════════ */
'use strict';

// Unified posture score + severity-ranked findings + remediation, aggregated from
// existing signals (firewall, egress, vSphere EOL/CVE, secrets, RBAC). Read-only
// for viewers; admins can rescan and mute/acknowledge. Alpha page → English.

const PosturePage = {
  _data: null,
  _showMuted: false,

  _SEV: {
    critical: { c: '#f85149', label: 'Critical' },
    high: { c: '#db6d28', label: 'High' },
    medium: { c: '#d29922', label: 'Medium' },
    low: { c: '#388bfd', label: 'Low' },
    info: { c: '#8b949e', label: 'Info' },
  },
  _gradeColor(g) { return { A: '#3fb950', B: '#3fb950', C: '#d29922', D: '#db6d28', F: '#f85149' }[g] || '#8b949e'; },

  async render(container) {
    this._isAdmin = (window.App && App.user && App.user.role) === 'admin';
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-shield-halved"></i> Security Posture <span class="badge badge-warning">alpha</span></h2>
          <div class="page-subtitle">One score for your estate — findings ranked by severity, with a fix for each. No telemetry.</div>
        </div>
        <div class="page-actions" style="align-items:center">
          ${this._isAdmin ? '<button class="btn btn-sm btn-primary" id="pt-rescan"><i class="fas fa-radar"></i> Rescan</button>' : ''}
          <button class="btn btn-sm btn-secondary" id="pt-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="pt-content"><div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Assessing…</div></div>
    `;
    container.querySelector('#pt-refresh').addEventListener('click', () => this._load());
    container.querySelector('#pt-rescan')?.addEventListener('click', () => this._rescan());
    await this._load();
    this._loadTrend();
  },

  async _load() {
    const el = document.getElementById('pt-content');
    if (!el) return;
    el.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Assessing…</div>';
    try { this._data = await Api.getPosture(); this._render(); this._loadTrend(); }
    catch (err) { el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`; }
  },

  async _rescan() {
    const btn = document.getElementById('pt-rescan');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning…'; }
    try { this._data = await Api.rescanPosture(); this._render(); this._loadTrend(); Toast.success('Rescanned'); }
    catch (err) { Toast.error(err.message); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-radar"></i> Rescan'; } }
  },

  _render() {
    const d = this._data; const g = d.global;
    const open = (d.findings || []).filter(f => !f.muted);
    const muted = (d.findings || []).filter(f => f.muted);
    const el = document.getElementById('pt-content');

    el.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
        <div class="card" style="padding:18px;display:flex;align-items:center;gap:18px;min-width:260px">
          ${this._gauge(g.score, g.grade)}
          <div>
            <div style="font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px">Estate posture</div>
            <div style="font-size:28px;font-weight:800;color:${this._gradeColor(g.grade)}">${g.grade} · ${g.score}/100</div>
            <div style="font-size:12px;color:var(--text-dim)">${open.length} open finding(s) · ${d.coverage.totalHosts} host(s)</div>
          </div>
        </div>
        <div class="card" style="padding:18px;flex:1;min-width:260px">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">By severity</div>
          ${this._sevBars(g.counts, open.length)}
        </div>
        <div class="card" style="padding:18px;flex:1;min-width:220px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px">Score trend</div>
          </div>
          <div id="pt-trend" style="height:56px"><span class="text-dim text-sm">—</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-triangle-exclamation text-dim" style="margin-right:8px"></i>Findings</h3>
          ${muted.length ? `<button class="btn btn-xs btn-secondary" id="pt-togglemuted">${this._showMuted ? 'Hide' : 'Show'} muted (${muted.length})</button>` : ''}
        </div>
        <div class="card-body" style="padding:0">
          ${open.length === 0 ? '<div class="empty-msg"><i class="fas fa-circle-check" style="color:var(--green)"></i> No open findings. Nice.</div>'
            : `<table class="data-table"><thead><tr><th style="width:90px">Severity</th><th>Finding</th><th>Host</th><th style="width:160px"></th></tr></thead>
              <tbody>${open.map(f => this._row(f)).join('')}</tbody></table>`}
          ${(this._showMuted && muted.length) ? `<div style="padding:10px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--text-dim)">Muted</div>
            <table class="data-table"><tbody>${muted.map(f => this._row(f)).join('')}</tbody></table>` : ''}
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-server text-dim" style="margin-right:8px"></i>Per-host posture</h3></div>
        <div class="card-body" style="padding:0">
          <table class="data-table"><thead><tr><th>Host</th><th>Type</th><th>Grade</th><th>Score</th><th>Findings</th></tr></thead>
          <tbody>${(d.hosts || []).map(h => `
            <tr>
              <td><strong>${Utils.escapeHtml(h.name)}</strong></td>
              <td class="text-sm text-dim">${Utils.escapeHtml(h.daemonType)}</td>
              <td><span class="badge" style="background:${this._gradeColor(h.grade)};color:#fff">${h.grade}</span></td>
              <td class="mono">${h.score}</td>
              <td class="text-sm">${this._miniCounts(h.counts)}</td>
            </tr>`).join('')}</tbody></table>
        </div>
      </div>
    `;

    el.querySelectorAll('[data-pt-fix]').forEach(b => b.addEventListener('click', () => this._openFinding(b.getAttribute('data-pt-fix'))));
    el.querySelector('#pt-togglemuted')?.addEventListener('click', () => { this._showMuted = !this._showMuted; this._render(); this._loadTrend(); });
  },

  _row(f) {
    const s = this._SEV[f.severity] || this._SEV.info;
    return `<tr${f.muted ? ' style="opacity:.55"' : ''}>
      <td><span class="badge" style="background:${s.c};color:#fff">${s.label}</span></td>
      <td>${Utils.escapeHtml(f.title)}${f.muted ? ' <span class="badge badge-info">muted</span>' : ''}</td>
      <td class="text-sm text-dim">${f.hostId != null ? Utils.escapeHtml(this._hostName(f.hostId)) : '—'}</td>
      <td style="text-align:right"><button class="btn btn-xs btn-secondary" data-pt-fix="${Utils.escapeHtml(f.key)}"><i class="fas fa-wrench"></i> Remediate</button></td>
    </tr>`;
  },

  _hostName(id) { const h = (this._data.hosts || []).find(x => x.hostId === id); return h ? h.name : `host ${id}`; },

  _miniCounts(c) {
    const parts = [];
    for (const k of ['critical', 'high', 'medium', 'low']) if (c[k]) parts.push(`<span style="color:${this._SEV[k].c}">${c[k]} ${k[0].toUpperCase()}</span>`);
    return parts.length ? parts.join(' · ') : '<span class="text-dim">clean</span>';
  },

  _gauge(score, grade) {
    const col = this._gradeColor(grade);
    const dash = `${Math.max(0, Math.min(100, score))} 100`;
    return `<div style="position:relative;width:88px;height:88px;flex:0 0 auto">
      <svg viewBox="0 0 36 36" style="width:100%;height:100%;transform:rotate(-90deg)">
        <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--surface3)" stroke-width="3.2"/>
        <circle cx="18" cy="18" r="15.915" fill="none" stroke="${col}" stroke-width="3.2" stroke-dasharray="${dash}" stroke-linecap="round"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:${col}">${grade}</div>
    </div>`;
  },

  _sevBars(counts, total) {
    const order = ['critical', 'high', 'medium', 'low'];
    const max = Math.max(1, ...order.map(k => counts[k] || 0));
    return order.map(k => {
      const n = counts[k] || 0; const s = this._SEV[k];
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="width:64px;font-size:12px;color:${s.c}">${s.label}</span>
        <div style="flex:1;height:8px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="width:${(n / max) * 100}%;height:100%;background:${s.c}"></div></div>
        <span class="mono" style="width:24px;text-align:right">${n}</span>
      </div>`;
    }).join('');
  },

  async _loadTrend() {
    const el = document.getElementById('pt-trend');
    if (!el) return;
    try {
      const { points } = await Api.getPostureTrend();
      if (!points || points.length < 2) { el.innerHTML = '<span class="text-dim text-sm">Not enough history yet.</span>'; return; }
      const w = 220, h = 56, pad = 4;
      const xs = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
      const ys = (v) => pad + (1 - v / 100) * (h - 2 * pad);
      const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.score).toFixed(1)}`).join(' ');
      const last = points[points.length - 1];
      el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%">
        <path d="${path}" fill="none" stroke="${this._gradeColor(last.grade)}" stroke-width="2"/>
      </svg>`;
    } catch { el.innerHTML = '<span class="text-dim text-sm">—</span>'; }
  },

  _openFinding(key) {
    const f = (this._data.findings || []).find(x => x.key === key);
    if (!f) return;
    const s = this._SEV[f.severity] || this._SEV.info;
    const r = f.remediation || {};
    const html = `
      <div class="modal-header">
        <h3><span class="badge" style="background:${s.c};color:#fff;margin-right:8px">${s.label}</span>${Utils.escapeHtml(f.title)}</h3>
        <button class="modal-close-btn" id="pt-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="max-height:70vh;overflow:auto">
        <p>${Utils.escapeHtml(f.detail || '')}</p>
        ${f.hostId != null ? `<div class="text-sm text-dim" style="margin-bottom:8px">Host: <b>${Utils.escapeHtml(this._hostName(f.hostId))}</b></div>` : ''}
        ${f.evidence ? `<div class="text-sm text-dim" style="margin-bottom:8px">Evidence: <span class="mono">${Utils.escapeHtml(f.evidence)}</span></div>` : ''}
        <div class="card" style="padding:12px;margin-top:8px">
          <div style="font-weight:600;margin-bottom:6px"><i class="fas fa-wrench"></i> Remediation</div>
          ${r.steps ? `<p class="text-sm" style="white-space:pre-wrap">${Utils.escapeHtml(r.steps)}</p>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${(r.action && this._isAdmin && !f.muted) ? `<button class="btn btn-sm btn-primary" id="pt-apply"><i class="fas fa-wand-magic-sparkles"></i> Apply fix</button>` : ''}
            ${r.link ? `<a class="btn btn-sm ${r.action ? 'btn-secondary' : 'btn-primary'}" href="${Utils.escapeHtml(r.link)}" id="pt-goto"><i class="fas fa-arrow-right"></i> ${Utils.escapeHtml(r.label || 'Open')}</a>` : ''}
          </div>
        </div>
        ${f.muted
          ? `<div style="margin-top:12px">${this._isAdmin ? '<button class="btn btn-sm btn-secondary" id="pt-unmute"><i class="fas fa-volume-high"></i> Un-mute</button>' : '<span class="text-dim text-sm">Muted.</span>'}</div>`
          : (this._isAdmin ? `<div style="margin-top:12px"><button class="btn btn-sm btn-secondary" id="pt-mute"><i class="fas fa-volume-xmark"></i> Mute / acknowledge</button></div>` : '')}
      </div>`;
    Modal.open(html, { width: '620px' });
    Modal._content.querySelector('#pt-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#pt-goto')?.addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#pt-apply')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying…';
      try {
        const res = await Api.remediatePosture(f.remediation.action);
        if (res && res.ok === false) { Toast.error(res.error || 'Fix failed'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Apply fix'; return; }
        Toast.success('Fix applied'); Modal.close(); await this._load();
      } catch (err) { Toast.error(err.message); btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Apply fix'; }
    });
    Modal._content.querySelector('#pt-mute')?.addEventListener('click', () => { Modal.close(); this._muteDialog(f); });
    Modal._content.querySelector('#pt-unmute')?.addEventListener('click', async () => {
      try { await Api.unmutePosture(f.key); Toast.success('Un-muted'); Modal.close(); await this._load(); } catch (e) { Toast.error(e.message); }
    });
  },

  async _muteDialog(f) {
    const result = await Modal.form(`
      <p class="text-muted" style="font-size:13px">Muting removes a finding from the score. It stays visible under “muted” and is audited.</p>
      <div class="form-group"><label>Reason</label><input type="text" id="pt-reason" class="form-control" placeholder="e.g. accepted risk / compensating control"></div>
      <div class="form-group"><label>Expires in (minutes) <span class="text-muted">(optional — blank = permanent)</span></label>
        <input type="number" id="pt-min" class="form-control" min="1" placeholder="e.g. 1440 for a day"></div>
    `, { title: 'Mute finding', width: '480px', onSubmit: (c) => ({ reason: c.querySelector('#pt-reason').value.trim(), minutes: c.querySelector('#pt-min').value.trim() }) });
    if (!result) return;
    try {
      await Api.mutePosture({ findingKey: f.key, hostId: f.hostId, checkId: f.checkId, reason: result.reason, minutes: result.minutes || undefined });
      Toast.success('Muted');
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  destroy() {},
};

window.PosturePage = PosturePage;
