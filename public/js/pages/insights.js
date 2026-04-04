/* ═══════════════════════════════════════════════════
   pages/insights.js — Intelligence Dashboard
   Aggregates health, recommendations, freshness,
   uptime, and cost into a single executive view.
   ═══════════════════════════════════════════════════ */
'use strict';

const InsightsPage = {
  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-brain" style="color:var(--accent)"></i> Insights</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-secondary" id="insights-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="insights-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Analyzing your infrastructure...</div></div>
    `;

    container.querySelector('#insights-refresh').addEventListener('click', () => this._load());
    await this._load();
  },

  async _load() {
    const el = document.getElementById('insights-content');
    if (!el) return;

    try {
      // Fetch all intelligence data in parallel
      const [containers, recommendations, freshness, footprint] = await Promise.all([
        Api.getContainers(true).catch(() => []),
        Api.getResourceRecommendations().catch(() => ({ recommendations: [] })),
        Api.getImageFreshness().catch(() => []),
        Api.getFootprint().catch(() => null),
      ]);

      // Calculate health scores for all containers
      const scored = containers.map(c => {
        const score = Utils.containerHealthScore({
          state: c.state, exitCode: c.exitCode || 0,
          health: c.health, restartCount: c.restartCount || 0,
          cpuPercent: c.cpuPercent || 0, memPercent: c.memPercent || 0,
          imageAge: 0, vulnCount: 0,
        });
        return { ...c, healthScore: score };
      });

      const running = scored.filter(c => c.state === 'running').length;
      const stopped = scored.length - running;
      const avgHealth = scored.length > 0
        ? Math.round(scored.reduce((s, c) => s + c.healthScore, 0) / scored.length)
        : 0;
      const critical = scored.filter(c => c.healthScore < 25).length;
      const warnings = recommendations.recommendations?.length || 0;
      const staleImages = freshness.filter(i => i.freshness < 50).length;

      el.innerHTML = `
        <!-- Top Stats -->
        <div class="stat-cards" style="margin-bottom:20px">
          <div class="stat-card">
            <div class="stat-icon" style="background:rgba(${avgHealth >= 70 ? '63,185,80' : avgHealth >= 40 ? '210,153,34' : '248,81,73'},0.1);color:${Utils.healthScoreColor(avgHealth)}">
              <i class="fas fa-heartbeat"></i>
            </div>
            <div class="stat-body">
              <div class="stat-value">${avgHealth}</div>
              <div class="stat-label">Avg Health Score</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green"><i class="fas fa-play-circle"></i></div>
            <div class="stat-body">
              <div class="stat-value">${running}<span class="text-muted text-sm">/${scored.length}</span></div>
              <div class="stat-label">Running</div>
            </div>
          </div>
          <div class="stat-card" id="insights-card-issues" style="cursor:pointer;transition:box-shadow .15s" title="Click to see issues">
            <div class="stat-icon" style="background:rgba(248,81,73,0.1);color:var(--red)"><i class="fas fa-exclamation-circle"></i></div>
            <div class="stat-body">
              <div class="stat-value">${critical + warnings}</div>
              <div class="stat-label">Issues Found</div>
            </div>
          </div>
          <div class="stat-card" id="insights-card-stale" style="cursor:pointer;transition:box-shadow .15s" title="Click to see stale images">
            <div class="stat-icon" style="background:rgba(210,153,34,0.1);color:#d29922"><i class="fas fa-image"></i></div>
            <div class="stat-body">
              <div class="stat-value">${staleImages}</div>
              <div class="stat-label">Stale Images</div>
            </div>
          </div>
        </div>

        <div class="info-grid" style="margin-top:0">
          <!-- Critical Containers -->
          ${critical > 0 ? `
          <div class="card" id="insights-section-issues" style="border-left:3px solid var(--red)">
            <div class="card-header"><h3><i class="fas fa-skull-crossbones" style="color:var(--red);margin-right:8px"></i>Critical Containers</h3></div>
            <div class="card-body" style="padding:0">
              <table class="data-table">
                <thead><tr><th style="text-align:left">Container</th><th>Score</th><th>State</th><th>Issue</th></tr></thead>
                <tbody>${scored.filter(c => c.healthScore < 25).map(c => `
                  <tr style="cursor:pointer" data-nav-container="${c.id}">
                    <td style="text-align:left" class="mono">${Utils.escapeHtml(c.name)}</td>
                    <td><span style="color:${Utils.healthScoreColor(c.healthScore)};font-weight:700">${c.healthScore}</span></td>
                    <td><span class="badge ${Utils.statusBadgeClass(c.state)}">${c.state}</span></td>
                    <td class="text-sm">${Utils.containerStatusMessage(c.state, c.exitCode)}</td>
                  </tr>
                `).join('')}</tbody>
              </table>
            </div>
          </div>` : ''}

          <!-- Resource Recommendations -->
          ${warnings > 0 ? `
          <div class="card" id="${critical === 0 ? 'insights-section-issues' : ''}" style="border-left:3px solid #d29922">
            <div class="card-header"><h3><i class="fas fa-lightbulb" style="color:#d29922;margin-right:8px"></i>Recommendations (${warnings})</h3></div>
            <div class="card-body" style="padding:0">
              <table class="data-table">
                <thead><tr><th style="text-align:left">Container</th><th>Issue</th><th>Severity</th></tr></thead>
                <tbody>${(recommendations.recommendations || []).slice(0, 8).map(r => r.recommendations.map(rec => `
                  <tr>
                    <td style="text-align:left" class="mono">${Utils.escapeHtml(r.container_name)}</td>
                    <td class="text-sm">${Utils.escapeHtml(rec.message.substring(0, 100))}</td>
                    <td><span class="badge ${rec.severity === 'warning' ? 'badge-warning' : 'badge-info'}">${rec.severity}</span></td>
                  </tr>
                `).join('')).join('')}</tbody>
              </table>
            </div>
          </div>` : ''}

          <!-- Stale Images -->
          ${staleImages > 0 ? `
          <div class="card" id="insights-section-stale" style="border-left:3px solid #d29922">
            <div class="card-header"><h3><i class="fas fa-clock" style="color:#d29922;margin-right:8px"></i>Stale Images (${staleImages})</h3></div>
            <div class="card-body" style="padding:0">
              <table class="data-table">
                <thead><tr><th style="text-align:left">Image</th><th>Age</th><th>Freshness</th><th>Vulns</th></tr></thead>
                <tbody>${freshness.filter(i => i.freshness < 50).slice(0, 8).map(i => `
                  <tr>
                    <td style="text-align:left" class="mono text-sm">${Utils.escapeHtml(i.name)}</td>
                    <td>${i.age_days}d</td>
                    <td><span style="color:${Utils.healthScoreColor(i.freshness)};font-weight:700">${i.freshness}</span></td>
                    <td>${i.scan ? `<span class="text-red">${i.scan.critical}C</span> <span style="color:#f97316">${i.scan.high}H</span>` : '<span class="text-muted">No scan</span>'}</td>
                  </tr>
                `).join('')}</tbody>
              </table>
            </div>
          </div>` : ''}

          <!-- All Good -->
          ${critical === 0 && warnings === 0 && staleImages === 0 ? `
          <div class="card" style="border-left:3px solid var(--green);grid-column:1/-1">
            <div class="card-body" style="text-align:center;padding:32px">
              <i class="fas fa-check-circle" style="font-size:48px;color:var(--green);margin-bottom:12px"></i>
              <h3 style="color:var(--green);margin:0">All Systems Healthy</h3>
              <p class="text-muted">No critical containers, no resource issues, no stale images.</p>
            </div>
          </div>` : ''}

          <!-- Docker Dash Footprint -->
          ${footprint ? `
          <div class="card">
            <div class="card-header"><h3><i class="fas fa-microchip" style="margin-right:8px;opacity:0.6"></i>Docker Dash Footprint</h3></div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>Memory (RSS)</td><td>${Utils.formatBytes(footprint.memory.rss)}</td></tr>
                <tr><td>Heap Used</td><td>${Utils.formatBytes(footprint.memory.heapUsed)}</td></tr>
                <tr><td>Uptime</td><td>${Utils.formatDuration(footprint.uptime)}</td></tr>
                <tr><td>Node.js</td><td class="mono">${footprint.nodeVersion}</td></tr>
                <tr><td>Database</td><td>${Utils.formatBytes(footprint.dbSizeBytes)}</td></tr>
              </table>
            </div>
          </div>` : ''}

          <!-- Health Score Distribution -->
          <div class="card">
            <div class="card-header"><h3><i class="fas fa-chart-bar" style="margin-right:8px;opacity:0.6"></i>Health Distribution</h3></div>
            <div class="card-body">
              ${this._renderHealthBar(scored)}
            </div>
          </div>
        </div>
      `;

      // Wire up navigation clicks
      el.querySelectorAll('[data-nav-container]').forEach(row => {
        row.addEventListener('click', () => { location.hash = '#/containers/' + row.dataset.navContainer; });
      });

      // Wire up stat card clicks — scroll to relevant section
      const issuesCard = document.getElementById('insights-card-issues');
      if (issuesCard) {
        issuesCard.addEventListener('click', () => {
          const section = document.getElementById('insights-section-issues');
          if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            section.style.outline = '2px solid var(--red)';
            setTimeout(() => { section.style.outline = ''; }, 1500);
          } else {
            if (window.App && App.showToast) App.showToast('No issues found — all systems healthy!', 'success');
          }
        });
        issuesCard.addEventListener('mouseenter', () => { issuesCard.style.boxShadow = '0 0 0 2px var(--red)'; });
        issuesCard.addEventListener('mouseleave', () => { issuesCard.style.boxShadow = ''; });
      }

      const staleCard = document.getElementById('insights-card-stale');
      if (staleCard) {
        staleCard.addEventListener('click', () => {
          const section = document.getElementById('insights-section-stale');
          if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            section.style.outline = '2px solid #d29922';
            setTimeout(() => { section.style.outline = ''; }, 1500);
          } else {
            if (window.App && App.showToast) App.showToast('No stale images found!', 'success');
          }
        });
        staleCard.addEventListener('mouseenter', () => { staleCard.style.boxShadow = '0 0 0 2px #d29922'; });
        staleCard.addEventListener('mouseleave', () => { staleCard.style.boxShadow = ''; });
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error loading insights: ${err.message}</div>`;
    }
  },

  _renderHealthBar(containers) {
    const buckets = { excellent: 0, good: 0, fair: 0, poor: 0, critical: 0 };
    for (const c of containers) {
      if (c.healthScore >= 90) buckets.excellent++;
      else if (c.healthScore >= 75) buckets.good++;
      else if (c.healthScore >= 50) buckets.fair++;
      else if (c.healthScore >= 25) buckets.poor++;
      else buckets.critical++;
    }
    const total = containers.length || 1;
    return `
      <div style="display:flex;height:24px;border-radius:var(--radius);overflow:hidden;margin-bottom:12px">
        ${buckets.excellent > 0 ? `<div style="width:${buckets.excellent/total*100}%;background:#3fb950" title="Excellent: ${buckets.excellent}"></div>` : ''}
        ${buckets.good > 0 ? `<div style="width:${buckets.good/total*100}%;background:#58a6ff" title="Good: ${buckets.good}"></div>` : ''}
        ${buckets.fair > 0 ? `<div style="width:${buckets.fair/total*100}%;background:#d29922" title="Fair: ${buckets.fair}"></div>` : ''}
        ${buckets.poor > 0 ? `<div style="width:${buckets.poor/total*100}%;background:#db6d28" title="Poor: ${buckets.poor}"></div>` : ''}
        ${buckets.critical > 0 ? `<div style="width:${buckets.critical/total*100}%;background:#f85149" title="Critical: ${buckets.critical}"></div>` : ''}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px">
        <span><span style="display:inline-block;width:10px;height:10px;background:#3fb950;border-radius:2px;margin-right:4px"></span>Excellent (${buckets.excellent})</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#58a6ff;border-radius:2px;margin-right:4px"></span>Good (${buckets.good})</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#d29922;border-radius:2px;margin-right:4px"></span>Fair (${buckets.fair})</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#db6d28;border-radius:2px;margin-right:4px"></span>Poor (${buckets.poor})</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#f85149;border-radius:2px;margin-right:4px"></span>Critical (${buckets.critical})</span>
      </div>
    `;
  },

  destroy() {},
};

window.InsightsPage = InsightsPage;
