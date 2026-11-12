/* ═══════════════════════════════════════════════════
   pages/system-cis.js — CIS Docker Benchmark tab + helpers

   Extracted from system.js in the v8.2.x further-split refactor.
   18 automated CIS Docker Benchmark checks, scored report with
   per-finding remediation guidance, container-scoped drill-down.

   3 methods: _renderCisBenchmark / _cisContainerRemediation /
   _cisBenchmarkGuide. Merged into SystemPage at module load via
   Object.assign at the bottom of system.js.
   ═══════════════════════════════════════════════════ */
'use strict';

const SystemPageCis = {
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
              ${!passAll ? `<div style="margin-top:12px;text-align:right;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
                ${item.containerId ? `<button class="btn btn-sm btn-primary cis-remediate-btn" data-container-id="${Utils.escapeHtml(item.containerId)}" data-container-name="${Utils.escapeHtml(item.title)}" style="font-size:11px" title="Open Remediation Wizard for this container"><i class="fas fa-tools" style="margin-right:5px"></i>Fix with Wizard</button>` : ''}
                ${item.containerId && item.stack ? `<button class="btn btn-sm btn-secondary cis-remediate-stack-btn" data-stack="${Utils.escapeHtml(item.stack)}" style="font-size:11px" title="Remediate whole stack"><i class="fas fa-cubes" style="margin-right:5px"></i>Stack</button>` : ''}
                <button class="btn btn-sm btn-accent cis-hardened-btn" data-container="${Utils.escapeHtml(item.title)}" style="font-size:11px"><i class="fas fa-shield-alt" style="margin-right:5px"></i>Generate CIS-hardened compose</button>
              </div>` : ''}
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

    // Remediation Wizard — container entry point
    el.querySelector('#cis-container-panel').addEventListener('click', (e) => {
      const fixBtn = e.target.closest('.cis-remediate-btn');
      if (fixBtn) {
        if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
        RemediateWizard.open({
          scope: { type: 'container', id: fixBtn.dataset.containerId, hostId: Api.getHostId(), displayName: fixBtn.dataset.containerName },
        });
        return;
      }
      const stackBtn = e.target.closest('.cis-remediate-stack-btn');
      if (stackBtn) {
        if (typeof RemediateWizard === 'undefined') { Toast.error('Remediation Wizard not loaded'); return; }
        RemediateWizard.open({
          scope: { type: 'stack', name: stackBtn.dataset.stack, hostId: Api.getHostId(), displayName: 'stack: ' + stackBtn.dataset.stack },
        });
        return;
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
      <a ${Utils.externalLinkAttributes(r.doc)} style="margin-left:8px;font-size:10px;color:var(--accent)"><i class="fas fa-external-link-alt"></i> docs</a>
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
};

if (typeof window !== 'undefined') window.SystemPageCis = SystemPageCis;
