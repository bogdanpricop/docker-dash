/* ═══════════════════════════════════════════════════
   pages/security.js — Vulnerability Scanning & Security
   ═══════════════════════════════════════════════════ */
'use strict';

const SecurityPage = {
  _tab: 'overview',

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-shield-alt"></i> Security</h2>
        ${Api.getHostId() > 0 ? '<span class="badge badge-info" style="margin-left:8px;font-size:11px"><i class="fas fa-server"></i> Remote Host</span>' : ''}
        <div class="page-actions">
          <button class="btn btn-sm btn-primary" id="scan-all-btn">
            <i class="fas fa-search"></i> Scan All Images
          </button>
          <button class="btn btn-sm btn-secondary" id="cis-header-btn" title="CIS Docker Benchmark">
            <i class="fas fa-clipboard-check" style="margin-right:4px"></i> CIS Benchmark
          </button>
          <button class="btn btn-sm btn-secondary" id="sec-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div class="tabs" id="sec-tabs">
        <button class="tab active" data-tab="overview">Overview</button>
        <button class="tab" data-tab="history">Scan History</button>
        <button class="tab" data-tab="scanners">Scanners</button>
      </div>
      <div id="sec-content">Loading...</div>
    `;

    container.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        this._tab = t.dataset.tab;
        this._renderTab();
      });
    });

    container.querySelector('#sec-refresh').addEventListener('click', () => this._renderTab());
    container.querySelector('#scan-all-btn').addEventListener('click', () => this._scanAll());
    container.querySelector('#cis-header-btn').addEventListener('click', () => {
      App.navigate('/system');
      setTimeout(() => document.querySelector('[data-tab="cis"]')?.click(), 350);
    });

    await this._renderTab();
  },

  async _renderTab() {
    const el = document.getElementById('sec-content');
    if (!el) return;
    try {
      if (this._tab === 'overview') await this._renderOverview(el);
      else if (this._tab === 'history') await this._renderHistory(el);
      else if (this._tab === 'scanners') await this._renderScanners(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  async _renderOverview(el) {
    el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading scan data...</div>`;

    const [history, images, scannersData] = await Promise.all([
      Api.get('/images/scan-history?limit=500'),
      Api.getImages(),
      Api.getScanners().catch(() => ({ scanners: [] })),
    ]);

    // Latest scan per image
    const latestByImage = {};
    for (const scan of history) {
      if (!latestByImage[scan.image_name]) latestByImage[scan.image_name] = scan;
    }
    const latestScans = Object.values(latestByImage);

    const totalImages = images.length;
    const scannedImages = latestScans.length;
    const unscannedImages = totalImages - scannedImages;
    const totalCritical = latestScans.reduce((s, r) => s + r.summary_critical, 0);
    const totalHigh = latestScans.reduce((s, r) => s + r.summary_high, 0);
    const totalMedium = latestScans.reduce((s, r) => s + r.summary_medium, 0);
    const totalLow = latestScans.reduce((s, r) => s + r.summary_low, 0);
    const totalVulns = latestScans.reduce((s, r) => s + r.summary_total, 0);
    const totalFixable = latestScans.reduce((s, r) => s + r.fixable_count, 0);

    el.innerHTML = `
      <!-- Summary Cards -->
      <div class="stat-cards" style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <div class="card" style="flex:1;min-width:120px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--accent)">${scannedImages}/${totalImages}</div>
          <div class="text-muted text-sm">Images Scanned</div>
        </div>
        <div class="card" style="flex:1;min-width:120px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:${totalCritical > 0 ? 'var(--red)' : 'var(--green)'}">${totalCritical}</div>
          <div class="text-muted text-sm">Critical</div>
        </div>
        <div class="card" style="flex:1;min-width:120px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:${totalHigh > 0 ? '#f97316' : 'var(--green)'}">${totalHigh}</div>
          <div class="text-muted text-sm">High</div>
        </div>
        <div class="card" style="flex:1;min-width:120px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--text)">${totalMedium + totalLow}</div>
          <div class="text-muted text-sm">Medium + Low</div>
        </div>
        <div class="card" style="flex:1;min-width:120px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--green)">${totalFixable}</div>
          <div class="text-muted text-sm">Fixable</div>
        </div>
      </div>

      ${unscannedImages > 0 ? `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--yellow)">
        <div class="card-body" style="padding:12px 16px">
          <i class="fas fa-exclamation-triangle" style="color:var(--yellow);margin-right:8px"></i>
          <strong>${unscannedImages} image(s)</strong> have not been scanned yet.
          <button class="btn btn-sm btn-warning" style="margin-left:12px" id="sec-scan-all-btn">Scan Now</button>
        </div>
      </div>` : ''}

      <!-- Per-Image Results -->
      <div class="card">
        <div class="card-header"><h3><i class="fas fa-layer-group" style="margin-right:8px"></i>Image Security Status</h3></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead><tr>
              <th style="text-align:left">Image</th>
              <th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>Total</th><th>Fixable</th>
              <th>Last Scan</th><th></th>
            </tr></thead>
            <tbody>
              ${images.map(img => {
                const name = (img.repoTags || [])[0] || '<none>';
                const eName = Utils.escapeHtml(name);
                const scan = latestByImage[name];
                const scanMenu = `<div class="action-btns" style="position:relative">
                  <button class="action-btn scan-menu-trigger" data-image="${eName}" title="Scan"><i class="fas fa-search"></i></button>
                </div>`;
                if (!scan) {
                  return `<tr>
                    <td style="text-align:left" class="mono text-sm">${eName}</td>
                    <td colspan="6" class="text-muted text-sm">Not scanned</td>
                    <td></td>
                    <td>${scanMenu}</td>
                  </tr>`;
                }
                return `<tr>
                  <td style="text-align:left" class="mono text-sm">${eName}</td>
                  <td style="${scan.summary_critical > 0 ? 'color:var(--red);font-weight:700' : ''}">${scan.summary_critical}</td>
                  <td style="${scan.summary_high > 0 ? 'color:#f97316;font-weight:600' : ''}">${scan.summary_high}</td>
                  <td>${scan.summary_medium}</td>
                  <td>${scan.summary_low}</td>
                  <td><strong>${scan.summary_total}</strong></td>
                  <td style="color:var(--green)">${scan.fixable_count}</td>
                  <td class="text-sm text-muted">${Utils.timeAgo(scan.scanned_at)}</td>
                  <td>
                    <div class="action-btns">
                      <button class="action-btn" data-action="view-scan" data-scan-id="${scan.id}" title="View Details"><i class="fas fa-eye"></i></button>
                      <button class="action-btn scan-menu-trigger" data-image="${eName}" title="Re-scan"><i class="fas fa-sync-alt"></i></button>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- CIS Benchmark Card -->
      <div class="card" style="margin-top:16px;border-left:3px solid var(--green,#4ade80)">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <h3 style="margin:0"><i class="fas fa-clipboard-check" style="margin-right:8px;color:var(--green,#4ade80)"></i>CIS Docker Benchmark</h3>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-sm btn-secondary" id="cis-quick-run"><i class="fas fa-play" style="margin-right:4px"></i>Run</button>
            <a href="#/system" id="cis-full-link" style="font-size:12px;color:var(--accent);text-decoration:none" onclick="event.preventDefault();window.location.hash='/system';setTimeout(()=>{document.querySelector('[data-tab=cis]')?.click()},300)">
              View full results <i class="fas fa-arrow-right" style="margin-left:3px"></i>
            </a>
          </div>
        </div>
        <div class="card-body" id="cis-quick-body">
          <div id="cis-quick-result" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
            <div class="text-muted text-sm"><i class="fas fa-info-circle" style="margin-right:5px"></i>Checks Docker daemon and container runtime against CIS security controls. Click Run for a quick score.</div>
          </div>
        </div>
      </div>

      <!-- AI Remediation Card -->
      <div class="card" style="margin-top:16px;border-left:3px solid var(--accent)">
        <div class="card-header">
          <h3><i class="fas fa-robot" style="margin-right:8px;color:var(--accent)"></i>AI-Assisted Remediation</h3>
        </div>
        <div class="card-body">
          <p class="text-muted" style="margin-bottom:12px">If you're using an AI assistant (Claude, ChatGPT, Copilot) for development and deployment, you can paste the following prompt to get automated fix instructions:</p>
          <div style="background:var(--surface2);border-radius:var(--radius-sm);padding:16px;position:relative">
            <button class="btn btn-sm btn-secondary" id="copy-overview-prompt" style="position:absolute;top:8px;right:8px"><i class="fas fa-copy"></i></button>
            <pre id="ai-prompt" class="mono text-sm" style="margin:0;white-space:pre-wrap;color:var(--text)">I have a Docker image "${images[0] ? (images[0].repoTags || ['unknown'])[0] : 'my-image'}" with the following vulnerability scan results:

Critical: ${totalCritical}, High: ${totalHigh}, Medium: ${totalMedium}, Low: ${totalLow}
Total vulnerabilities: ${totalVulns}, Fixable: ${totalFixable}

${latestScans.length > 0 ? 'Top critical/high vulnerabilities:\n' + latestScans.flatMap(s => {
              const scan = latestByImage[s.image_name];
              return scan ? [] : [];
            }).join('') : ''}
Please:
1. Update my Dockerfile to fix all fixable vulnerabilities
2. Add "apk upgrade --no-cache" or "apt-get upgrade -y" as appropriate for the base image
3. Pin specific package versions for any packages with known CVEs
4. Recommend a more secure base image if applicable (e.g., distroless, alpine, slim)
5. Generate a fixed Dockerfile with comments explaining each security change
6. List any vulnerabilities that cannot be fixed and suggest mitigations</pre>
          </div>

          <div style="margin-top:16px">
            <h4 style="font-size:13px;margin-bottom:8px"><i class="fas fa-lightbulb" style="color:var(--yellow);margin-right:6px"></i>Quick AI Commands</h4>
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              <button class="btn btn-sm btn-secondary" data-ai-prompt="dockerfile"><i class="fas fa-file-code"></i> Fix Dockerfile</button>
              <button class="btn btn-sm btn-secondary" data-ai-prompt="compose"><i class="fas fa-layer-group"></i> Fix Compose</button>
              <button class="btn btn-sm btn-secondary" data-ai-prompt="report"><i class="fas fa-file-alt"></i> Generate Report</button>
              <button class="btn btn-sm btn-secondary" data-ai-prompt="ci"><i class="fas fa-code-branch"></i> CI/CD Pipeline</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire copy buttons via addEventListener (not inline onclick)
    el.querySelector('#copy-overview-prompt')?.addEventListener('click', () => {
      const text = document.getElementById('ai-prompt')?.textContent;
      if (text) Utils.copyToClipboard(text).then(() => Toast.success('Copied!'));
    });

    el.querySelectorAll('[data-ai-prompt]').forEach(btn => {
      btn.addEventListener('click', () => this._copyAiPrompt(btn.dataset.aiPrompt));
    });

    // Global handler for data-copy-prev buttons (copy previous sibling text)
    el.querySelectorAll('[data-copy-prev]').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.previousElementSibling?.textContent;
        if (text) Utils.copyToClipboard(text).then(() => Toast.success('Copied!'));
      });
    });

    // CIS quick run
    const cisRunBtn = el.querySelector('#cis-quick-run');
    const cisResultEl = el.querySelector('#cis-quick-result');
    // Restore last result from session if available
    const _cisCache = sessionStorage.getItem('cis-quick-last');
    if (_cisCache) {
      try { cisResultEl.innerHTML = this._cisBriefHtml(JSON.parse(_cisCache)); } catch { /* ignore */ }
    }
    cisRunBtn?.addEventListener('click', async () => {
      cisRunBtn.disabled = true;
      cisRunBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px"></i>Running...';
      cisResultEl.innerHTML = '<span class="text-muted text-sm"><i class="fas fa-spinner fa-spin" style="margin-right:5px"></i>Running benchmark…</span>';
      try {
        const data = await Api.runCisBenchmark();
        sessionStorage.setItem('cis-quick-last', JSON.stringify(data));
        cisResultEl.innerHTML = this._cisBriefHtml(data);
      } catch (err) {
        cisResultEl.innerHTML = `<span class="text-muted text-sm" style="color:var(--red)"><i class="fas fa-exclamation-triangle" style="margin-right:5px"></i>${Utils.escapeHtml(err.message)}</span>`;
      } finally {
        cisRunBtn.disabled = false;
        cisRunBtn.innerHTML = '<i class="fas fa-sync-alt" style="margin-right:4px"></i>Run Again';
      }
    });

    // Scan All button
    el.querySelector('#sec-scan-all-btn')?.addEventListener('click', () => this._scanAll());

    // View scan detail buttons
    el.querySelectorAll('[data-action="view-scan"]').forEach(btn => {
      btn.addEventListener('click', () => this._viewScanDetail(parseInt(btn.dataset.scanId)));
    });

    // Scan menu dropdowns
    el.querySelectorAll('.scan-menu-trigger').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showScanDropdown(e, btn.dataset.image);
      });
    });
  },

  _showScanDropdown(event, imageName) {
    document.querySelectorAll('.scan-context-menu').forEach(m => m.remove());

    const rect = event.currentTarget.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'scan-context-menu';
    menu.innerHTML = `
      <div class="scan-menu-item" data-scanner="auto"><i class="fas fa-magic" style="width:16px;text-align:center"></i> Auto-detect</div>
      <div class="scan-menu-item" data-scanner="trivy"><i class="fas fa-search" style="width:16px;text-align:center"></i> Trivy</div>
      <div class="scan-menu-item" data-scanner="grype"><i class="fas fa-shield-alt" style="width:16px;text-align:center"></i> Grype</div>
      <div class="scan-menu-item" data-scanner="docker-scout"><i class="fab fa-docker" style="width:16px;text-align:center"></i> Docker Scout</div>
    `;
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = (rect.left - 120) + 'px';
    menu.style.zIndex = '9999';

    menu.querySelectorAll('.scan-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        menu.remove();
        this._scanImageWithScanner(imageName, item.dataset.scanner);
      });
    });

    document.body.appendChild(menu);
    const close = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close, true); }
    };
    setTimeout(() => document.addEventListener('click', close, true), 10);
  },

  async _scanImageWithScanner(imageName, scanner) {
    Toast.info(`Scanning ${imageName} with ${scanner}...`);
    try {
      await Api.scanImage(encodeURIComponent(imageName), scanner);
      Toast.success(`Scan complete for ${imageName}`);
      this._renderTab();
    } catch (err) {
      Toast.error(err.message);
    }
  },

  _historyData: [],
  _historyView: 'list',
  _historyFilter: '',

  async _renderHistory(el) {
    if (!this._historyData.length) {
      el.innerHTML = `<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;
      this._historyData = await Api.get('/images/scan-history?limit=500');
    }

    const history = this._historyData;

    if (history.length === 0) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-shield-alt"></i><p>No scan history yet. Run a scan from the Images page.</p></div>`;
      return;
    }

    const isGrouped = this._historyView !== 'list';

    el.innerHTML = `
      <div class="card">
        <div class="card-header" style="flex-wrap:wrap;gap:8px">
          <h3 style="margin:0">Scan History</h3>
          <div style="display:flex;align-items:center;gap:6px;flex:1;justify-content:flex-end;flex-wrap:wrap">
            <div class="search-box" style="min-width:160px;max-width:220px">
              <i class="fas fa-search"></i>
              <input type="text" id="hist-search" placeholder="Filter..." value="${Utils.escapeHtml(this._historyFilter)}" style="padding:4px 8px 4px 28px;font-size:12px">
            </div>
            <div class="btn-group" style="display:flex;gap:2px">
              <button class="btn btn-sm ${this._historyView === 'list' ? 'btn-primary' : 'btn-secondary'}" data-view="list" title="List view"><i class="fas fa-list"></i></button>
              <button class="btn btn-sm ${this._historyView === 'image' ? 'btn-primary' : 'btn-secondary'}" data-view="image" title="Group by image"><i class="fas fa-layer-group"></i></button>
              <button class="btn btn-sm ${this._historyView === 'scanner' ? 'btn-primary' : 'btn-secondary'}" data-view="scanner" title="Group by scanner"><i class="fas fa-search"></i></button>
              <button class="btn btn-sm ${this._historyView === 'date' ? 'btn-primary' : 'btn-secondary'}" data-view="date" title="Group by date"><i class="fas fa-calendar"></i></button>
            </div>
            ${isGrouped ? `
              <button class="btn btn-sm btn-secondary" id="hist-expand-all" title="Expand all"><i class="fas fa-expand-arrows-alt"></i></button>
              <button class="btn btn-sm btn-secondary" id="hist-collapse-all" title="Collapse all"><i class="fas fa-compress-arrows-alt"></i></button>
            ` : ''}
            <button class="btn btn-sm btn-secondary" id="hist-refresh" title="Refresh"><i class="fas fa-sync-alt"></i></button>
          </div>
        </div>
        <div class="card-body" style="padding:0" id="hist-body"></div>
      </div>
    `;

    // Wire toolbar
    el.querySelector('#hist-search').addEventListener('input', Utils.debounce(e => {
      this._historyFilter = e.target.value;
      this._renderHistoryBody();
    }, 200));

    el.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._historyView = btn.dataset.view;
        this._renderHistory(el);
      });
    });

    el.querySelector('#hist-refresh')?.addEventListener('click', async () => {
      this._historyData = await Api.get('/images/scan-history?limit=500');
      this._renderHistory(el);
    });

    el.querySelector('#hist-expand-all')?.addEventListener('click', () => {
      document.querySelectorAll('.hist-group-body').forEach(b => b.style.display = '');
      document.querySelectorAll('.hist-group-toggle').forEach(i => { if (i) i.className = 'fas fa-chevron-down hist-group-toggle'; });
    });

    el.querySelector('#hist-collapse-all')?.addEventListener('click', () => {
      document.querySelectorAll('.hist-group-body').forEach(b => b.style.display = 'none');
      document.querySelectorAll('.hist-group-toggle').forEach(i => { if (i) i.className = 'fas fa-chevron-right hist-group-toggle'; });
    });

    this._renderHistoryBody();
  },

  _renderHistoryBody() {
    const body = document.getElementById('hist-body');
    if (!body) return;

    const filter = this._historyFilter.toLowerCase();
    const filtered = this._historyData.filter(r =>
      !filter || r.image_name.toLowerCase().includes(filter) || r.scanner.toLowerCase().includes(filter)
    );

    if (filtered.length === 0) {
      body.innerHTML = `<div class="empty-msg">No results match "${Utils.escapeHtml(this._historyFilter)}"</div>`;
      return;
    }

    if (this._historyView === 'list') {
      body.innerHTML = this._renderHistoryTable(filtered);
      body.querySelectorAll('[data-action="view-scan"]').forEach(btn => {
        btn.addEventListener('click', () => this._viewScanDetail(parseInt(btn.dataset.scanId)));
      });
      return;
    }

    // Grouped views
    const groups = {};
    for (const r of filtered) {
      let key;
      if (this._historyView === 'image') key = r.image_name;
      else if (this._historyView === 'scanner') key = r.scanner;
      else key = (r.scanned_at || '').substring(0, 10); // date: YYYY-MM-DD
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    const groupIcon = this._historyView === 'image' ? 'fa-layer-group' : this._historyView === 'scanner' ? 'fa-search' : 'fa-calendar-day';

    body.innerHTML = Object.entries(groups).map(([key, items]) => {
      const totalC = items.reduce((s, r) => s + r.summary_critical, 0);
      const totalH = items.reduce((s, r) => s + r.summary_high, 0);
      const totalAll = items.reduce((s, r) => s + r.summary_total, 0);
      const sevBadge = totalC > 0 ? 'color:var(--red)' : totalH > 0 ? 'color:#f97316' : totalAll > 0 ? 'color:var(--yellow)' : 'color:var(--green)';

      return `
        <div class="hist-group" style="border-bottom:1px solid var(--border)">
          <div class="hist-group-header" style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none">
            <i class="fas fa-chevron-down hist-group-toggle" style="width:12px;font-size:11px;color:var(--text-muted)"></i>
            <i class="fas ${groupIcon}" style="color:var(--accent);width:16px;text-align:center"></i>
            <strong style="flex:1;font-size:13px">${Utils.escapeHtml(key)}</strong>
            <span class="text-sm text-muted">${items.length} scan${items.length > 1 ? 's' : ''}</span>
            <span class="text-sm" style="${sevBadge};font-weight:600">${totalAll} vulns</span>
            <button class="action-btn danger hist-group-delete" data-ids="${items.map(r => r.id).join(',')}" data-name="${Utils.escapeHtml(key)}" title="Delete group" style="margin-left:4px"><i class="fas fa-trash"></i></button>
          </div>
          <div class="hist-group-body">
            ${this._renderHistoryTable(items)}
          </div>
        </div>`;
    }).join('');

    // Wire view-scan buttons in all group tables
    body.querySelectorAll('[data-action="view-scan"]').forEach(btn => {
      btn.addEventListener('click', () => this._viewScanDetail(parseInt(btn.dataset.scanId)));
    });

    // Toggle groups
    body.querySelectorAll('.hist-group-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.hist-group-delete')) return;
        const groupBody = header.nextElementSibling;
        const icon = header.querySelector('.hist-group-toggle');
        if (!groupBody) return;
        if (groupBody.style.display === 'none') {
          groupBody.style.display = '';
          if (icon) icon.className = 'fas fa-chevron-down hist-group-toggle';
        } else {
          groupBody.style.display = 'none';
          if (icon) icon.className = 'fas fa-chevron-right hist-group-toggle';
        }
      });
    });

    // Delete group
    body.querySelectorAll('.hist-group-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ids = btn.dataset.ids.split(',').map(Number);
        const name = btn.dataset.name;
        const ok = await Modal.confirm(
          `Delete <strong>${ids.length}</strong> scan result(s) for <strong>${Utils.escapeHtml(name)}</strong>?`,
          { danger: true, confirmText: 'Delete' }
        );
        if (!ok) return;
        try {
          await Api.post('/images/scan-history/delete', { ids });
          Toast.success(`${ids.length} scan result(s) deleted`);
          this._historyData = this._historyData.filter(r => !ids.includes(r.id));
          this._scanIds = this._scanIds.filter(id => !ids.includes(id));
          this._renderHistoryBody();
        } catch (err) { Toast.error(err.message); }
      });
    });
  },

  _renderHistoryTable(rows) {
    return `<table class="data-table">
      <thead><tr>
        <th style="text-align:left">Image</th>
        <th>Scanner</th>
        <th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>Total</th>
        <th>Fixable</th>
        <th>Scanned At</th>
        <th></th>
      </tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(r.image_name)}</td>
          <td><span class="badge badge-info">${Utils.escapeHtml(r.scanner)}</span></td>
          <td style="${r.summary_critical > 0 ? 'color:var(--red);font-weight:700' : ''}">${r.summary_critical}</td>
          <td style="${r.summary_high > 0 ? 'color:#f97316;font-weight:600' : ''}">${r.summary_high}</td>
          <td>${r.summary_medium}</td>
          <td>${r.summary_low}</td>
          <td><strong>${r.summary_total}</strong></td>
          <td style="color:var(--green)">${r.fixable_count}</td>
          <td class="text-sm">${Utils.formatDate(r.scanned_at)}</td>
          <td><button class="action-btn" data-action="view-scan" data-scan-id="${r.id}" title="View Details"><i class="fas fa-eye"></i></button></td>
        </tr>
      `).join('')}</tbody>
    </table>`;
  },

  async _renderScanners(el) {
    const data = await Api.getScanners();
    const scanners = data.scanners || [];

    const scoutNotAuth = scanners.some(s => s.includes('not authenticated'));

    el.innerHTML = `
      <div class="info-grid">
        <div class="card">
          <div class="card-header"><h3><i class="fas fa-tools" style="margin-right:8px"></i>Available Scanners</h3></div>
          <div class="card-body">
            <!-- Trivy -->
            <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid var(--border)">
              <div style="width:40px;height:40px;border-radius:8px;background:rgba(14,165,233,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas fa-search" style="font-size:18px;color:#0ea5e9"></i>
              </div>
              <div style="flex:1">
                <div style="font-weight:600;font-size:14px">Trivy</div>
                <div class="text-sm text-muted" style="margin:2px 0 6px">Open-source vulnerability scanner by Aqua Security. Scans OS packages, language dependencies, IaC misconfigs, and secrets.</div>
                <div style="display:flex;gap:12px;flex-wrap:wrap">
                  <a href="https://trivy.dev" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fas fa-home" style="margin-right:4px"></i>trivy.dev</a>
                  <a href="https://github.com/aquasecurity/trivy" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fab fa-github" style="margin-right:4px"></i>GitHub</a>
                  <a href="https://aquasecurity.github.io/trivy/latest/" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fas fa-book" style="margin-right:4px"></i>Documentation</a>
                </div>
              </div>
              <span class="badge badge-running" style="flex-shrink:0">${scanners.some(s => s === 'trivy') ? '<i class="fas fa-check" style="margin-right:4px"></i>Ready' : 'Not Installed'}</span>
            </div>

            <!-- Grype -->
            <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 0">
              <div style="width:40px;height:40px;border-radius:8px;background:rgba(168,85,247,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas fa-shield-alt" style="font-size:18px;color:#a855f7"></i>
              </div>
              <div style="flex:1">
                <div style="font-weight:600;font-size:14px">Grype <span class="text-muted text-sm" style="font-weight:400">by Anchore</span></div>
                <div class="text-sm text-muted" style="margin:2px 0 6px">Open-source vulnerability scanner. Fast scanning against multiple databases (NVD, GitHub Advisories, Alpine SecDB, etc.). No authentication required.</div>
                <div style="display:flex;gap:12px;flex-wrap:wrap">
                  <a href="https://github.com/anchore/grype" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fab fa-github" style="margin-right:4px"></i>GitHub</a>
                  <a href="https://github.com/anchore/grype#readme" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fas fa-book" style="margin-right:4px"></i>Documentation</a>
                </div>
              </div>
              <span class="badge ${scanners.some(s => s === 'grype') ? 'badge-running' : 'badge-stopped'}" style="flex-shrink:0">${scanners.some(s => s === 'grype') ? '<i class="fas fa-check" style="margin-right:4px"></i>Ready' : 'Not Installed'}</span>
            </div>
            ${!scanners.some(s => s === 'grype') ? `
            <div style="padding:12px 0 6px">
              <details style="cursor:pointer">
                <summary style="font-size:13px;font-weight:600;color:var(--accent)"><i class="fas fa-wrench" style="margin-right:6px"></i>How to install Grype</summary>
                <div style="margin-top:10px;padding:12px 16px;background:var(--surface2);border-radius:var(--radius-sm);font-size:12px">
                  <p class="text-muted" style="margin:0 0 10px"><strong>Option 1: Docker (recommended)</strong> — rebuild the Docker Dash image:</p>
                  <pre class="mono" style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px;margin:0 0 14px;overflow-x:auto;font-size:11px;color:var(--text)">docker compose build --no-cache
docker compose up -d</pre>
                  <p class="text-muted" style="margin:0 0 10px"><strong>Option 2: Install into running container</strong> (temporary, lost on restart):</p>
                  <pre class="mono" style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px;margin:0 0 14px;overflow-x:auto;font-size:11px;color:var(--text)">docker exec -u root docker-dash sh -c '\\
  wget -qO /tmp/grype.tar.gz \\
    https://github.com/anchore/grype/releases/download/v0.92.0/grype_0.92.0_linux_amd64.tar.gz \\
  && tar -xzf /tmp/grype.tar.gz -C /usr/local/bin grype \\
  && chmod +x /usr/local/bin/grype \\
  && rm -f /tmp/grype.tar.gz'</pre>
                  <p class="text-muted" style="margin:0 0 10px"><strong>Option 3: Native install</strong> (Linux/macOS, if running without Docker):</p>
                  <pre class="mono" style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px;margin:0 0 14px;overflow-x:auto;font-size:11px;color:var(--text)"># One-line install (official script)
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin

# Or via Homebrew (macOS/Linux)
brew install grype

# Verify installation
grype version</pre>
                  <p class="text-muted" style="margin:0 0 6px"><strong>First scan note:</strong> Grype downloads its vulnerability database (~150MB) on the first scan. This is a one-time operation and takes 1-2 minutes. Subsequent scans are fast.</p>
                  <p class="text-muted" style="margin:0"><i class="fas fa-sync-alt" style="margin-right:4px"></i>After installing, refresh this page to see the updated status.</p>
                </div>
              </details>
            </div>` : ''}

            <div style="border-top:1px solid var(--border);margin:4px 0"></div>

            <!-- Docker Scout -->
            <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 0">
              <div style="width:40px;height:40px;border-radius:8px;background:rgba(56,139,253,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fab fa-docker" style="font-size:18px;color:#388bfd"></i>
              </div>
              <div style="flex:1">
                <div style="font-weight:600;font-size:14px">Docker Scout</div>
                <div class="text-sm text-muted" style="margin:2px 0 6px">Docker's official image analysis tool. Provides vulnerability detection, base image recommendations, and supply chain insights.</div>
                <div style="display:flex;gap:12px;flex-wrap:wrap">
                  <a href="https://docs.docker.com/scout/" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fas fa-home" style="margin-right:4px"></i>docs.docker.com/scout</a>
                  <a href="https://github.com/docker/scout-cli" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fab fa-github" style="margin-right:4px"></i>GitHub</a>
                  <a href="https://hub.docker.com" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;text-decoration:none"><i class="fab fa-docker" style="margin-right:4px"></i>Docker Hub</a>
                </div>
              </div>
              <span class="badge ${scoutNotAuth ? 'badge-warning' : scanners.some(s => s === 'docker-scout') ? 'badge-running' : 'badge-stopped'}" style="flex-shrink:0">${scoutNotAuth ? '<i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>Not Authenticated' : scanners.some(s => s === 'docker-scout') ? '<i class="fas fa-check" style="margin-right:4px"></i>Ready' : 'Not Installed'}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h3><i class="fas fa-info-circle" style="margin-right:8px"></i>About Scanning</h3></div>
          <div class="card-body">
            <p class="text-muted text-sm" style="margin-bottom:12px">Vulnerability scanning checks Docker images for known security issues (CVEs) in OS packages and application dependencies.</p>
            <table class="info-table">
              <tr><td>Trivy</td><td>Free, no authentication needed. Scans OS packages + language dependencies. <strong>Recommended.</strong></td></tr>
              <tr><td>Grype</td><td>Free, no authentication needed. Fast scanning by Anchore against multiple vulnerability databases (NVD, GitHub Advisories, etc.).</td></tr>
              <tr><td>Docker Scout</td><td>Requires Docker Hub account. Provides supply chain insights and base image recommendations.</td></tr>
              <tr><td>Scan frequency</td><td>Manual per image. Recommended: weekly or after each build.</td></tr>
              <tr><td>Data retention</td><td>All scan results are stored in the database with full history.</td></tr>
            </table>
          </div>
        </div>
      </div>

      ${scoutNotAuth ? `
      <div class="card" style="margin-top:16px;border-left:3px solid var(--yellow)">
        <div class="card-header">
          <h3><i class="fab fa-docker" style="margin-right:8px;color:var(--yellow)"></i>Authenticate Docker Scout</h3>
        </div>
        <div class="card-body">
          <p class="text-muted text-sm" style="margin-bottom:12px">Docker Scout requires authentication with Docker Hub to scan images. Enter your Docker Hub credentials below to enable it.</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
            <div class="form-group" style="flex:1;min-width:200px;margin:0">
              <label style="font-size:12px">Docker Hub Username</label>
              <input type="text" id="scout-username" class="form-control" placeholder="your-dockerhub-username">
            </div>
            <div class="form-group" style="flex:1;min-width:200px;margin:0">
              <label style="font-size:12px">Password or Access Token <a href="https://hub.docker.com/settings/security" target="_blank" rel="noopener" style="color:var(--accent);font-size:11px">(create token)</a></label>
              <input type="password" id="scout-password" class="form-control" placeholder="dckr_pat_xxxxx or password">
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-sm btn-primary" id="scout-login-btn"><i class="fas fa-sign-in-alt"></i> Authenticate</button>
            <span id="scout-login-status" class="text-sm"></span>
          </div>
          <div style="margin-top:12px;padding:10px 12px;background:var(--surface2);border-radius:var(--radius-sm)">
            <div class="text-sm" style="margin-bottom:6px"><strong>How to get a Docker Hub Access Token:</strong></div>
            <ol class="text-sm text-muted" style="margin:0;padding-left:20px;line-height:1.8">
              <li>Go to <a href="https://hub.docker.com/settings/security" target="_blank" rel="noopener" style="color:var(--accent)">hub.docker.com/settings/security</a></li>
              <li>Click <strong>"New Access Token"</strong></li>
              <li>Name it (e.g., "docker-dash-scanner"), select <strong>Read-only</strong> permissions</li>
              <li>Copy the token and paste it above</li>
            </ol>
          </div>
        </div>
      </div>` : ''}
    `;

    // Docker Scout login handler
    const loginBtn = el.querySelector('#scout-login-btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', async () => {
        const username = el.querySelector('#scout-username').value.trim();
        const password = el.querySelector('#scout-password').value;
        const statusEl = el.querySelector('#scout-login-status');

        if (!username || !password) {
          statusEl.innerHTML = '<span style="color:var(--red)">Username and password/token required</span>';
          return;
        }

        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Authenticating...';
        statusEl.innerHTML = '';

        try {
          const result = await Api.post('/images/scout-login', { username, password });
          if (result.ok) {
            statusEl.innerHTML = '<span style="color:var(--green)"><i class="fas fa-check"></i> Docker Scout authenticated successfully!</span>';
            setTimeout(() => this._renderScanners(el), 2000);
          } else {
            statusEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times"></i> ${Utils.escapeHtml(result.error || 'Authentication failed')}</span>`;
          }
        } catch (err) {
          statusEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times"></i> ${Utils.escapeHtml(err.message)}</span>`;
        }
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Authenticate';
      });
    }
  },

  _scanIds: [],

  async _viewScanDetail(scanId) {
    try {
      // Load scan IDs list for navigation if not already loaded
      if (!this._scanIds.length) {
        const history = await Api.get('/images/scan-history?limit=500');
        this._scanIds = history.map(r => r.id);
      }

      const data = await Api.get(`/images/scan-history/${scanId}`);
      const vulns = data.vulnerabilities || [];
      const recs = data.recommendations || [];
      const s = { critical: data.summary_critical, high: data.summary_high, medium: data.summary_medium, low: data.summary_low, total: data.summary_total };

      const currentIdx = this._scanIds.indexOf(scanId);
      const prevId = currentIdx > 0 ? this._scanIds[currentIdx - 1] : null;
      const nextId = currentIdx < this._scanIds.length - 1 ? this._scanIds[currentIdx + 1] : null;

      const sevColor = sev => ({ critical: 'var(--red)', high: '#f97316', medium: 'var(--yellow)', low: 'var(--text-dim)' }[sev] || 'var(--text)');

      // Build AI prompt from actual scan data (deduplicated)
      const dedup = (arr) => [...new Map(arr.map(v => [`${v.id}|${v.package}`, v])).values()];
      const criticalVulns = dedup(vulns.filter(v => v.severity === 'critical'));
      const highVulns = dedup(vulns.filter(v => v.severity === 'high'));
      const fixableVulns = dedup(vulns.filter(v => v.fixedIn));
      const topVulnsList = [...criticalVulns, ...highVulns].slice(0, 15)
        .map(v => `- ${v.severity.toUpperCase()} ${v.id}: ${v.package} ${v.version}${v.fixedIn ? ' (fix: ' + v.fixedIn + ')' : ' (no fix)'}${v.title ? ' — ' + v.title : ''}`)
        .join('\n');

      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
      const sortedVulns = [...vulns].sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));
      const uniqueVulns = dedup(vulns);
      const aiPrompt = `I have a Docker image "${data.image_name}" scanned with ${data.scanner} on ${data.scanned_at}.

Vulnerability summary: ${criticalVulns.length} critical, ${highVulns.length} high (${uniqueVulns.length} unique, ${fixableVulns.length} fixable)

Critical and high vulnerabilities:
${topVulnsList || '(none)'}

${fixableVulns.length > 0 ? 'Fixable packages:\n' + fixableVulns.map(v => `- ${v.package}: ${v.version} → ${v.fixedIn}`).join('\n') : ''}

Please:
1. Generate a fixed Dockerfile that resolves all fixable vulnerabilities
2. Add OS package upgrades (apk upgrade / apt-get upgrade) appropriate for the base image
3. Pin specific package versions for packages with known CVEs
4. Recommend a more secure base image if applicable (distroless, alpine, slim)
5. For unfixable vulnerabilities, suggest mitigations or risk acceptance criteria
6. Add comments in the Dockerfile explaining each security change`;

      Modal.open(`
        <div class="modal-header" style="display:flex;align-items:center;gap:8px">
          <button class="btn btn-sm btn-secondary" id="scan-prev" ${!prevId ? 'disabled' : ''} title="Previous scan"><i class="fas fa-chevron-left"></i></button>
          <button class="btn btn-sm btn-secondary" id="scan-next" ${!nextId ? 'disabled' : ''} title="Next scan"><i class="fas fa-chevron-right"></i></button>
          <h3 style="flex:1;margin:0"><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px"></i>Scan: ${Utils.escapeHtml(data.image_name)}</h3>
          <span class="text-sm text-muted">${currentIdx + 1}/${this._scanIds.length}</span>
          <button class="modal-close-btn" id="scan-detail-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="text-sm text-muted" style="margin-bottom:12px">
            Scanner: <strong>${Utils.escapeHtml(data.scanner)}</strong> | Scanned: ${Utils.formatDate(data.scanned_at)} | Fixable: <strong style="color:var(--green)">${data.fixable_count}</strong>/${s.total}
          </div>

          <div style="display:flex;gap:12px;margin-bottom:16px">
            <div style="flex:1;text-align:center;padding:10px;background:var(--red-dim);border-radius:var(--radius-sm)">
              <div style="font-size:22px;font-weight:700;color:var(--red)">${s.critical}</div><div class="text-sm">Critical</div>
            </div>
            <div style="flex:1;text-align:center;padding:10px;background:rgba(249,115,22,0.1);border-radius:var(--radius-sm)">
              <div style="font-size:22px;font-weight:700;color:#f97316">${s.high}</div><div class="text-sm">High</div>
            </div>
            <div style="flex:1;text-align:center;padding:10px;background:var(--yellow-dim);border-radius:var(--radius-sm)">
              <div style="font-size:22px;font-weight:700;color:var(--yellow)">${s.medium}</div><div class="text-sm">Medium</div>
            </div>
            <div style="flex:1;text-align:center;padding:10px;background:var(--surface3);border-radius:var(--radius-sm)">
              <div style="font-size:22px;font-weight:700">${s.low}</div><div class="text-sm">Low</div>
            </div>
          </div>

          ${recs.length > 0 ? `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <h4 style="margin:0;font-size:12px;text-transform:uppercase;color:var(--text-muted)"><i class="fas fa-lightbulb" style="margin-right:6px;color:var(--yellow)"></i>Recommendations</h4>
            <button class="btn btn-sm btn-secondary" id="copy-all-recs" style="padding:2px 8px;font-size:11px"><i class="fas fa-copy"></i> Copy All</button>
          </div>
          ${recs.filter(r => r.type !== 'summary').map(r => {
            const color = r.priority === 'critical' ? 'var(--red)' : r.priority === 'high' ? '#f97316' : r.priority === 'medium' ? 'var(--yellow)' : 'var(--text-muted)';
            return `<div style="padding:6px 10px;margin-bottom:4px;border-left:3px solid ${color};background:var(--surface2);border-radius:0 4px 4px 0;font-size:12px">
              <strong>${Utils.escapeHtml(r.title)}</strong>
              <div class="text-muted">${Utils.escapeHtml(r.description)}</div>
              ${r.command ? `<div style="position:relative;margin-top:4px"><code style="display:block;padding:4px 8px;padding-right:32px;background:var(--surface);border-radius:3px;font-size:11px;color:var(--accent);white-space:pre-wrap">${Utils.escapeHtml(r.command)}</code><button class="btn-icon copy-cmd-btn" style="position:absolute;top:2px;right:2px;padding:2px 6px;font-size:10px;color:var(--text-muted)" title="Copy" data-copy-prev="1"><i class="fas fa-copy"></i></button></div>` : ''}
            </div>`;
          }).join('')}` : ''}

          ${s.total > 0 ? `
          <div style="margin:16px 0;padding:12px 16px;border-left:3px solid var(--accent);background:var(--surface2);border-radius:0 var(--radius-sm) var(--radius-sm) 0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <h4 style="margin:0;font-size:13px"><i class="fas fa-robot" style="color:var(--accent);margin-right:6px"></i>AI-Assisted Remediation</h4>
              <button class="btn btn-sm btn-primary" id="copy-ai-prompt"><i class="fas fa-copy"></i> Copy AI Prompt</button>
            </div>
            <div class="text-sm" style="margin-bottom:10px;color:var(--text)">
              <strong>Personalized prompt generated for this scan:</strong>
            </div>
            <div style="background:var(--surface);border-radius:var(--radius-sm);padding:10px 12px;max-height:280px;overflow-y:auto;font-size:11px;line-height:1.5">
              <div style="margin-bottom:6px"><span style="color:var(--accent)">Image:</span> <strong>${Utils.escapeHtml(data.image_name)}</strong></div>
              <div style="margin-bottom:6px"><span style="color:var(--accent)">Findings:</span> <span style="color:var(--red)">${s.critical} critical</span>, <span style="color:#f97316">${s.high} high</span>, ${s.medium} medium, ${s.low} low — <strong>${data.fixable_count} fixable</strong></div>
              ${criticalVulns.length > 0 ? `<div style="margin-bottom:8px"><span style="color:var(--red)">Critical CVEs:</span><div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">${criticalVulns.map(v => `<code style="font-size:10px;background:rgba(248,81,73,0.15);padding:1px 4px;border-radius:3px">${Utils.escapeHtml(v.id)} (${Utils.escapeHtml(v.package)})</code>`).join('')}</div></div>` : ''}
              ${highVulns.length > 0 ? `<div style="margin-bottom:8px"><span style="color:#f97316">High CVEs:</span><div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">${highVulns.map(v => `<code style="font-size:10px;background:rgba(249,115,22,0.1);padding:1px 4px;border-radius:3px">${Utils.escapeHtml(v.id)} (${Utils.escapeHtml(v.package)})</code>`).join('')}</div></div>` : ''}
              ${fixableVulns.length > 0 ? `<div style="margin-bottom:8px"><span style="color:var(--green)">Upgradeable packages:</span><div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">${[...new Map(fixableVulns.map(v => [v.package, v])).values()].map(v => `<code style="font-size:10px;background:rgba(34,197,94,0.15);padding:1px 4px;border-radius:3px">${Utils.escapeHtml(v.package)} ${Utils.escapeHtml(v.version)} → ${Utils.escapeHtml(v.fixedIn)}</code>`).join('')}</div></div>` : ''}
              <div class="text-muted" style="font-size:10px;margin-top:4px">The prompt includes all ${vulns.length} CVEs with package versions and fix targets. Paste into Claude, ChatGPT, or Copilot for a fixed Dockerfile.</div>
            </div>
            <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
              <button class="btn btn-sm btn-secondary" id="ai-btn-dockerfile"><i class="fas fa-file-code"></i> Fix Dockerfile</button>
              <button class="btn btn-sm btn-secondary" id="ai-btn-compose"><i class="fas fa-layer-group"></i> Fix Compose</button>
              <button class="btn btn-sm btn-secondary" id="ai-btn-report"><i class="fas fa-file-alt"></i> Security Report</button>
            </div>
          </div>` : ''}

          ${vulns.length > 0 ? `
          <h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;color:var(--text-muted)">Vulnerabilities (${vulns.length})</h4>
          <div style="max-height:250px;overflow-y:auto">
            <table class="data-table compact">
              <thead><tr><th>Sev</th><th>CVE</th><th>Package</th><th>Version</th><th>Fix</th></tr></thead>
              <tbody>${sortedVulns.slice(0, 100).map(v => `
                <tr>
                  <td class="mono text-sm" style="color:${sevColor(v.severity)};font-weight:600">${v.severity.toUpperCase()}</td>
                  <td class="mono text-sm">${v.url ? `<a href="${Utils.escapeHtml(v.url)}" target="_blank" style="color:var(--accent)">${Utils.escapeHtml(v.id)}</a>` : Utils.escapeHtml(v.id)}</td>
                  <td class="text-sm">${Utils.escapeHtml(v.package)}</td>
                  <td class="text-sm">${Utils.escapeHtml(v.version)}</td>
                  <td class="text-sm">${v.fixedIn ? `<span style="color:var(--green)">${Utils.escapeHtml(v.fixedIn)}</span>` : '<span class="text-muted">—</span>'}</td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>` : ''}
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="scan-detail-close-btn">Close</button></div>
      `, { width: '850px' });

      Modal._content.querySelector('#scan-detail-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#scan-detail-close-btn').addEventListener('click', () => Modal.close());

      // Navigation buttons
      const prevBtn = Modal._content.querySelector('#scan-prev');
      const nextBtn = Modal._content.querySelector('#scan-next');
      if (prevBtn && prevId) prevBtn.addEventListener('click', () => { Modal.close(); this._viewScanDetail(prevId); });
      if (nextBtn && nextId) nextBtn.addEventListener('click', () => { Modal.close(); this._viewScanDetail(nextId); });

      // AI prompt copy button (main prompt)
      const aiBtn = Modal._content.querySelector('#copy-ai-prompt');
      if (aiBtn) aiBtn.addEventListener('click', () => { Utils.copyToClipboard(aiPrompt).then(() => Toast.success('AI prompt copied — paste it into your AI assistant')); });

      // Specific AI prompts for each button (using deduplicated data)
      const allVulnsList = uniqueVulns.map(v => `- ${v.severity.toUpperCase()} ${v.id}: ${v.package} ${v.version}${v.fixedIn ? ' → ' + v.fixedIn : ' (no fix)'}`)
        .join('\n');

      const dockerfilePrompt = `Fix the Dockerfile for image "${data.image_name}" which has ${uniqueVulns.length} unique vulnerabilities (${criticalVulns.length} critical, ${highVulns.length} high). ${fixableVulns.length} are fixable.

Vulnerabilities found:
${allVulnsList}

Generate a secure Dockerfile that:
1. Uses the latest patched base image
2. Adds OS package upgrades (apk upgrade / apt-get upgrade as appropriate)
3. Pins versions for: ${fixableVulns.map(v => v.package).join(', ')}
4. Uses multi-stage build to minimize attack surface
5. Runs as non-root user
6. Includes comments explaining each security fix`;

      const composePrompt = `My Docker Compose stack uses image "${data.image_name}" which has ${criticalVulns.length} critical and ${highVulns.length} high vulnerabilities.

Update my docker-compose.yml to:
1. Pin to the latest secure image tag (not :latest)
2. Add security options: read_only: true, security_opt: [no-new-privileges:true]
3. Drop all capabilities, add only required ones
4. Add resource limits (memory, CPU)
5. Add healthcheck
6. Use internal networks where possible
7. Remove unnecessary port exposures`;

      const reportPrompt = `Generate a security assessment report for Docker image "${data.image_name}".

Scan results (${data.scanner}, ${data.scanned_at}):
- Critical: ${criticalVulns.length}, High: ${highVulns.length}, Medium: ${s.medium}, Low: ${s.low}
- Unique: ${uniqueVulns.length}, Fixable: ${fixableVulns.length}

Vulnerabilities:
${allVulnsList}

Generate a professional report with:
1. Executive summary with risk rating
2. Top 5 most critical findings with remediation steps
3. Compliance impact (CIS Docker Benchmark, SOC2)
4. Prioritized remediation plan (immediate / 7-day / 30-day)
5. Risk acceptance recommendations for unfixable issues`;

      Modal._content.querySelector('#ai-btn-dockerfile')?.addEventListener('click', () => {
        Utils.copyToClipboard(dockerfilePrompt).then(() => Toast.success('Dockerfile fix prompt copied!'));
      });
      Modal._content.querySelector('#ai-btn-compose')?.addEventListener('click', () => {
        Utils.copyToClipboard(composePrompt).then(() => Toast.success('Compose fix prompt copied!'));
      });
      Modal._content.querySelector('#ai-btn-report')?.addEventListener('click', () => {
        Utils.copyToClipboard(reportPrompt).then(() => Toast.success('Report prompt copied!'));
      });

      // Copy all recommendations
      const copyRecsBtn = Modal._content.querySelector('#copy-all-recs');
      if (copyRecsBtn) {
        const recsText = recs.filter(r => r.type !== 'summary').map(r =>
          `[${r.priority.toUpperCase()}] ${r.title}\n${r.description}${r.command ? '\n$ ' + r.command : ''}`
        ).join('\n\n');
        copyRecsBtn.addEventListener('click', () => { Utils.copyToClipboard(recsText).then(() => Toast.success('All recommendations copied!')); });
      }
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _scanImage(imageId, imageName) {
    Toast.info(`Scanning ${imageName}...`);
    try {
      await Api.scanImage(encodeURIComponent(imageId), 'auto');
      Toast.success(`Scan complete for ${imageName}`);
      this._renderTab();
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _scanAll() {
    const ok = await Modal.confirm('Scan all images for vulnerabilities? This may take several minutes.', { confirmText: 'Scan All' });
    if (!ok) return;

    const images = await Api.getImages();
    Toast.info(`Scanning ${images.length} images...`);

    let completed = 0;
    for (const img of images) {
      const name = (img.repoTags || [])[0] || img.id;
      try {
        await Api.scanImage(encodeURIComponent(name), 'auto');
        completed++;
        Toast.info(`Scanned ${completed}/${images.length}: ${name}`);
      } catch { /* continue scanning others */ }
    }

    Toast.success(`Scan complete: ${completed}/${images.length} images scanned`);
    this._renderTab();
  },

  _cisBriefHtml(data) {
    const { score, summary, checks } = data;
    const scoreColor = score >= 80 ? 'var(--green,#4ade80)' : score >= 50 ? 'var(--yellow,#ffc107)' : 'var(--red,#ef4444)';
    const containerIssues = (checks || []).filter(c => c.category === 'Container' && c.status !== 'pass').length;
    const daemonIssues = (checks || []).filter(c => c.category === 'Daemon' && c.status !== 'pass' && c.status !== 'info').length;
    return `
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div style="text-align:center">
          <div style="font-size:36px;font-weight:700;color:${scoreColor};line-height:1">${score}%</div>
          <div class="text-muted" style="font-size:10px;margin-top:2px">Security Score</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <span class="badge" style="background:rgba(74,222,128,.15);color:var(--green,#4ade80)"><i class="fas fa-check" style="margin-right:4px"></i>${summary.pass || 0} passed</span>
          <span class="badge" style="background:rgba(239,68,68,.15);color:var(--red,#ef4444)"><i class="fas fa-times" style="margin-right:4px"></i>${summary.fail || 0} failed</span>
          <span class="badge" style="background:rgba(234,179,8,.15);color:var(--yellow,#ffc107)"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>${summary.warn || 0} warnings</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${daemonIssues ? `<span class="badge" style="background:rgba(234,179,8,.1);color:var(--text-dim);font-size:11px"><i class="fas fa-cog" style="margin-right:4px"></i>${daemonIssues} daemon issue${daemonIssues > 1 ? 's' : ''}</span>` : ''}
          ${containerIssues ? `<span class="badge" style="background:rgba(239,68,68,.1);color:var(--text-dim);font-size:11px"><i class="fas fa-box" style="margin-right:4px"></i>${containerIssues} container issue${containerIssues > 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>
    `;
  },

  _copyAiPrompt(type) {
    const prompts = {
      dockerfile: `Analyze the vulnerability scan results from my Docker Dash security dashboard and:
1. Generate an optimized, secure Dockerfile that fixes all fixable vulnerabilities
2. Use the latest stable base image with security patches
3. Add "apk upgrade --no-cache" or equivalent for the distro
4. Pin specific versions for packages with known CVEs
5. Use multi-stage build to minimize final image size
6. Add a non-root USER directive
7. Add comments explaining each security decision`,

      compose: `Based on my Docker Dash vulnerability scan, update my docker-compose.yml to:
1. Use the latest secure image tags (avoid :latest, pin to specific versions)
2. Add security-related options: read_only, no-new-privileges, drop all capabilities
3. Add resource limits (memory, CPU) to prevent DoS
4. Use internal networks where possible
5. Add health checks for all services
6. Remove any unnecessary port exposures`,

      report: `Generate a security assessment report based on my Docker Dash vulnerability scan results:
1. Executive summary with risk level (Critical/High/Medium/Low)
2. Top 5 most critical vulnerabilities with remediation steps
3. Compliance impact (CIS Docker Benchmark, SOC2, ISO 27001)
4. Remediation timeline recommendation (immediate, 7-day, 30-day)
5. Risk acceptance criteria for unfixable vulnerabilities
Format as a professional PDF-ready report.`,

      ci: `Create a CI/CD pipeline (GitHub Actions) that:
1. Builds the Docker image
2. Runs Trivy vulnerability scan
3. Fails the build if critical or high vulnerabilities are found
4. Generates a SARIF report and uploads to GitHub Security tab
5. Sends notification if new vulnerabilities are detected
6. Includes a weekly scheduled scan of running images
Include the complete .github/workflows/security-scan.yml file.`,
    };

    const text = prompts[type] || '';
    Utils.copyToClipboard(text).then(() => Toast.success('AI prompt copied to clipboard'));
  },

  destroy() {},
};

window.SecurityPage = SecurityPage;
