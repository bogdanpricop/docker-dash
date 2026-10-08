/* ═══════════════════════════════════════════════════
   pages/system-secrets.js — Secrets Audit + Rotations
   Extracted from system.js v8.2.x further-split.
   2 methods: _renderSecretsAudit / _renderSecretRotations.
   ═══════════════════════════════════════════════════ */
'use strict';

const SystemPageSecrets = {
  async _renderSecretsAudit(rootEl) {
    // NOTE: `rootEl` is the outer container (held by the page). Do NOT reassign
    // it — the subtab click handler's closure captures this variable, and if
    // it points at the inner sub-content div, subsequent clicks render the
    // tab bar INSIDE the inner div (tabs duplicate).
    const activeSub = this._secretsSubtab || 'audit';
    const tabBar = '<div style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--border)">'
      + '<button class="secrets-subtab-btn" data-sub="audit" style="padding:8px 14px;border:none;background:none;cursor:pointer;border-bottom:2px solid ' + (activeSub === 'audit' ? 'var(--accent)' : 'transparent') + ';color:' + (activeSub === 'audit' ? 'var(--text-bright)' : 'var(--text-dim)') + ';font-weight:' + (activeSub === 'audit' ? '600' : '400') + '"><i class="fas fa-shield-alt" style="margin-right:6px"></i>Audit &amp; Wizard</button>'
      + '<button class="secrets-subtab-btn" data-sub="rotation" style="padding:8px 14px;border:none;background:none;cursor:pointer;border-bottom:2px solid ' + (activeSub === 'rotation' ? 'var(--accent)' : 'transparent') + ';color:' + (activeSub === 'rotation' ? 'var(--text-bright)' : 'var(--text-dim)') + ';font-weight:' + (activeSub === 'rotation' ? '600' : '400') + '"><i class="fas fa-sync-alt" style="margin-right:6px"></i>Rotation Tracker</button>'
      + '<button class="secrets-subtab-btn" data-sub="certs" style="padding:8px 14px;border:none;background:none;cursor:pointer;border-bottom:2px solid ' + (activeSub === 'certs' ? 'var(--accent)' : 'transparent') + ';color:' + (activeSub === 'certs' ? 'var(--text-bright)' : 'var(--text-dim)') + ';font-weight:' + (activeSub === 'certs' ? '600' : '400') + '"><i class="fas fa-certificate" style="margin-right:6px"></i>Certificates</button>'
      + '</div><div id="secrets-sub-content"></div>';
    rootEl.innerHTML = tabBar;
    rootEl.querySelectorAll('.secrets-subtab-btn').forEach(btn => btn.addEventListener('click', () => {
      this._secretsSubtab = btn.dataset.sub;
      this._renderSecretsAudit(rootEl);
    }));

    const sub = rootEl.querySelector('#secrets-sub-content');
    if (activeSub === 'rotation') return this._renderSecretRotations(sub);
    if (activeSub === 'certs') return this._renderCertificates(sub);

    sub.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Scanning containers for secret hygiene...</div>';
    // Render the audit view INTO sub; use a local `el` alias for the rest of
    // the function to minimize diff vs. original code.
    const el = sub;

    try {
      const data = await Api.getSecretsAudit();
      const scoreColor = data.avgScore >= 80 ? 'var(--green)' : data.avgScore >= 50 ? 'var(--yellow)' : 'var(--red)';

      el.innerHTML = `
        <div class="card" style="margin-bottom:16px;border-left:4px solid var(--accent)">
          <div class="card-body" style="display:flex;align-items:center;gap:16px;padding:14px 18px">
            <i class="fas fa-magic" style="font-size:32px;color:var(--accent)"></i>
            <div style="flex:1">
              <div style="font-weight:700;font-size:15px">Secrets Setup Wizard</div>
              <div class="text-sm text-muted">Paste your .env file → auto-classify secrets → generate setup script + docker-compose secrets block</div>
            </div>
            <button class="btn btn-primary" id="secrets-wizard-btn"><i class="fas fa-rocket"></i> Launch Wizard</button>
          </div>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
          <div class="card" style="padding:14px;text-align:center;min-width:120px;flex:1">
            <div style="font-size:28px;font-weight:700;color:${scoreColor}">${data.avgScore}</div>
            <div class="text-sm text-muted">Security Score</div>
          </div>
          <div class="card" style="padding:14px;text-align:center;min-width:120px;flex:1">
            <div style="font-size:28px;font-weight:700;color:var(--red)">${data.criticalCount}</div>
            <div class="text-sm text-muted">Critical Issues</div>
          </div>
          <div class="card" style="padding:14px;text-align:center;min-width:120px;flex:1">
            <div style="font-size:28px;font-weight:700;color:var(--yellow)">${data.warningCount}</div>
            <div class="text-sm text-muted">Warnings</div>
          </div>
          <div class="card" style="padding:14px;text-align:center;min-width:120px;flex:1">
            <div style="font-size:28px;font-weight:700;color:var(--text)">${data.total}</div>
            <div class="text-sm text-muted">Containers Scanned</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h3><i class="fas fa-shield-alt" style="margin-right:8px;color:var(--accent)"></i>Container Secret Hygiene</h3></div>
          <div class="card-body" style="padding:0;overflow-x:auto">
            <table class="data-table compact" style="width:100%">
              <thead><tr>
                <th>Container</th>
                <th>Score</th>
                <th>Secret Mounts</th>
                <th>_FILE Pattern</th>
                <th>Plain Secrets</th>
                <th>Issues</th>
                <th>Actions</th>
              </tr></thead>
              <tbody>
                ${data.containers.map(c => {
                  const sColor = c.score >= 80 ? 'var(--green)' : c.score >= 50 ? 'var(--yellow)' : 'var(--red)';
                  const issuesHtml = c.issues.length > 0 ? c.issues.map(i => {
                    const iColor = i.severity === 'critical' ? 'var(--red)' : i.severity === 'warning' ? 'var(--yellow)' : 'var(--text-dim)';
                    return '<div style="padding:4px 0;font-size:11px;border-top:1px dashed var(--border)"><span class="badge" style="font-size:9px;background:' + iColor + '22;color:' + iColor + '">' + i.severity.toUpperCase() + '</span> ' + Utils.escapeHtml(i.message) + '<br><span class="text-muted" style="font-size:10px;margin-left:8px"><i class="fas fa-wrench" style="margin-right:3px"></i>' + Utils.escapeHtml(i.fix) + '</span></div>';
                  }).join('') : '<span class="text-muted text-sm">No issues</span>';

                  const remediateBtn = c.issues.length > 0
                    ? '<button class="btn btn-xs btn-primary remediate-btn" data-container-id="' + Utils.escapeHtml(c.id) + '" data-container-name="' + Utils.escapeHtml(c.name) + '" title="Open Remediation Wizard"><i class="fas fa-tools"></i> Fix</button>'
                    + (c.stack ? ' <button class="btn btn-xs btn-secondary remediate-stack-btn" data-stack="' + Utils.escapeHtml(c.stack) + '" title="Remediate whole stack"><i class="fas fa-cubes"></i></button>' : '')
                    : '<span class="text-muted text-sm">—</span>';

                  return '<tr>'
                    + '<td><div style="font-weight:600">' + Utils.escapeHtml(c.name) + '</div><div class="text-xs text-muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + Utils.escapeHtml(c.image) + '</div>' + (c.stack ? '<div class="text-xs" style="color:var(--accent)"><i class="fas fa-cubes"></i> ' + Utils.escapeHtml(c.stack) + '</div>' : '') + '</td>'
                    + '<td><strong style="color:' + sColor + ';font-size:14px">' + c.score + '</strong></td>'
                    + '<td>' + (c.secretMounts > 0 ? '<span style="color:var(--green)"><i class="fas fa-check"></i> ' + c.secretMounts + '</span>' : '<span class="text-muted">0</span>') + '</td>'
                    + '<td>' + (c.filePatternVars > 0 ? '<span style="color:var(--green)">' + c.filePatternVars + '</span>' : '<span class="text-muted">0</span>') + '</td>'
                    + '<td>' + (c.plainSecrets > 0 ? '<span style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ' + c.plainSecrets + '</span>' : '<span style="color:var(--green)">0</span>') + '</td>'
                    + '<td style="max-width:400px">' + (c.issues.length > 0 ? '<details><summary style="cursor:pointer;font-size:12px">' + c.issues.length + ' issue(s)</summary>' + issuesHtml + '</details>' : '<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Clean</span>') + '</td>'
                    + '<td>' + remediateBtn + '</td>'
                    + '</tr>';
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-header"><h3><i class="fas fa-clipboard-check" style="margin-right:8px;color:var(--green)"></i>Pre-Deploy Validation</h3></div>
          <div class="card-body">
            <p class="text-muted text-sm" style="margin-bottom:12px">Paste your <code>.env</code> and/or <code>docker-compose.yml</code> to validate before deploying. Checks for: unfilled placeholders, plain-text secrets, missing health checks, resource limits, and security options.</p>
            <div class="form-row">
              <div class="form-group" style="flex:1">
                <label>.env file content</label>
                <textarea id="validate-env" class="form-control" rows="8" placeholder="APP_SECRET=my-secret&#10;DB_PASSWORD_FILE=/run/secrets/db_pass&#10;..." style="font-family:var(--mono);font-size:11px"></textarea>
              </div>
              <div class="form-group" style="flex:1">
                <label>docker-compose.yml content</label>
                <textarea id="validate-compose" class="form-control" rows="8" placeholder="services:&#10;  app:&#10;    image: myapp&#10;    restart: unless-stopped&#10;    ..." style="font-family:var(--mono);font-size:11px"></textarea>
              </div>
            </div>
            <button class="btn btn-sm btn-primary" id="validate-deploy-btn"><i class="fas fa-check-circle"></i> Run Validation</button>
            <div id="validate-results" style="margin-top:12px"></div>
          </div>
        </div>
      `;

      el.querySelector('#validate-deploy-btn')?.addEventListener('click', async () => {
        const envContent = el.querySelector('#validate-env')?.value || '';
        const composeContent = el.querySelector('#validate-compose')?.value || '';
        if (!envContent && !composeContent) { Toast.warning('Paste at least one file to validate'); return; }

        const resultsEl = el.querySelector('#validate-results');
        resultsEl.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Validating...</div>';

        try {
          const data = await Api.validateDeploy({ envContent, composeContent });
          const checks = data.checks || [];
          resultsEl.innerHTML = '<div style="display:flex;gap:12px;margin-bottom:12px;font-size:13px">'
            + '<span style="color:var(--green)"><i class="fas fa-check-circle"></i> ' + data.summary.passed + ' passed</span>'
            + '<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ' + data.summary.failed + ' failed</span>'
            + '<span style="color:var(--yellow)"><i class="fas fa-exclamation-triangle"></i> ' + data.summary.warned + ' warnings</span>'
            + '</div>'
            + checks.map(c => {
                const icon = c.status === 'pass' ? '<i class="fas fa-check-circle" style="color:var(--green)"></i>' : c.status === 'fail' ? '<i class="fas fa-times-circle" style="color:var(--red)"></i>' : c.status === 'warn' ? '<i class="fas fa-exclamation-triangle" style="color:var(--yellow)"></i>' : '<i class="fas fa-info-circle" style="color:var(--accent)"></i>';
                return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">' + icon + '<div style="flex:1"><strong style="font-size:12px">' + Utils.escapeHtml(c.name) + '</strong><div class="text-sm text-muted" style="margin-top:2px">' + Utils.escapeHtml(c.details) + '</div></div></div>';
              }).join('');
        } catch (err) {
          resultsEl.innerHTML = '<div style="color:var(--red)">' + err.message + '</div>';
        }
      });

      el.querySelector('#secrets-wizard-btn')?.addEventListener('click', async () => {
        // FIX #32 — run openssl preflight before opening wizard; default to allow on failure
        let preflightOk = true;
        try {
          const pf = await Api.secretsWizardPreflight();
          if (pf && pf.openssl === false) preflightOk = false;
        } catch (_) { /* network/backend not ready — allow wizard to open */ }

        if (!preflightOk) {
          // Show a non-blocking warning banner above the wizard card and still open wizard
          const existingBanner = el.querySelector('#wz-openssl-banner');
          if (!existingBanner) {
            const banner = document.createElement('div');
            banner.id = 'wz-openssl-banner';
            banner.style.cssText = 'background:var(--yellow-bg,rgba(234,179,8,.12));border:1px solid var(--yellow,#ca8a04);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;display:flex;align-items:center;gap:10px';
            banner.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:var(--yellow,#ca8a04);flex-shrink:0"></i>'
              + '<span>\u26a0 Certificate features (CSR generation, PEM parsing) require <code>openssl</code> in the runtime image. Wizard is still functional for script generation.</span>';
            el.querySelector('.card')?.before(banner);
          }
        }
        this._showSecretsWizard();
      });
    } catch (err) {
      el.innerHTML = '<div class="empty-msg is-error">Error: ' + err.message + '</div>';
    }

    // Remediate Wizard entry points on Secrets Audit rows
    el.querySelectorAll('.remediate-btn').forEach(btn => btn.addEventListener('click', () => {
      if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
      RemediateWizard.open({
        scope: { type: 'container', id: btn.dataset.containerId, hostId: Api.getHostId(), displayName: btn.dataset.containerName },
      });
    }));
    el.querySelectorAll('.remediate-stack-btn').forEach(btn => btn.addEventListener('click', () => {
      if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
      RemediateWizard.open({
        scope: { type: 'stack', name: btn.dataset.stack, hostId: Api.getHostId(), displayName: 'stack: ' + btn.dataset.stack },
      });
    }));
  },

  _showSecretsWizard() {
    // Multi-step wizard: 1) Paste env, 2) Review classified, 3) Fill provider values, 4) Download script + compose
    let state = {
      step: 1,
      envContent: '',
      appName: 'myapp',
      secretDir: '/etc/myapp/secrets',
      analysis: null,
      providerValues: {},
    };

    const render = () => {
      const steps = ['Paste .env', 'Review & Classify', 'Provider Secrets', 'Download'];
      const stepBar = steps.map((label, i) => {
        const num = i + 1;
        const isActive = num === state.step;
        const isDone = num < state.step;
        const color = isDone ? 'var(--green)' : isActive ? 'var(--accent)' : 'var(--surface3)';
        const textColor = isActive ? 'var(--text-bright)' : isDone ? 'var(--text)' : 'var(--text-dim)';
        return '<div style="flex:1;display:flex;align-items:center;gap:6px">'
          + '<span style="width:26px;height:26px;border-radius:50%;background:' + color + ';color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">' + (isDone ? '✓' : num) + '</span>'
          + '<span style="font-size:12px;color:' + textColor + ';font-weight:' + (isActive ? '700' : '500') + '">' + label + '</span>'
          + (num < steps.length ? '<span style="flex:1;height:1px;background:var(--border);margin:0 4px"></span>' : '')
          + '</div>';
      }).join('');

      let content = '';
      if (state.step === 1) {
        content = '<div class="form-row">'
          + '<div class="form-group" style="flex:1"><label>App Name</label><input id="wz-appname" class="form-control" value="' + Utils.escapeHtml(state.appName) + '" placeholder="myapp"></div>'
          + '<div class="form-group" style="flex:2"><label>Secrets Directory on Host</label><input id="wz-secretdir" class="form-control" value="' + Utils.escapeHtml(state.secretDir) + '" placeholder="/etc/myapp/secrets"></div>'
          + '</div>'
          + '<div class="form-group"><label>Paste your .env file content</label>'
          + '<textarea id="wz-env" class="form-control" rows="16" placeholder="APP_ENV=live&#10;MSSQL_PASSWORD_FILE=/run/secrets/mssql_password_live&#10;JWT_SIGNING_KEY_FILE=/run/secrets/jwt_signing_key_live&#10;MS_CLIENT_SECRET_FILE=/run/secrets/ms_client_secret_live&#10;..." style="font-family:var(--mono);font-size:11px">' + Utils.escapeHtml(state.envContent) + '</textarea>'
          + '<p class="text-sm text-muted" style="margin-top:6px"><i class="fas fa-info-circle"></i> The wizard scans for <code>*_FILE=/run/secrets/*</code> entries and <code>&lt;TODO_*&gt;</code> placeholders.</p>'
          + '</div>';
      } else if (state.step === 2 && state.analysis) {
        const a = state.analysis;
        const actionColors = { generate: 'var(--green)', provider: 'var(--yellow)', upload: 'var(--accent)', inline: 'var(--purple, #a371f7)', 'ssh-keyscan': 'var(--yellow)', manual: 'var(--red)' };
        const actionLabels = { generate: 'Auto-Generate', provider: 'Manual Paste', upload: 'Upload File', inline: 'Replace Inline', 'ssh-keyscan': 'ssh-keyscan', manual: 'Manual' };

        content = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px">'
          + '<div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700">' + a.summary.total + '</div><div class="text-sm text-muted">Total Items</div></div>'
          + '<div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700;color:var(--green)">' + a.summary.generate + '</div><div class="text-sm text-muted">Auto-Generate</div></div>'
          + '<div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700;color:var(--yellow)">' + a.summary.provider + '</div><div class="text-sm text-muted">Provider</div></div>'
          + '<div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700;color:var(--accent)">' + a.summary.upload + '</div><div class="text-sm text-muted">Upload</div></div>'
          + '<div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700;color:var(--red)">' + a.summary.unknown + '</div><div class="text-sm text-muted">Unknown</div></div>'
          + '</div>';

        content += '<div class="card"><div class="card-header"><h3>Secret Files (' + a.secretFiles.length + ')</h3></div><div class="card-body" style="padding:0;overflow-x:auto">';
        content += '<table class="data-table compact"><thead><tr><th>Env Key</th><th>Secret Name</th><th>Type</th><th>Action</th><th>Details</th></tr></thead><tbody>';
        a.secretFiles.forEach(s => {
          const color = actionColors[s.action] || 'var(--text-dim)';
          const badge = '<span class="badge" style="background:' + color + '22;color:' + color + ';font-size:10px">' + (actionLabels[s.action] || s.action) + '</span>';
          const details = s.action === 'generate' ? '<code style="font-size:10px">' + Utils.escapeHtml(s.generator || '') + '</code>' : (s.provider || s.label);
          content += '<tr><td><code style="font-size:11px">' + Utils.escapeHtml(s.envKey) + '</code></td>'
            + '<td class="mono text-sm">' + Utils.escapeHtml(s.secretName) + '</td>'
            + '<td class="text-sm">' + Utils.escapeHtml(s.label) + '</td>'
            + '<td>' + badge + '</td>'
            + '<td class="text-sm text-muted" style="max-width:400px">' + details + '</td></tr>';
        });
        content += '</tbody></table></div></div>';

        if (a.todoPlaceholders.length > 0) {
          content += '<div class="card" style="margin-top:12px"><div class="card-header"><h3>Inline Placeholders (' + a.todoPlaceholders.length + ')</h3></div><div class="card-body" style="padding:0"><table class="data-table compact"><thead><tr><th>Env Key</th><th>Placeholder</th><th>Action</th></tr></thead><tbody>';
          a.todoPlaceholders.forEach(s => {
            content += '<tr><td><code style="font-size:11px">' + Utils.escapeHtml(s.envKey) + '</code></td>'
              + '<td class="mono text-sm" style="color:var(--yellow)">' + Utils.escapeHtml(s.placeholder) + '</td>'
              + '<td class="text-sm text-muted">' + Utils.escapeHtml(s.provider || s.label) + '</td></tr>';
          });
          content += '</tbody></table></div></div>';
        }
      } else if (state.step === 3) {
        const providerSecrets = state.analysis.secretFiles.filter(s => s.action === 'provider');
        if (providerSecrets.length === 0) {
          content = '<div class="empty-msg"><i class="fas fa-check-circle" style="color:var(--green);font-size:32px"></i><p>No provider-issued secrets detected. All values will be auto-generated.</p><p class="text-muted text-sm">Click Next to download the setup script.</p></div>';
        } else {
          content = '<p class="text-muted text-sm" style="margin-bottom:12px"><i class="fas fa-lock" style="margin-right:4px;color:var(--yellow)"></i>Paste provider-issued values below. They will be embedded base64-encoded in the script. Leave blank to get manual instructions only.</p>';
          providerSecrets.forEach(s => {
            const val = state.providerValues[s.envKey] || '';
            content += '<div class="form-group">'
              + '<label><strong>' + Utils.escapeHtml(s.envKey) + '</strong> <span class="text-sm text-muted">— ' + Utils.escapeHtml(s.label) + '</span></label>'
              + '<div class="text-sm text-muted" style="margin-bottom:4px">' + Utils.escapeHtml(s.provider || '') + '</div>'
              + '<input type="password" class="form-control wz-provider-input" data-key="' + Utils.escapeHtml(s.envKey) + '" value="' + Utils.escapeHtml(val) + '" placeholder="Paste value (or leave blank for manual)" style="font-family:var(--mono);font-size:12px">'
              + '</div>';
          });
        }
      } else if (state.step === 4) {
        const genCount = state.analysis.secretFiles.filter(s => s.action === 'generate').length;
        const hostOpts = (state.hosts || []).map(h => '<option value="' + h.id + '">' + Utils.escapeHtml(h.name) + ' (' + Utils.escapeHtml(h.host || 'local') + ')</option>').join('');
        content = '<div class="empty-msg" style="padding:20px"><i class="fas fa-check-circle" style="color:var(--green);font-size:48px;margin-bottom:12px"></i>'
          + '<h3 style="margin:0 0 8px">Ready to Deploy</h3>'
          + '<p class="text-muted">Download the files, run via SSH, or execute remotely from Docker Dash.</p></div>'
          + '<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:16px">'
          + '<button class="btn btn-primary" id="wz-download-script"><i class="fas fa-download"></i> Download setup-secrets.sh</button>'
          + '<button class="btn btn-primary" id="wz-download-compose"><i class="fas fa-download"></i> Download compose-secrets.yml</button>'
          + '<button class="btn btn-secondary" id="wz-copy-script"><i class="fas fa-copy"></i> Copy Script</button>'
          + '</div>'
          + '<div class="card" style="margin-top:16px;border-left:4px solid var(--accent)"><div class="card-header"><h3><i class="fas fa-bolt" style="margin-right:6px;color:var(--accent)"></i>Remote Deploy via SSH</h3></div><div class="card-body">'
          + '<p class="text-sm text-muted" style="margin-bottom:10px">' + Utils.escapeHtml(i18n.t('common.remoteSecretExecution')) + '</p>'
          + '<div class="form-row">'
          + '<div class="form-group" style="flex:1"><label>Target Host</label><select id="wz-remote-host" class="form-control"><option value="">— choose SSH host —</option>' + hostOpts + '</select></div>'
          + '<div class="form-group" style="flex:1"><label>Run as sudo</label><select id="wz-remote-sudo" class="form-control"><option value="1" selected>Yes (recommended)</option><option value="0">No</option></select></div>'
          + '</div>'
          + '<button class="btn btn-primary" id="wz-remote-deploy"><i class="fas fa-play"></i> Deploy to Remote Host</button>'
          + '<div id="wz-remote-log" style="margin-top:12px;display:none;background:#111;color:#eee;padding:10px;border-radius:4px;font-family:var(--mono);font-size:11px;max-height:280px;overflow:auto;white-space:pre-wrap"></div>'
          + '</div></div>'
          + '<div class="card" style="margin-top:16px;border-left:4px solid var(--green)"><div class="card-header"><h3><i class="fas fa-sync-alt" style="margin-right:6px;color:var(--green)"></i>Track for Rotation</h3></div><div class="card-body">'
          + '<p class="text-sm text-muted" style="margin-bottom:10px">Register these secrets with Docker Dash to get reminders before they expire. Rotation intervals are per-classifier (90–365 days).</p>'
          + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="wz-track-rotation" checked> Track ' + state.analysis.secretFiles.length + ' secrets for rotation</label>'
          + '<div class="form-row" style="margin-top:10px">'
          + '<div class="form-group" style="flex:1"><label>Track on Host</label><select id="wz-track-host" class="form-control"><option value="0">This Docker Dash instance</option>' + hostOpts + '</select></div>'
          + '</div>'
          + '<button class="btn btn-sm btn-success" id="wz-register-rotation"><i class="fas fa-check"></i> Register for Tracking</button>'
          + '<span id="wz-rotation-feedback" style="margin-left:10px;font-size:12px"></span>'
          + '</div></div>'
          + '<div class="card" style="margin-top:16px"><div class="card-header"><h3>Next Steps</h3></div><div class="card-body">'
          + '<ol style="padding-left:20px;line-height:1.8">'
          + '<li>Upload <code>setup-secrets.sh</code> to your Docker host (or use <strong>Remote Deploy</strong> above)</li>'
          + '<li>Run: <code>sudo bash setup-secrets.sh</code></li>'
          + '<li>Complete any MANUAL/UPLOAD steps shown in the output</li>'
          + '<li>Append <code>compose-secrets.yml</code> content to your <code>docker-compose.yml</code></li>'
          + '<li>Add <code>secrets:</code> block to each service that needs the secret</li>'
          + '<li>Run: <code>docker compose up -d</code></li>'
          + '<li>Record deployment in your password manager; rotation reminders will appear in the <strong>Secrets → Rotation Tracker</strong> tab</li>'
          + '</ol></div></div>';
      }

      const footer = '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:16px">'
        + (state.step > 1 ? '<button class="btn btn-secondary" id="wz-back"><i class="fas fa-arrow-left"></i> Back</button>' : '<div></div>')
        + '<div>'
        + (state.step < 4 ? '<button class="btn btn-primary" id="wz-next">Next <i class="fas fa-arrow-right"></i></button>' : '<button class="btn btn-primary" id="wz-close-done">Done</button>')
        + '</div></div>';

      Modal.open('<div class="modal-header"><h3><i class="fas fa-magic" style="margin-right:8px;color:var(--accent)"></i>Secrets Wizard</h3><button class="modal-close-btn" id="wz-close"><i class="fas fa-times"></i></button></div>'
        + '<div class="modal-body" style="max-height:75vh;overflow-y:auto">'
        + '<div style="display:flex;gap:4px;margin-bottom:20px">' + stepBar + '</div>'
        + content
        + footer
        + '</div>', { width: '900px' });

      const mc = Modal._content;
      mc.querySelector('#wz-close')?.addEventListener('click', () => Modal.close());
      mc.querySelector('#wz-close-done')?.addEventListener('click', () => Modal.close());

      mc.querySelector('#wz-back')?.addEventListener('click', () => { state.step--; render(); });

      mc.querySelector('#wz-next')?.addEventListener('click', async () => {
        if (state.step === 1) {
          const envContent = mc.querySelector('#wz-env')?.value?.trim() || '';
          if (!envContent) { Toast.warning('Paste your .env content first'); return; }
          state.envContent = envContent;
          state.appName = mc.querySelector('#wz-appname')?.value?.trim() || 'myapp';
          state.secretDir = mc.querySelector('#wz-secretdir')?.value?.trim() || ('/etc/' + state.appName + '/secrets');
          try {
            state.analysis = await Api.analyzeSecretsWizard(envContent);
            if (state.analysis.secretFiles.length === 0 && state.analysis.todoPlaceholders.length === 0) {
              Toast.warning('No secrets detected — check .env format');
              return;
            }
            state.step++;
            render();
          } catch (err) { Toast.error(err.message); }
        } else if (state.step === 2) {
          state.step++;
          render();
        } else if (state.step === 3) {
          mc.querySelectorAll('.wz-provider-input').forEach(input => {
            const key = input.dataset.key;
            const val = input.value;
            if (val) state.providerValues[key] = val;
          });
          state.step++;
          render();
        }
      });

      mc.querySelector('#wz-download-script')?.addEventListener('click', async () => {
        try {
          const script = await Api.generateSecretsScript({
            appName: state.appName,
            secretDir: state.secretDir,
            secretFiles: state.analysis.secretFiles,
            providerValues: state.providerValues,
          });
          const blob = new Blob([script], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'setup-secrets.sh';
          a.click();
          Toast.success('Script downloaded');
        } catch (err) { Toast.error(err.message); }
      });

      mc.querySelector('#wz-download-compose')?.addEventListener('click', async () => {
        try {
          const yaml = await Api.generateSecretsCompose({
            appName: state.appName,
            secretDir: state.secretDir,
            secretFiles: state.analysis.secretFiles,
          });
          const blob = new Blob([yaml], { type: 'text/yaml' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'compose-secrets.yml';
          a.click();
          Toast.success('Compose snippet downloaded');
        } catch (err) { Toast.error(err.message); }
      });

      mc.querySelector('#wz-copy-script')?.addEventListener('click', async () => {
        try {
          const script = await Api.generateSecretsScript({
            appName: state.appName,
            secretDir: state.secretDir,
            secretFiles: state.analysis.secretFiles,
            providerValues: state.providerValues,
          });
          await Utils.copyToClipboard(script);
          Toast.success('Script copied to clipboard');
        } catch (err) { Toast.error(err.message); }
      });

      mc.querySelector('#wz-register-rotation')?.addEventListener('click', async () => {
        try {
          const feedback = mc.querySelector('#wz-rotation-feedback');
          const hostId = Number(mc.querySelector('#wz-track-host')?.value || 0);
          const tracked = mc.querySelector('#wz-track-rotation')?.checked;
          if (!tracked) { Toast.warning('Tracking disabled — check the box first'); return; }
          feedback.textContent = 'Checking existing tracked secrets...';
          feedback.style.color = 'var(--text-muted)';

          // FIX #25 — warn if secrets for this app+host are already tracked
          let forceUpdateIntervals = false;
          try {
            const existing = await Api.getSecretRotations();
            const matches = (existing || []).filter(r => r.app_name === state.appName && Number(r.host_id) === hostId);
            if (matches.length > 0) {
              const answer = await new Promise(resolve => {
                const msg = matches.length + ' secret' + (matches.length === 1 ? ' is' : 's are')
                  + ' already tracked for this app. Update display labels (preserve intervals) or force-update intervals too?';
                const dlg = document.createElement('div');
                dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
                dlg.innerHTML = '<div style="background:var(--surface2,#1e2433);border:1px solid var(--border,#2a3040);border-radius:10px;padding:24px;max-width:420px;width:90%">'
                  + '<h4 style="margin:0 0 12px"><i class="fas fa-exclamation-triangle" style="color:var(--yellow,#ca8a04);margin-right:8px"></i>Already tracked</h4>'
                  + '<p style="margin:0 0 18px;font-size:13px;color:var(--text-muted)">' + msg + '</p>'
                  + '<div style="display:flex;gap:10px;justify-content:flex-end">'
                  + '<button id="wz-dup-cancel" class="btn btn-secondary btn-sm">Cancel</button>'
                  + '<button id="wz-dup-labels" class="btn btn-secondary btn-sm">Labels only</button>'
                  + '<button id="wz-dup-force" class="btn btn-primary btn-sm">Force-update intervals</button>'
                  + '</div></div>';
                document.body.appendChild(dlg);
                dlg.querySelector('#wz-dup-cancel').addEventListener('click', () => { document.body.removeChild(dlg); resolve(null); });
                dlg.querySelector('#wz-dup-labels').addEventListener('click', () => { document.body.removeChild(dlg); resolve(false); });
                dlg.querySelector('#wz-dup-force').addEventListener('click', () => { document.body.removeChild(dlg); resolve(true); });
              });
              if (answer === null) { feedback.textContent = ''; return; } // cancelled
              forceUpdateIntervals = answer;
            }
          } catch (_) { /* non-fatal — proceed without the check */ }

          feedback.textContent = 'Registering...';
          feedback.style.color = 'var(--text-muted)';
          const res = await Api.registerSecretRotations({
            appName: state.appName,
            hostId,
            force_update_intervals: forceUpdateIntervals,
            secrets: state.analysis.secretFiles.map(s => ({
              envKey: s.envKey, secretName: s.secretName, type: s.type,
              label: s.label, action: s.action, rotation_interval_days: s.rotation || 180,
            })),
          });
          feedback.textContent = '✓ Registered ' + res.count + ' secrets';
          feedback.style.color = 'var(--green)';
          Toast.success('Tracking ' + res.count + ' secrets for rotation');
        } catch (err) { Toast.error(err.message); }
      });

      mc.querySelector('#wz-remote-deploy')?.addEventListener('click', async () => {
        try {
          const hostId = Number(mc.querySelector('#wz-remote-host')?.value || 0);
          const useSudo = mc.querySelector('#wz-remote-sudo')?.value === '1';
          if (!hostId) { Toast.warning('Choose a target host first'); return; }
          const logEl = mc.querySelector('#wz-remote-log');
          logEl.style.display = 'block';
          logEl.textContent = '[*] Generating script...\n';
          const script = await Api.generateSecretsScript({
            appName: state.appName, secretDir: state.secretDir,
            secretFiles: state.analysis.secretFiles, providerValues: state.providerValues,
          });
          logEl.textContent += '[*] Verifying + executing on host ' + hostId + (useSudo ? ' (sudo)' : '') + '...\n';
          const res = await Api.deploySecretsRemote({ hostId, appName: state.appName, secretDir: state.secretDir, script, useSudo });
          logEl.textContent += '\n' + (res.output || '') + '\n\n[' + (res.exitCode === 0 ? '✓ SUCCESS' : '✗ FAILED exit=' + res.exitCode) + ']';
          logEl.scrollTop = logEl.scrollHeight;
          (res.exitCode === 0 ? Toast.success : Toast.error)(res.exitCode === 0 ? 'Remote deploy succeeded' : 'Remote deploy failed (exit ' + res.exitCode + ')');
        } catch (err) {
          const logEl = mc.querySelector('#wz-remote-log');
          if (logEl) { logEl.textContent += '\n[ERROR] ' + err.message; logEl.style.color = 'var(--red)'; }
          Toast.error(err.message);
        }
      });
    };

    // Preload hosts list for step 4
    if (!state.hosts) {
      Api.get('/hosts').then(hs => { state.hosts = (hs || []).filter(h => h.connection_type === 'ssh' || h.connectionType === 'ssh'); }).catch(() => { state.hosts = []; });
    }

    render();
  },

  async _renderSecretRotations(el) {
    el.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading rotation tracker...</div>';
    try {
      const [rows, summary] = await Promise.all([Api.getSecretRotations(), Api.getSecretRotationsSummary()]);
      if (!rows || rows.length === 0) {
        el.innerHTML = '<div class="empty-msg" style="padding:30px"><i class="fas fa-sync-alt" style="font-size:42px;color:var(--text-muted);margin-bottom:10px"></i>'
          + '<h3>No secrets tracked yet</h3>'
          + '<p class="text-muted">Use the Secrets Wizard to classify your <code>.env</code> and register secrets for rotation reminders.</p></div>';
        return;
      }

      const rowHtml = rows.map(r => {
        const statusColor = r.status === 'overdue' ? 'var(--red)' : r.status === 'due_soon' ? 'var(--yellow)' : 'var(--green)';
        const statusLabel = r.status === 'overdue' ? 'OVERDUE' : r.status === 'due_soon' ? 'DUE SOON' : 'OK';
        const daysTxt = r.daysUntilDue < 0 ? Math.abs(r.daysUntilDue) + ' days ago' : r.daysUntilDue + ' days';
        return '<tr>'
          + '<td><div style="font-weight:600;font-size:12px">' + Utils.escapeHtml(r.app_name || '—') + '</div>'
          + '<div class="text-xs text-muted">host ' + r.host_id + '</div></td>'
          + '<td><code style="font-size:11px">' + Utils.escapeHtml(r.env_key) + '</code><div class="text-xs text-muted">' + Utils.escapeHtml(r.label) + '</div></td>'
          + '<td class="text-sm">' + Utils.escapeHtml(r.secret_name) + '</td>'
          + '<td><span class="badge" style="background:' + statusColor + '22;color:' + statusColor + ';font-size:10px">' + statusLabel + '</span></td>'
          + '<td class="text-sm">' + daysTxt + '</td>'
          + '<td class="text-sm text-muted">' + (r.last_rotated_at || '—').replace('T', ' ').substring(0, 16) + '</td>'
          + '<td class="text-sm">' + r.rotation_interval_days + 'd</td>'
          + '<td>'
          + '<button class="btn btn-xs btn-success mark-rotated-btn" data-id="' + r.id + '" title="Mark Rotated"><i class="fas fa-check"></i></button> '
          + '<button class="btn btn-xs btn-secondary edit-rotation-btn" data-id="' + r.id + '" title="Edit interval"><i class="fas fa-cog"></i></button> '
          + '<button class="btn btn-xs btn-danger delete-rotation-btn" data-id="' + r.id + '" title="Untrack"><i class="fas fa-trash"></i></button>'
          + '</td></tr>';
      }).join('');

      el.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">'
        + '<div class="card" style="padding:14px;text-align:center"><div style="font-size:28px;font-weight:700">' + summary.total + '</div><div class="text-sm text-muted">Total Tracked</div></div>'
        + '<div class="card" style="padding:14px;text-align:center"><div style="font-size:28px;font-weight:700;color:var(--green)">' + summary.ok + '</div><div class="text-sm text-muted">OK</div></div>'
        + '<div class="card" style="padding:14px;text-align:center"><div style="font-size:28px;font-weight:700;color:var(--yellow)">' + summary.due_soon + '</div><div class="text-sm text-muted">Due Soon (≤14d)</div></div>'
        + '<div class="card" style="padding:14px;text-align:center"><div style="font-size:28px;font-weight:700;color:var(--red)">' + summary.overdue + '</div><div class="text-sm text-muted">Overdue</div></div>'
        + '</div>'
        + '<div class="card"><div class="card-header"><h3><i class="fas fa-sync-alt" style="margin-right:6px;color:var(--accent)"></i>Tracked Secrets</h3></div>'
        + '<div class="card-body" style="padding:0;overflow-x:auto">'
        + '<table class="data-table compact"><thead><tr><th>App</th><th>Env Key</th><th>Secret</th><th>Status</th><th>Next Due</th><th>Last Rotated</th><th>Interval</th><th>Actions</th></tr></thead>'
        + '<tbody>' + rowHtml + '</tbody></table></div></div>';

      el.querySelectorAll('.mark-rotated-btn').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const notes = prompt('Notes for this rotation (optional)?', '');
        if (notes === null) return;
        try {
          await Api.markSecretRotated(id, notes);
          Toast.success('Marked rotated');
          this._renderSecretRotations(el);
        } catch (err) { Toast.error(err.message); }
      }));
      el.querySelectorAll('.edit-rotation-btn').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const days = prompt('New rotation interval (days)?', '180');
        if (!days) return;
        try {
          await Api.updateSecretRotation(id, { rotation_interval_days: parseInt(days, 10) });
          Toast.success('Interval updated');
          this._renderSecretRotations(el);
        } catch (err) { Toast.error(err.message); }
      }));
      el.querySelectorAll('.delete-rotation-btn').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm('Stop tracking this secret?')) return;
        try {
          await Api.deleteSecretRotation(id);
          Toast.success('Untracked');
          this._renderSecretRotations(el);
        } catch (err) { Toast.error(err.message); }
      }));
    } catch (err) {
      el.innerHTML = '<div class="empty-msg is-error">Error: ' + err.message + '</div>';
    }
  },

};

if (typeof window !== 'undefined') window.SystemPageSecrets = SystemPageSecrets;
