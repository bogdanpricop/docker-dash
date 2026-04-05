/* ═══════════════════════════════════════════════════
   pages/compare.js — Feature Comparison Matrix
   ═══════════════════════════════════════════════════ */
'use strict';

const ComparePage = {
  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-balance-scale" style="color:var(--accent)"></i> Feature Comparison</h2>
        <div class="page-actions">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" id="compare-search" placeholder="Filter features...">
          </div>
        </div>
      </div>
      <div id="compare-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading comparison data...</div></div>
    `;

    try {
      const data = await Api.getComparison();
      this._renderMatrix(data);

      container.querySelector('#compare-search')?.addEventListener('input', Utils.debounce(() => {
        this._filterFeatures(data);
      }, 200));
    } catch (err) {
      document.getElementById('compare-content').innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  _renderMatrix(data) {
    const el = document.getElementById('compare-content');
    const features = data.features;
    const exclusive = data.summary.dockerDash.exclusive;

    const fmt = (v) => {
      if (v === true) return '<span class="text-green"><i class="fas fa-check-circle"></i></span>';
      if (v === false) return '<span class="text-muted">—</span>';
      return `<span class="badge badge-info" style="font-size:10px">${Utils.escapeHtml(String(v))}</span>`;
    };

    const isExclusive = (f) => f.dockerDash === true && !f.portainerCE && !f.portainerBE && !f.dockge && !f.dockhand && !f.coolify && !f.yacht && !f.rancher;

    el.innerHTML = `
      <div class="stat-cards" style="margin-bottom:20px">
        <div class="stat-card">
          <div class="stat-icon green"><i class="fas fa-star"></i></div>
          <div class="stat-body">
            <div class="stat-value">${exclusive}</div>
            <div class="stat-label">Exclusive Features</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="background:rgba(56,139,253,0.1);color:var(--accent)"><i class="fas fa-list"></i></div>
          <div class="stat-body">
            <div class="stat-value">${features.length}</div>
            <div class="stat-label">Total Features Compared</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="background:rgba(210,153,34,0.1);color:#d29922"><i class="fas fa-lock"></i></div>
          <div class="stat-body">
            <div class="stat-value">${features.filter(f => f.portainerCE === 'BE only').length}</div>
            <div class="stat-label">Portainer Paywalled (free in DD)</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="background:rgba(248,81,73,0.1);color:var(--red)"><i class="fas fa-ban"></i></div>
          <div class="stat-body">
            <div class="stat-value">${features.filter(f => !f.coolify && f.dockerDash).length}</div>
            <div class="stat-label">Coolify Missing (DD has)</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="padding:0;overflow:auto;max-height:calc(100vh - 280px)">
          <table class="data-table" id="compare-table">
            <thead>
              <tr>
                <th style="text-align:left;min-width:200px;position:sticky;top:0;left:0;z-index:3;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border),2px 0 0 var(--border)">Feature</th>
                <th style="min-width:100px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)"><strong style="color:var(--accent)">Docker Dash</strong></th>
                <th style="min-width:110px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Portainer CE</th>
                <th style="min-width:110px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Portainer BE</th>
                <th style="min-width:90px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Coolify</th>
                <th style="min-width:80px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Yacht</th>
                <th style="min-width:90px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Rancher</th>
                <th style="min-width:80px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Dockge</th>
                <th style="min-width:80px;position:sticky;top:0;z-index:2;background:var(--surface2,#16161e);box-shadow:inset 0 -2px 0 var(--border)">Dockhand</th>
              </tr>
            </thead>
            <tbody>
              ${features.map(f => `
                <tr class="compare-row ${isExclusive(f) ? 'exclusive-row' : ''}" data-feature="${Utils.escapeHtml(f.feature.toLowerCase())}">
                  <td style="text-align:left;position:sticky;left:0;background:var(--surface2,#16161e);box-shadow:2px 0 0 var(--border)">
                    ${isExclusive(f) ? '<i class="fas fa-star" style="color:#d29922;margin-right:6px;font-size:10px" title="Exclusive to Docker Dash"></i>' : ''}
                    ${Utils.escapeHtml(f.feature)}
                  </td>
                  <td>${fmt(f.dockerDash)}</td>
                  <td>${fmt(f.portainerCE)}</td>
                  <td>${fmt(f.portainerBE)}</td>
                  <td>${fmt(f.coolify)}</td>
                  <td>${fmt(f.yacht)}</td>
                  <td>${fmt(f.rancher)}</td>
                  <td>${fmt(f.dockge)}</td>
                  <td>${fmt(f.dockhand)}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="9" style="position:sticky;bottom:0;left:0;background:var(--surface2,#16161e);box-shadow:inset 0 2px 0 var(--border);padding:10px 16px;text-align:center;font-size:12px;color:var(--text-dim);white-space:nowrap">
                  <i class="fas fa-star" style="color:#d29922;margin-right:4px"></i> Exclusive to Docker Dash &nbsp;&nbsp;|&nbsp;&nbsp;
                  <span style="color:var(--green)"><i class="fas fa-check-circle" style="margin-right:2px"></i></span> Available &nbsp;&nbsp;|&nbsp;&nbsp;
                  <span class="badge badge-info" style="font-size:10px;vertical-align:middle">label</span> Partial / conditional &nbsp;&nbsp;|&nbsp;&nbsp;
                  <span style="font-weight:600">—</span> Not available &nbsp;&nbsp;|&nbsp;&nbsp;
                  <span style="color:var(--yellow)">BE</span> = paid Portainer edition
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `;
  },

  _filterFeatures(data) {
    const query = document.getElementById('compare-search')?.value?.toLowerCase() || '';
    document.querySelectorAll('.compare-row').forEach(row => {
      row.style.display = row.dataset.feature.includes(query) ? '' : 'none';
    });
  },

  destroy() {},
};

window.ComparePage = ComparePage;
