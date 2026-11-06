/* ═══════════════════════════════════════════════════
   pages/git-stacks.js — Git Repository Stack Management
   ═══════════════════════════════════════════════════ */
'use strict';

const GitStacksPage = {
  _view: 'list', // 'list' | 'detail' | 'create'
  _stackId: null,
  _pollTimer: null,

  async render(container) {
    const hash = location.hash;
    const match = hash.match(/#\/git-stacks\/(\d+)/);
    if (match) {
      this._stackId = parseInt(match[1]);
      this._view = 'detail';
    } else if (hash.includes('create')) {
      this._view = 'create';
    } else {
      this._view = 'list';
    }

    if (this._view === 'detail') await this._renderDetail(container);
    else if (this._view === 'create') await this._renderCreateForm(container);
    else await this._renderList(container);
  },

  // ─── List View ───────────────────────────────────

  async _renderList(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fab fa-git-alt" style="color:var(--accent)"></i> Git Stacks</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="gs-refresh"><i class="fas fa-sync-alt"></i></button>
          ${App.user?.role === 'admin' || App.user?.roles?.includes('admin') ? '<button class="btn btn-sm btn-secondary" id="gs-gitops"><i class="fas fa-code-merge"></i> Fleet GitOps</button>' : ''}
          ${App.user?.role === 'admin' || App.user?.roles?.includes('admin') ? '<button class="btn btn-sm btn-secondary" id="gs-writeback"><i class="fas fa-code-commit"></i> Managed Git</button>' : ''}
          ${App.user?.role === 'admin' || App.user?.roles?.includes('admin') ? '<button class="btn btn-sm btn-secondary" id="gs-oci"><i class="fas fa-cube"></i> OCI Apps</button>' : ''}
          <button class="btn btn-sm btn-primary" id="gs-create"><i class="fas fa-plus"></i> Deploy from Git</button>
        </div>
      </div>
      <div id="gs-list"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>
    `;

    container.querySelector('#gs-refresh').addEventListener('click', () => this._loadList());
    container.querySelector('#gs-create').addEventListener('click', () => this._showCreateDialog());
    container.querySelector('#gs-gitops')?.addEventListener('click', () => this._openGitOps());
    container.querySelector('#gs-writeback')?.addEventListener('click', () => this._openManagedGitOps());
    container.querySelector('#gs-oci')?.addEventListener('click', () => this._openOciArtifacts());
    await this._loadList();
  },

  async _loadList() {
    const el = document.getElementById('gs-list');
    if (!el) return;

    try {
      const stacks = await Api.getGitStacks();
      // v8.3.0 — drift badges (best-effort; don't block list render if it fails)
      let driftMap = {};
      try { driftMap = await Api.getGitDriftAll(); } catch { /* ignore */ }

      if (stacks.length === 0) {
        el.innerHTML = `
          <div class="empty-msg">
            <i class="fab fa-git-alt" style="font-size:48px;opacity:0.3"></i>
            <p>No Git-linked stacks. Deploy your first stack from a Git repository.</p>
          </div>
        `;
        return;
      }

      el.innerHTML = `
        <div class="info-grid" style="margin-top:0">
          ${stacks.map(s => `
            <div class="card stack-card" data-id="${s.id}" style="cursor:pointer">
              <div class="card-header">
                <h3>
                  <i class="fab fa-git-alt" style="margin-right:8px;color:var(--accent)"></i>
                  ${Utils.escapeHtml(s.stack_name)}
                </h3>
                <span style="display:flex;gap:6px;align-items:center">
                  ${this._driftBadge(driftMap[s.id])}
                  <span class="badge ${this._statusBadge(s.status)}">${s.status}</span>
                </span>
              </div>
              <div class="card-body">
                <div class="text-sm text-muted" style="margin-bottom:4px">${Utils.escapeHtml(s.repo_url)}</div>
                 <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                   <span class="badge badge-info">${Utils.escapeHtml(s.branch)}</span>
                   ${s.last_commit_hash ? `<span class="badge" style="background:var(--surface2);color:var(--text-muted);font-family:var(--mono)">${s.last_commit_hash}</span>` : ''}
                   ${s.credential_name ? `<span class="badge" style="background:var(--surface2);color:var(--text-muted)"><i class="fas fa-key" style="margin-right:4px"></i>${Utils.escapeHtml(s.credential_name)}</span>` : ''}
                   <span class="badge ${this._targetSummaryBadge(s.targets)}"><i class="fas fa-server" style="margin-right:4px"></i>${(s.targets || []).length || 1} target${((s.targets || []).length || 1) === 1 ? '' : 's'}</span>
                 </div>
                ${s.last_deployed_at ? `<div class="text-sm text-muted" style="margin-top:6px">Deployed ${Utils.timeAgo(s.last_deployed_at)}</div>` : ''}
                ${s.error_message ? `<div class="text-sm" style="color:var(--red);margin-top:6px">${Utils.escapeHtml(s.error_message.substring(0, 100))}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;

      el.querySelectorAll('.stack-card').forEach(card => {
        card.addEventListener('click', () => {
          location.hash = `#/git-stacks/${card.dataset.id}`;
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Create Dialog ───────────────────────────────

  async _openGitOps() {
    let bundle;
    try {
      bundle = await Api.exportGitOps();
    } catch (err) {
      Toast.error(`Could not export fleet configuration: ${err.message}`);
      return;
    }
    let reviewedPlan = null;
    const result = await Modal.form(`
      <div class="alert alert-info" style="margin-bottom:12px">
        <i class="fas fa-shield-alt"></i> Secrets are exported only as symbolic references. Apply never deploys a newly declared Git stack; it creates it in <strong>pending</strong> state for an explicit first deploy.
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:8px">
        <button type="button" class="btn btn-sm btn-secondary" id="gs-gitops-download"><i class="fas fa-download"></i> Download YAML</button>
        <button type="button" class="btn btn-sm btn-primary" id="gs-gitops-plan"><i class="fas fa-list-check"></i> Generate plan</button>
      </div>
      <textarea id="gs-gitops-document" class="form-control mono" spellcheck="false" style="min-height:430px;resize:vertical">${Utils.escapeHtml(bundle.yaml)}</textarea>
      <div id="gs-gitops-plan-result" style="margin-top:12px"><div class="text-sm text-muted">Edit the versioned fleet document, then generate a plan. Any edit after planning invalidates the reviewed hash.</div></div>
      <div class="form-group" style="margin-top:12px"><label><input type="checkbox" id="gs-gitops-allow-delete"> Allow deletes from this reviewed plan</label><div class="text-xs text-muted">Deletes also require <code>metadata.authoritative: true</code> in the document and a final confirmation.</div></div>
    `, {
      title: '<i class="fas fa-code-merge" style="margin-right:8px"></i> Declarative Fleet GitOps',
      width: '920px', confirmText: 'Apply reviewed plan',
      onOpen: content => {
        const editor = content.querySelector('#gs-gitops-document');
        const planEl = content.querySelector('#gs-gitops-plan-result');
        editor.addEventListener('input', () => {
          reviewedPlan = null;
          planEl.innerHTML = '<div class="text-sm text-muted"><i class="fas fa-triangle-exclamation"></i> Document changed; generate a new plan.</div>';
        });
        content.querySelector('#gs-gitops-download').addEventListener('click', () => {
          const blob = new Blob([editor.value], { type: 'application/yaml' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url; link.download = 'docker-dash-fleet.yaml'; link.click();
          URL.revokeObjectURL(url);
        });
        content.querySelector('#gs-gitops-plan').addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          planEl.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Normalizing and diffing live state...</div>';
          try {
            reviewedPlan = await Api.planGitOps(editor.value);
            planEl.innerHTML = this._gitOpsPlanHtml(reviewedPlan);
          } catch (err) {
            reviewedPlan = null;
            planEl.innerHTML = `<div class="alert alert-danger"><i class="fas fa-triangle-exclamation"></i> ${Utils.escapeHtml(err.message)}</div>`;
          } finally {
            button.disabled = false;
          }
        });
      },
      onSubmit: content => {
        if (!reviewedPlan) { Toast.warning('Generate and review a plan first'); return false; }
        if (reviewedPlan.blocked?.length) { Toast.warning('Resolve all blocked actions before applying'); return false; }
        const allowDelete = content.querySelector('#gs-gitops-allow-delete').checked;
        if (reviewedPlan.summary.delete > 0 && !allowDelete) {
          Toast.warning('This plan contains deletes; explicitly enable Allow deletes');
          return false;
        }
        return {
          document: content.querySelector('#gs-gitops-document').value,
          plan: reviewedPlan, allowDelete,
        };
      },
    });
    if (!result) return;
    if (result.plan.summary.delete > 0) {
      const confirmed = await Modal.confirm(
        `Apply ${result.plan.summary.delete} declarative deletion(s)? Omitted authoritative resources will be removed. Running containers are not deleted by Git stack removal.`,
        { danger: true, confirmText: 'Apply deletes' }
      );
      if (!confirmed) return;
    }
    try {
      const applied = await Api.applyGitOps(
        result.document, result.plan.planHash, result.allowDelete
      );
      const changed = applied.results?.length || 0;
      Toast.success(`Fleet GitOps applied ${changed} change${changed === 1 ? '' : 's'}`);
      await this._loadList();
    } catch (err) {
      if (err.body?.code === 'STALE_PLAN') Toast.warning('Live state changed. Generate and review a fresh plan.');
      else Toast.error(err.message);
    }
  },

  _gitOpsPlanHtml(plan) {
    const summary = plan.summary || {};
    const chips = [
      ['create', 'badge-running'], ['update', 'badge-info'], ['delete', 'badge-danger'],
      ['unchanged', 'badge-stopped'], ['blocked', 'badge-warning'],
    ].map(([key, style]) => `<span class="badge ${style}">${key}: ${summary[key] || 0}</span>`).join(' ');
    const blocked = (plan.blocked || []).map(item => `
      <div class="text-sm" style="color:var(--red);padding:5px 0"><i class="fas fa-ban"></i> ${Utils.escapeHtml(item.resource)} <strong>${Utils.escapeHtml(item.name || '')}</strong>: ${Utils.escapeHtml(item.reason)}</div>`).join('');
    const changes = (plan.actions || []).filter(action => action.operation !== 'unchanged').map(action => `
      <div class="text-sm" style="padding:5px 0;border-bottom:1px solid var(--border)">
        <span class="badge ${action.operation === 'delete' ? 'badge-danger' : action.operation === 'create' ? 'badge-running' : 'badge-info'}" style="margin-right:6px">${action.operation}</span>
        ${Utils.escapeHtml(action.resource)} <strong>${Utils.escapeHtml(action.name)}</strong>
        ${action.changes?.length ? `<span class="text-muted"> · ${Utils.escapeHtml(action.changes.join(', '))}</span>` : ''}
      </div>`).join('');
    return `<div class="card" style="margin:0"><div class="card-header"><strong>Reviewed plan</strong><span class="mono text-xs text-muted" title="${plan.planHash}">${plan.planHash.substring(0, 12)}</span></div><div class="card-body"><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${chips}</div>${blocked}${changes || '<div class="text-sm text-muted">Live state already matches this document.</div>'}</div></div>`;
  },

  async _showCreateDialog() {
    let credentials = [], hosts = [];
    try {
      [credentials, hosts] = await Promise.all([Api.getGitCredentials(), Api.getHosts()]);
    } catch {}
    const dockerHosts = hosts.filter(h => h.isActive && ['docker', 'podman'].includes(h.daemonType || 'docker'));
    const currentHostId = Api.getHostId();
    const selectedIds = new Set(dockerHosts
      .filter(h => h.id === currentHostId || (currentHostId === 0 && h.isDefault))
      .map(h => h.id));
    if (!selectedIds.size && dockerHosts[0]) selectedIds.add(dockerHosts[0].id);

    const result = await Modal.form(`
      <div class="form-group">
        <label>Stack Name *</label>
        <input type="text" id="gs-name" class="form-control" placeholder="my-app" pattern="[a-z0-9][a-z0-9_-]*">
        <small class="text-muted">Lowercase, hyphens, underscores. Used as compose project name.</small>
      </div>
      <div class="form-group">
        <label>Repository URL *</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="gs-repo-url" class="form-control" style="flex:1" placeholder="https://github.com/user/repo.git">
          <button type="button" class="btn btn-sm btn-secondary" id="gs-test-conn"><i class="fas fa-plug"></i> Test</button>
        </div>
      </div>
      <div style="display:flex;gap:16px">
        <div class="form-group" style="flex:1">
          <label>Branch</label>
          <select id="gs-branch" class="form-control"><option value="main">main</option></select>
        </div>
        <div class="form-group" style="flex:1">
          <label>Compose File</label>
          <input type="text" id="gs-compose-path" class="form-control" value="docker-compose.yml">
        </div>
      </div>
      <div class="form-group">
        <label>Credential</label>
        <select id="gs-credential" class="form-control">
          <option value="">-- None (public repo) --</option>
          ${credentials.map(c => `<option value="${c.id}">${Utils.escapeHtml(c.name)} (${c.auth_type})</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Deployment Targets *</label>
        <div id="gs-targets" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;padding:10px;border:1px solid var(--border);border-radius:6px;max-height:180px;overflow:auto">
          ${this._targetSelectorHtml(dockerHosts, selectedIds)}
        </div>
        <small class="text-muted">Deploys are sequential by default. Progressive waves can be enabled below. Bind-mount source paths must exist on every target host.</small>
      </div>
      <div id="gs-test-result" style="display:none;margin-bottom:12px"></div>
      <details style="margin-bottom:12px">
        <summary style="cursor:pointer;color:var(--text-muted);font-size:13px"><i class="fas fa-cog"></i> Advanced Options</summary>
        <div style="padding-top:8px">
          <div class="form-group"><label><input type="checkbox" id="gs-force" checked> Force redeploy (overwrite local changes)</label></div>
          <div class="form-group"><label><input type="checkbox" id="gs-pull-images"> Re-pull images on update</label></div>
          <div class="form-group"><label><input type="checkbox" id="gs-tls-skip"> Skip TLS verification (self-signed certs)</label></div>
          <div class="form-group"><label><input type="checkbox" id="gs-rollout-enabled"> Progressive rollout with health gates</label></div>
          <div id="gs-rollout-create-options" style="display:none;padding:10px;border:1px solid var(--border);border-radius:6px">
            <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
              <div class="form-group"><label>Wave strategy</label><select id="gs-rollout-strategy" class="form-control"><option value="fixed">Fixed</option><option value="exponential">Exponential</option></select></div>
              <div class="form-group"><label>On failure</label><select id="gs-rollout-failure" class="form-control"><option value="pause">Pause</option><option value="rollback">Rollback attempted targets</option><option value="continue">Continue</option></select></div>
              <div class="form-group"><label>Initial wave</label><input id="gs-rollout-wave" type="number" min="1" max="50" value="1" class="form-control"></div>
              <div class="form-group"><label>Max parallel</label><input id="gs-rollout-parallel" type="number" min="1" max="10" value="3" class="form-control"></div>
              <div class="form-group"><label>Delay between waves (seconds)</label><input id="gs-rollout-delay" type="number" min="0" max="3600" value="0" class="form-control"></div>
              <div class="form-group"><label>Health timeout (seconds)</label><input id="gs-rollout-timeout" type="number" min="1" max="900" value="120" class="form-control"></div>
            </div>
          </div>
        </div>
      </details>
    `, {
      title: '<i class="fab fa-git-alt" style="margin-right:8px"></i> Deploy from Git Repository',
      width: '680px',
      onSubmit: (content) => {
        const stack_name = content.querySelector('#gs-name').value.trim();
        const repo_url = content.querySelector('#gs-repo-url').value.trim();
        if (!stack_name || !repo_url) { Toast.warning('Stack name and repo URL are required'); return false; }
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(stack_name)) { Toast.warning('Stack name must be lowercase alphanumeric with hyphens/underscores'); return false; }
        const target_host_ids = [...content.querySelectorAll('[data-git-target]:checked')]
          .map(input => parseInt(input.value));
        if (!target_host_ids.length) { Toast.warning('Select at least one deployment target'); return false; }

        const data = {
          stack_name, repo_url, target_host_ids,
          branch: content.querySelector('#gs-branch').value,
          compose_path: content.querySelector('#gs-compose-path').value.trim() || 'docker-compose.yml',
          force_redeploy: content.querySelector('#gs-force').checked,
          re_pull_images: content.querySelector('#gs-pull-images').checked,
          tls_skip_verify: content.querySelector('#gs-tls-skip').checked,
          rollout_policy: {
            enabled: content.querySelector('#gs-rollout-enabled').checked,
            strategy: content.querySelector('#gs-rollout-strategy').value,
            initialWave: parseInt(content.querySelector('#gs-rollout-wave').value),
            multiplier: 2,
            maxParallel: parseInt(content.querySelector('#gs-rollout-parallel').value),
            delaySeconds: parseInt(content.querySelector('#gs-rollout-delay').value),
            healthGate: true,
            healthTimeoutSeconds: parseInt(content.querySelector('#gs-rollout-timeout').value),
            onFailure: content.querySelector('#gs-rollout-failure').value,
          },
        };
        const credId = content.querySelector('#gs-credential').value;
        if (credId) data.credential_id = parseInt(credId);
        return data;
      },
      onOpen: (content) => {
        const rolloutToggle = content.querySelector('#gs-rollout-enabled');
        const rolloutOptions = content.querySelector('#gs-rollout-create-options');
        rolloutToggle.addEventListener('change', () => {
          rolloutOptions.style.display = rolloutToggle.checked ? 'block' : 'none';
        });
        const testBtn = content.querySelector('#gs-test-conn');
        testBtn.addEventListener('click', async () => {
          const repo_url = content.querySelector('#gs-repo-url').value.trim();
          if (!repo_url) { Toast.warning('Enter a repository URL first'); return; }

          const resultEl = content.querySelector('#gs-test-result');
          resultEl.style.display = 'block';
          resultEl.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Testing connection...</div>';

          const body = { repo_url };
          const credId = content.querySelector('#gs-credential').value;
          if (credId) body.credential_id = parseInt(credId);

          try {
            const res = await Api.testGitConnection(body);
            if (res.ok) {
              resultEl.innerHTML = `<div style="color:var(--green)"><i class="fas fa-check-circle"></i> Connection successful. ${res.branches.length} branch(es) found.</div>`;
              const branchSel = content.querySelector('#gs-branch');
              branchSel.innerHTML = res.branches.map(b => `<option value="${Utils.escapeHtml(b)}" ${b === 'main' || b === 'master' ? 'selected' : ''}>${Utils.escapeHtml(b)}</option>`).join('');
            } else {
              resultEl.innerHTML = `<div style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(res.error || 'Connection failed')}</div>`;
            }
          } catch (err) {
            resultEl.innerHTML = `<div style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div>`;
          }
        });
      },
    });

    if (result) {
      try {
        const created = await Api.createGitStack(result);
        Toast.success(`Git stack "${result.stack_name}" created. Cloning repository...`);
        location.hash = `#/git-stacks/${created.id}`;
      } catch (err) {
        Toast.error(err.message);
      }
    }
  },

  // ─── Detail View ─────────────────────────────────

  async _renderDetail(container) {
    container.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;

    try {
      const stack = await Api.getGitStack(this._stackId);
      if (!stack) { container.innerHTML = '<div class="empty-msg">Git stack not found</div>'; return; }

      container.innerHTML = `
        <div class="page-header">
          <h2>
            <i class="fab fa-git-alt" style="color:var(--accent);margin-right:8px"></i>
            ${Utils.escapeHtml(stack.stack_name)}
            <span class="badge ${this._statusBadge(stack.status)}" style="margin-left:8px">${stack.status}</span>
          </h2>
          <div class="page-actions">
            <button class="btn btn-sm btn-secondary" id="gs-back"><i class="fas fa-arrow-left"></i> Back</button>
            <button class="btn btn-sm btn-secondary" id="gs-edit-push"><i class="fas fa-edit"></i> Edit</button>
            <button class="btn btn-sm btn-secondary" id="gs-diff"><i class="fas fa-code-branch"></i> Diff</button>
            <button class="btn btn-sm btn-secondary" id="gs-check"><i class="fas fa-search"></i> Check</button>
            <button class="btn btn-sm btn-secondary" id="gs-drift-scan"><i class="fas fa-wave-square"></i> Scan Drift</button>
            <button class="btn btn-sm btn-primary" id="gs-redeploy" ${stack.status === 'deploying' || stack.status === 'cloning' ? 'disabled' : ''}>
              <i class="fas fa-sync"></i> Redeploy
            </button>
            <button class="btn btn-sm btn-danger" id="gs-delete"><i class="fas fa-trash"></i></button>
          </div>
        </div>

        ${stack.error_message ? `
          <div class="card" style="border-left:3px solid var(--red);margin-bottom:16px">
            <div class="card-body" style="color:var(--red)">
              <strong><i class="fas fa-exclamation-triangle"></i> Error:</strong> ${Utils.escapeHtml(stack.error_message)}
            </div>
          </div>
        ` : ''}

        <div class="info-grid" style="margin-top:0">
          <div class="card">
            <div class="card-header"><h3><i class="fas fa-info-circle" style="margin-right:8px"></i>Git Source</h3></div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>Repository</td><td class="mono text-sm" style="word-break:break-all">${Utils.escapeHtml(stack.repo_url)}</td></tr>
                <tr><td>Branch</td><td><span class="badge badge-info">${Utils.escapeHtml(stack.branch)}</span></td></tr>
                <tr><td>Compose</td><td class="mono">${Utils.escapeHtml(stack.compose_path)}</td></tr>
                <tr><td>Credential</td><td>${stack.credential_name ? Utils.escapeHtml(stack.credential_name) : '<span class="text-muted">None</span>'}</td></tr>
                ${stack.last_commit_hash ? `<tr><td>Commit</td><td class="mono">${stack.last_commit_hash} — "${Utils.escapeHtml((stack.last_commit_message || '').substring(0, 60))}"</td></tr>` : ''}
                ${stack.last_deployed_at ? `<tr><td>Deployed</td><td>${Utils.timeAgo(stack.last_deployed_at)}</td></tr>` : ''}
                <tr><td>Deploys</td><td>${stack.deployment_count || 0}</td></tr>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3><i class="fas fa-robot" style="margin-right:8px"></i>Auto-Deploy</h3>
              <button class="btn btn-sm btn-secondary" id="gs-webhook-setup"><i class="fas fa-cog"></i></button>
            </div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>Webhook</td><td>${stack.webhook_token ? '<span class="text-green">Configured</span>' : '<span class="text-muted">Not set</span>'}</td></tr>
                <tr><td>Provider</td><td>${Utils.escapeHtml(stack.webhook_provider || 'github')}</td></tr>
                <tr><td>Polling</td><td>${stack.polling_enabled ? `<span class="text-green">Every ${stack.polling_interval_seconds}s</span>` : '<span class="text-muted">Off</span>'}</td></tr>
                <tr><td>Auto-deploy</td><td>${stack.deploy_on_push ? '<span class="text-green">Yes</span>' : 'Notify only'}</td></tr>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3><i class="fas fa-layer-group" style="margin-right:8px"></i>Rollout Policy</h3>
              <button class="btn btn-sm btn-secondary" id="gs-rollout-setup" ${stack.status === 'deploying' || stack.status === 'cloning' ? 'disabled' : ''}><i class="fas fa-cog"></i></button>
            </div>
            <div class="card-body">${this._rolloutPolicyHtml(stack.rollout_policy)}</div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3><i class="fas fa-code-pull-request" style="margin-right:8px"></i>PR Previews</h3>
              <button class="btn btn-sm btn-secondary" id="gs-preview-setup"><i class="fas fa-cog"></i></button>
            </div>
            <div class="card-body" id="gs-preview-summary"><span class="text-muted text-sm">Loading preview policy…</span></div>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-header">
            <h3><i class="fas fa-server" style="margin-right:8px"></i>Deployment Targets (${(stack.targets || []).length})</h3>
            <button class="btn btn-sm btn-secondary" id="gs-manage-targets" ${stack.status === 'deploying' || stack.status === 'cloning' ? 'disabled' : ''}><i class="fas fa-cog"></i> Manage</button>
          </div>
          <div class="card-body" style="padding:0;overflow:auto">
            <table class="table">
              <thead><tr><th>Host</th><th>Connection</th><th>Last status</th><th>Commit</th><th>Last attempt</th></tr></thead>
              <tbody>
                ${(stack.targets || []).map(target => `
                  <tr>
                    <td><strong>${Utils.escapeHtml(target.host_name || `Host ${target.host_id}`)}</strong><div class="text-sm text-muted">${Utils.escapeHtml(target.environment || '')}</div></td>
                    <td><span class="badge badge-info">${Utils.escapeHtml(target.connection_type || 'socket')}</span></td>
                    <td><span class="badge ${this._targetStatusBadge(target.last_deploy_status)}">${Utils.escapeHtml(target.last_deploy_status || 'never')}</span>${target.last_deploy_error ? `<div class="text-sm" style="color:var(--red);margin-top:4px">${Utils.escapeHtml(target.last_deploy_error)}</div>` : ''}</td>
                    <td class="mono text-sm">${Utils.escapeHtml(target.last_deployed_commit || '—')}</td>
                    <td class="text-sm text-muted">${target.last_deployed_at ? Utils.timeAgo(target.last_deployed_at) : 'Never'}</td>
                  </tr>
                `).join('') || '<tr><td colspan="5" class="text-muted">No deployment targets configured.</td></tr>'}
              </tbody>
            </table>
          </div>
          <div class="card-body text-sm text-muted" style="border-top:1px solid var(--border)"><i class="fas fa-info-circle"></i> Bind-mount source paths are resolved by each remote Docker daemon and must exist on every target.</div>
        </div>

        <div id="gs-drift-panel" style="margin-top:16px"></div>
        <div id="gs-update-result" style="margin-top:16px"></div>
        <div id="gs-deployments" style="margin-top:16px"></div>
      `;

      container.querySelector('#gs-back').addEventListener('click', () => { location.hash = '#/git-stacks'; });
      container.querySelector('#gs-check').addEventListener('click', () => this._checkUpdates(stack));
      container.querySelector('#gs-edit-push').addEventListener('click', () => this._editAndPush(stack));
      container.querySelector('#gs-diff').addEventListener('click', () => this._showDiff(stack));
      container.querySelector('#gs-redeploy').addEventListener('click', () => this._redeploy(stack));
      container.querySelector('#gs-delete').addEventListener('click', () => this._deleteStack(stack));
      container.querySelector('#gs-webhook-setup').addEventListener('click', () => this._configureAutoDeploy(stack));
      container.querySelector('#gs-drift-scan').addEventListener('click', () => this._scanDrift(stack));
      container.querySelector('#gs-manage-targets').addEventListener('click', () => this._manageTargets(stack));
      container.querySelector('#gs-rollout-setup').addEventListener('click', () => this._configureRollout(stack));
      container.querySelector('#gs-preview-setup').addEventListener('click', () => this._configurePreviews(stack));

      // Load deployment history + stored drift
      this._loadDeployments(stack.id);
      this._loadDriftPanel(stack.id);
      this._loadPreviewSummary(stack.id);

      // Auto-refresh if deploying/cloning
      if (stack.status === 'deploying' || stack.status === 'cloning') {
        this._pollTimer = setTimeout(() => this._renderDetail(container), 3000);
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _loadDeployments(stackId) {
    const el = document.getElementById('gs-deployments');
    if (!el) return;

    try {
      const data = await Api.getGitDeployments(stackId, { limit: 10 });
      if (!data.rows || data.rows.length === 0) {
        el.innerHTML = '';
        return;
      }

      el.innerHTML = `
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-history" style="margin-right:8px"></i>Deployment History</h3></div>
          <div class="card-body" style="padding:0">
            <table class="data-table">
              <thead><tr><th>#</th><th>Commit</th><th>Message</th><th>Trigger</th><th>Status</th><th>Duration</th><th>When</th><th></th></tr></thead>
              <tbody>${data.rows.map(d => `
                <tr>
                  <td class="text-sm">${d.id}</td>
                  <td class="mono text-sm">${(d.commit_hash || '').substring(0, 7)}</td>
                  <td class="text-sm">${Utils.escapeHtml((d.commit_message || '').substring(0, 50))}</td>
                  <td><span class="badge ${d.trigger_type === 'webhook' ? 'badge-info' : d.trigger_type === 'polling' ? 'badge-warning' : ''}" style="font-size:10px">${d.trigger_type}</span></td>
                  <td><span class="badge ${d.status === 'success' ? 'badge-running' : d.status === 'failed' ? 'badge-danger' : d.status === 'rolled_back' ? 'badge-warning' : 'badge-info'}" style="font-size:10px">${d.status}</span>${this._deploymentTargetSummary(d.target_results)}</td>
                  <td class="text-sm">${d.duration_ms ? (d.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
                  <td class="text-sm">${Utils.timeAgo(d.started_at)}</td>
                  <td>${d.status === 'success' ? `<button class="action-btn" data-action="rollback" data-id="${d.id}" title="Rollback to this deploy"><i class="fas fa-undo"></i></button>` : ''}</td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        </div>
      `;

      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action="rollback"]');
        if (!btn) return;
        const deployId = parseInt(btn.dataset.id);
        const ok = await Modal.confirm('Rollback to this deployment? This will checkout the previous commit and redeploy.', { confirmText: 'Rollback', danger: true });
        if (!ok) return;
        try {
          await Api.rollbackGitStack(stackId, deployId);
          Toast.success('Rollback initiated');
          setTimeout(() => this._renderDetail(document.getElementById('page-content')), 1500);
        } catch (err) { Toast.error(err.message); }
      });
    } catch (err) {
      el.innerHTML = `<div class="text-sm text-muted">Could not load deployment history</div>`;
    }
  },

  async _showDiff(stack) {
    const el = document.getElementById('gs-update-result');
    if (!el) return;
    el.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading diff...</div>';

    try {
      const diff = await Api.getGitDiff(stack.id);
      if (!diff.hasChanges) {
        el.innerHTML = `<div class="card" style="border-left:3px solid var(--green)"><div class="card-body" style="color:var(--green)"><i class="fas fa-check-circle"></i> No changes. Stack is at latest commit (${diff.localCommit}).</div></div>`;
        return;
      }

      el.innerHTML = `
        <div class="card" style="border-left:3px solid var(--yellow)">
          <div class="card-header"><h3><i class="fas fa-code-branch" style="color:var(--yellow);margin-right:8px"></i>Changes: ${diff.localCommit} → ${diff.remoteCommit}</h3></div>
          <div class="card-body">
            ${diff.commitsBetween?.length ? `
              <div style="margin-bottom:12px">
                <strong>${diff.commitsBetween.length} commit(s):</strong>
                <div style="margin-top:4px">${diff.commitsBetween.map(c => `<div class="text-sm"><span class="mono">${c.hash}</span> ${Utils.escapeHtml(c.message)} <span class="text-muted">— ${Utils.escapeHtml(c.author)}</span></div>`).join('')}</div>
              </div>
            ` : ''}
            ${diff.filesChanged?.length ? `
              <div style="margin-bottom:12px">
                <strong>Files changed:</strong>
                <div style="margin-top:4px">${diff.filesChanged.map(f => `<div class="text-sm mono"><span class="text-green">+${f.additions}</span> <span class="text-red">-${f.deletions}</span> ${Utils.escapeHtml(f.path)}</div>`).join('')}</div>
              </div>
            ` : ''}
            ${diff.diff ? `<details><summary class="text-sm" style="cursor:pointer;color:var(--text-muted)">Show raw diff</summary><pre style="max-height:300px;overflow:auto;font-size:11px;background:var(--surface2);padding:12px;border-radius:4px;margin-top:8px">${Utils.escapeHtml(diff.diff)}</pre></details>` : ''}
            <button class="btn btn-primary" id="gs-deploy-diff" style="margin-top:12px"><i class="fas fa-rocket"></i> Deploy These Changes</button>
          </div>
        </div>
      `;

      el.querySelector('#gs-deploy-diff')?.addEventListener('click', () => this._redeploy(stack));
    } catch (err) {
      el.innerHTML = `<div class="card"><div class="card-body" style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div></div>`;
    }
  },

  async _configureAutoDeploy(stack) {
    // Get current webhook URL
    let webhookInfo = { configured: false };
    try { webhookInfo = await Api.getWebhookUrl(stack.id); } catch {}

    const result = await Modal.form(`
      <div class="form-group">
        <label>Webhook Provider</label>
        <select id="ad-provider" class="form-control">
          ${['github', 'gitlab', 'gitea', 'bitbucket', 'generic'].map(p => `<option value="${p}" ${(stack.webhook_provider || 'github') === p ? 'selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Webhook URL</label>
        ${webhookInfo.configured ? `
          <div class="mono text-sm" style="word-break:break-all;padding:8px;background:var(--surface2);border-radius:4px;margin-bottom:4px">${Utils.escapeHtml(webhookInfo.webhookUrl)}</div>
          <div class="text-sm text-muted">Secret: <span class="mono">${Utils.escapeHtml(webhookInfo.webhookSecret || '')}</span></div>
        ` : '<div class="text-muted text-sm">Not generated yet. Click "Generate Webhook" below.</div>'}
        <button type="button" class="btn btn-sm btn-secondary" id="ad-regen" style="margin-top:8px"><i class="fas fa-sync"></i> ${webhookInfo.configured ? 'Regenerate' : 'Generate'} Webhook</button>
        <div id="ad-webhook-result"></div>
      </div>
      <hr class="divider">
      <div class="form-group">
        <label><input type="checkbox" id="ad-polling" ${stack.polling_enabled ? 'checked' : ''}> Enable Polling</label>
      </div>
      <div class="form-group">
        <label>Polling Interval (seconds)</label>
        <input type="number" id="ad-interval" class="form-control" value="${stack.polling_interval_seconds || 300}" min="60" step="60">
        <small class="text-muted">Minimum 60 seconds</small>
      </div>
      <hr class="divider">
      <div class="form-group">
        <label><input type="checkbox" id="ad-auto-deploy" ${stack.deploy_on_push !== false && stack.deploy_on_push !== 0 ? 'checked' : ''}> Auto-deploy on change</label>
        <small class="text-muted">If unchecked, changes are detected but not deployed (notify only)</small>
      </div>
    `, {
      title: '<i class="fas fa-robot" style="margin-right:8px"></i> Auto-Deploy Configuration',
      width: '520px',
      onSubmit: (content) => ({
        webhook_provider: content.querySelector('#ad-provider').value,
        polling_enabled: content.querySelector('#ad-polling').checked,
        polling_interval_seconds: Math.max(60, parseInt(content.querySelector('#ad-interval').value) || 300),
        deploy_on_push: content.querySelector('#ad-auto-deploy').checked,
      }),
      onOpen: (content) => {
        content.querySelector('#ad-regen').addEventListener('click', async () => {
          const resultEl = content.querySelector('#ad-webhook-result');
          resultEl.innerHTML = '<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin"></i> Generating...</div>';
          try {
            const res = await Api.regenerateWebhook(stack.id);
            resultEl.innerHTML = `
              <div style="margin-top:8px;padding:8px;background:var(--surface2);border-radius:4px">
                <div class="text-sm"><strong>URL:</strong> <span class="mono" style="word-break:break-all">${Utils.escapeHtml(res.webhookUrl)}</span></div>
                <div class="text-sm"><strong>Secret:</strong> <span class="mono">${Utils.escapeHtml(res.webhookSecret)}</span></div>
              </div>
            `;
            Toast.success('Webhook URL generated');
          } catch (err) {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--red)">${Utils.escapeHtml(err.message)}</div>`;
          }
        });
      },
    });

    if (result) {
      try {
        await Api.updateAutoDeployConfig(stack.id, result);
        Toast.success('Auto-deploy settings saved');
        this._renderDetail(document.getElementById('page-content'));
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _checkUpdates(stack) {
    const el = document.getElementById('gs-update-result');
    if (!el) return;
    el.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Checking for updates...</div>';

    try {
      const result = await Api.checkGitStack(stack.id);
      if (result.has_updates) {
        el.innerHTML = `
          <div class="card" style="border-left:3px solid var(--yellow)">
            <div class="card-header"><h3><i class="fas fa-arrow-circle-down" style="color:var(--yellow);margin-right:8px"></i>${result.commits_behind} new commit(s) available</h3></div>
            <div class="card-body">
              <table class="data-table">
                <thead><tr><th>Commit</th><th>Message</th><th>Author</th><th>Date</th></tr></thead>
                <tbody>${result.new_commits.map(c => `
                  <tr>
                    <td class="mono">${c.hash}</td>
                    <td>${Utils.escapeHtml(c.message)}</td>
                    <td>${Utils.escapeHtml(c.author)}</td>
                    <td class="text-sm">${Utils.timeAgo(c.date)}</td>
                  </tr>
                `).join('')}</tbody>
              </table>
              <button class="btn btn-primary" id="gs-deploy-updates" style="margin-top:12px">
                <i class="fas fa-rocket"></i> Deploy These Updates
              </button>
            </div>
          </div>
        `;
        el.querySelector('#gs-deploy-updates')?.addEventListener('click', () => this._redeploy(stack));
      } else {
        el.innerHTML = `
          <div class="card" style="border-left:3px solid var(--green)">
            <div class="card-body" style="color:var(--green)">
              <i class="fas fa-check-circle"></i> Stack is up to date (${result.local_commit})
            </div>
          </div>
        `;
      }
    } catch (err) {
      el.innerHTML = `<div class="card"><div class="card-body" style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div></div>`;
    }
  },

  async _configureRollout(stack) {
    const policy = {
      enabled: false, strategy: 'fixed', initialWave: 1, multiplier: 2,
      maxParallel: 3, delaySeconds: 0, healthGate: true,
      healthTimeoutSeconds: 120, onFailure: 'pause',
      ...(stack.rollout_policy || {}),
    };
    const result = await Modal.form(`
      <div class="form-group"><label><input type="checkbox" id="gs-r-enabled" ${policy.enabled ? 'checked' : ''}> Enable progressive rollout</label></div>
      <div id="gs-r-options" style="${policy.enabled ? '' : 'display:none;'}padding:10px;border:1px solid var(--border);border-radius:6px">
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
          <div class="form-group"><label>Wave strategy</label><select id="gs-r-strategy" class="form-control"><option value="fixed" ${policy.strategy === 'fixed' ? 'selected' : ''}>Fixed size</option><option value="exponential" ${policy.strategy === 'exponential' ? 'selected' : ''}>Exponential growth</option></select></div>
          <div class="form-group"><label>Failure action</label><select id="gs-r-failure" class="form-control"><option value="pause" ${policy.onFailure === 'pause' ? 'selected' : ''}>Pause before next wave</option><option value="rollback" ${policy.onFailure === 'rollback' ? 'selected' : ''}>Rollback attempted targets</option><option value="continue" ${policy.onFailure === 'continue' ? 'selected' : ''}>Continue remaining waves</option></select></div>
          <div class="form-group"><label>Initial/fixed wave size</label><input id="gs-r-wave" type="number" min="1" max="50" value="${policy.initialWave}" class="form-control"></div>
          <div class="form-group"><label>Growth multiplier</label><input id="gs-r-multiplier" type="number" min="2" max="10" value="${policy.multiplier}" class="form-control"></div>
          <div class="form-group"><label>Maximum parallel targets</label><input id="gs-r-parallel" type="number" min="1" max="10" value="${policy.maxParallel}" class="form-control"></div>
          <div class="form-group"><label>Delay between waves (seconds)</label><input id="gs-r-delay" type="number" min="0" max="3600" value="${policy.delaySeconds}" class="form-control"></div>
          <div class="form-group"><label>Health timeout (seconds)</label><input id="gs-r-timeout" type="number" min="1" max="900" value="${policy.healthTimeoutSeconds}" class="form-control"></div>
          <div class="form-group" style="display:flex;align-items:flex-end"><label><input type="checkbox" id="gs-r-health" ${policy.healthGate ? 'checked' : ''}> Gate each wave on container health</label></div>
        </div>
        <div class="text-sm text-muted"><i class="fas fa-info-circle"></i> A wave completes only after all its targets finish. Already-started targets are not cancelled when a peer fails.</div>
      </div>
    `, {
      title: 'Configure Progressive Rollout', width: '680px', confirmText: 'Save Policy',
      onOpen: (content) => {
        const enabled = content.querySelector('#gs-r-enabled');
        enabled.addEventListener('change', () => {
          content.querySelector('#gs-r-options').style.display = enabled.checked ? 'block' : 'none';
        });
      },
      onSubmit: (content) => {
        const values = {
          initialWave: parseInt(content.querySelector('#gs-r-wave').value),
          multiplier: parseInt(content.querySelector('#gs-r-multiplier').value),
          maxParallel: parseInt(content.querySelector('#gs-r-parallel').value),
          delaySeconds: parseInt(content.querySelector('#gs-r-delay').value),
          healthTimeoutSeconds: parseInt(content.querySelector('#gs-r-timeout').value),
        };
        if (Object.values(values).some(value => !Number.isInteger(value))) {
          Toast.warning('All rollout limits must be whole numbers');
          return false;
        }
        return {
          enabled: content.querySelector('#gs-r-enabled').checked,
          strategy: content.querySelector('#gs-r-strategy').value,
          ...values,
          healthGate: content.querySelector('#gs-r-health').checked,
          onFailure: content.querySelector('#gs-r-failure').value,
        };
      },
    });
    if (!result) return;
    try {
      await Api.updateGitRolloutPolicy(stack.id, result);
      Toast.success(result.enabled ? 'Progressive rollout enabled' : 'Sequential rollout restored');
      await this._renderDetail(document.getElementById('page-content'));
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _manageTargets(stack) {
    try {
      const hosts = (await Api.getHosts())
        .filter(h => h.isActive && ['docker', 'podman'].includes(h.daemonType || 'docker'));
      const selectedIds = new Set((stack.targets || []).map(target => target.host_id));
      const result = await Modal.form(`
        <p class="text-sm text-muted">Choose every Docker-compatible host that should receive this stack.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;padding:10px;border:1px solid var(--border);border-radius:6px;max-height:300px;overflow:auto">
          ${this._targetSelectorHtml(hosts, selectedIds)}
        </div>
        <div class="text-sm text-muted" style="margin-top:10px"><i class="fas fa-exclamation-triangle"></i> Bind-mount source paths must exist on every selected host.</div>
      `, {
        title: 'Manage Deployment Targets', width: '620px', confirmText: 'Save Targets',
        onSubmit: (content) => {
          const hostIds = [...content.querySelectorAll('[data-git-target]:checked')]
            .map(input => parseInt(input.value));
          if (!hostIds.length) { Toast.warning('Select at least one deployment target'); return false; }
          return hostIds;
        },
      });
      if (!result) return;
      await Api.setGitStackTargets(stack.id, result);
      Toast.success('Deployment targets updated');
      await this._renderDetail(document.getElementById('page-content'));
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _redeploy(stack) {
    const targetCount = (stack.targets || []).length || 1;
    const ok = await Modal.confirm(
      `Pull latest changes and redeploy "${stack.stack_name || ''}" to ${targetCount} target${targetCount === 1 ? '' : 's'}?`,
      { confirmText: 'Redeploy' }
    );
    if (!ok) return;
    try {
      await Api.deployGitStack(stack.id, { force: true });
      Toast.success('Deployment started');
      // Refresh detail to show deploying status
      setTimeout(() => this._renderDetail(document.getElementById('page-content')), 1000);
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _deleteStack(stack) {
    const result = await Modal.form(`
      <p>Delete Git stack "<strong>${Utils.escapeHtml(stack.stack_name)}</strong>"?</p>
      <div class="form-group"><label><input type="checkbox" id="gs-rm-containers"> Also stop and remove containers</label></div>
      <div class="form-group"><label><input type="checkbox" id="gs-rm-volumes"> Also remove volumes</label></div>
    `, {
      title: 'Delete Git Stack',
      width: '420px',
      confirmText: 'Delete',
      danger: true,
      onSubmit: (content) => ({
        removeContainers: content.querySelector('#gs-rm-containers').checked,
        removeVolumes: content.querySelector('#gs-rm-volumes').checked,
      }),
    });

    if (result) {
      try {
        await Api.deleteGitStack(stack.id, {
          removeContainers: result.removeContainers,
          removeVolumes: result.removeVolumes,
        });
        Toast.success('Git stack deleted');
        location.hash = '#/git-stacks';
      } catch (err) { Toast.error(err.message); }
    }
  },

  // ─── Edit & Push ─────────────────────────────────

  async _editAndPush(stack) {
    // Read current compose file content from the detail
    const composeFile = stack.compose_path || 'docker-compose.yml';

    let editor = null;
    const result = await Modal.form(`
      <div class="form-group">
        <label>File: <span class="mono">${Utils.escapeHtml(composeFile)}</span></label>
        <textarea id="ep-content" class="form-control"># Loading compose file…</textarea>
      </div>
      <div class="form-group">
        <label>Commit Message *</label>
        <input type="text" id="ep-message" class="form-control" placeholder="fix: update service configuration" required>
      </div>
      <div id="ep-remote-status" style="margin-bottom:8px"></div>
    `, {
      title: '<i class="fas fa-edit" style="margin-right:8px"></i> Edit & Push to Git',
      width: '700px',
      confirmText: 'Commit & Push',
      onSubmit: async (content) => {
        const fileContent = editor.getValue();
        const message = content.querySelector('#ep-message').value.trim();
        if (!message) { Toast.warning('Commit message is required'); return false; }
        if (!fileContent.trim()) { Toast.warning('File content cannot be empty'); return false; }
        const local = editor.validate();
        if (!local.valid) { editor.focus(); Toast.warning('Fix the YAML syntax error first'); return false; }
        try {
          const validation = await Api.validateStackConfig(stack.stack_name, { config: fileContent });
          if (!validation.valid) {
            Toast.error(validation.error || 'Docker Compose validation failed');
            editor.focus();
            return false;
          }
        } catch (err) { Toast.error(err.message); return false; }
        return { files: { [composeFile]: fileContent }, commitMessage: message };
      },
      onMount: async (content) => {
        editor = YamlEditor.mount(content.querySelector('#ep-content'), { minHeight: 420 });
        const statusEl = content.querySelector('#ep-remote-status');
        const [fileResult, remoteResult] = await Promise.allSettled([
          Api.getGitStackFile(stack.id, composeFile), Api.getRemoteStatus(stack.id),
        ]);
        if (fileResult.status === 'fulfilled') editor.setValue(fileResult.value.content);
        else {
          editor.setValue('');
          statusEl.innerHTML = `<div style="color:var(--red);font-size:13px">${Utils.escapeHtml(fileResult.reason.message)}</div>`;
        }
        if (remoteResult.status === 'fulfilled'
          && !remoteResult.value.isUpToDate && remoteResult.value.localBehind > 0) {
          statusEl.innerHTML += `<div style="color:var(--yellow);font-size:13px"><i class="fas fa-exclamation-triangle"></i> Remote is ${remoteResult.value.localBehind} commit(s) ahead. Consider pulling first.</div>`;
        }
      },
    });
    editor?.destroy();

    if (result) {
      try {
        const res = await Api.pushToGit(stack.id, result);
        Toast.success(`Pushed to Git (${res.commitHash})`);
        this._renderDetail(document.getElementById('page-content'));
      } catch (err) {
        if (err.message?.includes('newer changes')) {
          const force = await Modal.confirm('Remote has newer changes. Force push? This will overwrite remote.', { danger: true, confirmText: 'Force Push' });
          if (force) {
            try {
              const res = await Api.pushToGit(stack.id, { ...result, forcePush: true });
              Toast.success(`Force pushed to Git (${res.commitHash})`);
              this._renderDetail(document.getElementById('page-content'));
            } catch (e) { Toast.error(e.message); }
          }
        } else {
          Toast.error(err.message);
        }
      }
    }
  },

  // ─── Helpers ─────────────────────────────────────

  // ─── Drift detection (v8.3.0) ─────────────────────────────
  async _loadDriftPanel(stackId) {
    const el = document.getElementById('gs-drift-panel');
    if (!el) return;
    try {
      const drift = await Api.getGitDrift(stackId);
      this._renderDriftPanel(el, drift);
    } catch {
      el.innerHTML = '';
    }
  },

  async _scanDrift(stack) {
    const el = document.getElementById('gs-drift-panel');
    if (el) el.innerHTML = `<div class="card"><div class="card-body text-muted"><i class="fas fa-spinner fa-spin"></i> Scanning drift…</div></div>`;
    try {
      const drift = await Api.scanGitDrift(stack.id);
      if (el) this._renderDriftPanel(el, drift);
      Toast.success(drift.inSync ? 'In sync with git' : `${drift.drifts.length} drift(s) detected`);
    } catch (err) {
      Toast.error('Drift scan failed: ' + err.message);
      if (el) el.innerHTML = '';
    }
  },

  _renderDriftPanel(el, drift) {
    if (!drift || (!drift.checkedAt && !drift.error)) {
      el.innerHTML = `
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-wave-square" style="margin-right:8px"></i>Drift Detection</h3></div>
          <div class="card-body text-muted text-sm">Not scanned yet. Click <strong>Scan Drift</strong> to compare every deployment target against the git-checked-out compose. Runs automatically every 5 minutes.</div>
        </div>`;
      return;
    }

    const driftRow = (d) => {
      const labels = {
        missing: { icon: 'fa-ghost', color: 'var(--red)', text: `Service <strong>${Utils.escapeHtml(d.service)}</strong> is declared in git but has no container (expected <code>${Utils.escapeHtml(d.expected || '')}</code>)` },
        extra: { icon: 'fa-plus-circle', color: 'var(--yellow)', text: `Container <strong>${Utils.escapeHtml(d.container || '')}</strong> (service ${Utils.escapeHtml(d.service)}) is running but NOT declared in git` },
        stopped: { icon: 'fa-stop-circle', color: 'var(--yellow)', text: `Service <strong>${Utils.escapeHtml(d.service)}</strong> exists but is <code>${Utils.escapeHtml(d.state || 'not running')}</code>` },
        image_mismatch: { icon: 'fa-exchange-alt', color: 'var(--accent)', text: `Service <strong>${Utils.escapeHtml(d.service)}</strong> runs <code>${Utils.escapeHtml(d.actual || '')}</code> but git declares <code>${Utils.escapeHtml(d.expected || '')}</code>` },
        scan_error: { icon: 'fa-question-circle', color: 'var(--red)', text: `Could not scan this target: ${Utils.escapeHtml(d.error || 'unknown error')}` },
      };
      const l = labels[d.type] || { icon: 'fa-question', color: 'var(--text-muted)', text: Utils.escapeHtml(JSON.stringify(d)) };
      return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
        <i class="fas ${l.icon}" style="color:${l.color};margin-top:3px;width:18px;text-align:center"></i>
        <div class="text-sm">${d.hostName ? `<span class="badge badge-info" style="margin-right:6px">${Utils.escapeHtml(d.hostName)}</span>` : ''}${l.text}</div>
      </div>`;
    };

    if (drift.error) {
      el.innerHTML = `
        <div class="card" style="border-left:3px solid var(--text-muted)">
          <div class="card-header"><h3><i class="fas fa-wave-square" style="margin-right:8px"></i>Drift Detection</h3></div>
          <div class="card-body text-muted text-sm"><i class="fas fa-question-circle"></i> Could not scan: ${Utils.escapeHtml(drift.error)}</div>
        </div>`;
      return;
    }

    if (drift.inSync) {
      el.innerHTML = `
        <div class="card" style="border-left:3px solid var(--green,#4ade80)">
          <div class="card-header"><h3><i class="fas fa-wave-square" style="margin-right:8px"></i>Drift Detection</h3>
            <span class="badge badge-running"><i class="fas fa-check" style="margin-right:3px"></i>In sync</span>
          </div>
          <div class="card-body text-sm text-muted">Running state matches the git-checked-out compose. Last checked ${Utils.timeAgo(drift.checkedAt)}.</div>
        </div>`;
      return;
    }

    el.innerHTML = `
      <div class="card" style="border-left:3px solid var(--yellow)">
        <div class="card-header"><h3><i class="fas fa-wave-square" style="margin-right:8px"></i>Drift Detection</h3>
          <span class="badge badge-warning">${drift.drifts.length} drift(s)</span>
        </div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin-bottom:8px">The running state has diverged from what git declares. Last checked ${Utils.timeAgo(drift.checkedAt)}.</p>
          ${drift.drifts.map(driftRow).join('')}
          <div style="margin-top:12px">
            <button class="btn btn-sm btn-primary" id="gs-drift-redeploy"><i class="fas fa-sync"></i> Re-deploy from git to fix</button>
          </div>
        </div>
      </div>`;
    const fixBtn = el.querySelector('#gs-drift-redeploy');
    if (fixBtn) fixBtn.addEventListener('click', () => this._redeploy({ id: this._stackId, stack_name: '' }));
  },

  async _loadPreviewSummary(stackId) {
    const el = document.getElementById('gs-preview-summary');
    if (!el) return;
    try {
      const [config, environments] = await Promise.all([
        Api.getPreviewConfig(stackId), Api.getPreviews(stackId),
      ]);
      const running = environments.filter(item => item.status === 'running').length;
      el.innerHTML = config.enabled ? `
        <table class="info-table">
          <tr><td>Policy</td><td><span class="badge badge-running">Enabled</span></td></tr>
          <tr><td>Active</td><td>${running} / ${environments.length} preview(s)</td></tr>
          <tr><td>TTL</td><td>${config.ttl_minutes} minutes</td></tr>
          <tr><td>Resources</td><td>${config.cpu_limit} CPU · ${config.memory_limit_mb} MB/service</td></tr>
          <tr><td>Forks</td><td>${config.allow_forks ? '<span class="text-red">Allowed</span>' : 'Rejected'}</td></tr>
        </table>` : '<span class="badge badge-stopped" style="margin-right:6px">Disabled</span><span class="text-sm text-muted">Signed GitHub PR webhooks can create isolated, expiring stacks.</span>';
    } catch (err) {
      el.innerHTML = `<span class="text-sm text-muted">Unavailable: ${Utils.escapeHtml(err.message)}</span>`;
    }
  },

  async _configurePreviews(stack) {
    try {
      const [config, hosts, environments] = await Promise.all([
        Api.getPreviewConfig(stack.id), Api.getHosts(), Api.getPreviews(stack.id),
      ]);
      const targetHosts = hosts.filter(host => host.isActive && ['docker', 'podman'].includes(host.daemonType || 'docker'));
      const defaultHost = config.host_id || stack.targets?.[0]?.host_id || targetHosts[0]?.id;
      const variables = (config.variables || []).map(item => `${item.key}${item.sensitive ? '!' : ''}=${item.value}`).join('\n');
      const environmentRows = environments.length ? environments.map(item => `
        <tr><td>#${item.pr_number}</td><td><span class="badge ${item.status === 'running' ? 'badge-running' : item.status === 'error' ? 'badge-danger' : 'badge-warning'}">${Utils.escapeHtml(item.status)}</span></td>
        <td class="mono text-sm">${Utils.escapeHtml((item.head_sha || '').substring(0, 7))}</td><td>${item.url ? `<a href="${Utils.escapeHtml(item.url)}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
        <td><button type="button" class="action-btn" data-preview-delete="${item.id}" title="Delete preview"><i class="fas fa-trash"></i></button></td></tr>`).join('')
        : '<tr><td colspan="5" class="text-muted">No preview environments.</td></tr>';
      const result = await Modal.form(`
        <div class="alert alert-warning"><i class="fas fa-shield-alt"></i> Preview code is treated as untrusted. Production stack overrides are never inherited; fork PRs are rejected unless explicitly enabled.</div>
        <div class="form-group"><label><input type="checkbox" id="pv-enabled" ${config.enabled ? 'checked' : ''}> Enable GitHub pull-request previews</label></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>Dedicated host</label><select id="pv-host" class="form-control">${targetHosts.map(host => `<option value="${host.id}" ${host.id === defaultHost ? 'selected' : ''}>${Utils.escapeHtml(host.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>TTL (minutes)</label><input id="pv-ttl" class="form-control" type="number" min="30" max="10080" value="${config.ttl_minutes || 1440}"></div>
          <div class="form-group"><label>CPU per service</label><input id="pv-cpu" class="form-control" type="number" min="0.1" max="32" step="0.1" value="${config.cpu_limit || 1}"></div>
          <div class="form-group"><label>Memory MB per service</label><input id="pv-memory" class="form-control" type="number" min="64" max="65536" value="${config.memory_limit_mb || 512}"></div>
        </div>
        <div class="form-group"><label>URL template</label><input id="pv-url" class="form-control" value="${Utils.escapeHtml(config.url_template || '')}" placeholder="https://pr-{pr}.{stack}.preview.example.com"><small class="text-muted">Metadata for your reverse proxy; supports {pr}, {stack}, and {sha}.</small></div>
        <div class="form-group"><label>Preview-only variables</label><textarea id="pv-env" class="form-control mono" rows="5" placeholder="PREVIEW_MODE=true\nAPI_TOKEN!=secret">${Utils.escapeHtml(variables)}</textarea><small class="text-muted">One KEY=value per line. Add ! after the key to mask a sensitive value.</small></div>
        <div class="form-group"><label><input type="checkbox" id="pv-forks" ${config.allow_forks ? 'checked' : ''}> Allow fork pull requests (high risk)</label></div>
        <hr class="divider"><h4>Current previews</h4>
        <div style="overflow:auto"><table class="data-table"><thead><tr><th>PR</th><th>Status</th><th>SHA</th><th>URL</th><th></th></tr></thead><tbody>${environmentRows}</tbody></table></div>
      `, {
        title: '<i class="fas fa-code-pull-request"></i> Pull-request Previews', width: '780px', confirmText: 'Save Policy',
        onOpen: content => content.querySelectorAll('[data-preview-delete]').forEach(button => button.addEventListener('click', async () => {
          if (!await Modal.confirmSub('Delete this preview stack? Persistent volumes are preserved.', { danger: true, confirmText: 'Delete preview' })) return;
          try { await Api.deletePreview(button.dataset.previewDelete); button.closest('tr').remove(); Toast.success('Preview deleted'); }
          catch (err) { Toast.error(err.message); }
        })),
        onSubmit: content => ({
          enabled: content.querySelector('#pv-enabled').checked,
          host_id: Number(content.querySelector('#pv-host').value),
          ttl_minutes: Number(content.querySelector('#pv-ttl').value),
          cpu_limit: Number(content.querySelector('#pv-cpu').value),
          memory_limit_mb: Number(content.querySelector('#pv-memory').value),
          url_template: content.querySelector('#pv-url').value.trim() || null,
          allow_forks: content.querySelector('#pv-forks').checked,
          variables: content.querySelector('#pv-env').value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
            const separator = line.indexOf('=');
            const rawKey = separator >= 0 ? line.substring(0, separator).trim() : line;
            return { key: rawKey.replace(/!$/, ''), value: separator >= 0 ? line.substring(separator + 1) : '', sensitive: rawKey.endsWith('!') };
          }),
        }),
      });
      if (!result) return;
      await Api.updatePreviewConfig(stack.id, result);
      Toast.success('Preview policy saved');
      await this._loadPreviewSummary(stack.id);
    } catch (err) { Toast.error(err.message); }
  },

  async _openOciArtifacts() {
    try {
      const [artifacts, registries, hosts] = await Promise.all([
        Api.getOciComposeArtifacts(), Api.getRegistries(), Api.getHosts(),
      ]);
      const dockerHosts = hosts.filter(host => host.isActive && ['docker', 'podman'].includes(host.daemonType || 'docker'));
      const rows = artifacts.length ? artifacts.map(item => `
        <tr><td><strong>${Utils.escapeHtml(item.name)}</strong><div class="mono text-xs text-muted">${Utils.escapeHtml(item.digest.substring(0, 19))}…</div></td>
        <td>${Utils.escapeHtml(item.registry_name)}/${Utils.escapeHtml(item.repository)}:${Utils.escapeHtml(item.source_ref)}</td>
        <td>${Utils.escapeHtml(item.host_name)}</td><td><span class="badge ${item.status === 'running' ? 'badge-running' : item.status === 'error' ? 'badge-danger' : 'badge-info'}">${item.status}</span></td>
        <td style="white-space:nowrap"><button type="button" class="action-btn" data-oci-plan="${item.id}" title="Plan and deploy"><i class="fas fa-rocket"></i></button>
        <button type="button" class="action-btn" data-oci-refresh="${item.id}" title="Resolve tag to a fresh digest"><i class="fas fa-sync"></i></button>
        <button type="button" class="action-btn" data-oci-stop="${item.id}" title="Compose down"><i class="fas fa-stop"></i></button>
        <button type="button" class="action-btn" data-oci-delete="${item.id}" title="Delete definition"><i class="fas fa-trash"></i></button></td></tr>`).join('')
        : '<tr><td colspan="5" class="text-muted">No OCI Compose applications.</td></tr>';
      const result = await Modal.form(`
        <div class="alert alert-info"><i class="fas fa-thumbtack"></i> Tags are resolved once and deployments always use the stored <code>@sha256</code> digest. Docker Compose 2.34+ is required.</div>
        <div style="overflow:auto;max-height:260px"><table class="data-table"><thead><tr><th>Name / digest</th><th>Source</th><th>Host</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <hr class="divider"><h4>Import OCI Compose artifact</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>Name</label><input id="oci-name" class="form-control" placeholder="billing-app"></div>
          <div class="form-group"><label>Project name</label><input id="oci-project" class="form-control" placeholder="billing-app"></div>
          <div class="form-group"><label>Registry</label><select id="oci-registry" class="form-control">${registries.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Deployment host</label><select id="oci-host" class="form-control">${dockerHosts.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Repository</label><input id="oci-repository" class="form-control" placeholder="platform/billing-compose"></div>
          <div class="form-group"><label>Tag or digest</label><input id="oci-ref" class="form-control" value="latest"></div>
          <div class="form-group"><label>Trust policy</label><select id="oci-trust" class="form-control"><option value="none">Pinned digest</option><option value="annotation">Require signature annotation</option><option value="cosign">Cryptographic cosign verify</option></select></div>
          <div class="form-group"><label>Signer regexp (optional)</label><input id="oci-signer" class="form-control"></div>
        </div>
        <div class="form-group"><label>Local override YAML (optional)</label><textarea id="oci-override" class="form-control mono" rows="5" placeholder="services:\n  web:\n    ports: ['8080:80']"></textarea></div>
        <div id="oci-action-result"></div>
      `, {
        title: '<i class="fas fa-cube"></i> OCI Compose Applications', width: '960px', confirmText: 'Import Artifact',
        onOpen: content => {
          const resultEl = content.querySelector('#oci-action-result');
          content.querySelectorAll('[data-oci-plan]').forEach(button => button.addEventListener('click', async () => {
            try {
              resultEl.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Generating Docker Compose dry-run plan…</div>';
              const plan = await Api.planOciComposeArtifact(button.dataset.ociPlan);
              resultEl.innerHTML = `<pre style="max-height:220px;overflow:auto">${Utils.escapeHtml(plan.output || 'Plan completed')}</pre>`;
              if (!await Modal.confirmSub(`Deploy pinned artifact ${plan.digest.substring(0, 19)}… using this reviewed plan?`, { confirmText: 'Deploy' })) return;
              await Api.deployOciComposeArtifact(button.dataset.ociPlan, plan.planHash); Toast.success('OCI application deployed');
            } catch (err) { Toast.error(err.message); }
          }));
          content.querySelectorAll('[data-oci-refresh]').forEach(button => button.addEventListener('click', async () => {
            try { await Api.refreshOciComposeArtifact(button.dataset.ociRefresh); Toast.success('OCI digest refreshed'); }
            catch (err) { Toast.error(err.message); }
          }));
          content.querySelectorAll('[data-oci-stop]').forEach(button => button.addEventListener('click', async () => {
            if (!await Modal.confirmSub('Stop this OCI Compose application? Volumes are preserved.', { danger: true, confirmText: 'Stop' })) return;
            try { await Api.stopOciComposeArtifact(button.dataset.ociStop); Toast.success('OCI application stopped'); }
            catch (err) { Toast.error(err.message); }
          }));
          content.querySelectorAll('[data-oci-delete]').forEach(button => button.addEventListener('click', async () => {
            if (!await Modal.confirmSub('Delete this stopped OCI application definition?', { danger: true, confirmText: 'Delete definition' })) return;
            try { await Api.deleteOciComposeArtifact(button.dataset.ociDelete); button.closest('tr').remove(); Toast.success('OCI definition deleted'); }
            catch (err) { Toast.error(err.message); }
          }));
        },
        onSubmit: content => ({
          name: content.querySelector('#oci-name').value.trim(),
          project_name: content.querySelector('#oci-project').value.trim() || content.querySelector('#oci-name').value.trim(),
          registry_id: Number(content.querySelector('#oci-registry').value), host_id: Number(content.querySelector('#oci-host').value),
          repository: content.querySelector('#oci-repository').value.trim(), source_ref: content.querySelector('#oci-ref').value.trim(),
          signature_policy: content.querySelector('#oci-trust').value, signer_pattern: content.querySelector('#oci-signer').value.trim() || null,
          override_yaml: content.querySelector('#oci-override').value.trim() || null,
        }),
      });
      if (!result) return;
      await Api.createOciComposeArtifact(result); Toast.success('OCI artifact imported and pinned');
    } catch (err) { Toast.error(err.message); }
  },

  async _openManagedGitOps() {
    try {
      const [managed, stacks] = await Promise.all([Api.getManagedGitOps(), Api.getGitStacks()]);
      let reviewed = null;
      const rows = managed.length ? managed.map(item => `
        <tr><td>${Utils.escapeHtml(item.stack_name)}</td><td class="mono">${Utils.escapeHtml(item.file_path)}</td><td>${item.auto_writeback ? '<span class="badge badge-warning">Automatic</span>' : '<span class="badge badge-info">Manual</span>'}</td>
        <td><button type="button" class="btn btn-sm btn-secondary" data-managed-plan="${item.id}"><i class="fas fa-code-compare"></i> Plan</button></td></tr>`).join('')
        : '<tr><td colspan="4" class="text-muted">No managed Git source configured.</td></tr>';
      const result = await Modal.form(`
        <div class="alert alert-info"><i class="fas fa-code-commit"></i> Export is deterministic and secret-free. Commits never force-push and are blocked whenever the local checkout differs from its remote branch.</div>
        <table class="data-table"><thead><tr><th>Repository stack</th><th>Path</th><th>Mode</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div id="managed-plan" style="margin-top:12px"></div>
        <hr class="divider"><h4>Configure source</h4>
        <div class="form-group"><label>Git stack</label><select id="managed-stack" class="form-control">${stacks.map(item => `<option value="${item.id}">${Utils.escapeHtml(item.stack_name)} · ${Utils.escapeHtml(item.branch)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Fleet document path</label><input id="managed-path" class="form-control mono" value=".docker-dash/fleet.yaml"></div>
        <div class="form-group"><label><input type="checkbox" id="managed-enabled" checked> Enable managed write-back</label></div>
        <div class="form-group"><label><input type="checkbox" id="managed-auto"> Commit automatically after a successful Fleet GitOps apply</label></div>
      `, {
        title: '<i class="fas fa-code-commit"></i> Managed GitOps Write-back', width: '860px', confirmText: 'Save Source',
        onOpen: content => content.querySelectorAll('[data-managed-plan]').forEach(button => button.addEventListener('click', async () => {
          const planEl = content.querySelector('#managed-plan');
          try {
            reviewed = await Api.planManagedGitOps(button.dataset.managedPlan);
            planEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><strong>${reviewed.changed ? 'Changes ready for commit' : 'Repository already matches'}</strong>${reviewed.changed ? '<button type="button" id="managed-apply" class="btn btn-sm btn-primary">Commit & Push</button>' : ''}</div><pre style="max-height:260px;overflow:auto">${Utils.escapeHtml(reviewed.diff || 'No changes')}</pre>`;
            planEl.querySelector('#managed-apply')?.addEventListener('click', async () => {
              try { const applied = await Api.applyManagedGitOps(reviewed.managedId, reviewed.planHash); Toast.success(`Fleet document pushed at ${applied.commitHash}`); }
              catch (err) { Toast.error(err.message); }
            });
          } catch (err) { planEl.innerHTML = `<div class="alert alert-danger">${Utils.escapeHtml(err.message)}</div>`; }
        })),
        onSubmit: content => ({
          git_stack_id: Number(content.querySelector('#managed-stack').value),
          file_path: content.querySelector('#managed-path').value.trim(),
          enabled: content.querySelector('#managed-enabled').checked,
          auto_writeback: content.querySelector('#managed-auto').checked,
        }),
      });
      if (!result) return;
      await Api.configureManagedGitOps(result); Toast.success('Managed GitOps source saved');
    } catch (err) { Toast.error(err.message); }
  },

  _statusBadge(status) {
    const map = {
      running: 'badge-running', error: 'badge-danger',
      deploying: 'badge-warning', cloning: 'badge-warning',
      stopped: 'badge-stopped', pending: 'badge-stopped',
    };
    return map[status] || 'badge-info';
  },

  _rolloutPolicyHtml(policy = {}) {
    if (!policy.enabled) {
      return '<div class="text-sm text-muted"><span class="badge badge-stopped" style="margin-right:6px">Sequential</span>Targets are deployed one at a time without a health gate.</div>';
    }
    const strategy = policy.strategy === 'exponential'
      ? `exponential ×${policy.multiplier}` : `fixed waves of ${policy.initialWave}`;
    return `
      <table class="info-table">
        <tr><td>Mode</td><td><span class="badge badge-running">Progressive</span></td></tr>
        <tr><td>Waves</td><td>${Utils.escapeHtml(strategy)}, max ${policy.maxParallel} parallel</td></tr>
        <tr><td>Health gate</td><td>${policy.healthGate ? `${policy.healthTimeoutSeconds}s timeout` : 'Off'}</td></tr>
        <tr><td>Failure</td><td>${Utils.escapeHtml(policy.onFailure || 'pause')}</td></tr>
      </table>`;
  },

  _deploymentTargetSummary(results) {
    if (!Array.isArray(results) || !results.length) return '';
    const counts = results.reduce((acc, result) => {
      const key = result.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const order = ['success', 'failed', 'untouched', 'rolled_back', 'rollback_failed'];
    const labels = order.filter(status => counts[status])
      .map(status => `${counts[status]} ${status.replace('_', ' ')}`);
    return `<div class="text-sm text-muted" style="margin-top:4px;white-space:nowrap">${Utils.escapeHtml(labels.join(' · '))}</div>`;
  },

  _targetStatusBadge(status) {
    const map = {
      success: 'badge-running', failed: 'badge-danger', pending: 'badge-warning', never: 'badge-stopped',
    };
    return map[status] || 'badge-stopped';
  },

  _targetSummaryBadge(targets = []) {
    if (targets.some(target => target.last_deploy_status === 'failed')) return 'badge-danger';
    if (targets.some(target => target.last_deploy_status === 'pending')) return 'badge-warning';
    if (targets.length && targets.every(target => target.last_deploy_status === 'success')) return 'badge-running';
    return 'badge-stopped';
  },

  _targetSelectorHtml(hosts, selectedIds = new Set()) {
    if (!hosts.length) return '<div class="text-muted text-sm">No active Docker-compatible hosts are available.</div>';
    return hosts.map(host => `
      <label style="display:flex;gap:8px;align-items:flex-start;padding:8px;background:var(--surface2);border-radius:5px;cursor:pointer">
        <input type="checkbox" data-git-target value="${host.id}" ${selectedIds.has(host.id) ? 'checked' : ''}>
        <span><strong>${Utils.escapeHtml(host.name)}</strong><br><small class="text-muted">${Utils.escapeHtml(host.environment || 'development')} · ${Utils.escapeHtml(host.connectionType || 'socket')}</small></span>
      </label>
    `).join('');
  },

  // v8.3.0 — drift badge for the list cards. `d` is the per-stack summary from
  // /git/stacks/drift, or undefined if never scanned.
  _driftBadge(d) {
    if (!d || !d.checkedAt) return ''; // not scanned yet — show nothing
    if (d.error) {
      return `<span class="badge badge-stopped" title="Drift scan error: ${Utils.escapeHtml(d.error)}"><i class="fas fa-question-circle" style="margin-right:3px"></i>drift?</span>`;
    }
    if (d.inSync) {
      return `<span class="badge badge-running" title="Running state matches git (checked ${Utils.escapeHtml(d.checkedAt)})"><i class="fas fa-check" style="margin-right:3px"></i>in sync</span>`;
    }
    return `<span class="badge badge-warning" title="Running state has drifted from git — click for details"><i class="fas fa-code-branch" style="margin-right:3px"></i>${d.driftCount} drift</span>`;
  },

  destroy() {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  },
};

window.GitStacksPage = GitStacksPage;
