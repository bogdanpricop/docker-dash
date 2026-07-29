/* Edge, ROBO and disconnected operations — B326-B335 */
'use strict';

const EdgePlatformPage = {
  _container: null,
  _data: null,

  async render(container) {
    this._container = container; container.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i></div>';
    try { this._data = await Api.getEdgeOverview(); this._paint(); }
    catch (error) { container.innerHTML = `<div class="empty-state"><i class="fas fa-tower-broadcast"></i><h3>Edge &amp; disconnected</h3><p>${Utils.escapeHtml(error.message)}</p></div>`; }
  },

  _paint() {
    const data = this._data || {}; const summary = data.summary || {}; const sites = data.sites || [];
    const stateBadge = state => state === 'healthy' || state === 'ready' || state === 'acknowledged' || state === 'ready_for_agent' ? 'badge-success'
      : state === 'blocked' || state === 'offline' || state === 'expired' || state === 'revalidation_required' ? 'badge-danger' : 'badge-warning';
    this._container.innerHTML = `<div class="page-header"><div><h1 class="page-title"><i class="fas fa-tower-broadcast" style="color:var(--accent);margin-right:10px"></i>Edge &amp; disconnected</h1>
      <p class="page-subtitle">Signed offline intent, bounded cache and store-and-forward evidence for ROBO and air-gapped sites.</p></div>
      <button class="btn btn-secondary" id="edge-refresh"><i class="fas fa-rotate"></i> Refresh</button></div>
      <div class="alert alert-info">Central execution is disabled. Intents require reconnect revalidation; runbook/update/bootstrap/mirror records are signed envelopes or manifests only. Agent transport remains authenticated admin ingestion until B350 enrollment.</div>
      <div class="info-grid">
        ${this._stat('fa-location-dot','Sites',summary.sites || 0)}${this._stat('fa-signal','Healthy',summary.online || 0)}
        ${this._stat('fa-plug-circle-xmark','Expected offline',summary.expectedDisconnected || 0)}${this._stat('fa-clock-rotate-left','Stale cache',summary.staleCache || 0)}
        ${this._stat('fa-list-check','Queued intents',summary.queuedIntents || 0)}${this._stat('fa-box','Buffered events',summary.pendingEvents || 0)}
        ${this._stat('fa-microchip','Active agents',summary.activeAgents || 0)}${this._stat('fa-hard-drive','Ready mirrors',summary.readyMirrors || 0)}
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin:14px 0">
        ${[['site','Site'],['connectivity','Connectivity'],['cache','Cache evidence'],['intent','Offline intent'],['revalidate','Revalidate'],['agent','Agent'],['heartbeat','Heartbeat'],['sync-policy','Sync policy'],['events','Buffer events'],['sync-plan','Sync plan'],['ack','Acknowledge'],['runbook','Runbook envelope'],['update','Update plan'],['bootstrap','Bootstrap'],['mirror','Mirror']].map(([key,label], index) => `<button class="btn btn-sm ${index === 0 ? 'btn-primary' : 'btn-secondary'}" data-edge-action="${key}">${label}</button>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Sites &amp; connectivity</h3></div><table class="data-table"><thead><tr><th>Site</th><th>Region / owner</th><th>Connectivity</th><th>Health</th></tr></thead><tbody>
          ${sites.map(site => `<tr><td><strong>${Utils.escapeHtml(site.name)}</strong><div class="mono text-xs">#${site.id} · ${Utils.escapeHtml(site.slug)} · ${Utils.escapeHtml(site.timezone)}</div></td><td>${Utils.escapeHtml(site.region)} / ${Utils.escapeHtml(site.localOwner)}<div class="text-xs text-muted">${site.hosts.length} hosts · ${Utils.escapeHtml(site.jurisdiction)}</div></td><td>${Utils.escapeHtml(site.connectivity?.mode || 'unknown')}<div class="text-xs text-muted">cache ${site.connectivity?.cacheTtlSeconds || '—'}s · mutations ${site.connectivity?.mutationMode || 'deny'}</div></td><td><span class="badge ${stateBadge(site.health)}">${Utils.escapeHtml(site.health)}</span><div class="text-xs text-muted">${site.heartbeat ? `${site.heartbeat.ageSeconds}s · seq ${site.heartbeat.sequence}` : 'no heartbeat'}</div></td></tr>`).join('') || this._empty('No edge sites', 4)}
        </tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Offline intents</h3></div><table class="data-table"><thead><tr><th>Action / target</th><th>Expiry</th><th>State</th></tr></thead><tbody>
          ${(data.intents || []).slice(0,50).map(item => `<tr><td><strong class="mono text-sm">#${item.id} · ${Utils.escapeHtml(item.actionKey)}</strong><div class="text-xs text-muted">${Utils.escapeHtml(item.targetRef)} · ${item.intentHash.slice(0,12)}</div></td><td>${new Date(item.expiresAt).toLocaleString()}</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span><div class="text-xs text-muted">provider mutations 0</div></td></tr>`).join('') || this._empty('No signed offline intents', 3)}
        </tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Store-and-forward</h3></div><table class="data-table"><thead><tr><th>Plan</th><th>Cursors</th><th>Size</th><th>State</th></tr></thead><tbody>
          ${(data.syncPlans || []).slice(0,50).map(item => `<tr><td class="mono">#${item.id}<div class="text-xs text-muted">${item.planHash.slice(0,12)}</div></td><td>${item.firstCursor} → ${item.lastCursor}</td><td>${Utils.formatBytes ? Utils.formatBytes(item.totalBytes) : item.totalBytes}</td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td></tr>`).join('') || this._empty('No synchronization plans', 4)}
        </tbody></table><div class="card-body text-sm text-muted">Pending compressed bytes: ${Utils.formatBytes ? Utils.formatBytes(summary.pendingEventBytes || 0) : summary.pendingEventBytes || 0}. Priority order is explicit per site.</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Local agents &amp; updates</h3></div><table class="data-table"><thead><tr><th>Agent</th><th>Ring / version</th><th>Last seen</th><th>State</th></tr></thead><tbody>
          ${(data.agents || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.agentId)}</strong><div class="mono text-xs">#${item.id} · site #${item.siteId}</div></td><td>${Utils.escapeHtml(item.updateRing)} / ${Utils.escapeHtml(item.version || 'unknown')}</td><td>${item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : 'never'}</td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td></tr>`).join('') || this._empty('No local agent profiles', 4)}
        </tbody></table><div class="card-body text-sm text-muted">Runbook envelopes: ${(data.runbooks || []).length} · update plans: ${(data.updates || []).length} (${summary.blockedUpdates || 0} blocked).</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Air-gap bootstrap &amp; content</h3></div><table class="data-table"><thead><tr><th>Type / name</th><th>Content</th><th>State</th></tr></thead><tbody>
          ${(data.bootstraps || []).map(item => `<tr><td>Bootstrap · ${Utils.escapeHtml(item.name)}<div class="mono text-xs">${item.manifestHash.slice(0,12)}</div></td><td>${item.artifacts.length} artifacts · ${Utils.escapeHtml(item.version)}</td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td></tr>`).join('')}
          ${(data.mirrors || []).map(item => `<tr><td>Mirror · ${Utils.escapeHtml(item.name)}<div class="mono text-xs">${item.manifestHash.slice(0,12)}</div></td><td>${item.items.length} items · ${Utils.formatBytes ? Utils.formatBytes(item.totalBytes) : item.totalBytes}</td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td></tr>`).join('') || (!(data.bootstraps || []).length ? this._empty('No verified offline manifests', 3) : '')}
        </tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Read cache provenance</h3></div><table class="data-table"><thead><tr><th>Resource</th><th>Observed / expiry</th><th>State</th></tr></thead><tbody>
          ${(data.cache || []).slice(0,50).map(item => `<tr><td>${Utils.escapeHtml(item.resourceKind)} · ${Utils.escapeHtml(item.resourceRef)}<div class="text-xs text-muted">${Utils.escapeHtml(item.providerRef)}</div></td><td>${new Date(item.observedAt).toLocaleString()}<div class="text-xs text-muted">expires ${new Date(item.expiresAt).toLocaleString()}</div></td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td></tr>`).join('') || this._empty('No cached provider evidence', 3)}
        </tbody></table></div>
      </div>`;
    this._container.querySelector('#edge-refresh')?.addEventListener('click', () => this.render(this._container));
    this._container.querySelectorAll('[data-edge-action]').forEach(button => button.addEventListener('click', () => this._dialog(button.dataset.edgeAction)));
  },

  _stat(icon, label, value) { return `<div class="info-item"><div class="info-label"><i class="fas ${icon}" style="margin-right:5px"></i>${label}</div><div class="info-value">${value}</div></div>`; },
  _empty(text, colspan) { return `<tr><td colspan="${colspan}" class="text-muted">${text}</td></tr>`; },

  async _dialog(action) {
    const now = Date.now(); const digestA = `sha256:${'a'.repeat(64)}`; const digestB = `sha256:${'b'.repeat(64)}`;
    const examples = {
      site: { slug: 'bucharest-edge', name: 'Bucharest edge', timezone: 'Europe/Bucharest', region: 'ro-bucharest', jurisdiction: 'EU/RO', localOwner: 'platform-team', trustRoots: ['signer/platform-release'], hosts: [], status: 'active' },
      connectivity: { siteId: 1, mode: 'intermittent', maxStalenessSeconds: 900, cacheTtlSeconds: 86400, mutationMode: 'queue', expectedOfflineUntil: new Date(now + 3600000).toISOString() },
      cache: { siteId: 1, providerRef: 'cluster/edge-a', resourceKind: 'node', resourceRef: 'node/edge-a', observedAt: new Date().toISOString(), payload: { state: 'ready', cpu: 4, memoryGiB: 16 } },
      intent: { siteId: 1, actionKey: 'service.restart', targetRef: 'service/local-api', payload: { serviceRef: 'local-api' }, prerequisites: ['site_reconnected','service_identity_unchanged'], expiresAt: new Date(now + 86400000).toISOString() },
      revalidate: { intentId: 1, checks: [{ prerequisite: 'site_reconnected', outcome: 'pass', evidenceRef: 'heartbeat/42' }, { prerequisite: 'service_identity_unchanged', outcome: 'pass', evidenceRef: 'inventory/42' }] },
      agent: { siteId: 1, agentId: 'edge-a', certificateFingerprint: digestA, runbookAllowlist: ['collect_inventory','restart_managed_service','network_diagnostics'], updateRing: 'canary', state: 'active' },
      heartbeat: { siteId: 1, agentId: 'edge-a', sequence: 1, status: 'healthy', version: '1.0.0', capabilities: ['inventory','events','runbooks'], observedAt: new Date().toISOString() },
      'sync-policy': { siteId: 1, bandwidthKbps: 1024, maxBatchBytes: 5242880, priorityOrder: ['inventory','event','metric','artifact'] },
      events: { siteId: 1, agentId: 'edge-a', events: [{ eventId: `inventory-${now}`, category: 'inventory', occurredAt: new Date().toISOString(), payload: { resources: 12, health: 'ready' } }, { eventId: `metric-${now}`, category: 'metric', occurredAt: new Date().toISOString(), payload: { cpuPercent: 24 } }] },
      'sync-plan': { siteId: 1, maxBytes: 5242880 },
      ack: { planId: 1, planHash: 'copy exact planHash from the table/API response' },
      runbook: { agentRecordId: 1, runbookKey: 'collect_inventory', targetRef: 'site/bucharest-edge', parameters: { scope: 'all' }, expiresAt: new Date(now + 3600000).toISOString() },
      update: { agentRecordId: 1, targetVersion: '1.1.0', bundle: { digest: digestA, localRef: 'mirror/agent-1.1.0', signatureIdentity: 'signer/platform-release', signatureVerified: true }, rollback: { version: '1.0.0', digest: digestB, localRef: 'mirror/agent-1.0.0' } },
      bootstrap: { siteId: 1, name: 'edge-bootstrap', version: '1.0.0', expiresAt: new Date(now + 7 * 86400000).toISOString(), artifacts: [{ kind: 'certificate', name: 'site-ca', version: '1.0.0', digest: digestA, localRef: 'bundle/certs/site-ca.pem', byteSize: 2048, signatureIdentity: 'signer/platform-release', signatureVerified: true }, { kind: 'docs', name: 'operations-guide', version: '1.0.0', digest: digestB, localRef: 'bundle/docs/operations.pdf', byteSize: 4096, signatureIdentity: 'signer/platform-release', signatureVerified: true }] },
      mirror: { siteId: 1, name: 'site-content', sourceMirrorRef: 'airgap/site-a', items: [{ kind: 'oci', name: 'docker-dash', version: '8.65.0', digest: digestA, localRef: 'oci/docker-dash/8.65.0', byteSize: 524288000, signatureIdentity: 'signer/platform-release', signatureVerified: true }] },
    };
    const result = await Modal.form(`<p class="text-muted text-sm">Only references and bounded evidence are accepted. Inline credentials/private keys are rejected.</p><textarea id="edge-action-json" class="form-control mono" rows="24">${Utils.escapeHtml(JSON.stringify(examples[action], null, 2))}</textarea>`, {
      title: `Edge platform · ${action}`, width: '900px', confirmText: action === 'ack' ? 'Acknowledge exact plan' : 'Validate and save',
      onSubmit: async content => {
        let body; try { body = JSON.parse(content.querySelector('#edge-action-json').value); } catch { Toast.error('JSON is invalid'); return false; }
        try {
          if (action === 'site') return Api.saveEdgeSite(body);
          if (action === 'connectivity') return Api.saveEdgeConnectivity(body.siteId, body);
          if (action === 'cache') return Api.recordEdgeCache(body.siteId, body);
          if (action === 'intent') return Api.createEdgeIntent(body.siteId, body);
          if (action === 'revalidate') return Api.revalidateEdgeIntent(body.intentId, body);
          if (action === 'agent') return Api.saveEdgeAgent(body.siteId, body);
          if (action === 'heartbeat') return Api.recordEdgeHeartbeat(body.siteId, body);
          if (action === 'sync-policy') return Api.saveEdgeSyncPolicy(body.siteId, body);
          if (action === 'events') return Api.bufferEdgeEvents(body.siteId, body);
          if (action === 'sync-plan') return Api.createEdgeSyncPlan(body.siteId, body);
          if (action === 'ack') return Api.acknowledgeEdgeSyncPlan(body.planId, body);
          if (action === 'runbook') return Api.createEdgeRunbook(body.agentRecordId, body);
          if (action === 'update') return Api.createEdgeUpdatePlan(body.agentRecordId, body);
          if (action === 'bootstrap') return Api.createEdgeBootstrap(body.siteId, body);
          return Api.createEdgeMirror(body.siteId, body);
        } catch (error) { Toast.error(error.message); return false; }
      },
    });
    if (result) { Toast.success(`${action} evidence saved`); await this.render(this._container); }
  },
};

window.EdgePlatformPage = EdgePlatformPage;
