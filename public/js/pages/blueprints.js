/* ═══════════════════════════════════════════════════
   pages/blueprints.js — Declarative Reconciler (v8.9.42)
   ═══════════════════════════════════════════════════ */
'use strict';

// Estate Blueprints: a Git-friendly JSON desired-state for host firewall rules.
// Capture from reality, plan (diff), apply (converge through the firewall lockout
// guard), export/import, enforce. Admin gates mutations. Alpha page → English.

const BlueprintsPage = {
  _list: [], _detail: null, _plan: null,

  async render(container) {
    this._isAdmin = (window.App && App.user && App.user.role) === 'admin';
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-diagram-project"></i> Reconciler <span class="badge badge-warning">alpha</span></h2>
          <div class="page-subtitle">Declarative desired-state for your firewall — capture, commit to Git, plan &amp; converge. No telemetry.</div>
        </div>
        <div class="page-actions" style="align-items:center">
          ${this._isAdmin ? '<button class="btn btn-sm btn-primary" id="bp-capture"><i class="fas fa-camera"></i> Capture state</button>' : ''}
          ${this._isAdmin ? '<button class="btn btn-sm btn-secondary" id="bp-import"><i class="fas fa-file-import"></i> Import</button>' : ''}
          <button class="btn btn-sm btn-secondary" id="bp-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="bp-content"><div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div></div>
    `;
    container.querySelector('#bp-refresh').addEventListener('click', () => this._load());
    container.querySelector('#bp-capture')?.addEventListener('click', () => this._capture());
    container.querySelector('#bp-import')?.addEventListener('click', () => this._importDialog());
    await this._load();
  },

  async _load() {
    const el = document.getElementById('bp-content');
    if (!el) return;
    try { const r = await Api.listBlueprints(); this._list = r.blueprints || []; this._renderList(); }
    catch (err) { el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`; }
  },

  _renderList() {
    const el = document.getElementById('bp-content');
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h3><i class="fas fa-list text-dim" style="margin-right:8px"></i>Blueprints</h3></div>
        <div class="card-body" style="padding:0">
          ${this._list.length === 0 ? '<div class="empty-msg">No blueprints yet. Use “Capture state” to bootstrap one from your current firewall rules, or Import a JSON from Git.</div>' : `
          <table class="data-table"><thead><tr><th>Name</th><th>Enforce</th><th>Last plan</th><th>Last apply</th><th></th></tr></thead>
          <tbody>${this._list.map(b => `
            <tr>
              <td><strong>${Utils.escapeHtml(b.name)}</strong>${b.description ? `<div class="text-sm text-dim">${Utils.escapeHtml(b.description)}</div>` : ''}</td>
              <td>${b.enforce ? '<span class="badge badge-warning">enforce</span>' : '<span class="text-dim">off</span>'}</td>
              <td class="text-sm text-dim">${Utils.escapeHtml(b.last_plan_at || '—')}</td>
              <td class="text-sm text-dim">${Utils.escapeHtml(b.last_apply_at || '—')}</td>
              <td style="text-align:right"><button class="btn btn-xs btn-secondary" data-bp-open="${b.id}">Open</button></td>
            </tr>`).join('')}</tbody></table>`}
        </div>
      </div>
      <div id="bp-detail" style="margin-top:16px"></div>
    `;
    el.querySelectorAll('[data-bp-open]').forEach(btn => btn.addEventListener('click', () => this._open(parseInt(btn.getAttribute('data-bp-open'), 10))));
    if (this._detail) { const d = this._list.find(b => b.id === this._detail.id); if (d) this._open(this._detail.id); }
  },

  async _open(id) {
    const el = document.getElementById('bp-detail');
    el.innerHTML = '<div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
    try { this._detail = await Api.getBlueprint(id); this._plan = null; this._renderDetail(); }
    catch (err) { el.innerHTML = `<div class="empty-msg">${Utils.escapeHtml(err.message)}</div>`; }
  },

  _renderDetail() {
    const b = this._detail;
    const el = document.getElementById('bp-detail');
    const hostCount = Object.keys((b.doc && b.doc.hosts) || {}).length;
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-file-code text-dim" style="margin-right:8px"></i>${Utils.escapeHtml(b.name)}</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-xs btn-primary" id="bpd-plan"><i class="fas fa-magnifying-glass"></i> Plan</button>
            ${this._isAdmin ? '<button class="btn btn-xs btn-secondary" id="bpd-apply"><i class="fas fa-play"></i> Apply</button>' : ''}
            <button class="btn btn-xs btn-secondary" id="bpd-export"><i class="fas fa-file-export"></i> Export</button>
            ${this._isAdmin ? `<button class="btn btn-xs btn-secondary" id="bpd-enforce"><i class="fas fa-lock"></i> Enforce: ${b.enforce ? 'ON' : 'OFF'}</button>` : ''}
            ${this._isAdmin ? '<button class="btn btn-xs btn-danger" id="bpd-del"><i class="fas fa-trash"></i></button>' : ''}
          </div>
        </div>
        <div class="card-body">
          <div class="text-sm text-dim" style="margin-bottom:8px">${hostCount} host(s) in this blueprint.</div>
          <div id="bpd-plan-out"></div>
          <details style="margin-top:12px"><summary style="cursor:pointer;font-size:13px">Blueprint JSON</summary>
            <pre class="inspect-json" style="max-height:320px;color:var(--text)">${Utils.escapeHtml(JSON.stringify(b.doc, null, 2))}</pre>
          </details>
          ${(b.runs && b.runs.length) ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px">History (${b.runs.length})</summary>
            <table class="data-table" style="margin-top:6px"><tbody>${b.runs.map(r => `<tr><td>${Utils.escapeHtml(r.kind)}</td><td class="text-sm text-dim">${Utils.escapeHtml(r.at)}</td><td class="text-sm text-dim">${Utils.escapeHtml(JSON.stringify(r.summary || {}))}</td><td class="text-sm text-dim">${Utils.escapeHtml(r.by)}</td></tr>`).join('')}</tbody></table>
          </details>` : ''}
        </div>
      </div>
    `;
    el.querySelector('#bpd-plan').addEventListener('click', () => this._runPlan());
    el.querySelector('#bpd-apply')?.addEventListener('click', () => this._apply());
    el.querySelector('#bpd-export')?.addEventListener('click', () => this._export());
    el.querySelector('#bpd-enforce')?.addEventListener('click', () => this._toggleEnforce());
    el.querySelector('#bpd-del')?.addEventListener('click', () => this._delete());
    if (this._plan) this._renderPlan();
  },

  async _runPlan() {
    const out = document.getElementById('bpd-plan-out');
    out.innerHTML = '<div class="text-dim text-sm"><i class="fas fa-spinner fa-spin"></i> Planning…</div>';
    try { this._plan = await Api.planBlueprint(this._detail.id); this._renderPlan(); }
    catch (err) { out.innerHTML = `<div class="alert alert-warning">${Utils.escapeHtml(err.message)}</div>`; }
  },

  _renderPlan() {
    const p = this._plan; const out = document.getElementById('bpd-plan-out');
    if (!out) return;
    const s = p.summary;
    const cStart = s.containerStart || 0;
    const inSync = s.create === 0 && s.remove === 0 && cStart === 0;
    out.innerHTML = `
      <div class="alert ${inSync ? '' : 'alert-warning'}" style="margin-bottom:10px${inSync ? ';background:var(--surface2)' : ''}">
        ${inSync ? '<i class="fas fa-circle-check" style="color:var(--green)"></i> In sync — reality matches the blueprint.'
          : `<i class="fas fa-triangle-exclamation"></i> Drift: <b>${s.create}</b> rule(s) to create, <b>${s.remove}</b> to remove${cStart ? `, <b>${cStart}</b> container(s) to start` : ''} across ${s.hosts} host(s).`}
        ${s.unreachable ? ` <span class="text-dim">(${s.unreachable} host(s) unreachable)</span>` : ''}
        ${s.containerMissing ? ` <span class="text-dim">(${s.containerMissing} declared container(s) not found)</span>` : ''}
      </div>
      ${Object.entries(p.hosts).map(([hid, h]) => {
        if (h.orphaned) return `<div class="text-sm text-dim">Host ${hid}: orphaned (no longer registered).</div>`;
        if (h.unreachable) return `<div class="text-sm" style="color:var(--yellow)">${Utils.escapeHtml(h.hostName)}: unreachable — ${Utils.escapeHtml(h.error || '')}</div>`;
        const rows = [
          ...(h.toCreate || []).map(r => ({ op: 'create', r })),
          ...(h.toRemove || []).map(r => ({ op: 'remove', r })),
        ];
        const c = h.containers || null;
        const cRows = c ? [...(c.toStart || []).map(x => ({ op: 'start', name: x.name })), ...(c.missing || []).map(x => ({ op: 'missing', name: x.name }))] : [];
        const inSyncN = (h.inSync || []).length + (c ? (c.running || []).length : 0);
        if (!rows.length && !cRows.length && !inSyncN) return '';
        return `<div style="margin-bottom:10px">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">${Utils.escapeHtml(h.hostName)} <span class="text-dim">(${inSyncN} in sync)</span></div>
          ${(rows.length || cRows.length) ? `<table class="data-table"><tbody>
            ${rows.map(x => `
            <tr>
              <td style="width:80px"><span class="badge ${x.op === 'create' ? 'badge-running' : 'badge-stopped'}">${x.op}</span></td>
              <td>fw: ${Utils.escapeHtml(x.r.action)} ${Utils.escapeHtml(x.r.scope)}</td>
              <td class="mono text-sm">${Utils.escapeHtml(x.r.source_ip || 'any')}${x.r.destination_port ? ':' + x.r.destination_port : ''}/${Utils.escapeHtml(x.r.protocol || 'tcp')}</td>
            </tr>`).join('')}
            ${cRows.map(x => `
            <tr>
              <td style="width:80px"><span class="badge ${x.op === 'start' ? 'badge-running' : 'badge-warning'}">${x.op}</span></td>
              <td>container</td>
              <td class="mono text-sm">${Utils.escapeHtml(x.name)}</td>
            </tr>`).join('')}
          </tbody></table>` : '<div class="text-dim text-sm">no changes</div>'}
        </div>`;
      }).join('')}
    `;
  },

  async _capture() {
    const result = await Modal.form(
      '<div class="form-group"><label>Name for the captured blueprint</label><input type="text" id="bpc-name" class="form-control" value="Captured estate"></div>',
      { title: 'Capture current state', width: '460px', onSubmit: (c) => ({ name: c.querySelector('#bpc-name').value.trim() }) }
    );
    if (!result) return;
    try { const bp = await Api.captureBlueprint(result.name || 'Captured estate'); Toast.success('Captured'); await this._load(); this._open(bp.id); }
    catch (err) { Toast.error(err.message); }
  },

  async _apply() {
    const ok = await Modal.confirm('Apply this blueprint? docker-dash will create/remove firewall rules to match it (through the lockout guard, with a snapshot first).', { danger: true, confirmText: 'Apply' });
    if (!ok) return;
    try {
      const r = await Api.applyBlueprint(this._detail.id);
      if (r && r.ok === false && r.error) { Toast.error(r.error); return; }
      Toast.success(`Applied ${r.applied}, removed ${r.removed}${r.started ? `, started ${r.started}` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
      await this._open(this._detail.id); this._runPlan();
    } catch (err) { Toast.error(err.message); }
  },

  _export() {
    const blob = new Blob([JSON.stringify(this._detail.doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `blueprint-${this._detail.id}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  async _toggleEnforce() {
    try { const bp = await Api.enforceBlueprint(this._detail.id, !this._detail.enforce); this._detail = bp; Toast.success(`Enforce ${bp.enforce ? 'ON' : 'OFF'}`); this._renderDetail(); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  async _delete() {
    const ok = await Modal.confirm('Delete this blueprint? (It does not touch the live firewall.)', { danger: true, confirmText: 'Delete' });
    if (!ok) return;
    try { await Api.deleteBlueprint(this._detail.id); this._detail = null; Toast.success('Deleted'); await this._load(); }
    catch (err) { Toast.error(err.message); }
  },

  async _importDialog() {
    const result = await Modal.form(`
      <div class="form-group"><label>Name</label><input type="text" id="bpi-name" class="form-control" placeholder="Imported blueprint"></div>
      <div class="form-group"><label>Blueprint JSON</label><textarea id="bpi-json" class="form-control" rows="10" placeholder='{ "version": 1, "hosts": { ... } }'></textarea></div>
      <div class="alert alert-warning" style="font-size:12px"><i class="fas fa-info-circle"></i> Every firewall rule is validated on import; the whole doc is rejected if any rule is invalid.</div>
    `, { title: 'Import blueprint', width: '620px', onSubmit: (c) => ({ name: c.querySelector('#bpi-name').value.trim(), json: c.querySelector('#bpi-json').value.trim() }) });
    if (!result) return;
    let doc;
    try { doc = JSON.parse(result.json); } catch (e) { Toast.error('Invalid JSON: ' + e.message); return; }
    try { const bp = await Api.importBlueprint({ name: result.name || 'Imported blueprint', doc }); Toast.success('Imported'); await this._load(); this._open(bp.id); }
    catch (err) { Toast.error(err.message); }
  },

  destroy() {},
};

window.BlueprintsPage = BlueprintsPage;
