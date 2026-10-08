/* ═══════════════════════════════════════════════════
   pages/diagnostics.js — Diagnostic Sessions (retrospective)
   ═══════════════════════════════════════════════════ */
'use strict';

// Containers and VMs on one time axis, for answering "what was happening at
// 14:32?". Read-only: a session never changes estate state.
//
// Series arrive pre-bucketed from the server, so this draws SVG polylines rather
// than pulling in a charting library. That is not only a size argument — a null
// bucket has to break the line, and splitting a polyline on nulls expresses
// "we have no data here" exactly, where a charting default would happily join
// across the gap and invent a trend.

const DiagnosticsPage = {
  _sessions: [],
  _timeline: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-wave-square" style="color:var(--accent)"></i> ${Utils.escapeHtml(i18n.t('pages.diagnostics.title'))}</h2>
          <div class="page-subtitle">${Utils.escapeHtml(i18n.t('pages.diagnostics.subtitle'))}</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary btn-sm" id="diag-new"><i class="fas fa-plus"></i> ${Utils.escapeHtml(i18n.t('pages.diagnostics.newSession'))}</button>
        </div>
      </div>
      <div id="diag-body"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${Utils.escapeHtml(i18n.t('common.loading'))}</div></div>
    `;
    container.querySelector('#diag-new').addEventListener('click', () => this._openCreate());
    await this._loadList();
  },

  async _loadList() {
    const el = document.getElementById('diag-body');
    if (!el) return;
    try {
      const res = await Api.getDiagnosticSessions();
      this._sessions = res.sessions || [];
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">${Utils.escapeHtml(err.message)}</div>`;
      return;
    }

    if (!this._sessions.length) {
      // The timeline host is emitted even here: a session created from the empty
      // state must have somewhere to render, and without it the first session an
      // operator makes appears to do nothing.
      el.innerHTML = `<div class="empty-msg">
        <i class="fas fa-wave-square"></i>
        <p>${Utils.escapeHtml(i18n.t('pages.diagnostics.empty'))}</p>
      </div>
      <div id="diag-timeline" style="margin-top:16px"></div>`;
      return;
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-body" style="padding:0">
          <table class="data-table compact">
            <thead><tr>
              <th>${Utils.escapeHtml(i18n.t('common.name'))}</th>
              <th>${Utils.escapeHtml(i18n.t('pages.diagnostics.window'))}</th>
              <th>${Utils.escapeHtml(i18n.t('pages.diagnostics.subjects'))}</th>
              <th>${Utils.escapeHtml(i18n.t('pages.diagnostics.createdBy'))}</th>
              <th></th>
            </tr></thead>
            <tbody>${this._sessions.map(s => `
              <tr>
                <td><a href="#" data-diag-open="${s.id}">${Utils.escapeHtml(s.name)}</a></td>
                <td class="text-sm text-muted">${Utils.escapeHtml(Utils.formatDate(s.window_start))} → ${Utils.escapeHtml(Utils.formatDate(s.window_end))}</td>
                <td>${s.subject_count}</td>
                <td class="text-sm text-muted">${Utils.escapeHtml(s.created_by_username || '—')}</td>
                <td style="text-align:right">
                  <button class="action-btn" data-diag-export="${s.id}" title="${Utils.escapeHtml(i18n.t('pages.diagnostics.export'))}"><i class="fas fa-download"></i></button>
                  <button class="action-btn" data-diag-delete="${s.id}" title="${Utils.escapeHtml(i18n.t('common.delete'))}"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div id="diag-timeline" style="margin-top:16px"></div>
    `;

    el.querySelectorAll('[data-diag-open]').forEach(a => a.addEventListener('click', (e) => {
      e.preventDefault();
      this._openTimeline(a.dataset.diagOpen);
    }));
    el.querySelectorAll('[data-diag-export]').forEach(b => b.addEventListener('click', () => this._export(b.dataset.diagExport)));
    el.querySelectorAll('[data-diag-delete]').forEach(b => b.addEventListener('click', () => this._delete(b.dataset.diagDelete)));
  },

  async _openCreate() {
    let containers = [];
    try { containers = await Api.getContainers(false); } catch { containers = []; }

    const options = containers.slice(0, 300).map(c =>
      `<label style="display:flex;gap:8px;align-items:center;padding:3px 0">
         <input type="checkbox" value="${Utils.escapeHtml(c.id)}" data-name="${Utils.escapeHtml(c.name)}">
         <span class="text-sm">${Utils.escapeHtml(c.name)}</span>
       </label>`).join('') || `<div class="text-muted text-sm">${Utils.escapeHtml(i18n.t('pages.diagnostics.noContainers'))}</div>`;

    const html = `
      <div class="form-group">
        <label>${Utils.escapeHtml(i18n.t('common.name'))}</label>
        <input class="form-control" id="diag-name" value="${Utils.escapeHtml(i18n.t('pages.diagnostics.defaultName'))}">
      </div>
      <div class="form-group">
        <label>${Utils.escapeHtml(i18n.t('pages.diagnostics.window'))}</label>
        <select class="form-control" id="diag-range">
          <option value="1">${Utils.escapeHtml(i18n.t('pages.diagnostics.range1h'))}</option>
          <option value="6" selected>${Utils.escapeHtml(i18n.t('pages.diagnostics.range6h'))}</option>
          <option value="24">${Utils.escapeHtml(i18n.t('pages.diagnostics.range24h'))}</option>
          <option value="168">${Utils.escapeHtml(i18n.t('pages.diagnostics.range7d'))}</option>
        </select>
      </div>
      <div class="form-group">
        <label>${Utils.escapeHtml(i18n.t('pages.diagnostics.pickSubjects'))}</label>
        <div class="search-box" style="margin-bottom:6px">
          <i class="fas fa-search"></i>
          <input type="text" id="diag-filter" placeholder="${Utils.escapeHtml(i18n.t('pages.diagnostics.filter'))}">
        </div>
        <div id="diag-subjects" style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">${options}</div>
        <div class="text-sm text-muted" style="margin-top:4px">${Utils.escapeHtml(i18n.t('pages.diagnostics.subjectCap'))}</div>
      </div>`;

    Modal.form(html, {
      title: i18n.t('pages.diagnostics.newSession'),
      submitLabel: i18n.t('common.create'),
      onMount: (root) => {
        const filter = root.querySelector('#diag-filter');
        filter.addEventListener('input', Utils.debounce(() => {
          const q = filter.value.toLowerCase();
          root.querySelectorAll('#diag-subjects label').forEach(l => {
            l.style.display = l.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
          });
        }, 200));
      },
      onSubmit: async (root) => {
        const picked = [...root.querySelectorAll('#diag-subjects input:checked')];
        if (!picked.length) { Toast.error(i18n.t('pages.diagnostics.pickAtLeastOne')); return null; }
        const hours = parseInt(root.querySelector('#diag-range').value, 10) || 6;
        const to = new Date();
        const from = new Date(to.getTime() - hours * 3600 * 1000);
        try {
          const session = await Api.createDiagnosticSession({
            name: root.querySelector('#diag-name').value || i18n.t('pages.diagnostics.defaultName'),
            from: from.toISOString(), to: to.toISOString(),
            subjects: picked.map(p => ({ type: 'container', ref: p.value, hostId: 0, displayName: p.dataset.name })),
          });
          Toast.success(i18n.t('pages.diagnostics.created'));
          await this._loadList();
          this._openTimeline(session.id);
          return session;
        } catch (err) { Toast.error(err.message); return null; }
      },
    });
  },

  async _openTimeline(id) {
    const host = document.getElementById('diag-timeline');
    if (!host) return;
    host.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${Utils.escapeHtml(i18n.t('common.loading'))}</div>`;
    let data;
    try { data = await Api.getDiagnosticTimeline(id); }
    catch (err) { host.innerHTML = `<div class="empty-msg">${Utils.escapeHtml(err.message)}</div>`; return; }
    this._timeline = data;

    const skew = data.clockSkewWarning
      ? `<div class="card" style="border-left:4px solid var(--yellow);margin-bottom:12px">
           <div class="card-body" style="padding:10px 14px">
             <i class="fas fa-triangle-exclamation" style="color:var(--yellow)"></i>
             <span class="text-sm">${Utils.escapeHtml(i18n.t('pages.diagnostics.skewWarning', { ms: data.clockSkewMs }))}</span>
           </div></div>`
      : '';

    const charts = data.series.map(s => this._renderSeries(s)).join('');
    const annotations = data.annotations.slice(0, 40).map(a => `
      <tr>
        <td class="text-sm mono">${Utils.escapeHtml(Utils.formatDate(a.t))}</td>
        <td><span class="badge" style="font-size:9px">${Utils.escapeHtml(a.source)}</span></td>
        <td class="text-sm">${Utils.escapeHtml(a.label)}</td>
      </tr>`).join('');

    host.innerHTML = `
      ${skew}
      <div class="card">
        <div class="card-header">
          <h3>${Utils.escapeHtml(data.session.name)}</h3>
          <span class="text-sm text-muted" style="margin-left:auto">
            ${Utils.escapeHtml(i18n.t('pages.diagnostics.resolution', { resolution: data.resolution }))}
          </span>
        </div>
        <div class="card-body">${charts || `<div class="text-muted">${Utils.escapeHtml(i18n.t('pages.diagnostics.noSeries'))}</div>`}</div>
      </div>
      ${annotations ? `
      <div class="card mt-md">
        <div class="card-header"><h3>${Utils.escapeHtml(i18n.t('pages.diagnostics.annotations'))}</h3></div>
        <div class="card-body" style="padding:0">
          <table class="data-table compact"><tbody>${annotations}</tbody></table>
        </div>
      </div>` : ''}
    `;
  },

  /** One subject: a labelled row of small multiples, one per metric. */
  _renderSeries(s) {
    if (!s.hasData) {
      return `<div style="margin-bottom:14px">
        <div style="font-weight:600;font-size:13px">${Utils.escapeHtml(s.name)}
          <span class="badge badge-info" style="font-size:9px;margin-left:6px">${Utils.escapeHtml(s.type)}</span></div>
        <div class="text-sm text-muted" style="margin-top:4px">
          ${Utils.escapeHtml(s.type === 'vm' ? i18n.t('pages.diagnostics.noVmTelemetry') : i18n.t('pages.diagnostics.noSamples'))}
        </div>
      </div>`;
    }
    const charts = (s.metrics || []).map(m => `
      <div style="flex:1;min-width:170px">
        <div class="text-sm text-muted">${Utils.escapeHtml(m.key)}${m.cumulative ? ' Δ' : ''}</div>
        ${this._sparkline(m.points)}
      </div>`).join('');
    return `<div style="margin-bottom:16px">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px">${Utils.escapeHtml(s.name)}
        <span class="badge badge-info" style="font-size:9px;margin-left:6px">${Utils.escapeHtml(s.type)}</span></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">${charts}</div>
    </div>`;
  },

  /**
   * A gap breaks the line. Consecutive non-null points form one polyline; a null
   * ends the current segment and a new one starts after it. Joining across the
   * gap would draw a trend nobody measured.
   */
  _sparkline(points) {
    const W = 220, H = 44;
    const values = points.map(p => p.v).filter(v => v !== null && Number.isFinite(v));
    if (!values.length) return `<svg width="${W}" height="${H}" role="img" aria-label="no data"></svg>`;
    const max = Math.max(...values);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const x = (i) => (i / Math.max(1, points.length - 1)) * W;
    const y = (v) => H - ((v - min) / span) * (H - 4) - 2;

    const segments = [];
    let current = [];
    points.forEach((p, i) => {
      if (p.v === null || !Number.isFinite(p.v)) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push({ x: x(i), y: y(p.v) });
    });
    if (current.length) segments.push(current);

    // A run of one point still has to be visible. Sparse data — a sample every
    // minute against a 600-bucket axis — puts every reading in its own bucket, so
    // dropping single-point runs would render real data as an empty chart. That
    // is the same "missing data looks like nothing happened" failure the null
    // handling exists to prevent, just one layer up.
    const lines = segments.map(seg => seg.length === 1
      ? `<circle cx="${seg[0].x.toFixed(1)}" cy="${seg[0].y.toFixed(1)}" r="1.6" fill="var(--accent)"/>`
      : `<polyline points="${seg.map(pt => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`
    ).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${Utils.escapeHtml(i18n.t('pages.diagnostics.chartLabel', { max: Math.round(max) }))}"
      style="background:var(--surface2);border-radius:4px">${lines}</svg>`;
  },

  async _export(id) {
    try {
      const data = await Api.exportDiagnosticSession(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `diagnostic-session-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { Toast.error(err.message); }
  },

  async _delete(id) {
    const ok = await Modal.confirm(i18n.t('pages.diagnostics.confirmDelete'), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try {
      await Api.deleteDiagnosticSession(id);
      Toast.success(i18n.t('pages.diagnostics.deleted'));
      const host = document.getElementById('diag-timeline');
      if (host) host.innerHTML = '';
      await this._loadList();
    } catch (err) { Toast.error(err.message); }
  },
};
