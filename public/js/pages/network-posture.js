/* Provider-neutral, read-only virtual network posture. */
'use strict';

const NetworkPosturePage = {
  _hosts: [],
  _hostId: null,
  _container: null,
  _policyMinMtu: null,
  _policyRequireManaged: false,
  _policyRequireVlan: false,

  _badge(state) { return { pass: 'badge-success', warning: 'badge-warning', fail: 'badge-danger', unknown: 'badge-secondary' }[state] || 'badge-secondary'; },
  _label(value) { return String(value || 'unknown').replaceAll('_', ' '); },

  _networkHtml(network) {
    return `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span><i class="fas fa-network-wired" aria-hidden="true"></i> <strong>${Utils.escapeHtml(network.displayName)}</strong><span class="text-muted text-sm">${network.bridge ? ` · ${Utils.escapeHtml(network.bridge)}` : ''}${network.vlanId === null ? '' : ` · VLAN ${Utils.escapeHtml(network.vlanId)}`}</span></span><span class="badge ${this._badge(network.state)}">${Utils.escapeHtml(this._label(network.state))}</span></summary><div style="padding-top:12px"><div class="stats-grid" style="margin-bottom:10px"><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(network.mtu ?? '—')}</div><div class="stat-label">MTU</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(network.managed === null ? '—' : String(network.managed))}</div><div class="stat-label">Managed</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(network.accessible === null ? '—' : String(network.accessible))}</div><div class="stat-label">Accessible</div></div></div><ul style="margin:0 0 0 18px;display:grid;gap:6px">${(network.signals || []).map(signal => `<li><span class="badge ${this._badge(signal.state)}">${Utils.escapeHtml(this._label(signal.state))}</span> <strong>${Utils.escapeHtml(this._label(signal.key))}</strong> — ${Utils.escapeHtml(signal.reason || 'No provider explanation')}</li>`).join('')}</ul></div></details>`;
  },

  _resultHtml(result) {
    const summary = result.summary || {};
    return `<div class="card" style="padding:16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>${Utils.escapeHtml(result.provider?.type || 'Provider')} virtual network posture</strong><div class="text-muted text-sm">Read-only provider inventory; routing and isolation are not tested.</div></div><span class="badge ${this._badge(summary.state)}">${Utils.escapeHtml(this._label(summary.state))}</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.networkCount ?? 0}</div><div class="stat-label">Networks</div></div><div class="stat-card"><div class="stat-value">${summary.states?.fail ?? 0}</div><div class="stat-label">Inaccessible</div></div><div class="stat-card"><div class="stat-value">${summary.states?.warning ?? 0}</div><div class="stat-label">Warnings</div></div><div class="stat-card"><div class="stat-value">${summary.states?.unknown ?? 0}</div><div class="stat-label">Missing evidence</div></div></div></div>${(result.networks || []).length ? result.networks.map(item => this._networkHtml(item)).join('') : '<div class="empty-msg"><i class="fas fa-network-wired"></i>No virtual networks were returned by this provider.</div>'}<div class="alert alert-info" style="margin-top:16px"><strong>Assessment limits</strong><ul>${(result.limitations || []).map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>`;
  },

  _policyHtml(result) {
    const summary = result.summary || {}; const policy = result.policy || {};
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong>Network policy compliance</strong><div class="text-muted text-sm">Accessible networks; ${policy.minMtu === null ? 'no MTU minimum' : `MTU ≥ ${Utils.escapeHtml(policy.minMtu)}`}${policy.requireManaged ? '; managed required' : ''}${policy.requireVlan ? '; VLAN required' : ''}. This policy is not persisted.</div></div><span class="badge badge-secondary">read-only</span></div><div class="stats-grid" style="margin-top:12px"><div class="stat-card"><div class="stat-value">${summary.compliantCount ?? 0}</div><div class="stat-label">Compliant</div></div><div class="stat-card"><div class="stat-value">${summary.noncompliantCount ?? 0}</div><div class="stat-label">Noncompliant</div></div><div class="stat-card"><div class="stat-value">${summary.unknownCount ?? 0}</div><div class="stat-label">Unknown</div></div></div></div>`;
  },

  _topologyHtml(result) {
    const summary = result.summary || {};
    return `<div class="card" style="padding:16px;margin:16px 0"><strong>VM network attachment topology</strong><div class="text-muted text-sm">Read-only attachment evidence; this does not prove connectivity or isolation.</div><div class="stats-grid" style="margin-top:12px"><div class="stat-card"><div class="stat-value">${summary.networkCount ?? 0}</div><div class="stat-label">Observed networks</div></div><div class="stat-card"><div class="stat-value">${summary.attachmentCount ?? 0}</div><div class="stat-label">VM attachments</div></div></div>${(result.networks || []).length ? `<ul style="margin:14px 0 0 18px;display:grid;gap:8px">${result.networks.map(network => `<li><strong>${Utils.escapeHtml(network.displayName)}</strong> <span class="text-muted">${network.consumerCount} attachment${network.consumerCount === 1 ? '' : 's'}; ${network.connectedCount} connected</span></li>`).join('')}</ul>` : '<div class="text-muted" style="margin-top:12px">No VM-to-network attachments were observed.</div>'}</div>`;
  },

  _placementHtml(result) {
    const summary = result.summary || {};
    return `<div class="card" style="padding:16px;margin:16px 0"><strong>Network placement evidence</strong><div class="text-muted text-sm">Read-only advisory; candidates are not reservations or connectivity guarantees.</div><div class="stats-grid" style="margin-top:12px"><div class="stat-card"><div class="stat-value">${summary.candidateCount ?? 0}</div><div class="stat-label">Candidates</div></div><div class="stat-card"><div class="stat-value">${summary.blockedCount ?? 0}</div><div class="stat-label">Blocked</div></div><div class="stat-card"><div class="stat-value">${summary.unknownCount ?? 0}</div><div class="stat-label">Needs evidence</div></div></div></div>`;
  },

  _driftHtml(result) {
    const drifted = result.state === 'drifted';
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong>Network configuration baseline</strong><div class="text-muted text-sm">${result.state === 'unbaselined' ? 'No baseline saved yet.' : drifted ? `${(result.changes || []).length} provider-visible change(s) since the baseline.` : 'No provider-visible configuration drift detected.'}</div></div><span class="badge ${drifted ? 'badge-warning' : 'badge-secondary'}">${Utils.escapeHtml(result.state || 'unknown')}</span></div><div class="text-muted text-sm" style="margin-top:10px">Baseline records are explicit and read-only; saving one never changes provider configuration.</div></div>`;
  },

  _ipHtml(result) { const s = result.summary || {}; return `<div class="card" style="padding:16px;margin:16px 0"><strong>VM IP address evidence</strong><div class="text-muted text-sm">Provider/guest-tools observations only; no network probe is performed.</div><div class="stats-grid" style="margin-top:12px"><div class="stat-card"><div class="stat-value">${s.addressCount ?? 0}</div><div class="stat-label">Addresses</div></div><div class="stat-card"><div class="stat-value">${s.ipv4Count ?? 0}</div><div class="stat-label">IPv4</div></div><div class="stat-card"><div class="stat-value">${s.ipv6Count ?? 0}</div><div class="stat-label">IPv6</div></div></div></div>`; },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    const selected = Api.getHostId();
    this._hostId = this._hosts.some(host => host.id === selected) ? selected : this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-network-wired"></i> Network Posture</h1><div class="text-muted text-sm">Read-only provider evidence for virtual-network accessibility and configuration</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${this._hosts.length ? `<label class="text-muted text-sm">Policy min MTU <input id="network-policy-mtu" type="number" min="576" max="65535" value="${this._policyMinMtu ?? ''}" placeholder="none" class="form-control" style="width:88px;display:inline-block"></label><label class="text-muted text-sm"><input id="network-policy-managed" type="checkbox"${this._policyRequireManaged ? ' checked' : ''}> Managed</label><label class="text-muted text-sm"><input id="network-policy-vlan" type="checkbox"${this._policyRequireVlan ? ' checked' : ''}> VLAN</label><select id="network-posture-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select><button id="network-posture-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>` : ''}</div></div><div id="network-posture-content"></div>`;
    container.querySelector('#network-posture-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load(); });
    container.querySelector('#network-policy-mtu')?.addEventListener('change', event => { const raw = event.target.value; const value = raw === '' ? null : Number(raw); if (value === null || (Number.isInteger(value) && value >= 576 && value <= 65535)) { this._policyMinMtu = value; this._load(); } });
    container.querySelector('#network-policy-managed')?.addEventListener('change', event => { this._policyRequireManaged = event.target.checked === true; this._load(); });
    container.querySelector('#network-policy-vlan')?.addEventListener('change', event => { this._policyRequireVlan = event.target.checked === true; this._load(); });
    container.querySelector('#network-posture-refresh')?.addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const target = this._container?.querySelector('#network-posture-content');
    if (!target) return;
    if (!this._hostId) { target.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a supported virtualization endpoint to inspect its virtual networks.</div>'; return; }
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting live network evidence…</div>';
    try { const [posture, policy, topology, placement, drift, ips] = await Promise.all([Api.getProviderNetworkPosture(this._hostId), Api.getProviderNetworkPolicyAdvisory(this._hostId, { minMtu: this._policyMinMtu, requireManaged: this._policyRequireManaged, requireVlan: this._policyRequireVlan }).catch(error => ({ error })), Api.getProviderNetworkAttachmentTopology(this._hostId).catch(error => ({ error })), Api.getProviderNetworkPlacementAdvisory(this._hostId).catch(error => ({ error })), Api.getProviderNetworkDriftBaseline(this._hostId).catch(error => ({ error })), Api.getProviderIpAddressInventory(this._hostId).catch(error => ({ error }))]); target.innerHTML = this._resultHtml(posture) + (policy.error ? `<div class="alert alert-info"><strong>Network policy advisory unavailable</strong><div>${Utils.escapeHtml(policy.error.message)}</div></div>` : this._policyHtml(policy)) + (topology.error ? `<div class="alert alert-info"><strong>Network attachment topology unavailable</strong><div>${Utils.escapeHtml(topology.error.message)}</div></div>` : this._topologyHtml(topology)) + (placement.error ? `<div class="alert alert-info"><strong>Network placement advisory unavailable</strong><div>${Utils.escapeHtml(placement.error.message)}</div></div>` : this._placementHtml(placement)) + (drift.error ? `<div class="alert alert-info"><strong>Network baseline unavailable</strong><div>${Utils.escapeHtml(drift.error.message)}</div></div>` : this._driftHtml(drift)) + (ips.error ? `<div class="alert alert-info"><strong>IP address inventory unavailable</strong><div>${Utils.escapeHtml(ips.error.message)}</div></div>` : this._ipHtml(ips)); }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`; }
  },

  destroy() { this._container = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = NetworkPosturePage;
