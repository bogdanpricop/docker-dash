/* ═══════════════════════════════════════════════════
   pages/system-egress.js — Egress audit + filter editor

   Extracted from system.js in the v8.2.x post-audit refactor (system.js was
   6011 lines, the egress section alone was 436 LOC). Methods are merged into
   SystemPage at startup via Object.assign — see end of system.js. The split
   is purely organisational; egress UI loads with the rest of the dashboard
   (no lazy-load gating) to avoid any subtle ordering bugs in this
   security-sensitive flow.

   Six methods:
     _renderEgressAudit      — scan posture + per-container/stack policy table
     _loadEgressBlockLog     — lazy-load section invoked on expand
     _renderEgressBlockLog   — render denied connections (grouped or detail)
     _renderEgressBlockLogHeader — table header with view-toggle + export
     _exportEgressBlockLogCsv — CSV export of denied entries
     _egressFilterEdit       — modal: enable/edit/unapply policy
   ═══════════════════════════════════════════════════ */
'use strict';

const SystemPageEgress = {
  async _renderEgressAudit(el) {
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Scanning egress posture…</div>`;
    let data, policies, presetsData;
    try {
      [data, policies, presetsData] = await Promise.all([
        Api.getEgressAudit(),
        Api.egressFilterListPolicies().catch(() => ({ policies: [], enforced: false })),
        Api.egressFilterPresets().catch(() => ({ presets: [] })),
      ]);
    } catch (e) {
      el.innerHTML = `<div class="empty-msg">Error: ${Utils.escapeHtml(e.message || 'Failed to load egress audit')}</div>`;
      return;
    }

    // Build a lookup: containerKey → policy
    const policyByContainer = new Map();
    for (const p of (policies.policies || [])) {
      if (p.scopeType === 'container') policyByContainer.set(p.scopeKey, p);
    }
    const policyByStack = new Map();
    for (const p of (policies.policies || [])) {
      if (p.scopeType === 'stack') policyByStack.set(p.scopeKey, p);
    }
    const presets = presetsData.presets || [];

    const badge = (sev) => {
      const colors = { critical: 'var(--red)', warning: 'var(--yellow)', info: '#64748b' };
      return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:${colors[sev] || '#64748b'}">${sev.toUpperCase()}</span>`;
    };

    const pill = (label, val, bg) => `<div style="padding:10px 14px;background:${bg};border-radius:8px;min-width:110px"><div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px">${label}</div><div style="font-size:22px;font-weight:700;margin-top:2px">${val}</div></div>`;

    const score = data.avgScore ?? 100;
    const scoreColor = score >= 80 ? 'rgba(34,197,94,0.15)' : score >= 60 ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)';

    const rowHtml = (r) => {
      const topSev = r.findings.find(f => f.severity === 'critical') ? 'critical'
        : r.findings.find(f => f.severity === 'warning') ? 'warning'
        : r.findings.length > 0 ? 'info' : null;

      const verdict = r.canReachInternet
        ? (r.canReachIMDS ? '<span style="color:var(--red)">Internet + IMDS</span>' : '<span style="color:var(--yellow)">Internet</span>')
        : '<span style="color:#22c55e">Isolated</span>';

      const findingsHtml = r.findings.length === 0
        ? '<div style="padding:12px;color:var(--text-dim)">No findings — container has a clean egress posture.</div>'
        : r.findings.map(f => `
            <div style="padding:8px 12px;border-bottom:1px solid var(--border)">
              <div style="display:flex;gap:8px;align-items:start">
                ${badge(f.severity)}
                <div style="flex:1">
                  <div>${Utils.escapeHtml(f.message)}</div>
                  ${f.fix ? `<div style="color:var(--text-dim);font-size:12px;margin-top:4px"><i class="fas fa-wrench" style="margin-right:4px"></i>${Utils.escapeHtml(f.fix)}</div>` : ''}
                </div>
              </div>
            </div>`).join('');

      const netsHtml = r.networks.length === 0
        ? '<span style="color:var(--text-dim)">none</span>'
        : r.networks.map(n => {
            const tag = n.internal ? 'internal' : (n.gateway ? 'bridge' : n.driver);
            const bg = n.internal ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.10)';
            return `<span style="display:inline-block;padding:2px 6px;background:${bg};border-radius:3px;margin-right:4px;font-size:11px"><code>${Utils.escapeHtml(n.name)}</code> <span style="color:var(--text-dim)">[${tag}]</span></span>`;
          }).join('');

      // Long container id (full Id from audit if present, else short id)
      const fullId = r.fullId || r.id;
      const policy = policyByContainer.get(fullId) || policyByContainer.get(r.id) || (r.stack ? policyByStack.get(r.stack) : null);
      let filterCell;
      if (policy) {
        const scopeLbl = policy.scopeType === 'stack' ? `stack:${policy.scopeKey}` : 'container';
        const modeBg = policy.mode === 'enforce' ? 'rgba(59,130,246,0.15)' : 'rgba(234,179,8,0.15)';
        filterCell = `
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
            <span style="padding:2px 6px;background:${modeBg};border-radius:3px;font-size:10px;font-weight:600" title="${Utils.escapeHtml(scopeLbl)}">${policy.preset} · ${policy.mode}</span>
            <button class="btn btn-xs btn-secondary egress-manage-btn" data-policy-id="${policy.id}" data-cid="${fullId}" data-cname="${Utils.escapeHtml(r.name)}" title="Manage policy"><i class="fas fa-cog"></i></button>
          </div>`;
      } else {
        filterCell = `<button class="btn btn-xs btn-primary egress-enable-btn" data-cid="${fullId}" data-cname="${Utils.escapeHtml(r.name)}" data-stack="${Utils.escapeHtml(r.stack || '')}"><i class="fas fa-shield-alt" style="margin-right:4px"></i>Enable filter</button>`;
      }

      return `
        <tr class="egress-row" data-id="${r.id}" style="cursor:pointer">
          <td>${topSev ? badge(topSev) : '<span style="color:var(--text-dim)">—</span>'}</td>
          <td><strong>${Utils.escapeHtml(r.name)}</strong>${r.stack ? `<div style="font-size:11px;color:var(--text-dim)">${Utils.escapeHtml(r.stack)}${r.service ? ' / ' + Utils.escapeHtml(r.service) : ''}</div>` : ''}</td>
          <td><code style="font-size:12px">${Utils.escapeHtml(r.networkMode || 'default')}</code></td>
          <td>${netsHtml}</td>
          <td>${verdict}</td>
          <td style="text-align:right"><strong style="color:${r.score >= 80 ? '#22c55e' : r.score >= 60 ? 'var(--yellow)' : 'var(--red)'}">${r.score}</strong></td>
          <td>${filterCell}</td>
          <td style="text-align:center"><i class="fas fa-chevron-down egress-chev" style="color:var(--text-dim)"></i></td>
        </tr>
        <tr class="egress-detail" data-id="${r.id}" style="display:none;background:var(--bg-dim)"><td colspan="8" style="padding:0">
          ${findingsHtml}
          ${r.extraHosts && r.extraHosts.length > 0 ? `<div style="padding:8px 12px;border-top:1px solid var(--border);font-size:12px"><strong>extra_hosts:</strong> <code>${Utils.escapeHtml(r.extraHosts.join(', '))}</code></div>` : ''}
          ${r.dns && r.dns.length > 0 ? `<div style="padding:8px 12px;border-top:1px solid var(--border);font-size:12px"><strong>custom DNS:</strong> <code>${Utils.escapeHtml(r.dns.join(', '))}</code></div>` : ''}
          ${policy ? `<div class="egress-blocklog-slot" data-policy-id="${policy.id}" style="padding:12px;border-top:1px solid var(--border)"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Loading deny log...</div>` : ''}
        </td></tr>`;
    };

    const sorted = [...data.containers].sort((a, b) => a.score - b.score);

    el.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-body">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${pill('Avg Score', score, scoreColor)}
            ${pill('Critical', data.criticalCount, 'rgba(239,68,68,0.15)')}
            ${pill('Warnings', data.warningCount, 'rgba(234,179,8,0.15)')}
            ${pill('Internet reach', `${data.internetReachable}/${data.total}`, 'rgba(249,115,22,0.12)')}
            ${pill('IMDS reach', `${data.imdsReachable}/${data.total}`, 'rgba(239,68,68,0.12)')}
            ${pill('Scanned', `${data.scanned}/${data.hostTotal}`, 'rgba(148,163,184,0.15)')}
          </div>
          <div style="margin-top:12px;padding:10px 12px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;border-radius:4px;font-size:13px">
            <strong><i class="fas fa-info-circle" style="margin-right:4px"></i>Audit &amp; enforcement.</strong>
            Flags containers that can reach public internet and cloud-metadata endpoints (IMDS — <code>169.254.169.254</code>).
            ${policies.enforced ? 'Active enforcement available: click <strong>Enable filter</strong> per row to install an outbound allowlist (sidecar + iptables).' : 'Read-only audit — sidecar not configured. Set <code>DD_EGRESS_SIDECAR_ENDPOINT</code> to enable.'}
            <a href="#/howto" style="margin-left:6px">How to mitigate →</a>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="padding:0;overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:var(--bg-dim);border-bottom:1px solid var(--border)">
                <th style="padding:10px 12px;text-align:left;width:90px">Risk</th>
                <th style="padding:10px 12px;text-align:left">Container</th>
                <th style="padding:10px 12px;text-align:left;width:120px">Network Mode</th>
                <th style="padding:10px 12px;text-align:left">Networks</th>
                <th style="padding:10px 12px;text-align:left;width:150px">Reachability</th>
                <th style="padding:10px 12px;text-align:right;width:70px">Score</th>
                <th style="padding:10px 12px;text-align:left;width:210px">Filter</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              ${sorted.length > 0 ? sorted.map(rowHtml).join('') : '<tr><td colspan="8" style="padding:30px;text-align:center;color:var(--text-dim)">No containers to scan.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Toggle detail row on click (ignore clicks on buttons inside it)
    el.querySelectorAll('.egress-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const id = row.dataset.id;
        const detail = el.querySelector(`.egress-detail[data-id="${id}"]`);
        if (!detail) return;
        const open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : 'table-row';
        const chev = row.querySelector('.egress-chev');
        if (chev) chev.className = open ? 'fas fa-chevron-down egress-chev' : 'fas fa-chevron-up egress-chev';
        // Lazy-load block log on first expand
        if (!open) {
          const slot = detail.querySelector('.egress-blocklog-slot');
          if (slot && !slot.dataset.loaded) {
            slot.dataset.loaded = '1';
            this._loadEgressBlockLog(slot);
          }
        }
      });
    });

    // Enable filter button → opens 3-step modal
    el.querySelectorAll('.egress-enable-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showEgressFilterModal({
          mode: 'enable',
          containerId: btn.dataset.cid,
          containerName: btn.dataset.cname,
          stack: btn.dataset.stack || null,
          presets,
          onSaved: () => this._renderEgressAudit(el),
        });
      });
    });

    // Manage existing policy → opens manage modal
    el.querySelectorAll('.egress-manage-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showEgressFilterModal({
          mode: 'manage',
          policyId: parseInt(btn.dataset.policyId, 10),
          containerId: btn.dataset.cid,
          containerName: btn.dataset.cname,
          presets,
          onSaved: () => this._renderEgressAudit(el),
        });
      });
    });
  },

  // ─── Egress filter: lazy-load block log into the expanded detail row
  async _loadEgressBlockLog(slotEl) {
    const policyId = slotEl.dataset.policyId;
    // Toggle between 'recent' (raw events) and 'grouped' (by hostname) — persists per slot
    if (!slotEl.dataset.view) slotEl.dataset.view = 'grouped';
    await this._renderEgressBlockLog(slotEl, policyId, slotEl.dataset.view);
  },

  async _renderEgressBlockLog(slotEl, policyId, view) {
    slotEl.innerHTML = `<div style="color:var(--text-dim);font-size:12px"><i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Loading deny log…</div>`;
    try {
      if (view === 'grouped') {
        const { groups = [] } = await Api.egressFilterBlockLogGrouped(policyId, { sinceHours: 168, limit: 20 });
        slotEl.innerHTML = this._renderEgressBlockLogHeader(policyId, view, groups.length)
          + (groups.length === 0
            ? `<div style="color:var(--text-dim);font-size:12px;padding:8px"><i class="fas fa-shield-check" style="margin-right:6px"></i>No deny events in the last 7 days.</div>`
            : `<table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead>
                  <tr style="background:var(--bg);border-bottom:1px solid var(--border)">
                    <th style="padding:5px 8px;text-align:left">Hostname</th>
                    <th style="padding:5px 8px;text-align:right;width:60px">Denies</th>
                    <th style="padding:5px 8px;text-align:left;width:150px">Last seen</th>
                    <th style="padding:5px 8px;text-align:left;width:90px">Ports</th>
                    <th style="padding:5px 8px;width:90px"></th>
                  </tr>
                </thead>
                <tbody>
                ${groups.map(g => `
                  <tr style="border-bottom:1px solid var(--surface2)">
                    <td style="padding:5px 8px;font-family:var(--mono)"><strong>${Utils.escapeHtml(g.hostname)}</strong></td>
                    <td style="padding:5px 8px;text-align:right;color:var(--red);font-weight:600">${g.count}</td>
                    <td style="padding:5px 8px;color:var(--text-dim)">${g.last_seen}</td>
                    <td style="padding:5px 8px;font-family:var(--mono)">${Utils.escapeHtml(g.ports || '')}</td>
                    <td style="padding:5px 8px;text-align:right">
                      <button class="btn btn-xs btn-primary egress-allow-btn" data-policy-id="${policyId}" data-hostname="${Utils.escapeHtml(g.hostname)}" title="Add this hostname to the policy allowlist"><i class="fas fa-check" style="margin-right:4px"></i>Allow</button>
                    </td>
                  </tr>`).join('')}
                </tbody>
              </table>`);
      } else {
        const { entries = [] } = await Api.egressFilterBlockLog(policyId, { limit: 50 });
        slotEl.innerHTML = this._renderEgressBlockLogHeader(policyId, view, entries.length)
          + (entries.length === 0
            ? `<div style="color:var(--text-dim);font-size:12px;padding:8px"><i class="fas fa-shield-check" style="margin-right:6px"></i>No deny events yet.</div>`
            : `<div style="max-height:200px;overflow-y:auto;font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px">
                ${entries.map(e => `<div><span style="color:var(--text-dim)">${e.blocked_at}</span> <strong>${Utils.escapeHtml(e.hostname)}</strong>:<span style="color:var(--accent)">${e.port}</span> <span style="color:var(--red)">[${Utils.escapeHtml(e.reason)}]</span></div>`).join('')}
              </div>`);
      }

      // Wire interactions
      slotEl.querySelectorAll('.egress-blocklog-view-btn').forEach(b => b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        slotEl.dataset.view = b.dataset.view;
        await this._renderEgressBlockLog(slotEl, policyId, b.dataset.view);
      }));
      slotEl.querySelectorAll('.egress-blocklog-csv-btn').forEach(b => b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._exportEgressBlockLogCsv(policyId);
      }));
      slotEl.querySelectorAll('.egress-allow-btn').forEach(b => b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const hostname = b.dataset.hostname;
        if (!confirm(`Add "${hostname}" to the allowlist for this policy? The current preset will switch to 'custom'.`)) return;
        try {
          const r = await Api.egressFilterAllowHostname(policyId, hostname);
          if (r.added) Toast.success(`${hostname} added to allowlist`);
          else Toast.warning(`${hostname}: ${r.reason || 'no change'}`);
          await this._renderEgressBlockLog(slotEl, policyId, slotEl.dataset.view);
        } catch (err) { Toast.error(err.message); }
      }));
    } catch (e) {
      slotEl.innerHTML = `<div style="color:var(--red);font-size:12px">Failed to load deny log: ${Utils.escapeHtml(e.message)}</div>`;
    }
  },

  _renderEgressBlockLogHeader(_policyId, view, count) {
    const btn = (v, label) => `<button class="btn btn-xs ${v === view ? 'btn-primary' : 'btn-secondary'} egress-blocklog-view-btn" data-view="${v}">${label}</button>`;
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <i class="fas fa-ban" style="color:var(--red)"></i>
        <strong style="font-size:12px">Deny log</strong>
        <span style="color:var(--text-dim);font-size:11px">(${count} ${view === 'grouped' ? 'hosts' : 'events'})</span>
        <div style="flex:1"></div>
        ${btn('grouped', 'Grouped')}
        ${btn('recent', 'Recent')}
        <button class="btn btn-xs btn-secondary egress-blocklog-csv-btn" title="Export CSV"><i class="fas fa-file-csv"></i> CSV</button>
      </div>`;
  },

  async _exportEgressBlockLogCsv(policyId) {
    try {
      const { entries = [] } = await Api.egressFilterBlockLog(policyId, { limit: 1000 });
      if (entries.length === 0) { Toast.warning('No deny events to export'); return; }
      const csv = [
        ['id', 'blocked_at', 'hostname', 'port', 'proto', 'reason', 'container_id'].join(','),
        ...entries.map(e => [e.id, e.blocked_at, e.hostname, e.port, e.proto, e.reason, e.container_id || ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')),
      ].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `egress-blocklog-policy${policyId}-${Date.now()}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      Toast.success(`Exported ${entries.length} events`);
    } catch (e) { Toast.error(e.message); }
  },

  // ─── Egress filter modal (Enable or Manage)
  _showEgressFilterModal({ mode, policyId, containerId, containerName, stack, presets, onSaved }) {
    const isManage = mode === 'manage';
    const presetOptions = (presets || []).map(p =>
      `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)} — ${Utils.escapeHtml(p.description.slice(0, 80))}</option>`
    ).join('');

    const title = isManage
      ? `Manage egress filter — ${Utils.escapeHtml(containerName)}`
      : `Enable egress filter — ${Utils.escapeHtml(containerName)}`;

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px"></i>${title}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:12px;padding:8px 12px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:4px;font-size:12px">
          <i class="fas fa-info-circle" style="margin-right:6px;color:var(--accent)"></i>
          Policy is configured in the DB. Enforcement requires the <code>dd-egress-filter</code> sidecar + <code>DD_EGRESS_SIDECAR_ENDPOINT</code> env. IMDS endpoints (<code>169.254.169.254</code>) are always blocked regardless of policy.
        </div>
        <div style="display:grid;grid-template-columns:120px 1fr;gap:10px;margin-bottom:12px;align-items:center">
          <label style="font-size:13px">Preset:</label>
          <select id="ef-preset" style="width:100%">${presetOptions}</select>

          <label style="font-size:13px">Mode:</label>
          <select id="ef-mode" style="width:100%">
            <option value="enforce">Enforce (block denies)</option>
            <option value="audit-only">Audit-only (log, don't block)</option>
          </select>

          <label style="font-size:13px;align-self:start;padding-top:6px">Custom allowlist:</label>
          <textarea id="ef-allowlist" rows="6" style="width:100%;font-family:var(--mono);font-size:12px" placeholder="One hostname per line, e.g.&#10;docker.io&#10;*.github.com&#10;registry.npmjs.org"></textarea>
        </div>
        <div id="ef-status" style="font-size:12px;color:var(--text-dim);min-height:20px"></div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:space-between">
        <div>
          ${isManage ? '<button class="btn btn-danger" id="ef-emergency-disable"><i class="fas fa-times-circle" style="margin-right:4px"></i>Emergency disable</button>' : ''}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="ef-cancel">Cancel</button>
          ${isManage
            ? '<button class="btn btn-secondary" id="ef-unapply">Unapply</button><button class="btn btn-primary" id="ef-save">Save &amp; apply</button>'
            : '<button class="btn btn-primary" id="ef-save">Save &amp; apply</button>'}
        </div>
      </div>
    `, { width: '640px' });

    const mc = Modal._content;
    mc.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    mc.querySelector('#ef-cancel').addEventListener('click', () => Modal.close());

    const setStatus = (msg, color = 'var(--text-dim)') => {
      mc.querySelector('#ef-status').innerHTML = `<span style="color:${color}">${Utils.escapeHtml(msg)}</span>`;
    };

    // Prefill on Manage
    if (isManage) {
      (async () => {
        try {
          const { policy } = await Api.egressFilterGetPolicy(policyId);
          mc.querySelector('#ef-preset').value = policy.preset;
          mc.querySelector('#ef-mode').value = policy.mode;
          if (policy.preset === 'custom' || policy.preset === 'audit-only') {
            mc.querySelector('#ef-allowlist').value = (policy.allowlist || []).join('\n');
          }
        } catch (e) { setStatus('Could not load policy: ' + e.message, 'var(--red)'); }
      })();
    }

    const save = async () => {
      const preset = mc.querySelector('#ef-preset').value;
      const modeSel = mc.querySelector('#ef-mode').value;
      const customRaw = mc.querySelector('#ef-allowlist').value.trim();
      const customAllowlist = customRaw ? customRaw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) : undefined;

      setStatus('Saving policy...');
      try {
        let pid = policyId;
        if (!pid) {
          const created = await Api.egressFilterCreatePolicy({
            scopeType: 'container',
            scopeKey: containerId,
            preset,
            customAllowlist,
            mode: modeSel,
          });
          pid = created.policyId;
        } else {
          await Api.egressFilterUpdatePolicy(pid, { preset, customAllowlist, mode: modeSel });
        }
        setStatus('Applying filter...');
        const applyRes = await Api.egressFilterApply(pid);
        setStatus(`Applied: ${applyRes.scope === 'stack' ? `${applyRes.applied.length} container(s)` : 'ok'}`, '#22c55e');
        Toast.success('Egress filter applied');
        setTimeout(() => { Modal.close(); onSaved && onSaved(); }, 600);
      } catch (e) {
        setStatus('Failed: ' + e.message, 'var(--red)');
        Toast.error(e.message);
      }
    };

    mc.querySelector('#ef-save').addEventListener('click', save);

    if (isManage) {
      mc.querySelector('#ef-unapply').addEventListener('click', async () => {
        setStatus('Unapplying filter...');
        try {
          const result = await Api.egressFilterUnapply(policyId);
          if (result.retained === true || result.retained?.length) {
            setStatus('Shared filter retained for other active policies. This policy is still configured; use Emergency disable to remove it.', 'var(--orange)');
            Toast.warning('Other active policies still require the shared filter');
            return;
          }
          setStatus('Unapplied (policy config retained).', '#22c55e');
          Toast.success('Egress filter unapplied');
          setTimeout(() => { Modal.close(); onSaved && onSaved(); }, 600);
        } catch (e) {
          setStatus('Failed: ' + e.message, 'var(--red)');
          Toast.error(e.message);
        }
      });
      mc.querySelector('#ef-emergency-disable').addEventListener('click', async () => {
        if (!confirm('Disable this policy? Shared filters required by other active policies remain installed. Without another policy, the filter is removed and outbound access resumes.')) return;
        try {
          await Api.egressFilterUnapply(policyId);
          await Api.egressFilterDeletePolicy(policyId, 'emergency-disable');
          Toast.warning('Egress policy removed');
          Modal.close();
          onSaved && onSaved();
        } catch (e) { Toast.error(e.message); }
      });
    }
  },


};

if (typeof window !== 'undefined') window.SystemPageEgress = SystemPageEgress;
