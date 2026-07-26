/* Provider-neutral affinity inventory and read-only placement planning. */
'use strict';

const PlacementAdvisorPage = {
  _hosts: [], _hostId: null, _vms: [], _container: null,

  _isAdmin() { return App.user?.role === 'admin' || App.user?.roles?.includes('admin'); },
  _badge(state) {
    return ({ compliant: 'badge-success', fresh: 'badge-success', high: 'badge-success',
      violated: 'badge-danger', blocked: 'badge-danger', low: 'badge-danger',
      unknown: 'badge-secondary', unsupported: 'badge-secondary', disabled: 'badge-secondary',
      stale: 'badge-warning', expired: 'badge-warning', medium: 'badge-warning', conditional: 'badge-info' })[state] || 'badge-info';
  },
  _label(value) { return String(value || 'unknown').replaceAll('_', ' '); },
  _number(value, suffix = '') { return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100) / 100}${suffix}` : '—'; },

  _affinityHtml(data) {
    const rules = data.rules || [];
    const rows = rules.map(rule => `<tr><td>${Utils.escapeHtml(rule.name)}</td>
      <td>${Utils.escapeHtml(this._label(rule.kind))}</td>
      <td><span class="badge ${rule.mandatory ? 'badge-danger' : 'badge-info'}">${rule.mandatory ? 'mandatory' : 'preference'}</span></td>
      <td><span class="badge ${this._badge(rule.compliance?.state)}">${Utils.escapeHtml(this._label(rule.compliance?.state))}</span><div class="text-muted text-sm">${Utils.escapeHtml(rule.compliance?.reason || '')}</div></td>
      <td>${Number(rule.virtualMachineIds?.length || 0)} VM · ${Number(rule.hostIds?.length || 0)} host</td></tr>`).join('');
    return `<div class="card" style="padding:14px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong>Affinity policy</strong>
      <div class="text-muted text-sm">${Utils.escapeHtml(data.provider?.type || 'provider')} · observed ${Utils.escapeHtml(Utils.timeAgo(data.observedAt))}</div></div>
      <div><span class="badge ${this._badge(data.capability?.state)}">${Utils.escapeHtml(this._label(data.capability?.state))}</span>
      <span class="badge ${this._badge(data.freshness?.state)}">${Utils.escapeHtml(this._label(data.freshness?.state))}</span></div></div></div>
      ${(data.limitations || []).length ? `<div class="alert alert-info"><ul>${data.limitations.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Rule</th><th>Kind</th><th>Strength</th><th>Compliance</th><th>Mapped scope</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-msg">No portable affinity rules were reported. Capacity recommendations can still be available.</div>'}`;
  },

  _recommendationHtml(data) {
    const rows = (data.candidates || []).map(item => `<tr><td>${Utils.escapeHtml(item.target?.displayName || item.target?.id)}</td>
      <td><strong>${this._number(item.score, '/100')}</strong><div class="text-muted text-sm">${this._number(item.evidenceCoveragePercent, '%')} coverage</div></td>
      <td><span class="badge ${this._badge(item.confidence)}">${Utils.escapeHtml(item.confidence)}</span></td>
      <td>${(item.readyModes || []).map(mode => `<span class="badge badge-success">${Utils.escapeHtml(mode)}</span>`).join(' ') || '—'}</td>
      <td>${item.blockers?.length ? `<ul>${item.blockers.map(blocker => `<li>${Utils.escapeHtml(blocker.reason)}</li>`).join('')}</ul>` : (item.eligible ? '<span class="badge badge-success">eligible</span>' : '<span class="badge badge-secondary">unknown</span>')}</td></tr>`).join('');
    return `<div class="card" style="padding:14px;margin:16px 0"><strong>${Utils.escapeHtml(data.vm?.displayName || 'VM')}</strong>
      <div class="text-muted text-sm">Read-only recommendation · plan <code>${Utils.escapeHtml(String(data.planHash || '').slice(0, 12))}</code></div></div>
      ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Target</th><th>Score</th><th>Confidence</th><th>Ready modes</th><th>Decision evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-msg">No alternate placement target is visible in this endpoint boundary.</div>'}`;
  },

  _planHtml(plan) {
    const rows = (plan.moves || []).map(move => `<tr><td>${Utils.escapeHtml(move.vm?.displayName || move.vm?.id)}</td>
      <td><code>${Utils.escapeHtml(String(move.sourceHostId || '').slice(0, 18))}…</code></td><td><code>${Utils.escapeHtml(String(move.targetHostId || '').slice(0, 18))}…</code></td>
      <td>${Utils.escapeHtml(move.mode || 'unknown')}</td><td>${this._number(move.score, '/100')}</td><td>${this._number(move.projectedTargetMemoryUtilizationPercent, '%')}</td></tr>`).join('');
    return `<div class="alert alert-info"><strong>Dry-run only.</strong> This plan cannot execute migrations and expires ${Utils.escapeHtml(Utils.timeAgo(plan.expiresAt))}.</div>
      <div class="text-muted text-sm" style="margin-bottom:10px">Plan <code>${Utils.escapeHtml(String(plan.planHash || '').slice(0, 12))}</code> · ${Number(plan.skipped?.length || 0)} skipped workload(s)</div>
      ${rows ? `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>VM</th><th>Source</th><th>Target</th><th>Mode</th><th>Score</th><th>Projected target memory</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-msg">No safe move was proposed for the current thresholds and evidence.</div>'}`;
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-balance-scale"></i> Placement Advisor</h1>
      <div class="text-muted text-sm">Affinity-aware recommendations and bounded rebalance planning — no provider action is submitted</div></div>
      <select id="placement-host" class="form-control" aria-label="Virtualization endpoint">${this._hosts.map(host => `<option value="${Number(host.id)}">${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select></div>
      <div id="placement-affinity"></div><section class="card" style="padding:14px;margin-top:18px"><h2 style="margin-top:0">VM recommendation</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><select id="placement-vm" class="form-control" aria-label="Virtual machine"></select>
      <button id="placement-recommend" class="btn btn-primary"><i class="fas fa-search"></i> Evaluate targets</button></div><div id="placement-recommendation"></div></section>
      ${this._isAdmin() ? `<section class="card" style="padding:14px;margin-top:18px"><h2 style="margin-top:0">Cluster rebalance dry-run</h2>
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><label>Source threshold %<input id="placement-source-threshold" class="form-control" type="number" min="70" max="95" value="85"></label>
      <label>Target ceiling %<input id="placement-target-threshold" class="form-control" type="number" min="50" max="94" value="75"></label>
      <button id="placement-plan" class="btn btn-secondary"><i class="fas fa-project-diagram"></i> Generate dry-run</button></div><div id="placement-plan-result"></div></section>` : ''}`;
    container.querySelector('#placement-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); this._load(); });
    container.querySelector('#placement-recommend')?.addEventListener('click', () => this._recommend());
    container.querySelector('#placement-plan')?.addEventListener('click', () => this._plan());
    await this._load();
  },

  async _load() {
    const affinity = this._container?.querySelector('#placement-affinity');
    const vmSelect = this._container?.querySelector('#placement-vm');
    if (!affinity || !vmSelect) return;
    if (!this._hostId) { affinity.innerHTML = '<div class="empty-msg">Add a Proxmox, vSphere or Xen endpoint to inspect placement evidence.</div>'; return; }
    affinity.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting placement policy…</div>';
    try {
      const [policy, inventory] = await Promise.all([Api.getProviderAffinity(this._hostId), Api.getProviderVMs(this._hostId, 500)]);
      this._vms = inventory.items || [];
      affinity.innerHTML = this._affinityHtml(policy);
      vmSelect.innerHTML = this._vms.map(vm => `<option value="${Utils.escapeHtml(vm.id)}">${Utils.escapeHtml(vm.displayName)}</option>`).join('');
    } catch (err) { affinity.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; vmSelect.innerHTML = ''; }
  },

  async _recommend() {
    const target = this._container?.querySelector('#placement-recommendation');
    const vmId = this._container?.querySelector('#placement-vm')?.value;
    if (!target || !/^ddr_vm_[a-f0-9]{26}$/.test(String(vmId || ''))) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Evaluating targets…</div>';
    try { target.innerHTML = this._recommendationHtml(await Api.getProviderPlacementRecommendations(this._hostId, vmId)); }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; }
  },

  async _plan() {
    const target = this._container?.querySelector('#placement-plan-result');
    if (!target) return;
    const body = { sourceThresholdPercent: Number(this._container.querySelector('#placement-source-threshold').value),
      targetThresholdPercent: Number(this._container.querySelector('#placement-target-threshold').value) };
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Generating bounded dry-run…</div>';
    try { target.innerHTML = this._planHtml(await Api.planProviderRebalance(this._hostId, body)); }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error">${Utils.escapeHtml(err.message)}</div>`; }
  },

  destroy() { this._container = null; this._vms = []; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PlacementAdvisorPage;
