/* ===============================================
   pages/cost-optimizer.js — Cost Optimization
   =============================================== */
'use strict';

const CostOptimizerPage = {
  _monthlyCost: 50,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-dollar-sign" style="color:var(--green)"></i> ${i18n.t('pages.costOptimizer.title')}</h2>
        <div class="page-actions">
          <div style="display:flex;align-items:center;gap:8px">
            <label class="text-sm text-muted" style="white-space:nowrap">${i18n.t('pages.costOptimizer.monthlyServerCost')}</label>
            <input type="number" id="cost-monthly-input" class="form-control" style="width:100px" value="${this._monthlyCost}" min="1" step="1">
            <button class="btn btn-sm btn-primary" id="cost-save-settings"><i class="fas fa-save"></i></button>
          </div>
          <button class="btn btn-sm btn-secondary" id="cost-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="cost-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.costOptimizer.analyzingCosts')}</div></div>
    `;

    container.querySelector('#cost-refresh').addEventListener('click', () => this._load());
    container.querySelector('#cost-save-settings').addEventListener('click', async () => {
      const val = parseFloat(container.querySelector('#cost-monthly-input').value) || 50;
      this._monthlyCost = val;
      try {
        await Api.post('/stats/cost-settings', { monthly_cost: val });
        Toast.success(i18n.t('pages.costOptimizer.costSettingsSaved'));
      } catch (err) { Toast.error(err.message); }
      this._load();
    });
    container.querySelector('#cost-monthly-input').addEventListener('change', (e) => {
      this._monthlyCost = parseFloat(e.target.value) || 50;
    });

    // Load saved cost setting
    try {
      const data = await Api.get('/stats/cost-analysis?monthly_cost=0');
      if (data.monthly_total && data.monthly_total !== 50) {
        this._monthlyCost = data.monthly_total;
        container.querySelector('#cost-monthly-input').value = this._monthlyCost;
      }
    } catch { /* ignore */ }

    await this._load();
  },

  async _load() {
    const el = document.getElementById('cost-content');
    if (!el) return;

    try {
      const data = await Api.get(`/stats/cost-analysis?monthly_cost=${this._monthlyCost}`);

      // Overview cards
      const overviewHtml = `
        <div class="cost-overview">
          <div class="cost-card">
            <div class="cost-card-value">$${data.monthly_total.toFixed(2)}</div>
            <div class="cost-card-label">${i18n.t('pages.costOptimizer.monthlyServerCostLabel')}</div>
          </div>
          <div class="cost-card">
            <div class="cost-card-value">${data.containers.length}</div>
            <div class="cost-card-label">${i18n.t('pages.costOptimizer.containersTracked')}</div>
          </div>
          <div class="cost-card" style="border-color:var(--green)">
            <div class="cost-card-value" style="color:var(--green)">$${data.savings_potential.toFixed(2)}</div>
            <div class="cost-card-label">${i18n.t('pages.costOptimizer.potentialSavings')}</div>
          </div>
          <div class="cost-card" ${data.idle_count > 0 ? 'style="border-color:var(--yellow)"' : ''}>
            <div class="cost-card-value" ${data.idle_count > 0 ? 'style="color:var(--yellow)"' : ''}>${data.idle_count}</div>
            <div class="cost-card-label">${i18n.t('pages.costOptimizer.idleContainers')} ($${data.idle_cost.toFixed(2)}/mo)</div>
          </div>
        </div>
      `;

      // Savings banner
      let savingsHtml = '';
      if (data.savings_potential > 0) {
        savingsHtml = `
          <div class="cost-savings">
            <div class="cost-savings-icon"><i class="fas fa-piggy-bank"></i></div>
            <div class="cost-savings-text">
              ${i18n.t('pages.costOptimizer.savingsMessage', { amount: data.savings_potential.toFixed(2) })}
            </div>
          </div>
        `;
      }

      // Recommendations
      let recsHtml = '';
      if (data.recommendations.length > 0) {
        recsHtml = `
          <div class="card" style="margin-bottom:20px">
            <div class="card-header"><h3><i class="fas fa-lightbulb" style="color:var(--yellow);margin-right:8px"></i>${i18n.t('pages.costOptimizer.recommendations')}</h3></div>
            <div class="card-body" style="padding:0">
              <table class="data-table">
                <thead><tr><th>${i18n.t('pages.costOptimizer.container')}</th><th>${i18n.t('pages.costOptimizer.issue')}</th><th>${i18n.t('pages.costOptimizer.severity')}</th><th>${i18n.t('pages.costOptimizer.savings')}</th><th>${i18n.t('pages.costOptimizer.action')}</th></tr></thead>
                <tbody>
                  ${data.recommendations.map(r => `
                    <tr class="${r.type === 'idle' ? 'idle-container-row' : ''}">
                      <td><strong>${Utils.escapeHtml(r.container_name)}</strong></td>
                      <td class="text-sm">${Utils.escapeHtml(r.message)}</td>
                      <td><span class="badge badge-${r.severity}">${r.severity}</span></td>
                      <td class="mono">${r.monthly_savings > 0 ? '$' + r.monthly_savings.toFixed(2) : '-'}</td>
                      <td>
                        ${r.type === 'idle' ? `<button class="btn btn-xs btn-warning cost-stop-btn" data-id="${r.container_id}" data-name="${Utils.escapeHtml(r.container_name)}"><i class="fas fa-stop"></i> ${i18n.t('pages.costOptimizer.stop')}</button>` : ''}
                        ${r.type === 'over_provisioned' && r.suggested ? `<button class="btn btn-xs btn-accent cost-resize-btn" data-id="${r.container_id}" data-mem="${r.suggested}" data-name="${Utils.escapeHtml(r.container_name)}"><i class="fas fa-compress-alt"></i> ${i18n.t('pages.costOptimizer.resize')}</button>` : ''}
                        ${r.type === 'memory_pressure' && r.suggested ? `<button class="btn btn-xs btn-primary cost-resize-btn" data-id="${r.container_id}" data-mem="${r.suggested}" data-name="${Utils.escapeHtml(r.container_name)}"><i class="fas fa-expand-alt"></i> ${i18n.t('pages.costOptimizer.resize')}</button>` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }

      // Cost breakdown table
      const maxCost = Math.max(...data.containers.map(c => c.estimated_monthly_cost), 1);
      const breakdownHtml = `
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-chart-bar" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.costOptimizer.costBreakdown')}</h3></div>
          <div class="card-body" style="padding:0">
            <table class="data-table">
              <thead><tr><th>${i18n.t('pages.costOptimizer.container')}</th><th>${i18n.t('pages.costOptimizer.cpu')}</th><th>${i18n.t('pages.costOptimizer.memory')}</th><th>${i18n.t('pages.costOptimizer.costShare')}</th><th>${i18n.t('pages.costOptimizer.estCostPerMonth')}</th></tr></thead>
              <tbody>
                ${data.containers.map(c => `
                  <tr>
                    <td><strong>${Utils.escapeHtml(c.container_name)}</strong></td>
                    <td class="mono text-sm">${c.cpu_percent}%</td>
                    <td class="mono text-sm">${Utils.formatBytes(c.mem_usage)}</td>
                    <td style="min-width:120px">
                      <div class="cost-bar">
                        <div class="cost-bar-fill" style="width:${Math.max(2, (c.estimated_monthly_cost / maxCost) * 100)}%;background:var(--accent)"></div>
                        <span class="cost-bar-label">${((c.cpu_share + c.mem_share) / 2).toFixed(1)}%</span>
                      </div>
                    </td>
                    <td class="mono" style="font-weight:600;color:var(--text-bright)">$${c.estimated_monthly_cost.toFixed(2)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Tabs for Recommendations + Cost Breakdown
      const tabsHtml = `
        <div class="tabs" style="margin-bottom:16px">
          <button class="tab active" data-cost-tab="recommendations"><i class="fas fa-lightbulb" style="margin-right:4px"></i>${i18n.t('pages.costOptimizer.recommendations')} ${data.recommendations.length ? `<span class="badge badge-warning" style="margin-left:6px;font-size:10px">${data.recommendations.length}</span>` : ''}</button>
          <button class="tab" data-cost-tab="breakdown"><i class="fas fa-chart-bar" style="margin-right:4px"></i>${i18n.t('pages.costOptimizer.costBreakdown')} <span class="badge badge-info" style="margin-left:6px;font-size:10px">${data.containers.length}</span></button>
        </div>
        <div id="cost-tab-recommendations">${recsHtml || '<div class="empty-msg"><i class="fas fa-check-circle" style="color:var(--green);margin-right:8px"></i>No recommendations — all containers are well-optimized!</div>'}</div>
        <div id="cost-tab-breakdown" style="display:none">${breakdownHtml}</div>
      `;

      el.innerHTML = overviewHtml + savingsHtml + tabsHtml;

      // Tab switching
      el.querySelectorAll('[data-cost-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
          el.querySelectorAll('[data-cost-tab]').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          document.getElementById('cost-tab-recommendations').style.display = tab.dataset.costTab === 'recommendations' ? '' : 'none';
          document.getElementById('cost-tab-breakdown').style.display = tab.dataset.costTab === 'breakdown' ? '' : 'none';
        });
      });

      // Wire up action buttons
      el.querySelectorAll('.cost-stop-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ok = await Modal.confirm(i18n.t('pages.costOptimizer.stopIdleConfirm', { name: btn.dataset.name }), { danger: true, confirmText: i18n.t('common.stop') });
          if (!ok) return;
          try {
            await Api.containerAction(btn.dataset.id, 'stop');
            Toast.success(i18n.t('pages.costOptimizer.stopped', { name: btn.dataset.name }));
            this._load();
          } catch (err) { Toast.error(err.message); }
        });
      });

      el.querySelectorAll('.cost-resize-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const memBytes = parseInt(btn.dataset.mem);
          const memMB = Math.round(memBytes / 1024 / 1024);
          const ok = await Modal.confirm(i18n.t('pages.costOptimizer.resizeConfirm', { name: btn.dataset.name, mem: memMB }), { confirmText: i18n.t('pages.costOptimizer.resize') });
          if (!ok) return;
          try {
            await Api.put(`/system/containers/${btn.dataset.id}/resources`, { memory: memBytes });
            Toast.success(i18n.t('pages.costOptimizer.resized', { name: btn.dataset.name, mem: memMB }));
            this._load();
          } catch (err) { Toast.error(err.message); }
        });
      });

    } catch (err) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  destroy() {},
};

window.CostOptimizerPage = CostOptimizerPage;
