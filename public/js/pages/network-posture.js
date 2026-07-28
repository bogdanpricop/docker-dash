/* Provider-neutral, read-only virtual network posture. */
'use strict';

const NetworkPosturePage = {
  _hosts: [],
  _hostId: null,
  _container: null,

  _badge(state) { return { pass: 'badge-success', warning: 'badge-warning', fail: 'badge-danger', unknown: 'badge-secondary' }[state] || 'badge-secondary'; },
  _label(value) { return String(value || 'unknown').replaceAll('_', ' '); },

  _networkHtml(network) {
    return `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span><i class="fas fa-network-wired" aria-hidden="true"></i> <strong>${Utils.escapeHtml(network.displayName)}</strong><span class="text-muted text-sm">${network.bridge ? ` · ${Utils.escapeHtml(network.bridge)}` : ''}${network.vlanId === null ? '' : ` · VLAN ${Utils.escapeHtml(network.vlanId)}`}</span></span><span class="badge ${this._badge(network.state)}">${Utils.escapeHtml(this._label(network.state))}</span></summary><div style="padding-top:12px"><div class="stats-grid" style="margin-bottom:10px"><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(network.mtu ?? '—')}</div><div class="stat-label">MTU</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(network.managed === null ? '—' : String(network.managed))}</div><div class="stat-label">Managed</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(network.accessible === null ? '—' : String(network.accessible))}</div><div class="stat-label">Accessible</div></div></div><ul style="margin:0 0 0 18px;display:grid;gap:6px">${(network.signals || []).map(signal => `<li><span class="badge ${this._badge(signal.state)}">${Utils.escapeHtml(this._label(signal.state))}</span> <strong>${Utils.escapeHtml(this._label(signal.key))}</strong> — ${Utils.escapeHtml(signal.reason || 'No provider explanation')}</li>`).join('')}</ul></div></details>`;
  },

  _resultHtml(result) {
    const summary = result.summary || {};
    return `<div class="card" style="padding:16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>${Utils.escapeHtml(result.provider?.type || 'Provider')} virtual network posture</strong><div class="text-muted text-sm">Read-only provider inventory; routing and isolation are not tested.</div></div><span class="badge ${this._badge(summary.state)}">${Utils.escapeHtml(this._label(summary.state))}</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.networkCount ?? 0}</div><div class="stat-label">Networks</div></div><div class="stat-card"><div class="stat-value">${summary.states?.fail ?? 0}</div><div class="stat-label">Inaccessible</div></div><div class="stat-card"><div class="stat-value">${summary.states?.warning ?? 0}</div><div class="stat-label">Warnings</div></div><div class="stat-card"><div class="stat-value">${summary.states?.unknown ?? 0}</div><div class="stat-label">Missing evidence</div></div></div></div>${(result.networks || []).length ? result.networks.map(item => this._networkHtml(item)).join('') : '<div class="empty-msg"><i class="fas fa-network-wired"></i>No virtual networks were returned by this provider.</div>'}<div class="alert alert-info" style="margin-top:16px"><strong>Assessment limits</strong><ul>${(result.limitations || []).map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>`;
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    const selected = Api.getHostId();
    this._hostId = this._hosts.some(host => host.id === selected) ? selected : this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-network-wired"></i> Network Posture</h1><div class="text-muted text-sm">Read-only provider evidence for virtual-network accessibility and configuration</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${this._hosts.length ? `<select id="network-posture-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select><button id="network-posture-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>` : ''}</div></div><div id="network-posture-content"></div>`;
    container.querySelector('#network-posture-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load(); });
    container.querySelector('#network-posture-refresh')?.addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const target = this._container?.querySelector('#network-posture-content');
    if (!target) return;
    if (!this._hostId) { target.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a supported virtualization endpoint to inspect its virtual networks.</div>'; return; }
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting live network evidence…</div>';
    try { target.innerHTML = this._resultHtml(await Api.getProviderNetworkPosture(this._hostId)); }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`; }
  },

  destroy() { this._container = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = NetworkPosturePage;
