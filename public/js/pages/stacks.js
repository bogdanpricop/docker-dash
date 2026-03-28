/* ═══════════════════════════════════════════════════
   pages/stacks.js — Unified Stacks Page
   (Compose Stacks + Git Stacks in one view)
   ═══════════════════════════════════════════════════ */
'use strict';

const StacksPage = {
  _tab: 'all', // all | compose | git
  _detailStack: null,
  _detailType: null,

  async render(container) {
    // Check if navigating to a detail view
    const hash = location.hash;
    const gitMatch = hash.match(/#\/stacks\/git\/(\d+)/);
    const composeMatch = hash.match(/#\/stacks\/compose\/(.+)/);

    if (gitMatch) {
      this._detailStack = parseInt(gitMatch[1]);
      this._detailType = 'git';
      return this._renderGitDetail(container);
    }
    if (composeMatch) {
      this._detailStack = decodeURIComponent(composeMatch[1]);
      this._detailType = 'compose';
      return this._renderComposeDetail(container);
    }

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-layer-group" style="color:var(--accent)"></i> Stacks</h2>
          <div class="page-subtitle">Compose stacks and Git-linked deployments</div>
        </div>
        <div class="page-actions">
          <div class="tabs" id="stack-tabs" style="margin:0">
            <button class="tab ${this._tab === 'all' ? 'active' : ''}" data-tab="all">All</button>
            <button class="tab ${this._tab === 'compose' ? 'active' : ''}" data-tab="compose">Compose</button>
            <button class="tab ${this._tab === 'git' ? 'active' : ''}" data-tab="git">Git</button>
          </div>
          <button class="btn btn-sm btn-secondary" id="stacks-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="stacks-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>
    `;

    container.querySelectorAll('#stack-tabs .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._tab = tab.dataset.tab;
        container.querySelectorAll('#stack-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === this._tab));
        this._loadList();
      });
    });
    container.querySelector('#stacks-refresh').addEventListener('click', () => this._loadList());

    await this._loadList();
  },

  async _loadList() {
    const el = document.getElementById('stacks-content');
    if (!el) return;

    try {
      const [composeStacks, gitStacks] = await Promise.all([
        Api.getStacks().catch(() => []),
        Api.getGitStacks().catch(() => []),
      ]);

      const unified = [];

      if (this._tab === 'all' || this._tab === 'compose') {
        for (const s of composeStacks) {
          unified.push({
            source: 'compose', name: s.name, running: s.running, total: s.total,
            containers: s.containers, workingDir: s.workingDir,
          });
        }
      }

      if (this._tab === 'all' || this._tab === 'git') {
        for (const s of gitStacks) {
          unified.push({
            source: 'git', name: s.stack_name, id: s.id, status: s.status,
            branch: s.branch, repoUrl: s.repo_url, lastCommit: s.last_commit_hash,
            running: 0, total: 0, // Git stacks don't expose these directly in list
          });
        }
      }

      if (unified.length === 0) {
        el.innerHTML = `
          <div class="empty-msg" style="padding:48px">
            <i class="fas fa-layer-group" style="font-size:48px;opacity:0.3;margin-bottom:12px"></i>
            <p>No stacks found. Deploy a Compose stack or link a Git repository.</p>
          </div>`;
        return;
      }

      el.innerHTML = `
        <div class="info-grid" style="margin-top:0">
          ${unified.map(s => this._renderStackCard(s)).join('')}
        </div>
      `;

      // Card click to detail
      el.querySelectorAll('.stack-card[data-navigate]').forEach(card => {
        card.addEventListener('click', () => {
          location.hash = card.dataset.navigate;
        });
      });

      // Action buttons
      el.querySelectorAll('.stack-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { action, stack, source, stackId } = btn.dataset;
          try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            if (source === 'compose') {
              await Api.composeAction(stack, action);
            } else if (source === 'git') {
              await Api.deployGitStack(parseInt(stackId), {});
            }
            Toast.success(`Stack ${stack}: ${action} successful`);
            setTimeout(() => this._loadList(), 1500);
          } catch (err) {
            Toast.error(`Failed: ${err.message}`);
          } finally {
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderStackCard(s) {
    const isGit = s.source === 'git';
    const statusColor = isGit
      ? (s.status === 'deployed' ? 'var(--green)' : s.status === 'error' ? 'var(--red)' : 'var(--yellow)')
      : (s.running === s.total && s.total > 0 ? 'var(--green)' : s.running > 0 ? 'var(--yellow)' : 'var(--red)');
    const navPath = isGit ? `#/stacks/git/${s.id}` : `#/stacks/compose/${encodeURIComponent(s.name)}`;

    return `
      <div class="card stack-card" style="cursor:pointer" data-navigate="${navPath}">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="display:flex;align-items:center;gap:8px">
            <i class="${isGit ? 'fab fa-git-alt' : 'fas fa-cubes'}" style="color:var(--accent)"></i>
            ${Utils.escapeHtml(s.name)}
          </h3>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="badge" style="background:${isGit ? 'var(--surface2)' : 'var(--surface2)'};color:var(--text-muted)">${isGit ? 'Git' : 'Compose'}</span>
            <span style="width:8px;height:8px;border-radius:50%;background:${statusColor};display:inline-block"></span>
          </div>
        </div>
        <div class="card-body">
          ${isGit ? `
            <div class="text-sm text-muted" style="margin-bottom:4px"><i class="fas fa-code-branch" style="margin-right:4px"></i>${Utils.escapeHtml(s.branch || 'main')}</div>
            <div class="text-sm text-muted" style="word-break:break-all">${Utils.escapeHtml(s.repoUrl || '')}</div>
            ${s.lastCommit ? `<div class="text-sm" style="margin-top:4px;font-family:var(--mono)">${Utils.escapeHtml(s.lastCommit)}</div>` : ''}
          ` : `
            <div class="text-sm" style="margin-bottom:4px"><strong>${s.running}</strong>/${s.total} containers running</div>
            ${s.containers ? `<div class="text-sm text-muted">${s.containers.map(c => `<span style="color:${c.state === 'running' ? 'var(--green)' : 'var(--red)'}">${Utils.escapeHtml(c.name)}</span>`).join(', ')}</div>` : ''}
          `}
          <div style="display:flex;gap:4px;margin-top:8px;justify-content:flex-end">
            ${isGit ? `
              <button class="action-btn stack-action-btn" data-source="git" data-stack="${Utils.escapeHtml(s.name)}" data-stack-id="${s.id}" data-action="deploy" title="Deploy"><i class="fas fa-rocket"></i></button>
            ` : `
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="up" title="Up"><i class="fas fa-play"></i></button>
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="down" title="Down"><i class="fas fa-stop"></i></button>
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="restart" title="Restart"><i class="fas fa-sync-alt"></i></button>
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="pull" title="Pull"><i class="fas fa-download"></i></button>
            `}
          </div>
        </div>
      </div>
    `;
  },

  // ─── Compose Detail ──────────────────────────────
  async _renderComposeDetail(container) {
    container.innerHTML = `
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-sm btn-secondary" id="stacks-back"><i class="fas fa-arrow-left"></i></button>
          <h2><i class="fas fa-cubes" style="color:var(--accent)"></i> ${Utils.escapeHtml(String(this._detailStack))}</h2>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm btn-primary" id="cs-up"><i class="fas fa-play"></i> Up</button>
          <button class="btn btn-sm btn-secondary" id="cs-down"><i class="fas fa-stop"></i> Down</button>
          <button class="btn btn-sm btn-secondary" id="cs-restart"><i class="fas fa-sync-alt"></i> Restart</button>
          <button class="btn btn-sm btn-secondary" id="cs-pull"><i class="fas fa-download"></i> Pull</button>
        </div>
      </div>
      <div class="tabs" style="margin-bottom:16px">
        <button class="tab active" data-tab="services">Services</button>
        <button class="tab" data-tab="config">Compose Config</button>
      </div>
      <div id="cs-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>
    `;

    container.querySelector('#stacks-back').addEventListener('click', () => { location.hash = '#/stacks'; });

    // Action buttons
    ['up', 'down', 'restart', 'pull'].forEach(action => {
      container.querySelector(`#cs-${action}`).addEventListener('click', async () => {
        try {
          await Api.composeAction(this._detailStack, action);
          Toast.success(`${action} successful`);
          setTimeout(() => this._loadComposeDetail(), 1500);
        } catch (err) { Toast.error(err.message); }
      });
    });

    // Tabs
    let activeTab = 'services';
    container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        container.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
        this._loadComposeDetail(activeTab);
      });
    });

    await this._loadComposeDetail('services');
  },

  async _loadComposeDetail(tab = 'services') {
    const el = document.getElementById('cs-content');
    if (!el) return;

    try {
      const stack = await Api.getStack(this._detailStack);

      if (tab === 'services') {
        el.innerHTML = `
          <div class="card">
            <div class="card-body" style="padding:0">
              <table class="data-table" style="margin:0">
                <thead><tr><th>Container</th><th>Image</th><th>State</th><th>Actions</th></tr></thead>
                <tbody>
                  ${(stack.containers || []).map(c => `
                    <tr>
                      <td><a href="#/containers/${c.id}" style="color:var(--accent)">${Utils.escapeHtml(c.name)}</a></td>
                      <td class="text-muted text-sm" style="font-family:var(--mono)">${Utils.escapeHtml(c.image)}</td>
                      <td><span class="badge ${c.state === 'running' ? 'badge-success' : 'badge-danger'}">${c.state}</span></td>
                      <td style="display:flex;gap:4px">
                        <button class="action-btn svc-action" data-id="${c.id}" data-action="restart" title="Restart"><i class="fas fa-sync-alt"></i></button>
                        <button class="action-btn svc-action" data-id="${c.id}" data-action="stop" title="Stop"><i class="fas fa-stop"></i></button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
          ${stack.workingDir ? `<div class="text-sm text-muted" style="margin-top:8px"><i class="fas fa-folder"></i> ${Utils.escapeHtml(stack.workingDir)}</div>` : ''}
        `;

        el.querySelectorAll('.svc-action').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              await Api.containerAction(btn.dataset.id, btn.dataset.action);
              Toast.success(`Container ${btn.dataset.action} successful`);
              setTimeout(() => this._loadComposeDetail('services'), 1000);
            } catch (err) { Toast.error(err.message); }
          });
        });
      } else if (tab === 'config') {
        el.innerHTML = `
          <div class="card">
            <div class="card-header"><h3>docker-compose.yml</h3></div>
            <div class="card-body">
              <pre style="background:var(--surface1);padding:16px;border-radius:var(--radius);overflow:auto;max-height:500px;font-family:var(--mono);font-size:12px;line-height:1.6">${Utils.escapeHtml(stack.config || 'No compose config found')}</pre>
            </div>
          </div>
          ${stack.envFile ? `
            <div class="card" style="margin-top:16px">
              <div class="card-header"><h3>.env</h3></div>
              <div class="card-body">
                <pre style="background:var(--surface1);padding:16px;border-radius:var(--radius);overflow:auto;max-height:300px;font-family:var(--mono);font-size:12px;line-height:1.6">${Utils.escapeHtml(stack.envFile)}</pre>
              </div>
            </div>
          ` : ''}
        `;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="color:var(--red)">${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // ─── Git Detail (redirect to existing GitStacksPage) ─────
  async _renderGitDetail(container) {
    container.innerHTML = `
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-sm btn-secondary" id="stacks-back"><i class="fas fa-arrow-left"></i></button>
          <h2><i class="fab fa-git-alt" style="color:var(--accent)"></i> Git Stack Detail</h2>
        </div>
      </div>
      <div id="gs-detail-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div></div>
    `;

    container.querySelector('#stacks-back').addEventListener('click', () => { location.hash = '#/stacks'; });

    try {
      const stack = await Api.getGitStack(this._detailStack);
      const el = document.getElementById('gs-detail-content');
      if (!el) return;

      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fab fa-git-alt" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(stack.stack_name)}</h3>
            <span class="badge ${stack.status === 'deployed' ? 'badge-success' : 'badge-warning'}">${stack.status}</span>
          </div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
              <div><div class="text-muted text-sm">Repository</div><div style="word-break:break-all">${Utils.escapeHtml(stack.repo_url)}</div></div>
              <div><div class="text-muted text-sm">Branch</div><div><i class="fas fa-code-branch"></i> ${Utils.escapeHtml(stack.branch)}</div></div>
              <div><div class="text-muted text-sm">Last Commit</div><div style="font-family:var(--mono)">${Utils.escapeHtml(stack.last_commit_hash || '-')}</div></div>
              <div><div class="text-muted text-sm">Compose File</div><div>${Utils.escapeHtml(stack.compose_file || 'docker-compose.yml')}</div></div>
              <div><div class="text-muted text-sm">Last Deployed</div><div>${Utils.timeAgo(stack.last_deployed_at)}</div></div>
              <div><div class="text-muted text-sm">Auto-Deploy</div><div>${stack.auto_deploy ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge">Disabled</span>'}</div></div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary" id="gs-deploy"><i class="fas fa-rocket"></i> Deploy</button>
          <button class="btn btn-secondary" id="gs-check"><i class="fas fa-sync-alt"></i> Check for updates</button>
          <a href="#/git-stacks/${stack.id}" class="btn btn-secondary"><i class="fas fa-external-link-alt"></i> Full Git Stack view</a>
        </div>
      `;

      el.querySelector('#gs-deploy')?.addEventListener('click', async () => {
        try {
          await Api.deployGitStack(stack.id, {});
          Toast.success('Deployment started');
        } catch (err) { Toast.error(err.message); }
      });
      el.querySelector('#gs-check')?.addEventListener('click', async () => {
        try {
          const result = await Api.checkGitStack(stack.id);
          Toast.info(result.hasUpdates ? 'Updates available' : 'Already up to date');
        } catch (err) { Toast.error(err.message); }
      });
    } catch (err) {
      document.getElementById('gs-detail-content').innerHTML = `<div class="empty-msg" style="color:var(--red)">${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  destroy() {
    this._detailStack = null;
    this._detailType = null;
  },
};

window.StacksPage = StacksPage;
