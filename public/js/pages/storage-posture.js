/* Provider-neutral, read-only storage health and capacity posture. */
'use strict';

const StoragePosturePage = {
  _hosts: [],
  _hostId: null,
  _container: null,
  _placementGiB: 10,
  _policyMinGiB: null,
  _policyRequireShared: false,

  _badge(state) {
    return { pass: 'badge-success', warning: 'badge-warning', fail: 'badge-danger', unknown: 'badge-secondary' }[state] || 'badge-secondary';
  },

  _label(value) { return String(value || 'unknown').replaceAll('_', ' '); },

  _formatBytes(value) { return Number.isFinite(value) ? Utils.formatBytes(value) : '—'; },

  _repositoryBadge(state) {
    return this._badge({ healthy: 'pass', degraded: 'warning', unavailable: 'fail', critical: 'fail', unknown: 'unknown' }[state] || 'unknown');
  },

  _repositoryHealthHtml(result) {
    const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
    const summary = result.summary || { states: {} };
    const rows = (result.repositories || []).map(repository => {
      const latest = repository.latest || {};
      const stages = latest.stages || {};
      const stageText = ['dns', 'tcp', 'auth', 'list'].map(name => `${name}: ${stages[name]?.state || 'unknown'}`).join(' · ');
      const history = (repository.history || []).slice(0, 10).reverse().map(item => `<span class="badge ${this._repositoryBadge(item.state)}" title="${Utils.escapeHtml(item.observedAt)}">${Utils.escapeHtml(item.state)}</span>`).join(' ');
      const endpoint = `${repository.hostname}:${repository.port}${repository.protocol === 'nfs' ? repository.repositoryPath : `/${repository.repositoryPath}`}`;
      return `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span><i class="fas fa-archive" aria-hidden="true"></i> <strong>${Utils.escapeHtml(repository.name)}</strong> <span class="text-muted text-sm">${Utils.escapeHtml(repository.protocol.toUpperCase())} · ${Utils.escapeHtml(endpoint)}</span></span><span><span class="badge ${this._repositoryBadge(latest.state)}">${Utils.escapeHtml(latest.state || 'unknown')}</span> <span class="badge ${repository.freshness === 'fresh' ? 'badge-success' : 'badge-secondary'}">${Utils.escapeHtml(repository.freshness)}</span></span></summary>
        <div style="padding-top:12px"><div class="text-muted text-sm">${Utils.escapeHtml(stageText)}${latest.latencyMs === null || latest.latencyMs === undefined ? '' : ` · ${Utils.escapeHtml(latest.latencyMs)} ms`}${repository.credentialConfigured ? ' · vault reference configured' : ' · no credential reference'}</div>
        ${history ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:9px">${history}</div>` : '<div class="text-muted text-sm" style="margin-top:9px">No observations yet.</div>'}
        ${admin ? `<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:12px"><button class="btn btn-sm btn-secondary repository-probe" data-id="${repository.id}"><i class="fas fa-heartbeat"></i> Probe</button><button class="btn btn-sm btn-secondary repository-edit" data-id="${repository.id}"><i class="fas fa-edit"></i> Edit</button>${repository.writeTestEnabled && result.coverage?.dataPlaneAdapterAvailable ? `<button class="btn btn-sm btn-warning repository-write-test" data-id="${repository.id}"><i class="fas fa-pen"></i> Write test</button>` : ''}<button class="btn btn-sm btn-danger repository-delete" data-id="${repository.id}"><i class="fas fa-trash"></i> Delete</button></div>` : ''}</div></details>`;
    }).join('');
    return `<section class="card" style="padding:16px;margin:16px 0" aria-labelledby="repository-health-title"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong id="repository-health-title">NFS / SMB repository health</strong><div class="text-muted text-sm">Bounded DNS, TCP and protocol evidence. An open port alone is never reported as healthy.</div></div>${admin ? '<button id="repository-add" class="btn btn-sm btn-primary"><i class="fas fa-plus"></i> Add repository</button>' : ''}</div>
      <div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.total ?? 0}</div><div class="stat-label">Repositories</div></div><div class="stat-card"><div class="stat-value">${summary.states?.healthy ?? 0}</div><div class="stat-label">Healthy</div></div><div class="stat-card"><div class="stat-value">${summary.states?.degraded ?? 0}</div><div class="stat-label">Degraded</div></div><div class="stat-card"><div class="stat-value">${(summary.states?.unavailable ?? 0) + (summary.states?.critical ?? 0)}</div><div class="stat-label">Unavailable / critical</div></div></div>
      ${(result.limitations || []).map(item => `<div class="alert alert-info" style="margin-top:12px">${Utils.escapeHtml(item)}</div>`).join('')}
      <div style="margin-top:14px">${rows || '<div class="empty-msg"><i class="fas fa-archive"></i>No NFS or SMB repositories are registered.</div>'}</div>
      <div class="alert alert-info" style="margin-top:14px"><strong>Read-only scheduler</strong> — scheduled probes never mount a filesystem and never request a write test.</div></section>`;
  },

  async _editRepository(repository = null) {
    let secrets = [];
    try { secrets = await Api.get('/secrets'); } catch { /* vault list is best effort */ }
    const current = repository || { protocol: 'nfs', port: 2049, repositoryPath: '/', secretId: null,
      writeTestEnabled: false, warningLatencyMs: 500, criticalLatencyMs: 2000, intervalMinutes: 60, isEnabled: true };
    const input = await Modal.form(`<div class="alert alert-info text-sm">Store credentials in the Secrets Vault first. This form stores only the reference and rejects URL/UNC credentials.</div>
      <div class="form-group"><label for="repository-name">Name</label><input id="repository-name" class="form-control" maxlength="100" value="${Utils.escapeHtml(current.name || '')}" required></div>
      <div class="form-row"><div class="form-group"><label for="repository-protocol">Protocol</label><select id="repository-protocol" class="form-control"><option value="nfs"${current.protocol === 'nfs' ? ' selected' : ''}>NFS</option><option value="smb"${current.protocol === 'smb' ? ' selected' : ''}>SMB</option></select></div><div class="form-group"><label for="repository-port">TCP port</label><input id="repository-port" class="form-control" type="number" min="1" max="65535" value="${current.port}"></div></div>
      <div class="form-group"><label for="repository-hostname">Hostname or IP</label><input id="repository-hostname" class="form-control" maxlength="253" value="${Utils.escapeHtml(current.hostname || '')}" placeholder="nas.example.internal" required></div>
      <div class="form-group"><label for="repository-path">NFS export path or SMB share name</label><input id="repository-path" class="form-control" maxlength="1024" value="${Utils.escapeHtml(current.repositoryPath || '')}" placeholder="/exports/backups" required></div>
      <div class="form-group"><label for="repository-secret">Vault secret reference</label><select id="repository-secret" class="form-control"><option value="">None / anonymous</option>${secrets.map(secret => `<option value="${secret.id}"${Number(current.secretId) === Number(secret.id) ? ' selected' : ''}>${Utils.escapeHtml(secret.name)}</option>`).join('')}</select></div>
      <div class="form-row"><div class="form-group"><label for="repository-warning-latency">Warning latency ms</label><input id="repository-warning-latency" class="form-control" type="number" min="1" max="30000" value="${current.warningLatencyMs}"></div><div class="form-group"><label for="repository-critical-latency">Critical latency ms</label><input id="repository-critical-latency" class="form-control" type="number" min="2" max="30000" value="${current.criticalLatencyMs}"></div><div class="form-group"><label for="repository-interval">Interval minutes</label><input id="repository-interval" class="form-control" type="number" min="15" max="1440" value="${current.intervalMinutes}"></div></div>
      <label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input id="repository-enabled" type="checkbox"${current.isEnabled ? ' checked' : ''}> Enable scheduled read-only probes</label><label style="display:flex;gap:8px;align-items:center"><input id="repository-write-enabled" type="checkbox"${current.writeTestEnabled ? ' checked' : ''}> Permit separately confirmed manual write tests when an approved adapter is available</label>`, {
      title: repository ? 'Edit storage repository' : 'Add storage repository', submitLabel: repository ? 'Save repository' : 'Add repository',
      onSubmit: root => ({ name: root.querySelector('#repository-name').value.trim(), protocol: root.querySelector('#repository-protocol').value,
        hostname: root.querySelector('#repository-hostname').value.trim(), port: Number(root.querySelector('#repository-port').value),
        repositoryPath: root.querySelector('#repository-path').value.trim(), secretId: root.querySelector('#repository-secret').value ? Number(root.querySelector('#repository-secret').value) : null,
        writeTestEnabled: root.querySelector('#repository-write-enabled').checked, warningLatencyMs: Number(root.querySelector('#repository-warning-latency').value),
        criticalLatencyMs: Number(root.querySelector('#repository-critical-latency').value), intervalMinutes: Number(root.querySelector('#repository-interval').value),
        isEnabled: root.querySelector('#repository-enabled').checked, ...(repository ? { version: repository.version } : {}) }),
    });
    if (!input) return;
    try {
      if (repository) await Api.updateStorageRepository(repository.id, input); else await Api.createStorageRepository(input);
      Toast.success(repository ? 'Storage repository updated' : 'Storage repository added');
      await this._load();
    } catch (error) { Toast.error(error.message); }
  },

  _wireRepositoryEvents(root, result) {
    root.querySelector('#repository-add')?.addEventListener('click', () => this._editRepository());
    root.querySelectorAll('.repository-probe').forEach(button => button.addEventListener('click', async () => {
      try { button.disabled = true; await Api.probeStorageRepository(Number(button.dataset.id)); Toast.success('Repository probe completed'); await this._load(); }
      catch (error) { button.disabled = false; Toast.error(error.message); }
    }));
    root.querySelectorAll('.repository-edit').forEach(button => button.addEventListener('click', () => {
      const repository = (result.repositories || []).find(item => item.id === Number(button.dataset.id));
      if (repository) this._editRepository(repository);
    }));
    root.querySelectorAll('.repository-delete').forEach(button => button.addEventListener('click', async () => {
      const repository = (result.repositories || []).find(item => item.id === Number(button.dataset.id));
      if (!repository || !confirm(`Delete storage repository "${repository.name}" and its health history?`)) return;
      try { await Api.deleteStorageRepository(repository.id); Toast.success('Storage repository deleted'); await this._load(); }
      catch (error) { Toast.error(error.message); }
    }));
    root.querySelectorAll('.repository-write-test').forEach(button => button.addEventListener('click', async () => {
      const repository = (result.repositories || []).find(item => item.id === Number(button.dataset.id));
      if (!repository) return;
      const confirmation = prompt(`This writes and then removes one random marker. Type WRITE ${repository.name} to continue.`);
      if (confirmation === null) return;
      try { await Api.writeTestStorageRepository(repository.id, confirmation); Toast.success('Repository write and cleanup test completed'); await this._load(); }
      catch (error) { Toast.error(error.message); }
    }));
  },

  _capabilityHtml(capabilities) {
    return `<div class="card" style="padding:14px;margin-bottom:16px"><strong>Evidence coverage</strong>
      <div class="text-muted text-sm" style="margin:4px 0 10px">Only provider-reported evidence is assessed. Unsupported or absent telemetry remains unknown.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(capabilities || {}).map(([key, item]) =>
        `<span class="badge ${this._badge(item.state === 'supported' || item.state === 'conditional' ? 'pass' : 'unknown')}">${Utils.escapeHtml(key)}: ${Utils.escapeHtml(this._label(item.state))}</span>`).join('')}</div></div>`;
  },

  _signalHtml(signal) {
    return `<li><span class="badge ${this._badge(signal.state)}">${Utils.escapeHtml(this._label(signal.state))}</span> <strong>${Utils.escapeHtml(this._label(signal.key))}</strong> — ${Utils.escapeHtml(signal.reason || 'No provider explanation')}</li>`;
  },

  _storageHtml(storage) {
    const allocation = storage.virtualAllocationBytes === null ? '—' : this._formatBytes(storage.virtualAllocationBytes);
    return `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
      <span><i class="fas fa-database" aria-hidden="true"></i> <strong>${Utils.escapeHtml(storage.displayName)}</strong> <span class="text-muted text-sm">${Utils.escapeHtml(storage.type || 'type unknown')}${storage.shared === true ? ' · shared' : (storage.shared === false ? ' · local' : '')}</span></span>
      <span><span class="badge ${this._badge(storage.state)}">${Utils.escapeHtml(this._label(storage.state))}</span>${storage.usedPercent === null ? '' : ` <span class="text-muted text-sm">${storage.usedPercent}% used</span>`}</span>
    </summary><div style="padding-top:14px">
      <div class="stats-grid" style="margin-bottom:12px"><div class="stat-card"><div class="stat-value">${this._formatBytes(storage.capacityBytes)}</div><div class="stat-label">Capacity</div></div>
        <div class="stat-card"><div class="stat-value">${this._formatBytes(storage.usedBytes)}</div><div class="stat-label">Used</div></div>
        <div class="stat-card"><div class="stat-value">${this._formatBytes(storage.freeBytes)}</div><div class="stat-label">Free</div></div>
        <div class="stat-card"><div class="stat-value">${allocation}</div><div class="stat-label">Virtual allocation</div></div></div>
      <ul style="margin:0 0 0 18px;display:grid;gap:7px">${(storage.signals || []).map(signal => this._signalHtml(signal)).join('')}</ul>
      ${storage.contentType ? `<div class="text-muted text-sm" style="margin-top:10px">Content classes: ${Utils.escapeHtml(storage.contentType)}</div>` : ''}
    </div></details>`;
  },

  _topologyHtml(result) {
    const summary = result.summary || {};
    const coverage = result.coverage || {};
    const rows = (result.sharedBackings || []).map(group => `<details class="card" style="padding:14px;margin-bottom:10px"><summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span><i class="fas fa-project-diagram" aria-hidden="true"></i> <strong>${group.consumerCount || 0} observed consumers</strong></span><span class="badge ${this._badge(group.state === 'confirmed' ? 'pass' : 'warning')}">${Utils.escapeHtml(group.state || 'review')}</span></summary><div style="padding-top:12px"><div class="text-muted text-sm" style="margin-bottom:9px">${Utils.escapeHtml(group.reason || 'No provider explanation')}</div><ul style="margin:0 0 0 18px;display:grid;gap:6px">${(group.attachments || []).map(item => `<li><strong>${Utils.escapeHtml(item.vm?.displayName || item.vm?.id || 'VM')}</strong> · ${Utils.escapeHtml(item.disk?.label || item.disk?.device || 'disk')}<span class="text-muted text-sm">${item.storage?.displayName ? ` · ${Utils.escapeHtml(item.storage.displayName)}` : ''}</span> <span class="badge ${this._badge(item.attachment?.shared === true ? 'pass' : 'unknown')}">shared: ${Utils.escapeHtml(String(item.attachment?.shared ?? 'unknown'))}</span></li>`).join('')}</ul></div></details>`).join('');
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>Shared-disk topology</strong><div class="text-muted text-sm">Cross-VM backing correlation; provider-native backing references are hidden.</div></div><span class="badge ${this._badge(coverage.complete ? 'pass' : 'unknown')}">${coverage.complete ? 'complete evidence' : 'partial evidence'}</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.confirmedCount ?? 0}</div><div class="stat-label">Confirmed shared</div></div><div class="stat-card"><div class="stat-value">${summary.reviewCount ?? 0}</div><div class="stat-label">Needs review</div></div><div class="stat-card"><div class="stat-value">${coverage.hardwareUnavailable ?? 0}</div><div class="stat-label">Unreadable VM inventories</div></div></div><div class="text-muted text-sm" style="margin:12px 0">${coverage.truncated ? 'VM selection is bounded; results are incomplete.' : 'VM selection was not truncated.'}</div>${rows || '<div class="empty-msg"><i class="fas fa-check-circle"></i>No multi-VM backing was observed in the selected inventory.</div>'}</div>`;
  },

  _placementHtml(result) {
    const summary = result.summary || {};
    const required = result.requested?.requiredBytes;
    const rows = (result.storages || []).map(storage => `<li><strong>${Utils.escapeHtml(storage.displayName)}</strong> <span class="badge ${this._badge(storage.state === 'candidate' ? 'pass' : (storage.state === 'blocked' ? 'fail' : 'unknown'))}">${Utils.escapeHtml(storage.state)}</span> <span class="text-muted text-sm">${Utils.escapeHtml((storage.signals || []).map(signal => signal.key).join(', ') || 'no evidence')}</span></li>`).join('');
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>Disk placement advisory</strong><div class="text-muted text-sm">For ${this._formatBytes(result.requested?.bytes)} plus ${result.requested?.headroomPercent ?? '—'}% headroom (${this._formatBytes(required)} required). This does not reserve capacity.</div></div><span class="badge badge-secondary">read-only</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.candidateCount ?? 0}</div><div class="stat-label">Candidates</div></div><div class="stat-card"><div class="stat-value">${summary.blockedCount ?? 0}</div><div class="stat-label">Blocked</div></div><div class="stat-card"><div class="stat-value">${summary.unknownCount ?? 0}</div><div class="stat-label">Needs evidence</div></div></div><ul style="margin:14px 0 0 18px;display:grid;gap:6px">${rows || '<li>No storage targets were returned.</li>'}</ul></div>`;
  },

  _policyHtml(result) {
    const summary = result.summary || {};
    const policy = result.policy || {};
    const minFree = policy.minFreeBytes === null ? 'no minimum free-space requirement' : `minimum ${this._formatBytes(policy.minFreeBytes)} free`;
    const rows = (result.storages || []).map(storage => `<li><strong>${Utils.escapeHtml(storage.displayName)}</strong> <span class="badge ${this._badge(storage.state === 'compliant' ? 'pass' : (storage.state === 'noncompliant' ? 'fail' : 'unknown'))}">${Utils.escapeHtml(storage.state)}</span></li>`).join('');
    return `<div class="card" style="padding:16px;margin:16px 0"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>Storage policy compliance</strong><div class="text-muted text-sm">Accessible targets; ${Utils.escapeHtml(minFree)}${policy.requireShared ? '; shared storage required' : ''}. View-only policy, not persisted.</div></div><span class="badge badge-secondary">read-only</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.compliantCount ?? 0}</div><div class="stat-label">Compliant</div></div><div class="stat-card"><div class="stat-value">${summary.noncompliantCount ?? 0}</div><div class="stat-label">Noncompliant</div></div><div class="stat-card"><div class="stat-value">${summary.unknownCount ?? 0}</div><div class="stat-label">Unknown</div></div></div><ul style="margin:14px 0 0 18px;display:grid;gap:6px">${rows || '<li>No storage targets were returned.</li>'}</ul></div>`;
  },

  _snapshotRiskHtml(result) {
    const summary = result.summary || {};
    const coverage = result.coverage || {};
    const policy = result.policy || {};
    const admin = App.user?.role === 'admin' || (App.user?.roles || []).includes('admin');
    const risks = (result.items || []).filter(item => ['warning', 'critical'].includes(item.state));
    const rows = risks.slice(0, 100).map(item => `<tr><td><a href="#/virtual-machines/${this._hostId}/${item.vm.id}/snapshots"><strong>${Utils.escapeHtml(item.vm.displayName)}</strong></a><div class="text-muted text-sm">${Utils.escapeHtml(item.name)}</div></td>
      <td><span class="badge ${this._badge(item.state === 'critical' ? 'fail' : 'warning')}">${Utils.escapeHtml(item.state)}</span></td>
      <td>${item.ageDays === null ? '—' : `${Utils.escapeHtml(item.ageDays)} d`}</td><td>${item.chainDepth ?? '—'}</td>
      <td>${this._formatBytes(item.estimatedBytes)}${item.growthPercent === null ? '' : `<div class="text-muted text-sm">${item.growthPercent >= 0 ? '+' : ''}${Utils.escapeHtml(item.growthPercent)}%</div>`}</td>
      <td>${Utils.escapeHtml((item.reasons || []).map(reason => this._label(reason.code)).join(', ') || 'Evidence incomplete')}</td></tr>`).join('');
    const trend = (result.history || []).slice(0, 14).reverse().map(item => `<div class="card" style="padding:8px;min-width:94px;text-align:center"><div class="text-muted text-sm">${Utils.escapeHtml(item.day)}</div><strong>${item.states?.critical ?? 0} / ${item.states?.warning ?? 0}</strong><div class="text-muted text-sm">critical / warning</div></div>`).join('');
    return `<section class="card" style="padding:16px;margin:16px 0" aria-labelledby="snapshot-risk-title">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong id="snapshot-risk-title">Snapshot age and growth risk</strong><div class="text-muted text-sm">Daily, read-only evidence. Snapshot-specific bytes are never inferred from VM disk capacity.</div></div><div style="display:flex;gap:7px;align-items:center"><span class="badge ${this._badge(summary.state === 'critical' ? 'fail' : summary.state)}">${Utils.escapeHtml(summary.state || 'unknown')}</span>${admin ? '<button id="snapshot-risk-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh evidence</button><button id="snapshot-risk-policy" class="btn btn-sm btn-secondary"><i class="fas fa-sliders-h"></i> Thresholds</button>' : ''}</div></div>
      <div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.snapshotCount ?? 0}</div><div class="stat-label">Snapshots</div></div><div class="stat-card"><div class="stat-value">${summary.states?.critical ?? 0}</div><div class="stat-label">Critical</div></div><div class="stat-card"><div class="stat-value">${summary.states?.warning ?? 0}</div><div class="stat-label">Warnings</div></div><div class="stat-card"><div class="stat-value">${summary.oldestAgeDays ?? '—'}</div><div class="stat-label">Oldest age (days)</div></div><div class="stat-card"><div class="stat-value">${summary.maxChainDepth ?? '—'}</div><div class="stat-label">Max proven depth</div></div><div class="stat-card"><div class="stat-value">${summary.estimatedBytesKnownCount ?? 0}/${summary.snapshotCount ?? 0}</div><div class="stat-label">Byte coverage</div></div></div>
      <div class="text-muted text-sm" style="margin:12px 0">Policy: age ${policy.warningAgeDays ?? '—'}/${policy.criticalAgeDays ?? '—'} days · depth ${policy.warningChainDepth ?? '—'}/${policy.criticalChainDepth ?? '—'} · growth ${policy.warningGrowthPercent ?? '—'}/${policy.criticalGrowthPercent ?? '—'}% (warning/critical). Evidence: ${Utils.escapeHtml(coverage.evidenceFreshness || 'unknown')}${coverage.lastCaptureAt ? ` · captured ${Utils.escapeHtml(Utils.timeAgo(coverage.lastCaptureAt))}` : ' · no completed background capture yet'}.</div>
      ${coverage.collection?.failedVms ? `<div class="alert alert-warning">Snapshot inventory failed for ${coverage.collection.failedVms} of ${coverage.collection.attemptedVms} attempted VM(s). Results are partial.</div>` : ''}
      ${coverage.truncated ? '<div class="alert alert-warning">Snapshot inventory exceeded the bounded processing limit; results are partial.</div>' : ''}
      ${rows ? `<div style="overflow:auto"><table class="data-table"><thead><tr><th>VM / snapshot</th><th>Risk</th><th>Age</th><th>Depth</th><th>Reported bytes</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-msg"><i class="fas fa-check-circle"></i>No warning or critical snapshot risk is visible in the current evidence.</div>'}
      ${trend ? `<div style="margin-top:14px"><strong>Daily trend</strong><div style="display:flex;gap:7px;overflow:auto;margin-top:8px">${trend}</div></div>` : ''}
      <div class="alert alert-info" style="margin-top:14px"><strong>Monitor only</strong> — this section cannot delete or consolidate snapshots and does not change retention.</div>
    </section>`;
  },

  async _refreshSnapshotRisk() {
    try {
      Toast.info('Refreshing bounded snapshot evidence…');
      await Api.refreshProviderSnapshotRisk(this._hostId);
      Toast.success('Snapshot risk evidence refreshed');
      await this._load();
    } catch (error) { Toast.error(error.message); }
  },

  async _editSnapshotRiskPolicy(result) {
    const policy = result.policy || {};
    const input = await Modal.form(`<div class="alert alert-info text-sm">Thresholds affect warnings only. They never trigger snapshot deletion or consolidation.</div>
      <div class="form-row"><div class="form-group"><label for="snapshot-risk-warning-age">Warning age days</label><input id="snapshot-risk-warning-age" class="form-control" type="number" min="1" max="3650" value="${policy.warningAgeDays}"></div><div class="form-group"><label for="snapshot-risk-critical-age">Critical age days</label><input id="snapshot-risk-critical-age" class="form-control" type="number" min="2" max="3650" value="${policy.criticalAgeDays}"></div></div>
      <div class="form-row"><div class="form-group"><label for="snapshot-risk-warning-depth">Warning chain depth</label><input id="snapshot-risk-warning-depth" class="form-control" type="number" min="1" max="64" value="${policy.warningChainDepth}"></div><div class="form-group"><label for="snapshot-risk-critical-depth">Critical chain depth</label><input id="snapshot-risk-critical-depth" class="form-control" type="number" min="2" max="64" value="${policy.criticalChainDepth}"></div></div>
      <div class="form-row"><div class="form-group"><label for="snapshot-risk-warning-growth">Warning daily growth %</label><input id="snapshot-risk-warning-growth" class="form-control" type="number" min="1" max="10000" value="${policy.warningGrowthPercent}"></div><div class="form-group"><label for="snapshot-risk-critical-growth">Critical daily growth %</label><input id="snapshot-risk-critical-growth" class="form-control" type="number" min="2" max="10000" value="${policy.criticalGrowthPercent}"></div></div>`, {
      title: 'Snapshot risk thresholds', submitLabel: 'Save thresholds',
      onSubmit: root => ({
        warningAgeDays: Number(root.querySelector('#snapshot-risk-warning-age').value), criticalAgeDays: Number(root.querySelector('#snapshot-risk-critical-age').value),
        warningChainDepth: Number(root.querySelector('#snapshot-risk-warning-depth').value), criticalChainDepth: Number(root.querySelector('#snapshot-risk-critical-depth').value),
        warningGrowthPercent: Number(root.querySelector('#snapshot-risk-warning-growth').value), criticalGrowthPercent: Number(root.querySelector('#snapshot-risk-critical-growth').value),
        version: policy.version,
      }),
    });
    if (!input) return;
    try {
      await Api.updateProviderSnapshotRiskPolicy(this._hostId, input);
      Toast.success('Snapshot risk thresholds updated');
      await this._load();
    } catch (error) { Toast.error(error.message); }
  },

  _resultHtml(result) {
    const summary = result.summary || {};
    const state = summary.state || 'unknown';
    return `${this._capabilityHtml(result.capabilities)}
      <div class="card" style="padding:16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><strong>${Utils.escapeHtml(result.provider?.type || 'Provider')} storage posture</strong><div class="text-muted text-sm">Observed ${Utils.escapeHtml(Utils.timeAgo(result.observedAt))}</div></div><span class="badge ${this._badge(state)}">${Utils.escapeHtml(this._label(state))}</span></div>
      <div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${summary.storageCount ?? 0}</div><div class="stat-label">Storage targets</div></div><div class="stat-card"><div class="stat-value">${summary.states?.fail ?? 0}</div><div class="stat-label">Critical</div></div><div class="stat-card"><div class="stat-value">${summary.states?.warning ?? 0}</div><div class="stat-label">Warnings</div></div><div class="stat-card"><div class="stat-value">${this._formatBytes(summary.freeBytes)}</div><div class="stat-label">Reported free space</div></div></div></div>
      ${(result.storages || []).length ? result.storages.map(storage => this._storageHtml(storage)).join('') : '<div class="empty-msg"><i class="fas fa-database"></i>No storage targets were returned by this provider.</div>'}
      ${(result.limitations || []).length ? `<div class="alert alert-info" style="margin-top:16px"><strong>Assessment limits</strong><ul>${result.limitations.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}`;
  },

  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); }
    catch { this._hosts = []; }
    const selected = Api.getHostId();
    this._hostId = this._hosts.some(host => host.id === selected) ? selected : this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-database"></i> ${i18n.t('nav.storage-posture')}</h1><div class="text-muted text-sm">Read-only provider evidence for accessibility, maintenance, capacity and overcommit risk</div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${this._hosts.length ? `<label class="text-muted text-sm">Disk GiB <input id="storage-placement-gib" type="number" min="1" max="65536" step="1" value="${this._placementGiB}" class="form-control" style="width:88px;display:inline-block"></label><label class="text-muted text-sm">Policy min GiB <input id="storage-policy-min-gib" type="number" min="0" max="65536" step="1" value="${this._policyMinGiB ?? ''}" placeholder="none" class="form-control" style="width:88px;display:inline-block"></label><label class="text-muted text-sm"><input id="storage-policy-shared" type="checkbox"${this._policyRequireShared ? ' checked' : ''}> Shared only</label><select id="storage-posture-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select><button id="storage-posture-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> Refresh</button>` : ''}</div></div>
      <div id="storage-posture-content"></div>`;
    container.querySelector('#storage-posture-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load(); });
    container.querySelector('#storage-placement-gib')?.addEventListener('change', event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 65536) { this._placementGiB = value; this._load(); } });
    container.querySelector('#storage-policy-min-gib')?.addEventListener('change', event => { const raw = event.target.value; const value = raw === '' ? null : Number(raw); if (value === null || (Number.isInteger(value) && value >= 0 && value <= 65536)) { this._policyMinGiB = value; this._load(); } });
    container.querySelector('#storage-policy-shared')?.addEventListener('change', event => { this._policyRequireShared = event.target.checked === true; this._load(); });
    container.querySelector('#storage-posture-refresh')?.addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const target = this._container?.querySelector('#storage-posture-content');
    if (!target) return;
    target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting storage evidence…</div>';
    try {
      const repositoryHealth = await Api.getStorageRepositories(30).catch(error => ({ error }));
      const repositoryHtml = repositoryHealth.error
        ? `<div class="alert alert-info"><strong>Repository health unavailable</strong><div>${Utils.escapeHtml(repositoryHealth.error.message)}</div></div>`
        : this._repositoryHealthHtml(repositoryHealth);
      if (!this._hostId) {
        target.innerHTML = repositoryHtml + '<div class="empty-msg"><i class="fas fa-server"></i>Add a supported virtualization endpoint to inspect provider storage posture.</div>';
        if (!repositoryHealth.error) this._wireRepositoryEvents(target, repositoryHealth);
        return;
      }
      const requestedBytes = this._placementGiB * 1024 * 1024 * 1024;
      const policyMinFreeBytes = this._policyMinGiB === null ? null : this._policyMinGiB * 1024 * 1024 * 1024;
      const [posture, topology, placement, policy, snapshotRisk] = await Promise.all([
        Api.getProviderStoragePosture(this._hostId),
        Api.getProviderStorageTopology(this._hostId).catch(error => ({ error })),
        Api.getProviderStoragePlacementAdvisory(this._hostId, requestedBytes).catch(error => ({ error })),
        Api.getProviderStoragePolicyAdvisory(this._hostId, { minFreeBytes: policyMinFreeBytes, requireShared: this._policyRequireShared }).catch(error => ({ error })),
        Api.getProviderSnapshotRisk(this._hostId).catch(error => ({ error })),
      ]);
      target.innerHTML = repositoryHtml + this._resultHtml(posture) + (topology.error
        ? `<div class="alert alert-info"><strong>Shared-disk topology unavailable</strong><div>${Utils.escapeHtml(topology.error.message)}</div></div>`
        : this._topologyHtml(topology)) + (placement.error
        ? `<div class="alert alert-info"><strong>Disk placement advisory unavailable</strong><div>${Utils.escapeHtml(placement.error.message)}</div></div>`
        : this._placementHtml(placement)) + (policy.error
        ? `<div class="alert alert-info"><strong>Storage policy compliance unavailable</strong><div>${Utils.escapeHtml(policy.error.message)}</div></div>`
        : this._policyHtml(policy)) + (snapshotRisk.error
        ? `<div class="alert alert-info"><strong>Snapshot risk unavailable</strong><div>${Utils.escapeHtml(snapshotRisk.error.message)}</div></div>`
        : this._snapshotRiskHtml(snapshotRisk));
      target.querySelector('#snapshot-risk-refresh')?.addEventListener('click', () => this._refreshSnapshotRisk());
      target.querySelector('#snapshot-risk-policy')?.addEventListener('click', () => this._editSnapshotRiskPolicy(snapshotRisk));
      if (!repositoryHealth.error) this._wireRepositoryEvents(target, repositoryHealth);
    }
    catch (err) { target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`; }
  },

  destroy() { this._container = null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = StoragePosturePage;
