/* ═══════════════════════════════════════════════════
   pages/firewall.js — Firewall management (MVP1, per-host)
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.22-alpha.1 — per-host firewall management over SSH or a firewall-agent.
// Whitelisted ops, strict validation + lockout guard server-side, snapshot before
// each change, full audit. Alpha page → direct English strings (like the vSphere
// page). No inline onclick; Utils.escapeHtml on all interpolation.

const FirewallPage = {
  _hosts: [], _hostId: null, _tab: 'rules', _status: null, _rules: null,

  async render(container) {
    try { this._hosts = (await Api.getHosts()) || []; } catch { this._hosts = []; }

    if (!this._hosts.length) {
      container.innerHTML = `<div class="page-header"><h2><i class="fas fa-shield-alt"></i> Firewall</h2></div>
        <div class="empty-msg">No hosts registered.</div>`;
      return;
    }
    const gid = Api.getHostId();
    if (this._hosts.some(h => h.id === gid)) this._hostId = gid;
    else if (!this._hostId || !this._hosts.some(h => h.id === this._hostId)) this._hostId = (this._hosts.find(h => h.isDefault) || this._hosts[0]).id;

    const sel = this._hosts.length > 1
      ? `<select id="fw-host" class="form-control" style="width:auto;display:inline-block;margin-right:8px">
           ${this._hosts.map(h => `<option value="${h.id}"${h.id === this._hostId ? ' selected' : ''}>${Utils.escapeHtml(h.name)}</option>`).join('')}
         </select>`
      : `<span class="text-muted" style="margin-right:8px">${Utils.escapeHtml(this._hosts[0].name)}</span>`;

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-shield-alt"></i> Firewall <span class="badge badge-warning">alpha</span></h2>
          <div class="page-subtitle">Per-host rules over SSH or a firewall-agent — whitelisted, audited, reversible.</div>
        </div>
        <div class="page-actions" style="align-items:center">
          ${sel}
          <button class="btn btn-sm btn-primary" id="fw-add"><i class="fas fa-plus"></i> Add rule</button>
          <button class="btn btn-sm btn-secondary" id="fw-snapshot" title="Save a snapshot of the current ruleset"><i class="fas fa-camera"></i></button>
          <button class="btn btn-sm btn-secondary" id="fw-agent" title="Configure firewall-agent for this host"><i class="fas fa-network-wired"></i></button>
          <button class="btn btn-sm btn-secondary" id="fw-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div class="tabs" style="margin-bottom:16px">
        <button class="tab ${this._tab === 'rules' ? 'active' : ''}" data-fw-tab="rules">Rules</button>
        <button class="tab ${this._tab === 'audit' ? 'active' : ''}" data-fw-tab="audit">History</button>
      </div>
      <div id="fw-content"><div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div></div>
    `;

    const hs = container.querySelector('#fw-host');
    if (hs) hs.addEventListener('change', (e) => { this._hostId = parseInt(e.target.value, 10); this._load(); });
    container.querySelector('#fw-refresh').addEventListener('click', () => this._load());
    container.querySelector('#fw-add').addEventListener('click', () => this._addRuleDialog());
    container.querySelector('#fw-snapshot').addEventListener('click', () => this._snapshot());
    container.querySelector('#fw-agent').addEventListener('click', () => this._agentDialog());
    container.querySelectorAll('[data-fw-tab]').forEach(b => b.addEventListener('click', (e) => {
      this._tab = e.target.getAttribute('data-fw-tab');
      container.querySelectorAll('[data-fw-tab]').forEach(x => x.classList.toggle('active', x === e.target));
      this._load();
    }));

    await this._load();
  },

  async _load() {
    const el = document.getElementById('fw-content');
    if (!el) return;
    el.innerHTML = `<div class="page-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    try {
      if (this._tab === 'audit') { this._renderAudit(el, await Api.fwAudit(this._hostId)); return; }
      const [status, rules] = await Promise.all([
        Api.fwStatus(this._hostId).catch(() => null),
        Api.fwRules(this._hostId).catch(() => null),
      ]);
      this._status = status; this._rules = rules;
      this._renderRules(el);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderRules(el) {
    const s = this._status || {};
    const r = this._rules || { rules: [], raw: '' };
    const backend = r.backend || s.backend;
    const channel = s.channel || r.channel || '?';
    const available = (s.available != null ? s.available : r.available);

    const statBadge = available
      ? `<span class="badge badge-running"><span class="badge-dot"></span>${Utils.escapeHtml(backend || 'active')}</span>`
      : `<span class="badge badge-stopped"><span class="badge-dot"></span>unavailable</span>`;

    const warn = [];
    if (!available) warn.push('No firewall backend detected on this host. For an SSH host it needs iptables/firewalld/ufw; for the local host use a firewall-agent (button above).');
    if (backend === 'ufw') warn.push('ufw is host-general only — it does NOT filter Docker published ports. Use an iptables host for container-scope rules.');

    const rules = (r.rules || []);
    el.innerHTML = `
      <div class="stat-cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
        ${this._card('fa-microchip', 'Backend', statBadge)}
        ${this._card('fa-plug', 'Channel', Utils.escapeHtml(channel))}
        ${this._card('fa-list-ol', 'App rules', String(rules.length))}
        ${this._card('fa-server', 'Daemon', Utils.escapeHtml(s.daemonType || '—'))}
      </div>
      ${warn.map(w => `<div class="alert alert-warning" style="margin-bottom:12px"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(w)}</div>`).join('')}

      <div class="card">
        <div class="card-header"><h3><i class="fas fa-list text-dim" style="margin-right:8px"></i>App-managed rules</h3></div>
        <div class="card-body" style="padding:0">
          ${rules.length === 0 ? '<div class="empty-msg">No app-managed rules on this host yet. Use “Add rule”.</div>' : `
          <table class="data-table">
            <thead><tr><th>Action</th><th>Scope</th><th>Source</th><th>Port</th><th>Proto</th><th>Backend</th><th>By</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              ${rules.map(rl => `
                <tr>
                  <td><span class="badge ${rl.action === 'allow' ? 'badge-running' : 'badge-stopped'}">${Utils.escapeHtml(rl.action)}</span></td>
                  <td>${Utils.escapeHtml(rl.scope)}</td>
                  <td class="mono text-sm">${Utils.escapeHtml(rl.source_ip || 'any')}</td>
                  <td class="mono">${rl.destination_port || 'any'}</td>
                  <td>${Utils.escapeHtml(rl.protocol || '—')}</td>
                  <td class="text-sm">${Utils.escapeHtml(rl.backend)}</td>
                  <td class="text-sm text-dim">${Utils.escapeHtml(rl.created_by || '')}</td>
                  <td class="text-sm text-dim">${Utils.escapeHtml(rl.reason || '')}</td>
                  <td><button class="action-btn danger" data-fw-remove="${Utils.escapeHtml(rl.rule_uuid)}" title="Remove rule"><i class="fas fa-trash"></i></button></td>
                </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
      </div>

      ${r.raw ? `<div class="card" style="margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-terminal text-dim" style="margin-right:8px"></i>Live host ruleset</h3>
          <span class="text-dim text-sm">${Utils.escapeHtml(backend || '')}</span></div>
        <div class="card-body"><pre class="inspect-json" style="max-height:320px;color:var(--text)">${Utils.escapeHtml(r.raw)}</pre></div>
      </div>` : ''}
    `;

    el.querySelectorAll('[data-fw-remove]').forEach(b => b.addEventListener('click', () => this._removeRule(b.getAttribute('data-fw-remove'))));
  },

  _renderAudit(el, data) {
    const rules = (data && data.rules) || [];
    const snaps = (data && data.snapshots) || [];
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h3><i class="fas fa-history text-dim" style="margin-right:8px"></i>Rule history</h3></div>
        <div class="card-body" style="padding:0">
          ${rules.length === 0 ? '<div class="empty-msg">No history.</div>' : `
          <table class="data-table">
            <thead><tr><th>Status</th><th>Action</th><th>Scope</th><th>Source</th><th>Port</th><th>Backend</th><th>By</th><th>Created</th><th>Removed</th></tr></thead>
            <tbody>${rules.map(rl => `
              <tr>
                <td><span class="badge ${rl.is_active ? 'badge-running' : 'badge-info'}">${rl.is_active ? 'active' : 'removed'}</span></td>
                <td>${Utils.escapeHtml(rl.action)}</td><td>${Utils.escapeHtml(rl.scope)}</td>
                <td class="mono text-sm">${Utils.escapeHtml(rl.source_ip || 'any')}</td>
                <td class="mono">${rl.destination_port || 'any'}</td>
                <td class="text-sm">${Utils.escapeHtml(rl.backend)}</td>
                <td class="text-sm text-dim">${Utils.escapeHtml(rl.created_by || '')}</td>
                <td class="text-sm text-dim">${Utils.escapeHtml(rl.created_at || '')}</td>
                <td class="text-sm text-dim">${Utils.escapeHtml(rl.removed_at || '')}</td>
              </tr>`).join('')}</tbody>
          </table>`}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-camera text-dim" style="margin-right:8px"></i>Snapshots</h3></div>
        <div class="card-body" style="padding:0">
          ${snaps.length === 0 ? '<div class="empty-msg">No snapshots.</div>' : `
          <table class="data-table">
            <thead><tr><th>ID</th><th>Backend</th><th>Created</th><th>By</th><th>Reason</th><th></th></tr></thead>
            <tbody>${snaps.map(sn => `
              <tr><td class="mono">${sn.id}</td><td>${Utils.escapeHtml(sn.backend)}</td>
              <td class="text-sm text-dim">${Utils.escapeHtml(sn.created_at || '')}</td>
              <td class="text-sm text-dim">${Utils.escapeHtml(sn.created_by || '')}</td>
              <td class="text-sm text-dim">${Utils.escapeHtml(sn.reason || '')}</td>
              <td><button class="btn btn-xs btn-secondary" data-fw-rollback="${sn.id}" title="Restore this snapshot (iptables)"><i class="fas fa-undo"></i> Rollback</button></td></tr>`).join('')}</tbody>
          </table>`}
        </div>
      </div>
    `;
    el.querySelectorAll('[data-fw-rollback]').forEach(b => b.addEventListener('click', () => this._rollback(parseInt(b.getAttribute('data-fw-rollback'), 10))));
  },

  _card(icon, label, valueHtml) {
    return `<div class="stat-card"><div class="stat-icon blue"><i class="fas ${icon}"></i></div>
      <div class="stat-body"><div class="stat-value" style="font-size:16px">${valueHtml}</div>
      <div class="stat-label">${label}</div></div></div>`;
  },

  async _addRuleDialog() {
    const result = await Modal.form(`
      <div class="form-row">
        <div class="form-group"><label>Action</label>
          <select id="fwd-action" class="form-control"><option value="allow">Allow</option><option value="block">Block</option></select></div>
        <div class="form-group"><label>Scope</label>
          <select id="fwd-scope" class="form-control"><option value="host">Host (INPUT)</option><option value="docker">Docker (DOCKER-USER)</option></select></div>
      </div>
      <div class="form-group"><label>Source IP / CIDR <span class="text-muted">(optional)</span></label>
        <input type="text" id="fwd-src" class="form-control" placeholder="89.40.10.20 or 10.0.0.0/8"></div>
      <div class="form-row">
        <div class="form-group"><label>Destination port <span class="text-muted">(optional)</span></label>
          <input type="number" id="fwd-port" class="form-control" placeholder="8082" min="1" max="65535"></div>
        <div class="form-group"><label>Protocol</label>
          <select id="fwd-proto" class="form-control"><option value="tcp">tcp</option><option value="udp">udp</option><option value="icmp">icmp</option></select></div>
      </div>
      <div class="form-group"><label>Reason</label><input type="text" id="fwd-reason" class="form-control" placeholder="Supplier support access"></div>
      <div class="alert alert-warning" style="font-size:12px"><i class="fas fa-info-circle"></i> Specify at least a source IP or a port. Blocking the SSH/management port for everyone is refused (lockout guard).</div>
    `, {
      title: 'Add firewall rule',
      width: '520px',
      onSubmit: (c) => {
        const spec = {
          action: c.querySelector('#fwd-action').value,
          scope: c.querySelector('#fwd-scope').value,
          source_ip: c.querySelector('#fwd-src').value.trim() || undefined,
          destination_port: c.querySelector('#fwd-port').value.trim() || undefined,
          protocol: c.querySelector('#fwd-proto').value,
          reason: c.querySelector('#fwd-reason').value.trim() || undefined,
        };
        if (!spec.source_ip && !spec.destination_port) { Toast.warning('Specify a source IP or a destination port'); return false; }
        return spec;
      },
    });
    if (!result) return;
    try {
      const r = await Api.fwAddRule(this._hostId, result);
      if (r && r.ok === false) { Toast.error(r.error || 'Failed to apply rule'); return; }
      Toast.success('Rule applied');
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _removeRule(uuid) {
    const ok = await Modal.confirm('Remove this firewall rule from the host?', { danger: true, confirmText: 'Remove' });
    if (!ok) return;
    try {
      const r = await Api.fwRemoveRule(this._hostId, uuid);
      if (r && r.ok === false) { Toast.error(r.error || 'Failed to remove'); return; }
      Toast.success('Rule removed');
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _snapshot() {
    try {
      const r = await Api.fwSnapshot(this._hostId, 'manual');
      if (r && r.ok === false) { Toast.error(r.error || 'Snapshot failed'); return; }
      Toast.success(`Snapshot #${r.id} saved (${r.backend})`);
    } catch (err) { Toast.error(err.message); }
  },

  async _rollback(snapId) {
    const ok = await Modal.confirm(`Restore snapshot #${snapId}? This replaces the host ruleset (iptables only in MVP1).`, { danger: true, confirmText: 'Rollback' });
    if (!ok) return;
    try {
      const r = await Api.fwRollback(this._hostId, snapId);
      if (r && r.ok === false) { Toast.error(r.error || 'Rollback failed'); return; }
      Toast.success('Rolled back');
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _agentDialog() {
    let cur = { configured: false, url: '' };
    try { cur = await Api.fwGetAgentConfig(this._hostId); } catch { /* ignore */ }
    const result = await Modal.form(`
      <p class="text-muted" style="font-size:13px">Point this host at a running <b>firewall-agent</b> (systemd service). When set, firewall ops for this host route through the agent instead of SSH. See <span class="mono">agent/firewall-agent/README.md</span>.</p>
      <div class="form-group"><label>Agent URL</label>
        <input type="text" id="fwa-url" class="form-control" placeholder="http://host.docker.internal:9090" value="${Utils.escapeHtml(cur.url || '')}"></div>
      <div class="form-group"><label>Token ${cur.configured ? '<span class="text-muted">(leave blank to keep current)</span>' : ''}</label>
        <input type="password" id="fwa-token" class="form-control" placeholder="the FW_AGENT_TOKEN value"></div>
      ${cur.configured ? '<div class="alert alert-warning" style="font-size:12px">An agent is already configured. Submit to update, or use Remove.</div>' : ''}
    `, {
      title: 'Configure firewall-agent',
      width: '520px',
      onSubmit: (c) => ({ url: c.querySelector('#fwa-url').value.trim(), token: c.querySelector('#fwa-token').value.trim() }),
    });
    if (!result) return;
    try {
      if (!result.url) { await Api.fwSetAgentConfig(this._hostId, { remove: true }); Toast.success('Agent removed'); }
      else { await Api.fwSetAgentConfig(this._hostId, result); Toast.success('Agent configured'); }
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  destroy() {},
};

window.FirewallPage = FirewallPage;
