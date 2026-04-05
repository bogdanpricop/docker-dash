/* ═══════════════════════════════════════════════════
   pages/system.js — System Information & Resources
   ═══════════════════════════════════════════════════ */
'use strict';

const SystemPage = {
  _tab: 'info',
  _charts: {},

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-server"></i> ${i18n.t('pages.system.title')}</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="sys-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div class="tabs" id="sys-tabs">
        <button class="tab active" data-tab="info">${i18n.t('pages.system.tabInfo')}</button>
        <button class="tab" data-tab="health">${i18n.t('pages.system.tabHealth')}</button>
        <button class="tab" data-tab="disk">${i18n.t('pages.system.tabDisk')}</button>
        <button class="tab" data-tab="events">${i18n.t('pages.system.tabEvents')}</button>
        <button class="tab" data-tab="schedules">${i18n.t('pages.system.tabSchedules')}</button>
        <button class="tab" data-tab="backup">${i18n.t('pages.system.tabBackup')}</button>
        <button class="tab" data-tab="stacks"><i class="fas fa-layer-group" style="margin-right:4px"></i> Stacks</button>
        <button class="tab" data-tab="database"><i class="fas fa-database" style="margin-right:4px"></i> Database</button>
        <button class="tab" data-tab="tools"><i class="fas fa-toolbox" style="margin-right:4px"></i> Tools</button>
        <button class="tab" data-tab="templates"><i class="fas fa-rocket" style="margin-right:4px"></i> Templates</button>
        <button class="tab" data-tab="ssl"><i class="fas fa-shield-alt" style="margin-right:4px"></i> SSL/TLS</button>
        <button class="tab" data-tab="cis"><i class="fas fa-clipboard-check" style="margin-right:4px"></i> CIS Benchmark</button>
        <button class="tab" data-tab="prune">${i18n.t('pages.system.tabPrune')}</button>
        <button class="tab" data-tab="audit">${i18n.t('pages.system.tabAudit')}</button>
      </div>
      <div id="sys-content">Loading...</div>
    `;

    container.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        this._renderTab();
      });
    });

    container.querySelector('#sys-refresh').addEventListener('click', () => this._renderTab());
    await this._renderTab();
  },

  async _renderTab() {
    const el = document.getElementById('sys-content');
    if (!el) return;

    try {
      if (this._tab === 'info') await this._renderInfo(el);
      else if (this._tab === 'health') await this._renderHealth(el);
      else if (this._tab === 'disk') await this._renderDisk(el);
      else if (this._tab === 'events') await this._renderEvents(el);
      else if (this._tab === 'schedules') await this._renderSchedules(el);
      else if (this._tab === 'backup') this._renderBackup(el);
      else if (this._tab === 'stacks') await this._renderStacks(el);
      else if (this._tab === 'database') await this._renderDatabase(el);
      else if (this._tab === 'tools') this._renderTools(el);
      else if (this._tab === 'templates') await this._renderTemplates(el);
      else if (this._tab === 'ssl') await this._renderSsl(el);
      else if (this._tab === 'cis') await this._renderCisBenchmark(el);
      else if (this._tab === 'prune') this._renderPrune(el);
      else if (this._tab === 'audit') await this._renderAudit(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _renderInfo(el) {
    const info = await Api.getSystemInfo();
    // Backend maps to lowercase: hostname, os, kernelVersion, dockerVersion, apiVersion, etc.
    const containersTotal = info.containers || info.Containers || 0;
    const containersRunning = info.containersRunning || info.ContainersRunning || 0;
    el.innerHTML = `
      <div class="info-grid">
        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.system.dockerEngine')}</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>${i18n.t('pages.system.version')}</td><td>${info.dockerVersion || info.ServerVersion || '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.apiVersion')}</td><td>${info.apiVersion || info.ApiVersion || '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.os')}</td><td>${info.os || info.OperatingSystem || '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.kernel')}</td><td>${info.kernelVersion || info.KernelVersion || '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.storageDriver')}</td><td>${info.storageDriver || info.Driver || '—'}</td></tr>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.system.hostTitle')}</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>${i18n.t('pages.system.hostname')}</td><td>${info.hostname || info.Name || '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.cpus')}</td><td>${info.cpus || info.NCPU || '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.memoryLabel')}</td><td>${Utils.formatBytes(info.memTotal || info.MemTotal)}</td></tr>
              <tr><td>${i18n.t('pages.system.containersLabel')}</td><td>${containersTotal} (${i18n.t('pages.system.runningCount', { count: containersRunning })})</td></tr>
              <tr><td>${i18n.t('pages.system.imagesLabel')}</td><td>${info.images || info.Images || 0}</td></tr>
              <tr><td>${i18n.t('pages.system.uptime')}</td><td>${info.uptime ? Utils.formatDuration(info.uptime) : '—'}</td></tr>
              <tr><td>${i18n.t('pages.system.serverTime')}</td><td>${info.serverTime ? Utils.formatDate(info.serverTime) : '—'}</td></tr>
            </table>
          </div>
        </div>
      </div>
      <!-- Updates Card -->
      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <h3><i class="fas fa-arrow-circle-up text-dim" style="margin-right:8px"></i>${i18n.t('pages.system.updatesTitle')}</h3>
          <button class="btn btn-sm btn-secondary" id="check-updates-btn">
            <i class="fas fa-sync-alt"></i> ${i18n.t('pages.system.checkUpdates')}
          </button>
        </div>
        <div class="card-body" id="updates-content">
          <div class="text-muted text-sm">${i18n.t('pages.system.updatesClickCheck')}</div>
        </div>
      </div>
    `;
    el.querySelector('#check-updates-btn').addEventListener('click', () => this._loadUpdates());
    // Auto-check updates
    this._loadUpdates();
  },

  async _loadUpdates() {
    const el = document.getElementById('updates-content');
    if (!el) return;
    el.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('pages.system.updatesChecking')}</div>`;
    try {
      const data = await Api.checkUpdates();
      const d = data.docker || {};
      const o = data.os || {};
      const app = data.app || {};

      const dockerBadge = d.updateAvailable
        ? `<span class="badge badge-warning"><i class="fas fa-arrow-up"></i> ${i18n.t('pages.system.updateAvailable')}</span>`
        : `<span class="badge badge-running"><i class="fas fa-check"></i> ${i18n.t('pages.system.upToDate')}</span>`;

      const osBadge = o.updateAvailable
        ? `<span class="badge badge-warning"><i class="fas fa-arrow-up"></i> ${i18n.t('pages.system.osUpdatesCount', { count: o.total })}</span>`
        : `<span class="badge badge-running"><i class="fas fa-check"></i> ${i18n.t('pages.system.upToDate')}</span>`;

      let osPackageList = '';
      if (o.packages && o.packages.length > 0) {
        osPackageList = `
          <details style="margin-top:8px">
            <summary class="text-sm" style="cursor:pointer;color:var(--accent)">${i18n.t('pages.system.showPackages', { count: o.total })}</summary>
            <div style="max-height:200px;overflow-y:auto;margin-top:6px">
              <table class="data-table compact">
                <thead><tr><th>${i18n.t('pages.system.packageName')}</th><th>${i18n.t('pages.system.packageNew')}</th></tr></thead>
                <tbody>${o.packages.map(p => `
                  <tr>
                    <td class="mono text-sm">${Utils.escapeHtml(p.name)}</td>
                    <td class="mono text-sm">${Utils.escapeHtml(p.newVersion)}</td>
                  </tr>
                `).join('')}</tbody>
              </table>
            </div>
          </details>`;
      }

      el.innerHTML = `
        <table class="info-table">
          <tr>
            <td><i class="fas fa-whale" style="margin-right:6px"></i> ${i18n.t('pages.system.dockerVersionLabel')}</td>
            <td>
              <span class="mono">${Utils.escapeHtml(d.current || '?')}</span>
              ${d.latest ? `<span class="text-dim text-sm" style="margin-left:8px">(${i18n.t('pages.system.latest')}: ${Utils.escapeHtml(d.latest)})</span>` : ''}
              <span style="margin-left:8px">${dockerBadge}</span>
            </td>
          </tr>
          <tr>
            <td><i class="fas fa-server" style="margin-right:6px"></i> ${i18n.t('pages.system.osUpdatesLabel')}</td>
            <td>${osBadge}</td>
          </tr>
          <tr>
            <td><i class="fas fa-code-branch" style="margin-right:6px"></i> ${i18n.t('pages.system.appVersionLabel')}</td>
            <td><span class="mono">v${Utils.escapeHtml(app.version || '?')}</span></td>
          </tr>
        </table>
        ${osPackageList}
      `;
    } catch (err) {
      el.innerHTML = `<div class="text-muted text-sm"><i class="fas fa-exclamation-triangle" style="color:var(--yellow)"></i> ${i18n.t('pages.system.updatesError', { message: err.message })}</div>`;
    }
  },

  async _renderDisk(el) {
    const du = await Api.getDiskUsage();
    const images = (du.Images || []).reduce((sum, i) => sum + (i.Size || 0), 0);
    const containers = (du.Containers || []).reduce((sum, c) => sum + (c.SizeRw || 0), 0);
    const volumes = (du.Volumes || []).reduce((sum, v) => sum + (v.UsageData?.Size || 0), 0);
    const cache = du.BuildCache?.reduce((sum, b) => sum + (b.Size || 0), 0) || 0;

    el.innerHTML = `
      <div class="info-grid">
        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.system.diskBreakdown')}</h3></div>
          <div class="card-body chart-container" style="height:250px">
            <canvas id="disk-chart"></canvas>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.system.summary')}</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>${i18n.t('pages.system.diskImages')}</td><td>${Utils.formatBytes(images)}</td></tr>
              <tr><td>${i18n.t('pages.system.diskContainers')}</td><td>${Utils.formatBytes(containers)}</td></tr>
              <tr><td>${i18n.t('pages.system.diskVolumes')}</td><td>${Utils.formatBytes(volumes)}</td></tr>
              <tr><td>${i18n.t('pages.system.buildCache')}</td><td>${Utils.formatBytes(cache)}</td></tr>
              <tr><td><strong>${i18n.t('pages.system.total')}</strong></td><td><strong>${Utils.formatBytes(images + containers + volumes + cache)}</strong></td></tr>
            </table>
          </div>
        </div>
      </div>
    `;

    // Render pie chart
    if (this._charts.disk) this._charts.disk.destroy();
    const canvas = document.getElementById('disk-chart');
    if (canvas) {
      this._charts.disk = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: [i18n.t('pages.system.diskImages'), i18n.t('pages.system.diskContainers'), i18n.t('pages.system.diskVolumes'), i18n.t('pages.system.buildCache')],
          datasets: [{ data: [images, containers, volumes, cache], backgroundColor: ['#0ea5e9', '#22c55e', '#a855f7', '#eab308'], borderWidth: 0 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '60%',
          plugins: {
            legend: { display: true, position: 'bottom', labels: { color: '#8899aa' } },
            tooltip: { callbacks: { label: ctx => `${ctx.label}: ${Utils.formatBytes(ctx.raw)}` } },
          },
        },
      });
    }
  },

  async _renderEvents(el) {
    const res = await Api.get('/system/events?limit=50');
    const events = res.events || res || [];

    if (events.length === 0) {
      el.innerHTML = `<div class="empty-msg">${i18n.t('pages.system.noRecentEvents')}</div>`;
      return;
    }

    el.innerHTML = `<table class="data-table">
      <thead><tr><th>${i18n.t('pages.system.eventTime')}</th><th>${i18n.t('pages.system.eventType')}</th><th>${i18n.t('pages.system.eventAction')}</th><th>${i18n.t('pages.system.eventActor')}</th></tr></thead>
      <tbody>${events.map(e => `
        <tr>
          <td>${Utils.formatDate(e.event_time || e.eventTime)}</td>
          <td>${e.event_type || e.eventType || ''}</td>
          <td><span class="badge event-${e.action}">${e.action}</span></td>
          <td class="mono text-sm">${Utils.escapeHtml(e.actor_name || e.actorName || Utils.shortId(e.actor_id || e.actorId))}</td>
        </tr>
      `).join('')}</tbody>
    </table>`;
  },

  // ─── Stacks Tab ──────────────────────────────
  async _renderStacks(el) {
    el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading stacks...</div>`;
    try {
      const stacks = await Api.getStacks();

      el.innerHTML = `
        <div style="margin-bottom:12px;display:flex;justify-content:flex-end">
          <button class="btn btn-sm btn-primary" id="create-stack-btn"><i class="fas fa-plus"></i> Create Stack</button>
        </div>
        ${stacks.length === 0 ? '<div class="empty-msg"><i class="fas fa-layer-group"></i><p>No Docker Compose stacks found. Create one above.</p></div>' : `
        <div class="info-grid" style="margin-top:0">
          ${stacks.map(s => `
            <div class="card stack-card" data-stack="${Utils.escapeHtml(s.name)}" style="cursor:pointer">
              <div class="card-header">
                <h3><i class="fas fa-layer-group" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(s.name)}</h3>
                <span class="badge ${s.running === s.total ? 'badge-running' : s.running > 0 ? 'badge-warning' : 'badge-stopped'}">${s.running}/${s.total}</span>
              </div>
              <div class="card-body">
                <div class="text-sm text-muted" style="margin-bottom:8px">${Utils.escapeHtml(s.workingDir || 'Unknown directory')}</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px">
                  ${s.containers.map(c => `<span class="badge ${c.state === 'running' ? 'badge-running' : 'badge-stopped'}" style="font-size:10px">${Utils.escapeHtml(c.name)}</span>`).join('')}
                </div>
              </div>
            </div>
          `).join('')}
        </div>`}
      `;

      el.querySelectorAll('.stack-card').forEach(card => {
        card.addEventListener('click', () => this._openStackDetail(card.dataset.stack));
      });
      el.querySelector('#create-stack-btn').addEventListener('click', () => this._createStackDialog());
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _createStackDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>Stack Name</label>
        <input type="text" id="stack-name" class="form-control" placeholder="my-stack" required>
      </div>
      <div class="form-group">
        <label>Directory Path (on server)</label>
        <input type="text" id="stack-dir" class="form-control" placeholder="/opt/my-stack">
      </div>
      <div class="form-group">
        <label>docker-compose.yml</label>
        <textarea id="stack-yaml" class="form-control" rows="14" style="font-family:var(--mono);font-size:12px" placeholder="services:
  web:
    image: nginx:alpine
    ports:
      - '8080:80'
    restart: unless-stopped"></textarea>
      </div>
      <div class="form-group">
        <label>Environment Variables <span class="text-muted text-sm">(optional, one per line: KEY=value)</span></label>
        <textarea id="stack-env" class="form-control" rows="4" style="font-family:var(--mono);font-size:12px" placeholder="DB_HOST=localhost
DB_PASS=secret"></textarea>
      </div>
    `, {
      title: 'Create New Stack',
      width: '650px',
      onSubmit: (content) => {
        const name = content.querySelector('#stack-name').value.trim();
        const dir = content.querySelector('#stack-dir').value.trim();
        const yaml = content.querySelector('#stack-yaml').value;
        const env = content.querySelector('#stack-env').value;
        if (!name || !yaml) { Toast.warning('Stack name and compose YAML are required'); return false; }
        return { name, dir: dir || `/opt/${name}`, yaml, env };
      },
    });

    if (!result) return;

    try {
      await Api.post('/system/stacks', result);
      Toast.success(`Stack "${result.name}" created and deployed`);
      await this._renderStacks(document.getElementById('sys-content'));
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _openStackDetail(name) {
    const el = document.getElementById('sys-content');
    el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;
    try {
      const stack = await Api.getStack(name);

      el.innerHTML = `
        <div style="margin-bottom:12px">
          <button class="btn btn-sm btn-secondary" id="stack-back"><i class="fas fa-arrow-left"></i> Back to Stacks</button>
        </div>
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-layer-group" style="margin-right:8px"></i>${Utils.escapeHtml(name)}</h3>
            <div class="btn-group">
              ${stack.config ? '<button class="btn btn-sm btn-secondary" id="stack-validate"><i class="fas fa-check-circle"></i> Validate</button>' : ''}
              ${stack.config ? '<button class="btn btn-sm btn-primary" id="stack-save"><i class="fas fa-save"></i> Save</button>' : ''}
              <button class="btn btn-sm btn-accent" id="stack-deploy"><i class="fas fa-rocket"></i> Deploy</button>
            </div>
          </div>
          <div class="card-body" style="padding:0">
            ${stack.config
              ? `<textarea id="stack-editor" style="width:100%;min-height:400px;border:none;background:var(--surface2);color:var(--text);font-family:var(--mono);font-size:12px;padding:16px;resize:vertical;outline:none">${Utils.escapeHtml(stack.config)}</textarea>`
              : '<div class="empty-msg">Compose file not found on server</div>'
            }
          </div>
        </div>
        <div class="card" style="margin-top:12px">
          <div class="card-header">
            <h3><i class="fas fa-key" style="margin-right:8px"></i>Environment Variables (.env)</h3>
            <button class="btn btn-sm btn-secondary" id="stack-save-env"><i class="fas fa-save"></i> Save .env</button>
          </div>
          <div class="card-body" style="padding:0">
            <textarea id="stack-env-editor" style="width:100%;min-height:120px;border:none;background:var(--surface2);color:var(--text);font-family:var(--mono);font-size:12px;padding:16px;resize:vertical;outline:none" placeholder="KEY=value (one per line)">${Utils.escapeHtml(stack.envFile || '')}</textarea>
          </div>
        </div>
        <div class="card" style="margin-top:12px">
          <div class="card-header"><h3>Services</h3></div>
          <div class="card-body" style="padding:0">
            <table class="data-table">
              <thead><tr><th style="text-align:left">Container</th><th>Image</th><th>State</th></tr></thead>
              <tbody>${stack.containers.map(c => `
                <tr style="cursor:pointer" data-nav-container="${c.id}">
                  <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(c.name)}</td>
                  <td class="text-sm">${Utils.escapeHtml(c.image)}</td>
                  <td><span class="badge ${c.state === 'running' ? 'badge-running' : 'badge-stopped'}">${c.state}</span></td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        </div>
      `;

      el.querySelector('#stack-back').addEventListener('click', () => this._renderStacks(el));

      // Wire up container navigation clicks
      el.querySelectorAll('[data-nav-container]').forEach(row => {
        row.addEventListener('click', () => { location.hash = '#/containers/' + row.dataset.navContainer; });
      });

      const validateBtn = el.querySelector('#stack-validate');
      if (validateBtn) {
        validateBtn.addEventListener('click', async () => {
          const editor = el.querySelector('#stack-editor');
          try {
            const result = await Api.validateStackConfig(name, { config: editor.value, workingDir: stack.workingDir });
            if (result.valid) {
              Toast.success('Valid YAML configuration');
            } else {
              Toast.error('Validation failed: ' + (result.error || 'Unknown error'));
            }
          } catch (err) { Toast.error(err.message); }
        });
      }

      const saveBtn = el.querySelector('#stack-save');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const editor = el.querySelector('#stack-editor');
          try {
            await Api.saveStackConfig(name, { config: editor.value, workingDir: stack.workingDir });
            Toast.success('Configuration saved');
          } catch (err) { Toast.error(err.message); }
        });
      }

      el.querySelector('#stack-save-env').addEventListener('click', async () => {
        const envContent = el.querySelector('#stack-env-editor').value;
        try {
          await Api.post(`/system/stacks/${encodeURIComponent(name)}/env`, { env: envContent, workingDir: stack.workingDir });
          Toast.success('.env file saved');
        } catch (err) { Toast.error(err.message); }
      });

      el.querySelector('#stack-deploy').addEventListener('click', async () => {
        const ok = await Modal.confirm(`Deploy stack "${name}"? This will run docker compose up -d.`, { confirmText: 'Deploy' });
        if (!ok) return;
        try {
          const result = await Api.deployStack(name, { workingDir: stack.workingDir });
          Toast.success('Stack deployed');
        } catch (err) { Toast.error(err.message); }
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Database Tab ──────────────────────────────
  async _renderDatabase(el) {
    el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading database info...</div>`;
    try {
      const data = await Api.getDatabaseInfo();
      const f = data.file;
      const e = data.engine;
      const tables = data.tables || [];
      const ret = data.retention || {};

      // Top 10 tables by size (or by row count if sizes unavailable)
      const topTables = tables
        .filter(t => t.rows > 0 || t.size > 0)
        .sort((a, b) => (b.size || b.rows) - (a.size || a.rows))
        .slice(0, 10);

      const totalRows = tables.reduce((s, t) => s + t.rows, 0);
      const totalDataSize = tables.reduce((s, t) => s + (t.size || 0), 0);

      el.innerHTML = `
        <!-- Quick Actions -->
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
          <button class="btn btn-sm btn-primary" id="db-backup-now"><i class="fas fa-download"></i> Create Backup Now</button>
        </div>
        <!-- Overview Cards -->
        <div class="stat-cards" style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
          <div class="card" style="flex:1;min-width:140px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--accent)">${Utils.formatBytes(f.size)}</div>
            <div class="text-muted text-sm">DB File Size</div>
          </div>
          <div class="card" style="flex:1;min-width:140px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:${f.walSize > 50 * 1024 * 1024 ? 'var(--yellow)' : 'var(--green)'}">${Utils.formatBytes(f.walSize)}</div>
            <div class="text-muted text-sm">WAL Size</div>
          </div>
          <div class="card" style="flex:1;min-width:140px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--text)">${tables.length}</div>
            <div class="text-muted text-sm">Tables</div>
          </div>
          <div class="card" style="flex:1;min-width:140px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:${totalRows > 1000000 ? 'var(--yellow)' : 'var(--text)'}">${totalRows.toLocaleString()}</div>
            <div class="text-muted text-sm">Total Rows</div>
          </div>
        </div>

        <div class="info-grid">
          <!-- Top 10 Tables -->
          <div class="card">
            <div class="card-header"><h3><i class="fas fa-table" style="margin-right:8px"></i>Top 10 Tables</h3></div>
            <div class="card-body" style="padding:0">
              <table class="data-table">
                <thead><tr><th style="text-align:left">Table</th><th>Rows</th><th>Size</th><th>Indexes</th></tr></thead>
                <tbody>${topTables.map(t => {
                  const pct = totalDataSize > 0 ? ((t.size / totalDataSize) * 100).toFixed(1) : 0;
                  const sizeColor = t.size > 100 * 1024 * 1024 ? 'color:var(--yellow);font-weight:600' : '';
                  return `<tr>
                    <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(t.name)}</td>
                    <td>${t.rows.toLocaleString()}</td>
                    <td style="${sizeColor}">${t.size > 0 ? Utils.formatBytes(t.size) : '—'}${pct > 1 ? ` <span class="text-muted text-sm">(${pct}%)</span>` : ''}</td>
                    <td>${t.indexes}</td>
                  </tr>`;
                }).join('')}</tbody>
              </table>
            </div>
          </div>

          <!-- Engine Info & Retention -->
          <div class="card">
            <div class="card-header"><h3><i class="fas fa-cog" style="margin-right:8px"></i>Engine & Retention</h3></div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>SQLite Version</td><td class="mono">${Utils.escapeHtml(e.sqliteVersion)}</td></tr>
                <tr><td>Journal Mode</td><td class="mono">${Utils.escapeHtml(e.journalMode)}</td></tr>
                <tr><td>Page Size</td><td>${Utils.formatBytes(e.pageSize)}</td></tr>
                <tr><td>Total Pages</td><td>${e.pageCount.toLocaleString()}</td></tr>
                <tr><td>Free Pages</td><td>${e.freelistCount.toLocaleString()} ${e.freelistBytes > 0 ? `(${Utils.formatBytes(e.freelistBytes)})` : ''}</td></tr>
                <tr><td>Last Modified</td><td>${Utils.formatDate(f.modified)}</td></tr>
              </table>

              <h4 style="margin:16px 0 8px;font-size:13px;text-transform:uppercase;color:var(--text-muted)">Data Retention</h4>
              <table class="info-table">
                <tr><td>Raw Stats</td><td>${ret.statsRawHours}h</td></tr>
                <tr><td>1-min Stats</td><td>${ret.stats1mDays}d</td></tr>
                <tr><td>1-hour Stats</td><td>${ret.stats1hDays}d</td></tr>
                <tr><td>Audit Log</td><td>${ret.auditDays}d</td></tr>
                <tr><td>Docker Events</td><td>${ret.eventDays}d</td></tr>
              </table>
            </div>
          </div>
        </div>

        <!-- Maintenance Actions -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><h3><i class="fas fa-tools" style="margin-right:8px"></i>Maintenance</h3></div>
          <div class="card-body">
            <div style="display:flex;gap:16px;flex-wrap:wrap">
              <div class="card" style="flex:1;min-width:260px;padding:20px">
                <h4><i class="fas fa-broom" style="color:var(--accent);margin-right:8px"></i>Cleanup Old Data</h4>
                <p class="text-muted text-sm" style="margin:8px 0">Delete all logs, stats, events, and audit entries older than retention limits. This runs automatically every hour.</p>
                <button class="btn btn-sm btn-warning" id="db-cleanup-btn">
                  <i class="fas fa-broom"></i> Run Cleanup Now
                </button>
                <div id="db-cleanup-result" style="margin-top:8px"></div>
              </div>
              <div class="card" style="flex:1;min-width:260px;padding:20px">
                <h4><i class="fas fa-fire" style="color:var(--red);margin-right:8px"></i>Deep Cleanup (24h)</h4>
                <p class="text-muted text-sm" style="margin:8px 0">Delete <strong>everything</strong> except the last 24 hours: stats, logs, audit trail, alerts, events, scan results, notifications. Useful to free up disk space quickly.</p>
                <button class="btn btn-sm btn-danger" id="db-deep-cleanup-btn">
                  <i class="fas fa-fire"></i> Deep Cleanup
                </button>
                <div id="db-deep-cleanup-result" style="margin-top:8px"></div>
              </div>
              <div class="card" style="flex:1;min-width:260px;padding:20px">
                <h4><i class="fas fa-compress-arrows-alt" style="color:var(--green);margin-right:8px"></i>Vacuum Database</h4>
                <p class="text-muted text-sm" style="margin:8px 0">Reclaim disk space by compacting the database file. Runs automatically daily at 03:30. May briefly slow down the app.</p>
                <button class="btn btn-sm btn-secondary" id="db-vacuum-btn">
                  <i class="fas fa-compress-arrows-alt"></i> Run Vacuum Now
                </button>
                <div id="db-vacuum-result" style="margin-top:8px"></div>
              </div>
              <div class="card" style="flex:1;min-width:260px;padding:20px">
                <h4><i class="fas fa-file-archive" style="color:var(--accent);margin-right:8px"></i>Diagnostic Bundle</h4>
                <p class="text-muted text-sm" style="margin:8px 0">Download a JSON file with Docker info, container states, recent logs, database stats, and system health. Useful for troubleshooting or support.</p>
                <button class="btn btn-sm btn-secondary" id="db-diagnostics-btn">
                  <i class="fas fa-download"></i> Download Diagnostics
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Active Sessions -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><h3><i class="fas fa-users" style="margin-right:8px"></i>Active Sessions</h3></div>
          <div class="card-body" id="sessions-panel">
            <div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading sessions...</div>
          </div>
        </div>
      `;

      // Load sessions
      try {
        const sessions = await Api.getSessions();
        const sessionsEl = el.querySelector('#sessions-panel');
        if (sessionsEl && sessions.length > 0) {
          sessionsEl.innerHTML = `
            <table class="data-table compact">
              <thead><tr><th>User</th><th>IP</th><th>Started</th><th>Browser / Client</th><th></th></tr></thead>
              <tbody>
                ${sessions.map(s => `
                  <tr>
                    <td><i class="fas fa-user-circle" style="margin-right:6px;color:var(--accent)"></i>${Utils.escapeHtml(s.username)}${s.isCurrent ? ' <span class="badge badge-info" style="font-size:9px">you</span>' : ''}</td>
                    <td class="mono text-sm">${Utils.escapeHtml(s.ip || '—')}</td>
                    <td class="text-sm text-muted">${s.createdAt ? Utils.timeAgo(s.createdAt) : '—'}</td>
                    <td class="text-sm text-muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escapeHtml(s.userAgent || '')}">${Utils.escapeHtml((s.userAgent || '—').substring(0, 60))}${(s.userAgent || '').length > 60 ? '…' : ''}</td>
                    <td>${!s.isCurrent ? `<button class="action-btn danger" data-terminate-session="${s.id}" title="Terminate session"><i class="fas fa-times"></i></button>` : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `;
          sessionsEl.querySelectorAll('[data-terminate-session]').forEach(btn => {
            btn.addEventListener('click', async () => {
              const ok = await Modal.confirm('Terminate this session? The user will be logged out.', { danger: true, confirmText: 'Terminate' });
              if (!ok) return;
              try {
                await Api.terminateSession(btn.dataset.terminateSession);
                Toast.success('Session terminated');
                btn.closest('tr').remove();
              } catch (err) { Toast.error(err.message); }
            });
          });
        } else if (sessionsEl) {
          sessionsEl.innerHTML = '<div class="text-muted text-sm">No active sessions found.</div>';
        }
      } catch { /* sessions not available */ }

      // Backup button
      el.querySelector('#db-backup-now')?.addEventListener('click', async () => {
        try {
          Toast.info('Creating backup...');
          const result = await Api.post('/backup/database');
          if (result.ok) Toast.success('Backup created: ' + Utils.formatBytes(result.size));
          else Toast.error('Backup failed');
        } catch (err) { Toast.error(err.message); }
      });

      // Cleanup button
      el.querySelector('#db-cleanup-btn').addEventListener('click', async () => {
        const ok = await Modal.confirm(
          'Run database cleanup? This will delete all data older than the configured retention limits.',
          { confirmText: 'Run Cleanup' }
        );
        if (!ok) return;

        const btn = el.querySelector('#db-cleanup-btn');
        const resultEl = el.querySelector('#db-cleanup-result');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cleaning...';

        try {
          const result = await Api.databaseCleanup();
          const entries = Object.entries(result.deleted || {});
          if (entries.length > 0) {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check"></i> Deleted ${result.totalDeleted.toLocaleString()} rows: ${entries.map(([k, v]) => `${k} (${v})`).join(', ')}</div>`;
          } else {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check"></i> Nothing to clean — all data is within retention limits.</div>`;
          }
          Toast.success(`Cleanup done: ${result.totalDeleted} rows deleted`);
        } catch (err) {
          resultEl.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-times"></i> ${err.message}</div>`;
          Toast.error(err.message);
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-broom"></i> Run Cleanup Now';
      });

      // Deep cleanup button (keep last 24h only)
      el.querySelector('#db-deep-cleanup-btn').addEventListener('click', async () => {
        const ok = await Modal.confirm(
          `<div style="max-width:450px">
            <p style="margin:0 0 12px"><strong style="color:var(--red)">Deep Cleanup — Keep last 24 hours only</strong></p>
            <p class="text-sm" style="margin:0 0 12px">This will <strong>permanently delete</strong> all data older than 24 hours from:</p>
            <ul class="text-sm" style="margin:0 0 12px;padding-left:20px;color:var(--text)">
              <li>Container stats (CPU, RAM, network metrics)</li>
              <li>Aggregated stats (1-minute and 1-hour buckets)</li>
              <li>Audit log entries</li>
              <li>Docker events</li>
              <li>Alert and health events</li>
              <li>Webhook delivery history</li>
              <li>Scan results</li>
              <li>Notifications</li>
              <li>Schedule execution history</li>
              <li>Login attempts</li>
            </ul>
            <p class="text-sm" style="margin:0;color:var(--red)"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>This action is irreversible. Historical trends and reports will be lost.</p>
          </div>`,
          { confirmText: 'Delete Everything Older Than 24h', danger: true }
        );
        if (!ok) return;

        const btn = el.querySelector('#db-deep-cleanup-btn');
        const resultEl = el.querySelector('#db-deep-cleanup-result');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cleaning...';

        try {
          const result = await Api.databaseCleanupAggressive(24);
          const entries = Object.entries(result.deleted || {});
          if (entries.length > 0) {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check"></i> Deleted ${result.totalDeleted.toLocaleString()} rows: ${entries.map(([k, v]) => `${k} (${v})`).join(', ')}</div>`;
          } else {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check"></i> Nothing to delete — all data is already within 24 hours.</div>`;
          }
          Toast.success(`Deep cleanup done: ${result.totalDeleted} rows deleted`);
        } catch (err) {
          resultEl.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-times"></i> ${err.message}</div>`;
          Toast.error(err.message);
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-fire"></i> Deep Cleanup';
      });

      // Vacuum button
      el.querySelector('#db-vacuum-btn').addEventListener('click', async () => {
        const ok = await Modal.confirm(
          'Run VACUUM? This compacts the database file to reclaim disk space. The app may be briefly unresponsive.',
          { confirmText: 'Run Vacuum' }
        );
        if (!ok) return;

        const btn = el.querySelector('#db-vacuum-btn');
        const resultEl = el.querySelector('#db-vacuum-result');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Vacuuming...';

        try {
          const result = await Api.databaseVacuum();
          const freedStr = Utils.formatBytes(result.freed);
          const afterStr = Utils.formatBytes(result.sizeAfter);
          if (result.freed > 0) {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check"></i> Freed ${freedStr}. New size: ${afterStr}</div>`;
            Toast.success(`Vacuum done: freed ${freedStr}`);
          } else {
            resultEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check"></i> Database is already compact (${afterStr}).</div>`;
            Toast.success('Database is already compact');
          }
        } catch (err) {
          resultEl.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-times"></i> ${err.message}</div>`;
          Toast.error(err.message);
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i> Run Vacuum Now';
      });

      // Diagnostics download button
      el.querySelector('#db-diagnostics-btn')?.addEventListener('click', () => {
        window.open('/api/system/database/diagnostics', '_blank');
        Toast.success('Generating diagnostic bundle...');
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Tools Tab ─────────────────────────────────────
  _toolsDef() {
    return [
      // Docker tools (existing)
      { id: 'docker-run', name: 'docker run → Compose', icon: 'fa-terminal', color: '#388bfd', cat: 'docker', desc: 'Convert docker run commands to docker-compose YAML' },
      { id: 'proxy-labels', name: 'Reverse Proxy Labels', icon: 'fa-tags', color: '#3fb950', cat: 'docker', desc: 'Generate Traefik or Caddy reverse proxy labels' },
      { id: 'ai-logs', name: 'AI Log Analysis', icon: 'fa-robot', color: '#a371f7', cat: 'docker', desc: 'Generate diagnostic prompts from container logs' },
      // Security
      { id: 'password-gen', name: 'Password Generator', icon: 'fa-key', color: '#f85149', cat: 'security', desc: 'Generate secure random passwords with custom rules' },
      { id: 'password-strength', name: 'Password Strength', icon: 'fa-shield-alt', color: '#db6d28', cat: 'security', desc: 'Check password entropy, crack time and strength' },
      { id: 'hash-gen', name: 'Hash Generator', icon: 'fa-hashtag', color: '#a371f7', cat: 'security', desc: 'Generate SHA-1, SHA-256, SHA-512 hashes' },
      // Network
      { id: 'ip-calc', name: 'IP/Subnet Calculator', icon: 'fa-network-wired', color: '#0ea5e9', cat: 'network', desc: 'Calculate network, broadcast, host range from CIDR' },
      { id: 'url-codec', name: 'URL Encoder/Decoder', icon: 'fa-link', color: '#3fb950', cat: 'network', desc: 'Encode and decode URL components' },
      // Converters
      { id: 'base64', name: 'Base64 Encode/Decode', icon: 'fa-exchange-alt', color: '#388bfd', cat: 'converters', desc: 'Convert text to/from Base64 encoding' },
      { id: 'json-fmt', name: 'JSON Formatter', icon: 'fa-code', color: '#d29922', cat: 'converters', desc: 'Format, minify and validate JSON data' },
      { id: 'epoch', name: 'Epoch/Date Converter', icon: 'fa-clock', color: '#8b5cf6', cat: 'converters', desc: 'Convert between epoch timestamps and dates' },
      { id: 'storage-conv', name: 'Storage Unit Converter', icon: 'fa-hdd', color: '#39d0d8', cat: 'converters', desc: 'Convert between B, KB, MB, GB, TB (binary & decimal)' },
      // Text Tools
      { id: 'regex', name: 'Regex Tester', icon: 'fa-asterisk', color: '#f472b6', cat: 'text', desc: 'Test regex patterns with match highlighting' },
      { id: 'text-diff', name: 'Text Diff', icon: 'fa-columns', color: '#6366f1', cat: 'text', desc: 'Compare two texts with line-by-line diff' },
      { id: 'lorem', name: 'Lorem Ipsum Generator', icon: 'fa-paragraph', color: '#14b8a6', cat: 'text', desc: 'Generate placeholder text (paragraphs, sentences, words)' },
      // Reference
      { id: 'http-codes', name: 'HTTP Status Codes', icon: 'fa-globe', color: '#06b6d4', cat: 'reference', desc: 'Searchable reference of HTTP status codes' },
      { id: 'port-ref', name: 'Port Reference', icon: 'fa-server', color: '#ec4899', cat: 'reference', desc: 'Common network ports and their services' },
      // Converters (extra)
      { id: 'html2md', name: 'HTML → Markdown', icon: 'fa-file-code', color: '#f97316', cat: 'converters', desc: 'Convert HTML to Markdown with live preview' },
      { id: 'md2html', name: 'Markdown → HTML', icon: 'fa-file-alt', color: '#10b981', cat: 'converters', desc: 'Convert Markdown to HTML with live preview' },
    ];
  },

  _renderTools(el) {
    const tools = this._toolsDef();
    const cats = [
      { key: '', label: 'All', count: tools.length },
      { key: 'docker', label: 'Docker', count: tools.filter(t => t.cat === 'docker').length },
      { key: 'security', label: 'Security', count: tools.filter(t => t.cat === 'security').length },
      { key: 'network', label: 'Network', count: tools.filter(t => t.cat === 'network').length },
      { key: 'converters', label: 'Converters', count: tools.filter(t => t.cat === 'converters').length },
      { key: 'text', label: 'Text Tools', count: tools.filter(t => t.cat === 'text').length },
      { key: 'reference', label: 'Reference', count: tools.filter(t => t.cat === 'reference').length },
    ];

    el.innerHTML = `
      <div class="tool-filter-bar">
        <div class="search-box" style="flex:1;min-width:200px;max-width:320px">
          <i class="fas fa-search"></i>
          <input type="text" id="tools-search" placeholder="Search tools...">
        </div>
        ${cats.map(c => `<button class="tool-filter-btn${c.key === '' ? ' active' : ''}" data-cat="${c.key}">${c.label}<span class="tool-filter-count">${c.count}</span></button>`).join('')}
      </div>
      <div class="tools-grid" id="tools-grid">
        ${tools.map(t => `
          <div class="tool-card" data-tool="${t.id}" data-cat="${t.cat}" data-search="${t.name.toLowerCase()} ${t.desc.toLowerCase()}">
            <div class="tool-card-icon" style="background:${t.color}"><i class="fas ${t.icon}"></i></div>
            <div class="tool-card-title">${t.name}</div>
            <span class="tool-cat-badge tool-cat-${t.cat}">${t.cat}</span>
            <div class="tool-card-desc">${t.desc}</div>
          </div>
        `).join('')}
      </div>
    `;

    // Filter by category
    el.querySelectorAll('.tool-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.tool-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cat = btn.dataset.cat;
        el.querySelectorAll('.tool-card').forEach(card => {
          card.style.display = (!cat || card.dataset.cat === cat) ? '' : 'none';
        });
      });
    });

    // Search
    el.querySelector('#tools-search').addEventListener('input', Utils.debounce((e) => {
      const q = e.target.value.toLowerCase();
      const activeCat = el.querySelector('.tool-filter-btn.active')?.dataset?.cat || '';
      el.querySelectorAll('.tool-card').forEach(card => {
        const matchSearch = !q || card.dataset.search.includes(q);
        const matchCat = !activeCat || card.dataset.cat === activeCat;
        card.style.display = (matchSearch && matchCat) ? '' : 'none';
      });
    }, 150));

    // Card click → open tool modal
    el.querySelectorAll('.tool-card').forEach(card => {
      card.addEventListener('click', () => this._openToolModal(card.dataset.tool));
    });
  },

  _openToolModal(toolId) {
    const tool = this._toolsDef().find(t => t.id === toolId);
    if (!tool) return;

    const modalBody = this._getToolModalBody(toolId);
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas ${tool.icon}" style="margin-right:10px;color:${tool.color}"></i>${tool.name}</h3>
        <button class="modal-close-btn" id="tool-modal-close-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body tool-modal-content">${modalBody}</div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="tool-modal-close-btn">Close</button>
      </div>
    `, { width: '650px' });

    Modal._content.querySelector('#tool-modal-close-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#tool-modal-close-btn').addEventListener('click', () => Modal.close());

    // Initialize tool interactions after modal is open
    setTimeout(() => this._initToolModal(toolId), 50);
  },

  _getToolModalBody(id) {
    switch (id) {
      case 'docker-run': return `
        <p class="text-sm text-muted" style="margin-bottom:12px">Paste a <code>docker run</code> command to convert to docker-compose YAML.</p>
        <textarea id="tm-run-input" class="form-control" rows="4" placeholder="docker run -d --name myapp -p 8080:80 -v data:/app/data nginx:alpine"></textarea>
        <button class="btn btn-sm btn-primary" id="tm-run-convert" style="margin-top:8px"><i class="fas fa-exchange-alt"></i> Convert</button>
        <div id="tm-run-output" style="margin-top:12px;display:none">
          <textarea id="tm-run-yaml" class="form-control" rows="12" readonly></textarea>
          <button class="btn btn-sm btn-secondary" id="tm-run-copy" style="margin-top:4px"><i class="fas fa-copy"></i> Copy</button>
        </div>`;
      case 'proxy-labels': return `
        <p class="text-sm text-muted" style="margin-bottom:12px">Generate Traefik or Caddy reverse proxy labels.</p>
        <div class="form-group"><label>Proxy Type</label>
          <select id="tm-proxy-type" class="form-control"><option value="traefik">Traefik v2</option><option value="caddy">Caddy</option></select></div>
        <div style="display:flex;gap:8px">
          <div class="form-group" style="flex:1"><label>Domain</label><input type="text" id="tm-proxy-domain" class="form-control" placeholder="app.example.com"></div>
          <div class="form-group" style="flex:1"><label>Container Port</label><input type="number" id="tm-proxy-port" class="form-control" value="80"></div>
        </div>
        <div class="form-group"><label><input type="checkbox" id="tm-proxy-tls" checked> Enable HTTPS</label></div>
        <button class="btn btn-sm btn-primary" id="tm-proxy-gen"><i class="fas fa-magic"></i> Generate</button>
        <div id="tm-proxy-output" style="margin-top:12px;display:none">
          <textarea id="tm-proxy-labels" class="form-control" rows="10" readonly></textarea>
          <button class="btn btn-sm btn-secondary" id="tm-proxy-copy" style="margin-top:4px"><i class="fas fa-copy"></i> Copy</button>
        </div>`;
      case 'ai-logs': return `
        <p class="text-sm text-muted" style="margin-bottom:12px">Generate a diagnostic prompt from container logs for AI analysis.</p>
        <div class="form-group"><label>Container</label>
          <select id="tm-ai-container" class="form-control"><option value="">Loading...</option></select></div>
        <div class="form-group"><label>Log lines (last N)</label><input type="number" id="tm-ai-lines" class="form-control" value="50" min="10" max="200"></div>
        <button class="btn btn-sm btn-primary" id="tm-ai-gen"><i class="fas fa-magic"></i> Generate Prompt</button>
        <div id="tm-ai-output" style="margin-top:12px;display:none">
          <textarea id="tm-ai-prompt" class="form-control" rows="14" readonly></textarea>
          <button class="btn btn-sm btn-secondary" id="tm-ai-copy" style="margin-top:4px"><i class="fas fa-copy"></i> Copy</button>
        </div>`;
      case 'password-gen': return `
        <div class="form-group"><label>Length: <span id="tm-pw-len-val">16</span></label>
          <input type="range" id="tm-pw-len" min="8" max="128" value="16" style="width:100%"></div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
          <label><input type="checkbox" id="tm-pw-upper" checked> Uppercase (A-Z)</label>
          <label><input type="checkbox" id="tm-pw-lower" checked> Lowercase (a-z)</label>
          <label><input type="checkbox" id="tm-pw-digits" checked> Digits (0-9)</label>
          <label><input type="checkbox" id="tm-pw-symbols" checked> Symbols (!@#$...)</label>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm btn-primary" id="tm-pw-gen"><i class="fas fa-sync-alt"></i> Generate</button>
          <button class="btn btn-sm btn-secondary" id="tm-pw-copy"><i class="fas fa-copy"></i> Copy</button>
        </div>
        <div class="tool-output" id="tm-pw-result" style="font-size:16px;letter-spacing:1px;text-align:center;padding:16px"></div>`;
      case 'password-strength': return `
        <div class="form-group"><label>Enter password</label>
          <input type="text" id="tm-ps-input" class="form-control" placeholder="Type or paste a password..." autocomplete="off"></div>
        <div class="strength-bar"><div class="strength-bar-fill" id="tm-ps-bar" style="width:0"></div></div>
        <div id="tm-ps-result" style="margin-top:12px"></div>`;
      case 'hash-gen': return `
        <div class="form-group"><label>Input text</label>
          <textarea id="tm-hash-input" class="form-control" rows="3" placeholder="Type or paste text to hash..."></textarea></div>
        <button class="btn btn-sm btn-primary" id="tm-hash-gen" style="margin-bottom:12px"><i class="fas fa-hashtag"></i> Generate Hashes</button>
        <div id="tm-hash-output"></div>`;
      case 'ip-calc': return `
        <div class="form-group"><label>IP Address / CIDR</label>
          <input type="text" id="tm-ip-input" class="form-control" placeholder="192.168.1.0/24"></div>
        <button class="btn btn-sm btn-primary" id="tm-ip-calc"><i class="fas fa-calculator"></i> Calculate</button>
        <div id="tm-ip-output" style="margin-top:12px"></div>`;
      case 'url-codec': return `
        <div class="form-group"><label>Decoded</label>
          <textarea id="tm-url-decoded" class="form-control" rows="3" placeholder="Hello World! foo=bar&baz=qux"></textarea></div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm btn-primary" id="tm-url-encode"><i class="fas fa-arrow-down"></i> Encode ↓</button>
          <button class="btn btn-sm btn-primary" id="tm-url-decode"><i class="fas fa-arrow-up"></i> Decode ↑</button>
        </div>
        <div class="form-group"><label>Encoded</label>
          <textarea id="tm-url-encoded" class="form-control" rows="3" placeholder="Hello%20World%21%20foo%3Dbar%26baz%3Dqux"></textarea></div>`;
      case 'base64': return `
        <div class="form-group"><label>Text</label>
          <textarea id="tm-b64-text" class="form-control" rows="3" placeholder="Plain text..."></textarea></div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm btn-primary" id="tm-b64-encode"><i class="fas fa-arrow-down"></i> Encode ↓</button>
          <button class="btn btn-sm btn-primary" id="tm-b64-decode"><i class="fas fa-arrow-up"></i> Decode ↑</button>
        </div>
        <div class="form-group"><label>Base64</label>
          <textarea id="tm-b64-b64" class="form-control" rows="3" placeholder="Base64 encoded..."></textarea></div>`;
      case 'json-fmt': return `
        <div class="form-group"><label>JSON Input</label>
          <textarea id="tm-json-input" class="form-control" rows="10" placeholder='{"key":"value","arr":[1,2,3]}'></textarea></div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button class="btn btn-sm btn-primary" id="tm-json-format"><i class="fas fa-indent"></i> Format</button>
          <button class="btn btn-sm btn-secondary" id="tm-json-minify"><i class="fas fa-compress-alt"></i> Minify</button>
          <button class="btn btn-sm btn-secondary" id="tm-json-validate"><i class="fas fa-check"></i> Validate</button>
          <button class="btn btn-sm btn-secondary" id="tm-json-copy"><i class="fas fa-copy"></i> Copy</button>
        </div>
        <div id="tm-json-msg" style="font-size:12px;margin-top:4px"></div>`;
      case 'epoch': return `
        <div class="form-group"><label>Epoch (seconds)</label>
          <div style="display:flex;gap:8px"><input type="number" id="tm-epoch-input" class="form-control" placeholder="1711612800">
          <button class="btn btn-sm btn-primary" id="tm-epoch-now"><i class="fas fa-clock"></i> Now</button>
          <button class="btn btn-sm btn-secondary" id="tm-epoch-to-date">→ Date</button></div></div>
        <div id="tm-epoch-date-result" style="margin-bottom:12px"></div>
        <div class="form-group"><label>Date/Time</label>
          <div style="display:flex;gap:8px"><input type="datetime-local" id="tm-epoch-date" class="form-control">
          <button class="btn btn-sm btn-secondary" id="tm-epoch-to-epoch">→ Epoch</button></div></div>
        <div id="tm-epoch-epoch-result"></div>`;
      case 'storage-conv': return `
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <div class="form-group" style="flex:1"><label>Value</label>
            <input type="number" id="tm-stor-val" class="form-control" value="1" min="0" step="any"></div>
          <div class="form-group" style="flex:0 0 120px"><label>Unit</label>
            <select id="tm-stor-unit" class="form-control">
              <option value="B">Bytes (B)</option><option value="KB">KB</option><option value="MB">MB</option>
              <option value="GB" selected>GB</option><option value="TB">TB</option>
            </select></div>
        </div>
        <button class="btn btn-sm btn-primary" id="tm-stor-calc" style="margin-bottom:12px"><i class="fas fa-calculator"></i> Convert</button>
        <div id="tm-stor-output"></div>`;
      case 'regex': return `
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div class="form-group" style="flex:1"><label>Pattern</label>
            <input type="text" id="tm-regex-pattern" class="form-control" placeholder="\\d+"></div>
          <div class="form-group" style="flex:0 0 100px"><label>Flags</label>
            <input type="text" id="tm-regex-flags" class="form-control" value="g" placeholder="g, i, m"></div>
        </div>
        <div class="form-group"><label>Test String</label>
          <textarea id="tm-regex-input" class="form-control" rows="4" placeholder="Enter text to test against..."></textarea></div>
        <button class="btn btn-sm btn-primary" id="tm-regex-test"><i class="fas fa-play"></i> Test</button>
        <div id="tm-regex-output" style="margin-top:12px"></div>`;
      case 'text-diff': return `
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <div class="form-group" style="flex:1"><label>Original</label>
            <textarea id="tm-diff-a" class="form-control" rows="8" placeholder="Original text..."></textarea></div>
          <div class="form-group" style="flex:1"><label>Modified</label>
            <textarea id="tm-diff-b" class="form-control" rows="8" placeholder="Modified text..."></textarea></div>
        </div>
        <button class="btn btn-sm btn-primary" id="tm-diff-compare"><i class="fas fa-columns"></i> Compare</button>
        <div id="tm-diff-output" class="diff-result" style="margin-top:12px"></div>`;
      case 'lorem': return `
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div class="form-group" style="flex:1"><label>Type</label>
            <select id="tm-lorem-type" class="form-control">
              <option value="paragraphs">Paragraphs</option><option value="sentences">Sentences</option><option value="words">Words</option>
            </select></div>
          <div class="form-group" style="flex:0 0 100px"><label>Count</label>
            <input type="number" id="tm-lorem-count" class="form-control" value="3" min="1" max="50"></div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm btn-primary" id="tm-lorem-gen"><i class="fas fa-paragraph"></i> Generate</button>
          <button class="btn btn-sm btn-secondary" id="tm-lorem-copy"><i class="fas fa-copy"></i> Copy</button>
        </div>
        <div class="tool-output" id="tm-lorem-output" style="max-height:300px;overflow:auto;white-space:pre-wrap"></div>`;
      case 'http-codes': return `
        <div class="form-group" style="margin-bottom:12px">
          <input type="text" id="tm-http-search" class="form-control" placeholder="Search by code or name...">
        </div>
        <div style="max-height:450px;overflow:auto"><table class="ref-table" id="tm-http-table">
          <thead><tr><th style="width:70px">Code</th><th>Name</th><th>Description</th></tr></thead>
          <tbody></tbody></table></div>`;
      case 'port-ref': return `
        <div class="form-group" style="margin-bottom:12px">
          <input type="text" id="tm-port-search" class="form-control" placeholder="Search by port, protocol, or service...">
        </div>
        <div style="max-height:450px;overflow:auto"><table class="ref-table" id="tm-port-table">
          <thead><tr><th style="width:70px">Port</th><th style="width:60px">Proto</th><th>Service</th><th>Description</th></tr></thead>
          <tbody></tbody></table></div>`;
      case 'html2md': return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label>HTML Input</label>
            <textarea id="tm-h2m-input" class="form-control" rows="14" style="font-family:var(--mono);font-size:12px" placeholder="<h1>Hello</h1>\n<p>Paste your <strong>HTML</strong> here</p>"></textarea>
          </div>
          <div class="form-group" style="margin:0">
            <label>Markdown Output</label>
            <textarea id="tm-h2m-output" class="form-control" rows="14" style="font-family:var(--mono);font-size:12px" readonly></textarea>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm btn-primary" id="tm-h2m-convert"><i class="fas fa-arrow-right"></i> Convert</button>
          <button class="btn btn-sm btn-secondary" id="tm-h2m-copy"><i class="fas fa-copy"></i> Copy</button>
          <label style="margin-left:auto;font-size:12px"><input type="checkbox" id="tm-h2m-live"> Live preview</label>
        </div>
        <div style="margin-top:12px">
          <label>Preview</label>
          <div id="tm-h2m-preview" style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);min-height:60px;font-size:13px"></div>
        </div>`;
      case 'md2html': return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label>Markdown Input</label>
            <textarea id="tm-m2h-input" class="form-control" rows="14" style="font-family:var(--mono);font-size:12px" placeholder="# Hello\n\nType your **Markdown** here"></textarea>
          </div>
          <div class="form-group" style="margin:0">
            <label>HTML Output</label>
            <textarea id="tm-m2h-output" class="form-control" rows="14" style="font-family:var(--mono);font-size:12px" readonly></textarea>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm btn-primary" id="tm-m2h-convert"><i class="fas fa-arrow-right"></i> Convert</button>
          <button class="btn btn-sm btn-secondary" id="tm-m2h-copy"><i class="fas fa-copy"></i> Copy</button>
          <label style="margin-left:auto;font-size:12px"><input type="checkbox" id="tm-m2h-live"> Live preview</label>
        </div>
        <div style="margin-top:12px">
          <label>Preview</label>
          <div id="tm-m2h-preview" style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);min-height:60px;font-size:13px"></div>
        </div>`;
      default: return '<p>Tool not implemented yet.</p>';
    }
  },

  _initToolModal(id) {
    const mc = Modal._content;
    if (!mc) return;

    switch (id) {
      case 'docker-run': {
        mc.querySelector('#tm-run-convert').addEventListener('click', () => {
          const input = mc.querySelector('#tm-run-input').value.trim();
          if (!input) { Toast.warning('Paste a docker run command'); return; }
          try {
            const yaml = this._dockerRunToCompose(input);
            mc.querySelector('#tm-run-yaml').value = yaml;
            mc.querySelector('#tm-run-output').style.display = '';
          } catch (err) { Toast.error('Parse error: ' + err.message); }
        });
        mc.querySelector('#tm-run-copy').addEventListener('click', () => {
          Utils.copyToClipboard(mc.querySelector('#tm-run-yaml').value); Toast.success('Copied!');
        });
        break;
      }
      case 'proxy-labels': {
        mc.querySelector('#tm-proxy-gen').addEventListener('click', () => {
          const type = mc.querySelector('#tm-proxy-type').value;
          const domain = mc.querySelector('#tm-proxy-domain').value.trim();
          const port = mc.querySelector('#tm-proxy-port').value;
          const tls = mc.querySelector('#tm-proxy-tls').checked;
          if (!domain) { Toast.warning('Enter a domain'); return; }
          const labels = this._generateProxyLabels(type, domain, port, tls);
          mc.querySelector('#tm-proxy-labels').value = labels;
          mc.querySelector('#tm-proxy-output').style.display = '';
        });
        mc.querySelector('#tm-proxy-copy').addEventListener('click', () => {
          Utils.copyToClipboard(mc.querySelector('#tm-proxy-labels').value); Toast.success('Copied!');
        });
        break;
      }
      case 'ai-logs': {
        Api.getContainers().then(containers => {
          const sel = mc.querySelector('#tm-ai-container');
          if (sel) sel.innerHTML = containers.map(c => {
            const name = Utils.containerName(c.Names || c.names);
            return `<option value="${c.Id || c.id}">${Utils.escapeHtml(name)} (${c.State || c.state})</option>`;
          }).join('');
        }).catch(() => {});
        mc.querySelector('#tm-ai-gen').addEventListener('click', async () => {
          const containerId = mc.querySelector('#tm-ai-container').value;
          const lines = parseInt(mc.querySelector('#tm-ai-lines').value) || 50;
          if (!containerId) { Toast.warning('Select a container'); return; }
          try {
            const [logs, inspect] = await Promise.all([Api.getContainerLogs(containerId, lines), Api.getContainer(containerId)]);
            const name = Utils.containerName(inspect.Name || inspect.name);
            const image = inspect.Config?.Image || inspect.config?.Image || '';
            const state = inspect.State?.Status || inspect.state?.Status || '';
            const exitCode = inspect.State?.ExitCode ?? '';
            const logText = typeof logs === 'string' ? logs : (logs.logs || logs.stdout || '');
            const prompt = `I have a Docker container that needs diagnosis. Please analyze the following information and provide:\n1. What the likely issue is\n2. Recommended fixes (most likely first)\n3. Any preventive measures\n\n**Container:** ${name}\n**Image:** ${image}\n**State:** ${state}${exitCode !== '' ? ` (exit code: ${exitCode})` : ''}\n\n**Last ${lines} log lines:**\n\`\`\`\n${logText.substring(0, 3000)}\n\`\`\`\n\n**Container Config:**\n- Restart Policy: ${inspect.HostConfig?.RestartPolicy?.Name || 'none'}\n- Memory Limit: ${inspect.HostConfig?.Memory ? Utils.formatBytes(inspect.HostConfig.Memory) : 'unlimited'}\n- CPU Shares: ${inspect.HostConfig?.CpuShares || 'default'}`;
            mc.querySelector('#tm-ai-prompt').value = prompt;
            mc.querySelector('#tm-ai-output').style.display = '';
          } catch (err) { Toast.error(err.message); }
        });
        mc.querySelector('#tm-ai-copy').addEventListener('click', () => {
          Utils.copyToClipboard(mc.querySelector('#tm-ai-prompt').value); Toast.success('Copied!');
        });
        break;
      }
      case 'password-gen': {
        const generate = () => {
          const len = parseInt(mc.querySelector('#tm-pw-len').value);
          let chars = '';
          if (mc.querySelector('#tm-pw-upper').checked) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          if (mc.querySelector('#tm-pw-lower').checked) chars += 'abcdefghijklmnopqrstuvwxyz';
          if (mc.querySelector('#tm-pw-digits').checked) chars += '0123456789';
          if (mc.querySelector('#tm-pw-symbols').checked) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
          if (!chars) { Toast.warning('Select at least one character set'); return; }
          const arr = new Uint32Array(len);
          crypto.getRandomValues(arr);
          let pw = '';
          for (let i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
          mc.querySelector('#tm-pw-result').textContent = pw;
        };
        mc.querySelector('#tm-pw-gen').addEventListener('click', generate);
        mc.querySelector('#tm-pw-copy').addEventListener('click', () => {
          const pw = mc.querySelector('#tm-pw-result').textContent;
          if (pw) { Utils.copyToClipboard(pw); Toast.success('Copied!'); }
        });
        mc.querySelector('#tm-pw-len').addEventListener('input', (e) => {
          mc.querySelector('#tm-pw-len-val').textContent = e.target.value;
          generate();
        });
        ['#tm-pw-upper','#tm-pw-lower','#tm-pw-digits','#tm-pw-symbols'].forEach(s => {
          mc.querySelector(s).addEventListener('change', generate);
        });
        generate();
        break;
      }
      case 'password-strength': {
        const commonPasswords = ['password','123456','12345678','qwerty','abc123','monkey','master','dragon','111111',
          'baseball','iloveyou','trustno1','sunshine','princess','football','shadow','superman','letmein','welcome',
          'admin','login','passw0rd','starwars','hello','charlie','donald','password1','password123','1234567890'];
        mc.querySelector('#tm-ps-input').addEventListener('input', (e) => {
          const pw = e.target.value;
          const bar = mc.querySelector('#tm-ps-bar');
          const result = mc.querySelector('#tm-ps-result');
          if (!pw) { bar.style.width = '0'; result.innerHTML = ''; return; }
          // Calculate charset size
          let poolSize = 0;
          if (/[a-z]/.test(pw)) poolSize += 26;
          if (/[A-Z]/.test(pw)) poolSize += 26;
          if (/[0-9]/.test(pw)) poolSize += 10;
          if (/[^a-zA-Z0-9]/.test(pw)) poolSize += 33;
          const entropy = Math.floor(pw.length * Math.log2(poolSize || 1));
          const isCommon = commonPasswords.includes(pw.toLowerCase());
          let strength, color, pct;
          if (isCommon) { strength = 'Common password!'; color = '#f85149'; pct = 5; }
          else if (entropy < 28) { strength = 'Weak'; color = '#f85149'; pct = 15; }
          else if (entropy < 36) { strength = 'Fair'; color = '#db6d28'; pct = 35; }
          else if (entropy < 60) { strength = 'Good'; color = '#d29922'; pct = 55; }
          else if (entropy < 80) { strength = 'Strong'; color = '#3fb950'; pct = 80; }
          else { strength = 'Very Strong'; color = '#3fb950'; pct = 100; }
          // Crack time estimation
          const guessesPerSec = 1e10; // 10 billion/sec for modern hardware
          const totalGuesses = Math.pow(2, entropy);
          const seconds = totalGuesses / guessesPerSec;
          let crackTime;
          if (seconds < 1) crackTime = 'Instant';
          else if (seconds < 60) crackTime = Math.round(seconds) + ' seconds';
          else if (seconds < 3600) crackTime = Math.round(seconds / 60) + ' minutes';
          else if (seconds < 86400) crackTime = Math.round(seconds / 3600) + ' hours';
          else if (seconds < 31536000) crackTime = Math.round(seconds / 86400) + ' days';
          else if (seconds < 31536000 * 1000) crackTime = Math.round(seconds / 31536000) + ' years';
          else if (seconds < 31536000 * 1e6) crackTime = Math.round(seconds / (31536000 * 1000)) + 'K years';
          else crackTime = 'Centuries+';
          bar.style.width = pct + '%';
          bar.style.background = color;
          result.innerHTML = `
            <table class="info-table" style="margin-top:8px;font-size:12px">
              <tr><td>Strength</td><td><strong style="color:${color}">${strength}</strong></td></tr>
              <tr><td>Entropy</td><td>${entropy} bits</td></tr>
              <tr><td>Crack time</td><td>${crackTime} (10B guesses/sec)</td></tr>
              <tr><td>Length</td><td>${pw.length} characters</td></tr>
              <tr><td>Charset size</td><td>${poolSize} characters</td></tr>
              ${isCommon ? '<tr><td colspan="2" style="color:#f85149"><i class="fas fa-exclamation-triangle"></i> This is a commonly used password!</td></tr>' : ''}
            </table>`;
        });
        break;
      }
      case 'hash-gen': {
        mc.querySelector('#tm-hash-gen').addEventListener('click', async () => {
          const text = mc.querySelector('#tm-hash-input').value;
          if (!text) { Toast.warning('Enter some text'); return; }
          const enc = new TextEncoder().encode(text);
          const [sha1, sha256, sha512] = await Promise.all([
            crypto.subtle.digest('SHA-1', enc),
            crypto.subtle.digest('SHA-256', enc),
            crypto.subtle.digest('SHA-512', enc),
          ]);
          const toHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
          const hashes = [
            { label: 'SHA-1', value: toHex(sha1) },
            { label: 'SHA-256', value: toHex(sha256) },
            { label: 'SHA-512', value: toHex(sha512) },
          ];
          mc.querySelector('#tm-hash-output').innerHTML = hashes.map(h => `
            <div class="hash-row">
              <span class="hash-label">${h.label}</span>
              <code>${h.value}</code>
              <button class="btn btn-xs btn-secondary hash-copy-btn" data-val="${h.value}"><i class="fas fa-copy"></i></button>
            </div>`).join('');
          mc.querySelectorAll('.hash-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => { Utils.copyToClipboard(btn.dataset.val); Toast.success('Copied!'); });
          });
        });
        break;
      }
      case 'ip-calc': {
        mc.querySelector('#tm-ip-calc').addEventListener('click', () => {
          const input = mc.querySelector('#tm-ip-input').value.trim();
          const match = input.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
          if (!match) { Toast.warning('Enter IP in CIDR format (e.g. 192.168.1.0/24)'); return; }
          const octets = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3]), parseInt(match[4])];
          const cidr = parseInt(match[5]);
          if (octets.some(o => o > 255) || cidr > 32) { Toast.error('Invalid IP or CIDR'); return; }
          const ip = (octets[0] << 24 | octets[1] << 16 | octets[2] << 8 | octets[3]) >>> 0;
          const mask = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
          const network = (ip & mask) >>> 0;
          const broadcast = (network | ~mask) >>> 0;
          const firstHost = cidr >= 31 ? network : (network + 1) >>> 0;
          const lastHost = cidr >= 31 ? broadcast : (broadcast - 1) >>> 0;
          const totalHosts = cidr >= 31 ? Math.pow(2, 32 - cidr) : Math.pow(2, 32 - cidr) - 2;
          const wildcard = (~mask) >>> 0;
          const toIP = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
          mc.querySelector('#tm-ip-output').innerHTML = `
            <table class="info-table" style="font-size:12px">
              <tr><td>Network Address</td><td><strong>${toIP(network)}</strong></td></tr>
              <tr><td>Broadcast Address</td><td>${toIP(broadcast)}</td></tr>
              <tr><td>First Host</td><td>${toIP(firstHost)}</td></tr>
              <tr><td>Last Host</td><td>${toIP(lastHost)}</td></tr>
              <tr><td>Total Hosts</td><td>${totalHosts.toLocaleString()}</td></tr>
              <tr><td>Subnet Mask</td><td>${toIP(mask)}</td></tr>
              <tr><td>Wildcard Mask</td><td>${toIP(wildcard)}</td></tr>
              <tr><td>CIDR Notation</td><td>/${cidr}</td></tr>
            </table>`;
        });
        break;
      }
      case 'url-codec': {
        mc.querySelector('#tm-url-encode').addEventListener('click', () => {
          mc.querySelector('#tm-url-encoded').value = encodeURIComponent(mc.querySelector('#tm-url-decoded').value);
        });
        mc.querySelector('#tm-url-decode').addEventListener('click', () => {
          try {
            mc.querySelector('#tm-url-decoded').value = decodeURIComponent(mc.querySelector('#tm-url-encoded').value);
          } catch (e) { Toast.error('Invalid encoded string'); }
        });
        break;
      }
      case 'base64': {
        mc.querySelector('#tm-b64-encode').addEventListener('click', () => {
          try {
            mc.querySelector('#tm-b64-b64').value = btoa(unescape(encodeURIComponent(mc.querySelector('#tm-b64-text').value)));
          } catch (e) { Toast.error('Encoding failed'); }
        });
        mc.querySelector('#tm-b64-decode').addEventListener('click', () => {
          try {
            mc.querySelector('#tm-b64-text').value = decodeURIComponent(escape(atob(mc.querySelector('#tm-b64-b64').value)));
          } catch (e) { Toast.error('Invalid Base64 string'); }
        });
        break;
      }
      case 'json-fmt': {
        mc.querySelector('#tm-json-format').addEventListener('click', () => {
          try {
            const obj = JSON.parse(mc.querySelector('#tm-json-input').value);
            mc.querySelector('#tm-json-input').value = JSON.stringify(obj, null, 2);
            mc.querySelector('#tm-json-msg').innerHTML = '<span style="color:#3fb950"><i class="fas fa-check"></i> Formatted</span>';
          } catch (e) { mc.querySelector('#tm-json-msg').innerHTML = `<span style="color:#f85149"><i class="fas fa-times"></i> ${Utils.escapeHtml(e.message)}</span>`; }
        });
        mc.querySelector('#tm-json-minify').addEventListener('click', () => {
          try {
            const obj = JSON.parse(mc.querySelector('#tm-json-input').value);
            mc.querySelector('#tm-json-input').value = JSON.stringify(obj);
            mc.querySelector('#tm-json-msg').innerHTML = '<span style="color:#3fb950"><i class="fas fa-check"></i> Minified</span>';
          } catch (e) { mc.querySelector('#tm-json-msg').innerHTML = `<span style="color:#f85149"><i class="fas fa-times"></i> ${Utils.escapeHtml(e.message)}</span>`; }
        });
        mc.querySelector('#tm-json-validate').addEventListener('click', () => {
          try {
            JSON.parse(mc.querySelector('#tm-json-input').value);
            mc.querySelector('#tm-json-msg').innerHTML = '<span style="color:#3fb950"><i class="fas fa-check-circle"></i> Valid JSON</span>';
          } catch (e) { mc.querySelector('#tm-json-msg').innerHTML = `<span style="color:#f85149"><i class="fas fa-times-circle"></i> Invalid: ${Utils.escapeHtml(e.message)}</span>`; }
        });
        mc.querySelector('#tm-json-copy').addEventListener('click', () => {
          Utils.copyToClipboard(mc.querySelector('#tm-json-input').value); Toast.success('Copied!');
        });
        break;
      }
      case 'epoch': {
        mc.querySelector('#tm-epoch-now').addEventListener('click', () => {
          mc.querySelector('#tm-epoch-input').value = Math.floor(Date.now() / 1000);
        });
        mc.querySelector('#tm-epoch-to-date').addEventListener('click', () => {
          const epoch = parseInt(mc.querySelector('#tm-epoch-input').value);
          if (isNaN(epoch)) { Toast.warning('Enter an epoch timestamp'); return; }
          const ms = epoch > 1e12 ? epoch : epoch * 1000;
          const d = new Date(ms);
          mc.querySelector('#tm-epoch-date-result').innerHTML = `
            <table class="info-table" style="font-size:12px">
              <tr><td>UTC</td><td>${d.toUTCString()}</td></tr>
              <tr><td>Local</td><td>${d.toLocaleString()}</td></tr>
              <tr><td>ISO 8601</td><td>${d.toISOString()}</td></tr>
              <tr><td>Milliseconds</td><td>${ms}</td></tr>
            </table>`;
        });
        mc.querySelector('#tm-epoch-to-epoch').addEventListener('click', () => {
          const dateVal = mc.querySelector('#tm-epoch-date').value;
          if (!dateVal) { Toast.warning('Select a date'); return; }
          const d = new Date(dateVal);
          mc.querySelector('#tm-epoch-epoch-result').innerHTML = `
            <table class="info-table" style="font-size:12px">
              <tr><td>Epoch (seconds)</td><td><strong>${Math.floor(d.getTime() / 1000)}</strong></td></tr>
              <tr><td>Epoch (milliseconds)</td><td>${d.getTime()}</td></tr>
            </table>`;
        });
        break;
      }
      case 'storage-conv': {
        mc.querySelector('#tm-stor-calc').addEventListener('click', () => {
          const val = parseFloat(mc.querySelector('#tm-stor-val').value);
          const unit = mc.querySelector('#tm-stor-unit').value;
          if (isNaN(val) || val < 0) { Toast.warning('Enter a valid number'); return; }
          const decimalMap = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
          const bytes = val * (decimalMap[unit] || 1);
          const fmt = (v) => v % 1 === 0 ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
          mc.querySelector('#tm-stor-output').innerHTML = `
            <table class="info-table" style="font-size:12px">
              <tr><td colspan="2" style="font-weight:600;color:var(--text-muted)">Decimal (SI)</td></tr>
              <tr><td>Bytes</td><td>${fmt(bytes)}</td></tr>
              <tr><td>KB (10<sup>3</sup>)</td><td>${fmt(bytes / 1e3)}</td></tr>
              <tr><td>MB (10<sup>6</sup>)</td><td>${fmt(bytes / 1e6)}</td></tr>
              <tr><td>GB (10<sup>9</sup>)</td><td>${fmt(bytes / 1e9)}</td></tr>
              <tr><td>TB (10<sup>12</sup>)</td><td>${fmt(bytes / 1e12)}</td></tr>
              <tr><td colspan="2" style="font-weight:600;color:var(--text-muted);padding-top:12px">Binary (IEC)</td></tr>
              <tr><td>KiB (2<sup>10</sup>)</td><td>${fmt(bytes / 1024)}</td></tr>
              <tr><td>MiB (2<sup>20</sup>)</td><td>${fmt(bytes / (1024 ** 2))}</td></tr>
              <tr><td>GiB (2<sup>30</sup>)</td><td>${fmt(bytes / (1024 ** 3))}</td></tr>
              <tr><td>TiB (2<sup>40</sup>)</td><td>${fmt(bytes / (1024 ** 4))}</td></tr>
            </table>`;
        });
        break;
      }
      case 'regex': {
        mc.querySelector('#tm-regex-test').addEventListener('click', () => {
          const pattern = mc.querySelector('#tm-regex-pattern').value;
          const flags = mc.querySelector('#tm-regex-flags').value;
          const text = mc.querySelector('#tm-regex-input').value;
          if (!pattern) { Toast.warning('Enter a pattern'); return; }
          try {
            const re = new RegExp(pattern, flags);
            const matches = [];
            let m;
            if (flags.includes('g')) {
              while ((m = re.exec(text)) !== null) {
                matches.push({ index: m.index, length: m[0].length, value: m[0], groups: m.slice(1) });
                if (m[0].length === 0) re.lastIndex++;
              }
            } else {
              m = re.exec(text);
              if (m) matches.push({ index: m.index, length: m[0].length, value: m[0], groups: m.slice(1) });
            }
            // Build highlighted text
            let highlighted = '';
            let lastIdx = 0;
            matches.forEach(match => {
              highlighted += Utils.escapeHtml(text.substring(lastIdx, match.index));
              highlighted += `<span class="regex-match">${Utils.escapeHtml(match.value)}</span>`;
              lastIdx = match.index + match.length;
            });
            highlighted += Utils.escapeHtml(text.substring(lastIdx));
            let groupsHtml = '';
            if (matches.length > 0 && matches[0].groups.length > 0) {
              groupsHtml = '<div style="margin-top:8px;font-size:12px"><strong>Groups:</strong><br>' +
                matches.map((m, i) => m.groups.map((g, j) => `Match ${i + 1}, Group ${j + 1}: <code>${Utils.escapeHtml(g || '')}</code>`).join('<br>')).join('<br>') + '</div>';
            }
            mc.querySelector('#tm-regex-output').innerHTML = `
              <div style="font-size:12px;margin-bottom:8px;color:var(--text-muted)">${matches.length} match${matches.length !== 1 ? 'es' : ''} found</div>
              <div class="tool-output" style="white-space:pre-wrap">${highlighted || '<span class="text-muted">No matches</span>'}</div>
              ${groupsHtml}`;
          } catch (e) { mc.querySelector('#tm-regex-output').innerHTML = `<span style="color:#f85149"><i class="fas fa-times"></i> ${Utils.escapeHtml(e.message)}</span>`; }
        });
        break;
      }
      case 'text-diff': {
        mc.querySelector('#tm-diff-compare').addEventListener('click', () => {
          const a = mc.querySelector('#tm-diff-a').value.split('\n');
          const b = mc.querySelector('#tm-diff-b').value.split('\n');
          const maxLen = Math.max(a.length, b.length);
          let html = '<div class="diff-result" style="border:1px solid var(--border);border-radius:6px;overflow:auto;max-height:350px">';
          for (let i = 0; i < maxLen; i++) {
            const lineA = i < a.length ? a[i] : undefined;
            const lineB = i < b.length ? b[i] : undefined;
            if (lineA === lineB) {
              html += `<div class="diff-line diff-same">&nbsp; ${Utils.escapeHtml(lineA)}</div>`;
            } else {
              if (lineA !== undefined) html += `<div class="diff-line diff-del">- ${Utils.escapeHtml(lineA)}</div>`;
              if (lineB !== undefined) html += `<div class="diff-line diff-add">+ ${Utils.escapeHtml(lineB)}</div>`;
            }
          }
          html += '</div>';
          mc.querySelector('#tm-diff-output').innerHTML = html;
        });
        break;
      }
      case 'lorem': {
        const words = ['lorem','ipsum','dolor','sit','amet','consectetur','adipiscing','elit','sed','do','eiusmod','tempor','incididunt','ut','labore','et','dolore','magna','aliqua','enim','ad','minim','veniam','quis','nostrud','exercitation','ullamco','laboris','nisi','aliquip','ex','ea','commodo','consequat','duis','aute','irure','in','reprehenderit','voluptate','velit','esse','cillum','fugiat','nulla','pariatur','excepteur','sint','occaecat','cupidatat','non','proident','sunt','culpa','qui','officia','deserunt','mollit','anim','id','est','laborum','porta','nibh','venenatis','cras','pulvinar','mattis','nunc','pellentesque','habitant','morbi','tristique','senectus','netus','malesuada','fames','ac','turpis','egestas','maecenas','pharetra','convallis','posuere','orci','leo','faucibus','pretium','vulputate','sapien','nec','sagittis','feugiat','vivamus','at','augue'];
        const randWord = () => words[Math.floor(Math.random() * words.length)];
        const genSentence = () => {
          const len = 8 + Math.floor(Math.random() * 12);
          const s = Array.from({ length: len }, randWord).join(' ');
          return s.charAt(0).toUpperCase() + s.slice(1) + '.';
        };
        const genParagraph = () => Array.from({ length: 4 + Math.floor(Math.random() * 4) }, genSentence).join(' ');
        mc.querySelector('#tm-lorem-gen').addEventListener('click', () => {
          const type = mc.querySelector('#tm-lorem-type').value;
          const count = parseInt(mc.querySelector('#tm-lorem-count').value) || 1;
          let result;
          if (type === 'paragraphs') result = Array.from({ length: count }, genParagraph).join('\n\n');
          else if (type === 'sentences') result = Array.from({ length: count }, genSentence).join(' ');
          else result = Array.from({ length: count }, randWord).join(' ');
          mc.querySelector('#tm-lorem-output').textContent = result;
        });
        mc.querySelector('#tm-lorem-copy').addEventListener('click', () => {
          const text = mc.querySelector('#tm-lorem-output').textContent;
          if (text) { Utils.copyToClipboard(text); Toast.success('Copied!'); }
        });
        mc.querySelector('#tm-lorem-gen').click(); // auto-generate
        break;
      }
      case 'http-codes': {
        const codes = [
          [200, 'OK', 'The request succeeded'],
          [201, 'Created', 'The request succeeded and a new resource was created'],
          [204, 'No Content', 'The request succeeded with no response body'],
          [301, 'Moved Permanently', 'The resource has been permanently moved to a new URL'],
          [302, 'Found', 'The resource resides temporarily at a different URL'],
          [304, 'Not Modified', 'The resource has not been modified since the last request'],
          [400, 'Bad Request', 'The server cannot process the request due to client error'],
          [401, 'Unauthorized', 'Authentication is required and has failed or not been provided'],
          [403, 'Forbidden', 'The server understood the request but refuses to authorize it'],
          [404, 'Not Found', 'The requested resource could not be found'],
          [405, 'Method Not Allowed', 'The HTTP method is not supported for the requested resource'],
          [408, 'Request Timeout', 'The server timed out waiting for the request'],
          [409, 'Conflict', 'The request conflicts with the current state of the resource'],
          [429, 'Too Many Requests', 'The user has sent too many requests in a given time (rate limiting)'],
          [500, 'Internal Server Error', 'The server encountered an unexpected condition'],
          [502, 'Bad Gateway', 'The server received an invalid response from an upstream server'],
          [503, 'Service Unavailable', 'The server is temporarily unable to handle the request'],
          [504, 'Gateway Timeout', 'The upstream server failed to respond in time'],
        ];
        const renderTable = (filter) => {
          const f = (filter || '').toLowerCase();
          const filtered = codes.filter(([code, name, desc]) => !f || String(code).includes(f) || name.toLowerCase().includes(f) || desc.toLowerCase().includes(f));
          const tbody = mc.querySelector('#tm-http-table tbody');
          tbody.innerHTML = filtered.map(([code, name, desc]) => {
            const cls = code < 300 ? 'http-2xx' : code < 400 ? 'http-3xx' : code < 500 ? 'http-4xx' : 'http-5xx';
            return `<tr><td><strong class="${cls}">${code}</strong></td><td>${name}</td><td class="text-muted">${desc}</td></tr>`;
          }).join('');
        };
        renderTable('');
        mc.querySelector('#tm-http-search').addEventListener('input', (e) => renderTable(e.target.value));
        break;
      }
      case 'port-ref': {
        const ports = [
          [20, 'TCP', 'FTP Data', 'File Transfer Protocol data transfer'],
          [21, 'TCP', 'FTP Control', 'File Transfer Protocol command control'],
          [22, 'TCP', 'SSH/SFTP', 'Secure Shell remote login, SFTP file transfer'],
          [23, 'TCP', 'Telnet', 'Unencrypted text communications (legacy)'],
          [25, 'TCP', 'SMTP', 'Simple Mail Transfer Protocol for email routing'],
          [53, 'TCP/UDP', 'DNS', 'Domain Name System name resolution'],
          [67, 'UDP', 'DHCP Server', 'Dynamic Host Configuration Protocol server'],
          [68, 'UDP', 'DHCP Client', 'Dynamic Host Configuration Protocol client'],
          [69, 'UDP', 'TFTP', 'Trivial File Transfer Protocol'],
          [80, 'TCP', 'HTTP', 'Hypertext Transfer Protocol for web traffic'],
          [110, 'TCP', 'POP3', 'Post Office Protocol v3 for email retrieval'],
          [123, 'UDP', 'NTP', 'Network Time Protocol for clock synchronization'],
          [137, 'UDP', 'NetBIOS NS', 'NetBIOS Name Service (Windows networking)'],
          [143, 'TCP', 'IMAP', 'Internet Message Access Protocol for email'],
          [161, 'UDP', 'SNMP', 'Simple Network Management Protocol'],
          [162, 'UDP', 'SNMP Trap', 'SNMP Trap notifications'],
          [389, 'TCP', 'LDAP', 'Lightweight Directory Access Protocol'],
          [443, 'TCP', 'HTTPS', 'HTTP Secure (TLS/SSL encrypted web traffic)'],
          [445, 'TCP', 'SMB', 'Server Message Block (Windows file sharing)'],
          [465, 'TCP', 'SMTPS', 'SMTP over SSL for secure email submission'],
          [514, 'UDP', 'Syslog', 'System logging protocol'],
          [587, 'TCP', 'SMTP Submission', 'Email message submission with STARTTLS'],
          [636, 'TCP', 'LDAPS', 'LDAP over SSL/TLS'],
          [873, 'TCP', 'Rsync', 'Remote file synchronization'],
          [993, 'TCP', 'IMAPS', 'IMAP over SSL for secure email access'],
          [995, 'TCP', 'POP3S', 'POP3 over SSL for secure email retrieval'],
          [1080, 'TCP', 'SOCKS', 'SOCKS proxy protocol'],
          [1433, 'TCP', 'MSSQL', 'Microsoft SQL Server database'],
          [1521, 'TCP', 'Oracle DB', 'Oracle Database listener'],
          [1883, 'TCP', 'MQTT', 'Message Queuing Telemetry Transport (IoT)'],
          [2049, 'TCP/UDP', 'NFS', 'Network File System'],
          [2375, 'TCP', 'Docker', 'Docker daemon API (unencrypted)'],
          [2376, 'TCP', 'Docker TLS', 'Docker daemon API (TLS encrypted)'],
          [3000, 'TCP', 'Grafana/Dev', 'Grafana, Node.js dev servers, Gitea'],
          [3306, 'TCP', 'MySQL', 'MySQL / MariaDB database server'],
          [3389, 'TCP', 'RDP', 'Remote Desktop Protocol (Windows)'],
          [4222, 'TCP', 'NATS', 'NATS messaging system'],
          [5000, 'TCP', 'Docker Registry', 'Docker container registry, Flask dev'],
          [5432, 'TCP', 'PostgreSQL', 'PostgreSQL database server'],
          [5672, 'TCP', 'AMQP', 'RabbitMQ / Advanced Message Queuing Protocol'],
          [5900, 'TCP', 'VNC', 'Virtual Network Computing remote desktop'],
          [6379, 'TCP', 'Redis', 'Redis in-memory data structure store'],
          [6443, 'TCP', 'Kubernetes API', 'Kubernetes API server (HTTPS)'],
          [8080, 'TCP', 'HTTP Alt', 'Alternative HTTP (proxies, Tomcat, Jenkins)'],
          [8443, 'TCP', 'HTTPS Alt', 'Alternative HTTPS port'],
          [8883, 'TCP', 'MQTT TLS', 'MQTT over TLS/SSL'],
          [9000, 'TCP', 'Portainer', 'Portainer, SonarQube, PHP-FPM'],
          [9090, 'TCP', 'Prometheus', 'Prometheus monitoring server'],
          [9200, 'TCP', 'Elasticsearch', 'Elasticsearch REST API'],
          [9300, 'TCP', 'ES Transport', 'Elasticsearch node-to-node communication'],
          [9418, 'TCP', 'Git', 'Git protocol (unencrypted)'],
          [10250, 'TCP', 'Kubelet', 'Kubernetes Kubelet API'],
          [11211, 'TCP/UDP', 'Memcached', 'Memcached distributed cache'],
          [15672, 'TCP', 'RabbitMQ Mgmt', 'RabbitMQ management console'],
          [27017, 'TCP', 'MongoDB', 'MongoDB NoSQL database server'],
          [50000, 'TCP', 'Jenkins Agent', 'Jenkins JNLP agent communication'],
          [51820, 'UDP', 'WireGuard', 'WireGuard VPN tunnel'],
        ];
        const renderTable = (filter) => {
          const f = (filter || '').toLowerCase();
          const filtered = ports.filter(([port, proto, svc, desc]) => !f || String(port).includes(f) || proto.toLowerCase().includes(f) || svc.toLowerCase().includes(f) || desc.toLowerCase().includes(f));
          const tbody = mc.querySelector('#tm-port-table tbody');
          tbody.innerHTML = filtered.map(([port, proto, svc, desc]) =>
            `<tr><td><strong>${port}</strong></td><td>${proto}</td><td>${svc}</td><td class="text-muted">${desc}</td></tr>`
          ).join('');
        };
        renderTable('');
        mc.querySelector('#tm-port-search').addEventListener('input', (e) => renderTable(e.target.value));
        break;
      }
      case 'html2md': {
        const convert = () => {
          const html = mc.querySelector('#tm-h2m-input').value;
          // Simple HTML to Markdown conversion
          let md = html
            .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
            .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
            .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
            .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
            .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
            .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
            .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
            .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
            .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
            .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
            .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n')
            .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n\n')
            .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
            .replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)')
            .replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, '![]($1)')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<hr\s*\/?>/gi, '\n---\n\n')
            .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
            .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
            .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, c) => c.trim().split('\n').map(l => '> ' + l.trim()).join('\n') + '\n\n')
            .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
            .replace(/<\/?(div|span|section|article|header|footer|main|nav)[^>]*>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, '\n\n').trim();
          mc.querySelector('#tm-h2m-output').value = md;
          mc.querySelector('#tm-h2m-preview').textContent = md;
        };
        mc.querySelector('#tm-h2m-convert').addEventListener('click', convert);
        mc.querySelector('#tm-h2m-copy').addEventListener('click', () => {
          Utils.copyToClipboard(mc.querySelector('#tm-h2m-output').value); Toast.success('Copied!');
        });
        mc.querySelector('#tm-h2m-input').addEventListener('input', () => {
          if (mc.querySelector('#tm-h2m-live').checked) convert();
        });
        break;
      }
      case 'md2html': {
        const convert = () => {
          const md = mc.querySelector('#tm-m2h-input').value;
          // Simple Markdown to HTML conversion
          let html = md
            .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
            .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
            .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
            .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
            .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
            .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
            .replace(/^---$/gm, '<hr>')
            .replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>')
            .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
            .replace(/^(?!<[hupblo]|<hr|<li|<blockquote|<pre)(.+)$/gm, '<p>$1</p>')
            .replace(/\n{2,}/g, '\n').trim();
          mc.querySelector('#tm-m2h-output').value = html;
          mc.querySelector('#tm-m2h-preview').innerHTML = html;
        };
        mc.querySelector('#tm-m2h-convert').addEventListener('click', convert);
        mc.querySelector('#tm-m2h-copy').addEventListener('click', () => {
          Utils.copyToClipboard(mc.querySelector('#tm-m2h-output').value); Toast.success('Copied!');
        });
        mc.querySelector('#tm-m2h-input').addEventListener('input', () => {
          if (mc.querySelector('#tm-m2h-live').checked) convert();
        });
        break;
      }
    }
  },

  _dockerRunToCompose(cmd) {
    // Parse docker run command into compose YAML
    const args = this._parseDockerArgs(cmd);
    const svc = { image: args.image || 'unknown' };

    if (args.name) svc.container_name = args.name;
    if (args.ports.length) svc.ports = args.ports;
    if (args.volumes.length) svc.volumes = args.volumes;
    if (Object.keys(args.env).length) svc.environment = args.env;
    if (args.restart) svc.restart = args.restart;
    if (args.network) svc.networks = [args.network];
    if (args.hostname) svc.hostname = args.hostname;
    if (args.workdir) svc.working_dir = args.workdir;
    if (args.entrypoint) svc.entrypoint = args.entrypoint;
    if (args.command) svc.command = args.command;
    if (args.labels.length) {
      svc.labels = {};
      args.labels.forEach(l => { const [k, ...v] = l.split('='); svc.labels[k] = v.join('='); });
    }

    const name = (args.name || 'app').replace(/[^a-z0-9-]/g, '-');
    let yaml = `services:\n  ${name}:\n`;
    for (const [key, val] of Object.entries(svc)) {
      if (typeof val === 'string') {
        yaml += `    ${key}: ${val}\n`;
      } else if (Array.isArray(val)) {
        yaml += `    ${key}:\n`;
        val.forEach(v => { yaml += `      - "${v}"\n`; });
      } else if (typeof val === 'object') {
        yaml += `    ${key}:\n`;
        for (const [k, v] of Object.entries(val)) {
          yaml += `      ${k}: "${v}"\n`;
        }
      }
    }
    return yaml;
  },

  _parseDockerArgs(cmd) {
    // Tokenize respecting quotes
    const tokens = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of cmd) {
      if (inQuote) {
        if (ch === quoteChar) { inQuote = false; } else { current += ch; }
      } else if (ch === '"' || ch === "'") {
        inQuote = true; quoteChar = ch;
      } else if (ch === ' ' || ch === '\t') {
        if (current) { tokens.push(current); current = ''; }
      } else { current += ch; }
    }
    if (current) tokens.push(current);

    // Skip "docker run" prefix
    let i = 0;
    while (i < tokens.length && (tokens[i] === 'docker' || tokens[i] === 'run')) i++;

    const result = { ports: [], volumes: [], env: {}, labels: [], name: '', image: '', restart: '', network: '', hostname: '', workdir: '', entrypoint: '', command: '' };
    let imageFound = false;

    while (i < tokens.length) {
      const t = tokens[i];
      if (imageFound) {
        result.command = tokens.slice(i).join(' ');
        break;
      }
      if (t === '-d' || t === '--detach') { i++; continue; }
      if (t === '-it' || t === '-i' || t === '-t') { i++; continue; }
      if (t === '--rm') { i++; continue; }
      if (t === '-p' || t === '--publish') { result.ports.push(tokens[++i]); i++; continue; }
      if (t === '-v' || t === '--volume') { result.volumes.push(tokens[++i]); i++; continue; }
      if (t === '-e' || t === '--env') { const kv = tokens[++i]; const eq = kv.indexOf('='); if (eq > 0) result.env[kv.substring(0, eq)] = kv.substring(eq + 1); i++; continue; }
      if (t === '-l' || t === '--label') { result.labels.push(tokens[++i]); i++; continue; }
      if (t === '--name') { result.name = tokens[++i]; i++; continue; }
      if (t === '--restart') { result.restart = tokens[++i]; i++; continue; }
      if (t === '--network' || t === '--net') { result.network = tokens[++i]; i++; continue; }
      if (t === '-h' || t === '--hostname') { result.hostname = tokens[++i]; i++; continue; }
      if (t === '-w' || t === '--workdir') { result.workdir = tokens[++i]; i++; continue; }
      if (t === '--entrypoint') { result.entrypoint = tokens[++i]; i++; continue; }
      if (t.startsWith('-')) { if (t.includes('=')) { i++; } else { i += 2; } continue; } // skip unknown flags
      result.image = t;
      imageFound = true;
      i++;
    }
    return result;
  },

  _generateProxyLabels(type, domain, port, tls) {
    if (type === 'traefik') {
      const router = domain.replace(/[^a-z0-9]/g, '-');
      let labels = `labels:\n`;
      labels += `  - "traefik.enable=true"\n`;
      labels += `  - "traefik.http.routers.${router}.rule=Host(\\\`${domain}\\\`)"\n`;
      if (tls) {
        labels += `  - "traefik.http.routers.${router}.entrypoints=websecure"\n`;
        labels += `  - "traefik.http.routers.${router}.tls.certresolver=letsencrypt"\n`;
      } else {
        labels += `  - "traefik.http.routers.${router}.entrypoints=web"\n`;
      }
      labels += `  - "traefik.http.services.${router}.loadbalancer.server.port=${port}"\n`;
      return labels;
    } else {
      // Caddy labels (via caddy-docker-proxy)
      let labels = `labels:\n`;
      labels += `  caddy: "${domain}"\n`;
      labels += `  caddy.reverse_proxy: "{{upstreams ${port}}}"\n`;
      if (tls) {
        labels += `  caddy.tls: "internal"  # or remove for Let's Encrypt auto\n`;
      }
      return labels;
    }
  },

  // ─── Templates Tab ────────────────────────────────
  async _renderTemplates(el) {
    el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading templates...</div>`;
    try {
      const data = await Api.getTemplates();
      const templates = data.templates || [];
      const categories = data.categories || [];

      const renderCard = (t) => {
        const modifiedBadge = t.isModified
          ? `<span class="badge badge-warning" style="font-size:9px;margin-left:6px" title="Modified by ${Utils.escapeHtml(t.updatedBy || '?')} on ${Utils.escapeHtml(t.updatedAt || '?')}"><i class="fas fa-pen" style="margin-right:3px"></i>modified</span>`
          : '';
        const customBadge = t.isCustom
          ? `<span class="badge badge-info" style="font-size:9px;margin-left:6px"><i class="fas fa-user" style="margin-right:3px"></i>custom</span>`
          : '';
        // Logo: show image with graceful fallback to FontAwesome icon
        const logoHtml = t.logoUrl
          ? `<img src="${Utils.escapeHtml(t.logoUrl)}" alt="${Utils.escapeHtml(t.name)}" style="width:28px;height:28px;object-fit:contain;flex-shrink:0" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
          + `<i class="${t.icon || 'fas fa-cube'}" style="display:none;font-size:18px;color:var(--accent)"></i>`
          : `<i class="${t.icon || 'fas fa-cube'}" style="font-size:18px;color:var(--accent)"></i>`;
        return `
          <div class="card tpl-card" data-id="${t.id}" data-cat="${Utils.escapeHtml((t.category || '').toLowerCase())}" data-name="${Utils.escapeHtml((t.name || '').toLowerCase())} ${Utils.escapeHtml((t.description || '').toLowerCase())}">
            <div class="card-header" style="gap:10px">
              <div style="display:flex;align-items:center;gap:8px;min-width:0">
                ${logoHtml}
                <h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(t.name)}${modifiedBadge}${customBadge}</h3>
              </div>
              <span class="badge badge-info" style="font-size:10px;flex-shrink:0">${Utils.escapeHtml(t.category)}</span>
            </div>
            <div class="card-body">
              <p class="text-sm text-muted" style="margin-bottom:12px">${Utils.escapeHtml(t.description)}</p>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-sm btn-primary tpl-deploy" data-id="${t.id}"><i class="fas fa-rocket"></i> Deploy</button>
                <button class="btn btn-sm btn-secondary tpl-view" data-id="${t.id}" title="View YAML"><i class="fas fa-eye"></i> View</button>
                <button class="btn btn-sm btn-secondary tpl-configure" data-id="${t.id}" title="Configure & Deploy"><i class="fas fa-sliders-h"></i> Configure</button>
                <button class="btn btn-sm btn-secondary tpl-edit" data-id="${t.id}" title="Edit template"><i class="fas fa-edit"></i> Edit</button>
                ${t.isModified ? `<button class="btn btn-sm btn-secondary tpl-reset" data-id="${t.id}" title="Reset to built-in default"><i class="fas fa-undo"></i></button>` : ''}
                ${t.isCustom ? `<button class="btn btn-sm btn-danger tpl-delete" data-id="${t.id}" title="Delete custom template"><i class="fas fa-trash"></i></button>` : ''}
              </div>
            </div>
          </div>`;
      };

      el.innerHTML = `
        <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
          <div class="search-box" style="flex:1;min-width:200px">
            <i class="fas fa-search"></i>
            <input type="text" id="tpl-search" placeholder="Search templates...">
          </div>
          <select id="tpl-category" class="form-control" style="width:auto;min-width:150px">
            <option value="">All categories</option>
            ${categories.map(c => `<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-primary" id="tpl-add"><i class="fas fa-plus"></i> Add Template</button>
          <button class="btn btn-sm btn-secondary" id="tpl-import-portainer"><i class="fas fa-file-import"></i> Import from Portainer</button>
        </div>
        <div class="info-grid" id="tpl-grid" style="margin-top:0">
          ${templates.map(renderCard).join('')}
        </div>
      `;

      // Search + filter
      const filterFn = () => {
        const q = el.querySelector('#tpl-search')?.value?.toLowerCase() || '';
        const cat = el.querySelector('#tpl-category')?.value?.toLowerCase() || '';
        el.querySelectorAll('.tpl-card').forEach(card => {
          const matchName = card.dataset.name.includes(q);
          const matchCat = !cat || card.dataset.cat === cat;
          card.style.display = matchName && matchCat ? '' : 'none';
        });
      };
      el.querySelector('#tpl-search')?.addEventListener('input', Utils.debounce(filterFn, 200));
      el.querySelector('#tpl-category')?.addEventListener('change', filterFn);

      // Add new template
      el.querySelector('#tpl-add').addEventListener('click', () => this._templateFormDialog(null, el));

      // Import from Portainer
      el.querySelector('#tpl-import-portainer').addEventListener('click', () => this._portainerImportDialog(el));

      // Delegated click handler
      el.addEventListener('click', async (e) => {
        const id = e.target.closest('[data-id]')?.dataset?.id;
        if (!id) return;
        const t = templates.find(t => t.id === id);

        // View — read-only YAML
        if (e.target.closest('.tpl-view') && t) {
          Modal.open(`
            <div class="modal-header">
              <h3><i class="${t.icon}" style="margin-right:8px;color:var(--accent)"></i>${Utils.escapeHtml(t.name)}</h3>
              <button class="modal-close-btn" id="tpl-v-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
              <pre class="inspect-json" style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px">${Utils.escapeHtml(t.compose)}</pre>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" id="tpl-v-copy"><i class="fas fa-copy"></i> Copy</button>
              <button class="btn btn-primary" id="tpl-v-ok">Close</button>
            </div>
          `, { width: '600px' });
          Modal._content.querySelector('#tpl-v-close').addEventListener('click', () => Modal.close());
          Modal._content.querySelector('#tpl-v-ok').addEventListener('click', () => Modal.close());
          Modal._content.querySelector('#tpl-v-copy').addEventListener('click', () => {
            Utils.copyToClipboard(t.compose).then(() => Toast.success('Copied!'));
          });
        }

        // Configure — dynamic configurator with deploy
        if (e.target.closest('.tpl-configure') && t) {
          TemplateConfigurator.open(t, {
            mode: 'deploy',
            onDeploy: async ({ name, compose }) => {
              try {
                Toast.info('Deploying ' + t.name + '...');
                await Api.post(`/templates/${id}/deploy`, { name, compose });
                Toast.success(t.name + ' deployed!');
              } catch (err) { Toast.error(err.message); }
            },
          });
        }

        // Edit — edit template definition (name, icon, YAML)
        if (e.target.closest('.tpl-edit') && t) {
          this._templateFormDialog(t, el);
        }

        if (e.target.closest('.tpl-reset') && t) {
          const ok = await Modal.confirm(`Reset "${t.name}" to its original built-in configuration?`);
          if (!ok) return;
          try {
            await Api.post(`/templates/${id}/reset`);
            Toast.success('Template reset to default');
            this._renderTemplates(el);
          } catch (err) { Toast.error(err.message); }
        }

        if (e.target.closest('.tpl-delete') && t) {
          const ok = await Modal.confirm(`Delete custom template "${t.name}"?`, { danger: true });
          if (!ok) return;
          try {
            await Api.delete(`/templates/${id}`);
            Toast.success('Template deleted');
            this._renderTemplates(el);
          } catch (err) { Toast.error(err.message); }
        }

        // Deploy — direct with defaults
        if (e.target.closest('.tpl-deploy') && t) {
          const result = await Modal.form(`
            <div class="form-group">
              <label>Stack Name *</label>
              <input type="text" id="tpl-name" class="form-control" value="${t.id}" placeholder="my-${t.id}">
              <small class="text-muted">Letters, numbers, dashes and underscores only</small>
            </div>
          `, {
            title: 'Deploy ' + t.name,
            width: '400px',
            onSubmit: (content) => {
              const name = content.querySelector('#tpl-name').value.trim();
              if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) { Toast.error('Invalid stack name'); return false; }
              return { name };
            },
          });
          if (result) {
            try {
              Toast.info('Deploying ' + t.name + '...');
              await Api.post(`/templates/${id}/deploy`, result);
              Toast.success(t.name + ' deployed!');
            } catch (err) { Toast.error(err.message); }
          }
        }
      });
    } catch (err) {
      el.innerHTML = '<div class="empty-msg">Error: ' + err.message + '</div>';
    }
  },

  async _templateFormDialog(template, parentEl) {
    const isEdit = !!template;
    const isBuiltin = template?.isBuiltin;
    const title = isEdit ? `Edit: ${template.name}` : 'Add Custom Template';

    const result = await Modal.form(`
      <div class="form-group">
        <label>Template ID *</label>
        <input type="text" id="tf-id" class="form-control" value="${isEdit ? Utils.escapeHtml(template.id) : ''}" ${isEdit ? 'readonly style="opacity:0.6"' : ''} placeholder="my-template">
        ${!isEdit ? '<small class="text-muted">Unique identifier (letters, numbers, dashes, underscores)</small>' : ''}
      </div>
      <div class="form-group">
        <label>Name *</label>
        <input type="text" id="tf-name" class="form-control" value="${isEdit ? Utils.escapeHtml(template.name) : ''}" placeholder="My Template">
      </div>
      <div class="form-group">
        <label>Category</label>
        <input type="text" id="tf-category" class="form-control" value="${isEdit ? Utils.escapeHtml(template.category) : 'Custom'}" placeholder="Database, Web Server, Tool...">
      </div>
      <div class="form-group">
        <label>Icon (FontAwesome class)</label>
        <input type="text" id="tf-icon" class="form-control" value="${isEdit ? Utils.escapeHtml(template.icon) : 'fas fa-cube'}" placeholder="fas fa-cube">
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="tf-desc" class="form-control" value="${isEdit ? Utils.escapeHtml(template.description) : ''}" placeholder="What this template does">
      </div>
      <div class="form-group">
        <label>Compose YAML *</label>
        <textarea id="tf-compose" class="form-control" rows="12" style="font-family:var(--mono);font-size:12px">${isEdit ? Utils.escapeHtml(template.compose) : 'services:\n  my-app:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: unless-stopped'}</textarea>
      </div>
    `, {
      title,
      width: '650px',
      onSubmit: (content) => {
        const id = content.querySelector('#tf-id').value.trim();
        const name = content.querySelector('#tf-name').value.trim();
        const compose = content.querySelector('#tf-compose').value.trim();
        if (!id || !name || !compose) { Toast.error('ID, Name, and Compose YAML are required'); return false; }
        if (!isEdit && !/^[a-zA-Z0-9_-]+$/.test(id)) { Toast.error('ID must be alphanumeric with dashes/underscores'); return false; }
        return {
          id, name, compose,
          category: content.querySelector('#tf-category').value.trim() || 'Custom',
          icon: content.querySelector('#tf-icon').value.trim() || 'fas fa-cube',
          description: content.querySelector('#tf-desc').value.trim(),
        };
      },
    });

    if (!result) return;

    try {
      if (isEdit) {
        await Api.put(`/templates/${result.id}`, result);
        Toast.success('Template updated');
      } else {
        await Api.post('/templates', result);
        Toast.success('Template created');
      }
      this._renderTemplates(parentEl);
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _portainerImportDialog(parentEl) {
    const defaultUrl = 'https://raw.githubusercontent.com/portainer/templates/master/templates-2.0.json';

    // Step 1: Ask for URL
    const urlResult = await Modal.form(`
      <div class="form-group">
        <label>Portainer Templates URL</label>
        <input type="url" id="pi-url" class="form-control" value="${defaultUrl}" placeholder="https://...">
        <small class="text-muted">The official Portainer templates URL is pre-filled. You can also use custom template repositories.</small>
      </div>
    `, { title: 'Import from Portainer', width: '600px', submitText: 'Fetch Templates',
      onSubmit: (content) => {
        const url = content.querySelector('#pi-url').value.trim();
        if (!url) { Toast.error('URL is required'); return false; }
        return { url };
      },
    });
    if (!urlResult) return;

    // Step 2: Fetch and preview
    Toast.info('Fetching templates...');
    let preview;
    try {
      preview = await Api.previewPortainerImport(urlResult.url);
    } catch (err) {
      Toast.error('Failed to fetch: ' + err.message);
      return;
    }

    if (!preview.templates || preview.templates.length === 0) {
      Toast.warning('No templates found at that URL');
      return;
    }

    // Step 3: Show checkboxes for selection
    const tpls = preview.templates;
    const selectResult = await Modal.form(`
      <div style="margin-bottom:12px">
        <strong>${tpls.length} templates found.</strong> Select which to import:
        <div style="margin-top:8px;display:flex;gap:8px">
          <button class="btn btn-xs btn-secondary" id="pi-select-all">Select All</button>
          <button class="btn btn-xs btn-secondary" id="pi-select-none">Select None</button>
        </div>
      </div>
      <div style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        ${tpls.map((t, i) => `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px">
            <input type="checkbox" class="pi-check" data-idx="${i}" ${t.alreadyExists ? '' : 'checked'}>
            <div>
              <strong>${Utils.escapeHtml(t.name)}</strong>
              <span class="badge badge-info" style="font-size:9px;margin-left:6px">${Utils.escapeHtml(t.category)}</span>
              ${t.alreadyExists ? '<span class="badge badge-warning" style="font-size:9px;margin-left:4px">exists</span>' : ''}
              <div class="text-sm text-muted" style="margin-top:2px">${Utils.escapeHtml((t.description || '').substring(0, 100))}</div>
            </div>
          </label>
        `).join('')}
      </div>
    `, {
      title: `Import Templates (${tpls.length} found)`,
      width: '650px',
      submitText: 'Import Selected',
      onMount: (content) => {
        content.querySelector('#pi-select-all').addEventListener('click', () => {
          content.querySelectorAll('.pi-check').forEach(cb => cb.checked = true);
        });
        content.querySelector('#pi-select-none').addEventListener('click', () => {
          content.querySelectorAll('.pi-check').forEach(cb => cb.checked = false);
        });
      },
      onSubmit: (content) => {
        const selected = [];
        content.querySelectorAll('.pi-check:checked').forEach(cb => {
          selected.push(tpls[parseInt(cb.dataset.idx)]);
        });
        if (selected.length === 0) { Toast.warning('No templates selected'); return false; }
        return { selected };
      },
    });
    if (!selectResult) return;

    // Step 4: Import
    try {
      const result = await Api.importPortainerTemplates(selectResult.selected);
      Toast.success(`Imported ${result.imported} templates` + (result.skipped ? `, ${result.skipped} skipped (duplicates)` : ''));
      this._renderTemplates(parentEl);
    } catch (err) {
      Toast.error('Import failed: ' + err.message);
    }
  },

  _renderPrune(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>${i18n.t('pages.system.systemPrune')}</h3>
          <button class="prune-help-btn" id="prune-help" title="${i18n.t('pages.system.pruneHelpTooltip')}">?</button>
        </div>
        <div class="card-body">
          <p class="text-muted mb-md">${i18n.t('pages.system.pruneDesc')}</p>
          <div class="prune-grid">
            <div class="prune-item">
              <h4><i class="fas fa-cube"></i> ${i18n.t('pages.system.pruneContainers')}</h4>
              <p>${i18n.t('pages.system.pruneContainersDesc')}</p>
              <button class="btn btn-sm btn-warning" data-prune="containers">${i18n.t('pages.system.pruneContainersBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-layer-group"></i> ${i18n.t('pages.system.pruneImages')}</h4>
              <p>${i18n.t('pages.system.pruneImagesDesc')}</p>
              <button class="btn btn-sm btn-warning" data-prune="images">${i18n.t('pages.system.pruneImagesBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-database"></i> ${i18n.t('pages.system.pruneVolumes')}</h4>
              <p>${i18n.t('pages.system.pruneVolumesDesc')}</p>
              <button class="btn btn-sm btn-danger" data-prune="volumes">${i18n.t('pages.system.pruneVolumesBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-network-wired"></i> ${i18n.t('pages.system.pruneNetworks')}</h4>
              <p>${i18n.t('pages.system.pruneNetworksDesc')}</p>
              <button class="btn btn-sm btn-warning" data-prune="networks">${i18n.t('pages.system.pruneNetworksBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-broom"></i> ${i18n.t('pages.system.pruneEverything')}</h4>
              <p>${i18n.t('pages.system.pruneEverythingDesc')}</p>
              <button class="btn btn-sm btn-danger" data-prune="all">${i18n.t('pages.system.pruneAllBtn')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    el.querySelector('#prune-help').addEventListener('click', () => this._showPruneHelp());

    // Wire up prune buttons
    el.querySelectorAll('[data-prune]').forEach(btn => {
      btn.addEventListener('click', () => SystemPage._prune(btn.dataset.prune));
    });
  },

  _showPruneHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.system.pruneHelp.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.system.pruneHelp.intro')}</p>

        <h4><i class="fas fa-cube"></i> ${i18n.t('pages.system.pruneHelp.containersTitle')}</h4>
        <p>${i18n.t('pages.system.pruneHelp.containersBody')}</p>
        <p class="warn-text"><i class="fas fa-exclamation-triangle"></i> ${i18n.t('pages.system.pruneHelp.containersWarning')}</p>

        <h4><i class="fas fa-layer-group"></i> ${i18n.t('pages.system.pruneHelp.imagesTitle')}</h4>
        <p>${i18n.t('pages.system.pruneHelp.imagesBody')}</p>
        <p class="warn-text"><i class="fas fa-exclamation-triangle"></i> ${i18n.t('pages.system.pruneHelp.imagesWarning')}</p>

        <h4><i class="fas fa-database"></i> ${i18n.t('pages.system.pruneHelp.volumesTitle')}</h4>
        <p>${i18n.t('pages.system.pruneHelp.volumesBody')}</p>
        <p class="danger-text"><i class="fas fa-exclamation-circle"></i> ${i18n.t('pages.system.pruneHelp.volumesWarning')}</p>

        <h4><i class="fas fa-network-wired"></i> ${i18n.t('pages.system.pruneHelp.networksTitle')}</h4>
        <p>${i18n.t('pages.system.pruneHelp.networksBody')}</p>
        <p>${i18n.t('pages.system.pruneHelp.networksSafe')}</p>

        <h4><i class="fas fa-broom"></i> ${i18n.t('pages.system.pruneHelp.allTitle')}</h4>
        <p>${i18n.t('pages.system.pruneHelp.allBody')}</p>
        <p class="danger-text"><i class="fas fa-exclamation-circle"></i> ${i18n.t('pages.system.pruneHelp.allWarning')}</p>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.system.pruneHelp.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '620px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  async _prune(type) {
    const msg = type === 'all'
      ? i18n.t('pages.system.pruneAllConfirm')
      : i18n.t('pages.system.pruneConfirm', { type });
    const ok = await Modal.confirm(
      msg,
      { danger: true, confirmText: i18n.t('common.prune') }
    );
    if (!ok) return;
    try {
      const result = await Api.prune(type);
      const freed = result.SpaceReclaimed || result.space_reclaimed || 0;
      Toast.success(freed
        ? i18n.t('pages.system.pruneSuccess', { freed: Utils.formatBytes(freed) })
        : i18n.t('pages.system.pruneDone')
      );
    } catch (err) { Toast.error(err.message); }
  },

  async _renderAudit(el) {
    try {
      const data = await Api.getAuditLog(1, 100);
      const entries = data.rows || data.entries || data.logs || (Array.isArray(data) ? data : []);

      if (entries.length === 0) {
        el.innerHTML = `<div class="empty-msg">${i18n.t('pages.system.noAuditEntries')}</div>`;
        return;
      }

      el.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;gap:8px">
        <button class="btn btn-sm btn-secondary" id="audit-export-csv"><i class="fas fa-download"></i> Export CSV</button>
        <button class="btn btn-sm btn-secondary" id="audit-analytics-btn"><i class="fas fa-chart-bar"></i> Analytics</button>
      </div>
      <table class="data-table">
        <thead><tr><th>${i18n.t('pages.system.eventTime')}</th><th>${i18n.t('pages.system.auditUser')}</th><th>${i18n.t('pages.system.auditAction')}</th><th>${i18n.t('pages.system.auditTarget')}</th><th>${i18n.t('pages.system.auditIp')}</th></tr></thead>
        <tbody>${entries.map(e => `
          <tr>
            <td>${Utils.formatDate(e.created_at || e.timestamp)}</td>
            <td>${Utils.escapeHtml(e.username || '')}</td>
            <td><span class="badge badge-info">${Utils.escapeHtml(e.action)}</span></td>
            <td class="mono text-sm">${Utils.escapeHtml(e.target_type ? e.target_type + ':' + Utils.shortId(e.target_id) : '')}</td>
            <td class="mono text-sm">${Utils.escapeHtml(e.ip || '')}</td>
          </tr>
        `).join('')}</tbody>
      </table>`;

      el.querySelector('#audit-export-csv')?.addEventListener('click', () => {
        window.open('/api/audit/export?days=30', '_blank');
      });

      el.querySelector('#audit-analytics-btn')?.addEventListener('click', async () => {
        try {
          const analytics = await Api.getAuditAnalytics(7);
          const html = `
            <div class="modal-header"><h3><i class="fas fa-chart-bar" style="margin-right:8px;color:var(--accent)"></i>Audit Analytics (${analytics.days} days)</h3>
              <button class="modal-close-btn" id="audit-modal-close-x"><i class="fas fa-times"></i></button></div>
            <div class="modal-body">
              <p><strong>${analytics.total}</strong> total actions</p>
              <h4 style="margin-top:12px">Top Users</h4>
              <table class="data-table"><thead><tr><th style="text-align:left">User</th><th>Actions</th></tr></thead>
              <tbody>${(analytics.topUsers || []).map(u => `<tr><td style="text-align:left">${Utils.escapeHtml(u.username)}</td><td>${u.action_count}</td></tr>`).join('')}</tbody></table>
              <h4 style="margin-top:12px">Top Actions</h4>
              <table class="data-table"><thead><tr><th style="text-align:left">Action</th><th>Count</th></tr></thead>
              <tbody>${(analytics.topActions || []).slice(0, 10).map(a => `<tr><td style="text-align:left"><span class="badge badge-info">${Utils.escapeHtml(a.action)}</span></td><td>${a.count}</td></tr>`).join('')}</tbody></table>
            </div>
            <div class="modal-footer"><button class="btn btn-primary" id="audit-modal-close-btn">Close</button></div>`;
          Modal.open(html, { width: '500px' });
          Modal._content.querySelector('#audit-modal-close-x').addEventListener('click', () => Modal.close());
          Modal._content.querySelector('#audit-modal-close-btn').addEventListener('click', () => Modal.close());
        } catch (err) { Toast.error(err.message); }
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Health Overview Tab ─────────────────────────
  async _renderHealth(el) {
    el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div>`;
    try {
      const data = await Api.getHealthOverview();
      const containers = data.containers || [];

      if (containers.length === 0) {
        el.innerHTML = `<div class="empty-msg">${i18n.t('pages.system.noHealthData')}</div>`;
        return;
      }

      const running = containers.filter(c => c.state === 'running').length;
      const unhealthy = containers.filter(c => c.health?.status === 'unhealthy').length;
      const totalRestarts = containers.reduce((sum, c) => sum + (c.restartCount || 0), 0);

      el.innerHTML = `
        <div class="stat-cards" style="display:flex;gap:16px;margin-bottom:16px">
          <div class="card" style="flex:1;padding:16px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:var(--green)">${running}</div>
            <div class="text-muted text-sm">${i18n.t('pages.system.totalRunning', { count: running })}</div>
          </div>
          <div class="card" style="flex:1;padding:16px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${unhealthy > 0 ? 'var(--red)' : 'var(--green)'}">${unhealthy}</div>
            <div class="text-muted text-sm">${i18n.t('pages.system.totalUnhealthy', { count: unhealthy })}</div>
          </div>
          <div class="card" style="flex:1;padding:16px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${totalRestarts > 10 ? 'var(--yellow)' : 'var(--text)'}">${totalRestarts}</div>
            <div class="text-muted text-sm">${i18n.t('pages.system.totalRestarts', { count: totalRestarts })}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>${i18n.t('pages.system.healthTitle')}</h3></div>
          <div class="card-body">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${i18n.t('pages.system.colContainer')}</th>
                  <th>${i18n.t('pages.system.colState')}</th>
                  <th>${i18n.t('pages.system.colHealth')}</th>
                  <th>${i18n.t('pages.system.colRestarts')}</th>
                  <th>${i18n.t('pages.system.colUptime')}</th>
                  <th>${i18n.t('pages.system.colStarted')}</th>
                </tr>
              </thead>
              <tbody>${containers.map(c => {
                const healthBadge = c.health
                  ? `<span class="health-badge ${c.health.status}"><i class="fas fa-circle"></i> ${c.health.status}</span>`
                  : `<span class="text-muted text-sm">—</span>`;
                const uptimeStr = c.uptime > 0 ? Utils.formatDuration(Math.floor(c.uptime / 1000)) : '—';
                return `<tr>
                  <td class="mono text-sm">${Utils.escapeHtml(c.name)}</td>
                  <td><span class="badge ${Utils.statusBadgeClass(c.state)}">${c.state}</span></td>
                  <td>${healthBadge}</td>
                  <td style="${c.restartCount > 5 ? 'color:var(--yellow);font-weight:600' : ''}">${c.restartCount}</td>
                  <td class="text-sm">${uptimeStr}</td>
                  <td class="text-sm text-muted">${c.startedAt ? Utils.timeAgo(c.startedAt) : '—'}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Schedules Tab ──────────────────────────────
  async _renderSchedules(el) {
    try {
      const schedules = await Api.getSchedules();
      const containers = await Api.getContainers(true);

      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h3><i class="fas fa-clock" style="margin-right:8px"></i>${i18n.t('pages.system.schedulesTitle')}</h3>
            <button class="btn btn-sm btn-primary" id="add-schedule">
              <i class="fas fa-plus"></i> ${i18n.t('pages.containers.newSchedule')}
            </button>
          </div>
          <div class="card-body" id="schedules-list">
            ${schedules.length === 0 ? `<div class="text-muted text-sm">${i18n.t('pages.containers.noSchedules')}</div>` : `
            <table class="data-table">
              <thead><tr>
                <th>${i18n.t('pages.system.colContainer')}</th>
                <th>${i18n.t('pages.containers.scheduleAction')}</th>
                <th>${i18n.t('pages.containers.scheduleCron')}</th>
                <th>${i18n.t('common.status')}</th>
                <th>Last Run</th>
                <th>Runs</th>
                <th></th>
              </tr></thead>
              <tbody>${schedules.map(s => `
                <tr>
                  <td class="mono text-sm">${Utils.escapeHtml(s.containerName || s.containerId?.substring(0, 12))}</td>
                  <td><span class="badge badge-info">${s.action}</span></td>
                  <td class="mono text-sm">${Utils.escapeHtml(s.cron)}</td>
                  <td>
                    <label class="toggle-label" style="margin:0">
                      <input type="checkbox" class="sched-toggle" data-sched-id="${s.id}" ${s.enabled ? 'checked' : ''}>
                      <span class="text-sm">${s.enabled ? i18n.t('common.enabled') : i18n.t('common.disabled')}</span>
                    </label>
                  </td>
                  <td class="text-sm">${s.lastRunAt ? `<span class="${s.lastRunStatus === 'error' ? 'text-danger' : ''}">${Utils.timeAgo(s.lastRunAt)}</span>` : '—'}</td>
                  <td class="text-sm">${s.runCount || 0}</td>
                  <td style="white-space:nowrap">
                    <button class="action-btn" data-run-schedule="${s.id}" title="Run Now"><i class="fas fa-play"></i></button>
                    <button class="action-btn" data-history-schedule="${s.id}" title="History"><i class="fas fa-history"></i></button>
                    <button class="action-btn danger" data-del-schedule="${s.id}" title="${i18n.t('common.delete')}"><i class="fas fa-trash"></i></button>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

      // Toggle schedule enabled/disabled
      el.querySelectorAll('.sched-toggle').forEach(checkbox => {
        checkbox.addEventListener('change', async () => {
          try {
            await Api.updateSchedule(checkbox.dataset.schedId, { enabled: checkbox.checked });
            Toast.success(checkbox.checked ? 'Schedule enabled' : 'Schedule disabled');
          } catch (err) { Toast.error(err.message); checkbox.checked = !checkbox.checked; }
        });
      });

      // Run now
      el.querySelectorAll('[data-run-schedule]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            Toast.info('Executing schedule...');
            await Api.runScheduleNow(btn.dataset.runSchedule);
            Toast.success('Schedule executed');
            this._renderSchedules(el);
          } catch (err) { Toast.error('Execution failed: ' + err.message); }
        });
      });

      // History
      el.querySelectorAll('[data-history-schedule]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const history = await Api.getScheduleHistory(btn.dataset.historySchedule);
            if (history.length === 0) {
              Toast.info('No execution history yet.');
              return;
            }
            Modal.open(`
              <div class="modal-header">
                <h3><i class="fas fa-history" style="color:var(--accent);margin-right:8px"></i>Execution History</h3>
                <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
              </div>
              <div class="modal-body">
                <table class="data-table compact">
                  <thead><tr><th>Time</th><th>Action</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
                  <tbody>${history.map(h => `
                    <tr>
                      <td class="text-sm">${Utils.formatDate(h.executed_at)}</td>
                      <td><span class="badge badge-info">${h.action}</span></td>
                      <td><span class="badge ${h.status === 'success' ? 'badge-running' : 'badge-stopped'}">${h.status}</span></td>
                      <td class="text-sm">${h.duration_ms ? h.duration_ms + 'ms' : '—'}</td>
                      <td class="text-sm text-danger">${Utils.escapeHtml(h.error_message || '')}</td>
                    </tr>
                  `).join('')}</tbody>
                </table>
              </div>
              <div class="modal-footer"><button class="btn btn-secondary" id="modal-ok">Close</button></div>
            `, { width: '700px' });
            Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
            Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
          } catch (err) { Toast.error(err.message); }
        });
      });

      // Add schedule
      el.querySelector('#add-schedule').addEventListener('click', async () => {
        const containerOpts = containers.map(c =>
          `<option value="${c.id}" data-name="${Utils.escapeHtml(c.name)}">${Utils.escapeHtml(c.name)} (${c.state})</option>`
        ).join('');

        const result = await Modal.form(`
          <div class="form-group">
            <label>${i18n.t('pages.system.colContainer')}</label>
            <select id="sched-container" class="form-control">${containerOpts}</select>
          </div>
          <div class="form-group">
            <label>${i18n.t('pages.containers.scheduleAction')}</label>
            <select id="sched-action" class="form-control">
              <option value="restart">${i18n.t('common.restart')}</option>
              <option value="stop">${i18n.t('common.stop')}</option>
              <option value="start">${i18n.t('common.start')}</option>
              <option value="pause">${i18n.t('common.pause')}</option>
              <option value="unpause">${i18n.t('common.unpause')}</option>
            </select>
          </div>
          <div class="form-group">
            <label>${i18n.t('pages.containers.scheduleCron')}</label>
            <input type="text" id="sched-cron" class="form-control" placeholder="${i18n.t('pages.containers.cronPlaceholder')}">
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn btn-sm btn-secondary cron-preset" data-cron="*/5 * * * *">Every 5 min</button>
              <button type="button" class="btn btn-sm btn-secondary cron-preset" data-cron="0 * * * *">Every hour</button>
              <button type="button" class="btn btn-sm btn-secondary cron-preset" data-cron="0 0 * * *">Daily midnight</button>
              <button type="button" class="btn btn-sm btn-secondary cron-preset" data-cron="0 3 * * 0">Sun 3 AM</button>
            </div>
          </div>
          <div class="form-group">
            <label>Description <span class="text-muted text-sm">(optional)</span></label>
            <input type="text" id="sched-desc" class="form-control" placeholder="e.g. Weekly restart">
          </div>
        `, {
          title: i18n.t('pages.containers.scheduleCreate'),
          width: '500px',
          onSubmit: (content) => {
            const sel = content.querySelector('#sched-container');
            return {
              containerId: sel.value,
              containerName: sel.options[sel.selectedIndex]?.dataset?.name || '',
              action: content.querySelector('#sched-action').value,
              cron: content.querySelector('#sched-cron').value.trim(),
              description: content.querySelector('#sched-desc').value.trim(),
              enabled: true,
            };
          },
          onMount: (content) => {
            content.querySelectorAll('.cron-preset').forEach(btn => {
              btn.addEventListener('click', (e) => {
                e.preventDefault();
                content.querySelector('#sched-cron').value = btn.dataset.cron;
              });
            });
          },
        });

        if (result && result.cron) {
          try {
            await Api.createSchedule(result);
            Toast.success(i18n.t('pages.containers.scheduleCreated'));
            this._renderSchedules(el);
          } catch (err) { Toast.error(err.message); }
        }
      });

      // Delete schedule
      el.querySelectorAll('[data-del-schedule]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ok = await Modal.confirm(i18n.t('pages.containers.scheduleDeleteConfirm'), { danger: true });
          if (!ok) return;
          try {
            await Api.deleteSchedule(btn.dataset.delSchedule);
            Toast.success(i18n.t('pages.containers.scheduleDeleted'));
            this._renderSchedules(el);
          } catch (err) { Toast.error(err.message); }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Backup & Restore Tab ──────────────────────
  _renderBackup(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-archive" style="margin-right:8px"></i>${i18n.t('pages.system.backupTitle')}</h3>
        </div>
        <div class="card-body">
          <p class="text-muted mb-md">${i18n.t('pages.system.backupDesc')}</p>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <div class="card" style="flex:1;min-width:240px;padding:20px;text-align:center">
              <i class="fas fa-download" style="font-size:32px;color:var(--accent);margin-bottom:12px"></i>
              <h4>${i18n.t('pages.system.exportConfig')}</h4>
              <p class="text-muted text-sm" style="margin:8px 0">${i18n.t('pages.system.backupDesc')}</p>
              <a href="/api/system/backup/config" class="btn btn-sm btn-primary" download>
                <i class="fas fa-download"></i> ${i18n.t('pages.system.exportConfig')}
              </a>
            </div>
            <div class="card" style="flex:1;min-width:240px;padding:20px;text-align:center">
              <i class="fas fa-upload" style="font-size:32px;color:var(--green);margin-bottom:12px"></i>
              <h4>${i18n.t('pages.system.importConfig')}</h4>
              <p class="text-muted text-sm" style="margin:8px 0">${i18n.t('pages.system.selectBackupFile')}</p>
              <input type="file" id="restore-file" accept=".json" style="display:none">
              <button class="btn btn-sm btn-secondary" id="restore-btn">
                <i class="fas fa-upload"></i> ${i18n.t('pages.system.importConfig')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt-md">
        <div class="card-header">
          <h3><i class="fas fa-database" style="margin-right:8px"></i>Database Backup & Restore</h3>
        </div>
        <div class="card-body">
          <p class="text-muted mb-md">Full database backup and restore. This includes all data: users, audit logs, settings, container metadata, and more.</p>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <div class="card" style="flex:1;min-width:240px;padding:20px;text-align:center">
              <i class="fas fa-download" style="font-size:32px;color:var(--accent);margin-bottom:12px"></i>
              <h4>Create Backup</h4>
              <p class="text-muted text-sm" style="margin:8px 0">Download a full copy of the SQLite database.</p>
              <button class="btn btn-sm btn-primary" id="db-backup-tab-btn">
                <i class="fas fa-download"></i> Download Backup
              </button>
            </div>
            <div class="card" style="flex:1;min-width:240px;padding:20px;text-align:center">
              <i class="fas fa-upload" style="font-size:32px;color:var(--red);margin-bottom:12px"></i>
              <h4>Restore Database</h4>
              <p class="text-muted text-sm" style="margin:8px 0">Upload a .db file to replace the current database. A safety backup is created first.</p>
              <input type="file" id="db-restore-file" accept=".db,.sqlite,.sqlite3" style="display:none">
              <button class="btn btn-sm btn-danger" id="db-restore-btn">
                <i class="fas fa-upload"></i> Restore Database
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt-md" id="s3-backup-section">
        <div class="card-header">
          <h3><i class="fab fa-aws" style="margin-right:8px"></i>S3 Cloud Backup</h3>
        </div>
        <div class="card-body">
          <p class="text-muted mb-md">Automatically backup the database to S3-compatible storage (AWS S3, MinIO, Backblaze B2).</p>
          <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:700px">
            <div class="form-group">
              <label>Endpoint URL</label>
              <input type="text" id="s3-endpoint" class="form-control" placeholder="https://s3.amazonaws.com">
            </div>
            <div class="form-group">
              <label>Bucket</label>
              <input type="text" id="s3-bucket" class="form-control" placeholder="my-backups">
            </div>
            <div class="form-group">
              <label>Access Key</label>
              <input type="text" id="s3-access-key" class="form-control" placeholder="AKIA...">
            </div>
            <div class="form-group">
              <label>Secret Key</label>
              <input type="password" id="s3-secret-key" class="form-control" placeholder="secret">
            </div>
            <div class="form-group">
              <label>Region</label>
              <input type="text" id="s3-region" class="form-control" placeholder="us-east-1" value="us-east-1">
            </div>
            <div class="form-group">
              <label>Schedule (cron)</label>
              <input type="text" id="s3-schedule" class="form-control" placeholder="0 3 * * *" value="0 3 * * *">
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" id="s3-save-btn"><i class="fas fa-save"></i> Save Config</button>
            <button class="btn btn-sm btn-secondary" id="s3-test-btn"><i class="fas fa-plug"></i> Test Connection</button>
            <button class="btn btn-sm btn-secondary" id="s3-upload-btn"><i class="fas fa-cloud-upload-alt"></i> Backup Now</button>
          </div>
          <div id="s3-status" class="mt-sm" style="margin-top:12px"></div>
        </div>
      </div>
    `;

    // S3 backup handlers
    (async () => {
      try {
        const status = await Api.get('/system/backup/s3-status');
        const statusEl = el.querySelector('#s3-status');
        if (status.enabled) {
          statusEl.innerHTML = '<span class="badge badge-running">Enabled</span>';
          if (status.lastBackup && status.lastBackup.time) {
            const lb = status.lastBackup;
            const badge = lb.status === 'success' ? 'badge-running' : 'badge-stopped';
            statusEl.innerHTML += ` &mdash; Last backup: <span class="badge ${badge}">${lb.status}</span> ${Utils.timeAgo(lb.time)}`;
            if (lb.size) statusEl.innerHTML += ` (${Utils.formatBytes(lb.size)})`;
            if (lb.error) statusEl.innerHTML += ` <span class="text-red">${Utils.escapeHtml(lb.error)}</span>`;
          }
        } else {
          statusEl.innerHTML = '<span class="text-muted">Not configured — fill in the fields above and save.</span>';
        }
      } catch { /* ignore */ }
    })();

    el.querySelector('#s3-save-btn').addEventListener('click', async () => {
      try {
        const cfg = {
          endpoint: el.querySelector('#s3-endpoint').value.trim(),
          bucket: el.querySelector('#s3-bucket').value.trim(),
          accessKey: el.querySelector('#s3-access-key').value.trim(),
          secretKey: el.querySelector('#s3-secret-key').value.trim(),
          region: el.querySelector('#s3-region').value.trim(),
          schedule: el.querySelector('#s3-schedule').value.trim(),
        };
        if (!cfg.endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) {
          Toast.error('Endpoint, bucket, access key, and secret key are required');
          return;
        }
        await Api.put('/system/backup/s3-config', cfg);
        Toast.success('S3 configuration saved');
        this._renderTab();
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#s3-test-btn').addEventListener('click', async () => {
      try {
        Toast.info('Testing S3 connection...');
        const result = await Api.post('/system/backup/s3-test');
        Toast.success(result.message || 'S3 connection successful');
      } catch (err) { Toast.error('S3 test failed: ' + err.message); }
    });

    el.querySelector('#s3-upload-btn').addEventListener('click', async () => {
      try {
        Toast.info('Uploading backup to S3...');
        const result = await Api.post('/system/backup/s3-upload');
        Toast.success('Backup uploaded to S3 (' + Utils.formatBytes(result.size) + ')');
      } catch (err) { Toast.error('S3 upload failed: ' + err.message); }
    });

    // Database backup from backup tab
    el.querySelector('#db-backup-tab-btn')?.addEventListener('click', async () => {
      try {
        Toast.info('Creating backup...');
        const result = await Api.post('/backup/database');
        if (result.ok) Toast.success('Backup created: ' + Utils.formatBytes(result.size));
        else Toast.error('Backup failed');
      } catch (err) { Toast.error(err.message); }
    });

    const fileInput = el.querySelector('#restore-file');
    el.querySelector('#restore-btn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const ok = await Modal.confirm(`Restore from "${file.name}"? This will overwrite current settings.`, { danger: true });
      if (!ok) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const result = await Api.restoreConfig(data);
        const r = result.restored || {};
        Toast.success(i18n.t('pages.containers.restoreSuccess', {
          details: `Settings: ${r.settings || 0}, Rules: ${r.alertRules || 0}, Schedules: ${r.schedules || 0}`
        }));
      } catch (err) {
        Toast.error(i18n.t('pages.containers.restoreFailed', { message: err.message }));
      }
    });

    // Database restore
    const dbFileInput = el.querySelector('#db-restore-file');
    el.querySelector('#db-restore-btn').addEventListener('click', () => dbFileInput.click());

    dbFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Validate file extension
      if (!file.name.endsWith('.db') && !file.name.endsWith('.sqlite') && !file.name.endsWith('.sqlite3')) {
        Toast.error('Please select a .db, .sqlite, or .sqlite3 file');
        dbFileInput.value = '';
        return;
      }

      const ok = await Modal.confirm(
        `<div style="text-align:left">
          <p><strong>Restore database from "${Utils.escapeHtml(file.name)}"?</strong></p>
          <p style="color:var(--red);margin-top:8px"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>
          This will replace ALL current data (containers metadata, audit logs, settings, users, etc.).</p>
          <p class="text-muted text-sm" style="margin-top:8px">A safety backup of the current database will be created automatically before replacing.</p>
          <p style="margin-top:8px"><strong>The application will restart after restore.</strong></p>
        </div>`,
        { danger: true }
      );
      if (!ok) { dbFileInput.value = ''; return; }

      try {
        Toast.info('Reading database file...');
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });

        Toast.info('Uploading and restoring database...');
        const result = await Api.restoreDatabase(base64);

        if (result.ok) {
          Toast.success('Database restored! Application is restarting...');
          // Wait for the server to restart, then reload
          setTimeout(() => {
            const checkRestart = setInterval(async () => {
              try {
                await fetch('/api/health');
                clearInterval(checkRestart);
                window.location.reload();
              } catch (_) { /* server still restarting */ }
            }, 2000);
          }, 2000);
        }
      } catch (err) {
        Toast.error('Restore failed: ' + err.message);
        dbFileInput.value = '';
      }
    });
  },

  // ═══════════════════════════════════════════════════
  // SSL/TLS WIZARD
  // ═══════════════════════════════════════════════════

  async _renderSsl(el) {
    let status, caddyStatus;
    try {
      [status, caddyStatus] = await Promise.all([Api.getSslStatus(), Api.getCaddyStatus()]);
    } catch {
      status = { mode: 'none', hasCert: false, hasKey: false, hasCaddyfile: false };
      caddyStatus = { exists: false, running: false, status: 'unknown' };
    }

    const modeLabel = {
      'none': '<span class="text-muted"><i class="fas fa-unlock"></i> HTTP Only (No SSL)</span>',
      'self-signed': '<span class="text-yellow"><i class="fas fa-shield-alt"></i> Self-Signed Certificate</span>',
      'caddy': '<span class="text-green"><i class="fas fa-lock"></i> Caddy Reverse Proxy (Auto-TLS)</span>',
    };

    let certHtml = '';
    if (status.certInfo && !status.certInfo.error) {
      const ci = status.certInfo;
      const expiryClass = ci.expired ? 'text-red' : (ci.daysUntilExpiry < 30 ? 'text-yellow' : 'text-green');
      certHtml = `
        <div class="card" style="margin-top:16px">
          <div class="card-header"><h3><i class="fas fa-certificate" style="margin-right:8px"></i>Current Certificate</h3></div>
          <div class="card-body">
            <table class="info-table">
              <tr><td>Subject</td><td class="mono">${Utils.escapeHtml(ci.subject || '')}</td></tr>
              <tr><td>Issuer</td><td class="mono">${Utils.escapeHtml(ci.issuer || '')}</td></tr>
              <tr><td>Valid From</td><td>${ci.notBefore || '—'}</td></tr>
              <tr><td>Expires</td><td class="${expiryClass}">${ci.notAfter || '—'} ${ci.daysUntilExpiry != null ? `(${ci.daysUntilExpiry} days)` : ''}</td></tr>
              <tr><td>Self-Signed</td><td>${ci.selfSigned ? '<span class="text-yellow">Yes</span>' : '<span class="text-green">No</span>'}</td></tr>
              <tr><td>Fingerprint</td><td class="mono text-sm">${Utils.escapeHtml(ci.fingerprint || '')}</td></tr>
            </table>
            <div style="margin-top:12px">
              <a href="/api/system/ssl/cert/server.crt" download class="btn btn-sm btn-secondary"><i class="fas fa-download" style="margin-right:4px"></i>Download Certificate</a>
              <a href="/api/system/ssl/cert/server.key" download class="btn btn-sm btn-secondary" style="margin-left:8px"><i class="fas fa-download" style="margin-right:4px"></i>Download Key</a>
            </div>
          </div>
        </div>
      `;
    } else if (status.certInfo?.error) {
      certHtml = `<div class="card" style="margin-top:16px"><div class="card-body"><span class="text-muted">${Utils.escapeHtml(status.certInfo.error)}</span></div></div>`;
    }

    let caddyHtml = '';
    if (status.caddyfileContent) {
      caddyHtml = `
        <div class="card" style="margin-top:16px">
          <div class="card-header"><h3><i class="fas fa-file-code" style="margin-right:8px"></i>Caddyfile</h3></div>
          <div class="card-body">
            <pre class="code-block" style="max-height:200px;overflow:auto">${Utils.escapeHtml(status.caddyfileContent)}</pre>
          </div>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-shield-alt" style="margin-right:8px"></i>SSL/TLS Configuration</h3>
        </div>
        <div class="card-body">
          <table class="info-table">
            <tr><td>Current Mode</td><td>${modeLabel[status.mode] || modeLabel.none}</td></tr>
            <tr><td>Certificate</td><td>${status.hasCert ? '<span class="text-green">Present</span>' : '<span class="text-muted">Not configured</span>'}</td></tr>
            <tr><td>Private Key</td><td>${status.hasKey ? '<span class="text-green">Present</span>' : '<span class="text-muted">Not configured</span>'}</td></tr>
            <tr><td>Certs Directory</td><td class="mono text-sm">${Utils.escapeHtml(status.certsDir || '/data/certs')}</td></tr>
          </table>
        </div>
      </div>

      ${certHtml}
      ${caddyHtml}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:20px">
        <!-- Option 1: No SSL -->
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-unlock" style="margin-right:8px"></i>No SSL</h3></div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:12px">
              Use HTTP only. Suitable for local/internal networks behind a trusted reverse proxy.
            </p>
            ${status.mode !== 'none' ? '<button class="btn btn-sm btn-danger" id="ssl-remove"><i class="fas fa-trash" style="margin-right:4px"></i>Remove SSL Config</button>' : '<span class="badge badge-info">Current</span>'}
          </div>
        </div>

        <!-- Option 2: Self-Signed -->
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-certificate" style="margin-right:8px"></i>Self-Signed Certificate</h3></div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:12px">
              Generate a self-signed certificate for development or internal use. Browsers will show a warning.
            </p>
            <div class="form-group">
              <label>Domain / Hostname</label>
              <input type="text" id="ssl-domain" class="form-control" placeholder="e.g. docker-dash.local" value="${window.location.hostname}">
            </div>
            <button class="btn btn-sm btn-primary" id="ssl-generate"><i class="fas fa-magic" style="margin-right:4px"></i>Generate Certificate</button>
          </div>
        </div>

        <!-- Option 3: Caddy Zero-Config HTTPS -->
        <div class="card" style="${caddyStatus.running ? 'border-color:var(--green)' : ''}">
          <div class="card-header">
            <h3><i class="fas fa-lock" style="margin-right:8px"></i>Automatic HTTPS (Let's Encrypt)</h3>
            <span class="badge" style="font-size:10px;background:${caddyStatus.running ? 'var(--green)' : 'var(--surface2)'}; color:${caddyStatus.running ? '#000' : 'var(--text-dim)'}">
              <i class="fas fa-circle" style="font-size:8px;margin-right:3px"></i>
              Caddy ${caddyStatus.running ? 'running' : (caddyStatus.exists ? caddyStatus.status : 'not started')}
            </span>
          </div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:12px">
              Enter your public domain and click <strong>Enable HTTPS</strong>. Docker Dash will write the Caddyfile and reload Caddy automatically — no manual steps needed.
            </p>
            <div class="form-group">
              <label>Public Domain</label>
              <input type="text" id="caddy-domain" class="form-control" placeholder="e.g. dash.example.com" ${!caddyStatus.running ? 'disabled' : ''}>
              <small class="text-muted">Must resolve to this server's public IP for Let's Encrypt to work</small>
            </div>
            <div class="form-group">
              <label>Docker Dash Port</label>
              <input type="number" id="caddy-port" class="form-control" value="8101" ${!caddyStatus.running ? 'disabled' : ''}>
            </div>
            ${caddyStatus.running
              ? `<button class="btn btn-sm btn-primary" id="caddy-enable"><i class="fas fa-magic" style="margin-right:4px"></i>Enable HTTPS</button>`
              : `<div class="tip-box" style="margin-bottom:0">
                  <i class="fas fa-terminal"></i>
                  <div>Start Caddy first:<br><code>docker compose --profile tls up -d</code><br>
                  <small class="text-muted" style="margin-top:4px;display:block">Then refresh this page — the button will activate.</small></div>
                </div>`
            }
          </div>
        </div>
      </div>
    `;

    // Event handlers
    el.querySelector('#ssl-generate')?.addEventListener('click', async () => {
      const domain = el.querySelector('#ssl-domain').value.trim();
      if (!domain) { Toast.warning('Enter a domain'); return; }
      try {
        Toast.info('Generating self-signed certificate...');
        const result = await Api.generateSelfSigned(domain);
        Toast.success('Certificate generated for ' + domain);
        await this._renderSsl(el);
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#caddy-enable')?.addEventListener('click', async () => {
      const domain = el.querySelector('#caddy-domain').value.trim();
      const port = el.querySelector('#caddy-port').value.trim();
      if (!domain) { Toast.warning('Enter a domain'); return; }
      try {
        Toast.info('Enabling HTTPS for ' + domain + '...');
        await Api.enableHttps(domain, parseInt(port) || 8101);
        Toast.success('HTTPS enabled — Caddy is now serving ' + domain);
        await this._renderSsl(el);
      } catch (err) {
        if (err.message?.includes('caddy_not_running')) {
          Toast.warning('Caddy is not running. Start it with: docker compose --profile tls up -d');
        } else {
          Toast.error(err.message);
        }
      }
    });

    el.querySelector('#ssl-remove')?.addEventListener('click', async () => {
      if (!confirm('Remove all SSL configuration? This cannot be undone.')) return;
      try {
        await Api.removeSsl();
        Toast.success('SSL configuration removed');
        await this._renderSsl(el);
      } catch (err) { Toast.error(err.message); }
    });
  },

  async _renderCisBenchmark(el) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-clipboard-check" style="margin-right:8px;color:var(--accent)"></i>CIS Docker Benchmark <span class="badge badge-info" style="font-size:10px;margin-left:6px">v1.6</span></h3>
          <button class="btn btn-sm btn-primary" id="cis-run"><i class="fas fa-play" style="margin-right:4px"></i>Run Benchmark</button>
        </div>
        <div class="card-body" style="padding-bottom:0">
          <div id="cis-score-bar" style="display:none;margin-bottom:16px"></div>
          <!-- sub-tabs -->
          <div class="tabs" id="cis-tabs" style="border-bottom:1px solid var(--border);margin:0 -16px;padding:0 16px">
            <button class="tab active" data-cis-tab="guide"><i class="fas fa-book-open" style="margin-right:4px"></i>Guide</button>
            <button class="tab" data-cis-tab="daemon"><i class="fas fa-cog" style="margin-right:4px"></i>Daemon <span id="cis-badge-daemon" class="badge" style="margin-left:4px;font-size:9px;display:none"></span></button>
            <button class="tab" data-cis-tab="container"><i class="fas fa-box" style="margin-right:4px"></i>Containers <span id="cis-badge-container" class="badge" style="margin-left:4px;font-size:9px;display:none"></span></button>
            <button class="tab" data-cis-tab="all"><i class="fas fa-list" style="margin-right:4px"></i>All results</button>
          </div>
        </div>
        <div class="card-body" id="cis-tab-content" style="padding-top:16px">
          <div id="cis-guide-panel">${this._cisBenchmarkGuide()}</div>
          <div id="cis-daemon-panel" style="display:none"><p class="text-muted text-sm">Run the benchmark first.</p></div>
          <div id="cis-container-panel" style="display:none"><p class="text-muted text-sm">Run the benchmark first.</p></div>
          <div id="cis-all-panel" style="display:none"><p class="text-muted text-sm">Run the benchmark first.</p></div>
        </div>
      </div>
    `;

    // Sub-tab switching
    let _cisTab = 'guide';
    el.querySelectorAll('[data-cis-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('[data-cis-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _cisTab = btn.dataset.cisTab;
        el.querySelectorAll('#cis-guide-panel,#cis-daemon-panel,#cis-container-panel,#cis-all-panel')
          .forEach(p => p.style.display = 'none');
        el.querySelector(`#cis-${_cisTab}-panel`).style.display = '';
      });
    });

    const statusIcon = s => ({
      pass: '<i class="fas fa-check-circle" style="color:var(--green)"></i>',
      warn: '<i class="fas fa-exclamation-triangle" style="color:var(--yellow)"></i>',
      fail: '<i class="fas fa-times-circle" style="color:var(--red)"></i>',
      info: '<i class="fas fa-info-circle" style="color:var(--accent)"></i>',
    }[s] || '');

    const statusBadge = s => ({
      pass: '<span class="badge" style="background:rgba(74,222,128,.15);color:var(--green)">PASS</span>',
      warn: '<span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow)">WARN</span>',
      fail: '<span class="badge" style="background:rgba(239,68,68,.15);color:var(--red)">FAIL</span>',
      info: '<span class="badge" style="background:rgba(56,139,253,.12);color:var(--accent)">INFO</span>',
    }[s] || '');

    // Render a flat list of checks (daemon or all-daemon)
    const renderDaemonChecks = (checks) => checks.map(item => `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--surface2)">
        <span style="width:22px;flex-shrink:0;margin-top:2px">${statusIcon(item.status)}</span>
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600">${Utils.escapeHtml(item.id)}</span>
            ${statusBadge(item.status)}
            <span style="font-size:13px">${Utils.escapeHtml(item.title)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:4px">${Utils.escapeHtml(item.details)}</div>
          ${item.status !== 'pass' ? `<div style="font-size:11px;margin-top:6px;padding:6px 10px;background:rgba(56,139,253,.07);border-left:3px solid var(--accent);border-radius:0 var(--radius-sm) var(--radius-sm) 0"><i class="fas fa-wrench" style="margin-right:5px;color:var(--accent)"></i><strong>Fix:</strong> ${Utils.escapeHtml(item.remediation || '')}</div>` : ''}
        </div>
      </div>
    `).join('');

    // Render per-container accordion
    const renderContainerChecks = (checks) => {
      if (!checks.length) return '<div class="empty-msg">No running containers to check.</div>';
      return checks.map(item => {
        const findings = item.findings || [];
        const failCount = findings.filter(f => f.severity === 'fail').length;
        const warnCount = findings.filter(f => f.severity === 'warn').length;
        const passAll = item.status === 'pass';
        return `
          <details style="margin-bottom:8px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden" ${item.status === 'fail' ? 'open' : ''}>
            <summary style="cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:10px;list-style:none;background:var(--surface2)">
              <span>${statusIcon(item.status)}</span>
              <span style="font-weight:600;flex:1">${Utils.escapeHtml(item.title)}</span>
              ${item.image ? `<span class="text-muted" style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escapeHtml(item.image)}">${Utils.escapeHtml(item.image.split('/').pop())}</span>` : ''}
              ${failCount ? `<span class="badge" style="background:rgba(239,68,68,.15);color:var(--red)">${failCount} fail</span>` : ''}
              ${warnCount ? `<span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow)">${warnCount} warn</span>` : ''}
              ${passAll ? `<span class="badge" style="background:rgba(74,222,128,.15);color:var(--green)">all clear</span>` : ''}
            </summary>
            <div style="padding:12px 14px">
              ${passAll
                ? '<div style="color:var(--green);font-size:13px"><i class="fas fa-check-circle" style="margin-right:6px"></i>All container security checks passed.</div>'
                : findings.map(f => `
                    <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--surface2)">
                      <span style="width:16px;flex-shrink:0;margin-top:1px">${statusIcon(f.severity)}</span>
                      <div style="flex:1">
                        <div style="font-size:12px">${Utils.escapeHtml(f.msg)}</div>
                        ${this._cisContainerRemediation(f.msg)}
                      </div>
                    </div>
                  `).join('')
              }
              ${!passAll ? `<div style="margin-top:12px;text-align:right"><button class="btn btn-sm btn-accent cis-hardened-btn" data-container="${Utils.escapeHtml(item.title)}" style="font-size:11px"><i class="fas fa-shield-alt" style="margin-right:5px"></i>Generate CIS-hardened compose</button></div>` : ''}
            </div>
          </details>
        `;
      }).join('');
    };

    const renderResults = (data) => {
      const { checks, summary, score, runAt } = data;
      const scoreColor = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--red)';
      const daemonChecks = checks.filter(c => c.category === 'Daemon');
      const containerChecks = checks.filter(c => c.category === 'Container');

      // Score bar
      el.querySelector('#cis-score-bar').style.display = '';
      el.querySelector('#cis-score-bar').innerHTML = `
        <div style="display:flex;align-items:center;gap:20px;padding:14px 16px;background:var(--surface2);border-radius:var(--radius);flex-wrap:wrap">
          <div style="text-align:center;min-width:70px">
            <div style="font-size:32px;font-weight:700;color:${scoreColor};line-height:1">${score}%</div>
            <div class="text-muted" style="font-size:10px;margin-top:2px">Security Score</div>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <span class="badge" style="background:rgba(74,222,128,.15);color:var(--green);font-size:11px"><i class="fas fa-check" style="margin-right:4px"></i>${summary.pass || 0} passed</span>
            <span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow);font-size:11px"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>${summary.warn || 0} warnings</span>
            <span class="badge" style="background:rgba(239,68,68,.15);color:var(--red);font-size:11px"><i class="fas fa-times" style="margin-right:4px"></i>${summary.fail || 0} failures</span>
            <span class="badge" style="font-size:11px"><i class="fas fa-info-circle" style="margin-right:4px"></i>${summary.info || 0} info</span>
          </div>
          <div class="text-muted" style="font-size:11px;margin-left:auto">Run at ${new Date(runAt).toLocaleTimeString()}</div>
        </div>
      `;

      // Update badges on sub-tabs
      const daemonIssues = daemonChecks.filter(c => c.status !== 'pass' && c.status !== 'info').length;
      const containerIssues = containerChecks.filter(c => c.status !== 'pass').length;
      const daemonBadge = el.querySelector('#cis-badge-daemon');
      const containerBadge = el.querySelector('#cis-badge-container');
      if (daemonIssues) { daemonBadge.textContent = daemonIssues; daemonBadge.style.display = ''; daemonBadge.style.background = 'rgba(234,179,8,.25)'; daemonBadge.style.color = 'var(--yellow)'; }
      if (containerIssues) { containerBadge.textContent = containerIssues; containerBadge.style.display = ''; containerBadge.style.background = 'rgba(239,68,68,.2)'; containerBadge.style.color = 'var(--red)'; }

      // Daemon panel
      el.querySelector('#cis-daemon-panel').innerHTML = `
        <h4 style="margin:0 0 12px;font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">
          <i class="fas fa-cog" style="margin-right:6px"></i>Docker Daemon Configuration (${daemonChecks.length} checks)
        </h4>
        ${renderDaemonChecks(daemonChecks)}
      `;

      // Container panel
      el.querySelector('#cis-container-panel').innerHTML = `
        <h4 style="margin:0 0 12px;font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">
          <i class="fas fa-box" style="margin-right:6px"></i>Running Containers (${containerChecks.length} containers checked)
        </h4>
        ${renderContainerChecks(containerChecks)}
      `;

      // All panel
      el.querySelector('#cis-all-panel').innerHTML = `
        <h4 style="margin:0 0 12px;font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">
          <i class="fas fa-list" style="margin-right:6px"></i>All Results (${checks.length} total)
        </h4>
        ${renderDaemonChecks(daemonChecks)}
        <h4 style="margin:16px 0 12px;font-size:13px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">
          <i class="fas fa-box" style="margin-right:6px"></i>Containers
        </h4>
        ${renderContainerChecks(containerChecks)}
      `;

      // Auto-switch to daemon tab after first run
      const daemonBtn = el.querySelector('[data-cis-tab="daemon"]');
      daemonBtn?.click();
    };

    el.querySelector('#cis-run').addEventListener('click', async () => {
      const runBtn = el.querySelector('#cis-run');
      runBtn.disabled = true;
      runBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>Running...';
      try {
        const data = await Api.runCisBenchmark(this._hostId);
        renderResults(data);
      } catch (err) {
        el.querySelector('#cis-daemon-panel').innerHTML = `<div class="alert alert-danger">Error: ${Utils.escapeHtml(err.message)}</div>`;
        el.querySelector('[data-cis-tab="daemon"]')?.click();
      } finally {
        runBtn.disabled = false;
        runBtn.innerHTML = '<i class="fas fa-sync-alt" style="margin-right:4px"></i>Run Again';
      }
    });

    // CIS hardened compose — event delegation on the container panel
    el.querySelector('#cis-container-panel').addEventListener('click', async (e) => {
      const btn = e.target.closest('.cis-hardened-btn');
      if (!btn) return;
      const containerName = btn.dataset.container;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Generating...';
      try {
        const data = await Api.getCisHardenedCompose(containerName, this._hostId);
        const changesHtml = data.changes.length
          ? `<div style="margin-bottom:12px;padding:10px 14px;background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.25);border-radius:var(--radius-sm)">
              <div style="font-size:11px;font-weight:600;color:var(--green);margin-bottom:6px"><i class="fas fa-check-circle" style="margin-right:5px"></i>CIS fixes applied (${data.changes.length})</div>
              <ul style="margin:0;padding-left:18px;font-size:11px;color:var(--text-dim)">
                ${data.changes.map(c => `<li>${Utils.escapeHtml(c)}</li>`).join('')}
              </ul>
            </div>`
          : '';
        Modal.open(`
          <div class="modal-header">
            <h3><i class="fas fa-shield-alt" style="color:var(--green);margin-right:8px"></i>CIS-hardened compose — ${Utils.escapeHtml(containerName)}</h3>
            <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body">
            <div style="margin-bottom:10px;padding:8px 12px;background:rgba(56,139,253,.08);border:1px solid var(--accent);border-radius:var(--radius-sm);font-size:12px;color:var(--text-dim)">
              <i class="fas fa-info-circle" style="margin-right:6px;color:var(--accent)"></i>
              <strong>Generated &amp; hardened from container metadata.</strong> Review carefully before deploying — adjust <code>mem_limit</code>, <code>cpus</code>, <code>user</code>, and <code>tmpfs</code> to match your app.
            </div>
            ${changesHtml}
            <textarea id="cis-compose-out" style="width:100%;min-height:420px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:var(--mono);font-size:12px;padding:12px;resize:vertical;outline:none;border-radius:var(--radius-sm);tab-size:2">${Utils.escapeHtml(data.compose)}</textarea>
          </div>
          <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-secondary" id="cis-copy"><i class="fas fa-copy"></i> Copy</button>
            <button class="btn btn-secondary" id="modal-ok">${i18n.t('common.close')}</button>
          </div>
        `, { width: '800px' });
        Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
        Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
        Modal._content.querySelector('#cis-copy').addEventListener('click', () => {
          const val = Modal._content.querySelector('#cis-compose-out').value;
          Utils.copyToClipboard(val).then(() => Toast.success(i18n.t('common.copied')));
        });
      } catch (err) {
        Toast.error(err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-shield-alt" style="margin-right:5px"></i>Generate CIS-hardened compose';
      }
    });
  },

  _cisContainerRemediation(msg) {
    const remediations = {
      'privileged mode': { fix: 'Remove <code>--privileged</code>. Grant only needed capabilities with <code>--cap-add</code>.', doc: 'https://docs.docker.com/engine/reference/run/#runtime-privilege-and-linux-capabilities' },
      'CapAdd=ALL': { fix: 'Remove <code>--cap-add ALL</code>. Use the minimum required capabilities instead.', doc: 'https://docs.docker.com/engine/reference/run/#runtime-privilege-and-linux-capabilities' },
      'Sensitive capabilities': { fix: 'Audit and remove unnecessary capabilities. <code>NET_ADMIN</code>, <code>SYS_ADMIN</code>, <code>SYS_PTRACE</code> are high risk.', doc: 'https://docs.docker.com/engine/reference/run/#runtime-privilege-and-linux-capabilities' },
      'no-new-privileges': { fix: 'Add <code>--security-opt no-new-privileges</code> or in Compose: <code>security_opt: [no-new-privileges:true]</code>', doc: 'https://docs.docker.com/engine/reference/run/#security-configuration' },
      'PID namespace': { fix: 'Remove <code>--pid=host</code>. This grants the container full visibility of all host processes.', doc: 'https://docs.docker.com/engine/reference/run/#pid-settings---pid' },
      'host network': { fix: 'Remove <code>--network=host</code>. Use a named Docker network and expose only needed ports.', doc: 'https://docs.docker.com/network/network-tutorial-host/' },
      'IPC namespace': { fix: 'Remove <code>--ipc=host</code>. Use <code>--ipc=private</code> (default) or <code>--ipc=shareable</code> between specific containers.', doc: 'https://docs.docker.com/engine/reference/run/#ipc-settings---ipc' },
      'read-only': { fix: 'Add <code>--read-only</code> flag. Use <code>--tmpfs /tmp</code> for writable temp dirs.', doc: 'https://docs.docker.com/engine/reference/run/#read-only' },
      'memory limit': { fix: 'Set <code>--memory 512m</code> (or appropriate limit). In Compose: <code>mem_limit: 512m</code>', doc: 'https://docs.docker.com/config/containers/resource_constraints/' },
      'CPU': { fix: 'Set <code>--cpus 1.0</code> or <code>--cpu-shares 512</code>. In Compose: <code>cpus: "1.0"</code>', doc: 'https://docs.docker.com/config/containers/resource_constraints/#cpu' },
      'bind-mounted read-write': { fix: 'Mount sensitive paths read-only: <code>-v /etc:/etc:ro</code>. Prefer named volumes over bind mounts.', doc: 'https://docs.docker.com/storage/bind-mounts/' },
      'Docker socket': { fix: 'Avoid mounting the Docker socket unless absolutely necessary. Use docker-socket-proxy to restrict API access.', doc: 'https://github.com/Tecnativa/docker-socket-proxy' },
      'Privileged ports': { fix: 'Use ports ≥ 1024 internally and map them: <code>-p 80:8080</code>. Avoid binding privileged ports directly.', doc: 'https://docs.docker.com/network/' },
      'root': { fix: 'Add <code>--user 1000:1000</code> or set <code>USER</code> in the Dockerfile. Run as a non-root user.', doc: 'https://docs.docker.com/develop/develop-images/dockerfile_best-practices/#user' },
    };
    const key = Object.keys(remediations).find(k => msg.toLowerCase().includes(k.toLowerCase()));
    if (!key) return '';
    const r = remediations[key];
    return `<div style="font-size:11px;margin-top:5px;padding:5px 8px;background:rgba(56,139,253,.07);border-left:3px solid var(--accent);border-radius:0 var(--radius-sm) var(--radius-sm) 0">
      <i class="fas fa-wrench" style="margin-right:4px;color:var(--accent)"></i><strong>Fix:</strong> ${r.fix}
      <a href="${r.doc}" target="_blank" rel="noopener" style="margin-left:8px;font-size:10px;color:var(--accent)"><i class="fas fa-external-link-alt"></i> docs</a>
    </div>`;
  },

  _cisBenchmarkGuide() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

        <!-- What is CIS? -->
        <div style="grid-column:1/-1;padding:14px 16px;background:var(--surface2);border-radius:var(--radius);border-left:4px solid var(--accent)">
          <div style="font-weight:600;margin-bottom:6px"><i class="fas fa-shield-alt" style="margin-right:8px;color:var(--accent)"></i>What is the CIS Docker Benchmark?</div>
          <div class="text-sm text-muted">
            The <strong>Center for Internet Security (CIS) Docker Benchmark</strong> is an industry-standard security configuration guide for Docker.
            It defines measurable technical controls across two areas: <strong>Docker daemon configuration</strong> and <strong>container runtime settings</strong>.
            Running it gives you an objective security score and a prioritized remediation list — no guesswork.
          </div>
        </div>

        <!-- Daemon checks explained -->
        <div class="card" style="margin:0">
          <div class="card-header" style="padding:10px 14px">
            <h4 style="margin:0;font-size:13px"><i class="fas fa-cog" style="margin-right:7px;color:var(--accent)"></i>Daemon Checks (D-1 … D-6)</h4>
          </div>
          <div class="card-body" style="padding:10px 14px;font-size:12px;display:flex;flex-direction:column;gap:10px">
            <div><strong>D-1 — Logging driver</strong><br><span class="text-muted">Docker should have a logging driver configured (<code>json-file</code>, <code>journald</code>, <code>syslog</code>…). <code>none</code> means lost logs after restart.</span></div>
            <div><strong>D-2 — Experimental features</strong><br><span class="text-muted">Experimental features are unstable and may have security vulnerabilities. Disable in production with <code>"experimental": false</code> in <code>/etc/docker/daemon.json</code>.</span></div>
            <div><strong>D-3 — Live restore</strong><br><span class="text-muted"><code>--live-restore</code> keeps containers running during daemon restarts/upgrades. Add <code>"live-restore": true</code> to <code>daemon.json</code>.</span></div>
            <div><strong>D-4 — Userland proxy</strong><br><span class="text-muted">Disabling <code>--userland-proxy</code> makes Docker use iptables DNAT instead of a Go proxy per port. More efficient, uses fewer resources.</span></div>
            <div><strong>D-5 — Seccomp profile</strong><br><span class="text-muted">Seccomp filters syscalls the container can make. The default Docker seccomp profile blocks ~40 dangerous syscalls. Verify it's active.</span></div>
            <div><strong>D-6 — AppArmor / SELinux</strong><br><span class="text-muted">Mandatory Access Control frameworks that restrict container actions at the OS level. Ubuntu/Debian use AppArmor; RHEL/Fedora use SELinux.</span></div>
          </div>
        </div>

        <!-- Container checks explained -->
        <div class="card" style="margin:0">
          <div class="card-header" style="padding:10px 14px">
            <h4 style="margin:0;font-size:13px"><i class="fas fa-box" style="margin-right:7px;color:var(--accent)"></i>Container Checks (C-1 … C-12)</h4>
          </div>
          <div class="card-body" style="padding:10px 14px;font-size:12px;display:flex;flex-direction:column;gap:10px">
            <div><strong>C-1 — Privileged mode</strong><br><span class="text-muted"><code>--privileged</code> gives the container nearly the same access as root on the host. Almost never needed.</span></div>
            <div><strong>C-2 — Capabilities</strong><br><span class="text-muted">Linux capabilities break root into discrete privileges. <code>CAP_SYS_ADMIN</code> is nearly equivalent to full root. Drop unused caps.</span></div>
            <div><strong>C-3 — no-new-privileges</strong><br><span class="text-muted">Prevents container processes from gaining more privileges via setuid/setgid binaries. A single flag, near-zero cost.</span></div>
            <div><strong>C-4/5/6 — Namespace sharing</strong><br><span class="text-muted"><code>--pid=host</code>, <code>--network=host</code>, <code>--ipc=host</code> all remove isolation boundaries. Use only when explicitly required.</span></div>
            <div><strong>C-7 — Read-only rootfs</strong><br><span class="text-muted"><code>--read-only</code> prevents malware from writing to the container filesystem. Use <code>--tmpfs /tmp</code> for writable temp space.</span></div>
            <div><strong>C-8/9 — Resource limits</strong><br><span class="text-muted">Without <code>--memory</code> and <code>--cpus</code>, a runaway container can consume all host resources (DoS). Set limits on every container.</span></div>
            <div><strong>C-10 — Sensitive bind mounts</strong><br><span class="text-muted">Mounting <code>/etc</code>, <code>/proc</code>, <code>/sys</code>, or the Docker socket read-write can lead to full host compromise.</span></div>
            <div><strong>C-11/12 — Ports &amp; user</strong><br><span class="text-muted">Binding privileged ports (&lt;1024) requires elevated privileges. Running as <code>root</code> inside the container amplifies any escape.</span></div>
          </div>
        </div>

        <!-- Scoring -->
        <div class="card" style="margin:0">
          <div class="card-header" style="padding:10px 14px">
            <h4 style="margin:0;font-size:13px"><i class="fas fa-chart-pie" style="margin-right:7px;color:var(--accent)"></i>How the score is calculated</h4>
          </div>
          <div class="card-body" style="padding:10px 14px;font-size:12px">
            <p class="text-muted" style="margin:0 0 8px">Score = <code>passed / (passed + warned + failed) × 100</code>. Informational findings don't affect the score.</p>
            <div style="display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;align-items:center;gap:8px"><span style="width:40px;height:8px;border-radius:4px;background:var(--green);display:inline-block"></span><span class="text-muted">80–100% — Good posture. Review remaining warnings.</span></div>
              <div style="display:flex;align-items:center;gap:8px"><span style="width:40px;height:8px;border-radius:4px;background:var(--yellow);display:inline-block"></span><span class="text-muted">50–79% — Moderate risk. Prioritize FAIL items.</span></div>
              <div style="display:flex;align-items:center;gap:8px"><span style="width:40px;height:8px;border-radius:4px;background:var(--red);display:inline-block"></span><span class="text-muted">&lt;50% — High risk. Immediate action recommended.</span></div>
            </div>
            <p class="text-muted" style="margin:10px 0 0;font-size:11px">
              <i class="fas fa-info-circle" style="margin-right:4px"></i>
              Some warnings (e.g. <em>no memory limit</em> on a dev container) may be acceptable tradeoffs. Use your judgement.
            </p>
          </div>
        </div>

        <!-- Quick wins -->
        <div class="card" style="margin:0">
          <div class="card-header" style="padding:10px 14px">
            <h4 style="margin:0;font-size:13px"><i class="fas fa-bolt" style="margin-right:7px;color:var(--yellow)"></i>Quick wins (highest impact, lowest effort)</h4>
          </div>
          <div class="card-body" style="padding:10px 14px;font-size:12px;display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;gap:8px">
              <span style="color:var(--red);font-size:16px;line-height:1.3">①</span>
              <div><strong>Add <code>no-new-privileges</code> to every container</strong><br><span class="text-muted">One line in compose, no app changes needed. Eliminates an entire class of privilege escalation.</span><br><code style="font-size:10px;color:var(--accent)">security_opt: [no-new-privileges:true]</code></div>
            </div>
            <div style="display:flex;gap:8px">
              <span style="color:var(--red);font-size:16px;line-height:1.3">②</span>
              <div><strong>Set memory limits</strong><br><span class="text-muted">Prevents OOM cascades. Start with <code>mem_limit: 512m</code> and tune from real usage data.</span></div>
            </div>
            <div style="display:flex;gap:8px">
              <span style="color:var(--yellow);font-size:16px;line-height:1.3">③</span>
              <div><strong>Enable live restore on the daemon</strong><br><span class="text-muted">Add <code>"live-restore": true</code> to <code>/etc/docker/daemon.json</code> and <code>systemctl reload docker</code>. Zero downtime.</span></div>
            </div>
            <div style="display:flex;gap:8px">
              <span style="color:var(--yellow);font-size:16px;line-height:1.3">④</span>
              <div><strong>Run containers as non-root</strong><br><span class="text-muted">Add <code>USER 1001</code> to Dockerfile or <code>user: "1001:1001"</code> in Compose.</span></div>
            </div>
            <div style="display:flex;gap:8px">
              <span style="color:var(--accent);font-size:16px;line-height:1.3">⑤</span>
              <div><strong>Remove <code>--privileged</code> and cap-add ALL</strong><br><span class="text-muted">Audit each container. Almost nothing legitimately needs full host access.</span></div>
            </div>
          </div>
        </div>

        <!-- Resources -->
        <div style="grid-column:1/-1">
          <div style="font-size:12px;color:var(--text-dim);display:flex;gap:16px;flex-wrap:wrap;align-items:center;padding-top:8px;border-top:1px solid var(--border)">
            <span><i class="fas fa-book" style="margin-right:5px"></i>Resources:</span>
            <a href="https://www.cisecurity.org/benchmark/docker" target="_blank" rel="noopener" style="color:var(--accent)">CIS Docker Benchmark PDF</a>
            <a href="https://docs.docker.com/engine/security/" target="_blank" rel="noopener" style="color:var(--accent)">Docker Security docs</a>
            <a href="https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html" target="_blank" rel="noopener" style="color:var(--accent)">OWASP Docker Cheat Sheet</a>
            <a href="https://github.com/docker/docker-bench-security" target="_blank" rel="noopener" style="color:var(--accent)">docker-bench-security (official tool)</a>
          </div>
        </div>

      </div>
    `;
  },

  destroy() {
    Object.values(this._charts).forEach(c => c.destroy());
    this._charts = {};
  },
};

window.SystemPage = SystemPage;
