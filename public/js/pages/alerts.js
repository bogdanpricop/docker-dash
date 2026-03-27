/* ═══════════════════════════════════════════════════
   pages/alerts.js — Alerts Management
   ═══════════════════════════════════════════════════ */
'use strict';

const AlertsPage = {
  _tab: 'active',

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-bell"></i> ${i18n.t('pages.alerts.title')}</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-primary" id="alert-new-rule">
            <i class="fas fa-plus"></i> ${i18n.t('pages.alerts.newRule')}
          </button>
          <button class="prune-help-btn" id="alerts-help" title="${i18n.t('pages.alerts.helpTooltip')}">?</button>
          <button class="btn btn-sm btn-secondary" id="alerts-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div class="tabs" id="alert-tabs">
        <button class="tab active" data-tab="active">${i18n.t('pages.alerts.tabActive')}</button>
        <button class="tab" data-tab="rules">${i18n.t('pages.alerts.tabRules')}</button>
        <button class="tab" data-tab="history">${i18n.t('pages.alerts.tabHistory')}</button>
      </div>
      <div id="alerts-content"></div>
    `;

    container.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        this._renderTab();
      });
    });

    container.querySelector('#alert-new-rule').addEventListener('click', () => this._ruleDialog());
    container.querySelector('#alerts-help').addEventListener('click', () => this._showHelp());
    container.querySelector('#alerts-refresh').addEventListener('click', () => this._renderTab());

    // Live alert updates
    WS.on('alert', (msg) => {
      Toast.warning(i18n.t('pages.alerts.alertTriggered', { name: msg.data?.ruleName || 'New alert triggered' }));
      if (this._tab === 'active') this._renderTab();
    });

    await this._renderTab();
  },

  async _renderTab() {
    const el = document.getElementById('alerts-content');
    if (!el) return;

    if (this._tab === 'active') await this._renderActive(el);
    else if (this._tab === 'rules') await this._renderRules(el);
    else if (this._tab === 'history') await this._renderHistory(el);
  },

  async _renderActive(el) {
    try {
      const alerts = await Api.getActiveAlerts();
      const items = alerts.alerts || alerts || [];
      if (items.length === 0) {
        el.innerHTML = `<div class="empty-msg"><i class="fas fa-check-circle" style="color:var(--green)"></i> ${i18n.t('pages.alerts.noActiveAlerts')}</div>`;
        return;
      }
      el.innerHTML = `<div class="alert-list">${items.map(a => `
        <div class="alert-card severity-${a.severity || 'warning'}">
          <div class="alert-card-header">
            <span class="alert-severity"><i class="fas fa-exclamation-triangle"></i> ${a.severity || 'warning'}</span>
            <span class="alert-time">${Utils.timeAgo(a.triggered_at)}</span>
          </div>
          <div class="alert-card-body">
            <strong>${Utils.escapeHtml(a.rule_name || a.name || 'Alert')}</strong>
            <p class="text-muted">${Utils.escapeHtml(a.container_name || Utils.shortId(a.container_id) || '')} — ${a.metric}: ${parseFloat(a.metric_value || 0).toFixed(1)}</p>
          </div>
          <div class="alert-card-footer">
            <button class="btn btn-sm btn-secondary" onclick="AlertsPage._acknowledge(${a.id})">
              <i class="fas fa-check"></i> ${i18n.t('pages.alerts.acknowledge')}
            </button>
          </div>
        </div>
      `).join('')}</div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">${i18n.t('pages.alerts.loadFailed', { message: err.message })}</div>`;
    }
  },

  async _renderRules(el) {
    try {
      const rules = await Api.getAlertRules();
      const items = rules.rules || rules || [];
      if (items.length === 0) {
        el.innerHTML = `<div class="empty-msg">${i18n.t('pages.alerts.noRules')}</div>`;
        return;
      }
      el.innerHTML = `<table class="data-table">
        <thead><tr><th>${i18n.t('common.name')}</th><th>${i18n.t('pages.alerts.metric')}</th><th>${i18n.t('pages.alerts.condition')}</th><th>${i18n.t('pages.alerts.severity')}</th><th>${i18n.t('common.status')}</th><th>${i18n.t('common.actions')}</th></tr></thead>
        <tbody>${items.map(r => `
          <tr>
            <td>${Utils.escapeHtml(r.name)}</td>
            <td><span class="badge badge-info">${r.metric}</span></td>
            <td class="mono text-sm">${r.operator} ${r.threshold}${r.metric.includes('percent') ? '%' : ''} for ${r.duration_seconds || 0}s</td>
            <td><span class="badge severity-${r.severity}">${r.severity}</span></td>
            <td>${r.is_active ? `<span class="text-green">${i18n.t('common.active')}</span>` : `<span class="text-muted">${i18n.t('common.disabled')}</span>`}</td>
            <td>
              <div class="action-btns">
                <button class="action-btn" onclick="AlertsPage._toggleRule(${r.id}, ${r.is_active ? 0 : 1})" title="${r.is_active ? i18n.t('pages.alerts.disable') : i18n.t('pages.alerts.enable')}">
                  <i class="fas fa-${r.is_active ? 'pause' : 'play'}"></i>
                </button>
                <button class="action-btn danger" onclick="AlertsPage._deleteRule(${r.id})" title="${i18n.t('common.delete')}">
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </td>
          </tr>
        `).join('')}</tbody>
      </table>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">${i18n.t('pages.alerts.loadFailed', { message: err.message })}</div>`;
    }
  },

  async _renderHistory(el) {
    try {
      const data = await Api.getAlertHistory(100);
      const items = data.rows || data.events || (Array.isArray(data) ? data : []);
      if (items.length === 0) {
        el.innerHTML = `<div class="empty-msg">${i18n.t('pages.alerts.noHistory')}</div>`;
        return;
      }
      el.innerHTML = `<table class="data-table">
        <thead><tr><th>${i18n.t('pages.alerts.time')}</th><th>${i18n.t('pages.alerts.rule')}</th><th>${i18n.t('pages.alerts.container')}</th><th>${i18n.t('pages.alerts.value')}</th><th>${i18n.t('pages.alerts.resolved')}</th></tr></thead>
        <tbody>${items.map(h => `
          <tr>
            <td>${Utils.formatDate(h.triggered_at)}</td>
            <td>${Utils.escapeHtml(h.rule_name || '')}</td>
            <td class="mono text-sm">${Utils.escapeHtml(h.container_name || Utils.shortId(h.container_id) || '')}</td>
            <td>${parseFloat(h.metric_value || 0).toFixed(1)}</td>
            <td>${h.resolved_at ? Utils.formatDate(h.resolved_at) : `<span class="text-warning">${i18n.t('common.active')}</span>`}</td>
          </tr>
        `).join('')}</tbody>
      </table>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">${i18n.t('pages.alerts.loadFailed', { message: err.message })}</div>`;
    }
  },

  async _acknowledge(id) {
    try {
      await Api.acknowledgeAlert(id);
      Toast.success(i18n.t('pages.alerts.acknowledged'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _toggleRule(id, active) {
    try {
      await Api.updateAlertRule(id, { is_active: active });
      Toast.success(i18n.t('pages.alerts.ruleToggled', { status: active ? i18n.t('common.enabled') : i18n.t('common.disabled') }));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _deleteRule(id) {
    const ok = await Modal.confirm(i18n.t('pages.alerts.deleteRuleConfirm'), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try {
      await Api.deleteAlertRule(id);
      Toast.success(i18n.t('pages.alerts.ruleDeleted'));
      await this._renderTab();
    } catch (err) { Toast.error(err.message); }
  },

  async _ruleDialog() {
    const result = await Modal.form(`
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.alerts.ruleName')}</label>
          <input type="text" id="rule-name" class="form-control" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.alerts.metricLabel')}</label>
          <select id="rule-metric" class="form-control">
            <option value="cpu_percent">${i18n.t('pages.alerts.cpuPercent')}</option>
            <option value="memory_percent">${i18n.t('pages.alerts.memoryPercent')}</option>
            <option value="status_change">${i18n.t('pages.alerts.statusChange')}</option>
          </select>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.alerts.operator')}</label>
          <select id="rule-op" class="form-control">
            <option value=">">&gt;</option>
            <option value=">=">&gt;=</option>
            <option value="<">&lt;</option>
            <option value="=">=</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.alerts.threshold')}</label>
          <input type="number" id="rule-thresh" class="form-control" value="80">
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.alerts.durationLabel')}</label>
          <input type="number" id="rule-dur" class="form-control" value="60">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.alerts.severityLabel')}</label>
          <select id="rule-sev" class="form-control">
            <option value="warning">${i18n.t('pages.alerts.warningOpt')}</option>
            <option value="critical">${i18n.t('pages.alerts.criticalOpt')}</option>
            <option value="info">${i18n.t('pages.alerts.infoOpt')}</option>
          </select>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.alerts.cooldownLabel')}</label>
          <input type="number" id="rule-cool" class="form-control" value="300">
        </div>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.alerts.targetLabel')}</label>
        <input type="text" id="rule-target" class="form-control" value="*">
      </div>
    `, {
      title: i18n.t('pages.alerts.createTitle'),
      width: '520px',
      onSubmit: (content) => {
        const name = content.querySelector('#rule-name').value.trim();
        if (!name) { Toast.warning(i18n.t('pages.alerts.nameRequired')); return false; }
        return {
          name,
          metric: content.querySelector('#rule-metric').value,
          operator: content.querySelector('#rule-op').value,
          threshold: parseFloat(content.querySelector('#rule-thresh').value),
          duration_seconds: parseInt(content.querySelector('#rule-dur').value) || 0,
          severity: content.querySelector('#rule-sev').value,
          cooldown_seconds: parseInt(content.querySelector('#rule-cool').value) || 300,
          target: content.querySelector('#rule-target').value || '*',
          is_active: 1,
          channels: 'toast',
        };
      }
    });

    if (result) {
      try {
        await Api.createAlertRule(result);
        Toast.success(i18n.t('pages.alerts.ruleCreated'));
        this._tab = 'rules';
        document.querySelectorAll('#alert-tabs .tab').forEach(t => {
          t.classList.toggle('active', t.dataset.tab === 'rules');
        });
        await this._renderTab();
      } catch (err) { Toast.error(err.message); }
    }
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.alerts.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.alerts.help.intro')}</p>

        <h4><i class="fas fa-list-ol"></i> ${i18n.t('pages.alerts.help.rulesTitle')}</h4>
        <p>${i18n.t('pages.alerts.help.rulesBody')}</p>

        <h4><i class="fas fa-chart-line"></i> ${i18n.t('pages.alerts.help.metricsTitle')}</h4>
        <p>${i18n.t('pages.alerts.help.metricsBody')}</p>

        <h4><i class="fas fa-clock"></i> ${i18n.t('pages.alerts.help.durationTitle')}</h4>
        <p>${i18n.t('pages.alerts.help.durationBody')}</p>

        <h4><i class="fas fa-hourglass-half"></i> ${i18n.t('pages.alerts.help.cooldownTitle')}</h4>
        <p>${i18n.t('pages.alerts.help.cooldownBody')}</p>

        <h4><i class="fas fa-crosshairs"></i> ${i18n.t('pages.alerts.help.targetTitle')}</h4>
        <p>${i18n.t('pages.alerts.help.targetBody')}</p>

        <h4><i class="fas fa-exclamation-triangle"></i> ${i18n.t('pages.alerts.help.severityTitle')}</h4>
        <p>${i18n.t('pages.alerts.help.severityBody')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.alerts.help.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '620px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  destroy() {},
};

window.AlertsPage = AlertsPage;
