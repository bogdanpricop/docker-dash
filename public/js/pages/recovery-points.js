/* Provider-neutral recovery-point inventory and guarded restore planning. */
'use strict';

const RecoveryPointsPage = {
  _hosts: [], _hostId: null, _data: null, _drills: [], _container: null,

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
      <td style="white-space:nowrap">${this._data?.restoreFeatureEnabled ? `<button class="btn btn-sm btn-primary recovery-restore" data-point-id="${Utils.escapeHtml(item.id)}"><i class="fas fa-rotate-left"></i> Restore</button>` : '<span class="text-muted text-sm">release disabled</span>'}
        ${this._data?.restoreDrillFeatureEnabled ? `<button class="btn btn-sm btn-secondary recovery-drill" data-point-id="${Utils.escapeHtml(item.id)}"><i class="fas fa-vial"></i> Drill</button>` : ''}</td>
    </tr>`).join('');
    return `<div class="card" style="overflow:auto"><table class="data-table"><thead><tr><th>Workload</th><th>Repository</th><th>Created</th><th>Backup</th><th>Verification</th><th>Retention protection</th><th>Restore</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  _drillsHtml(items) {
    if (!this._data?.restoreDrillFeatureEnabled) return '';
    if (!items?.length) return `<section style="margin-top:18px"><h2>Restore drills</h2>
      <div class="empty-msg">No restore drill has been recorded for this endpoint.</div></section>`;
    const rows = items.slice(0, 20).map(run => `<tr>
      <td><code>${Utils.escapeHtml(run.id)}</code><div class="text-muted text-sm">${Utils.escapeHtml(run.trigger || 'manual')}</div></td>
      <td><span class="badge ${run.state === 'succeeded' ? 'badge-success' : run.state === 'failed' || run.state === 'unknown' ? 'badge-danger' : run.state === 'blocked' ? 'badge-warning' : 'badge-info'}">${Utils.escapeHtml(run.state)}</span></td>
      <td>${run.target?.vmid ?? '—'}</td>
      <td>${run.rpoAgeSeconds == null ? '—' : `${Number(run.rpoAgeSeconds)}s`}${run.rpoTargetSeconds == null ? '' : ` / ${Number(run.rpoTargetSeconds)}s`}</td>
      <td>${run.rtoSeconds == null ? '—' : `${Number(run.rtoSeconds)}s`}${run.rtoTargetSeconds == null ? '' : ` / ${Number(run.rtoTargetSeconds)}s`}</td>
      <td><span class="badge ${run.compliance === 'met' ? 'badge-success' : run.compliance === 'breached' || run.compliance === 'failed' ? 'badge-danger' : 'badge-secondary'}">${Utils.escapeHtml(run.compliance || 'unknown')}</span></td>
      <td>${Utils.escapeHtml(this._date(run.createdAt))}</td>
    </tr>`).join('');
    return `<section style="margin-top:18px"><h2>Restore drills</h2><div class="card" style="overflow:auto">
      <table class="data-table"><thead><tr><th>Run</th><th>State</th><th>VMID</th><th>RPO age / target</th><th>RTO / target</th><th>Compliance</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  },

  _renderData(data) {
    const target = this._container?.querySelector('#recovery-content');
    if (!target) return;
    const limitations = (data.limitations || []).map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('');
    target.innerHTML = `${this._coverageHtml(data)}
      ${limitations ? `<div class="alert alert-info"><strong>Evidence boundaries</strong><ul style="margin:7px 0 0 18px">${limitations}</ul></div>` : ''}
      <section style="margin-top:18px"><h2>Backup repositories</h2>${this._repositoriesHtml(data.repositories)}</section>
      <section style="margin-top:18px"><h2>Recovery points</h2>${this._pointsHtml(data.items)}</section>
      ${this._drillsHtml(this._drills)}`;
    target.querySelectorAll('.recovery-restore').forEach(button => button.addEventListener('click', () => {
      const point = data.items.find(item => item.id === button.dataset.pointId);
      if (point) this._restore(point);
    }));
    target.querySelectorAll('.recovery-drill').forEach(button => button.addEventListener('click', () => {
      const point = data.items.find(item => item.id === button.dataset.pointId);
      if (point) this._drill(point);
    }));
  },

  _pick(items, title) {
    if (!items.length) throw new Error(`No ${title.toLowerCase()} is available`);
    const answer = window.prompt(`${title}:\n${items.map((item, index) => `${index + 1}. ${item.displayName}`).join('\n')}\n\nEnter the number:`);
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
    return items[index];
  },

  async _restore(point) {
    try {
      const [nodesResult, storagesResult] = await Promise.all([
        Api.getProviderHosts(this._hostId, 64), Api.getProviderStorages(this._hostId, 500),
      ]);
      const node = this._pick(nodesResult.items || [], 'Target node');
      if (!node) return;
      const nodeStorages = (storagesResult.items || []).filter(item =>
        !item.extensions?.node || item.extensions.node === node.displayName);
      const storage = this._pick(nodeStorages, 'Target storage');
      if (!storage) return;
      const targetVmidText = window.prompt('New target VMID (100-999999999). Existing workloads are never overwritten:');
      if (targetVmidText === null) return;
      const targetVmid = Number(targetVmidText);
      const verification = point.verification?.state || 'unknown';
      let allowUnverified = false; let overrideReason = null;
      if (verification !== 'verified') {
        if (verification === 'failed') throw new Error('A recovery point with failed verification cannot be restored');
        allowUnverified = window.confirm(`This recovery point is ${verification}. Continue to an explicit override plan?`);
        if (!allowUnverified) return;
        overrideReason = window.prompt('Reason for restoring unverified evidence (20-240 characters):') || '';
      }
      const input = {
        kind: 'vm', targetNodeId: node.id, targetStorageId: storage.id, targetVmid,
        allowUnverified, overrideReason,
      };
      const plan = await Api.preflightProviderRecoveryRestore(this._hostId, point.id, input);
      if (!plan.allowed) {
        const reasons = (plan.blockers || []).map(item => `${item.type}: ${item.reason}`).join('\n');
        throw new Error(reasons || 'Restore preflight is blocked');
      }
      const confirmation = window.prompt(`Restore creates VMID ${targetVmid} powered off and never cleans up partial data automatically.\n\nType exactly: ${plan.confirmation.expected}`);
      if (confirmation !== plan.confirmation.expected) return;
      const idempotencyKey = `restore-${Date.now()}-${window.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`;
      const result = await Api.submitProviderRecoveryRestore(this._hostId, point.id, {
        ...input, planHash: plan.planHash, confirm: true, confirmText: confirmation,
      }, idempotencyKey);
      Toast.success(`Restore queued as ${result.operation.id}; follow it in Activity Center`);
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _drill(point) {
    try {
      const [nodesResult, storagesResult] = await Promise.all([
        Api.getProviderHosts(this._hostId, 64), Api.getProviderStorages(this._hostId, 500),
      ]);
      const node = this._pick(nodesResult.items || [], 'Isolated drill target node');
      if (!node) return;
      const nodeStorages = (storagesResult.items || []).filter(item =>
        !item.extensions?.node || item.extensions.node === node.displayName);
      const storage = this._pick(nodeStorages, 'Isolated drill target storage');
      if (!storage) return;
      const targetVmidText = window.prompt('New drill VMID (100-999999999). Every restored NIC will be disconnected before boot:');
      if (targetVmidText === null) return;
      const targetVmid = Number(targetVmidText);
      const verification = point.verification?.state || 'unknown';
      let allowUnverified = false; let overrideReason = null;
      if (verification !== 'verified') {
        if (verification === 'failed') throw new Error('A recovery point with failed verification cannot be drilled');
        allowUnverified = window.confirm(`This recovery point is ${verification}. Continue with an explicit override?`);
        if (!allowUnverified) return;
        overrideReason = window.prompt('Reason for drilling unverified evidence (20-240 characters):') || '';
      }
      const cleanupOnSuccess = window.confirm('Automatically delete the isolated target only after every assertion and shutdown succeeds? Cancel keeps the stopped target.');
      const guestType = String(point.workload?.guestType || '').toLowerCase();
      const input = {
        kind: 'vm', targetNodeId: node.id, targetStorageId: storage.id, targetVmid,
        allowUnverified, overrideReason,
        assertions: { boot: true, guestAgent: guestType === 'lxc' || guestType === 'ct' ? 'disabled' : 'required',
          bootTimeoutSeconds: 300, osInfo: guestType !== 'lxc' && guestType !== 'ct' },
        cleanupMode: cleanupOnSuccess ? 'on_success' : 'never',
        allowAutomaticCleanup: cleanupOnSuccess, shutdownTimeoutSeconds: 120,
        rpoTargetSeconds: null, rtoTargetSeconds: 900,
      };
      const plan = await Api.preflightProviderRestoreDrill(this._hostId, point.id, input);
      if (!plan.allowed) {
        const reasons = (plan.blockers || []).map(item => `${item.type}: ${item.reason}`).join('\n');
        throw new Error(reasons || 'Restore-drill preflight is blocked');
      }
      const confirmation = window.prompt(`The drill restores VMID ${targetVmid}, disconnects every NIC, boots it, runs fixed assertions, and stops it.\n\nType exactly: ${plan.confirmation.expected}`);
      if (confirmation !== plan.confirmation.expected) return;
      let cleanupConfirmation = null;
      if (cleanupOnSuccess) {
        cleanupConfirmation = window.prompt(`Success-only cleanup is destructive. Failed or ambiguous targets are retained.\n\nType exactly: ${plan.confirmation.cleanupExpected}`);
        if (cleanupConfirmation !== plan.confirmation.cleanupExpected) return;
      }
      const idempotencyKey = `drill-${Date.now()}-${window.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`;
      const result = await Api.submitProviderRestoreDrill(this._hostId, point.id, {
        ...input, planHash: plan.planHash, confirm: true, confirmText: confirmation,
        cleanupConfirmText: cleanupConfirmation,
      }, idempotencyKey);
      Toast.success(`Restore drill queued as ${result.run.id}; follow operation ${result.operation?.id || result.run.operationId} in Activity Center`);
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => ['proxmox', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    this._hostId = this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-box-archive"></i> ${i18n.t('nav.recovery-points')}</h1>
      <div class="text-muted text-sm">Backup evidence and guarded create-only restore planning</div></div>
      <select id="recovery-host" class="form-control" aria-label="Virtualization endpoint">${this._hosts.map(host => `<option value="${Number(host.id)}">${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select></div>
      <div class="alert alert-warning"><strong>Snapshots are not backups.</strong> This page lists provider-reported backup recovery points only. “Unknown” means Docker Dash received no proof; it never implies success.</div>
      <div class="alert alert-info"><strong>Restore safety:</strong> normal restore creates a new powered-off Proxmox VM/CT. Restore drills additionally disconnect every NIC before boot, run fixed boot/guest-agent assertions, stop the target, and delete it only after success with separate authorization.</div>
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
      this._drills = this._data.restoreDrillFeatureEnabled
        ? (await Api.getProviderRestoreDrills(this._hostId, '', 50)).items || [] : [];
      this._renderData(this._data);
    } catch (err) {
      target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  destroy() { this._container = null; this._data = null; this._drills = []; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = RecoveryPointsPage;
