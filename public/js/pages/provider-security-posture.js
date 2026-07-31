/* Provider SDK security evidence and governed compliance controls. */
'use strict';

const ProviderSecurityPosturePage = {
  _hosts: [], _hostId: null, _container: null, _assurance: null, _securityLifecycle: null,
  _privilegedCompliance: null, _operationalQualifications: [],
  _isAdmin() { return App.user?.role === 'admin' || App.user?.roles?.includes('admin'); },
  _badge(state) { return { supported: 'badge-success', conditional: 'badge-warning', unsupported: 'badge-secondary' }[state] || 'badge-secondary'; },
  _coverageHtml(result) {
    const s = result.coverage?.states || {};
    return `<div class="card" style="padding:16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong><i class="fas fa-shield-alt" aria-hidden="true"></i> Provider capability coverage</strong><div class="text-muted text-sm">Declared SDK contract evidence, not a security scan or compliance verdict.</div></div><span class="badge badge-secondary">read-only</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${result.coverage?.declaredFeatureCount ?? 0}</div><div class="stat-label">Declared features</div></div>${['supported', 'conditional', 'unsupported'].map(state => `<div class="stat-card"><div class="stat-value"><span class="badge ${this._badge(state)}">${s[state] ?? 0}</span></div><div class="stat-label">${state}</div></div>`).join('')}</div></div>`;
  },
  _safeguardsHtml(result) { const s = result.safeguards || {}; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Privileged-operation safeguards</strong><div class="text-muted text-sm">Declared contract controls only; no operation is attempted or authorized here.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${s.declaredPrivilegedFeatureCount ?? 0}</div><div class="stat-label">Guarded features</div></div><div class="stat-card"><div class="stat-value">${s.approvalRequired ?? 0}</div><div class="stat-label">Four-eyes</div></div><div class="stat-card"><div class="stat-value">${s.typedConfirmation ?? 0}</div><div class="stat-label">Typed confirmation</div></div><div class="stat-card"><div class="stat-value">${s.revalidation ?? 0}</div><div class="stat-label">Revalidation</div></div><div class="stat-card"><div class="stat-value">${s.postVerification ?? 0}</div><div class="stat-label">Post-verification</div></div><div class="stat-card"><div class="stat-value">${s.durableTasks ?? 0}</div><div class="stat-label">Durable tasks</div></div></div></div>`; },
  _recoveryHtml(result) { const s = result.recovery || {}; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Backup and recovery control evidence</strong><div class="text-muted text-sm">Declared recovery properties, not proof that a backup is restorable or a drill has run.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${s.declaredFeatureCount ?? 0}</div><div class="stat-label">Recovery features</div></div><div class="stat-card"><div class="stat-value">${s.durableTasks ?? 0}</div><div class="stat-label">Durable tasks</div></div><div class="stat-card"><div class="stat-value">${s.createOnlyRestore ?? 0}</div><div class="stat-label">Create-only restore</div></div><div class="stat-card"><div class="stat-value">${s.isolatedDrills ?? 0}</div><div class="stat-label">Isolated drills</div></div><div class="stat-card"><div class="stat-value">${s.retentionMutationDisabled ?? 0}</div><div class="stat-label">Retention locked</div></div></div></div>`; },
  _consoleHtml(result) { const s = result.consoleExposure || {}; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Console exposure safeguards</strong><div class="text-muted text-sm">Declared console-gateway controls, not proof of a live console session or endpoint hardening.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(s.state || 'unknown')}</div><div class="stat-label">Capability state</div></div><div class="stat-card"><div class="stat-value">${s.singleUseToken ? 'yes' : '—'}</div><div class="stat-label">Single-use token</div></div><div class="stat-card"><div class="stat-value">${s.credentialIsolation ? 'server-side' : '—'}</div><div class="stat-label">Credential isolation</div></div><div class="stat-card"><div class="stat-value">${s.emergencyLock ? 'yes' : '—'}</div><div class="stat-label">Emergency lock</div></div></div></div>`; },
  _tasksHtml(result) { const s = result.taskAssurance || {}; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Native task assurance evidence</strong><div class="text-muted text-sm">Declared task-contract properties only; no task is listed, started, cancelled, or reconciled.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${s.declaredTaskFeatures ?? 0}</div><div class="stat-label">Task features</div></div><div class="stat-card"><div class="stat-value">${s.durable ?? 0}</div><div class="stat-label">Durable</div></div><div class="stat-card"><div class="stat-value">${s.cancellable ?? 0}</div><div class="stat-label">Cancellable</div></div><div class="stat-card"><div class="stat-value">${s.postVerified ?? 0}</div><div class="stat-label">Post-verified</div></div><div class="stat-card"><div class="stat-value">${s.revalidated ?? 0}</div><div class="stat-label">Revalidated</div></div></div></div>`; },
  _networkHtml(result) { const s = result.networkGuardrails || {}; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Network-change guardrail evidence</strong><div class="text-muted text-sm">Declared evidence boundaries; this does not validate VLAN safety, routing, firewall policy, or fabric isolation.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${s.declaredFeatureCount ?? 0}</div><div class="stat-label">Network features</div></div><div class="stat-card"><div class="stat-value">${s.readOnlyEvidence ?? 0}</div><div class="stat-label">Read-only evidence</div></div><div class="stat-card"><div class="stat-value">${s.boundedEvidence ?? 0}</div><div class="stat-label">Bounded reads</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(s.mutationState || 'unknown')}</div><div class="stat-label">Network mutation</div></div></div></div>`; },
  _lifecycleHtml(result) { const s = result.lifecycleGuardrails || {}; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Workload lifecycle guardrail evidence</strong><div class="text-muted text-sm">Declared VM power, snapshot, clone/create and customization safeguards; no VM operation is attempted.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${s.declaredFeatureCount ?? 0}</div><div class="stat-label">Lifecycle features</div></div><div class="stat-card"><div class="stat-value">${s.durableTasks ?? 0}</div><div class="stat-label">Durable tasks</div></div><div class="stat-card"><div class="stat-value">${s.confirmationRequired ?? 0}</div><div class="stat-label">Confirmation</div></div><div class="stat-card"><div class="stat-value">${s.postVerified ?? 0}</div><div class="stat-label">Post-verified</div></div><div class="stat-card"><div class="stat-value">${s.revalidated ?? 0}</div><div class="stat-label">Revalidated</div></div></div></div>`; },
  _gapsHtml(result) { const s = result.gapRegister || {}; return `<details class="card" style="padding:16px;margin-bottom:16px"><summary style="cursor:pointer"><strong>Unsupported capability gap register</strong> <span class="badge badge-secondary">${s.unsupportedCount ?? 0}</span></summary><div class="text-muted text-sm" style="margin-top:10px">Declared unsupported is an explicit safety boundary; no compatibility fallback is attempted.</div><ul style="margin:12px 0 0 18px;display:grid;gap:6px">${(s.entries || []).map(entry => `<li><code>${Utils.escapeHtml(entry.key)}</code> — ${Utils.escapeHtml(entry.reason)}</li>`).join('') || '<li>No unsupported capability declaration was returned.</li>'}</ul></details>`; },
  _freshnessHtml(result) { const s = result.freshness || {}; const age = Number.isFinite(s.ageMs) ? `${Math.floor(s.ageMs / 1000)}s` : '—'; return `<div class="card" style="padding:16px;margin-bottom:16px"><strong>Posture evidence freshness</strong><div class="text-muted text-sm">Age of the capability evidence returned for this view; refresh may still be incomplete or conditional.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(s.state || 'unknown')}</div><div class="stat-label">Freshness</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(age)}</div><div class="stat-label">Evidence age</div></div><div class="stat-card"><div class="stat-value">${Utils.escapeHtml(s.probeStatus || 'unknown')}</div><div class="stat-label">Probe state</div></div></div></div>`; },
  _dashboardHtml(result) { const c = result.coverage || {}; const s = c.states || {}; return `<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--accent)"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong><i class="fas fa-shield-alt" aria-hidden="true"></i> Consolidated provider security evidence</strong><div class="text-muted text-sm">One read-only orientation view of the declared SDK contract. It is not a security rating, compliance certification, or vulnerability assessment.</div></div><span class="badge badge-secondary">${Utils.escapeHtml(result.freshness?.state || 'unknown')}</span></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${s.supported ?? 0}</div><div class="stat-label">Supported</div></div><div class="stat-card"><div class="stat-value">${s.conditional ?? 0}</div><div class="stat-label">Conditional</div></div><div class="stat-card"><div class="stat-value">${s.unsupported ?? 0}</div><div class="stat-label">Unsupported</div></div><div class="stat-card"><div class="stat-value">${result.safeguards?.declaredPrivilegedFeatureCount ?? 0}</div><div class="stat-label">Guarded operations</div></div><div class="stat-card"><div class="stat-value">${result.gapRegister?.unsupportedCount ?? 0}</div><div class="stat-label">Registered gaps</div></div></div></div>`; },
  _operationalQualificationHtml(result) {
    if (!result) return '<div class="alert alert-secondary"><strong>Operational qualification is unavailable.</strong> No success state is inferred.</div>';
    const stateBadge = state => state === 'ready' || state === 'observed' ? 'badge-success' : 'badge-secondary';
    const rows = (result.items || []).map(item => {
      const flags = item.runtime?.releaseFlags || (item.runtime?.executeFlag ? [item.runtime.executeFlag] : []);
      const flagHtml = flags.length ? flags.map(flag => `<span class="badge ${flag.enabled ? 'badge-warning' : 'badge-secondary'}" style="margin:2px">${flag.enabled ? 'enabled' : 'default-off'}</span><div class="text-muted text-sm"><code>${Utils.escapeHtml(flag.name)}</code></div>`).join('') : '<span class="badge badge-secondary">read-only</span>';
      return `<tr><td><strong>${Utils.escapeHtml(item.featureId)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(item.name)}</div></td><td><span class="badge ${stateBadge(item.schema?.state)}">${Utils.escapeHtml(item.schema?.state || 'missing')}</span></td><td><span class="badge ${stateBadge(item.runtime?.state)}">${Utils.escapeHtml(item.runtime?.state || 'not_observed')}</span><div class="text-muted text-sm">${Number(item.runtime?.recordCount || 0)} records</div></td><td>${flagHtml}</td><td>${(item.validation?.outstanding || []).map(gap => `<span class="badge badge-secondary" style="margin:2px">${Utils.escapeHtml(gap)}</span>`).join('') || '—'}</td></tr>`;
    }).join('');
    const batchLabel = result.batch?.label || (result.items || []).map(item => item.featureId).join('/');
    return `<details class="card" style="padding:16px;margin-bottom:16px" open><summary style="cursor:pointer"><strong><i class="fas fa-clipboard-check"></i> ${Utils.escapeHtml(batchLabel)} operational qualification</strong> <span class="badge badge-secondary">${Number(result.summary?.featureCount || 0)}</span></summary><div class="text-muted text-sm" style="margin-top:8px">Read-only local evidence from qualification release ${Utils.escapeHtml(result.items?.[0]?.delivery?.qualificationRelease || 'unknown')}. It starts no provider mutation, network call, external command, browser smoke or active probe.</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${Number(result.summary?.schemaReady || 0)}/${Number(result.summary?.featureCount || 0)}</div><div class="stat-label">Schema ready</div></div><div class="stat-card"><div class="stat-value">${Number(result.summary?.runtimeObserved || 0)}</div><div class="stat-label">Runtime observed</div></div><div class="stat-card"><div class="stat-value">${Number(result.summary?.executeFlagsEnabled || 0)}</div><div class="stat-label">Execute flags enabled</div></div><div class="stat-card"><div class="stat-value">${Number(result.summary?.browserSmokeRecorded || 0)}</div><div class="stat-label">Browser smoke recorded</div></div><div class="stat-card"><div class="stat-value"><code>${Utils.escapeHtml(String(result.evidenceHash || '').slice(0, 12))}</code></div><div class="stat-label">Evidence hash</div></div></div><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Feature</th><th>Schema</th><th>Runtime evidence</th><th>Execution boundary</th><th>Outstanding</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No qualification evidence.</td></tr>'}</tbody></table></div></details>`;
  },
  _assuranceHtml(result) {
    if (!result) return '<div class="alert alert-secondary"><strong>Security assurance packs are disabled.</strong> Enable the release flag to import provider-reported evidence.</div>';
    const badge = state => ({ pass: 'badge-success', fail: 'badge-danger', healthy: 'badge-success',
      degraded: 'badge-warning', unavailable: 'badge-danger' }[state] || 'badge-secondary');
    const evidenceRows = (result.items || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.resourceName)}</strong><div class="text-muted text-sm"><code>${Utils.escapeHtml(item.resourceId)}</code></div></td><td>${Utils.escapeHtml(item.resourceKind)}</td><td>${(item.controls || []).map(control => `<span class="badge ${badge(control.state)}" style="margin:2px">${Utils.escapeHtml(control.id)}: ${Utils.escapeHtml(control.state)}</span>`).join('') || '<span class="badge badge-secondary">unknown</span>'}</td><td>${Utils.escapeHtml(Utils.timeAgo(item.observedAt))}</td><td><code>${Utils.escapeHtml(String(item.evidenceHash || '').slice(0, 12))}</code></td></tr>`).join('');
    const keyRows = (result.keyProviders || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(item.providerKind)}</div></td><td>${Utils.escapeHtml(item.endpointOrigin)}</td><td><span class="badge ${badge(item.health?.state)}">${Utils.escapeHtml(item.health?.state || 'unknown')}</span></td><td>${Number(item.affectedResourceIds?.length || 0)}</td><td>${this._isAdmin() ? `<button class="btn btn-xs btn-danger" data-security-key-delete="${Utils.escapeHtml(item.id)}"><i class="fas fa-trash"></i></button>` : ''}</td></tr>`).join('');
    const controls = this._isAdmin() ? '<div style="display:flex;gap:7px;flex-wrap:wrap"><button id="security-import-evidence" class="btn btn-sm btn-secondary"><i class="fas fa-file-import"></i> Import evidence</button><button id="security-new-key-provider" class="btn btn-sm btn-secondary"><i class="fas fa-key"></i> Register key provider</button><button id="security-confidential-plan" class="btn btn-sm btn-primary"><i class="fas fa-user-shield"></i> Plan confidential VM</button></div>' : '';
    return `<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--yellow)"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><strong>Versioned provider security assurance</strong><div class="text-muted text-sm">${Utils.escapeHtml(result.pack?.title || 'Generic security posture')} · pack ${Utils.escapeHtml(result.pack?.version || 'unknown')}. Absence is unknown; this view starts no probe or provider mutation.</div></div>${controls}</div><div class="stats-grid" style="margin-top:14px">${['pass', 'fail', 'unknown', 'not_applicable'].map(state => `<div class="stat-card"><div class="stat-value">${Number(result.counts?.[state] || 0)}</div><div class="stat-label">${Utils.escapeHtml(state.replace('_', ' '))}</div></div>`).join('')}<div class="stat-card"><div class="stat-value">${Number(result.keyProviders?.length || 0)}</div><div class="stat-label">Key providers</div></div></div></div>
      <details class="card" style="padding:16px;margin-bottom:16px" open><summary><strong>Secure Boot, vTPM, encryption, confidential VM and hardening evidence</strong> <span class="badge badge-secondary">${Number(result.evidenceCount || 0)}</span></summary><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Resource</th><th>Kind</th><th>Controls</th><th>Observed</th><th>Evidence</th></tr></thead><tbody>${evidenceRows || '<tr><td colspan="5" class="text-muted">No evidence imported. All assurance domains remain unknown.</td></tr>'}</tbody></table></div></details>
      <details class="card" style="padding:16px;margin-bottom:16px"><summary><strong>KMS and key-provider registry</strong> <span class="badge badge-secondary">${Number(result.keyProviders?.length || 0)}</span></summary><div class="text-muted text-sm" style="margin-top:8px">Credentials are symbolic secret-manager references and are never returned by the API.</div><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Provider</th><th>HTTPS origin</th><th>Health</th><th>Affected resources</th><th></th></tr></thead><tbody>${keyRows || '<tr><td colspan="5" class="text-muted">No key provider is registered.</td></tr>'}</tbody></table></div></details>`;
  },
  _securityLifecycleHtml(result) {
    if (!result) return '<div class="alert alert-secondary"><strong>Security lifecycle controls are disabled.</strong> Exact advisory correlation, exceptions, remediation planning and secret-reference validation remain unavailable.</div>';
    const badge = state => ({ open: 'badge-danger', excepted: 'badge-warning', planned: 'badge-info',
      remediated: 'badge-success', valid: 'badge-success', invalid: 'badge-danger', critical: 'badge-danger',
      high: 'badge-danger', medium: 'badge-warning' }[state] || 'badge-secondary');
    const findings = (result.findings || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.advisoryId)}</strong><div class="text-muted text-sm">${(item.cveIds || []).map(id => Utils.escapeHtml(id)).join(', ') || 'No CVE ID'}</div></td><td><span class="badge ${badge(item.severity)}">${Utils.escapeHtml(item.severity)}</span> <strong>${Number(item.priorityScore || 0)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(item.confidence)} confidence</div></td><td>${Utils.escapeHtml(item.resourceName)}<div class="text-muted text-sm"><code>${Utils.escapeHtml(item.resourceId)}</code></div></td><td><span class="badge ${badge(item.state)}">${Utils.escapeHtml(item.state)}</span>${item.exception ? `<div class="text-muted text-sm">${Utils.escapeHtml(item.exception.owner)} · ${Utils.escapeHtml(Utils.timeAgo(item.exception.expiresAt))}</div>` : ''}</td><td>${this._isAdmin() ? `<div style="display:flex;gap:5px;flex-wrap:wrap">${item.exception ? `<button class="btn btn-xs btn-secondary" data-security-exception-revoke="${Utils.escapeHtml(item.id)}">Revoke exception</button>` : `<button class="btn btn-xs btn-secondary" data-security-exception="${Utils.escapeHtml(item.id)}">Exception</button>`}<button class="btn btn-xs btn-primary" data-security-remediation="${Utils.escapeHtml(item.id)}">Dry-run plan</button>${result.automation?.enabled && item.remediationPlan?.allowed && item.remediationPlan?.state === 'planned' ? `<button class="btn btn-xs btn-warning" data-security-execute="${Utils.escapeHtml(item.remediationPlan.id)}">Execute low-risk</button>` : ''}</div>` : ''}</td></tr>`).join('');
    const certificates = (result.certificateRotation || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(item.subject || 'Unknown subject')}</div></td><td>${item.ownership ? `${Utils.escapeHtml(item.ownership.owner)}<div class="text-muted text-sm">${Utils.escapeHtml(item.ownership.environment)}</div>` : '<span class="badge badge-warning">unowned</span>'}</td><td>${item.expiresAt ? Utils.escapeHtml(Utils.timeAgo(item.expiresAt)) : '—'}</td><td>${item.latestRenewal ? `<span class="badge ${badge(item.latestRenewal.state)}">${Utils.escapeHtml(item.latestRenewal.state)}</span><div class="text-muted text-sm">${Utils.escapeHtml(item.latestRenewal.adapterKey)}</div>` : 'No plan'}</td></tr>`).join('');
    const controls = this._isAdmin() ? '<div style="display:flex;gap:7px;flex-wrap:wrap"><button id="security-correlate" class="btn btn-sm btn-secondary"><i class="fas fa-project-diagram"></i> Correlate official advisories</button><button id="security-validate-references" class="btn btn-sm btn-secondary"><i class="fas fa-key"></i> Validate secret references</button></div>' : '';
    return `<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--red)"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><strong>Security findings and remediation lifecycle</strong><div class="text-muted text-sm">Exact version/build matching against the imported official catalog. No advisory fetch or provider mutation is started by this view.</div></div>${controls}</div><div class="stats-grid" style="margin-top:14px">${['open', 'excepted', 'planned', 'remediated'].map(state => `<div class="stat-card"><div class="stat-value">${Number(result.counts?.[state] || 0)}</div><div class="stat-label">${state}</div></div>`).join('')}<div class="stat-card"><div class="stat-value">${Number(result.validations?.length || 0)}</div><div class="stat-label">Secret checks</div></div></div></div>
      <details class="card" style="padding:16px;margin-bottom:16px" open><summary><strong>CVE/advisory findings and exposure priority</strong> <span class="badge badge-secondary">${Number(result.findings?.length || 0)}</span></summary><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Advisory</th><th>Priority</th><th>Resource</th><th>State</th><th></th></tr></thead><tbody>${findings || '<tr><td colspan="5" class="text-muted">No exact advisory match has been correlated.</td></tr>'}</tbody></table></div></details>
      <details class="card" style="padding:16px;margin-bottom:16px"><summary><strong>Certificate ownership and rotation workflow</strong> <span class="badge badge-secondary">${Number(result.certificateRotation?.length || 0)}</span></summary><div class="text-muted text-sm" style="margin-top:8px">Rotation remains approval-bound in the existing lifecycle workflow and retains rollback evidence.</div><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Certificate</th><th>Owner</th><th>Expiry</th><th>Latest renewal</th></tr></thead><tbody>${certificates || '<tr><td colspan="4" class="text-muted">No endpoint-scoped tracked certificate.</td></tr>'}</tbody></table></div></details>`;
  },
  _privilegedComplianceHtml(result) {
    if (!result) return '<div class="alert alert-secondary"><strong>Privileged access and compliance controls are disabled.</strong> JIT, break-glass, classification and evidence export remain fail-closed.</div>';
    const badge = state => ({ active: 'badge-success', reviewed: 'badge-success', pending: 'badge-warning',
      approved: 'badge-info', closed: 'badge-warning', expired: 'badge-secondary', revoked: 'badge-secondary',
      restricted: 'badge-danger', confidential: 'badge-warning', internal: 'badge-info', public: 'badge-success' }[state] || 'badge-secondary');
    const actorId = Number(App.user?.id);
    const grants = (result.grants || []).map(item => `<tr><td><code>${Utils.escapeHtml(item.permissionKey)}</code><div class="text-muted text-sm">scope ${Number(item.scopeId)}</div></td><td><span class="badge ${badge(item.state)}">${Utils.escapeHtml(item.state)}</span></td><td>${Utils.escapeHtml(Utils.timeAgo(item.expiresAt))}</td><td><div style="display:flex;gap:5px;flex-wrap:wrap">${item.state === 'pending' && Number(item.requestedBy) !== actorId ? `<button class="btn btn-xs btn-primary" data-pc-jit-action="approve" data-pc-id="${Utils.escapeHtml(item.id)}">Approve</button>` : ''}${item.state === 'active' && !item.claimed && Number(item.requestedBy) === actorId ? `<button class="btn btn-xs btn-primary" data-pc-jit-action="claim" data-pc-id="${Utils.escapeHtml(item.id)}">Claim once</button>` : ''}${['pending', 'active'].includes(item.state) ? `<button class="btn btn-xs btn-secondary" data-pc-jit-action="revoke" data-pc-id="${Utils.escapeHtml(item.id)}">Revoke</button>` : ''}</div></td></tr>`).join('');
    const breakGlass = (result.breakGlass || []).map(item => `<tr><td><strong>${Utils.escapeHtml(item.ticketRef)}</strong><div class="text-muted text-sm">${Utils.escapeHtml(item.temporaryIdentity)}</div></td><td><span class="badge ${badge(item.state)}">${Utils.escapeHtml(item.state)}</span><div class="text-muted text-sm">${Utils.escapeHtml(item.recordingPolicy)} recording</div></td><td>${Utils.escapeHtml(Utils.timeAgo(item.expiresAt))}</td><td><div style="display:flex;gap:5px;flex-wrap:wrap">${item.state === 'pending' && Number(item.requestedBy) !== actorId ? `<button class="btn btn-xs btn-primary" data-pc-bg-action="approve" data-pc-id="${Utils.escapeHtml(item.id)}">Approve</button>` : ''}${item.state === 'approved' && Number(item.requestedBy) === actorId ? `<button class="btn btn-xs btn-warning" data-pc-bg-action="activate" data-pc-id="${Utils.escapeHtml(item.id)}">Activate</button>` : ''}${['approved', 'active', 'expired'].includes(item.state) ? `<button class="btn btn-xs btn-secondary" data-pc-bg-action="close" data-pc-id="${Utils.escapeHtml(item.id)}">Close</button>` : ''}${['closed', 'expired'].includes(item.state) && Number(item.requestedBy) !== actorId ? `<button class="btn btn-xs btn-primary" data-pc-bg-action="review" data-pc-id="${Utils.escapeHtml(item.id)}">Review</button>` : ''}</div></td></tr>`).join('');
    const classifications = (result.classifications || []).map(item => `<tr><td><code>${Utils.escapeHtml(item.resourceId)}</code><div class="text-muted text-sm">${Utils.escapeHtml(item.resourceKind)}</div></td><td><span class="badge ${badge(item.classification)}">${Utils.escapeHtml(item.classification)}</span></td><td>${Utils.escapeHtml(item.policy?.backup || 'unknown')}</td><td>${Utils.escapeHtml(item.policy?.evidenceExport || 'unknown')}</td></tr>`).join('');
    const latest = result.ransomwarePostures?.[0];
    const permissions = new Set(result.governanceIntegration?.actorPermissions || []);
    const canRequestJit = permissions.has('privileged.elevation.request');
    const permitted = permission => canRequestJit || permissions.has(permission);
    const controlButtons = [
      canRequestJit ? '<button id="pc-request-jit" class="btn btn-sm btn-secondary"><i class="fas fa-user-clock"></i> Request JIT</button>' : '',
      permitted('privileged.break_glass.request') ? '<button id="pc-request-break-glass" class="btn btn-sm btn-warning"><i class="fas fa-fire-extinguisher"></i> Break glass</button>' : '',
      permitted('data.classification.manage') ? '<button id="pc-classify" class="btn btn-sm btn-secondary"><i class="fas fa-tags"></i> Classify endpoint</button>' : '',
      permitted('compliance.mapping.manage') ? '<button id="pc-import-mapping" class="btn btn-sm btn-secondary"><i class="fas fa-project-diagram"></i> Map control</button>' : '',
      permitted('recovery.ransomware_posture.manage') ? '<button id="pc-ransomware" class="btn btn-sm btn-secondary"><i class="fas fa-life-ring"></i> Record recovery posture</button>' : '',
      permitted('compliance.evidence.export') ? '<button id="pc-export" class="btn btn-sm btn-primary"><i class="fas fa-file-signature"></i> Export signed JSON</button>' : '',
    ].filter(Boolean);
    const controls = controlButtons.length
      ? `<div style="display:flex;gap:7px;flex-wrap:wrap">${controlButtons.join('')}</div>` : '';
    return `<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--purple)"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><strong>Privileged access and compliance evidence</strong><div class="text-muted text-sm">MFA + four-eyes JIT, scoped break-glass and installation-signed evidence. Tokens, screen content and raw configs are never returned by this overview.</div></div>${controls}</div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${Number(result.counts?.activeGrants || 0)}</div><div class="stat-label">Active JIT</div></div><div class="stat-card"><div class="stat-value">${Number(result.counts?.activeBreakGlass || 0)}</div><div class="stat-label">Break glass</div></div><div class="stat-card"><div class="stat-value">${Number(result.counts?.remoteSessions || 0)}</div><div class="stat-label">Session metadata</div></div><div class="stat-card"><div class="stat-value">${Number(result.counts?.classifications || 0)}</div><div class="stat-label">Classifications</div></div><div class="stat-card"><div class="stat-value">${latest ? Number(latest.score) : '—'}</div><div class="stat-label">Ransomware score</div></div><div class="stat-card"><div class="stat-value">${Number(result.governanceIntegration?.permissionCount || 0)}</div><div class="stat-label">Catalog permissions</div></div></div></div>
      <details class="card" style="padding:16px;margin-bottom:16px" open><summary><strong>JIT elevation and break-glass lifecycle</strong></summary><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Permission</th><th>State</th><th>Expiry</th><th></th></tr></thead><tbody>${grants || '<tr><td colspan="4" class="text-muted">No JIT elevation request.</td></tr>'}</tbody></table></div><div style="overflow:auto;margin-top:16px"><table class="data-table"><thead><tr><th>Break glass</th><th>State</th><th>Expiry</th><th></th></tr></thead><tbody>${breakGlass || '<tr><td colspan="4" class="text-muted">No break-glass request.</td></tr>'}</tbody></table></div></details>
      <details class="card" style="padding:16px;margin-bottom:16px"><summary><strong>Classification, framework mapping and recovery posture</strong> <span class="badge badge-secondary">${Number(result.counts?.classifications || 0)}</span></summary><div class="text-muted text-sm" style="margin-top:8px">Framework references are organization-authored mappings, not a certification verdict.</div><div style="overflow:auto;margin-top:12px"><table class="data-table"><thead><tr><th>Resource</th><th>Class</th><th>Backup policy</th><th>Export policy</th></tr></thead><tbody>${classifications || '<tr><td colspan="4" class="text-muted">No resource classification.</td></tr>'}</tbody></table></div><div class="stats-grid" style="margin-top:14px"><div class="stat-card"><div class="stat-value">${Number(result.counts?.mappings || 0)}</div><div class="stat-label">Mappings</div></div><div class="stat-card"><div class="stat-value">${Number(result.counts?.exports || 0)}</div><div class="stat-label">Signed exports</div></div><div class="stat-card"><div class="stat-value">${latest ? Utils.escapeHtml(latest.confidence) : '—'}</div><div class="stat-label">Posture confidence</div></div></div></details>`;
  },
  async _importEvidence() {
    const sample = { resourceKind: 'endpoint', source: 'imported_evidence', observedAt: new Date().toISOString(),
      facts: { hardening: { baselineKey: 'organization-host-v1', baselineVersion: '1.0.0',
        checks: [{ id: 'management_tls', state: 'unknown', evidence: 'Import bounded provider evidence' }] } } };
    const result = await Modal.form(`<div class="alert alert-info">Metadata-only import. No endpoint, guest or host command is run. Use canonical IDs for host, virtualMachine or artifact resources.</div><label for="security-evidence-json">Normalized evidence JSON</label><textarea id="security-evidence-json" class="form-control mono" rows="20">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea>`, {
      title: 'Import security evidence', confirmText: 'Validate and save', width: '700px',
      onSubmit: content => JSON.parse(content.querySelector('#security-evidence-json').value),
    });
    if (!result) return;
    try { await Api.importProviderSecurityEvidence(this._hostId, result); Toast.success('Security evidence saved'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _newKeyProvider() {
    const result = await Modal.form(`<div class="alert alert-info">Register evidence only. The credential must be a secret-manager URI; inline secrets are rejected and no network call is started.</div><label>Name<input id="security-key-name" maxlength="100" class="form-control" value="Primary KMS"></label><label>Kind<select id="security-key-kind" class="form-control"><option value="external_kms">external KMS</option><option value="native_kms">provider native KMS</option><option value="hgs">Host Guardian Service</option><option value="key_broker">key broker</option></select></label><label>Credential-free HTTPS origin<input id="security-key-origin" maxlength="300" class="form-control" placeholder="https://kms.example.com"></label><label>Secret reference<input id="security-key-ref" maxlength="500" class="form-control" placeholder="vault://virtualization/kms/client"></label><label>Reported health<select id="security-key-health" class="form-control"><option value="unknown">unknown</option><option value="healthy">healthy</option><option value="degraded">degraded</option><option value="unavailable">unavailable</option></select></label>`, {
      title: 'Register key-provider evidence', confirmText: 'Register', width: '620px',
      onSubmit: content => ({ name: content.querySelector('#security-key-name').value.trim(),
        providerKind: content.querySelector('#security-key-kind').value,
        endpointOrigin: content.querySelector('#security-key-origin').value.trim(),
        secretRef: content.querySelector('#security-key-ref').value.trim(),
        health: { state: content.querySelector('#security-key-health').value,
          observedAt: new Date().toISOString() }, affectedResourceIds: [] }),
    });
    if (!result) return;
    try { await Api.saveProviderKeyProvider(this._hostId, result); Toast.success('Key-provider evidence registered'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _planConfidential() {
    const result = await Modal.form('<div class="alert alert-warning"><strong>Compatibility preflight only.</strong> A passing result cannot create a VM.</div><label>Canonical artifact ID<input id="security-plan-artifact" class="form-control mono" placeholder="dda_art_…"></label><label>Canonical target-host ID<input id="security-plan-host" class="form-control mono" placeholder="ddr_host_…"></label><label>Mode<select id="security-plan-mode" class="form-control"><option value="shielded">shielded</option><option value="sev">SEV</option><option value="sev_es">SEV-ES</option><option value="sev_snp">SEV-SNP</option><option value="tdx">TDX</option></select></label>', {
      title: 'Plan confidential VM compatibility', confirmText: 'Run preflight', width: '620px',
      onSubmit: content => ({ artifactId: content.querySelector('#security-plan-artifact').value.trim(),
        targetHostId: content.querySelector('#security-plan-host').value.trim(),
        mode: content.querySelector('#security-plan-mode').value }),
    });
    if (!result) return;
    try { const plan = await Api.preflightProviderConfidentialProvisioning(this._hostId, result);
      const details = [...(plan.blockers || []), ...(plan.warnings || [])].map(item => `${item.code}: ${item.reason}`).join('\n');
      Toast[plan.allowed ? 'success' : 'warning'](`${plan.allowed ? 'Compatible' : 'Blocked'}; execution authorized: no${details ? ` — ${details}` : ''}`); }
    catch (err) { Toast.error(err.message); }
  },
  async _deleteKeyProvider(id) {
    const item = this._assurance?.keyProviders?.find(entry => entry.id === id);
    if (!item || !await Modal.confirm(`Delete key-provider evidence “${item.name}”?`, { danger: true })) return;
    try { await Api.deleteProviderKeyProvider(this._hostId, id); Toast.success('Key-provider evidence deleted'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _correlateSecurity() {
    try { const result = await Api.correlateProviderSecurityAdvisories(this._hostId);
      Toast.success(`${result.matched} exact advisory match(es) correlated`); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _validateSecretReferences() {
    const sample = { documentKind: 'manifest', document: { services: { app: {
      environment: { DATABASE_PASSWORD_REF: 'vault://docker-dash/database/password' } } } } };
    const result = await Modal.form(`<div class="alert alert-info">The document is validated in memory. Only its hash, reference hashes and finding paths are stored.</div><label for="security-secret-document">Manifest, job or template JSON</label><textarea id="security-secret-document" class="form-control mono" rows="18">${Utils.escapeHtml(JSON.stringify(sample, null, 2))}</textarea>`, {
      title: 'Validate secret references', confirmText: 'Validate', width: '700px',
      onSubmit: content => JSON.parse(content.querySelector('#security-secret-document').value),
    });
    if (!result) return;
    try { await Api.validateProviderSecretReferences(this._hostId, result);
      Toast.success('All secret-bearing fields use approved references'); await this._load(); }
    catch (err) { Toast.error(err.message); await this._load(); }
  },
  async _createSecurityException(findingId) {
    const result = await Modal.form('<div class="alert alert-warning">Exceptions require an owner, expiry and explicit compensating controls.</div><label>Owner<input id="security-exception-owner" maxlength="160" class="form-control"></label><label>Reason<textarea id="security-exception-reason" maxlength="500" class="form-control"></textarea></label><label>Expires at<input id="security-exception-expiry" type="datetime-local" class="form-control"></label><label>Compensating controls (one per line)<textarea id="security-exception-controls" maxlength="4000" class="form-control"></textarea></label>', {
      title: 'Create security exception', confirmText: 'Create exception', width: '620px',
      onSubmit: content => ({ owner: content.querySelector('#security-exception-owner').value.trim(),
        reason: content.querySelector('#security-exception-reason').value.trim(),
        expiresAt: new Date(content.querySelector('#security-exception-expiry').value).toISOString(),
        compensatingControls: content.querySelector('#security-exception-controls').value.split('\n').map(value => value.trim()).filter(Boolean) }),
    });
    if (!result) return;
    try { await Api.createProviderSecurityException(this._hostId, findingId, result);
      Toast.success('Security exception created'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _revokeSecurityException(findingId) {
    const finding = this._securityLifecycle?.findings?.find(item => item.id === findingId);
    if (!finding?.exception || !await Modal.confirm('Revoke this active security exception?', { danger: true })) return;
    try { await Api.revokeProviderSecurityException(this._hostId, findingId, finding.exception.id);
      Toast.success('Security exception revoked'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _planSecurityRemediation(findingId) {
    const result = await Modal.form('<div class="alert alert-info">Plan only. Dry-run and rollback evidence are mandatory; this action starts no provider mutation.</div><label>Action<select id="security-plan-action" class="form-control"><option value="disable_legacy_protocol">disable legacy protocol (low)</option><option value="remove_legacy_device">remove legacy device (low)</option><option value="enforce_secret_reference">enforce secret reference (low)</option><option value="rotate_certificate">rotate certificate (moderate)</option><option value="upgrade_provider_build">upgrade provider build (high)</option></select></label><label>Steps (one per line)<textarea id="security-plan-steps" class="form-control">Verify current evidence\nApply bounded change\nPost-read verification</textarea></label><label>Downtime seconds<input id="security-plan-downtime" type="number" min="0" max="604800" value="0" class="form-control"></label><label>Dry-run evidence<input id="security-plan-dryrun" maxlength="500" class="form-control" value="Read-only dry-run passed"></label><label>Rollback strategy<input id="security-plan-rollback" maxlength="500" class="form-control" value="Restore the captured pre-change state"></label>', {
      title: 'Create remediation plan', confirmText: 'Save dry-run plan', width: '650px',
      onSubmit: content => ({ actionKey: content.querySelector('#security-plan-action').value,
        steps: content.querySelector('#security-plan-steps').value.split('\n').map(value => value.trim()).filter(Boolean),
        downtimeSeconds: Number(content.querySelector('#security-plan-downtime').value), dependencies: [],
        dryRun: { passed: true, evidence: content.querySelector('#security-plan-dryrun').value.trim() },
        rollback: { verified: true, strategy: content.querySelector('#security-plan-rollback').value.trim() } }),
    });
    if (!result) return;
    try { const plan = await Api.planProviderSecurityRemediation(this._hostId, findingId, result);
      Toast[plan.allowed ? 'success' : 'warning'](`Plan ${plan.allowed ? 'ready' : 'blocked'}; execution authorized: no`); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _executeSecurityRemediation(planId) {
    const finding = this._securityLifecycle?.findings?.find(item => item.remediationPlan?.id === planId);
    const plan = finding?.remediationPlan; if (!plan) return;
    const result = await Modal.form(`<div class="alert alert-danger"><strong>Provider mutation boundary.</strong> Execution still requires an installed conformance-tested adapter and a successful read-only canary.</div><label>Adapter key<input id="security-execute-adapter" class="form-control mono"></label><label>Typed confirmation<input id="security-execute-confirm" class="form-control mono" placeholder="EXECUTE SECURITY PLAN ${Utils.escapeHtml(plan.id)}"></label>`, {
      title: 'Execute low-risk remediation', confirmText: 'Execute canary', danger: true, width: '650px',
      onSubmit: content => ({ adapterKey: content.querySelector('#security-execute-adapter').value.trim(),
        confirmation: content.querySelector('#security-execute-confirm').value.trim(), planHash: plan.planHash }),
    });
    if (!result) return;
    try { const run = await Api.executeProviderSecurityRemediation(this._hostId, plan.id, result);
      Toast[run.state === 'succeeded' ? 'success' : 'warning'](`Remediation run: ${run.state}`); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _requestJit() {
    const result = await Modal.form('<div class="alert alert-warning">A local TOTP and an independent approver are required. The grant token is claimable once after approval.</div><label>Scope ID<input id="pc-jit-scope" type="number" min="1" value="1" class="form-control"></label><label>Permission<select id="pc-jit-permission" class="form-control"><option>data.classification.manage</option><option>compliance.evidence.export</option><option>compliance.mapping.manage</option><option>recovery.ransomware_posture.manage</option><option>privileged.break_glass.request</option><option>privileged.session_recording.read</option></select></label><label>Reason<textarea id="pc-jit-reason" maxlength="600" class="form-control"></textarea></label><label>TTL seconds<input id="pc-jit-ttl" type="number" min="60" max="3600" value="900" class="form-control"></label><label>Current TOTP<input id="pc-jit-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="form-control mono"></label>', {
      title: 'Request scoped JIT elevation', confirmText: 'Verify MFA and request', width: '620px',
      onSubmit: content => ({ scopeId: Number(content.querySelector('#pc-jit-scope').value),
        permissionKey: content.querySelector('#pc-jit-permission').value,
        reason: content.querySelector('#pc-jit-reason').value.trim(),
        ttlSeconds: Number(content.querySelector('#pc-jit-ttl').value),
        totpCode: content.querySelector('#pc-jit-totp').value.trim() }),
    });
    if (!result) return;
    try { await Api.requestProviderElevation(this._hostId, result); Toast.success('JIT elevation is pending independent approval'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _jitAction(action, id) {
    try {
      if (action === 'approve') {
        if (!await Modal.confirm(`Approve JIT grant ${Utils.escapeHtml(id)} for another user?`, { confirmText: 'Approve' })) return;
        await Api.approveProviderElevation(this._hostId, id, `APPROVE JIT ${id}`);
        Toast.success('JIT grant approved; requester can claim it once');
      } else if (action === 'claim') {
        const result = await Api.claimProviderElevation(this._hostId, id);
        await Modal.confirm(`<p>This JIT token is shown once. Store it only for the short authorized window.</p><textarea class="form-control mono" rows="3" readonly>${Utils.escapeHtml(result.token)}</textarea>`, { confirmText: 'I stored it' });
      } else {
        if (!await Modal.confirm(`Revoke JIT grant ${Utils.escapeHtml(id)}?`, { danger: true, confirmText: 'Revoke' })) return;
        await Api.revokeProviderElevation(this._hostId, id); Toast.success('JIT grant revoked');
      }
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },
  async _requestBreakGlass() {
    const result = await Modal.form('<div class="alert alert-danger">Break-glass remains scoped, time-bound, four-eyes and review-required. This release creates a temporary access envelope, not a standalone login account.</div><label>Scope ID<input id="pc-bg-scope" type="number" min="1" value="1" class="form-control"></label><label>Ticket reference<input id="pc-bg-ticket" maxlength="300" class="form-control" placeholder="INC-1234"></label><label>Reason<textarea id="pc-bg-reason" maxlength="600" class="form-control"></textarea></label><label>Notification references (one per line)<textarea id="pc-bg-notify" maxlength="1500" class="form-control" placeholder="oncall:security\nmanager:platform"></textarea></label><label>TTL seconds<input id="pc-bg-ttl" type="number" min="300" max="3600" value="900" class="form-control"></label><label>JIT token (delegated users only)<input id="pc-bg-token" maxlength="64" autocomplete="off" class="form-control mono"></label>', {
      title: 'Request break-glass access', confirmText: 'Request', danger: true, width: '620px',
      onSubmit: content => ({ scopeId: Number(content.querySelector('#pc-bg-scope').value),
        ticketRef: content.querySelector('#pc-bg-ticket').value.trim(),
        reason: content.querySelector('#pc-bg-reason').value.trim(), ttlSeconds: Number(content.querySelector('#pc-bg-ttl').value),
        notificationRefs: content.querySelector('#pc-bg-notify').value.split('\n').map(value => value.trim()).filter(Boolean),
        recordingPolicy: 'metadata', recordingConsent: false,
        grantToken: content.querySelector('#pc-bg-token').value.trim() }),
    });
    if (!result) return;
    try { await Api.requestProviderBreakGlass(this._hostId, result); Toast.success('Break-glass request awaits independent approval'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _breakGlassAction(action, id) {
    try {
      if (action === 'approve') {
        if (!await Modal.confirm(`Approve break-glass request ${Utils.escapeHtml(id)}?`, { danger: true, confirmText: 'Approve' })) return;
        await Api.approveProviderBreakGlass(this._hostId, id, `APPROVE BREAK GLASS ${id}`);
      } else if (action === 'activate') {
        if (!await Modal.confirm(`Activate the approved temporary envelope ${Utils.escapeHtml(id)}?`, { danger: true, confirmText: 'Activate' })) return;
        const result = await Api.activateProviderBreakGlass(this._hostId, id, `ACTIVATE BREAK GLASS ${id}`);
        await Modal.confirm(`<p>This break-glass token is shown once.</p><textarea class="form-control mono" rows="3" readonly>${Utils.escapeHtml(result.token)}</textarea>`, { confirmText: 'I stored it' });
      } else if (action === 'close') {
        if (!await Modal.confirm(`Close break-glass request ${Utils.escapeHtml(id)} and require review?`, { confirmText: 'Close' })) return;
        await Api.closeProviderBreakGlass(this._hostId, id);
      } else {
        const review = await Modal.form('<label>Outcome<select id="pc-bg-outcome" class="form-control"><option value="expected">expected</option><option value="needs_follow_up">needs follow-up</option><option value="policy_violation">policy violation</option></select></label><label>Review notes<textarea id="pc-bg-notes" maxlength="600" class="form-control"></textarea></label>', {
          title: 'Independent break-glass review', confirmText: 'Complete review', width: '600px',
          onSubmit: content => ({ outcome: content.querySelector('#pc-bg-outcome').value,
            notes: content.querySelector('#pc-bg-notes').value.trim() }),
        });
        if (!review) return; await Api.reviewProviderBreakGlass(this._hostId, id, review);
      }
      Toast.success(`Break-glass ${action} completed`); await this._load();
    } catch (err) { Toast.error(err.message); }
  },
  async _classifyEndpoint() {
    const result = await Modal.form('<div class="alert alert-info">Classification deterministically projects backup, evidence-export and telemetry policy. A non-admin can supply a current JIT token.</div><label>Scope ID<input id="pc-class-scope" type="number" min="1" value="1" class="form-control"></label><label>Classification<select id="pc-class-level" class="form-control"><option>public</option><option selected>internal</option><option>confidential</option><option>restricted</option></select></label><label>JIT token (delegated users only)<input id="pc-class-token" maxlength="64" autocomplete="off" class="form-control mono"></label>', {
      title: 'Classify provider endpoint', confirmText: 'Save classification', width: '600px',
      onSubmit: content => ({ scopeId: Number(content.querySelector('#pc-class-scope').value),
        resourceKind: 'endpoint', resourceId: `endpoint:${this._hostId}`,
        classification: content.querySelector('#pc-class-level').value,
        grantToken: content.querySelector('#pc-class-token').value.trim() }),
    });
    if (!result) return;
    try { await Api.saveProviderDataClassification(this._hostId, result); Toast.success('Classification policy projected'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _importComplianceMapping() {
    const result = await Modal.form('<div class="alert alert-info">Mappings are organization-authored references. One subject is exported once with all its controls.</div><label>Scope ID<input id="pc-map-scope" type="number" min="1" value="1" class="form-control"></label><label>Subject kind<select id="pc-map-kind" class="form-control"><option value="security_finding">security finding</option><option value="classification">classification</option><option value="ransomware_posture">ransomware posture</option><option value="privileged_access">privileged access</option><option value="remote_session">remote session</option></select></label><label>Subject ID<input id="pc-map-subject" maxlength="300" class="form-control mono"></label><label>Framework<select id="pc-map-framework" class="form-control"><option>CIS</option><option>NIST</option><option>ISO27001</option><option>SOC2</option><option>DORA</option></select></label><label>Control reference<input id="pc-map-control" maxlength="300" class="form-control"></label><label>Rationale<textarea id="pc-map-rationale" maxlength="600" class="form-control"></textarea></label><label>JIT token (delegated users only)<input id="pc-map-token" maxlength="64" autocomplete="off" class="form-control mono"></label>', {
      title: 'Map evidence to a control', confirmText: 'Save mapping', width: '620px',
      onSubmit: content => ({ scopeId: Number(content.querySelector('#pc-map-scope').value),
        grantToken: content.querySelector('#pc-map-token').value.trim(), mappings: [{
          subjectKind: content.querySelector('#pc-map-kind').value,
          subjectKey: content.querySelector('#pc-map-subject').value.trim(),
          framework: content.querySelector('#pc-map-framework').value,
          controlRef: content.querySelector('#pc-map-control').value.trim(),
          rationale: content.querySelector('#pc-map-rationale').value.trim() }] }),
    });
    if (!result) return;
    try { await Api.importProviderComplianceMappings(this._hostId, result); Toast.success('Control mapping saved'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _recordRansomwarePosture() {
    const select = id => `<select id="${id}" class="form-control"><option value="verified">verified</option><option value="failed">failed</option><option value="unknown">unknown</option><option value="not_applicable">not applicable</option></select>`;
    const result = await Modal.form(`<div class="alert alert-info">Evidence references are stored; no backup or restore mutation is started.</div><label>Scope ID<input id="pc-rp-scope" type="number" min="1" value="1" class="form-control"></label>${[['immutability','Immutability'],['isolation','Isolation'],['restore','Restore tests'],['credentials','Credential separation']].map(([id,label]) => `<label>${label}${select(`pc-rp-${id}`)}<input id="pc-rp-${id}-ref" maxlength="300" class="form-control" placeholder="evidence:${id}"></label>`).join('')}<label>JIT token (delegated users only)<input id="pc-rp-token" maxlength="64" autocomplete="off" class="form-control mono"></label>`, {
      title: 'Record ransomware recovery posture', confirmText: 'Record evidence', width: '650px',
      onSubmit: content => { const observedAt = new Date().toISOString(); const factor = id => ({ state: content.querySelector(`#pc-rp-${id}`).value, evidenceRef: content.querySelector(`#pc-rp-${id}-ref`).value.trim(), observedAt }); return { scopeId: Number(content.querySelector('#pc-rp-scope').value), source: 'imported_evidence', observedAt, grantToken: content.querySelector('#pc-rp-token').value.trim(), factors: { immutability: factor('immutability'), isolation: factor('isolation'), restoreTests: factor('restore'), credentialSeparation: factor('credentials') } }; },
    });
    if (!result) return;
    try { const saved = await Api.recordProviderRansomwarePosture(this._hostId, result); Toast.success(`Recovery posture score: ${saved.posture.score}`); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  async _exportCompliance() {
    const result = await Modal.form('<div class="alert alert-info">The JSON bundle includes hashes, checks, mapping references and audit links. Raw configs, secrets and screen content are excluded.</div><label>Scope ID<input id="pc-export-scope" type="number" min="1" value="1" class="form-control"></label><label>JIT token (delegated users only)<input id="pc-export-token" maxlength="64" autocomplete="off" class="form-control mono"></label>', {
      title: 'Export installation-signed evidence', confirmText: 'Create JSON bundle', width: '600px',
      onSubmit: content => ({ scopeId: Number(content.querySelector('#pc-export-scope').value), format: 'json', grantToken: content.querySelector('#pc-export-token').value.trim() }),
    });
    if (!result) return;
    try { const exported = await Api.exportProviderComplianceEvidence(this._hostId, result); const blob = new Blob([JSON.stringify(exported.bundle, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `docker-dash-compliance-${exported.export.id}.json`; link.click(); URL.revokeObjectURL(url); Toast.success('Signed compliance evidence downloaded'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },
  _wireAssurance() {
    this._container?.querySelector('#security-import-evidence')?.addEventListener('click', () => this._importEvidence());
    this._container?.querySelector('#security-new-key-provider')?.addEventListener('click', () => this._newKeyProvider());
    this._container?.querySelector('#security-confidential-plan')?.addEventListener('click', () => this._planConfidential());
    this._container?.querySelectorAll('[data-security-key-delete]').forEach(button => button.addEventListener('click', () => this._deleteKeyProvider(button.dataset.securityKeyDelete)));
    this._container?.querySelector('#security-correlate')?.addEventListener('click', () => this._correlateSecurity());
    this._container?.querySelector('#security-validate-references')?.addEventListener('click', () => this._validateSecretReferences());
    this._container?.querySelectorAll('[data-security-exception]').forEach(button => button.addEventListener('click', () => this._createSecurityException(button.dataset.securityException)));
    this._container?.querySelectorAll('[data-security-exception-revoke]').forEach(button => button.addEventListener('click', () => this._revokeSecurityException(button.dataset.securityExceptionRevoke)));
    this._container?.querySelectorAll('[data-security-remediation]').forEach(button => button.addEventListener('click', () => this._planSecurityRemediation(button.dataset.securityRemediation)));
    this._container?.querySelectorAll('[data-security-execute]').forEach(button => button.addEventListener('click', () => this._executeSecurityRemediation(button.dataset.securityExecute)));
    this._container?.querySelector('#pc-request-jit')?.addEventListener('click', () => this._requestJit());
    this._container?.querySelector('#pc-request-break-glass')?.addEventListener('click', () => this._requestBreakGlass());
    this._container?.querySelector('#pc-classify')?.addEventListener('click', () => this._classifyEndpoint());
    this._container?.querySelector('#pc-import-mapping')?.addEventListener('click', () => this._importComplianceMapping());
    this._container?.querySelector('#pc-ransomware')?.addEventListener('click', () => this._recordRansomwarePosture());
    this._container?.querySelector('#pc-export')?.addEventListener('click', () => this._exportCompliance());
    this._container?.querySelectorAll('[data-pc-jit-action]').forEach(button => button.addEventListener('click', () => this._jitAction(button.dataset.pcJitAction, button.dataset.pcId)));
    this._container?.querySelectorAll('[data-pc-bg-action]').forEach(button => button.addEventListener('click', () => this._breakGlassAction(button.dataset.pcBgAction, button.dataset.pcId)));
  },
  async render(container) {
    this._container = container;
    try { this._hosts = (await Api.getHosts()).filter(host => host.isActive && ['proxmox', 'vsphere', 'xen'].includes(host.daemonType)); } catch { this._hosts = []; }
    const selected = Api.getHostId(); this._hostId = this._hosts.some(host => host.id === selected) ? selected : this._hosts[0]?.id || null;
    container.innerHTML = `<div class="page-header"><div><h1><i class="fas fa-shield-alt"></i> ${i18n.t('nav.provider-security-posture')}</h1><div class="text-muted text-sm">Provider security evidence and governed compliance controls</div></div>${this._hosts.length ? `<div style="display:flex;gap:8px"><select id="provider-security-host" class="form-control" style="width:auto">${this._hosts.map(host => `<option value="${host.id}"${host.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(host.name)} · ${Utils.escapeHtml(host.daemonType)}</option>`).join('')}</select><button id="provider-security-refresh" class="btn btn-sm btn-secondary"><i class="fas fa-sync"></i> ${i18n.t('common.refresh')}</button></div>` : ''}</div><div id="provider-security-content"></div>`;
    container.querySelector('#provider-security-host')?.addEventListener('change', event => { this._hostId = Number(event.target.value); Api.setHost(this._hostId); this._load(); });
    container.querySelector('#provider-security-refresh')?.addEventListener('click', () => this._load()); await this._load();
  },
  async _load() { const target = this._container?.querySelector('#provider-security-content'); if (!target) return; if (!this._hostId) { target.innerHTML = '<div class="empty-msg"><i class="fas fa-server"></i>Add a supported virtualization endpoint to inspect its declared safeguards.</div>'; return; } target.innerHTML = '<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i>Collecting declared capability evidence…</div>'; try { const [result, assurance, securityLifecycle, privilegedCompliance, foundationQualification, networkBackupQualification, recoveryDepthQualification, drSecurityQualification] = await Promise.all([Api.getProviderSecurityPosture(this._hostId), Api.getProviderSecurityAssurance(this._hostId).catch(() => null), Api.getProviderSecurityLifecycle(this._hostId).catch(() => null), Api.getProviderPrivilegedCompliance(this._hostId).catch(() => null), Api.getProviderOperationalQualification(this._hostId).catch(() => null), Api.getProviderOperationalQualification(this._hostId, 'network-backup').catch(() => null), Api.getProviderOperationalQualification(this._hostId, 'recovery-depth').catch(() => null), Api.getProviderOperationalQualification(this._hostId, 'dr-security').catch(() => null)]); this._assurance = assurance; this._securityLifecycle = securityLifecycle; this._privilegedCompliance = privilegedCompliance; this._operationalQualifications = [foundationQualification, networkBackupQualification, recoveryDepthQualification, drSecurityQualification].filter(Boolean); const qualificationHtml = this._operationalQualifications.length ? this._operationalQualifications.map(item => this._operationalQualificationHtml(item)).join('') : this._operationalQualificationHtml(null); target.innerHTML = this._dashboardHtml(result) + qualificationHtml + this._assuranceHtml(assurance) + this._securityLifecycleHtml(securityLifecycle) + this._privilegedComplianceHtml(privilegedCompliance) + this._freshnessHtml(result) + this._coverageHtml(result) + this._safeguardsHtml(result) + this._recoveryHtml(result) + this._consoleHtml(result) + this._tasksHtml(result) + this._networkHtml(result) + this._lifecycleHtml(result) + this._gapsHtml(result) + `<div class="alert alert-info"><strong>Assessment limits</strong><ul>${(result.limitations || []).map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}</ul></div>`; this._wireAssurance(); } catch (err) { target.innerHTML = `<div class="empty-msg is-error"><i class="fas fa-exclamation-triangle"></i>${Utils.escapeHtml(err.message)}</div>`; } },
  destroy() { this._container = null; this._assurance = null; this._securityLifecycle = null; this._privilegedCompliance = null; this._operationalQualifications = []; },
};
if (typeof module !== 'undefined' && module.exports) module.exports = ProviderSecurityPosturePage;
