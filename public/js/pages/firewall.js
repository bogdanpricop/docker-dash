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

    // RBAC (v8.9.28): viewer = read-only, operator = temporary rules + own
    // remove/extend + snapshot, admin = everything.
    const role = (window.App && App.user && App.user.role) || 'viewer';
    this._isAdmin = role === 'admin';
    this._canWrite = this._isAdmin || role === 'operator';
    // Non-Docker platforms (ESXi/Proxmox/Incus/LXD) are read-only here.
    this._container = container;
    const selHost0 = this._hosts.find(h => h.id === this._hostId);
    this._isPlatform = !!(selHost0 && ['vsphere', 'proxmox', 'incus', 'lxd'].includes(selHost0.daemonType));

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
          ${this._canWrite && !this._isPlatform ? `<button class="btn btn-sm btn-primary" id="fw-add"><i class="fas fa-plus"></i> Add rule</button>` : ''}
          ${this._canWrite && !this._isPlatform ? `<button class="btn btn-sm btn-secondary" id="fw-snapshot" title="Save a snapshot of the current ruleset"><i class="fas fa-camera"></i></button>` : ''}
          ${this._isAdmin && !this._isPlatform ? `<button class="btn btn-sm btn-secondary" id="fw-sudo" title="Set a sudo password (for key-auth SSH hosts whose user needs sudo)"><i class="fas fa-user-shield"></i></button>` : ''}
          ${this._isAdmin && !this._isPlatform ? `<button class="btn btn-sm btn-secondary" id="fw-agent" title="Configure firewall-agent for this host"><i class="fas fa-network-wired"></i></button>` : ''}
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
    if (hs) hs.addEventListener('change', (e) => { this._hostId = parseInt(e.target.value, 10); this._syncHeaderForHost(); this._load(); });
    container.querySelector('#fw-refresh').addEventListener('click', () => this._load());
    container.querySelector('#fw-add')?.addEventListener('click', () => this._addRuleDialog());
    container.querySelector('#fw-snapshot')?.addEventListener('click', () => this._snapshot());
    container.querySelector('#fw-agent')?.addEventListener('click', () => this._agentDialog());
    container.querySelector('#fw-sudo')?.addEventListener('click', () => this._sudoDialog());
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

  _syncHeaderForHost() {
    const h = this._hosts.find(x => x.id === this._hostId);
    this._isPlatform = !!(h && ['vsphere', 'proxmox', 'incus', 'lxd'].includes(h.daemonType));
    const setDisp = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
    setDisp('fw-add', this._canWrite && !this._isPlatform);
    setDisp('fw-snapshot', this._canWrite && !this._isPlatform);
    setDisp('fw-agent', this._isAdmin && !this._isPlatform);
    setDisp('fw-sudo', this._isAdmin && !this._isPlatform);
  },

  async _sudoDialog() {
    let cur = { configured: false };
    try { cur = await Api.fwGetSudoConfig(this._hostId); } catch { /* ignore */ }
    const result = await Modal.form(`
      <p class="text-muted" style="font-size:13px">For SSH hosts that authenticate by <b>key</b> but whose user needs <b>sudo</b> (and sudo asks for a password), store that password here. docker-dash feeds it to <span class="mono">sudo -S</span> over stdin — never on the command line, never logged, encrypted at rest.</p>
      <p class="text-muted" style="font-size:12px">More secure alternative: give the SSH user passwordless sudo scoped to the firewall binaries (see the “no firewall” hint), and leave this empty.</p>
      <div class="form-group"><label>Sudo password ${cur.configured ? '<span class="badge badge-running">stored</span>' : ''}</label>
        <input type="password" id="fws-pw" class="form-control" placeholder="${cur.configured ? '•••••• (leave blank to keep)' : 'the account/sudo password'}"></div>
      ${cur.configured ? '<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="fws-clear"> Clear the stored sudo password</label>' : ''}
    `, {
      title: 'Sudo password',
      width: '520px',
      onSubmit: (c) => ({ password: c.querySelector('#fws-pw').value, clear: !!(c.querySelector('#fws-clear') && c.querySelector('#fws-clear').checked) }),
    });
    if (!result) return;
    try {
      if (result.clear) { await Api.fwSetSudoConfig(this._hostId, { remove: true }); Toast.success('Sudo password cleared'); }
      else if (result.password) { await Api.fwSetSudoConfig(this._hostId, { password: result.password }); Toast.success('Sudo password saved'); }
      else { return; }
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _platformCanWrite(pf) { return !!(pf && pf.writesSupported && this._isAdmin); },

  _renderPlatform(el, pf) {
    const badgeClass = pf.available ? 'badge-running' : 'badge-warning';
    const groups = pf.groups || [];
    const canWrite = this._platformCanWrite(pf);
    const isEsxi = pf.platform === 'esxi';
    el.innerHTML = `
      <div id="fw-pending-banner"></div>
      ${canWrite
        ? `<div class="alert alert-warning" style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
             <span style="flex:1"><i class="fas fa-shield-halved"></i> Write-enabled (${Utils.escapeHtml((pf.platform || '').toUpperCase())}). Every change is applied <b>provisionally</b> and <b>auto-reverts</b> unless you confirm it — a bad rule can't lock you out permanently.${isEsxi ? ' Use the per-ruleset controls (enable/disable, allowed IPs, allowed-all).' : ''}</span>
             ${isEsxi ? '' : '<button class="btn btn-sm btn-primary" id="fw-plat-add"><i class="fas fa-plus"></i> Add firewall rule</button>'}
           </div>`
        : `<div class="alert" style="margin-bottom:12px;background:var(--surface2)"><i class="fas fa-eye"></i> Read-only view — ${Utils.escapeHtml((pf.platform || '').toUpperCase())} manages its firewall in its native tool (esxcli / pve-firewall / incus network acl).</div>`}
      <div class="stat-cards" style="grid-template-columns:repeat(2,1fr);margin-bottom:16px">
        ${this._card('fa-shield-alt', 'Platform', `<span class="badge ${badgeClass}"><span class="badge-dot"></span>${Utils.escapeHtml(pf.platform || '')}</span>`)}
        ${this._card('fa-info-circle', 'Status', Utils.escapeHtml(pf.summary || ''))}
      </div>
      ${pf.trustHint ? `<div class="alert alert-warning" style="margin-bottom:12px"><i class="fas fa-user-lock"></i> ${Utils.escapeHtml(pf.summary)} <a href="#/incus-instances">Open Instances →</a></div>` : ''}
      ${(!pf.available && !pf.trustHint) ? `<div class="alert alert-warning" style="margin-bottom:12px">${Utils.escapeHtml(pf.summary || 'Unavailable')}</div>` : ''}
      ${groups.map(g => `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header"><h3><i class="fas fa-list text-dim" style="margin-right:8px"></i>${Utils.escapeHtml(g.title)}</h3><span class="text-dim text-sm">${(g.items || []).length}</span></div>
          <div class="card-body" style="padding:0">
            ${(g.items || []).length === 0 ? '<div class="empty-msg">None.</div>' : `
            <table class="data-table"><thead><tr><th>Rule</th><th>State</th><th>Detail</th>${canWrite ? '<th></th>' : ''}</tr></thead>
            <tbody>${g.items.map(it => `
              <tr>
                <td class="mono text-sm">${Utils.escapeHtml(it.name || '')}</td>
                <td>${it.enabled === false ? '<span class="badge badge-info">off</span>' : '<span class="badge badge-running">on</span>'}</td>
                <td class="text-sm text-dim">${Utils.escapeHtml(it.detail || '')}</td>
                ${canWrite ? `<td style="white-space:nowrap;text-align:right">${it.esxi
                  ? `<button class="action-btn" title="${it.enabled === false ? 'Enable' : 'Disable'} this ruleset (provisional)" data-fw-esxi-toggle="1" data-fw-rs="${Utils.escapeHtml(it.rulesetId || '')}" data-fw-enabled="${it.enabled === false ? '0' : '1'}"><i class="fas fa-power-off"></i></button>
                     <button class="action-btn" title="Add an allowed IP (provisional)" data-fw-esxi-addip="1" data-fw-rs="${Utils.escapeHtml(it.rulesetId || '')}"><i class="fas fa-plus"></i></button>
                     <button class="action-btn" title="Remove an allowed IP (provisional)" data-fw-esxi-removeip="1" data-fw-rs="${Utils.escapeHtml(it.rulesetId || '')}" data-fw-ips="${Utils.escapeHtml((it.allowedIps || []).join(','))}"><i class="fas fa-minus"></i></button>
                     <button class="action-btn" title="Toggle allowed-all (provisional)" data-fw-esxi-allowedall="1" data-fw-rs="${Utils.escapeHtml(it.rulesetId || '')}" data-fw-allowedall="${it.allowedAll ? '1' : '0'}"><i class="fas fa-globe"></i></button>`
                  : (it.removable
                    ? `<button class="action-btn danger" title="Remove this rule (provisional, auto-reverts unless confirmed)" data-fw-plat-remove="1" data-fw-pos="${Utils.escapeHtml(String(it.pos))}" data-fw-scope="${Utils.escapeHtml(it.scope || '')}" data-fw-node="${Utils.escapeHtml(it.node || '')}"><i class="fas fa-times"></i></button>`
                    : '<span class="text-dim">—</span>')}</td>` : ''}
              </tr>`).join('')}</tbody></table>`}
          </div>
        </div>`).join('')}
      ${pf.raw ? `<div class="card"><div class="card-header"><h3><i class="fas fa-terminal text-dim" style="margin-right:8px"></i>Raw</h3></div><div class="card-body"><pre class="inspect-json" style="max-height:300px;color:var(--text)">${Utils.escapeHtml(pf.raw)}</pre></div></div>` : ''}
    `;

    if (canWrite) {
      el.querySelector('#fw-plat-add')?.addEventListener('click', () => this._addPlatformRuleDialog(pf));
      el.querySelectorAll('[data-fw-plat-remove]').forEach(b => b.addEventListener('click', () => this._removePlatformRule({
        pos: parseInt(b.getAttribute('data-fw-pos'), 10),
        scope: b.getAttribute('data-fw-scope'),
        node: b.getAttribute('data-fw-node') || undefined,
      })));
      // ESXi per-ruleset controls (Phase B).
      el.querySelectorAll('[data-fw-esxi-toggle]').forEach(b => b.addEventListener('click', () =>
        this._esxiToggleRuleset(b.getAttribute('data-fw-rs'), b.getAttribute('data-fw-enabled') === '1')));
      el.querySelectorAll('[data-fw-esxi-addip]').forEach(b => b.addEventListener('click', () =>
        this._esxiAddAllowedIp(b.getAttribute('data-fw-rs'))));
      el.querySelectorAll('[data-fw-esxi-removeip]').forEach(b => b.addEventListener('click', () =>
        this._esxiRemoveAllowedIp(b.getAttribute('data-fw-rs'), (b.getAttribute('data-fw-ips') || '').split(',').filter(Boolean))));
      el.querySelectorAll('[data-fw-esxi-allowedall]').forEach(b => b.addEventListener('click', () =>
        this._esxiToggleAllowedAll(b.getAttribute('data-fw-rs'), b.getAttribute('data-fw-allowedall') === '1')));
      // Live commit-confirmed countdown banner (fetch now + start the 1s poller).
      this._renderPendingBanner();
      this._refreshPending();
      this._startPendingPoll();
    } else {
      this._stopPendingPoll();
      this._pendingChanges = [];
    }
  },

  // ── Platform (hypervisor) commit-confirmed write flow (v8.11, Proxmox) ──
  _parseSqlUtc(s) {
    if (!s) return 0;
    // SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS" (no tz marker).
    const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
    return Number.isNaN(t) ? 0 : t;
  },

  _describeChange(ch) {
    const s = ch.spec || {};
    const scope = ch.scope || '';
    if (ch.operation === 'add-rule' && s.rule) {
      const r = s.rule;
      return `add ${r.type} ${r.action}${r.proto ? ' ' + r.proto : ''}${r.dport ? ' dport ' + r.dport : ''}${r.source ? ' from ' + r.source : ''} on ${scope}`;
    }
    if (ch.operation === 'remove-rule') return `remove rule #${s.pos} on ${scope}`;
    if (ch.operation === 'set-options') return `set firewall options on ${scope}`;
    // ESXi (Phase B) — ruleset-based operations.
    if (ch.operation === 'ruleset-set-enabled') return `${s.enabled ? 'enable' : 'disable'} ruleset ${s.rulesetId || scope}`;
    if (ch.operation === 'ruleset-set-allowedall') return `set allowed-all=${s.allowedAll} on ruleset ${s.rulesetId || scope}`;
    if (ch.operation === 'allowedip-add') return `allow IP ${s.ipAddress} on ruleset ${s.rulesetId || scope}`;
    if (ch.operation === 'allowedip-remove') return `remove allowed IP ${s.ipAddress} from ruleset ${s.rulesetId || scope}`;
    return `${ch.operation} on ${scope}`;
  },

  _fmtRemaining(sec) {
    const s = Math.max(0, sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },

  _renderPendingBanner() {
    const el = document.getElementById('fw-pending-banner');
    if (!el) return;
    const pend = this._pendingChanges || [];
    if (!pend.length) { el.innerHTML = ''; return; }
    const now = Date.now();
    el.innerHTML = pend.map(ch => {
      const remaining = Math.floor((this._parseSqlUtc(ch.revert_at) - now) / 1000);
      return `<div class="alert alert-warning" style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="flex:1"><i class="fas fa-hourglass-half"></i> <b>Change applied provisionally</b> — auto-reverts in <b class="mono" data-fw-countdown="${ch.id}">${this._fmtRemaining(remaining)}</b> unless confirmed. <span class="text-dim">${Utils.escapeHtml(this._describeChange(ch))}</span></span>
        <button class="btn btn-xs btn-primary" data-fw-confirm="${ch.id}"><i class="fas fa-check"></i> Confirm</button>
        <button class="btn btn-xs btn-danger" data-fw-revert="${ch.id}"><i class="fas fa-undo"></i> Revert now</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-fw-confirm]').forEach(b => b.addEventListener('click', () => this._confirmChange(parseInt(b.getAttribute('data-fw-confirm'), 10))));
    el.querySelectorAll('[data-fw-revert]').forEach(b => b.addEventListener('click', () => this._revertChange(parseInt(b.getAttribute('data-fw-revert'), 10))));
  },

  async _refreshPending() {
    if (!this._isPlatform) { this._pendingChanges = []; this._renderPendingBanner(); return; }
    try {
      const r = await Api.fwPendingChanges(this._hostId);
      this._pendingChanges = (r && r.pending) || [];
    } catch { this._pendingChanges = this._pendingChanges || []; }
    this._renderPendingBanner();
  },

  _startPendingPoll() {
    this._stopPendingPoll();
    this._pendingTick = 0;
    this._pendingTimer = setInterval(() => {
      this._pendingTick++;
      const now = Date.now();
      let refresh = (this._pendingTick % 5 === 0);
      (this._pendingChanges || []).forEach(ch => {
        const span = document.querySelector(`[data-fw-countdown="${ch.id}"]`);
        if (!span) return;
        const remaining = Math.floor((this._parseSqlUtc(ch.revert_at) - now) / 1000);
        if (remaining <= 0) refresh = true;
        span.textContent = this._fmtRemaining(remaining);
      });
      // Stop polling if there's nothing pending and the banner element is gone.
      if (!document.getElementById('fw-pending-banner')) { this._stopPendingPoll(); return; }
      if (refresh) this._refreshPending();
    }, 1000);
  },

  _stopPendingPoll() { if (this._pendingTimer) { clearInterval(this._pendingTimer); this._pendingTimer = null; } },

  async _addPlatformRuleDialog(pf) {
    const nodeName = (pf && pf.node) ? pf.node : '';
    const result = await Modal.form(`
      <div class="form-row">
        <div class="form-group"><label>Direction</label>
          <select id="fwp-type" class="form-control"><option value="in">in (inbound)</option><option value="out">out (outbound)</option></select></div>
        <div class="form-group"><label>Action</label>
          <select id="fwp-action" class="form-control"><option value="ACCEPT">ACCEPT</option><option value="DROP">DROP</option><option value="REJECT">REJECT</option></select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Source IP / CIDR <span class="text-muted">(optional)</span></label>
          <input type="text" id="fwp-src" class="form-control" placeholder="89.40.10.20 or 10.0.0.0/8"></div>
        <div class="form-group"><label>Destination IP / CIDR <span class="text-muted">(optional)</span></label>
          <input type="text" id="fwp-dest" class="form-control" placeholder="10.0.0.5"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Protocol</label>
          <select id="fwp-proto" class="form-control"><option value="">any</option><option value="tcp">tcp</option><option value="udp">udp</option><option value="icmp">icmp</option></select></div>
        <div class="form-group"><label>Destination port <span class="text-muted">(single or n:m range)</span></label>
          <input type="text" id="fwp-dport" class="form-control" placeholder="8006 or 8000:8010"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Scope</label>
          <select id="fwp-scope" class="form-control"><option value="cluster">Cluster</option><option value="node">Node</option></select></div>
        <div class="form-group"><label>Node <span class="text-muted">(when scope = node)</span></label>
          <input type="text" id="fwp-node" class="form-control" placeholder="${Utils.escapeHtml(nodeName)}" value="${Utils.escapeHtml(nodeName)}"></div>
      </div>
      <div class="form-group"><label>Comment</label><input type="text" id="fwp-comment" class="form-control" placeholder="Supplier support access"></div>
      <div class="alert alert-warning" style="font-size:12px"><i class="fas fa-triangle-exclamation"></i> The lockout guard refuses a DROP/REJECT that would drop SSH (22) / PVE web (8006) for everyone, and refuses enabling the firewall without an ACCEPT protecting your IP. This change applies provisionally and auto-reverts unless you confirm it.</div>
    `, {
      title: 'Add Proxmox firewall rule',
      width: '560px',
      onSubmit: (c) => {
        const scope = c.querySelector('#fwp-scope').value;
        const spec = {
          type: c.querySelector('#fwp-type').value,
          action: c.querySelector('#fwp-action').value,
          source: c.querySelector('#fwp-src').value.trim() || undefined,
          dest: c.querySelector('#fwp-dest').value.trim() || undefined,
          proto: c.querySelector('#fwp-proto').value || undefined,
          dport: c.querySelector('#fwp-dport').value.trim() || undefined,
          comment: c.querySelector('#fwp-comment').value.trim() || undefined,
          scope,
          node: scope === 'node' ? (c.querySelector('#fwp-node').value.trim() || undefined) : undefined,
        };
        if (!spec.dport && !spec.source && !spec.dest) { Toast.warning('Specify at least a destination port, a source, or a destination'); return false; }
        if (spec.scope === 'node' && !spec.node) { Toast.warning('Enter the node name for node scope'); return false; }
        return spec;
      },
    });
    if (!result) return;
    const summary = `${Utils.escapeHtml(result.type)} <b>${Utils.escapeHtml(result.action)}</b>${result.proto ? ' ' + Utils.escapeHtml(result.proto) : ''}${result.dport ? ' dport ' + Utils.escapeHtml(result.dport) : ''}<br>Source: ${Utils.escapeHtml(result.source || 'any')} → Dest: ${Utils.escapeHtml(result.dest || 'any')}<br>Scope: ${result.scope === 'node' ? 'node ' + Utils.escapeHtml(result.node) : 'cluster'}`;
    const ok = await Modal.confirm(
      `<p>Apply this firewall change to the Proxmox host?</p><p class="mono text-sm" style="background:var(--surface2);padding:10px;border-radius:6px">${summary}</p><p class="text-sm text-dim">It applies <b>provisionally</b> and auto-reverts unless you confirm it in time.</p>`,
      { title: 'Confirm firewall change', html: true, danger: result.action !== 'ACCEPT', confirmText: 'Apply provisionally' }
    );
    if (!ok) return;
    try {
      const r = await Api.fwAddRule(this._hostId, result);
      if (r && r.ok === false) { Toast.error(r.error || 'Failed to apply rule'); return; }
      Toast.success('Change applied provisionally — confirm it before the timer runs out');
      await this._refreshPending();
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _removePlatformRule({ pos, scope, node }) {
    const ok = await Modal.confirm(
      `<p>Remove firewall rule <b>#${pos}</b> on <b>${Utils.escapeHtml(scope === 'node' ? 'node ' + (node || '') : 'cluster')}</b>?</p><p class="text-sm text-dim">It applies <b>provisionally</b> and auto-reverts (re-creates the rule) unless you confirm it in time.</p>`,
      { title: 'Remove firewall rule', html: true, danger: true, confirmText: 'Remove provisionally' }
    );
    if (!ok) return;
    try {
      const r = await Api.fwRemoveRule(this._hostId, null, { pos, scope, node });
      if (r && r.ok === false) { Toast.error(r.error || 'Failed to remove'); return; }
      Toast.success('Removal applied provisionally — confirm it before the timer runs out');
      await this._refreshPending();
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  // ── ESXi (Phase B) per-ruleset write controls ──
  // Every ESXi mutation runs through the SAME commit-confirmed pipeline: it is
  // applied provisionally and auto-reverts unless confirmed. Each control shows a
  // confirm dialog first, then posts an esxi-shaped body to the apply route.
  async _esxiApply(body, summaryHtml, danger) {
    const ok = await Modal.confirm(
      `<p>Apply this ESXi firewall change?</p><p class="mono text-sm" style="background:var(--surface2);padding:10px;border-radius:6px">${summaryHtml}</p><p class="text-sm text-dim">It applies <b>provisionally</b> and auto-reverts unless you confirm it in time. The lockout guard refuses any change that would cut off SSH access for your IP.</p>`,
      { title: 'Confirm ESXi firewall change', html: true, danger: !!danger, confirmText: 'Apply provisionally' }
    );
    if (!ok) return;
    try {
      const r = await Api.fwAddRule(this._hostId, body);
      if (r && r.ok === false) { Toast.error(r.error || 'Failed to apply change'); return; }
      Toast.success('Change applied provisionally — confirm it before the timer runs out');
      await this._refreshPending();
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _esxiToggleRuleset(rulesetId, currentEnabled) {
    const next = !currentEnabled;
    const summary = `${next ? 'Enable' : 'Disable'} ruleset <b>${Utils.escapeHtml(rulesetId)}</b>`;
    return this._esxiApply(
      { operation: 'ruleset-set-enabled', rulesetId, enabled: next },
      summary, !next // disabling is the dangerous direction
    );
  },

  async _esxiToggleAllowedAll(rulesetId, currentAllowedAll) {
    const next = !currentAllowedAll;
    const summary = `Set <b>allowed-all=${next}</b> on ruleset <b>${Utils.escapeHtml(rulesetId)}</b>`;
    return this._esxiApply(
      { operation: 'ruleset-set-allowedall', rulesetId, allowedAll: next },
      summary, !next // restricting (allowed-all=false) is the dangerous direction
    );
  },

  async _esxiAddAllowedIp(rulesetId) {
    const result = await Modal.form(`
      <div class="form-group"><label>Allowed IP / CIDR</label>
        <input type="text" id="fwe-ip" class="form-control" placeholder="89.40.10.20 or 10.0.0.0/24"></div>
      <p class="text-muted" style="font-size:12px">Adds the IP/range to ruleset <b>${Utils.escapeHtml(rulesetId)}</b>'s allowed list.</p>
    `, {
      title: `Add allowed IP — ${rulesetId}`,
      width: '460px',
      onSubmit: (c) => {
        const ip = c.querySelector('#fwe-ip').value.trim();
        if (!ip) { Toast.warning('Enter an IP or CIDR'); return false; }
        return { ip };
      },
    });
    if (!result) return;
    const summary = `Allow <b>${Utils.escapeHtml(result.ip)}</b> on ruleset <b>${Utils.escapeHtml(rulesetId)}</b>`;
    return this._esxiApply({ operation: 'allowedip-add', rulesetId, ipAddress: result.ip }, summary, false);
  },

  async _esxiRemoveAllowedIp(rulesetId, ips) {
    if (!ips || !ips.length) { Toast.warning('This ruleset has no explicit allowed IPs to remove (it is allowed-all).'); return; }
    const result = await Modal.form(`
      <div class="form-group"><label>Allowed IP to remove</label>
        <select id="fwe-ip" class="form-control">${ips.map(ip => `<option value="${Utils.escapeHtml(ip)}">${Utils.escapeHtml(ip)}</option>`).join('')}</select></div>
      <p class="text-muted" style="font-size:12px">Removes the IP/range from ruleset <b>${Utils.escapeHtml(rulesetId)}</b>'s allowed list. The lockout guard refuses removing the entry that covers your own IP on the SSH ruleset.</p>
    `, {
      title: `Remove allowed IP — ${rulesetId}`,
      width: '460px',
      onSubmit: (c) => ({ ip: c.querySelector('#fwe-ip').value }),
    });
    if (!result || !result.ip) return;
    const summary = `Remove allowed IP <b>${Utils.escapeHtml(result.ip)}</b> from ruleset <b>${Utils.escapeHtml(rulesetId)}</b>`;
    return this._esxiApply({ operation: 'allowedip-remove', rulesetId, ipAddress: result.ip }, summary, true);
  },

  async _confirmChange(changeId) {
    const ok = await Modal.confirm('Confirm this change and cancel its auto-revert? Only confirm once you have verified you still have access to the host.', { confirmText: 'Confirm change' });
    if (!ok) return;
    try {
      const r = await Api.fwConfirmChange(this._hostId, changeId);
      if (r && r.ok === false) { Toast.error(r.error || 'Confirm failed'); return; }
      Toast.success('Change confirmed');
      await this._refreshPending();
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _revertChange(changeId) {
    const ok = await Modal.confirm('Revert this change now (restore the pre-change state)?', { danger: true, confirmText: 'Revert now' });
    if (!ok) return;
    try {
      const r = await Api.fwRevertChange(this._hostId, changeId);
      if (r && r.ok === false) { Toast.error(r.error || 'Revert failed'); return; }
      Toast.success('Change reverted');
      await this._refreshPending();
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _renderRules(el) {
    const r = this._rules || {};
    if (r.readOnly && r.platform) { this._renderPlatform(el, r.platform); return; }
    const s = this._status || {};
    const backend = r.backend || s.backend;
    const channel = s.channel || r.channel || '?';
    const available = (s.available != null ? s.available : r.available);

    const statBadge = available
      ? `<span class="badge badge-running"><span class="badge-dot"></span>${Utils.escapeHtml(backend || 'active')}</span>`
      : `<span class="badge badge-stopped"><span class="badge-dot"></span>unavailable</span>`;

    const drift = (r.drift || []);
    const warn = [];
    if (!available) warn.push('No readable firewall on this host. Firewall commands need root — docker-dash auto-adds /usr/sbin to PATH and tries "sudo -n", so the SSH user must be root OR have passwordless sudo for iptables/nft/ufw (e.g. sudoers: "<user> ALL=(root) NOPASSWD: /usr/sbin/iptables, /usr/sbin/nft, /usr/sbin/ufw, /usr/sbin/iptables-save, /usr/sbin/iptables-restore"). Alternatively install the firewall-agent. (For the local host, the container can\'t reach the host firewall at all — use the agent.)');
    if (['ufw', 'nftables', 'windows'].includes(backend)) warn.push(`${backend} is host-only — it does NOT filter Docker published ports. Use an iptables host for container-scope rules.`);

    const rules = (r.rules || []);
    el.innerHTML = `
      <div class="stat-cards" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
        ${this._card('fa-microchip', 'Backend', statBadge)}
        ${this._card('fa-plug', 'Channel', Utils.escapeHtml(channel))}
        ${this._card('fa-list-ol', 'App rules', String(rules.length))}
        ${this._card('fa-server', 'Daemon', Utils.escapeHtml(s.daemonType || '—'))}
      </div>
      ${warn.map(w => `<div class="alert alert-warning" style="margin-bottom:12px"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(w)}</div>`).join('')}
      ${drift.length ? `<div class="alert alert-warning" style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span><i class="fas fa-triangle-exclamation"></i> <b>${drift.length}</b> app-managed rule(s) are missing on the host (removed manually or lost on restart).</span>
        ${this._isAdmin ? '<button class="btn btn-xs btn-primary" id="fw-reconcile" style="margin-left:auto"><i class="fas fa-rotate"></i> Re-apply missing</button>' : ''}
      </div>` : ''}

      <div class="card">
        <div class="card-header"><h3><i class="fas fa-list text-dim" style="margin-right:8px"></i>App-managed rules</h3></div>
        <div class="card-body" style="padding:0">
          ${rules.length === 0 ? '<div class="empty-msg">No app-managed rules on this host yet. Use “Add rule”.</div>' : `
          <table class="data-table">
            <thead><tr><th>Action</th><th>Scope</th><th>Source</th><th>Port</th><th>Proto</th><th>Backend</th><th>By</th><th>Expires</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              ${rules.map(rl => `
                <tr${rl._present === false ? ' style="opacity:.6"' : ''}>
                  <td><span class="badge ${rl.action === 'allow' ? 'badge-running' : 'badge-stopped'}">${Utils.escapeHtml(rl.action)}</span>${rl._present === false ? ' <span class="badge badge-warning" title="Not present on the host">drift</span>' : ''}</td>
                  <td>${Utils.escapeHtml(rl.scope)}</td>
                  <td class="mono text-sm">${Utils.escapeHtml(rl.source_ip || 'any')}</td>
                  <td class="mono">${rl.destination_port || 'any'}</td>
                  <td>${Utils.escapeHtml(rl.protocol || '—')}</td>
                  <td class="text-sm">${Utils.escapeHtml(rl.backend)}</td>
                  <td class="text-sm text-dim">${Utils.escapeHtml(rl.created_by || '')}</td>
                  <td class="text-sm">${rl.is_temporary ? `<span class="badge badge-warning" title="Auto-removed at ${Utils.escapeHtml(rl.expires_at || '')}"><i class="fas fa-clock"></i> ${Utils.escapeHtml(rl.expires_at || 'temp')}</span>` : '<span class="text-dim">—</span>'}</td>
                  <td class="text-sm text-dim">${Utils.escapeHtml(rl.reason || '')}</td>
                  <td style="white-space:nowrap">
                    ${this._canWrite && rl.is_temporary ? `<button class="action-btn" data-fw-extend="${Utils.escapeHtml(rl.rule_uuid)}" title="Extend expiry"><i class="fas fa-clock"></i></button>` : ''}
                    ${this._canWrite ? `<button class="action-btn danger" data-fw-remove="${Utils.escapeHtml(rl.rule_uuid)}" title="Remove rule"><i class="fas fa-trash"></i></button>` : '<span class="text-dim">—</span>'}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
      </div>

      ${r.raw ? `<div class="card" style="margin-top:16px">
        <div class="card-header"><h3><i class="fas fa-terminal text-dim" style="margin-right:8px"></i>Live host ruleset</h3>
          <span class="text-dim text-sm">${Utils.escapeHtml(backend || '')}${r.otherRules != null ? ` · ${r.otherRules} non-app rule(s) (incl. Docker/system)` : ''}</span></div>
        <div class="card-body"><pre class="inspect-json" style="max-height:320px;color:var(--text)">${Utils.escapeHtml(r.raw)}</pre></div>
      </div>` : ''}
    `;

    el.querySelectorAll('[data-fw-remove]').forEach(b => b.addEventListener('click', () => this._removeRule(b.getAttribute('data-fw-remove'))));
    el.querySelectorAll('[data-fw-extend]').forEach(b => b.addEventListener('click', () => this._extendRule(b.getAttribute('data-fw-extend'))));
    const rec = el.querySelector('#fw-reconcile');
    if (rec) rec.addEventListener('click', () => this._reconcile());
  },

  async _reconcile() {
    const ok = await Modal.confirm('Re-apply all app-managed rules that are missing on this host?', { confirmText: 'Re-apply' });
    if (!ok) return;
    try {
      const r = await Api.fwReconcile(this._hostId);
      if (r && r.ok === false) { Toast.error(r.error || 'Reconcile failed'); return; }
      Toast.success(`Re-applied ${r.reapplied}/${r.total}${r.failed ? `, ${r.failed} failed` : ''}`);
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  async _extendRule(uuid) {
    const result = await Modal.form(
      `<div class="form-group"><label>Extend expiry by (minutes from now)</label>
        <input type="number" id="fwe-min" class="form-control" value="120" min="1" max="10080"></div>`,
      { title: 'Extend temporary rule', width: '420px', onSubmit: (c) => ({ minutes: parseInt(c.querySelector('#fwe-min').value, 10) }) }
    );
    if (!result || !result.minutes) return;
    try {
      const r = await Api.fwExtendRule(this._hostId, uuid, result.minutes);
      if (r && r.ok === false) { Toast.error(r.error || 'Extend failed'); return; }
      Toast.success('Expiry extended');
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _renderAudit(el, data) {
    this._auditData = data;
    const rules = (data && data.rules) || [];
    const snaps = (data && data.snapshots) || [];
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h3><i class="fas fa-history text-dim" style="margin-right:8px"></i>Rule history</h3>
          <div style="display:flex;gap:6px">
            <button class="btn btn-xs btn-secondary" id="fw-export-csv"><i class="fas fa-file-csv"></i> CSV</button>
            <button class="btn btn-xs btn-secondary" id="fw-export-json"><i class="fas fa-file-code"></i> JSON</button>
          </div>
        </div>
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
              <td>${this._isAdmin ? `<button class="btn btn-xs btn-secondary" data-fw-rollback="${sn.id}" title="Restore this snapshot (iptables)"><i class="fas fa-undo"></i> Rollback</button>` : ''}</td></tr>`).join('')}</tbody>
          </table>`}
        </div>
      </div>
    `;
    el.querySelectorAll('[data-fw-rollback]').forEach(b => b.addEventListener('click', () => this._rollback(parseInt(b.getAttribute('data-fw-rollback'), 10))));
    el.querySelector('#fw-export-csv')?.addEventListener('click', () => this._exportAudit('csv'));
    el.querySelector('#fw-export-json')?.addEventListener('click', () => this._exportAudit('json'));
  },

  _exportAudit(format) {
    const rules = (this._auditData && this._auditData.rules) || [];
    const host = (this._hosts.find(h => h.id === this._hostId) || {}).name || `host${this._hostId}`;
    let content, mime, ext;
    if (format === 'csv') {
      const cols = ['rule_uuid', 'backend', 'scope', 'action', 'source_ip', 'destination_port', 'protocol', 'reason', 'created_by', 'created_at', 'expires_at', 'is_temporary', 'is_active', 'removed_by', 'removed_at'];
      const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      content = [cols.join(',')].concat(rules.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
      mime = 'text/csv'; ext = 'csv';
    } else {
      content = JSON.stringify({ host, exportedAt: new Date().toISOString(), rules, snapshots: (this._auditData && this._auditData.snapshots) || [] }, null, 2);
      mime = 'application/json'; ext = 'json';
    }
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `firewall-audit-${host}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
      <div class="form-row">
        <div class="form-group"><label>Reason</label><input type="text" id="fwd-reason" class="form-control" placeholder="Supplier support access"></div>
        <div class="form-group"><label>Expires in (minutes) ${this._isAdmin ? '<span class="text-muted">(optional — temporary rule)</span>' : '<span style="color:var(--yellow)">(required for operators)</span>'}</label>
          <input type="number" id="fwd-expiry" class="form-control" placeholder="120" min="1" max="10080" value="${this._isAdmin ? '' : '120'}"></div>
      </div>
      <div class="alert alert-warning" style="font-size:12px"><i class="fas fa-info-circle"></i> Specify at least a source IP or a port. Temporary rules are auto-removed when they expire. Blocking the SSH/management port for everyone is refused (lockout guard).</div>
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
          expires_in_minutes: c.querySelector('#fwd-expiry').value.trim() || undefined,
        };
        if (!spec.source_ip && !spec.destination_port) { Toast.warning('Specify a source IP or a destination port'); return false; }
        if (!this._isAdmin && !spec.expires_in_minutes) { Toast.warning('Operators can only add temporary rules — set an expiry.'); return false; }
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
      <details style="margin-bottom:10px"${cur.mtls ? ' open' : ''}>
        <summary style="cursor:pointer;font-size:13px">Mutual TLS (optional) ${cur.mtls ? '<span class="badge badge-running">configured</span>' : ''}</summary>
        <p class="text-muted" style="font-size:12px;margin:6px 0">Paste the client certificate + key docker-dash should present, and the CA that signed the agent's server cert. See the agent README for openssl commands. Leave blank to keep current / use token-only.</p>
        <div class="form-group"><label>Client certificate (PEM)</label><textarea id="fwa-cert" class="form-control" rows="2" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
        <div class="form-group"><label>Client key (PEM)</label><textarea id="fwa-key" class="form-control" rows="2" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
        <div class="form-group"><label>CA certificate (PEM)</label><textarea id="fwa-ca" class="form-control" rows="2" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
      </details>
      ${cur.configured ? '<div class="alert alert-warning" style="font-size:12px">An agent is already configured. Submit to update, or clear the URL + submit to Remove.</div>' : ''}
    `, {
      title: 'Configure firewall-agent',
      width: '560px',
      onSubmit: (c) => ({
        url: c.querySelector('#fwa-url').value.trim(),
        token: c.querySelector('#fwa-token').value.trim(),
        tls: {
          cert: c.querySelector('#fwa-cert').value.trim(),
          key: c.querySelector('#fwa-key').value.trim(),
          ca: c.querySelector('#fwa-ca').value.trim(),
          keep: true,
        },
      }),
    });
    if (!result) return;
    try {
      if (!result.url) { await Api.fwSetAgentConfig(this._hostId, { remove: true }); Toast.success('Agent removed'); }
      else { await Api.fwSetAgentConfig(this._hostId, result); Toast.success('Agent configured'); }
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  destroy() { this._stopPendingPoll(); },
};

window.FirewallPage = FirewallPage;
