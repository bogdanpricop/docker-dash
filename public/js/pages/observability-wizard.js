/* ═══════════════════════════════════════════════════
   pages/observability-wizard.js — Observability Wizard (v7.2.0)
   ═══════════════════════════════════════════════════
   Three-state wizard for wiring Docker Dash into Prometheus + Grafana:
     (A) Both running on this host → integration path
     (B) One running only          → partial-stack guidance
     (C) Neither running           → deploy-ours guidance

   Admin-only (enforced both client-side via data-role check and
   server-side on every endpoint). See plans/deep-spec-observability-
   wizard.md for architecture.
   ═══════════════════════════════════════════════════ */
'use strict';

const ObservabilityWizardPage = {
  _state: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-chart-line" style="color:var(--accent)"></i> ${i18n.t('pages.observability.title')}</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="obs-rescan">
            <i class="fas fa-sync-alt"></i> ${i18n.t('pages.observability.rescan')}
          </button>
        </div>
      </div>
      <p class="text-sm text-muted" style="margin:0 0 20px">${i18n.t('pages.observability.subtitle')}</p>
      <div id="obs-content">
        <div class="empty-msg">
          <i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.observability.scanning')}
        </div>
      </div>
    `;

    container.querySelector('#obs-rescan').addEventListener('click', () => this._loadState());
    await this._loadState();
  },

  async _loadState() {
    const slot = document.getElementById('obs-content');
    if (!slot) return;
    slot.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.observability.scanning')}</div>`;
    try {
      const state = await Api.get('/observability/detect');
      this._state = state;
      this._renderState(state);
    } catch (err) {
      slot.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(i18n.t('pages.observability.detectError', { err: err.message }))}</div>`;
    }
  },

  _renderState(state) {
    const slot = document.getElementById('obs-content');
    if (!slot) return;
    const hasProm = !!state.prometheus;
    const hasGraf = !!state.grafana;
    let branch;
    if (hasProm && hasGraf) branch = 'both';
    else if (hasProm || hasGraf) branch = 'partial';
    else branch = 'none';

    slot.innerHTML = `<div class="alert alert-info" style="margin-bottom:16px">${Utils.escapeHtml(i18n.t('pages.observability.monitoringAuth'))}</div>` + this._renderBranch(branch, state);
    this._attachHandlers(branch, state);
  },

  _renderBranch(branch, state) {
    // v7.6.0 — reachability pills next to detected services
    const probe = state.probes || {};
    const _pill = (svc, label) => {
      const p = probe[svc];
      if (!p) return '';
      if (p.ok) return ` <span class="badge" style="background:rgba(46,160,67,0.15);color:var(--green);font-size:10px;padding:2px 6px;border-radius:8px;margin-left:4px"><i class="fas fa-check" style="font-size:8px"></i> reachable (HTTP ${p.status})</span>`;
      return ` <span class="badge" style="background:rgba(248,113,113,0.15);color:var(--red);font-size:10px;padding:2px 6px;border-radius:8px;margin-left:4px" title="${Utils.escapeHtml(p.url || '')}"><i class="fas fa-times" style="font-size:8px"></i> unreachable (${Utils.escapeHtml(p.error || ('HTTP ' + p.status))})</span>`;
    };

    const banner = (() => {
      if (branch === 'both') return `<div class="card" style="border-left:4px solid var(--green);padding:12px 16px;margin-bottom:20px">
        <i class="fas fa-check-circle" style="color:var(--green);margin-right:8px"></i>
        <strong>${i18n.t('pages.observability.stateA.banner')}</strong>
        <div class="text-sm text-muted" style="margin-top:6px">
          Prometheus: <code>${Utils.escapeHtml(state.prometheus.name)}</code>${_pill('prometheus', 'Prometheus')} ·
          Grafana: <code>${Utils.escapeHtml(state.grafana.name)}</code>${_pill('grafana', 'Grafana')}
        </div>
      </div>`;
      if (branch === 'partial') {
        const foundSvc = state.prometheus ? 'prometheus' : 'grafana';
        const foundName = state.prometheus ? state.prometheus.name : state.grafana.name;
        return `<div class="card" style="border-left:4px solid var(--yellow);padding:12px 16px;margin-bottom:20px">
          <i class="fas fa-exclamation-triangle" style="color:var(--yellow);margin-right:8px"></i>
          <strong>${i18n.t('pages.observability.stateB.banner', { found: state.prometheus ? 'Prometheus' : 'Grafana', missing: state.prometheus ? 'Grafana' : 'Prometheus' })}</strong>
          <div class="text-sm text-muted" style="margin-top:6px">
            <code>${Utils.escapeHtml(foundName)}</code>${_pill(foundSvc, foundSvc)}
          </div>
        </div>`;
      }
      return `<div class="card" style="border-left:4px solid var(--text-dim);padding:12px 16px;margin-bottom:20px">
        <i class="fas fa-info-circle" style="color:var(--text-dim);margin-right:8px"></i>
        <strong>${i18n.t('pages.observability.stateC.banner')}</strong>
      </div>`;
    })();

    // Build action cards per branch
    const actions = branch === 'both' ? this._renderBothActions(state)
                   : branch === 'partial' ? this._renderPartialActions(state)
                   : this._renderNoneActions(state);

    return `${banner}${actions}
      <div class="card" style="margin-top:20px;padding:14px 16px;background:var(--bg-dim)">
        <i class="fas fa-book" style="margin-right:6px;color:var(--accent)"></i>
        <a href="https://github.com/bogdanpricop/docker-dash/blob/main/docs/features/observability.md" target="_blank" rel="noopener">${i18n.t('pages.observability.fullGuide')}</a>
      </div>`;
  },

  _renderBothActions(state) {
    const grafanaDefaultUrl = state.grafana.externalPort
      ? `http://${window.location.hostname}:${state.grafana.externalPort}`
      : state.grafana.internalUrl;

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3><i class="fas fa-cog" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.observability.actionScrape.title')}</h3></div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.observability.actionScrape.desc')}</p>
          <div class="code-block" style="font-size:11px;line-height:1.5;background:var(--bg-dim);padding:10px;border-radius:var(--radius-sm);overflow-x:auto;white-space:pre;font-family:'JetBrains Mono',monospace" id="scrape-snippet">${Utils.escapeHtml(state.scrapeConfigSnippet)}</div>
          <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
            <button class="btn btn-sm btn-primary" id="copy-snippet"><i class="fas fa-copy"></i> ${i18n.t('pages.observability.actionScrape.copy')}</button>
            <span class="text-sm text-muted">${i18n.t('pages.observability.actionScrape.hint')}</span>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3><i class="fas fa-upload" style="color:var(--green);margin-right:8px"></i>${i18n.t('pages.observability.actionImport.title')}</h3></div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin:0 0 14px">${i18n.t('pages.observability.actionImport.desc')}</p>
          <div class="form-group">
            <label>${i18n.t('pages.observability.actionImport.urlLabel')}</label>
            <input type="text" id="grafana-url" class="form-control" value="${Utils.escapeHtml(grafanaDefaultUrl)}" placeholder="http://grafana:3000">
          </div>
          <div class="form-group">
            <label>${i18n.t('pages.observability.actionImport.tokenLabel')}</label>
            <input type="password" id="grafana-token" class="form-control" placeholder="glsa_...">
            <p class="text-sm text-muted" style="margin-top:4px">${i18n.t('pages.observability.actionImport.tokenHint')}</p>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
            <button class="btn btn-primary" id="import-btn"><i class="fas fa-upload"></i> ${i18n.t('pages.observability.actionImport.submit')}</button>
            <div id="import-status" class="text-sm"></div>
          </div>
        </div>
      </div>
    `;
  },

  _renderPartialActions(state) {
    const missing = state.prometheus ? 'Grafana' : 'Prometheus';
    const found = state.prometheus ? 'Prometheus' : 'Grafana';
    const foundDetails = state.prometheus
      ? `<code>${Utils.escapeHtml(state.prometheus.name)}</code> at <code>${Utils.escapeHtml(state.prometheus.internalUrl)}</code>`
      : `<code>${Utils.escapeHtml(state.grafana.name)}</code> at <code>${Utils.escapeHtml(state.grafana.internalUrl)}</code>`;

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-body">
          <p>${i18n.t('pages.observability.stateB.intro', { found, details: '' })}${foundDetails}.</p>
          <p style="margin-top:10px">${i18n.t('pages.observability.stateB.options', { missing })}</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3><i class="fas fa-rocket" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.observability.optionDeploy.title')}</h3></div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.observability.optionDeploy.desc')}</p>
          <div class="code-block" style="font-size:11px;background:var(--bg-dim);padding:10px;border-radius:var(--radius-sm);font-family:'JetBrains Mono',monospace"># On the Docker Dash host:
docker compose --profile observability up -d</div>
          <p class="text-sm text-muted" style="margin-top:10px">${i18n.t('pages.observability.optionDeploy.rescanHint')}</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3><i class="fas fa-link" style="color:var(--green);margin-right:8px"></i>${i18n.t('pages.observability.optionManual.title', { missing })}</h3></div>
        <div class="card-body">
          <p class="text-sm text-muted">${i18n.t('pages.observability.optionManual.desc', { missing })}</p>
          <ul style="margin:10px 0 0;padding-left:22px;line-height:1.8">
            <li>${missing === 'Prometheus' ? `<a href="https://prometheus.io/docs/prometheus/latest/installation/" target="_blank" rel="noopener">Prometheus install docs ↗</a>` : `<a href="https://grafana.com/docs/grafana/latest/setup-grafana/installation/" target="_blank" rel="noopener">Grafana install docs ↗</a>`}</li>
            <li><a href="https://github.com/bogdanpricop/docker-dash/blob/main/docs/features/observability.md#5-integrating-with-an-existing-prometheusgrafana" target="_blank" rel="noopener">${i18n.t('pages.observability.optionManual.integrateLink')}</a></li>
          </ul>
        </div>
      </div>
    `;
  },

  _renderNoneActions() {
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3><i class="fas fa-rocket" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.observability.stateC.deployTitle')}</h3></div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin:0 0 14px">${i18n.t('pages.observability.stateC.deployDesc')}</p>
          <div class="code-block" style="font-size:12px;background:var(--bg-dim);padding:12px;border-radius:var(--radius-sm);font-family:'JetBrains Mono',monospace"># On the Docker Dash host:
docker compose --profile observability up -d

# Wait ~30 seconds for containers to start. Grafana default:
#   URL:      http://&lt;host&gt;:3001 (configurable via GRAFANA_PORT in .env)
#   Login:    admin / admin (forced change on first login)
#   Dashboard: Docker Dash &rarr; Docker Dash &mdash; Overview</div>
          <div style="margin-top:14px;display:flex;gap:10px">
            <button class="btn btn-sm btn-primary" id="obs-rescan-cta"><i class="fas fa-sync-alt"></i> ${i18n.t('pages.observability.stateC.rescan')}</button>
            <a href="https://github.com/bogdanpricop/docker-dash/blob/main/docs/features/observability.md" target="_blank" rel="noopener" class="btn btn-sm btn-secondary"><i class="fas fa-external-link-alt"></i> ${i18n.t('pages.observability.fullGuide')}</a>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3><i class="fas fa-link" style="color:var(--green);margin-right:8px"></i>${i18n.t('pages.observability.stateC.externalTitle')}</h3></div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.observability.stateC.externalDesc')}</p>
          <div class="form-group">
            <label>${i18n.t('pages.observability.actionImport.urlLabel')}</label>
            <input type="text" id="grafana-url-external" class="form-control" placeholder="https://grafana.example.com">
          </div>
          <div class="form-group">
            <label>${i18n.t('pages.observability.actionImport.tokenLabel')}</label>
            <input type="password" id="grafana-token-external" class="form-control" placeholder="glsa_...">
            <p class="text-sm text-muted" style="margin-top:4px">${i18n.t('pages.observability.actionImport.tokenHint')}</p>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
            <button class="btn btn-primary" id="import-btn-external"><i class="fas fa-upload"></i> ${i18n.t('pages.observability.actionImport.submit')}</button>
            <div id="import-status-external" class="text-sm"></div>
          </div>
        </div>
      </div>
    `;
  },

  _attachHandlers(branch, state) {
    const copyBtn = document.getElementById('copy-snippet');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(state.scrapeConfigSnippet).then(
          () => Toast.success(i18n.t('pages.observability.actionScrape.copied')),
          () => Toast.error('Failed to copy to clipboard')
        );
      });
    }

    const importBtn = document.getElementById('import-btn');
    if (importBtn) importBtn.addEventListener('click', () => this._doImport('grafana-url', 'grafana-token', 'import-status'));

    const importBtnExt = document.getElementById('import-btn-external');
    if (importBtnExt) importBtnExt.addEventListener('click', () => this._doImport('grafana-url-external', 'grafana-token-external', 'import-status-external'));

    const rescanCta = document.getElementById('obs-rescan-cta');
    if (rescanCta) rescanCta.addEventListener('click', () => this._loadState());
  },

  async _doImport(urlInputId, tokenInputId, statusElId) {
    const urlEl = document.getElementById(urlInputId);
    const tokenEl = document.getElementById(tokenInputId);
    const statusEl = document.getElementById(statusElId);
    const grafanaUrl = (urlEl?.value || '').trim();
    const token = (tokenEl?.value || '').trim();

    if (!grafanaUrl || !token) {
      statusEl.innerHTML = `<span style="color:var(--red)">${i18n.t('pages.observability.actionImport.missingFields')}</span>`;
      return;
    }

    statusEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.observability.actionImport.importing')}`;
    try {
      const result = await Api.post('/observability/import-dashboard', { grafanaUrl, token });
      statusEl.innerHTML = `<span style="color:var(--green)"><i class="fas fa-check"></i> ${i18n.t('pages.observability.actionImport.success')} — <a href="${Utils.escapeHtml(result.dashboardUrl)}" target="_blank" rel="noopener">${i18n.t('pages.observability.actionImport.openDashboard')} <i class="fas fa-external-link-alt"></i></a></span>`;
      Toast.success(i18n.t('pages.observability.actionImport.success'));
      // Clear token after successful import (don't leave it in the DOM)
      tokenEl.value = '';
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times"></i> ${Utils.escapeHtml(err.message)}</span>`;
    }
  },

  destroy() {
    this._state = null;
  },
};
