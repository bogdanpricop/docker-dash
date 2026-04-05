'use strict';

const TimelinePage = {
  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-stream" style="color:var(--accent)"></i> Event Timeline</h2>
        <div class="page-actions">
          <select id="tl-hours" class="form-control" style="width:auto;font-size:12px">
            <option value="1">Last 1h</option>
            <option value="6">Last 6h</option>
            <option value="24" selected>Last 24h</option>
            <option value="168">Last 7d</option>
          </select>
          <select id="tl-category" class="form-control" style="width:auto;font-size:12px">
            <option value="">All Events</option>
            <option value="deploy">Deployments</option>
            <option value="lifecycle">Lifecycle</option>
            <option value="action">Actions</option>
            <option value="alert">Alerts</option>
            <option value="auth">Auth</option>
            <option value="security">Security</option>
          </select>
          <div class="search-box" style="max-width:200px">
            <i class="fas fa-search"></i>
            <input type="text" id="tl-search" placeholder="Filter events...">
          </div>
          <button class="btn btn-sm btn-secondary" id="tl-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="tl-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading timeline...</div></div>
    `;

    container.querySelector('#tl-hours').addEventListener('change', () => this._load());
    container.querySelector('#tl-category').addEventListener('change', () => this._load());
    container.querySelector('#tl-search').addEventListener('input', Utils.debounce(() => this._load(), 300));
    container.querySelector('#tl-refresh').addEventListener('click', () => this._load());

    await this._load();
  },

  async _load() {
    const el = document.getElementById('tl-content');
    if (!el) return;

    const hours = document.getElementById('tl-hours')?.value || '24';
    const category = document.getElementById('tl-category')?.value || '';
    const search = (document.getElementById('tl-search')?.value || '').toLowerCase();

    try {
      const data = await Api.get(`/timeline?hours=${hours}`);
      let events = data.events || [];

      if (category) events = events.filter(e => e.category === category);
      if (search) events = events.filter(e =>
        (e.action || '').toLowerCase().includes(search) ||
        (e.target || '').toLowerCase().includes(search) ||
        (e.user || '').toLowerCase().includes(search) ||
        (e.message || '').toLowerCase().includes(search)
      );

      if (events.length === 0) {
        el.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i><p>No events found for this time range.</p></div>';
        return;
      }

      // Group by date
      const groups = {};
      events.forEach(e => {
        const day = (e.time || '').substring(0, 10);
        if (!groups[day]) groups[day] = [];
        groups[day].push(e);
      });

      const categoryIcons = {
        deploy:    { icon: 'fa-rocket',            color: 'var(--accent)' },
        lifecycle: { icon: 'fa-circle',            color: 'var(--green)' },
        action:    { icon: 'fa-play',              color: 'var(--yellow)' },
        alert:     { icon: 'fa-exclamation-triangle', color: 'var(--red)' },
        auth:      { icon: 'fa-user-shield',       color: 'var(--purple, #a371f7)' },
        security:  { icon: 'fa-shield-alt',        color: 'var(--green)' },
      };

      el.innerHTML = Object.entries(groups).map(([day, evts]) => `
        <div style="margin-bottom:24px">
          <div style="font-size:12px;font-weight:700;color:var(--text-dim);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)">${day}</div>
          <div style="position:relative;padding-left:24px">
            <div style="position:absolute;left:8px;top:0;bottom:0;width:2px;background:var(--border)"></div>
            ${evts.map(e => {
              const ci = categoryIcons[e.category] || { icon: 'fa-circle', color: 'var(--text-dim)' };
              const time = (e.time || '').substring(11, 19);
              const details = e.details ? (() => {
                try {
                  const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
                  return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
                } catch { return e.details; }
              })() : '';
              return `
                <div style="position:relative;margin-bottom:8px;padding:8px 12px;background:var(--surface2);border-radius:var(--radius-sm, 6px);border-left:3px solid ${ci.color}">
                  <div style="position:absolute;left:-20px;top:10px;width:12px;height:12px;border-radius:50%;background:${ci.color};display:flex;align-items:center;justify-content:center">
                    <i class="fas ${ci.icon}" style="font-size:6px;color:#fff"></i>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span class="mono" style="font-size:11px;color:var(--text-dim);min-width:60px">${time}</span>
                    <span class="badge" style="font-size:10px;background:${ci.color}22;color:${ci.color}">${Utils.escapeHtml(e.category)}</span>
                    <span style="font-weight:600;font-size:13px;color:var(--text-bright)">${Utils.escapeHtml(e.action || '')}</span>
                    ${e.target ? `<span class="mono text-sm" style="color:var(--accent)">${Utils.escapeHtml(e.target)}</span>` : ''}
                    ${e.user ? `<span class="text-sm text-muted" style="margin-left:auto"><i class="fas fa-user" style="margin-right:3px"></i>${Utils.escapeHtml(e.user)}</span>` : ''}
                  </div>
                  ${details ? `<div class="text-xs text-muted" style="margin-top:4px;word-break:break-all">${Utils.escapeHtml(details)}</div>` : ''}
                  ${e.message ? `<div class="text-sm" style="margin-top:4px;color:${e.severity === 'critical' ? 'var(--red)' : 'var(--text)'}">${Utils.escapeHtml(e.message)}</div>` : ''}
                </div>`;
            }).join('')}
          </div>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  destroy() {},
};

window.TimelinePage = TimelinePage;
