/* ═══════════════════════════════════════════════════
   pages/system-backup.js — Backup tab (Local + S3 + pCloud + DB)
   Extracted from system.js v8.2.x further-split.
   1 method: _renderBackup. Includes pCloud connect/test/run/disconnect
   handlers (v8.2.0), S3 config + test + upload (v3.x), local DB backup
   download/restore.
   ═══════════════════════════════════════════════════ */
'use strict';

const SystemPageBackup = {
  _renderBackup(el) {
    el.innerHTML = `
      <section class="card backup-overview">
        <div class="card-header"><h3>Backup and recovery overview</h3><a class="btn btn-sm btn-secondary" href="#/recovery-points">Provider recovery points</a></div>
        <div class="card-body" data-backup-overview aria-live="polite">Loading backup inventory…</div>
      </section>
      ${App.user?.role === 'admin' || App.user?.roles?.includes('admin')
        ? '<section class="card" data-storage-backup aria-label="Storage backup"></section>' : ''}
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

      <div class="card mt-md" id="pcloud-backup-section">
        <div class="card-header">
          <h3><i class="fas fa-cloud" style="margin-right:8px"></i>pCloud Backup (v8.2.0)</h3>
        </div>
        <div class="card-body">
          <p class="text-muted mb-md">Push the daily DB backup, weekly stack bundles, and monthly audit log dumps to a pCloud account (free tier 10 GB, EU data center by default).</p>
          <div id="pcloud-status" style="margin-bottom:16px"></div>
          <div id="pcloud-connect-form" style="display:none">
            <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:700px">
              <div class="form-group">
                <label>pCloud username (email)</label>
                <input type="text" id="pcloud-username" class="form-control" placeholder="you@example.com" autocomplete="off">
              </div>
              <div class="form-group">
                <label>Password</label>
                <input type="password" id="pcloud-password" class="form-control" placeholder="••••••••" autocomplete="new-password">
              </div>
              <div class="form-group">
                <label>Region</label>
                <select id="pcloud-region" class="form-control">
                  <option value="eu" selected>EU (Switzerland)</option>
                  <option value="us">US</option>
                </select>
              </div>
            </div>
            <div style="margin-top:12px">
              <button class="btn btn-sm btn-primary" id="pcloud-connect-btn"><i class="fas fa-plug"></i> Connect & Test</button>
            </div>
            <p class="text-muted text-sm" style="margin-top:8px">Username and password are exchanged for a long-lived auth token; the password is not stored.</p>
          </div>
          <div id="pcloud-config-form" style="display:none">
            <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;max-width:900px">
              <div class="form-group">
                <label>DB schedule (cron)</label>
                <input type="text" id="pcloud-sched-db" class="form-control" placeholder="0 3 * * *">
              </div>
              <div class="form-group">
                <label>Stack archive (cron)</label>
                <input type="text" id="pcloud-sched-stack" class="form-control" placeholder="0 4 * * 0">
              </div>
              <div class="form-group">
                <label>Audit dump (cron)</label>
                <input type="text" id="pcloud-sched-audit" class="form-control" placeholder="5 4 1 * *">
              </div>
              <div class="form-group">
                <label>Keep DB backups</label>
                <input type="number" id="pcloud-keep-db" class="form-control" min="1" value="7">
              </div>
              <div class="form-group">
                <label>Keep stack weeks</label>
                <input type="number" id="pcloud-keep-stack" class="form-control" min="1" value="8">
              </div>
              <div class="form-group">
                <label>Keep audit months</label>
                <input type="number" id="pcloud-keep-audit" class="form-control" min="1" value="24">
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
              <button class="btn btn-sm btn-primary" id="pcloud-save-btn"><i class="fas fa-save"></i> Save</button>
              <button class="btn btn-sm btn-secondary" id="pcloud-test-btn"><i class="fas fa-plug"></i> Refresh quota</button>
              <button class="btn btn-sm btn-secondary" id="pcloud-run-db"><i class="fas fa-database"></i> Run DB now</button>
              <button class="btn btn-sm btn-secondary" id="pcloud-run-stacks"><i class="fas fa-layer-group"></i> Run stacks now</button>
              <button class="btn btn-sm btn-secondary" id="pcloud-run-audit"><i class="fas fa-clipboard-list"></i> Run audit now</button>
              <button class="btn btn-sm btn-danger" id="pcloud-disconnect-btn" style="margin-left:auto"><i class="fas fa-unlink"></i> Disconnect</button>
            </div>
            <p class="text-muted text-sm" style="margin-top:8px">Schedule changes take effect after a restart of Docker Dash.</p>
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

    this._loadBackupOverview(el.querySelector('[data-backup-overview]'));
    void StorageBackupPanel.render(el.querySelector('[data-storage-backup]'));

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

    // ─── pCloud Backup (v8.2.0) ─────────────────────────
    const renderPcloud = async () => {
      try {
        const status = await Api.get('/system/backup/pcloud/status');
        const statusEl = el.querySelector('#pcloud-status');
        const connectForm = el.querySelector('#pcloud-connect-form');
        const configForm = el.querySelector('#pcloud-config-form');

        if (!status.configured) {
          statusEl.innerHTML = '<span class="text-muted">Not connected — enter pCloud credentials to enable.</span>';
          connectForm.style.display = '';
          configForm.style.display = 'none';
          return;
        }

        const lb = status.lastBackup || {};
        const fmtBackup = (label, b) => {
          if (!b?.at) return `<div><strong>${label}:</strong> <span class="text-muted">never run</span></div>`;
          const cls = b.status === 'success' ? 'badge-running' : 'badge-stopped';
          return `<div><strong>${label}:</strong> <span class="badge ${cls}">${b.status}</span> ${Utils.timeAgo(b.at)}${b.error ? ' <span class="text-red">' + Utils.escapeHtml(b.error) + '</span>' : ''}</div>`;
        };

        const quota = status.quota || {};
        const quotaPct = quota.pct != null ? quota.pct.toFixed(1) + '%' : '?';
        const quotaBar = quota.total
          ? `<div style="background:var(--card-border);height:8px;border-radius:4px;overflow:hidden;margin:8px 0">
               <div style="background:${quota.pct > 90 ? 'var(--red)' : 'var(--accent)'};width:${Math.min(quota.pct || 0, 100)}%;height:100%"></div>
             </div>
             <small class="text-muted">${Utils.formatBytes(quota.used || 0)} of ${Utils.formatBytes(quota.total)} used (${quotaPct})</small>`
          : '<small class="text-muted">Quota not yet checked.</small>';

        statusEl.innerHTML = `
          <div><strong>Connected as:</strong> ${Utils.escapeHtml(status.email || '-')} (${status.region?.toUpperCase()})</div>
          ${quotaBar}
          <div style="margin-top:12px">
            ${fmtBackup('DB', lb.db)}
            ${fmtBackup('Stacks', lb.stack)}
            ${fmtBackup('Audit', lb.audit)}
          </div>
        `;

        connectForm.style.display = 'none';
        configForm.style.display = '';
        el.querySelector('#pcloud-sched-db').value = status.schedules?.db || '';
        el.querySelector('#pcloud-sched-stack').value = status.schedules?.stack || '';
        el.querySelector('#pcloud-sched-audit').value = status.schedules?.audit || '';
        el.querySelector('#pcloud-keep-db').value = status.keep?.db || 7;
        el.querySelector('#pcloud-keep-stack').value = status.keep?.stackWeeks || 8;
        el.querySelector('#pcloud-keep-audit').value = status.keep?.auditMonths || 24;
      } catch (err) {
        const statusEl = el.querySelector('#pcloud-status');
        if (statusEl) statusEl.innerHTML = `<span class="text-red">${Utils.escapeHtml(err.message || 'Status load failed')}</span>`;
      }
    };

    renderPcloud();

    el.querySelector('#pcloud-connect-btn')?.addEventListener('click', async () => {
      const username = el.querySelector('#pcloud-username').value.trim();
      const password = el.querySelector('#pcloud-password').value;
      const region = el.querySelector('#pcloud-region').value;
      if (!username || !password) { Toast.error('Username and password required'); return; }
      try {
        Toast.info('Connecting to pCloud...');
        await Api.post('/system/backup/pcloud/connect', { username, password, region });
        Toast.success('Connected to pCloud');
        el.querySelector('#pcloud-password').value = '';
        await renderPcloud();
      } catch (err) { Toast.error('Connect failed: ' + err.message); }
    });

    el.querySelector('#pcloud-disconnect-btn')?.addEventListener('click', async () => {
      const ok = await Modal.confirm('Disconnect pCloud? Existing backups in pCloud are kept.', { danger: true });
      if (!ok) return;
      try {
        await Api.post('/system/backup/pcloud/disconnect');
        Toast.success('Disconnected');
        await renderPcloud();
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#pcloud-test-btn')?.addEventListener('click', async () => {
      try {
        Toast.info('Refreshing pCloud quota...');
        await Api.post('/system/backup/pcloud/test');
        Toast.success('Quota refreshed');
        await renderPcloud();
      } catch (err) { Toast.error('Test failed: ' + err.message); }
    });

    el.querySelector('#pcloud-save-btn')?.addEventListener('click', async () => {
      try {
        await Api.put('/system/backup/pcloud/config', {
          schedules: {
            db: el.querySelector('#pcloud-sched-db').value.trim(),
            stack: el.querySelector('#pcloud-sched-stack').value.trim(),
            audit: el.querySelector('#pcloud-sched-audit').value.trim(),
          },
          keep: {
            db: parseInt(el.querySelector('#pcloud-keep-db').value, 10),
            stackWeeks: parseInt(el.querySelector('#pcloud-keep-stack').value, 10),
            auditMonths: parseInt(el.querySelector('#pcloud-keep-audit').value, 10),
          },
        });
        Toast.success('pCloud configuration saved (restart to apply schedule changes)');
        await renderPcloud();
      } catch (err) { Toast.error(err.message); }
    });

    el.querySelector('#pcloud-run-db')?.addEventListener('click', async () => {
      try {
        Toast.info('Uploading DB to pCloud...');
        const r = await Api.post('/system/backup/pcloud/run/db');
        Toast.success(`DB uploaded: ${r.file} (${Utils.formatBytes(r.size)})`);
        await renderPcloud();
      } catch (err) { Toast.error('DB upload failed: ' + err.message); }
    });

    el.querySelector('#pcloud-run-stacks')?.addEventListener('click', async () => {
      try {
        Toast.info('Archiving stacks to pCloud...');
        const r = await Api.post('/system/backup/pcloud/run/stacks');
        Toast.success(`Archived ${r.succeeded}/${r.stacks} stacks (${r.failed} failed)`);
        await renderPcloud();
      } catch (err) { Toast.error('Stack archive failed: ' + err.message); }
    });

    el.querySelector('#pcloud-run-audit')?.addEventListener('click', async () => {
      try {
        Toast.info('Dumping previous month audit log...');
        const r = await Api.post('/system/backup/pcloud/run/audit');
        Toast.success(`Audit dump uploaded: ${r.yearMonth} (${r.rows} rows, ${Utils.formatBytes(r.gzBytes)} gz)`);
        await renderPcloud();
      } catch (err) { Toast.error('Audit dump failed: ' + err.message); }
    });

    // Database backup from backup tab
    el.querySelector('#db-backup-tab-btn')?.addEventListener('click', async () => {
      try {
        Toast.info('Creating backup...');
        const result = await Api.post('/backup/database');
        if (result.ok) {
          Toast.success('Backup created: ' + Utils.formatBytes(result.size));
          await this._loadBackupOverview(el.querySelector('[data-backup-overview]'));
        } else Toast.error('Backup failed');
      } catch (err) { Toast.error(err.message); }
    });

    const fileInput = el.querySelector('#restore-file');
    el.querySelector('#restore-btn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      e.target.value = '';
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const plan = await Api.post('/system/backup/restore/plan?hostId=0', data);
        const escape = Utils.escapeHtml;
        const keys = (label, values) => values.length ? `<details><summary>${label} · ${values.length}</summary>
          <ul class="bulk-plan-rows">${values.map(value => `<li class="mono">${escape(value)}</li>`).join('')}</ul></details>` : '';
        const ok = await Modal.confirm(`
          <p><strong>Destination</strong> · Docker Dash at ${escape(location.origin)}</p>
          <p>${escape(file.name)} · exported by version ${escape(plan.version)}</p>
          ${keys('New settings', plan.creates)}${keys('Settings to overwrite', plan.replaces)}
          <p>${plan.unchanged} settings already match. The configuration import skips ${plan.apiKeysSkipped} API key records and ${plan.usersSkipped} user records.</p>
        `, { html: true, danger: true, title: 'Review configuration restore', confirmText: 'Apply reviewed restore', width: '680px' });
        if (!ok) return;
        const result = await Api.post('/system/backup/restore?hostId=0', { ...data, planId: plan.planId });
        const restored = result.restored || {};
        Toast.success(`Restored ${restored.settings || 0} settings and ${restored.apiKeys || 0} API keys`);
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
          <p>Destination · Docker Dash at ${Utils.escapeHtml(location.origin)}</p>
          <p>File size · ${Utils.formatBytes(file.size)}</p>
          <p style="color:var(--red);margin-top:8px"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>
          This will replace ALL current data (containers metadata, audit logs, settings, users, etc.).</p>
          <p class="text-muted text-sm" style="margin-top:8px">A safety backup of the current database will be created automatically before replacing.</p>
          <p style="margin-top:8px"><strong>The application will restart after restore.</strong></p>
        </div>`,
        { danger: true, html: true, title: 'Review database restore', confirmText: 'Replace database', typeToConfirm: 'RESTORE' }
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

  async _loadBackupOverview(root, outcome = null) {
    const requests = await Promise.allSettled([
      Api.get('/system/backup/list?hostId=0'),
      Api.get('/system/backup/s3-status?hostId=0'),
      Api.get('/system/backup/pcloud/status?hostId=0'),
    ]);
    if (!root?.isConnected) return;
    const [local, s3, pcloud] = requests;
    const escape = Utils.escapeHtml;
    const result = entry => entry.status === 'fulfilled' ? entry.value : null;
    const files = result(local)?.files || [];
    const s3Status = result(s3);
    const cloudStatus = result(pcloud);
    const copiesOpen = root.querySelector('[data-local-copies]')?.open;
    const deleteLabel = i18n.t('common.delete');
    const selectLabel = file => `Select ${file.name} (${file.location})`;
    const hasSelectable = files.some(file => file.revision);
    const when = value => value ? escape(new Date(value).toLocaleString()) : 'No backup recorded';
    const status = (name, enabled, schedule, last) => `<tr><td>${name}</td>
      <td>${enabled === undefined ? 'Unavailable' : enabled ? 'Enabled' : 'Disabled'}</td>
      <td class="mono">${escape(schedule || '—')}</td><td>${when(last?.time || last?.at)}${last?.status ? ' · ' + escape(last.status) : ''}</td></tr>`;
    root.innerHTML = `<p class="text-sm text-muted">Application instance · ${escape(location.origin)}</p>
      <div class="file-list-scroll"><table class="data-table compact">
      <thead><tr><th>Destination</th><th>Status</th><th>Schedule</th><th>Last backup</th></tr></thead>
      <tbody>
        ${status('Local database', local.status === 'fulfilled' ? true : undefined, '', { at: files[0]?.created })}
        ${status('S3', s3Status?.enabled, s3Status?.schedule, s3Status?.lastBackup)}
        ${status('pCloud database', cloudStatus?.enabled, cloudStatus?.schedules?.db, cloudStatus?.lastBackup?.db)}
        ${status('pCloud stacks', cloudStatus?.enabled, cloudStatus?.schedules?.stack, cloudStatus?.lastBackup?.stack)}
        ${status('pCloud audit', cloudStatus?.enabled, cloudStatus?.schedules?.audit, cloudStatus?.lastBackup?.audit)}
      </tbody></table></div>
      <details data-local-copies style="margin-top:10px" ${copiesOpen ? 'open' : ''}><summary>Local database copies · ${files.length}</summary>
        ${outcome ? `<div class="text-sm" role="status"><p>${escape(outcome.message)}</p>
          ${outcome.issues?.length ? `<ul>${outcome.issues.map(issue => `<li>${escape(issue.name)} (${escape(issue.location)}) · ${escape(issue.error)}</li>`).join('')}</ul>` : ''}</div>` : ''}
        ${hasSelectable ? `<div class="page-actions" style="margin-top:10px">
          <span class="text-sm text-muted" data-local-copy-count aria-live="polite">0 selected</span>
          <button type="button" class="btn btn-sm btn-danger" data-delete-local-selected disabled>Delete selected</button>
        </div>` : ''}
        ${files.length ? `<div class="file-list-scroll"><table class="data-table compact"><thead><tr>
          ${hasSelectable ? '<th><input type="checkbox" data-select-all-local-copies aria-label="Select all local database copies"></th>' : ''}
          <th>Copy</th><th>Location</th><th>Size</th><th>Modified</th><th>${escape(i18n.t('common.actions'))}</th></tr></thead>
          <tbody>${files.map((file, index) => `<tr>${hasSelectable ? `<td>${file.revision
            ? `<input type="checkbox" data-select-local-copy="${index}" aria-label="${escape(selectLabel(file))}">` : ''}</td>` : ''}
          <td class="mono">${escape(file.name)}${file.encrypted ? ' <span class="badge">Encrypted</span>' : ''}</td>
          <td>${escape(file.location || 'local')}</td><td>${Utils.formatBytes(file.size)}</td><td>${when(file.created)}</td>
          <td>${file.revision ? `<button type="button" class="btn btn-sm btn-danger" data-delete-local-copy="${index}"
            aria-label="${escape(deleteLabel + ' ' + file.name + ' (' + file.location + ')')}">${escape(deleteLabel)}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
          : `<p class="text-muted">${local.status === 'fulfilled' ? 'No local copies available.' : 'Local copies could not be loaded.'}</p>`}</details>`;

    const buttons = [...root.querySelectorAll('[data-delete-local-copy]')];
    const checks = [...root.querySelectorAll('[data-select-local-copy]')];
    const selectAll = root.querySelector('[data-select-all-local-copies]');
    const bulkButton = root.querySelector('[data-delete-local-selected]');
    const count = root.querySelector('[data-local-copy-count]');
    if (!bulkButton) return;

    const selectedCopies = () => checks.filter(check => check.checked).map(check => files[Number(check.dataset.selectLocalCopy)]);
    const updateSelection = () => {
      const selected = selectedCopies().length;
      count.textContent = `${selected} selected`;
      selectAll.checked = selected === checks.length;
      selectAll.indeterminate = selected > 0 && !selectAll.checked;
      bulkButton.disabled = selected === 0;
    };
    checks.forEach(check => check.addEventListener('change', updateSelection));
    selectAll.addEventListener('change', () => {
      checks.forEach(check => { check.checked = selectAll.checked; });
      updateSelection();
    });

    const deleteCopies = async (copies, trigger, bulk) => {
      if (!copies.length) return;
      const controls = [bulkButton, selectAll, ...checks, ...buttons];
      controls.forEach(control => { control.disabled = true; });
      try {
        const [file] = copies;
        const message = bulk
          ? `<p>Permanently delete ${copies.length} selected database ${copies.length === 1 ? 'copy' : 'copies'}?</p>
            <ul style="max-height:240px;overflow:auto">${copies.map(copy => `<li><strong>${escape(copy.name)}</strong> (${escape(copy.location)})</li>`).join('')}</ul>`
          : `Permanently delete ${file.name} (${file.location})?`;
        const confirmed = await Modal.confirm(message, {
          danger: true, confirmText: bulk ? 'Delete selected' : deleteLabel, html: bulk,
        });
        if (!confirmed) return;
        if (bulk) {
          const result = await Api.delete('/system/backup/local/bulk?hostId=0', {
            copies: copies.map(({ name, location, revision }) => ({ name, location, revision })),
          });
          const deleted = result.deleted.length;
          const outcome = result.failed.length
            ? { message: `${deleted} of ${copies.length} copies deleted.`, issues: result.failed } : null;
          if (!outcome) Toast.success(deleted === 1 ? 'Local database copy deleted' : `${deleted} local database copies deleted`);
          await this._loadBackupOverview(root, outcome);
        } else {
          const selection = [file.location, file.name].map(encodeURIComponent).join('/');
          await Api.delete(`/system/backup/local/${selection}?hostId=0`, { revision: file.revision });
          Toast.success('Local database copy deleted');
          await this._loadBackupOverview(root);
        }
      } catch (error) {
        Toast.error(error.message);
        if (bulk || error.status === 404 || error.status === 409) {
          await this._loadBackupOverview(root, { message: error.message, issues: error.body?.conflicts });
        }
      } finally {
        controls.forEach(control => { control.disabled = false; });
        updateSelection();
        if (trigger.isConnected) trigger.focus();
        else root.querySelector('[data-local-copies] summary')?.focus();
      }
    };
    buttons.forEach(button => button.addEventListener('click', () => {
      void deleteCopies([files[Number(button.dataset.deleteLocalCopy)]], button, false);
    }));
    bulkButton.addEventListener('click', () => { void deleteCopies(selectedCopies(), bulkButton, true); });
  },

};

if (typeof window !== 'undefined') window.SystemPageBackup = SystemPageBackup;
