/* Edge, ROBO and disconnected operations — B326-B350 */
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
    const stateBadge = state => ['healthy','ready','active','allowed','compliant','acknowledged','ready_for_agent','ready_for_edge_agent','ready_for_local_operator'].includes(state) ? 'badge-success'
      : ['blocked','offline','expired','revalidation_required','non_compliant','at_risk','disaster'].includes(state) ? 'badge-danger' : 'badge-warning';
    this._container.innerHTML = `<div class="page-header"><div><h1 class="page-title"><i class="fas fa-tower-broadcast" style="color:var(--accent);margin-right:10px"></i>Edge &amp; disconnected</h1>
      <p class="page-subtitle">Sovereign, resilient operations for ROBO, low-bandwidth and air-gapped sites.</p></div>
      <button class="btn btn-secondary" id="edge-refresh"><i class="fas fa-rotate"></i> Refresh</button></div>
      <div class="alert alert-info">Central execution remains disabled. Residency is fail-closed; cached identity returns no token; secrets resolve only at the edge. Remote-hands and BMC recovery require independent approval and create local JIT envelopes.</div>
      <div class="info-grid">
        ${this._stat('fa-location-dot','Sites',summary.sites || 0)}${this._stat('fa-signal','Healthy',summary.online || 0)}
        ${this._stat('fa-plug-circle-xmark','Expected offline',summary.expectedDisconnected || 0)}${this._stat('fa-clock-rotate-left','Stale cache',summary.staleCache || 0)}
        ${this._stat('fa-list-check','Queued intents',summary.queuedIntents || 0)}${this._stat('fa-box','Buffered events',summary.pendingEvents || 0)}
        ${this._stat('fa-shield-halved','Blocked transfers',summary.blockedResidency || 0)}${this._stat('fa-key','Active grants',summary.activeIdentityGrants || 0)}
        ${this._stat('fa-scale-balanced','Quorum risks',summary.atRiskQuorum || 0)}${this._stat('fa-screwdriver-wrench','Remote-hands pending',summary.pendingRemoteHands || 0)}
        ${this._stat('fa-microchip','Critical BMC',summary.criticalBmc || 0)}${this._stat('fa-power-off','Recovery ready',summary.readyBmcRecovery || 0)}
        ${this._stat('fa-triangle-exclamation','Active disasters',summary.activeDisasters || 0)}${this._stat('fa-hard-drive','Ready backup seeds',summary.readyBackupSeeds || 0)}
        ${this._stat('fa-clipboard-check','Non-compliant sites',summary.nonCompliantSites || 0)}${this._stat('fa-network-wired','Topology risks',summary.atRiskFaultDomains || 0)}
        ${this._stat('fa-certificate','Pending enrollments',summary.pendingEnrollments || 0)}
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin:14px 0">
        ${[['site','Site'],['connectivity','Connectivity'],['cache','Cache evidence'],['intent','Offline intent'],['revalidate','Revalidate'],['agent','Agent'],['heartbeat','Heartbeat'],['sync-policy','Sync policy'],['events','Buffer events'],['sync-plan','Sync plan'],['ack','Acknowledge'],['runbook','Runbook envelope'],['update','Update plan'],['bootstrap','Bootstrap'],['mirror','Mirror'],['residency-policy','Residency policy'],['residency-check','Residency check'],['identity-policy','Identity policy'],['identity-grant','Identity grant'],['identity-activate','Activate grant'],['vault','Local vault'],['secret-plan','Secret plan'],['single-profile','Single-node'],['single-assess','Single assess'],['quorum','Quorum'],['reservation-policy','Reservations'],['reservation-assess','Reserve assess'],['console','Console'],['remote-hands','Remote hands'],['remote-authorize','Authorize hands'],['bmc','BMC endpoint'],['bmc-inventory','BMC inventory'],['bmc-recovery','BMC recovery'],['bmc-authorize','Authorize BMC'],['disaster','Declare disaster'],['disaster-resolve','Resolve disaster'],['backup-seed','Backup seed'],['backup-checkpoint','Seed checkpoint'],['compliance-profile','Compliance profile'],['compliance-snapshot','Compliance snapshot'],['fault-domain','Fault domain'],['fault-assess','Assess domains'],['enrollment-token','Enrollment token'],['enrollment-approve','Approve enrollment']].map(([key,label], index) => `<button class="btn btn-sm ${index === 0 ? 'btn-primary' : 'btn-secondary'}" data-edge-action="${key}">${label}</button>`).join('')}
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
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Sovereignty &amp; disconnected identity</h3></div><table class="data-table"><thead><tr><th>Control</th><th>Scope</th><th>State</th></tr></thead><tbody>
          ${(data.residencyPolicies || []).map(item => `<tr><td>Residency · site #${item.siteId}<div class="mono text-xs">${item.policyHash.slice(0,12)}</div></td><td>${Utils.escapeHtml(item.zone)} · ${Object.keys(item.categoryRules).length} categories</td><td><span class="badge badge-success">fail closed</span></td></tr>`).join('')}
          ${(data.identityGrants || []).slice(0,25).map(item => `<tr><td>Identity · ${Utils.escapeHtml(item.subjectRef)}<div class="mono text-xs">${item.grantHash.slice(0,12)}</div></td><td>${Utils.escapeHtml(item.mode)} · ${item.scopes.length} scopes</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('')}
          ${(data.vaultAdapters || []).map(item => `<tr><td>Vault · ${Utils.escapeHtml(item.name)}<div class="text-xs text-muted">${Utils.escapeHtml(item.providerKind)}</div></td><td>${Utils.escapeHtml(item.endpointRef)}</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('') || this._empty('No sovereignty or identity controls', 3)}
        </tbody></table><div class="card-body text-sm text-muted">Secrets stored centrally: never · bearer tokens returned: never · secret resolution plans: ${(data.secretPlans || []).length}.</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Small-cluster resilience</h3></div><table class="data-table"><thead><tr><th>Evidence</th><th>Result</th><th>Safety boundary</th></tr></thead><tbody>
          ${(data.singleNodeAssessments || []).slice(0,25).map(item => `<tr><td>Single-node · site #${item.siteId}<div class="mono text-xs">${item.assessmentHash.slice(0,12)}</div></td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td><td>HA unavailable · no apply</td></tr>`).join('')}
          ${(data.quorum || []).slice(0,25).map(item => `<tr><td>Quorum · ${Utils.escapeHtml(item.clusterRef)}<div class="text-xs text-muted">${item.availableVotes}/${item.requiredVotes} votes</div></td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td><td>${Utils.escapeHtml(item.risks.join(', ') || 'no recorded risk')}</td></tr>`).join('')}
          ${(data.reservations || []).slice(0,25).map(item => `<tr><td>Reservations · site #${item.siteId}<div class="mono text-xs">${item.assessmentHash.slice(0,12)}</div></td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td><td>assessment only</td></tr>`).join('') || this._empty('No topology or reservation evidence', 3)}
        </tbody></table><div class="card-body text-sm text-muted">Low-bandwidth console profiles: ${(data.consoleProfiles || []).length}; serial/text first, clipboard and file transfer disabled.</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Remote hands &amp; out-of-band recovery</h3></div><table class="data-table"><thead><tr><th>Plan / endpoint</th><th>Owner / action</th><th>State</th></tr></thead><tbody>
          ${(data.bmcEndpoints || []).map(item => `<tr><td>BMC · ${Utils.escapeHtml(item.name)}<div class="text-xs text-muted">${Utils.escapeHtml(item.protocol)} · host #${item.hostId}</div></td><td>${Utils.escapeHtml(item.owner)}</td><td><span class="badge ${stateBadge(item.state)}">${item.state}</span></td></tr>`).join('')}
          ${(data.remoteHands || []).slice(0,25).map(item => `<tr><td>Hands · ${Utils.escapeHtml(item.targetRef)}<div class="mono text-xs">approval #${item.approvalId}</div></td><td>${item.checklist.length} checks</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('')}
          ${(data.bmcRecovery || []).slice(0,25).map(item => `<tr><td>Recovery · endpoint #${item.endpointId}<div class="mono text-xs">${item.planHash.slice(0,12)}</div></td><td>${Utils.escapeHtml(item.actionKey)}</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('') || this._empty('No BMC or remote-hands plans', 3)}
        </tbody></table><div class="card-body text-sm text-muted">Inventory snapshots: ${(data.bmcInventory || []).length}. Recovery executes only at the edge after independent approval.</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Disaster freeze &amp; offline backup seeding</h3></div><table class="data-table"><thead><tr><th>Evidence</th><th>Scope</th><th>State</th></tr></thead><tbody>
          ${(data.disasters || []).slice(0,25).map(item => `<tr><td>Disaster #${item.id}<div class="text-xs text-muted">${Utils.escapeHtml(item.ticketRef)} · ${Utils.escapeHtml(item.reason)}</div></td><td>site #${item.siteId} · ${Utils.escapeHtml(item.severity)}</td><td><span class="badge ${item.state === 'active' ? 'badge-danger' : 'badge-success'}">${Utils.escapeHtml(item.state)}</span><div class="text-xs text-muted">mutation freeze ${item.state === 'active' ? 'on' : 'released'}</div></td></tr>`).join('')}
          ${(data.backupSeeds || []).slice(0,25).map(item => `<tr><td>Seed #${item.id}<div class="text-xs text-muted">${Utils.escapeHtml(item.datasetRef)} · ${item.chunks.length} chunks</div></td><td>${Utils.formatBytes ? Utils.formatBytes(item.totalBytes) : item.totalBytes} · offline media</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('') || this._empty('No disaster or seed evidence', 3)}
        </tbody></table><div class="card-body text-sm text-muted">Notifications are queued locally; backup bytes never traverse this API.</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Fleet compliance &amp; fault domains</h3></div><table class="data-table"><thead><tr><th>Site / domain</th><th>Evidence</th><th>State</th></tr></thead><tbody>
          ${(data.compliance?.sites || []).map(item => `<tr><td>${Utils.escapeHtml(item.siteName)}<div class="mono text-xs">${Utils.escapeHtml(item.siteSlug)}</div></td><td>${item.passedCount} pass · ${item.failedCount} fail · ${item.unknownCount} unknown</td><td><span class="badge ${stateBadge(item.posture)}">${Utils.escapeHtml(item.posture)}</span></td></tr>`).join('')}
          ${(data.faultDomains || []).map(item => `<tr><td>${Utils.escapeHtml(item.domainType)} · ${Utils.escapeHtml(item.name)}<div class="mono text-xs">${Utils.escapeHtml(item.domainKey)}</div></td><td>${item.hostCount} host(s) · ${Utils.escapeHtml(item.owner)}</td><td><span class="badge badge-success">mapped</span></td></tr>`).join('')}
          ${(data.faultAssessments || []).slice(0,25).map(item => `<tr><td>${Utils.escapeHtml(item.workloadRef)}</td><td>${item.requiredReplicas} replicas · ${Utils.escapeHtml(item.risks.join(', ') || 'separated')}</td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('') || this._empty('No aggregate compliance or topology evidence', 3)}
        </tbody></table><div class="card-body text-sm text-muted">Raw compliance evidence is withheld; topology assessment never changes placement.</div></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Zero-touch enrollment attestations</h3></div><table class="data-table"><thead><tr><th>Agent</th><th>Hardware identity</th><th>State</th></tr></thead><tbody>
          ${(data.enrollments || []).map(item => `<tr><td>${Utils.escapeHtml(item.agentId)}<div class="mono text-xs">attestation #${item.id} · site #${item.siteId}</div></td><td>${Utils.escapeHtml(item.hardwareClaims?.manufacturer || '')} ${Utils.escapeHtml(item.hardwareClaims?.model || '')}<div class="text-xs text-muted">${Utils.escapeHtml(item.hardwareClaims?.serialNumber || '')}</div></td><td><span class="badge ${stateBadge(item.state)}">${Utils.escapeHtml(item.state)}</span></td></tr>`).join('') || this._empty('No enrollment attestations', 3)}
        </tbody></table><div class="card-body text-sm text-muted">Tokens are single-use; agents generate their own key pair and only public fingerprints are retained.</div></div>
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
      agent: { siteId: 1, agentId: 'edge-a', certificateFingerprint: digestA, runbookAllowlist: ['collect_inventory','restart_managed_service','network_diagnostics','disaster_assessment'], updateRing: 'canary', state: 'active' },
      heartbeat: { siteId: 1, agentId: 'edge-a', sequence: 1, status: 'healthy', version: '1.0.0', capabilities: ['inventory','events','runbooks'], observedAt: new Date().toISOString() },
      'sync-policy': { siteId: 1, bandwidthKbps: 1024, maxBatchBytes: 5242880, priorityOrder: ['inventory','event','metric','artifact'] },
      events: { siteId: 1, agentId: 'edge-a', events: [{ eventId: `inventory-${now}`, category: 'inventory', occurredAt: new Date().toISOString(), payload: { resources: 12, health: 'ready' } }, { eventId: `metric-${now}`, category: 'metric', occurredAt: new Date().toISOString(), payload: { cpuPercent: 24 } }] },
      'sync-plan': { siteId: 1, maxBytes: 5242880, destinationJurisdiction: 'EU/RO' },
      ack: { planId: 1, planHash: 'copy exact planHash from the table/API response' },
      runbook: { agentRecordId: 1, runbookKey: 'collect_inventory', targetRef: 'site/bucharest-edge', parameters: { scope: 'all' }, expiresAt: new Date(now + 3600000).toISOString() },
      update: { agentRecordId: 1, targetVersion: '1.1.0', bundle: { digest: digestA, localRef: 'mirror/agent-1.1.0', signatureIdentity: 'signer/platform-release', signatureVerified: true }, rollback: { version: '1.0.0', digest: digestB, localRef: 'mirror/agent-1.0.0' } },
      bootstrap: { siteId: 1, name: 'edge-bootstrap', version: '1.0.0', expiresAt: new Date(now + 7 * 86400000).toISOString(), artifacts: [{ kind: 'certificate', name: 'site-ca', version: '1.0.0', digest: digestA, localRef: 'bundle/certs/site-ca.pem', byteSize: 2048, signatureIdentity: 'signer/platform-release', signatureVerified: true }, { kind: 'docs', name: 'operations-guide', version: '1.0.0', digest: digestB, localRef: 'bundle/docs/operations.pdf', byteSize: 4096, signatureIdentity: 'signer/platform-release', signatureVerified: true }] },
      mirror: { siteId: 1, name: 'site-content', sourceMirrorRef: 'airgap/site-a', items: [{ kind: 'oci', name: 'docker-dash', version: '8.66.0', digest: digestA, localRef: 'oci/docker-dash/8.66.0', byteSize: 524288000, signatureIdentity: 'signer/platform-release', signatureVerified: true }] },
      'residency-policy': { siteId: 1, zone: 'EU/RO', categoryRules: { inventory: ['EU/RO'], logs: ['EU/RO'], metrics: ['EU/RO'], backups: ['EU/RO'] } },
      'residency-check': { siteId: 1, dataCategory: 'logs', destinationJurisdiction: 'EU/RO' },
      'identity-policy': { siteId: 1, issuerRef: 'oidc/romprix', normalTtlSeconds: 600, emergencyTtlSeconds: 180, normalScopes: ['inventory.read','events.write','health.write'], emergencyScopes: ['inventory.read','health.write'] },
      'identity-grant': { siteId: 1, subjectRef: 'user/local-operator', assertionHash: digestA, scopes: ['inventory.read'], mode: 'emergency', ttlSeconds: 120, reason: 'WAN outage', ticketRef: 'INC-0001' },
      'identity-activate': { grantId: 1, grantHash: 'copy exact grantHash', confirmation: 'user/local-operator' },
      vault: { siteId: 1, name: 'site-vault', providerKind: 'hashicorp_vault', endpointRef: 'https://vault.edge.internal', namespaceRef: 'sites/bucharest', authMethod: 'mtls', certificateFingerprint: digestA, allowedPurposes: ['bmc.power','backup.read'] },
      'secret-plan': { adapterId: 1, agentRecordId: 1, secretRef: 'kv/bmc/edge-node', purpose: 'bmc.power', expiresAt: new Date(now + 180000).toISOString() },
      'single-profile': { siteId: 1, minimumCpuMillicores: 1000, minimumMemoryMiB: 2048, minimumStorageGiB: 20 },
      'single-assess': { siteId: 1, nodeCount: 1, cpuMillicores: 4000, memoryMiB: 8192, storageGiB: 100, externalBackupVerified: true, maintenanceWindowDeclared: true },
      quorum: { siteId: 1, clusterRef: 'cluster/edge-a', observedAt: new Date().toISOString(), members: [{ memberRef: 'node/a', role: 'voter', healthy: true, failureDomain: 'rack/a' }, { memberRef: 'node/b', role: 'voter', healthy: true, failureDomain: 'rack/b' }, { memberRef: 'witness/c', role: 'witness', healthy: true, failureDomain: 'cloud/eu' }] },
      'reservation-policy': { siteId: 1, systemCpuMillicores: 500, systemMemoryMiB: 1024, systemStorageGiB: 10, maxWorkloadPercent: 75, evictionFreeStoragePercent: 15 },
      'reservation-assess': { siteId: 1, capacity: { cpuMillicores: 4000, memoryMiB: 8192, storageGiB: 100 }, workload: { cpuMillicores: 2500, memoryMiB: 5000, storageGiB: 70 } },
      console: { siteId: 1, transportOrder: ['serial','text','html5'], maxBandwidthKbps: 128, maxFps: 5, colorDepth: 8, adaptiveQuality: true, idleTtlSeconds: 300 },
      'remote-hands': { siteId: 1, targetRef: 'host/edge-node', bmcEndpointId: 1, checklist: ['Confirm asset label', 'Connect serial console', 'Photograph status LEDs'], consoleRef: 'serial/rack-a', expiresAt: new Date(now + 3600000).toISOString(), assigneeUserId: 2 },
      'remote-authorize': { planId: 1, approvalId: 1, confirmation: 'host/edge-node' },
      bmc: { siteId: 1, hostId: 1, name: 'edge-node-bmc', protocol: 'redfish', endpointRef: 'redfish/edge-node', vaultAdapterId: 1, credentialRef: 'kv/bmc/edge-node', certificateFingerprint: digestA, owner: 'local-operations' },
      'bmc-inventory': { endpointId: 1, powerState: 'on', manufacturer: 'Dell', model: 'R650', serialNumber: 'ABC123', firmware: { bios: '2.4.1', bmc: '6.10' }, sensors: { temperature: { state: 'ok', celsius: 31 } }, health: 'ok', observedAt: new Date().toISOString() },
      'bmc-recovery': { endpointId: 1, actionKey: 'power_cycle', safeguards: { targetIdentityMatched: true, fencingVerified: true, quorumSafe: true, workloadsEvacuated: true, recentBackupVerified: true }, reason: 'Frozen host after approved maintenance', ticketRef: 'INC-0002', expiresAt: new Date(now + 600000).toISOString(), assigneeUserId: 2 },
      'bmc-authorize': { planId: 1, approvalId: 1, confirmation: 'redfish/edge-node' },
      disaster: { siteId: 1, agentRecordId: 1, severity: 'critical', reason: 'Site-wide storage and power incident', ticketRef: 'INC-0003', notifications: [{ channel: 'local_banner', recipientRef: 'site/bucharest-edge' }, { channel: 'email', recipientRef: 'oncall/platform' }], runbookExpiresAt: new Date(now + 3600000).toISOString() },
      'disaster-resolve': { declarationId: 1, confirmation: 'bucharest-edge', evidence: { ticketRef: 'INC-0003', verification: 'Power, storage and provider inventory verified locally' } },
      'backup-seed': { siteId: 1, datasetRef: 'site/bucharest-edge', baseBackupRef: 'backup/full-20260729', baseBackupDigest: digestA, encryptionKeyRef: 'vault/backup/site-a', mediaRef: 'offline-media/SSD-001', chunks: [{ index: 0, digest: digestB, bytes: 1048576, verified: true }], expiresAt: new Date(now + 7 * 86400000).toISOString() },
      'backup-checkpoint': { seedId: 1, sequence: 1, completedChunk: 0, transferredBytes: 1048576, continuationCursor: 'chunk/0/complete', rollingDigest: digestB, mediaIdentityHash: digestA },
      'compliance-profile': { siteId: 1, requiredControls: ['agent_version','connectivity','residency','backup','quorum','bmc_firmware'], maximumUnknown: 0 },
      'compliance-snapshot': { siteId: 1, observedAt: new Date().toISOString(), controls: ['agent_version','connectivity','residency','backup','quorum','bmc_firmware'].map(control => ({ control, state: 'pass', evidenceDigest: digestA })) },
      'fault-domain': { siteId: 1, domainType: 'rack', domainKey: 'rack-a', name: 'Rack A', owner: 'local-operations', metadata: { room: 'MDF-1' }, hostIds: [1] },
      'fault-assess': { siteId: 1, workloadRef: 'workload/local-api', hostIds: [1], requiredReplicas: 1 },
      'enrollment-token': { siteId: 1, expectedHardware: { manufacturer: 'Dell', model: 'R650', serialNumber: 'ABC123', tpmEkHash: digestA }, runbookAllowlist: ['collect_inventory','network_diagnostics'], updateRing: 'canary', ttlSeconds: 600 },
      'enrollment-approve': { attestationId: 1, attestationHash: 'copy exact attestationHash', confirmation: 'edge-node-a', certificateFingerprint: digestA },
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
          if (action === 'mirror') return Api.createEdgeMirror(body.siteId, body);
          if (action === 'residency-policy') return Api.saveEdgeResidencyPolicy(body.siteId, body);
          if (action === 'residency-check') return Api.evaluateEdgeResidency(body.siteId, body);
          if (action === 'identity-policy') return Api.saveEdgeIdentityPolicy(body.siteId, body);
          if (action === 'identity-grant') return Api.issueEdgeIdentityGrant(body.siteId, body);
          if (action === 'identity-activate') return Api.activateEdgeIdentityGrant(body.grantId, body);
          if (action === 'vault') return Api.saveEdgeVaultAdapter(body.siteId, body);
          if (action === 'secret-plan') return Api.createEdgeSecretResolution(body.adapterId, body);
          if (action === 'single-profile') return Api.saveEdgeSingleNodeProfile(body.siteId, body);
          if (action === 'single-assess') return Api.assessEdgeSingleNode(body.siteId, body);
          if (action === 'quorum') return Api.recordEdgeQuorum(body.siteId, body);
          if (action === 'reservation-policy') return Api.saveEdgeReservationPolicy(body.siteId, body);
          if (action === 'reservation-assess') return Api.assessEdgeReservations(body.siteId, body);
          if (action === 'console') return Api.saveEdgeConsoleProfile(body.siteId, body);
          if (action === 'remote-hands') return Api.createEdgeRemoteHands(body.siteId, body);
          if (action === 'remote-authorize') return Api.authorizeEdgeRemoteHands(body.planId, body);
          if (action === 'bmc') return Api.saveEdgeBmcEndpoint(body.siteId, body);
          if (action === 'bmc-inventory') return Api.recordEdgeBmcInventory(body.endpointId, body);
          if (action === 'bmc-recovery') return Api.createEdgeBmcRecovery(body.endpointId, body);
          if (action === 'disaster') return Api.declareEdgeDisaster(body.siteId, body);
          if (action === 'disaster-resolve') return Api.resolveEdgeDisaster(body.declarationId, body);
          if (action === 'backup-seed') return Api.createEdgeBackupSeed(body.siteId, body);
          if (action === 'backup-checkpoint') return Api.recordEdgeBackupCheckpoint(body.seedId, body);
          if (action === 'compliance-profile') return Api.saveEdgeComplianceProfile(body.siteId, body);
          if (action === 'compliance-snapshot') return Api.recordEdgeComplianceSnapshot(body.siteId, body);
          if (action === 'fault-domain') return Api.saveEdgeFaultDomain(body.siteId, body);
          if (action === 'fault-assess') return Api.assessEdgeFaultDomains(body.siteId, body);
          if (action === 'enrollment-token') return Api.createEdgeEnrollmentToken(body.siteId, body);
          if (action === 'enrollment-approve') return Api.approveEdgeEnrollment(body.attestationId, body);
          return Api.authorizeEdgeBmcRecovery(body.planId, body);
        } catch (error) { Toast.error(error.message); return false; }
      },
    });
    if (result?.enrollment?.token) {
      await new Promise(resolve => setTimeout(resolve, 250));
      await Modal.confirm(`<p>This one-time token will not be shown again.</p><textarea class="form-control mono" rows="3" readonly>${Utils.escapeHtml(result.enrollment.token)}</textarea>`, {
        title: 'Copy enrollment token now', confirmText: 'I copied the token', html: true, width: '620px',
      });
    }
    if (result) { Toast.success(`${action} evidence saved`); await this.render(this._container); }
  },
};

window.EdgePlatformPage = EdgePlatformPage;
