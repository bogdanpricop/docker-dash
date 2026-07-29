/* ═══════════════════════════════════════════════════
   pages/stacks.js — Unified Stacks Page
   (Compose Stacks + Git Stacks in one view)
   ═══════════════════════════════════════════════════ */
'use strict';

const StacksPage = {
  _tab: 'all', // all | compose | git
  _detailStack: null,
  _detailType: null,
  _stackLogUnsubs: [],
  _stackLogLines: [],
  _stackLogContainers: [],
  _stackLogPaused: false,
  _stackLogRenderFrame: null,
  _showDiskStacks: localStorage.getItem('dd-stacks-show-disk') !== 'false',
  _yamlEditor: null,
  _composeServiceForm: null,
  _uptimeKuma: null,

  async render(container) {
    this._stopStackLogs();
    this._destroyYamlEditor();
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
          <h2><i class="fas fa-layer-group" style="color:var(--accent)"></i> ${i18n.t('pages.stacks.title')}</h2>
          <div class="page-subtitle">${i18n.t('pages.stacks.subtitle')}</div>
        </div>
        <div class="page-actions">
          <label class="toggle-label" title="Include stopped Compose projects discovered under DD_STACKS_DIR">
            <input type="checkbox" id="stacks-show-disk" ${this._showDiskStacks ? 'checked' : ''}> From disk
          </label>
          <div class="tabs" id="stack-tabs" style="margin:0">
            <button class="tab ${this._tab === 'all' ? 'active' : ''}" data-tab="all">${i18n.t('pages.stacks.tabAll')}</button>
            <button class="tab ${this._tab === 'compose' ? 'active' : ''}" data-tab="compose">${i18n.t('pages.stacks.tabCompose')}</button>
            <button class="tab ${this._tab === 'git' ? 'active' : ''}" data-tab="git">${i18n.t('pages.stacks.tabGit')}</button>
          </div>
          <button class="btn btn-sm btn-primary" id="stacks-create"><i class="fas fa-plus"></i> Create Stack</button>
          <button class="btn btn-sm btn-secondary" id="stacks-convert" title="Convert docker run to compose"><i class="fas fa-exchange-alt"></i> Convert docker run</button>
          <button class="btn btn-sm btn-secondary" id="stacks-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="stacks-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div></div>
    `;

    container.querySelectorAll('#stack-tabs .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._tab = tab.dataset.tab;
        container.querySelectorAll('#stack-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === this._tab));
        this._loadList();
      });
    });
    container.querySelector('#stacks-refresh').addEventListener('click', () => this._loadList());
    container.querySelector('#stacks-show-disk')?.addEventListener('change', event => {
      this._showDiskStacks = event.target.checked;
      localStorage.setItem('dd-stacks-show-disk', String(this._showDiskStacks));
      this._loadList();
    });
    container.querySelector('#stacks-create')?.addEventListener('click', () => this._createStackDialog());
    // v8.9.9-alpha.1 — Dockge G06 closure: docker-run → compose converter UI
    container.querySelector('#stacks-convert')?.addEventListener('click', () => this._convertDockerRunDialog());

    await this._loadList();
  },

  async _loadList() {
    const el = document.getElementById('stacks-content');
    if (!el) return;

    try {
      const [composeStacks, gitStacks, uptimeKuma] = await Promise.all([
        Api.getStacks().catch(() => []),
        Api.getGitStacks().catch(() => []),
        Api.detectUptimeKuma().catch(() => ({ detected: false })),
      ]);
      this._uptimeKuma = uptimeKuma;

      const unified = [];

      if (this._tab === 'all' || this._tab === 'compose') {
        for (const s of composeStacks) {
          if (s.diskOnly && !this._showDiskStacks) continue;
          unified.push({
            source: 'compose', name: s.name, running: s.running, total: s.total,
            containers: s.containers, workingDir: s.workingDir,
            discovered: !!s.discovered, diskOnly: !!s.diskOnly, composeSource: s.source,
            services: s.services || [], serviceCount: s.serviceCount || 0,
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
            <p>${i18n.t('pages.stacks.noStacks')}</p>
          </div>`;
        return;
      }

      let kumaUrl = '';
      if (uptimeKuma.detected && uptimeKuma.url) {
        try {
          const candidate = new URL(uptimeKuma.url.replace('<this-host>', location.hostname));
          if (candidate.protocol === 'http:' || candidate.protocol === 'https:') kumaUrl = candidate.href;
        } catch { /* detection remains useful without a published URL */ }
      }
      el.innerHTML = `
        ${uptimeKuma.detected ? `<div class="alert alert-info" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
          <span><i class="fas fa-heartbeat" style="color:var(--green);margin-right:6px"></i><strong>Uptime Kuma detected</strong>${uptimeKuma.container?.name ? ` · ${Utils.escapeHtml(uptimeKuma.container.name)}` : ''}</span>
          ${kumaUrl ? `<a class="btn btn-sm btn-secondary" href="${Utils.escapeHtml(kumaUrl)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-external-link-alt"></i> Open</a>` : '<span class="badge">port not published</span>'}
        </div>` : ''}
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

      // Remediation Wizard — stack entry point (compose only; v6.6.3)
      el.querySelectorAll('.stack-remediate-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
          RemediateWizard.open({
            scope: { type: 'stack', name: btn.dataset.stack, hostId: Api.getHostId(), displayName: 'stack: ' + btn.dataset.stack },
          });
        });
      });

      // Action buttons
      el.querySelectorAll('.stack-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { action, stack, source, stackId } = btn.dataset;
          const originalHtml = btn.innerHTML;
          try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            if (source === 'compose') {
              const completed = await this._runComposeAction(stack, action);
              if (!completed) return;
            } else if (source === 'git') {
              await Api.deployGitStack(parseInt(stackId), {});
            }
            Toast.success(i18n.t('pages.stacks.actionSuccess', { stack, action }));
            setTimeout(() => this._loadList(), 1500);
          } catch (err) {
            Toast.error(i18n.t('pages.stacks.actionFailed', { message: err.message }));
          } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _runComposeAction(stack, action) {
    const approved = await this._confirmComposeAction(stack, action);
    if (!approved) return null;

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-terminal" style="color:var(--accent);margin-right:8px"></i>${Utils.escapeHtml(stack)} — ${Utils.escapeHtml(action)}</h3>
        <button class="modal-close-btn" id="compose-progress-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div id="compose-progress-status" class="text-sm" aria-live="polite"><i class="fas fa-spinner fa-spin"></i> Starting Docker Compose…</div>
        <pre id="compose-progress-output" role="log" aria-live="polite" aria-label="Docker Compose output" tabindex="0" style="margin-top:12px;background:#0d1117;color:#d7dde5;padding:14px;border-radius:var(--radius);height:min(52vh,420px);overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;line-height:1.5"></pre>
        <p class="text-xs text-muted" style="margin-top:8px">Closing this window does not cancel the Compose operation.</p>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" id="compose-progress-close">Close</button></div>
    `, { width: '760px' });

    const content = Modal._content;
    const outputEl = content.querySelector('#compose-progress-output');
    const statusEl = content.querySelector('#compose-progress-status');
    const close = () => Modal.close();
    content.querySelector('#compose-progress-x').addEventListener('click', close);
    content.querySelector('#compose-progress-close').addEventListener('click', close);
    let output = '';

    const append = (value) => {
      output += String(value || '');
      if (output.length > 100_000) output = `[Earlier output truncated]\n${output.slice(-100_000)}`;
      outputEl.textContent = output;
      outputEl.scrollTop = outputEl.scrollHeight;
    };

    try {
      const result = await Api.streamComposeAction(stack, action, event => {
        if (event.type === 'start') {
          statusEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Running in <code>${Utils.escapeHtml(event.data.workingDir || '')}</code>`;
        } else if (event.type === 'output') {
          append(event.data.data);
        } else if (event.type === 'done') {
          statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i> Completed in ${Utils.escapeHtml(String(event.data.durationMs || 0))} ms`;
        }
      });
      return result;
    } catch (err) {
      statusEl.innerHTML = `<i class="fas fa-times-circle" style="color:var(--red)"></i> ${Utils.escapeHtml(err.message)}`;
      throw err;
    }
  },

  async _confirmComposeAction(stack, action) {
    let plan;
    try {
      plan = await Api.composePlan(stack, action);
    } catch (err) {
      if (err.status !== 501 || err.body?.code !== 'compose_dry_run_unsupported') throw err;
      return Modal.confirm(`
        <div class="alert alert-warning"><i class="fas fa-exclamation-triangle"></i> This host's Docker Compose version cannot produce a safe dry-run plan.</div>
        <p style="margin-top:12px">Run <strong>${Utils.escapeHtml(action)}</strong> for <strong>${Utils.escapeHtml(stack)}</strong> without a preview?</p>
      `, {
        html: true, title: 'Deployment plan unavailable',
        confirmText: `Run ${action}`, danger: action === 'down', width: '560px',
      });
    }

    const summary = Object.entries(plan.summary || {})
      .filter(([, count]) => count > 0)
      .map(([operation, count]) => `<span class="badge" style="margin-right:6px">${Utils.escapeHtml(operation)}: ${Utils.escapeHtml(String(count))}</span>`)
      .join('');
    const warningCount = (plan.steps || []).filter(step => step.status === 'warning').length;
    const raw = plan.rawOutput || (plan.steps || []).map(step => `${step.resource ? step.resource + ': ' : ''}${step.text}`).join('\n');
    return Modal.confirm(`
      <p>Review the read-only Docker Compose plan for <strong>${Utils.escapeHtml(stack)}</strong>.</p>
      <div style="margin:10px 0">${summary || '<span class="text-muted">No classified changes</span>'}${warningCount ? `<span class="badge badge-warning">warnings: ${warningCount}</span>` : ''}</div>
      <pre role="log" aria-label="Docker Compose deployment plan" tabindex="0" style="background:#0d1117;color:#d7dde5;padding:12px;border-radius:var(--radius);max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px">${Utils.escapeHtml(raw || 'Compose reported no changes.')}</pre>
      ${plan.truncated ? '<p class="text-xs" style="color:var(--yellow);margin-top:8px">Plan output was truncated; review the stack configuration before continuing.</p>' : ''}
    `, {
      html: true, title: `Compose plan — ${stack}`,
      confirmText: `Run ${action}`, danger: action === 'down', width: '760px',
    });
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
            ${s.total === 0 && s.discovered
              ? `<div style="margin-bottom:7px"><span class="badge badge-stopped"><i class="fas fa-folder-open" style="margin-right:4px"></i>Stopped · discovered on disk</span></div>
                <div class="text-sm text-muted">${s.serviceCount || s.services.length} configured service(s)</div>
                ${s.services.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${s.services.slice(0, 12).map(name => `<span class="badge" style="font-size:10px">${Utils.escapeHtml(name)}</span>`).join('')}</div>` : ''}`
              : `<div class="text-sm" style="margin-bottom:6px">${i18n.t('pages.stacks.containersRunning', { running: '<strong>' + s.running + '</strong>', total: s.total })}</div>
                ${s.containers ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${s.containers.map(c => `<span class="badge ${c.state === 'running' ? 'badge-running' : 'badge-stopped'}" style="font-size:10px">${Utils.escapeHtml(c.name)}</span>`).join('')}</div>` : ''}`}
          `}
          <div style="display:flex;gap:4px;margin-top:8px;justify-content:flex-end">
            ${isGit ? `
              <button class="action-btn stack-action-btn" data-source="git" data-stack="${Utils.escapeHtml(s.name)}" data-stack-id="${s.id}" data-action="deploy" title="Deploy"><i class="fas fa-rocket"></i></button>
            ` : `
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="up" title="Up"><i class="fas fa-play"></i></button>
              ${s.total > 0 ? `<button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="down" title="Down"><i class="fas fa-stop"></i></button>
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="restart" title="Restart"><i class="fas fa-sync-alt"></i></button>` : ''}
              <button class="action-btn stack-action-btn" data-source="compose" data-stack="${Utils.escapeHtml(s.name)}" data-action="pull" title="Pull"><i class="fas fa-download"></i></button>
              ${s.total > 0 ? `<button class="action-btn stack-remediate-btn" data-stack="${Utils.escapeHtml(s.name)}" title="Remediate stack (security fixes)"><i class="fas fa-tools"></i></button>` : ''}
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
          <button class="btn btn-sm btn-secondary" id="cs-to-swarm" title="${i18n.t('pages.swarm.deployToSwarmStackTitle')}"><i class="fas fa-project-diagram"></i> ${i18n.t('pages.swarm.deployToSwarm')}</button>
        </div>
      </div>
      <div class="tabs" style="margin-bottom:16px">
        <button class="tab active" data-tab="services">${i18n.t('pages.stacks.services')}</button>
        <button class="tab" data-tab="logs">Logs</button>
        <button class="tab" data-tab="config">${i18n.t('pages.stacks.composeConfig')}</button>
      </div>
      <div id="cs-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div></div>
    `;

    container.querySelector('#stacks-back').addEventListener('click', () => { location.hash = '#/stacks'; });

    // Action buttons
    ['up', 'down', 'restart', 'pull'].forEach(action => {
      container.querySelector(`#cs-${action}`).addEventListener('click', async () => {
        try {
          const completed = await this._runComposeAction(this._detailStack, action);
          if (!completed) return;
          Toast.success(i18n.t('pages.stacks.actionSuccessShort', { action }));
          setTimeout(() => this._loadComposeDetail(), 1500);
        } catch (err) { Toast.error(err.message); }
      });
    });

    // Deploy-to-swarm bridge (b): load this stack's compose YAML and open the
    // existing Swarm "Deploy Stack" modal pre-filled for review.
    container.querySelector('#cs-to-swarm')?.addEventListener('click', () => this._deployStackToSwarm());

    // Tabs
    let activeTab = 'services';
    container.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (activeTab === 'logs' && tab.dataset.tab !== 'logs') this._stopStackLogs();
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
    this._destroyYamlEditor();

    try {
      const stack = await Api.getStack(this._detailStack);

      const hasContainers = (stack.containers || []).length > 0;
      document.getElementById('cs-down')?.toggleAttribute('disabled', !hasContainers);
      document.getElementById('cs-restart')?.toggleAttribute('disabled', !hasContainers);

      if (tab === 'services') {
        const storage = stack.storage || {};
        const formatSize = value => value == null ? '—' : Utils.formatBytes(value);
        const imageCoverage = `${storage.measuredImages || 0}/${storage.uniqueImages || 0}`;
        const containerCoverage = `${storage.measuredContainers || 0}/${(stack.containers || []).length}`;
        el.innerHTML = `
          ${hasContainers ? `
            <div class="info-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 12px">
              <div class="info-item">
                <div class="info-label"><i class="fas fa-images" style="margin-right:5px"></i>${i18n.t('pages.stacks.uniqueImageSize')}</div>
                <div class="info-value" style="font-family:var(--mono)">${formatSize(storage.imageBytes)}</div>
                <div class="text-xs text-muted">${i18n.t('pages.stacks.measurementCoverage', { measured: imageCoverage })}</div>
              </div>
              <div class="info-item">
                <div class="info-label"><i class="fas fa-layer-group" style="margin-right:5px"></i>${i18n.t('pages.stacks.writableLayers')}</div>
                <div class="info-value" style="font-family:var(--mono)">${formatSize(storage.writableBytes)}</div>
                <div class="text-xs text-muted">${i18n.t('pages.stacks.measurementCoverage', { measured: containerCoverage })}</div>
              </div>
              <div class="info-item">
                <div class="info-label"><i class="fas fa-hdd" style="margin-right:5px"></i>${i18n.t('pages.stacks.approximateFootprint')}</div>
                <div class="info-value" style="font-family:var(--mono)">${formatSize(storage.approximateFootprintBytes)}</div>
                <div class="text-xs text-muted">${i18n.t('pages.stacks.footprintFormula')}</div>
              </div>
            </div>
            <div class="text-xs text-muted" style="margin:-4px 0 10px"><i class="fas fa-info-circle" style="margin-right:4px"></i>${i18n.t('pages.stacks.storageExclusions')}</div>
          ` : ''}
          <div class="card">
            <div class="card-body" style="padding:0">
              <table class="data-table" style="margin:0">
                <thead><tr><th>${i18n.t('pages.containers.container', { defaultValue: 'Container' })}</th><th>${i18n.t('pages.containers.image')}</th><th title="${i18n.t('pages.stacks.imageSizeHelp')}">${i18n.t('pages.stacks.imageSize')}</th><th title="${i18n.t('pages.stacks.writableSizeHelp')}">${i18n.t('pages.stacks.writableSize')}</th><th title="${i18n.t('pages.stacks.rootFsSizeHelp')}">${i18n.t('pages.stacks.rootFsSize')}</th><th>${i18n.t('common.status')}</th><th>${i18n.t('common.actions')}</th></tr></thead>
                <tbody>
                  ${(stack.containers || []).map(c => `
                    <tr>
                      <td><a href="#/containers/${c.id}" style="color:var(--accent)">${Utils.escapeHtml(c.name)}</a></td>
                      <td class="text-muted text-sm" style="font-family:var(--mono)">${Utils.escapeHtml(c.image)}</td>
                      <td class="text-sm" style="font-family:var(--mono);white-space:nowrap">${formatSize(c.imageSizeBytes)}</td>
                      <td class="text-sm" style="font-family:var(--mono);white-space:nowrap">${formatSize(c.writableSizeBytes)}</td>
                      <td class="text-sm" style="font-family:var(--mono);white-space:nowrap">${formatSize(c.rootFsSizeBytes)}</td>
                      <td><span class="badge ${c.state === 'running' ? 'badge-success' : 'badge-danger'}">${c.state}</span></td>
                      <td style="display:flex;gap:4px">
                        <button class="action-btn svc-action" data-id="${c.id}" data-action="restart" title="Restart"><i class="fas fa-sync-alt"></i></button>
                        <button class="action-btn svc-action" data-id="${c.id}" data-action="stop" title="Stop"><i class="fas fa-stop"></i></button>
                      </td>
                    </tr>
                  `).join('') || (stack.services || []).map(service => `
                    <tr>
                      <td>${Utils.escapeHtml(service)}</td>
                      <td class="text-muted text-sm">Configured in Compose</td>
                      <td class="text-muted">—</td>
                      <td class="text-muted">—</td>
                      <td class="text-muted">—</td>
                      <td><span class="badge badge-stopped">stopped</span></td>
                      <td class="text-muted text-sm">Use <strong>Up</strong> to start</td>
                    </tr>
                  `).join('') || `<tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px">No services found in this Compose file.</td></tr>`}
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
              Toast.success(i18n.t('pages.stacks.containerActionSuccess', { action: btn.dataset.action }));
              setTimeout(() => this._loadComposeDetail('services'), 1000);
            } catch (err) { Toast.error(err.message); }
          });
        });
      } else if (tab === 'logs') {
        await this._renderStackLogs(el, stack);
      } else if (tab === 'config') {
        const canEdit = App.user?.role === 'admin';
        el.innerHTML = `
          <div class="card">
            <div class="card-header">
              <h3>docker-compose.yml</h3>
              ${canEdit ? '<button class="btn btn-sm btn-primary" id="cs-config-save"><i class="fas fa-save"></i> Save config</button>' : '<span class="badge">Read only</span>'}
            </div>
            <div class="card-body">
              <div class="compose-editor-switch" role="tablist" aria-label="Compose editor mode">
                <button class="btn btn-sm btn-secondary active" id="cs-mode-yaml" role="tab" aria-selected="true"><i class="fas fa-code"></i> YAML</button>
                <button class="btn btn-sm btn-secondary" id="cs-mode-form" role="tab" aria-selected="false"><i class="fas fa-list-alt"></i> Form <span class="badge" style="margin-left:4px">preview</span></button>
              </div>
              <div id="cs-config-yaml-pane"><textarea id="cs-config-editor" class="form-control" aria-label="Docker Compose YAML"></textarea></div>
              <div id="cs-config-form-pane" hidden><div id="cs-config-service-form"></div></div>
              <div id="cs-config-server-status" class="text-xs text-muted" aria-live="polite"></div>
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
        this._yamlEditor = YamlEditor.mount(el.querySelector('#cs-config-editor'), {
          value: stack.config || '', readOnly: !canEdit, minHeight: 430,
        });
        this._composeServiceForm = ComposeServiceForm.mount(el.querySelector('#cs-config-service-form'), {
          editor: this._yamlEditor, readOnly: !canEdit,
        });
        let configMode = 'yaml';
        const switchMode = async nextMode => {
          if (nextMode === configMode) return true;
          const status = el.querySelector('#cs-config-server-status');
          try {
            if (nextMode === 'form') await this._composeServiceForm.syncFromYaml();
            else if (canEdit) {
              const result = await this._composeServiceForm.applyToYaml();
              if (!result.valid) {
                status.textContent = 'Fix the highlighted Form fields before returning to YAML.';
                status.style.color = 'var(--red)';
                return false;
              }
            }
          } catch (err) {
            status.textContent = err.message;
            status.style.color = 'var(--red)';
            Toast.error(err.message);
            return false;
          }
          configMode = nextMode;
          el.querySelector('#cs-config-yaml-pane').hidden = nextMode !== 'yaml';
          el.querySelector('#cs-config-form-pane').hidden = nextMode !== 'form';
          for (const mode of ['yaml', 'form']) {
            const button = el.querySelector(`#cs-mode-${mode}`);
            const active = mode === nextMode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
          }
          if (nextMode === 'yaml') this._yamlEditor.refresh();
          status.textContent = nextMode === 'form'
            ? 'Common fields are editable here; advanced fields remain in YAML.'
            : 'Form changes synchronized to YAML.';
          status.style.color = 'var(--text-dim)';
          return true;
        };
        el.querySelector('#cs-mode-yaml').addEventListener('click', () => switchMode('yaml'));
        el.querySelector('#cs-mode-form').addEventListener('click', () => switchMode('form'));
        el.querySelector('#cs-config-save')?.addEventListener('click', async event => {
          const button = event.currentTarget;
          const status = el.querySelector('#cs-config-server-status');
          if (configMode === 'form') {
            const formResult = await this._composeServiceForm.applyToYaml();
            if (!formResult.valid) {
              Toast.warning('Fix the highlighted Form fields before saving');
              return;
            }
          }
          const local = this._yamlEditor.validate();
          if (!local.valid) {
            this._yamlEditor.focus();
            Toast.warning('Fix the YAML syntax error before saving');
            return;
          }
          button.disabled = true;
          button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Validating…';
          try {
            const config = this._yamlEditor.getValue();
            const validation = await Api.validateStackConfig(stack.name, { config });
            if (!validation.valid) {
              status.textContent = validation.error || 'Docker Compose validation failed';
              status.style.color = 'var(--red)';
              return;
            }
            await Api.saveStackConfig(stack.name, { config, workingDir: stack.workingDir });
            status.textContent = 'Saved after Docker Compose validation.';
            status.style.color = 'var(--green)';
            Toast.success('Compose configuration saved');
          } catch (err) {
            status.textContent = err.message;
            status.style.color = 'var(--red)';
            Toast.error(err.message);
          } finally {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-save"></i> Save config';
          }
        });
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="color:var(--red)">${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _renderStackLogs(el, stack) {
    this._stopStackLogs();
    this._stackLogLines = [];
    this._stackLogPaused = false;
    const allContainers = stack.containers || [];
    this._stackLogContainers = allContainers.slice(0, 20);

    if (!this._stackLogContainers.length) {
      el.innerHTML = '<div class="empty-msg"><i class="fas fa-scroll"></i><p>No containers are available for this stack.</p></div>';
      return;
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-header" style="gap:10px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:260px">
            <h3 style="margin:0"><i class="fas fa-scroll" style="color:var(--accent);margin-right:7px"></i>Combined stack logs</h3>
            <span id="stack-log-status" class="text-xs text-muted" aria-live="polite">Loading history…</span>
          </div>
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <div class="search-box" style="width:210px"><i class="fas fa-search"></i><input id="stack-log-search" aria-label="Search stack logs" placeholder="Search logs…"></div>
            <label class="toggle-label"><input type="checkbox" id="stack-log-follow" checked> Follow</label>
            <button class="btn btn-sm btn-secondary" id="stack-log-pause" aria-pressed="false"><i class="fas fa-pause"></i> Pause</button>
            <button class="btn btn-sm btn-secondary" id="stack-log-clear"><i class="fas fa-eraser"></i> Clear</button>
            <button class="btn btn-sm btn-secondary" id="stack-log-download"><i class="fas fa-download"></i> Download</button>
          </div>
        </div>
        <div class="card-body" style="padding:0">
          ${allContainers.length > 20 ? `<div class="alert alert-warning" style="margin:10px">Showing live logs for the first 20 of ${allContainers.length} services to protect browser and daemon resources.</div>` : ''}
          <pre class="log-viewer" id="stack-log-output" role="log" aria-live="polite" aria-label="Combined live logs for ${Utils.escapeHtml(stack.name || String(this._detailStack))}" tabindex="0" style="margin:0;height:calc(100vh - 310px);min-height:340px;border:0;border-radius:0;padding:14px"></pre>
        </div>
      </div>`;

    el.querySelector('#stack-log-search').addEventListener('input', Utils.debounce(() => this._renderStackLogLines(), 150));
    el.querySelector('#stack-log-follow').addEventListener('change', event => {
      if (event.target.checked) {
        const output = el.querySelector('#stack-log-output');
        if (output) output.scrollTop = output.scrollHeight;
      }
    });
    el.querySelector('#stack-log-pause').addEventListener('click', event => {
      this._stackLogPaused = !this._stackLogPaused;
      event.currentTarget.setAttribute('aria-pressed', String(this._stackLogPaused));
      event.currentTarget.innerHTML = this._stackLogPaused
        ? '<i class="fas fa-play"></i> Resume'
        : '<i class="fas fa-pause"></i> Pause';
      if (!this._stackLogPaused) this._renderStackLogLines();
    });
    el.querySelector('#stack-log-clear').addEventListener('click', () => {
      this._stackLogLines = [];
      this._renderStackLogLines();
    });
    el.querySelector('#stack-log-download').addEventListener('click', () => this._downloadStackLogs());

    try {
      const ids = this._stackLogContainers.map(container => container.id).join(',');
      const history = await Api.getMultiLogs({ containers: ids, tail: 100 });
      this._stackLogLines = (history.logs || []).map(entry => ({
        containerId: entry.containerId,
        container: entry.container,
        timestamp: entry.ts || '',
        message: entry.msg || '',
      })).slice(-5_000);
      this._renderStackLogLines();
    } catch (err) {
      const status = el.querySelector('#stack-log-status');
      if (status) status.textContent = `History unavailable: ${err.message}`;
    }

    this._startStackLogs();
  },

  _stackLogColor(name) {
    const palette = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#bc8cff'];
    let hash = 0;
    for (const char of String(name || 'service')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return palette[Math.abs(hash) % palette.length];
  },

  _appendStackLog(containerId, rawLine) {
    const container = this._stackLogContainers.find(item =>
      String(item.id) === String(containerId)
      || String(item.id).startsWith(String(containerId))
      || String(containerId).startsWith(String(item.id))
    );
    const name = container?.name || String(containerId).slice(0, 12);
    for (const raw of String(rawLine || '').split(/\r?\n/)) {
      if (!raw) continue;
      const match = raw.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/);
      this._stackLogLines.push({
        containerId, container: name,
        timestamp: match ? match[1] : '',
        message: match ? match[2] : raw,
      });
    }
    if (this._stackLogLines.length > 5_000) this._stackLogLines.splice(0, this._stackLogLines.length - 5_000);
    if (!this._stackLogPaused) this._scheduleStackLogRender();
  },

  _scheduleStackLogRender() {
    if (this._stackLogRenderFrame !== null) return;
    this._stackLogRenderFrame = requestAnimationFrame(() => {
      this._stackLogRenderFrame = null;
      this._renderStackLogLines();
    });
  },

  _renderStackLogLines() {
    const output = document.getElementById('stack-log-output');
    if (!output) return;
    const search = document.getElementById('stack-log-search')?.value?.trim().toLowerCase() || '';
    const lines = search
      ? this._stackLogLines.filter(line => `${line.container} ${line.message}`.toLowerCase().includes(search))
      : this._stackLogLines;
    if (!lines.length) {
      output.innerHTML = '<span class="text-muted">No log lines match the current view.</span>';
      return;
    }
    output.innerHTML = lines.map(line => {
      const severity = /\b(error|fatal|panic|exception|critical|fail)\b/i.test(line.message) ? 'log-error'
        : /\b(warn|warning)\b/i.test(line.message) ? 'log-warn'
        : /\b(debug|trace)\b/i.test(line.message) ? 'log-debug' : '';
      const timestamp = line.timestamp
        ? `<span class="text-muted" style="font-size:10px;display:inline-block;min-width:25ch">${Utils.escapeHtml(line.timestamp)}</span>`
        : '<span style="display:inline-block;min-width:25ch"></span>';
      const tag = `<span style="display:inline-block;min-width:18ch;color:${this._stackLogColor(line.container)};font-weight:600">[${Utils.escapeHtml(line.container)}]</span>`;
      return `<span class="log-line ${severity}">${timestamp} ${tag} ${Utils.escapeHtml(line.message)}</span>`;
    }).join('\n');
    if (document.getElementById('stack-log-follow')?.checked) output.scrollTop = output.scrollHeight;
  },

  _startStackLogs() {
    if (!this._stackLogContainers.length) return;
    const status = document.getElementById('stack-log-status');
    const subscribed = new Set();
    const payloadFor = msg => msg.data || msg;

    this._stackLogUnsubs.push(WS.on('logs:data', msg => {
      const data = payloadFor(msg);
      if (!this._stackLogContainers.some(container => String(container.id) === String(data.containerId))) return;
      for (const line of (data.lines || [])) this._appendStackLog(data.containerId, line);
    }));
    this._stackLogUnsubs.push(WS.on('logs:subscribed', msg => {
      const data = payloadFor(msg);
      if (!this._stackLogContainers.some(container => String(container.id) === String(data.containerId))) return;
      subscribed.add(String(data.containerId));
      if (status) status.textContent = `Live · ${subscribed.size}/${this._stackLogContainers.length} services`;
    }));
    this._stackLogUnsubs.push(WS.on('logs:end', msg => {
      const data = payloadFor(msg);
      if (!this._stackLogContainers.some(container => String(container.id) === String(data.containerId))) return;
      subscribed.delete(String(data.containerId));
      if (status) status.textContent = `Live · ${subscribed.size}/${this._stackLogContainers.length} services`;
    }));
    this._stackLogUnsubs.push(WS.on('logs:error', msg => {
      const data = payloadFor(msg);
      if (data.containerId && !this._stackLogContainers.some(container => String(container.id) === String(data.containerId))) return;
      if (status) status.textContent = `Stream warning: ${data.error || 'unknown error'}`;
    }));
    this._stackLogUnsubs.push(WS.on('_disconnected', () => {
      if (status) status.textContent = 'Disconnected · waiting to reconnect';
    }));
    this._stackLogUnsubs.push(WS.on('_connected', () => this._subscribeStackLogs()));
    this._subscribeStackLogs();
  },

  _subscribeStackLogs() {
    if (!this._stackLogContainers.length) return;
    WS.send('logs:subscribe-many', {
      containerIds: this._stackLogContainers.map(container => container.id),
      tail: 0,
      hostId: Api.getHostId(),
    });
  },

  _stopStackLogs() {
    if (this._stackLogContainers.length) WS.send('logs:unsubscribe', {
      containerIds: this._stackLogContainers.map(container => container.id),
    });
    for (const unsubscribe of this._stackLogUnsubs) {
      try { unsubscribe(); } catch { /* already removed */ }
    }
    this._stackLogUnsubs = [];
    this._stackLogContainers = [];
    if (this._stackLogRenderFrame !== null) {
      cancelAnimationFrame(this._stackLogRenderFrame);
      this._stackLogRenderFrame = null;
    }
  },

  _downloadStackLogs() {
    if (!this._stackLogLines.length) return Toast.warning('No stack logs to download');
    const text = this._stackLogLines.map(line =>
      `${line.timestamp || ''}\t[${line.container}]\t${line.message}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${String(this._detailStack).replace(/[^a-z0-9_.-]/gi, '_')}-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  },

  // ─── Git Detail (redirect to existing GitStacksPage) ─────
  async _renderGitDetail(container) {
    container.innerHTML = `
      <div class="page-header">
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-sm btn-secondary" id="stacks-back"><i class="fas fa-arrow-left"></i></button>
          <h2><i class="fab fa-git-alt" style="color:var(--accent)"></i> ${i18n.t('pages.stacks.gitStackDetail')}</h2>
        </div>
      </div>
      <div id="gs-detail-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div></div>
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
              <div><div class="text-muted text-sm">${i18n.t('pages.stacks.repository')}</div><div style="word-break:break-all">${Utils.escapeHtml(stack.repo_url)}</div></div>
              <div><div class="text-muted text-sm">${i18n.t('pages.stacks.branch')}</div><div><i class="fas fa-code-branch"></i> ${Utils.escapeHtml(stack.branch)}</div></div>
              <div><div class="text-muted text-sm">${i18n.t('pages.stacks.lastCommit')}</div><div style="font-family:var(--mono)">${Utils.escapeHtml(stack.last_commit_hash || '-')}</div></div>
              <div><div class="text-muted text-sm">${i18n.t('pages.stacks.composeFile')}</div><div>${Utils.escapeHtml(stack.compose_file || 'docker-compose.yml')}</div></div>
              <div><div class="text-muted text-sm">${i18n.t('pages.stacks.lastDeployed')}</div><div>${Utils.timeAgo(stack.last_deployed_at)}</div></div>
              <div><div class="text-muted text-sm">${i18n.t('pages.stacks.autoDeploy')}</div><div>${stack.auto_deploy ? '<span class="badge badge-success">' + i18n.t('common.enabled') + '</span>' : '<span class="badge">' + i18n.t('common.disabled') + '</span>'}</div></div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary" id="gs-deploy"><i class="fas fa-rocket"></i> ${i18n.t('pages.stacks.deploy')}</button>
          <button class="btn btn-secondary" id="gs-check"><i class="fas fa-sync-alt"></i> ${i18n.t('pages.stacks.checkForUpdates')}</button>
          <a href="#/git-stacks/${stack.id}" class="btn btn-secondary"><i class="fas fa-external-link-alt"></i> ${i18n.t('pages.stacks.fullGitStackView')}</a>
        </div>
      `;

      el.querySelector('#gs-deploy')?.addEventListener('click', async () => {
        try {
          await Api.deployGitStack(stack.id, {});
          Toast.success(i18n.t('pages.stacks.deploymentStarted'));
        } catch (err) { Toast.error(err.message); }
      });
      el.querySelector('#gs-check')?.addEventListener('click', async () => {
        try {
          const result = await Api.checkGitStack(stack.id);
          Toast.info(result.hasUpdates ? i18n.t('pages.stacks.updatesAvailable') : i18n.t('pages.stacks.upToDate'));
        } catch (err) { Toast.error(err.message); }
      });
    } catch (err) {
      document.getElementById('gs-detail-content').innerHTML = `<div class="empty-msg" style="color:var(--red)">${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // v8.9.9-alpha.1 — Dockge G06 closure: docker-run → compose converter dialog.
  async _convertDockerRunDialog() {
    let editor = null;
    let suggestedName = '';
    const html = `
      <div class="form-group">
        <label>Paste a <code>docker run</code> command</label>
        <textarea id="drc-cmd" class="form-control" rows="4" placeholder="docker run -d --name mydb -p 5432:5432 -v pgdata:/var/lib/postgresql/data -e POSTGRES_PASSWORD=secret postgres:16" style="font-family:monospace;font-size:12px"></textarea>
        <small class="text-muted">Handles <code>--name</code>, <code>-p</code>, <code>-v</code>, <code>-e</code>, <code>--restart</code>, <code>--network</code>, <code>--user</code>, <code>-w</code>, <code>--cap-add</code>, <code>--tmpfs</code>, <code>--device</code>, <code>--label</code>, and more.</small>
      </div>
      <div class="form-group">
        <button class="btn btn-sm btn-primary" id="drc-convert" type="button"><i class="fas fa-arrow-right"></i> Convert</button>
      </div>
      <div class="form-group" id="drc-output-group" style="display:none">
        <label>Generated compose YAML</label>
        <textarea id="drc-yaml" class="form-control" rows="14" aria-label="Generated editable Compose YAML"></textarea>
        <small class="text-muted">Review or edit the YAML, then continue to Create Stack.</small>
      </div>
    `;
    const result = await Modal.form(html, {
      title: 'Convert docker run to compose',
      width: '720px',
      submitLabel: 'Create Stack',
      onMount: (content) => {
        editor = YamlEditor.mount(content.querySelector('#drc-yaml'), { minHeight: 320 });
        content.querySelector('#drc-convert').addEventListener('click', async () => {
          const cmd = content.querySelector('#drc-cmd').value.trim();
          if (!cmd) { Toast.error('Paste a command first'); return; }
          try {
            const r = await Api.convertDockerRun(cmd);
            suggestedName = r.serviceName || '';
            editor.setValue(r.yaml);
            content.querySelector('#drc-output-group').style.display = '';
            setTimeout(() => editor?.refresh(), 0);
          } catch (err) { Toast.error(err.message); }
        });
      },
      onSubmit: () => {
        const yaml = editor?.getValue().trim() || '';
        if (!yaml) { Toast.warning('Convert a docker run command first'); return false; }
        const validation = editor.validate();
        if (!validation.valid) { editor.focus(); Toast.warning('Fix the YAML syntax error first'); return false; }
        return { yaml, suggestedName };
      },
    });
    editor?.destroy();
    if (result) await this._createStackDialog({ initialYaml: result.yaml, initialName: result.suggestedName });
  },

  // Deploy-to-swarm bridge (b): promote this existing single-host compose
  // stack onto the swarm. Reuses the compose-config endpoint to fetch the
  // YAML and the swarm page's existing "Deploy Stack" modal to review + apply.
  async _deployStackToSwarm() {
    if (typeof SwarmPage === 'undefined' || typeof SwarmPage._showDeployStackModal !== 'function') {
      Toast.error('Swarm module not available');
      return;
    }
    const stackName = String(this._detailStack || '');

    // Precondition — target host must be an active swarm manager.
    let status;
    try { status = await Api.getSwarmStatus(); }
    catch (err) { Toast.error(err.message); return; }
    const isManager = !!(status && status.active && status.info && status.info.ControlAvailable);
    if (!isManager) {
      const go = await Modal.confirm(i18n.t('pages.swarm.noActiveSwarm'), {
        title: i18n.t('pages.swarm.deployToSwarmStackTitle'),
        confirmText: i18n.t('nav.swarm'),
      });
      if (go) location.hash = '#/swarm';
      return;
    }

    // Fetch the compose YAML via the EXISTING compose-config endpoint, which
    // already falls back (docker compose config → file read → inspect).
    Toast.info(i18n.t('pages.swarm.loadingCompose'));
    let cfg;
    try { cfg = await Api.composeConfig(stackName); }
    catch (err) { Toast.error(i18n.t('pages.swarm.composeLoadFailed', { message: err.message })); return; }
    const compose = (cfg && cfg.config) ? cfg.config : '';
    if (!compose.trim()) {
      Toast.error(i18n.t('pages.swarm.composeLoadFailed', { message: i18n.t('pages.stacks.noComposeConfig') }));
      return;
    }

    // Swarm stack names must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,62}.
    let swarmName = stackName.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/^[a-zA-Z0-9]/.test(swarmName)) swarmName = 's_' + swarmName;
    swarmName = swarmName.slice(0, 63);

    SwarmPage._showDeployStackModal({ name: swarmName, compose, source: 'local-stack' });
  },

  async _createStackDialog({ initialYaml = '', initialName = '' } = {}) {
    const seedYaml = initialYaml || `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"`;
    let editor = null;
    const result = await Modal.form(`
      <div class="form-group">
        <label>Stack Name</label>
        <input type="text" id="cs-name" class="form-control" placeholder="my-stack" value="${Utils.escapeHtml(initialName)}" required>
      </div>
      <div class="form-group">
        <label>Working Directory (optional)</label>
        <input type="text" id="cs-dir" class="form-control" placeholder="/opt/stacks/my-stack">
      </div>
      <div class="form-group">
        <label>docker-compose.yml</label>
        <textarea id="cs-yaml" class="form-control">${Utils.escapeHtml(seedYaml)}</textarea>
      </div>
    `, {
      title: 'Create Stack',
      width: '780px',
      onMount: content => {
        editor = YamlEditor.mount(content.querySelector('#cs-yaml'), { minHeight: 360 });
      },
      onSubmit: async (content) => {
        const name = content.querySelector('#cs-name').value.trim();
        const yaml = editor.getValue().trim();
        if (!name) { Toast.warning('Stack name is required'); return false; }
        if (!yaml) { Toast.warning('Compose YAML is required'); return false; }
        const local = editor.validate();
        if (!local.valid) { editor.focus(); Toast.warning('Fix the YAML syntax error first'); return false; }
        try {
          const validation = await Api.validateStackConfig(name, { config: yaml });
          if (!validation.valid) {
            Toast.error(validation.error || 'Docker Compose validation failed');
            editor.focus();
            return false;
          }
        } catch (err) {
          Toast.error(err.message);
          return false;
        }
        return { name, dir: content.querySelector('#cs-dir').value.trim(), yaml };
      },
    });
    editor?.destroy();

    if (result) {
      try {
        const saved = await Api.saveStackConfig(result.name, { config: result.yaml, workingDir: result.dir || undefined });
        const workingDir = saved.workingDir || result.dir || undefined;
        const deploy = await Modal.confirm(`Stack "${result.name}" created. Deploy it now?`, { confirmText: 'Deploy' });
        if (deploy) {
          await Api.deployStack(result.name, { workingDir });
          Toast.success(`Stack "${result.name}" deployed`);
        } else {
          Toast.success(`Stack "${result.name}" saved`);
        }
        await this._loadList();
      } catch (err) {
        Toast.error('Failed: ' + err.message);
      }
    }
  },

  destroy() {
    this._stopStackLogs();
    this._destroyYamlEditor();
    this._detailStack = null;
    this._detailType = null;
  },

  _destroyYamlEditor() {
    if (this._composeServiceForm) {
      try { this._composeServiceForm.destroy(); } catch { /* detached page */ }
      this._composeServiceForm = null;
    }
    if (!this._yamlEditor) return;
    try { this._yamlEditor.destroy(); } catch { /* detached modal/page */ }
    this._yamlEditor = null;
  },
};

window.StacksPage = StacksPage;
