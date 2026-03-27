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
          <button class="btn btn-sm btn-primary" id="gs-create"><i class="fas fa-plus"></i> Deploy from Git</button>
        </div>
      </div>
      <div id="gs-list"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>
    `;

    container.querySelector('#gs-refresh').addEventListener('click', () => this._loadList());
    container.querySelector('#gs-create').addEventListener('click', () => this._showCreateDialog());
    await this._loadList();
  },

  async _loadList() {
    const el = document.getElementById('gs-list');
    if (!el) return;

    try {
      const stacks = await Api.getGitStacks();

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
                <span class="badge ${this._statusBadge(s.status)}">${s.status}</span>
              </div>
              <div class="card-body">
                <div class="text-sm text-muted" style="margin-bottom:4px">${Utils.escapeHtml(s.repo_url)}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                  <span class="badge badge-info">${Utils.escapeHtml(s.branch)}</span>
                  ${s.last_commit_hash ? `<span class="badge" style="background:var(--surface2);color:var(--text-muted);font-family:var(--mono)">${s.last_commit_hash}</span>` : ''}
                  ${s.credential_name ? `<span class="badge" style="background:var(--surface2);color:var(--text-muted)"><i class="fas fa-key" style="margin-right:4px"></i>${Utils.escapeHtml(s.credential_name)}</span>` : ''}
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

  async _showCreateDialog() {
    let credentials = [];
    try { credentials = await Api.getGitCredentials(); } catch {}

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
      <div id="gs-test-result" style="display:none;margin-bottom:12px"></div>
      <details style="margin-bottom:12px">
        <summary style="cursor:pointer;color:var(--text-muted);font-size:13px"><i class="fas fa-cog"></i> Advanced Options</summary>
        <div style="padding-top:8px">
          <div class="form-group"><label><input type="checkbox" id="gs-force" checked> Force redeploy (overwrite local changes)</label></div>
          <div class="form-group"><label><input type="checkbox" id="gs-pull-images"> Re-pull images on update</label></div>
          <div class="form-group"><label><input type="checkbox" id="gs-tls-skip"> Skip TLS verification (self-signed certs)</label></div>
        </div>
      </details>
    `, {
      title: '<i class="fab fa-git-alt" style="margin-right:8px"></i> Deploy from Git Repository',
      width: '580px',
      onSubmit: (content) => {
        const stack_name = content.querySelector('#gs-name').value.trim();
        const repo_url = content.querySelector('#gs-repo-url').value.trim();
        if (!stack_name || !repo_url) { Toast.warning('Stack name and repo URL are required'); return false; }
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(stack_name)) { Toast.warning('Stack name must be lowercase alphanumeric with hyphens/underscores'); return false; }

        const data = {
          stack_name, repo_url,
          branch: content.querySelector('#gs-branch').value,
          compose_path: content.querySelector('#gs-compose-path').value.trim() || 'docker-compose.yml',
          force_redeploy: content.querySelector('#gs-force').checked,
          re_pull_images: content.querySelector('#gs-pull-images').checked,
          tls_skip_verify: content.querySelector('#gs-tls-skip').checked,
        };
        const credId = content.querySelector('#gs-credential').value;
        if (credId) data.credential_id = parseInt(credId);
        return data;
      },
      onOpen: (content) => {
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
            <button class="btn btn-sm btn-secondary" id="gs-diff"><i class="fas fa-code-branch"></i> Diff</button>
            <button class="btn btn-sm btn-secondary" id="gs-check"><i class="fas fa-search"></i> Check</button>
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
        </div>

        <div id="gs-update-result" style="margin-top:16px"></div>
        <div id="gs-deployments" style="margin-top:16px"></div>
      `;

      container.querySelector('#gs-back').addEventListener('click', () => { location.hash = '#/git-stacks'; });
      container.querySelector('#gs-check').addEventListener('click', () => this._checkUpdates(stack));
      container.querySelector('#gs-diff').addEventListener('click', () => this._showDiff(stack));
      container.querySelector('#gs-redeploy').addEventListener('click', () => this._redeploy(stack));
      container.querySelector('#gs-delete').addEventListener('click', () => this._deleteStack(stack));
      container.querySelector('#gs-webhook-setup').addEventListener('click', () => this._configureAutoDeploy(stack));

      // Load deployment history
      this._loadDeployments(stack.id);

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
                  <td><span class="badge ${d.status === 'success' ? 'badge-running' : d.status === 'failed' ? 'badge-danger' : d.status === 'rolled_back' ? 'badge-warning' : 'badge-info'}" style="font-size:10px">${d.status}</span></td>
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

  async _redeploy(stack) {
    const ok = await Modal.confirm(`Pull latest changes and redeploy "${stack.stack_name}"?`, { confirmText: 'Redeploy' });
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

  // ─── Helpers ─────────────────────────────────────

  _statusBadge(status) {
    const map = {
      running: 'badge-running', error: 'badge-danger',
      deploying: 'badge-warning', cloning: 'badge-warning',
      stopped: 'badge-stopped', pending: 'badge-stopped',
    };
    return map[status] || 'badge-info';
  },

  destroy() {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  },
};

window.GitStacksPage = GitStacksPage;
