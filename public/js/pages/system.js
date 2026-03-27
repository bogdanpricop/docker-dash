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
                <tr style="cursor:pointer" onclick="location.hash='#/containers/${c.id}'">
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
                <h4><i class="fas fa-compress-arrows-alt" style="color:var(--green);margin-right:8px"></i>Vacuum Database</h4>
                <p class="text-muted text-sm" style="margin:8px 0">Reclaim disk space by compacting the database file. Runs automatically daily at 03:30. May briefly slow down the app.</p>
                <button class="btn btn-sm btn-secondary" id="db-vacuum-btn">
                  <i class="fas fa-compress-arrows-alt"></i> Run Vacuum Now
                </button>
                <div id="db-vacuum-result" style="margin-top:8px"></div>
              </div>
            </div>
          </div>
        </div>
      `;

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
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  // ─── Tools Tab ─────────────────────────────────────
  _renderTools(el) {
    el.innerHTML = `
      <div class="info-grid" style="margin-top:0">
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-terminal" style="margin-right:8px"></i>docker run → Compose</h3></div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:12px">Paste a <code>docker run</code> command to convert it to docker-compose YAML.</p>
            <textarea id="tool-run-input" class="form-control" rows="4" style="font-family:var(--mono);font-size:12px"
              placeholder="docker run -d --name myapp -p 8080:80 -v data:/app/data -e NODE_ENV=production --restart unless-stopped nginx:alpine"></textarea>
            <button class="btn btn-sm btn-primary" id="tool-run-convert" style="margin-top:8px"><i class="fas fa-exchange-alt"></i> Convert</button>
            <div id="tool-run-output" style="margin-top:12px;display:none">
              <textarea id="tool-run-yaml" class="form-control" rows="12" style="font-family:var(--mono);font-size:12px" readonly></textarea>
              <button class="btn btn-sm btn-secondary" id="tool-run-copy" style="margin-top:4px"><i class="fas fa-copy"></i> Copy</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h3><i class="fas fa-tags" style="margin-right:8px"></i>Reverse Proxy Labels</h3></div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:12px">Generate Traefik or Caddy labels for a container.</p>
            <div class="form-group">
              <label>Proxy Type</label>
              <select id="tool-proxy-type" class="form-control"><option value="traefik">Traefik v2</option><option value="caddy">Caddy</option></select>
            </div>
            <div style="display:flex;gap:8px">
              <div class="form-group" style="flex:1"><label>Domain</label><input type="text" id="tool-proxy-domain" class="form-control" placeholder="app.example.com"></div>
              <div class="form-group" style="flex:1"><label>Container Port</label><input type="number" id="tool-proxy-port" class="form-control" value="80"></div>
            </div>
            <div class="form-group"><label><input type="checkbox" id="tool-proxy-tls" checked> Enable HTTPS (Let's Encrypt)</label></div>
            <button class="btn btn-sm btn-primary" id="tool-proxy-gen"><i class="fas fa-magic"></i> Generate</button>
            <div id="tool-proxy-output" style="margin-top:12px;display:none">
              <textarea id="tool-proxy-labels" class="form-control" rows="10" style="font-family:var(--mono);font-size:12px" readonly></textarea>
              <button class="btn btn-sm btn-secondary" id="tool-proxy-copy" style="margin-top:4px"><i class="fas fa-copy"></i> Copy</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h3><i class="fas fa-robot" style="margin-right:8px"></i>AI Log Analysis</h3></div>
          <div class="card-body">
            <p class="text-sm text-muted" style="margin-bottom:12px">Generate a diagnostic prompt from container logs for ChatGPT/Claude.</p>
            <div class="form-group">
              <label>Container</label>
              <select id="tool-ai-container" class="form-control"><option value="">Loading...</option></select>
            </div>
            <div class="form-group"><label>Log lines (last N)</label><input type="number" id="tool-ai-lines" class="form-control" value="50" min="10" max="200"></div>
            <button class="btn btn-sm btn-primary" id="tool-ai-gen"><i class="fas fa-magic"></i> Generate Prompt</button>
            <div id="tool-ai-output" style="margin-top:12px;display:none">
              <textarea id="tool-ai-prompt" class="form-control" rows="14" style="font-family:var(--mono);font-size:12px" readonly></textarea>
              <button class="btn btn-sm btn-secondary" id="tool-ai-copy" style="margin-top:4px"><i class="fas fa-copy"></i> Copy to Clipboard</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Load containers for AI tool
    Api.getContainers().then(containers => {
      const sel = el.querySelector('#tool-ai-container');
      if (sel) sel.innerHTML = containers.map(c => {
        const name = Utils.containerName(c.Names || c.names);
        return `<option value="${c.Id || c.id}">${Utils.escapeHtml(name)} (${c.State || c.state})</option>`;
      }).join('');
    }).catch(() => {});

    // docker run → Compose converter
    el.querySelector('#tool-run-convert').addEventListener('click', () => {
      const input = el.querySelector('#tool-run-input').value.trim();
      if (!input) { Toast.warning('Paste a docker run command'); return; }
      try {
        const yaml = this._dockerRunToCompose(input);
        el.querySelector('#tool-run-yaml').value = yaml;
        el.querySelector('#tool-run-output').style.display = '';
      } catch (err) { Toast.error('Parse error: ' + err.message); }
    });
    el.querySelector('#tool-run-copy').addEventListener('click', () => {
      Utils.copyToClipboard(el.querySelector('#tool-run-yaml').value);
      Toast.success('Copied!');
    });

    // Proxy label generator
    el.querySelector('#tool-proxy-gen').addEventListener('click', () => {
      const type = el.querySelector('#tool-proxy-type').value;
      const domain = el.querySelector('#tool-proxy-domain').value.trim();
      const port = el.querySelector('#tool-proxy-port').value;
      const tls = el.querySelector('#tool-proxy-tls').checked;
      if (!domain) { Toast.warning('Enter a domain'); return; }
      const labels = this._generateProxyLabels(type, domain, port, tls);
      el.querySelector('#tool-proxy-labels').value = labels;
      el.querySelector('#tool-proxy-output').style.display = '';
    });
    el.querySelector('#tool-proxy-copy').addEventListener('click', () => {
      Utils.copyToClipboard(el.querySelector('#tool-proxy-labels').value);
      Toast.success('Copied!');
    });

    // AI log analysis
    el.querySelector('#tool-ai-gen').addEventListener('click', async () => {
      const containerId = el.querySelector('#tool-ai-container').value;
      const lines = parseInt(el.querySelector('#tool-ai-lines').value) || 50;
      if (!containerId) { Toast.warning('Select a container'); return; }
      try {
        const [logs, inspect] = await Promise.all([
          Api.getContainerLogs(containerId, lines),
          Api.getContainer(containerId),
        ]);
        const name = Utils.containerName(inspect.Name || inspect.name);
        const image = inspect.Config?.Image || inspect.config?.Image || '';
        const state = inspect.State?.Status || inspect.state?.Status || '';
        const exitCode = inspect.State?.ExitCode ?? '';
        const logText = typeof logs === 'string' ? logs : (logs.logs || logs.stdout || '');

        const prompt = `I have a Docker container that needs diagnosis. Please analyze the following information and provide:
1. What the likely issue is
2. Recommended fixes (most likely first)
3. Any preventive measures

**Container:** ${name}
**Image:** ${image}
**State:** ${state}${exitCode !== '' ? ` (exit code: ${exitCode})` : ''}
**Status Message:** ${Utils.containerStatusMessage(state, exitCode)}

**Last ${lines} log lines:**
\`\`\`
${logText.substring(0, 3000)}
\`\`\`

**Container Config:**
- Restart Policy: ${inspect.HostConfig?.RestartPolicy?.Name || 'none'}
- Memory Limit: ${inspect.HostConfig?.Memory ? Utils.formatBytes(inspect.HostConfig.Memory) : 'unlimited'}
- CPU Shares: ${inspect.HostConfig?.CpuShares || 'default'}
- Ports: ${Utils.formatPorts(inspect.NetworkSettings?.Ports ? Object.entries(inspect.NetworkSettings.Ports).map(([k,v]) => ({ private: k.split('/')[0], public: v?.[0]?.HostPort, type: k.split('/')[1] })) : [])}`;

        el.querySelector('#tool-ai-prompt').value = prompt;
        el.querySelector('#tool-ai-output').style.display = '';
      } catch (err) { Toast.error(err.message); }
    });
    el.querySelector('#tool-ai-copy').addEventListener('click', () => {
      Utils.copyToClipboard(el.querySelector('#tool-ai-prompt').value);
      Toast.success('Copied! Paste into ChatGPT or Claude.');
    });
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
              <button class="btn btn-sm btn-warning" onclick="SystemPage._prune('containers')">${i18n.t('pages.system.pruneContainersBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-layer-group"></i> ${i18n.t('pages.system.pruneImages')}</h4>
              <p>${i18n.t('pages.system.pruneImagesDesc')}</p>
              <button class="btn btn-sm btn-warning" onclick="SystemPage._prune('images')">${i18n.t('pages.system.pruneImagesBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-database"></i> ${i18n.t('pages.system.pruneVolumes')}</h4>
              <p>${i18n.t('pages.system.pruneVolumesDesc')}</p>
              <button class="btn btn-sm btn-danger" onclick="SystemPage._prune('volumes')">${i18n.t('pages.system.pruneVolumesBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-network-wired"></i> ${i18n.t('pages.system.pruneNetworks')}</h4>
              <p>${i18n.t('pages.system.pruneNetworksDesc')}</p>
              <button class="btn btn-sm btn-warning" onclick="SystemPage._prune('networks')">${i18n.t('pages.system.pruneNetworksBtn')}</button>
            </div>
            <div class="prune-item">
              <h4><i class="fas fa-broom"></i> ${i18n.t('pages.system.pruneEverything')}</h4>
              <p>${i18n.t('pages.system.pruneEverythingDesc')}</p>
              <button class="btn btn-sm btn-danger" onclick="SystemPage._prune('all')">${i18n.t('pages.system.pruneAllBtn')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    el.querySelector('#prune-help').addEventListener('click', () => this._showPruneHelp());
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

      el.innerHTML = `<table class="data-table">
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
                <th></th>
              </tr></thead>
              <tbody>${schedules.map(s => `
                <tr>
                  <td class="mono text-sm">${Utils.escapeHtml(s.containerName || s.containerId?.substring(0, 12))}</td>
                  <td><span class="badge badge-info">${s.action}</span></td>
                  <td class="mono text-sm">${Utils.escapeHtml(s.cron)}</td>
                  <td><span class="badge ${s.enabled ? 'badge-running' : 'badge-stopped'}">${s.enabled ? i18n.t('common.enabled') : i18n.t('common.disabled')}</span></td>
                  <td>
                    <button class="action-btn danger" data-del-schedule="${s.id}" title="${i18n.t('common.delete')}"><i class="fas fa-trash"></i></button>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>
        </div>
      `;

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
            </select>
          </div>
          <div class="form-group">
            <label>${i18n.t('pages.containers.scheduleCron')}</label>
            <input type="text" id="sched-cron" class="form-control" placeholder="${i18n.t('pages.containers.cronPlaceholder')}">
          </div>
        `, {
          title: i18n.t('pages.containers.scheduleCreate'),
          onSubmit: (content) => {
            const sel = content.querySelector('#sched-container');
            return {
              containerId: sel.value,
              containerName: sel.options[sel.selectedIndex]?.dataset?.name || '',
              action: content.querySelector('#sched-action').value,
              cron: content.querySelector('#sched-cron').value.trim(),
              enabled: true,
            };
          }
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
    `;

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
  },

  destroy() {
    Object.values(this._charts).forEach(c => c.destroy());
    this._charts = {};
  },
};

window.SystemPage = SystemPage;
