/* ═══════════════════════════════════════════════════
   pages/firewall.js — Firewall Dashboard (UFW)
   ═══════════════════════════════════════════════════ */
'use strict';

const FirewallPage = {
  _data: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-shield-alt"></i> ${i18n.t('pages.firewall.title')}</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-primary" id="fw-add-rule">
            <i class="fas fa-plus"></i> ${i18n.t('pages.firewall.addRule')}
          </button>
          <button class="prune-help-btn" id="fw-help" title="${i18n.t('pages.firewall.helpTooltip')}">?</button>
          <button class="btn btn-sm btn-secondary" id="fw-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div id="fw-content"><div class="page-loading"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.firewall.loadingStatus')}</div></div>
    `;

    container.querySelector('#fw-refresh').addEventListener('click', () => this._load());
    container.querySelector('#fw-add-rule').addEventListener('click', () => this._addRuleDialog());
    container.querySelector('#fw-help').addEventListener('click', () => this._showHelp());

    await this._load();
  },

  async _load() {
    const el = document.getElementById('fw-content');
    if (!el) return;

    try {
      this._data = await Api.getFirewall();
      this._render(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> ${err.message}</div>`;
    }
  },

  _render(el) {
    const d = this._data;

    if (!d.available) {
      el.innerHTML = `
        <div class="empty-msg">
          <i class="fas fa-shield-alt" style="color:var(--text-dim)"></i>
          <p>${i18n.t('pages.firewall.notAvailable')}<br>
          <span class="text-muted">${i18n.t('pages.firewall.notAvailableHint')}</span></p>
        </div>`;
      return;
    }

    const isActive = d.status === 'active';
    const ruleCount = d.rules?.length || 0;

    el.innerHTML = `
      <!-- Status Cards -->
      <div class="stat-cards" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 20px">
        <div class="stat-card">
          <div class="stat-icon ${isActive ? 'green' : 'red'}">
            <i class="fas fa-${isActive ? 'shield-alt' : 'shield-virus'}"></i>
          </div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:22px">${d.status?.toUpperCase() || 'UNKNOWN'}</div>
            <div class="stat-label">${i18n.t('pages.firewall.status')}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue"><i class="fas fa-list-ol"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:22px">${ruleCount}</div>
            <div class="stat-label">${i18n.t('pages.firewall.rules')}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon purple"><i class="fas fa-cog"></i></div>
          <div class="stat-body">
            <div class="stat-value" style="font-size:14px;font-family:var(--mono)">${d.defaultPolicy || '—'}</div>
            <div class="stat-label">${i18n.t('pages.firewall.defaultPolicy')}</div>
          </div>
        </div>
      </div>

      <!-- Rules Table -->
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-list text-dim" style="margin-right:8px"></i> ${i18n.t('pages.firewall.firewallRules')}</h3>
          <span class="text-dim text-sm">${i18n.t('pages.firewall.backend')}: ${d.backend}</span>
        </div>
        <div class="card-body" style="padding:0">
          ${ruleCount === 0 ? `<div class="empty-msg">${i18n.t('pages.firewall.noRules')}</div>` : `
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:50px">#</th>
                <th>${i18n.t('pages.firewall.to')}</th>
                <th>${i18n.t('pages.firewall.action')}</th>
                <th>${i18n.t('pages.firewall.direction')}</th>
                <th>${i18n.t('pages.firewall.from')}</th>
                <th style="width:80px"></th>
              </tr>
            </thead>
            <tbody>
              ${d.rules.map(r => `
                <tr>
                  <td class="mono text-dim">${r.number}</td>
                  <td class="mono">${Utils.escapeHtml(r.to)}</td>
                  <td><span class="badge ${r.action === 'ALLOW' ? 'badge-running' : r.action === 'DENY' ? 'badge-stopped' : r.action === 'LIMIT' ? 'badge-warning' : 'badge-info'}">${r.action}</span></td>
                  <td><span class="badge badge-info">${r.direction}</span></td>
                  <td class="mono text-sm">${Utils.escapeHtml(r.from)}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn danger" data-action="delete-rule" data-rule-number="${r.number}" title="${i18n.t('pages.firewall.deleteRule')}">
                        <i class="fas fa-trash"></i>
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`}
        </div>
      </div>

      <!-- Listening Ports -->
      ${d.listening ? `
      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <h3><i class="fas fa-plug text-dim" style="margin-right:8px"></i> ${i18n.t('pages.firewall.listeningPorts')}</h3>
        </div>
        <div class="card-body">
          <pre class="inspect-json" style="max-height:300px;color:var(--text)">${Utils.escapeHtml(d.listening)}</pre>
        </div>
      </div>` : ''}
    `;

    // Wire up delete rule buttons
    el.querySelectorAll('[data-action="delete-rule"]').forEach(btn => {
      btn.addEventListener('click', () => FirewallPage._deleteRule(parseInt(btn.dataset.ruleNumber)));
    });
  },

  async _addRuleDialog() {
    const result = await Modal.form(`
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.firewall.actionLabel')}</label>
          <select id="fw-action" class="form-control">
            <option value="allow">${i18n.t('pages.firewall.allow')}</option>
            <option value="deny">${i18n.t('pages.firewall.deny')}</option>
            <option value="limit">${i18n.t('pages.firewall.limit')}</option>
            <option value="reject">${i18n.t('pages.firewall.reject')}</option>
          </select>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.firewall.directionLabel')}</label>
          <select id="fw-dir" class="form-control">
            <option value="in">${i18n.t('pages.firewall.incoming')}</option>
            <option value="out">${i18n.t('pages.firewall.outgoing')}</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>${i18n.t('pages.firewall.portLabel')}</label>
          <input type="text" id="fw-port" class="form-control" placeholder="${i18n.t('pages.firewall.portPlaceholder')}" required>
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.firewall.protocolLabel')}</label>
          <select id="fw-proto" class="form-control">
            <option value="any">${i18n.t('pages.firewall.any')}</option>
            <option value="tcp">${i18n.t('pages.firewall.tcp')}</option>
            <option value="udp">${i18n.t('pages.firewall.udp')}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.firewall.fromLabel')}</label>
        <input type="text" id="fw-from" class="form-control" placeholder="${i18n.t('pages.firewall.fromPlaceholder')}">
      </div>
    `, {
      title: i18n.t('pages.firewall.addRuleTitle'),
      width: '480px',
      onSubmit: (content) => {
        const port = content.querySelector('#fw-port').value.trim();
        if (!port) { Toast.warning(i18n.t('pages.firewall.portRequired')); return false; }
        return {
          action: content.querySelector('#fw-action').value,
          port,
          proto: content.querySelector('#fw-proto').value,
          from: content.querySelector('#fw-from').value.trim() || undefined,
          direction: content.querySelector('#fw-dir').value,
        };
      }
    });

    if (result) {
      try {
        await Api.addFirewallRule(result);
        Toast.success(i18n.t('pages.firewall.ruleAdded'));
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _deleteRule(number) {
    const ok = await Modal.confirm(i18n.t('pages.firewall.deleteConfirm', { number }), { danger: true, confirmText: i18n.t('common.delete') });
    if (!ok) return;
    try {
      await Api.deleteFirewallRule(number);
      Toast.success(i18n.t('pages.firewall.ruleDeleted'));
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.firewall.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.firewall.help.intro')}</p>

        <h4><i class="fas fa-check-circle"></i> ${i18n.t('pages.firewall.help.actionsTitle')}</h4>
        <p>${i18n.t('pages.firewall.help.actionsBody')}</p>

        <h4><i class="fas fa-arrows-alt-h"></i> ${i18n.t('pages.firewall.help.directionTitle')}</h4>
        <p>${i18n.t('pages.firewall.help.directionBody')}</p>

        <h4><i class="fas fa-plug"></i> ${i18n.t('pages.firewall.help.portTitle')}</h4>
        <p>${i18n.t('pages.firewall.help.portBody')}</p>

        <h4><i class="fas fa-globe"></i> ${i18n.t('pages.firewall.help.protocolTitle')}</h4>
        <p>${i18n.t('pages.firewall.help.protocolBody')}</p>

        <h4><i class="fas fa-map-marker-alt"></i> ${i18n.t('pages.firewall.help.fromTitle')}</h4>
        <p>${i18n.t('pages.firewall.help.fromBody')}</p>

        <h4><i class="fas fa-shield-alt"></i> ${i18n.t('pages.firewall.help.policyTitle')}</h4>
        <p>${i18n.t('pages.firewall.help.policyBody')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.firewall.help.tipText')}
        </div>

        <p class="warn-text" style="margin-top:12px"><i class="fas fa-exclamation-triangle"></i> ${i18n.t('pages.firewall.help.warningText')}</p>
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

window.FirewallPage = FirewallPage;
