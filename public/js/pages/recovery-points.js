/* Provider-neutral, read-only backup repository and recovery-point inventory. */
'use strict';

const RecoveryPointsPage = {
  _hosts: [], _hostId: null, _data: null, _container: null,

  _badge(state) {
    return ({ verified: 'badge-success', failed: 'badge-danger', stale: 'badge-warning',
      unverified: 'badge-warning', unknown: 'badge-secondary' })[state] || 'badge-secondary';
  },

  _bytes(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
      ? '—' : Utils.formatBytes(Number(value));
  },

  _date(value) { return value ? Utils.timeAgo(value) : 'not reported'; },

  _coverageHtml(data) {
    const coverage = data.coverage || {};
    const verification = coverage.verification || {};
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:14px 0">
      <div class="card" style="padding:14px"><div class="text-muted text-sm">Recovery points</div><strong style="font-size:24px">${Number(data.totalObserved || 0)}</strong></div>
      <div class="card" style="padding:14px"><div class="text-muted text-sm">Repositories</div><strong style="font-size:24px">${Number(coverage.repositoryCount || 0)}</strong></div>
      <div class="card" style="padding:14px"><div class="text-muted text-sm">Mapped workloads</div><strong style="font-size:24px">${Number(coverage.mappedWorkloadCount || 0)} / ${Number(coverage.workloadCount || 0)}</strong></div>
      <div class="card" style="padding:14px"><div class="text-muted text-sm">Verified / failed</div><strong style="font-size:24px">${Number(verification.verified || 0)} / ${Number(verification.failed || 0)}</strong></div>
      <div class="card" style="padding:14px"><div class="text-muted text-sm">Newest point</div><strong>${Utils.escapeHtml(this._date(coverage.newestAt))}</strong></div>
    </div>`;
  },

  _repositoriesHtml(repositories) {
    if (!repositories?.length) return '<div class="empty-msg">No backup repository was reported.</div>';
    const rows = repositories.map(repository => `<tr>
      <td><strong>${Utils.escapeHtml(repository.displayName)}</strong></td>
      <td>${Utils.escapeHtml(repository.repositoryType || 'unknown')}</td>
      <td><span class="badge ${repository.status?.accessible === false ? 'badge-danger' : repository.status?.accessible === true ? 'badge-success' : 'badge-secondary'}">${repository.status?.accessible === false ? 'offline' : repository.status?.accessible === true ? 'online' : 'unknown'}</span></td>
      <td>${this._bytes(repository.status?.usedBytes)} / ${this._bytes(repository.status?.capacityBytes)}</td>
      <td>${repository.capabilities?.verification === true ? '<span class="badge badge-info">verification</span>' : '—'} ${repository.capabilities?.clientSideEncryption === true ? '<span class="badge badge-info">encryption capable</span>' : ''} ${repository.capabilities?.immutableRetention === true ? '<span class="badge badge-info">protection capable</span>' : ''}</td>
    </tr>`).join('');
    return `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Repository</th><th>Type</th><th>Access</th><th>Used / capacity</th><th>Reported capabilities</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _pointsHtml(items) {
    if (!items?.length) return '<div class="empty-msg">No recovery point matches the current filters.</div>';
    const rows = items.map(item => `<tr>
      <td><strong>${Utils.escapeHtml(item.workload?.displayName || item.displayName)}</strong>${item.workload?.missingFromInventory ? '<div class="text-muted text-sm">workload not mapped in current inventory</div>' : ''}</td>
      <td>${Utils.escapeHtml(item.repository?.displayName || 'Unknown repository')}</td>
      <td>${Utils.escapeHtml(this._date(item.createdAt))}<div class="text-muted text-sm">${Utils.escapeHtml(item.createdAt || 'timestamp not reported')}</div></td>
      <td>${Utils.escapeHtml(item.backup?.mode || 'unknown')} · ${Utils.escapeHtml(item.backup?.format || 'format unknown')}<div class="text-muted text-sm">${this._bytes(item.backup?.sizeBytes)}</div></td>
      <td><span class="badge ${this._badge(item.verification?.state)}">${Utils.escapeHtml(item.verification?.state || 'unknown')}</span>${item.verification?.checkedAt ? `<div class="text-muted text-sm">${Utils.escapeHtml(this._date(item.verification.checkedAt))}</div>` : ''}</td>
      <td>${item.backup?.protected === true ? '<span class="badge badge-success">protected</span>' : item.backup?.protected === false ? '<span class="badge badge-warning">not protected</span>' : '<span class="badge badge-secondary">unknown</span>'}</td>
    </tr>`).join('');
    return `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Workload</th><th>Repository</th><th>Created</th><th>Backup</th><th>Verification</th><th>Retention protection</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _renderData(data) {
    const target = this._container?.querySelector('#recovery-content');
    if (!target) return;
    const limitations = (data.limitations || []).map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('');
    target.innerHTML = `${this._coverageHtml(data)}
      ${limitations ? `<div class="alert alert-info"><strong>Evidence boundaries</strong><ul style="margin:7px 0 0 18px">${limitations}</ul></div>` : ''}
      <section style="margin-top:18px"><h2>Backup repositories</h2>${this._repositoriesHtml(data.repositories)}</section>
      <section style="margin-top:18px"><h2>Recovery points</h2>${this._pointsHtml(data.items)}</section>`;
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-box-archive"></i> Recovery Points</h1>
      <div class="text-muted text-sm">Read-only backup evidence across Proxmox VE / PBS and Xen Orchestra</div></div>
      <select id="recovery-host" class="form-control" aria-label="Virtualization endpoint">${this._hosts.map(host => `<option value="${Number(host.id)}">${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select></div>
      <div class="alert alert-warning"><strong>Snapshots are not backups.</strong> This page lists provider-reported backup recovery points only. “Unknown” means Docker Dash received no proof; it never implies success.</div>
      <div class="card" style="padding:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <label style="flex:1;min-width:220px">Search<input id="recovery-search" class="form-control" maxlength="120" placeholder="Workload, repository, format"></label>
        <label>Verification<select id="recovery-verification" class="form-control"><option value="">All states</option><option value="verified">Verified</option><option value="failed">Failed</option><option value="stale">Stale</option><option value="unverified">Unverified</option><option value="unknown">Unknown</option></select></label>
        <button id="recovery-refresh" class="btn btn-primary"><i class="fas fa-sync"></i> Refresh</button>
      </div><div id="recovery-content"></div>`;
    container.querySelector('#recovery-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); this._load(); });
    container.querySelector('#recovery-refresh')?.addEventListener('click', () => this._load());
    container.querySelector('#recovery-verification')?.addEventListener('change', () => this._load());
    container.querySelector('#recovery-search')?.addEventListener('keydown', event => { if (event.key === 'Enter') this._load(); });
    await this._load();
  },

  async _load() {
    const target = this._container?.querySelector('#recovery-content');
    if (!target) return;
    if (!this._hostId) {
      target.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a Proxmox VE or Xen Orchestra endpoint to inspect recovery points.</div>';
      return;
    }
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Reading provider backup evidence…</div>';
    try {
      this._data = await Api.getProviderRecoveryPoints(this._hostId, {
        limit: 500, query: this._container.querySelector('#recovery-search')?.value || '',
        verification: this._container.querySelector('#recovery-verification')?.value || '',
      });
      this._renderData(this._data);
    } catch (err) {
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  destroy() { this._container = null; this._data = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = RecoveryPointsPage;
