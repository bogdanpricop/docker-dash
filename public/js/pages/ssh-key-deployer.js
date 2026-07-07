/* ═══════════════════════════════════════════════════
   pages/ssh-key-deployer.js — SSH Key Manager & Deployer
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.16-alpha.1 — System → Tools wizard: generate an SSH keypair and push
// the public key to a target's authorized_keys, or produce manual
// instructions when auto-deploy isn't possible. Own modal (like the
// Deployment Configurator). Admin-only (the Tools tab is already gated).

const SshKeyDeployer = {
  _targets: {
    linux:   { label: 'Linux / Docker host (SSH)', icon: 'fa-linux', iconLib: 'fab', deploy: true,
      hint: 'Appends to ~/.ssh/authorized_keys. Enables key auth incl. Docker-over-SSH.' },
    esxi:    { label: 'VMware ESXi', icon: 'fa-server', iconLib: 'fas', deploy: true,
      hint: 'Root key at /etc/ssh/keys-root/authorized_keys. SSH (TSM-SSH) must be enabled on the host.' },
    proxmox: { label: 'Proxmox / generic Linux', icon: 'fa-server', iconLib: 'fas', deploy: true,
      hint: 'Appends to ~/.ssh/authorized_keys (root for Proxmox).' },
    git:     { label: 'Git provider (GitHub / GitLab)', icon: 'fa-git-alt', iconLib: 'fab', deploy: false,
      hint: 'No API push — you paste the public key in the provider settings (instructions provided).' },
    manual:  { label: 'Just generate (I\'ll deploy myself)', icon: 'fa-key', iconLib: 'fas', deploy: false,
      hint: 'Generate a keypair and get manual instructions + downloads.' },
  },

  open() {
    this._target = 'linux';
    this._result = null; // { publicKey, privateKey, fingerprint, type }
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-key" style="margin-right:10px;color:#8b5cf6"></i>SSH Key Deployer</h3>
        <button class="modal-close-btn" id="skd-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="max-height:75vh;overflow:auto"><div id="skd-body"></div></div>
    `;
    Modal.open(html, { width: '720px' });
    Modal._content.querySelector('#skd-x').addEventListener('click', () => Modal.close());
    this._render();
  },

  _render() {
    const body = Modal._content.querySelector('#skd-body');
    const t = this._targets[this._target];
    body.innerHTML = `
      <div class="form-group">
        <label>Target</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${Object.entries(this._targets).map(([k, v]) => `
            <button type="button" class="btn btn-sm ${k === this._target ? 'btn-primary' : 'btn-secondary'}" data-skd-target="${k}">
              <i class="${v.iconLib} ${v.icon}"></i> ${Utils.escapeHtml(v.label)}
            </button>`).join('')}
        </div>
        <small class="text-muted" style="display:block;margin-top:6px">${Utils.escapeHtml(t.hint)}</small>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:160px"><label>Key type</label>
          <select id="skd-type" class="form-control">
            <option value="ed25519">ed25519 (recommended)</option>
            <option value="rsa">RSA 4096</option>
          </select></div>
        <div class="form-group" style="flex:2;min-width:200px"><label>Comment (label)</label>
          <input type="text" id="skd-comment" class="form-control" value="dockerdash@${location.hostname}"></div>
      </div>

      ${t.deploy ? `
      <div id="skd-conn" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:8px"><i class="fas fa-plug"></i> Connection (used once to install the key — not stored)</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="form-group" style="flex:2;min-width:180px"><label>Host / IP</label><input type="text" id="skd-host" class="form-control" placeholder="192.168.13.20"></div>
          <div class="form-group" style="flex:0 0 90px"><label>Port</label><input type="number" id="skd-port" class="form-control" value="22"></div>
          <div class="form-group" style="flex:1;min-width:120px"><label>User</label><input type="text" id="skd-user" class="form-control" value="${this._target === 'esxi' || this._target === 'proxmox' ? 'root' : ''}" placeholder="root"></div>
        </div>
        <div class="form-group"><label>Initial auth</label>
          <select id="skd-authmode" class="form-control"><option value="password">Password</option><option value="key">Existing private key</option></select></div>
        <div class="form-group" id="skd-pw-wrap"><label>Password</label><input type="password" id="skd-password" class="form-control"></div>
        <div class="form-group" id="skd-key-wrap" style="display:none"><label>Existing private key (PEM)</label><textarea id="skd-existing-key" class="form-control" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>
      </div>
      <button class="btn btn-secondary" id="skd-test"><i class="fas fa-plug"></i> Test connection</button>
      <button class="btn btn-primary" id="skd-go" style="margin-left:8px"><i class="fas fa-bolt"></i> Generate &amp; Deploy</button>
      ` : `
      <button class="btn btn-primary" id="skd-go"><i class="fas fa-key"></i> Generate keypair</button>
      `}
      <span id="skd-status" style="margin-left:10px;font-size:13px"></span>
      <div id="skd-result" style="margin-top:14px"></div>
    `;

    body.querySelectorAll('[data-skd-target]').forEach(b => b.addEventListener('click', () => {
      this._target = b.getAttribute('data-skd-target'); this._result = null; this._render();
    }));
    const authSel = body.querySelector('#skd-authmode');
    if (authSel) authSel.addEventListener('change', () => {
      body.querySelector('#skd-pw-wrap').style.display = authSel.value === 'password' ? '' : 'none';
      body.querySelector('#skd-key-wrap').style.display = authSel.value === 'key' ? '' : 'none';
    });
    body.querySelector('#skd-go').addEventListener('click', () => this._run());
    const testBtn = body.querySelector('#skd-test');
    if (testBtn) testBtn.addEventListener('click', () => this._testConn());
  },

  async _testConn() {
    const body = Modal._content.querySelector('#skd-body');
    const statusEl = body.querySelector('#skd-status');
    const btn = body.querySelector('#skd-test');
    const conn = this._connFromForm();
    if (!conn.host || !conn.user || (!conn.password && !conn.privateKey)) {
      statusEl.innerHTML = '<span style="color:var(--yellow)">Fill host, user and a password/key first.</span>';
      return;
    }
    if (btn) btn.disabled = true;
    statusEl.style.color = 'var(--text-dim)';
    statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing connection…';
    try {
      const r = await Api.testSshConnection({ targetType: this._target, connection: conn });
      if (r && r.ok) {
        statusEl.innerHTML = `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Connected as <b>${Utils.escapeHtml(r.whoami)}</b> — will write to ${Utils.escapeHtml(r.path)}</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml((r && r.error) || 'Connection failed')}</span>`;
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--red)">${Utils.escapeHtml(err.message)}</span>`;
    } finally { if (btn) btn.disabled = false; }
  },

  _connFromForm() {
    const body = Modal._content.querySelector('#skd-body');
    const v = (id) => (body.querySelector(id) || {}).value || '';
    const conn = { host: v('#skd-host').trim(), port: parseInt(v('#skd-port'), 10) || 22, user: v('#skd-user').trim() };
    if (v('#skd-authmode') === 'key') conn.privateKey = v('#skd-existing-key');
    else conn.password = v('#skd-password');
    return conn;
  },

  async _run() {
    const body = Modal._content.querySelector('#skd-body');
    const statusEl = body.querySelector('#skd-status');
    const t = this._targets[this._target];
    const type = body.querySelector('#skd-type').value;
    const comment = body.querySelector('#skd-comment').value.trim();
    statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…';
    statusEl.style.color = 'var(--text-dim)';
    try {
      this._result = await Api.generateSshKey({ type, comment });
    } catch (err) { statusEl.innerHTML = `<span style="color:var(--red)">${Utils.escapeHtml(err.message)}</span>`; return; }

    // Render the key artifacts immediately (download is always available).
    this._renderResult();

    if (!t.deploy) { statusEl.textContent = ''; return; }

    // Attempt deploy.
    const conn = this._connFromForm();
    if (!conn.host || !conn.user || (!conn.password && !conn.privateKey)) {
      statusEl.innerHTML = '<span style="color:var(--yellow)">Fill host, user and a password/key to auto-deploy — or use the manual steps below.</span>';
      return;
    }
    statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deploying public key…';
    try {
      const r = await Api.deploySshKey({ targetType: this._target, connection: conn, publicKey: this._result.publicKey });
      if (r && r.ok) {
        statusEl.innerHTML = `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Deployed to ${Utils.escapeHtml(r.path)}${r.alreadyPresent ? ' (already present)' : ''}</span>`;
        this._renderResult({ deployed: true, conn });
      } else {
        statusEl.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml((r && r.error) || 'Deploy failed')}</span>`;
        this._renderResult({ deployFailed: true, conn });
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--red)">${Utils.escapeHtml(err.message)}</span>`;
      this._renderResult({ deployFailed: true, conn });
    }
  },

  _renderResult(state = {}) {
    const el = Modal._content.querySelector('#skd-result');
    if (!this._result) { el.innerHTML = ''; return; }
    const r = this._result;
    const kvName = (r.comment || 'id_' + r.type).replace(/[^\w.@-]/g, '_');
    el.innerHTML = `
      <div class="card" style="padding:12px;margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:6px"><i class="fas fa-fingerprint"></i> ${Utils.escapeHtml(r.fingerprint)}</div>
        <label style="font-size:12px;color:var(--text-dim)">Public key (authorized_keys line)</label>
        <textarea class="form-control" rows="2" readonly id="skd-pub" style="font-family:monospace;font-size:11px">${Utils.escapeHtml(r.publicKey)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-secondary" id="skd-copy-pub"><i class="fas fa-copy"></i> Copy public</button>
          <button class="btn btn-sm btn-primary" id="skd-dl-priv"><i class="fas fa-download"></i> Download private key</button>
          <button class="btn btn-sm btn-secondary" id="skd-dl-pub"><i class="fas fa-download"></i> Download public key</button>
        </div>
        <div class="alert alert-warning" style="margin-top:8px;font-size:12px;padding:6px 10px">
          <i class="fas fa-exclamation-triangle"></i> The private key is shown only now. Download and store it securely — it is not saved on the server unless you attach it below.
        </div>
      </div>
      ${state.deployed && this._target === 'esxi' ? this._attachVsphereBlock() : ''}
      ${(!this._targets[this._target].deploy || state.deployFailed) ? this._instructionsBlock(state.conn) : ''}
    `;
    const dl = (name, content, mime) => {
      const blob = new Blob([content], { type: mime || 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    el.querySelector('#skd-copy-pub').addEventListener('click', () => { navigator.clipboard.writeText(r.publicKey); Toast.success('Public key copied'); });
    el.querySelector('#skd-dl-priv').addEventListener('click', () => dl(kvName, r.privateKey));
    el.querySelector('#skd-dl-pub').addEventListener('click', () => dl(kvName + '.pub', r.publicKey));
    // Attach-to-vSphere wiring
    const attachBtn = el.querySelector('#skd-attach-btn');
    if (attachBtn) {
      this._loadVsphereHosts(el);
      attachBtn.addEventListener('click', async () => {
        const hostId = parseInt(el.querySelector('#skd-attach-host').value, 10);
        if (!hostId) { Toast.error('Pick a vSphere host'); return; }
        try {
          await Api.attachSshKeyVsphere({ hostId, sshConfig: { host: state.conn.host, port: state.conn.port, user: state.conn.user, privateKey: r.privateKey } });
          Toast.success('Private key attached to host — SSH console & Hardware tab are ready');
        } catch (err) { Toast.error(err.message); }
      });
    }
  },

  _attachVsphereBlock() {
    return `<div class="card" style="padding:12px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:6px"><i class="fas fa-link"></i> Attach to a vSphere host</div>
      <small class="text-muted">Save this private key to a registered vSphere host so the SSH Console + Hardware tab work with key auth.</small>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <select id="skd-attach-host" class="form-control" style="flex:1;min-width:180px"><option value="">Loading hosts…</option></select>
        <button class="btn btn-sm btn-primary" id="skd-attach-btn"><i class="fas fa-save"></i> Attach</button>
      </div></div>`;
  },

  async _loadVsphereHosts(el) {
    try {
      const hosts = await Api.listVsphereHostsForSsh();
      const sel = el.querySelector('#skd-attach-host');
      if (!sel) return;
      sel.innerHTML = hosts.length
        ? hosts.map(h => `<option value="${h.id}">${Utils.escapeHtml(h.name)}</option>`).join('')
        : '<option value="">(no vSphere hosts registered)</option>';
    } catch { /* leave placeholder */ }
  },

  _instructionsBlock(conn) {
    const pub = this._result.publicKey;
    const host = (conn && conn.host) || '<host>';
    const user = (conn && conn.user) || 'root';
    let steps;
    if (this._target === 'esxi') {
      steps = `# 1) Enable SSH on the ESXi host (Host → Manage → Services → TSM-SSH → Start),
#    or in docker-dash: vSphere page → Services tab → Start on TSM-SSH.
# 2) Append the public key to root's authorized_keys:
cat >> /etc/ssh/keys-root/authorized_keys <<'EOF'
${pub}
EOF`;
    } else if (this._target === 'git') {
      steps = `# GitHub: Settings → SSH and GPG keys → New SSH key → paste the public key.
#   https://github.com/settings/ssh/new
# GitLab: Preferences → SSH Keys → paste the public key.
#   https://gitlab.com/-/profile/keys
# Public key to paste:
${pub}`;
    } else {
      steps = `# Option A — ssh-copy-id (easiest):
ssh-copy-id -i keyfile.pub ${user}@${host}

# Option B — manual (paste the public key):
ssh ${user}@${host} 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys <<'"'"'EOF'"'"'
${pub}
EOF
chmod 600 ~/.ssh/authorized_keys'`;
    }
    return `<div class="card" style="padding:12px">
      <div style="font-weight:600;margin-bottom:6px"><i class="fas fa-list-ol"></i> Manual deployment steps</div>
      <textarea class="form-control" rows="8" readonly style="font-family:monospace;font-size:11px">${Utils.escapeHtml(steps)}</textarea>
      <button class="btn btn-sm btn-secondary" id="skd-copy-steps" style="margin-top:6px"><i class="fas fa-copy"></i> Copy steps</button>
    </div>`;
  },
};

// Wire the "Copy steps" button via delegation (it's re-rendered).
document.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('#skd-copy-steps')) {
    const ta = e.target.closest('.card').querySelector('textarea');
    if (ta) { navigator.clipboard.writeText(ta.value); if (typeof Toast !== 'undefined') Toast.success('Copied'); }
  }
});
