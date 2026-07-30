/* Provider-neutral HA readiness dashboard. */
'use strict';

const HighAvailabilityPage = {
  _hosts: [],
  _hostId: null,

  _isAdmin() {
    return App.user?.role === 'admin' || App.user?.roles?.includes('admin');
  },

  _badge(state) {
    const classes = {
      ready: 'badge-success', pass: 'badge-success', degraded: 'badge-warning', warning: 'badge-warning',
      blocked: 'badge-danger', fail: 'badge-danger', unknown: 'badge-secondary', unsupported: 'badge-secondary',
      not_configured: 'badge-info', not_applicable: 'badge-info',
    };
    return classes[state] || 'badge-secondary';
  },

  _stateText(value) { return String(value || 'unknown').replaceAll('_', ' '); },
  _count(value) { return Number.isInteger(value) && value >= 0 ? String(value) : '—'; },

  _signalHtml(signal) {
    return `<tr><td><code>${Utils.escapeHtml(signal.key)}</code></td>
      <td><span class="badge ${this._badge(signal.state)}">${Utils.escapeHtml(this._stateText(signal.state))}</span></td>
      <td>${Utils.escapeHtml(signal.reason || 'No explanation')}</td>
      <td>${Utils.escapeHtml(signal.source || 'provider')} · ${Utils.escapeHtml(signal.confidence || 'unknown')}</td></tr>`;
  },

  _recoveryPlanHtml(plan) {
    if (!plan || plan.state === 'not_applicable') return '<div class="empty-msg">No protected running workload is eligible for recovery planning.</div>';
    const nodes = new Map((plan.nodes || []).map(item => [item.id, item]));
    const seconds = value => Number.isFinite(value) ? `${value}s` : 'evidence unavailable';
    const rows = (plan.waves || []).map(wave => {
      const items = (wave.items || []).map(id => nodes.get(id)).filter(Boolean);
      const workloads = items.map(item => `<div><strong>${Utils.escapeHtml(item.displayName)}</strong>
        <span class="text-muted text-sm">priority ${Utils.escapeHtml(item.priority || 'unknown')} · ready ${Utils.escapeHtml(seconds(item.estimatedReadySeconds))}</span></div>`).join('');
      const dependencies = [...new Set(items.flatMap(item => item.dependencyIds || []).map(id => nodes.get(id)?.displayName).filter(Boolean))];
      return `<tr><td>${this._count(wave.index)}</td><td>${Utils.escapeHtml(seconds(wave.startOffsetSeconds))}</td>
        <td>${Utils.escapeHtml(seconds(wave.estimatedReadyAtSeconds))}</td><td>${workloads || '—'}</td>
        <td>${dependencies.length ? dependencies.map(value => Utils.escapeHtml(value)).join(', ') : (wave.dependsOnWaveIds?.length ? Utils.escapeHtml(wave.dependsOnWaveIds.join(', ')) : 'none')}</td></tr>`;
    }).join('');
    const blockers = plan.blockers?.length ? `<div class="alert ${plan.state === 'blocked' ? 'alert-danger' : 'alert-info'}"><strong>Evidence limits</strong><ul>
      ${plan.blockers.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : '';
    return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span class="badge ${this._badge(plan.state)}">${Utils.escapeHtml(this._stateText(plan.state))}</span>
      <span class="text-muted text-sm">${Utils.escapeHtml(this._stateText(plan.mode))} · ${Utils.escapeHtml(plan.confidence || 'unknown')} confidence · ${this._count(plan.edges?.length)} explicit edge(s) · completion ${Utils.escapeHtml(seconds(plan.estimatedCompletionSeconds))}</span></div>
      ${blockers}<div style="overflow:auto"><table class="data-table"><thead><tr><th>Wave</th><th>Estimated start</th><th>Estimated ready</th><th>Workloads</th><th>Depends on</th></tr></thead><tbody>
      ${rows || '<tr><td colspan="5">No acyclic recovery waves could be produced.</td></tr>'}</tbody></table></div>`;
  },

  _domainHtml(domain) {
    const score = Number.isFinite(domain.score) ? `${domain.score}/100` : '—';
    const domainId = /^ddr_cluster_[a-f0-9]{26}$/.test(String(domain.id || ''))
      ? domain.id : 'ddr_cluster_unknown';
    const signals = domain.signals?.length ? `<div style="overflow:auto"><table class="data-table"><thead><tr><th>Signal</th><th>State</th><th>Evidence</th><th>Source</th></tr></thead><tbody>
      ${domain.signals.map(signal => this._signalHtml(signal)).join('')}</tbody></table></div>`
      : '<div class="empty-msg">No portable HA signals are available for this domain.</div>';
    const scenarios = domain.scenarios?.length ? `<div style="overflow:auto"><table class="data-table"><thead><tr><th>Host failures</th><th>Result</th><th>Method</th><th>Reason</th></tr></thead><tbody>
      ${domain.scenarios.map(item => `<tr><td>${this._count(item.failures)}</td><td><span class="badge ${this._badge(item.state)}">${Utils.escapeHtml(this._stateText(item.state))}</span></td>
        <td>${Utils.escapeHtml(item.source === 'provider_native' ? 'provider native' : 'conservative estimate')}</td><td>${Utils.escapeHtml(item.reason || '')}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-msg">No safe host-loss simulation is available.</div>';
    const recovery = domain.recoveryGroups?.length ? domain.recoveryGroups.map(group => `<details style="margin:8px 0"><summary>
      <span class="badge ${group.priority === 'disabled' ? 'badge-secondary' : 'badge-info'}">${Utils.escapeHtml(group.priority)}</span> ${group.items.length} workload(s)</summary>
      <div style="padding:8px 0 0 16px">${group.items.map(item => `<div><i class="fas fa-desktop" aria-hidden="true"></i> ${Utils.escapeHtml(item.displayName)}
        <span class="text-muted text-sm">${item.poweredOn ? 'running' : 'stopped'} · ${item.protected === true ? 'protected' : (item.protected === false ? 'unprotected' : 'unknown')}</span></div>`).join('')}</div></details>`).join('')
      : '<div class="empty-msg">No provider restart-priority evidence is available.</div>';
    const recoveryPlan = this._recoveryPlanHtml(domain.recoveryPlan);
    return `<section class="card" style="padding:16px;margin-bottom:16px" aria-labelledby="ha-domain-${domainId}">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div><h2 id="ha-domain-${domainId}" style="margin:0 0 4px"><i class="fas fa-shield-alt" aria-hidden="true"></i> ${Utils.escapeHtml(domain.displayName)}</h2>
          <span class="badge ${this._badge(domain.state)}">${Utils.escapeHtml(this._stateText(domain.state))}</span></div>
        <div style="font-size:24px;font-weight:700" aria-label="Readiness score ${Utils.escapeHtml(score)}">${Utils.escapeHtml(score)}</div>
      </div>
      <div class="stats-grid" style="margin:14px 0">
        <div class="stat-card"><div class="stat-value">${this._count(domain.onlineHostCount)}/${this._count(domain.hostCount)}</div><div class="stat-label">Online hosts</div></div>
        <div class="stat-card"><div class="stat-value">${this._count(domain.protectedVmCount)}/${this._count(domain.poweredOnVmCount)}</div><div class="stat-label">Protected running VMs</div></div>
        <div class="stat-card"><div class="stat-value">${this._count(domain.protectionCoveragePercent)}${domain.protectionCoveragePercent === null ? '' : '%'}</div><div class="stat-label">Protection coverage</div></div>
        <div class="stat-card"><div class="stat-value">${this._count(domain.observedFailureTolerance)}</div><div class="stat-label">Observed failover depth</div></div>
      </div>
      ${domain.warnings?.length ? `<div class="alert alert-warning"><strong>Provider caveats</strong><ul>${domain.warnings.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      <h3>Readiness evidence</h3>${signals}
      <h3 style="margin-top:18px">Host-loss simulation</h3><p class="text-muted text-sm">Estimated scenarios do not prove CPU, network, storage, device or application compatibility.</p>${scenarios}
      <h3 style="margin-top:18px">Recovery dependency DAG</h3><p class="text-muted text-sm">Waves use explicit dependencies or provider start-order evidence. Unknown readiness durations remain unknown.</p>${recoveryPlan}
      <h3 style="margin-top:18px">Recovery priority groups</h3><p class="text-muted text-sm">Priority groups are descriptive; they are not a guaranteed dependency-aware restart schedule.</p>${recovery}
    </section>`;
  },

  _snapshotHtml(snapshot) {
    return `<div class="card" style="padding:14px;margin-bottom:16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div><strong>${Utils.escapeHtml(snapshot.provider?.type || 'provider')} HA readiness</strong>
        <div class="text-muted text-sm">Observed ${Utils.escapeHtml(Utils.timeAgo(snapshot.observedAt))} · ${snapshot.cache?.stale ? 'stale last-good snapshot' : (snapshot.cache?.hit ? 'cached' : 'live refresh')}</div></div>
      <div><span class="badge ${this._badge(snapshot.state)}">${Utils.escapeHtml(this._stateText(snapshot.state))}</span>
        <span class="text-muted text-sm" style="margin-left:8px">${Number.isFinite(snapshot.score) ? `${snapshot.score}/100` : 'score unavailable'}</span></div></div>
      ${snapshot.cache?.refreshError ? `<div class="alert alert-warning">${Utils.escapeHtml(snapshot.cache.refreshError)}; showing encrypted last-good evidence.</div>` : ''}
      ${(snapshot.limitations || []).length ? `<div class="alert alert-info"><strong>Method limits</strong><ul>${snapshot.limitations.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${(snapshot.domains || []).map(domain => this._domainHtml(domain)).join('')}`;
  },

  _historyHtml(history) {
    const items = history?.items || [];
    if (!items.length) return '<div class="empty-msg">No HA readiness history has been recorded yet.</div>';
    return `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Observed</th><th>State</th><th>Score</th><th>Domains</th><th>Snapshot</th></tr></thead><tbody>
      ${items.map(item => `<tr><td>${Utils.escapeHtml(Utils.timeAgo(item.observedAt))}</td><td><span class="badge ${this._badge(item.state)}">${Utils.escapeHtml(this._stateText(item.state))}</span></td>
        <td>${this._count(item.score)}</td><td>${this._count(item.domainCount)}</td><td><code>${Utils.escapeHtml(String(item.snapshotHash || '').slice(0, 12))}</code></td></tr>`).join('')}</tbody></table></div>`;
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)
      && Number.isInteger(Number(host.id)) && Number(host.id) > 0); }
    catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-shield-alt"></i> High Availability</h1>
      <div class="text-muted text-sm">Provider-native HA facts, conservative failure simulations and evidence-bound recovery waves</div></div>
      <div style="display:flex;gap:8px;align-items:center"><select id="ha-host" class="form-control" aria-label="Virtualization endpoint">
        ${this._hosts.map(host => `<option value="${host.id}">${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select>
        ${this._isAdmin() ? '<button class="btn btn-sm btn-secondary" id="ha-refresh"><i class="fas fa-sync"></i> Refresh evidence</button>' : ''}</div></div>
      <div id="ha-content"></div><h2 style="margin-top:24px">Readiness history</h2><div id="ha-history"></div>`;
    const select = container.querySelector('#ha-host');
    select?.addEventListener('change', () => { this._hostId = Number(select.value); this._load(false); });
    container.querySelector('#ha-refresh')?.addEventListener('click', () => this._load(true));
    await this._load(false);
  },

  async _load(refresh) {
    const content = this._container?.querySelector('#ha-content');
    const history = this._container?.querySelector('#ha-history');
    if (!content || !history) return;
    if (!this._hostId) {
      content.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a Proxmox, vSphere or Xen endpoint to inspect HA readiness.</div>';
      history.innerHTML = ''; return;
    }
    content.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting bounded HA evidence…</div>';
    history.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Loading history…</div>';
    try {
      const [snapshot, historyResult] = await Promise.all([
        refresh ? Api.refreshProviderHaReadiness(this._hostId) : Api.getProviderHaReadiness(this._hostId),
        Api.getProviderHaReadinessHistory(this._hostId, 48),
      ]);
      content.innerHTML = this._snapshotHtml(snapshot);
      history.innerHTML = this._historyHtml(historyResult);
    } catch (err) {
      content.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
      history.innerHTML = '';
    }
  },

  destroy() { this._container = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = HighAvailabilityPage;
