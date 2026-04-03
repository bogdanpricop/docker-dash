/* ═══════════════════════════════════════════════════
   pages/hosts.js — Docker Hosts Management
   ═══════════════════════════════════════════════════ */
'use strict';

const HostsPage = {
  _hosts: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-server"></i> ${i18n.t('pages.hosts.title')}</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-primary" id="host-add"><i class="fas fa-plus"></i> ${i18n.t('pages.hosts.addHost')}</button>
          <button class="btn btn-sm btn-secondary" id="host-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="hosts-grid" class="hosts-grid"></div>
      ${this._renderGuide()}
    `;

    container.querySelector('#host-add').addEventListener('click', () => this._addHostDialog());
    container.querySelector('#host-refresh').addEventListener('click', () => this._load());

    // Collapse/expand guide
    const guideToggle = container.querySelector('#guide-toggle');
    const guideBody = container.querySelector('#guide-body');
    if (guideToggle && guideBody) {
      const saved = localStorage.getItem('dd-hosts-guide-collapsed');
      if (saved === 'true') guideBody.style.display = 'none';
      guideToggle.addEventListener('click', () => {
        const hidden = guideBody.style.display === 'none';
        guideBody.style.display = hidden ? '' : 'none';
        localStorage.setItem('dd-hosts-guide-collapsed', !hidden);
        guideToggle.querySelector('i.fa-chevron-down, i.fa-chevron-right').className =
          hidden ? 'fas fa-chevron-down' : 'fas fa-chevron-right';
      });
    }

    await this._load();
  },

  async _load() {
    const grid = document.getElementById('hosts-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="text-muted" style="padding:20px"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div>`;

    try {
      this._hosts = await Api.getHosts();
      this._renderGrid();
    } catch (err) {
      grid.innerHTML = `<div class="empty-msg">${i18n.t('common.error')}: ${err.message}</div>`;
    }
  },

  _renderGrid() {
    const grid = document.getElementById('hosts-grid');
    if (!grid) return;

    if (this._hosts.length === 0) {
      grid.innerHTML = `<div class="empty-msg">${i18n.t('pages.hosts.noHosts')}</div>`;
      return;
    }

    grid.innerHTML = this._hosts.map(h => {
      const isOnline = h.healthy === true;
      const isOffline = h.healthy === false;
      const isPending = h.healthy === null;
      const statusClass = isOnline ? 'online' : isOffline ? 'offline' : 'pending';
      const statusText = isOnline ? i18n.t('pages.hosts.online') : isOffline ? i18n.t('pages.hosts.offline') : i18n.t('pages.hosts.checking');
      const statusIcon = isOnline ? 'fa-check-circle' : isOffline ? 'fa-times-circle' : 'fa-spinner fa-spin';
      const connIcon = h.connectionType === 'tcp' ? 'fa-globe' : h.connectionType === 'ssh' ? 'fa-terminal' : 'fa-plug';
      const connLabel = h.connectionType === 'tcp' ? `TCP ${h.host}:${h.port || 2376}` :
                         h.connectionType === 'ssh' ? `SSH ${h.sshHost || h.host}` :
                         h.socketPath || '/var/run/docker.sock';
      const isSelected = Api.getHostId() === h.id || (Api.getHostId() === 0 && h.isDefault);

      const envColors = { production: 'var(--red)', staging: 'var(--yellow)', development: 'var(--green)', custom: 'var(--accent)' };
      const envLabel = (h.environment || 'development').charAt(0).toUpperCase() + (h.environment || 'development').slice(1);
      const envColor = envColors[h.environment] || 'var(--text-dim)';

      return `
        <div class="host-card ${statusClass} ${isSelected ? 'selected' : ''}" data-host-id="${h.id}">
          <div class="host-card-header">
            <div class="host-status"><i class="fas ${statusIcon}"></i> ${statusText}</div>
            <div style="display:flex;gap:6px;align-items:center">
              <span class="badge" style="font-size:9px;background:${envColor};color:#fff;padding:2px 6px;border-radius:3px">${envLabel}</span>
              ${h.isDefault ? `<span class="badge badge-info">${i18n.t('pages.hosts.default')}</span>` : ''}
            </div>
          </div>
          <div class="host-card-body">
            <h3 class="host-name">${Utils.escapeHtml(h.name)}</h3>
            <div class="host-conn"><i class="fas ${connIcon}"></i> ${Utils.escapeHtml(connLabel)}</div>
            ${h.lastSeenAt ? `<div class="host-seen text-sm text-muted">${i18n.t('pages.hosts.lastSeen')}: ${Utils.timeAgo(h.lastSeenAt)}</div>` : ''}
            ${h.hasTls ? '<div class="text-sm" style="color:var(--green)"><i class="fas fa-lock"></i> TLS</div>' : ''}
          </div>
          <div class="host-card-actions">
            <button class="btn btn-xs btn-primary host-select" data-id="${h.id}" title="${i18n.t('pages.hosts.switchTo')}"><i class="fas fa-exchange-alt"></i> ${i18n.t('pages.hosts.switchTo')}</button>
            <button class="btn btn-xs btn-secondary host-test" data-id="${h.id}" title="${i18n.t('pages.hosts.testConnection')}"><i class="fas fa-plug"></i></button>
            <button class="btn btn-xs btn-secondary host-info" data-id="${h.id}" title="${i18n.t('pages.hosts.info')}"><i class="fas fa-info-circle"></i></button>
            ${!h.isDefault ? `<button class="btn btn-xs btn-secondary host-edit" data-id="${h.id}" title="${i18n.t('common.edit')}"><i class="fas fa-edit"></i></button>
            <button class="btn btn-xs btn-danger host-delete" data-id="${h.id}" title="${i18n.t('common.remove')}"><i class="fas fa-trash"></i></button>` : `
            <button class="btn btn-xs btn-secondary host-edit" data-id="${h.id}" title="${i18n.t('common.edit')}"><i class="fas fa-edit"></i></button>`}
          </div>
        </div>
      `;
    }).join('');

    // Bind events
    grid.querySelectorAll('.host-select').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const hostId = parseInt(e.currentTarget.dataset.id);
        Api.setHost(hostId);
        Toast.success(i18n.t('pages.hosts.switched', { name: this._hosts.find(h => h.id === hostId)?.name }));
        this._renderGrid();
        // Trigger host change event for sidebar
        window.dispatchEvent(new CustomEvent('hostChanged', { detail: { hostId } }));
      });
    });

    grid.querySelectorAll('.host-test').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const hostId = parseInt(e.currentTarget.dataset.id);
        const btn2 = e.currentTarget;
        btn2.disabled = true;
        btn2.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
          const result = await Api.testHost(hostId);
          if (result.ok) {
            Toast.success(`${i18n.t('pages.hosts.connectionOk')} (${result.latency}ms) — Docker ${result.dockerVersion}`);
          } else {
            Toast.error(`${i18n.t('pages.hosts.connectionFailed')}: ${result.error}`);
          }
        } catch (err) {
          Toast.error(err.message);
        } finally {
          btn2.disabled = false;
          btn2.innerHTML = '<i class="fas fa-plug"></i>';
        }
      });
    });

    grid.querySelectorAll('.host-info').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const hostId = parseInt(e.currentTarget.dataset.id);
        try {
          const info = await Api.getHostInfo(hostId);
          Modal.open(`
            <div class="modal-header">
              <h3><i class="fas fa-server" style="color:var(--accent);margin-right:8px"></i>${Utils.escapeHtml(info.hostname)}</h3>
              <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
              <table class="info-table">
                <tr><td>OS</td><td>${Utils.escapeHtml(info.os)}</td></tr>
                <tr><td>Docker</td><td>${info.dockerVersion}</td></tr>
                <tr><td>API</td><td>${info.apiVersion}</td></tr>
                <tr><td>Kernel</td><td>${info.kernelVersion}</td></tr>
                <tr><td>CPUs</td><td>${info.cpus}</td></tr>
                <tr><td>${i18n.t('pages.dashboard.memory')}</td><td>${Utils.formatBytes(info.memTotal)}</td></tr>
                <tr><td>${i18n.t('pages.dashboard.containers')}</td><td>${info.containersRunning}/${info.containers}</td></tr>
                <tr><td>${i18n.t('nav.images')}</td><td>${info.images}</td></tr>
                <tr><td>Storage</td><td>${info.storageDriver}</td></tr>
              </table>
            </div>
            <div class="modal-footer"><button class="btn btn-primary" id="modal-ok">${i18n.t('common.close')}</button></div>
          `, { width: '500px' });
          Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
          Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
        } catch (err) {
          Toast.error(err.message);
        }
      });
    });

    grid.querySelectorAll('.host-edit').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const hostId = parseInt(e.currentTarget.dataset.id);
        try {
          // Fetch full host details (list endpoint doesn't include SSH config)
          const host = await Api.getHost(hostId);
          this._editHostDialog(host);
        } catch (err) {
          Toast.error(err.message);
        }
      });
    });

    grid.querySelectorAll('.host-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const hostId = parseInt(e.currentTarget.dataset.id);
        const host = this._hosts.find(h => h.id === hostId);
        if (!host) return;
        const ok = await Modal.confirm(
          i18n.t('pages.hosts.deleteConfirm', { name: host.name }),
          { danger: true, confirmText: i18n.t('common.remove') },
        );
        if (!ok) return;
        try {
          await Api.deleteHost(hostId);
          Toast.success(i18n.t('pages.hosts.deleted'));
          if (Api.getHostId() === hostId) Api.setHost(0);
          await this._load();
        } catch (err) { Toast.error(err.message); }
      });
    });
  },

  async _addHostDialog() {
    const html = this._buildFormHtml({ type: 'tcp' });

    const result = await Modal.form(html, {
      title: i18n.t('pages.hosts.addHost'),
      width: '560px',
      onSubmit: (content) => this._collectFormData(content),
      onMount: (content) => this._setupFormToggle(content),
    });

    if (result) {
      try {
        await Api.createHost(result);
        Toast.success(i18n.t('pages.hosts.created'));
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  /** Shared form HTML builder for add/edit */
  _buildFormHtml(opts = {}) {
    const { name = '', type = 'tcp', host = '', port, socketPath, sshHost = '', sshPort,
            sshUsername = '', sshDockerSocket, hasTls, showActive, isActive, environment = 'development' } = opts;
    const esc = (v) => Utils.escapeHtml(v || '');
    return `
      <div class="form-group">
        <label>${i18n.t('common.name')}</label>
        <input type="text" id="h-name" class="form-control" value="${esc(name)}" placeholder="${i18n.t('pages.hosts.namePlaceholder')}" required>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.hosts.connectionType')}</label>
        <select id="h-type" class="form-control">
          <option value="tcp" ${type === 'tcp' ? 'selected' : ''}>TCP (${i18n.t('pages.hosts.remote')})</option>
          <option value="socket" ${type === 'socket' ? 'selected' : ''}>Socket (${i18n.t('pages.hosts.local')})</option>
          <option value="ssh" ${type === 'ssh' ? 'selected' : ''}>SSH Tunnel</option>
        </select>
      </div>
      <div id="h-tcp-fields" ${type !== 'tcp' ? 'style="display:none"' : ''}>
        <div class="form-group">
          <label>${i18n.t('pages.hosts.hostAddress')}</label>
          <input type="text" id="h-host" class="form-control" value="${esc(host)}" placeholder="192.168.1.100">
        </div>
        <div class="form-group">
          <label>${i18n.t('pages.hosts.port')}</label>
          <input type="number" id="h-port" class="form-control" value="${port || 2376}">
        </div>
        <div class="form-group">
          <label>TLS CA Certificate (${i18n.t('pages.hosts.optional')})</label>
          <textarea id="h-tls-ca" class="form-control" rows="3" placeholder="${hasTls ? i18n.t('pages.hosts.leaveEmpty') : i18n.t('pages.hosts.pastePem')}"></textarea>
        </div>
        <div class="form-group">
          <label>TLS Client Certificate</label>
          <textarea id="h-tls-cert" class="form-control" rows="3" placeholder="${i18n.t('pages.hosts.pastePem')}"></textarea>
        </div>
        <div class="form-group">
          <label>TLS Client Key</label>
          <textarea id="h-tls-key" class="form-control" rows="3" placeholder="${i18n.t('pages.hosts.pastePem')}"></textarea>
        </div>
      </div>
      <div id="h-socket-fields" ${type !== 'socket' ? 'style="display:none"' : ''}>
        <div class="form-group">
          <label>Socket Path</label>
          <input type="text" id="h-socket" class="form-control" value="${esc(socketPath || '/var/run/docker.sock')}">
        </div>
      </div>
      <div id="h-ssh-fields" ${type !== 'ssh' ? 'style="display:none"' : ''}>
        <div class="form-group">
          <label>SSH Host</label>
          <input type="text" id="h-ssh-host" class="form-control" value="${esc(sshHost)}" placeholder="192.168.1.100">
        </div>
        <div class="form-group">
          <label>SSH Port</label>
          <input type="number" id="h-ssh-port" class="form-control" value="${sshPort || 22}">
        </div>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="h-ssh-user" class="form-control" value="${esc(sshUsername)}" placeholder="root">
        </div>
        <div class="form-group">
          <label>Password (${i18n.t('pages.hosts.orKey')})</label>
          <input type="password" id="h-ssh-pass" class="form-control">
        </div>
        <div class="form-group">
          <label>SSH Private Key (${i18n.t('pages.hosts.optional')})</label>
          <textarea id="h-ssh-key" class="form-control" rows="3" placeholder="${i18n.t('pages.hosts.pastePem')}"></textarea>
        </div>
        <div class="form-group">
          <label>Docker Socket Path (${i18n.t('pages.hosts.onRemote')})</label>
          <input type="text" id="h-ssh-docker" class="form-control" value="${esc(sshDockerSocket || '/var/run/docker.sock')}">
        </div>
      </div>
      <div class="form-group">
        <label>Environment</label>
        <select id="h-environment" class="form-control">
          <option value="development" ${environment === 'development' ? 'selected' : ''}>Development</option>
          <option value="staging" ${environment === 'staging' ? 'selected' : ''}>Staging</option>
          <option value="production" ${environment === 'production' ? 'selected' : ''}>Production</option>
          <option value="custom" ${environment === 'custom' ? 'selected' : ''}>Custom</option>
        </select>
      </div>
      ${showActive ? `<div class="form-group"><label><input type="checkbox" id="h-active" ${isActive ? 'checked' : ''}> ${i18n.t('pages.hosts.active')}</label></div>` : ''}
      <div style="margin-top:12px">
        <button class="btn btn-sm btn-secondary" id="h-test-btn"><i class="fas fa-plug"></i> ${i18n.t('pages.hosts.testConnection')}</button>
        <span id="h-test-result" class="text-sm" style="margin-left:8px"></span>
      </div>
    `;
  },

  async _editHostDialog(host) {
    const html = this._buildFormHtml({
      name: host.name,
      type: host.connectionType,
      host: host.host,
      port: host.port,
      socketPath: host.socketPath,
      sshHost: host.sshHost,
      sshPort: host.sshPort,
      sshUsername: host.sshUsername,
      sshDockerSocket: host.sshDockerSocket,
      hasTls: host.hasTls,
      showActive: true,
      isActive: host.isActive,
      environment: host.environment || 'development',
    });

    const result = await Modal.form(html, {
      title: i18n.t('pages.hosts.editHost'),
      width: '560px',
      onSubmit: (content) => {
        const data = this._collectFormData(content);
        if (data === false) return false;
        data.isActive = content.querySelector('#h-active')?.checked ?? true;
        return data;
      },
      onMount: (content) => this._setupFormToggle(content),
    });

    if (result) {
      try {
        await Api.updateHost(host.id, result);
        Toast.success(i18n.t('pages.hosts.updated'));
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  _setupFormToggle(content) {
    const typeSelect = content.querySelector('#h-type');
    const tcpFields = content.querySelector('#h-tcp-fields');
    const socketFields = content.querySelector('#h-socket-fields');
    const sshFields = content.querySelector('#h-ssh-fields');

    const toggle = () => {
      const v = typeSelect.value;
      tcpFields.style.display = v === 'tcp' ? '' : 'none';
      socketFields.style.display = v === 'socket' ? '' : 'none';
      sshFields.style.display = v === 'ssh' ? '' : 'none';
    };
    typeSelect.addEventListener('change', toggle);

    // Test button
    const testBtn = content.querySelector('#h-test-btn');
    const testResult = content.querySelector('#h-test-result');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';
        testResult.textContent = '';
        try {
          const data = this._collectFormData(content);
          const r = await Api.testHostConnection(data);
          if (r.ok) {
            let msg = `<span style="color:var(--green)"><i class="fas fa-check"></i> OK (${r.latency || 0}ms) — Docker ${r.dockerVersion || 'connected'}</span>`;
            if (r.warnings?.length) {
              msg += `<div style="margin-top:6px">${r.warnings.map(w => `<div class="text-sm" style="color:var(--yellow)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(w)}</div>`).join('')}</div>`;
            }
            testResult.innerHTML = msg;
          } else {
            testResult.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times"></i> ${Utils.escapeHtml(r.error || 'Failed')}</span>`;
          }
        } catch (err) {
          testResult.innerHTML = `<span style="color:var(--red)"><i class="fas fa-times"></i> ${Utils.escapeHtml(err.message)}</span>`;
        } finally {
          testBtn.disabled = false;
          testBtn.innerHTML = `<i class="fas fa-plug"></i> ${i18n.t('pages.hosts.testConnection')}`;
        }
      });
    }
  },

  _collectFormData(content) {
    const type = content.querySelector('#h-type').value;
    const data = {
      name: content.querySelector('#h-name').value.trim(),
      connectionType: type,
    };

    if (type === 'tcp') {
      data.host = content.querySelector('#h-host').value.trim();
      data.port = parseInt(content.querySelector('#h-port').value) || 2376;
      const ca = content.querySelector('#h-tls-ca').value.trim();
      if (ca) {
        data.tlsCa = ca;
        data.tlsCert = content.querySelector('#h-tls-cert').value.trim();
        data.tlsKey = content.querySelector('#h-tls-key').value.trim();
      }
    } else if (type === 'socket') {
      data.socketPath = content.querySelector('#h-socket').value.trim();
    } else if (type === 'ssh') {
      data.sshHost = content.querySelector('#h-ssh-host').value.trim();
      data.sshPort = parseInt(content.querySelector('#h-ssh-port').value) || 22;
      data.sshUsername = content.querySelector('#h-ssh-user').value.trim();
      data.sshPassword = content.querySelector('#h-ssh-pass').value;
      const key = content.querySelector('#h-ssh-key').value.trim();
      if (key) data.sshPrivateKey = key;
      data.sshDockerSocket = content.querySelector('#h-ssh-docker').value.trim() || '/var/run/docker.sock';
    }

    // Environment tag
    const envEl = content.querySelector('#h-environment');
    if (envEl) data.environment = envEl.value;

    if (!data.name) { Toast.warning(i18n.t('pages.hosts.nameRequired')); return false; }
    return data;
  },

  _renderGuide() {
    const collapsed = localStorage.getItem('dd-hosts-guide-collapsed') === 'true';
    return `
      <div class="card" style="margin-top:16px">
        <div class="card-header" id="guide-toggle" style="cursor:pointer;user-select:none">
          <h3><i class="fas fa-book" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.hosts.guideTitle')}</h3>
          <i class="fas ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="color:var(--text-dim)"></i>
        </div>
        <div class="card-body" id="guide-body" style="${collapsed ? 'display:none' : ''}">

          <!-- Connection Types -->
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:20px">

            <!-- TCP + TLS -->
            <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <i class="fas fa-globe" style="color:var(--accent);font-size:18px"></i>
                <strong style="font-size:14px">TCP + TLS</strong>
                <span class="badge badge-info" style="font-size:10px">${i18n.t('pages.hosts.recommended')}</span>
              </div>
              <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.hosts.guideTcpDesc')}</p>

              <div style="font-size:11px;margin-bottom:6px;font-weight:600"><i class="fas fa-certificate" style="margin-right:4px"></i>${i18n.t('pages.hosts.guideTlsGenTitle')}:</div>
              <div class="code-block" style="font-size:11px;line-height:1.5;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);overflow-x:auto;white-space:pre;font-family:'JetBrains Mono',monospace"># ${i18n.t('pages.hosts.guideTlsStep1')}
openssl genrsa -aes256 -out ca-key.pem 4096
openssl req -new -x509 -days 365 -key ca-key.pem \\
  -sha256 -out ca.pem -subj "/CN=Docker CA"

# ${i18n.t('pages.hosts.guideTlsStep2')}
openssl genrsa -out server-key.pem 4096
openssl req -new -key server-key.pem -out server.csr \\
  -subj "/CN=\$(hostname)"
echo "subjectAltName=IP:SERVER_IP,IP:127.0.0.1" \\
  > extfile.cnf
openssl x509 -req -days 365 -sha256 \\
  -in server.csr -CA ca.pem -CAkey ca-key.pem \\
  -CAcreateserial -out server-cert.pem \\
  -extfile extfile.cnf

# ${i18n.t('pages.hosts.guideTlsStep3')}
openssl genrsa -out key.pem 4096
openssl req -new -key key.pem -out client.csr \\
  -subj "/CN=client"
echo "extendedKeyUsage=clientAuth" > extfile2.cnf
openssl x509 -req -days 365 -sha256 \\
  -in client.csr -CA ca.pem -CAkey ca-key.pem \\
  -CAcreateserial -out cert.pem \\
  -extfile extfile2.cnf

# ${i18n.t('pages.hosts.guideTlsStep4')}
sudo mkdir -p /etc/docker/certs
sudo cp ca.pem server-cert.pem server-key.pem \\
  /etc/docker/certs/
sudo chmod 600 /etc/docker/certs/*</div>

              <div style="font-size:11px;margin:12px 0 6px;font-weight:600"><i class="fas fa-cog" style="margin-right:4px"></i>${i18n.t('pages.hosts.guideTlsDaemon')}:</div>
              <div class="code-block" style="font-size:11px;line-height:1.5;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);overflow-x:auto;white-space:pre;font-family:'JetBrains Mono',monospace"># sudo nano /etc/docker/daemon.json
{
  "hosts": [
    "unix:///var/run/docker.sock",
    "tcp://0.0.0.0:2376"
  ],
  "tls": true,
  "tlscacert": "/etc/docker/certs/ca.pem",
  "tlscert": "/etc/docker/certs/server-cert.pem",
  "tlskey": "/etc/docker/certs/server-key.pem",
  "tlsverify": true
}

# ${i18n.t('pages.hosts.guideRestart')}
sudo systemctl restart docker

# ${i18n.t('pages.hosts.guideFirewall')}
sudo ufw allow 2376/tcp  # Ubuntu/Debian
# firewall-cmd --add-port=2376/tcp --permanent  # CentOS/RHEL</div>

              <div style="font-size:11px;margin:12px 0 6px;font-weight:600"><i class="fas fa-paste" style="margin-right:4px"></i>${i18n.t('pages.hosts.guideTlsPaste')}:</div>
              <div class="text-sm text-muted" style="line-height:1.7">
                <div><strong>TLS CA Certificate</strong> → ${i18n.t('pages.hosts.guideTlsPasteCa')}: <code>ca.pem</code></div>
                <div><strong>TLS Client Certificate</strong> → ${i18n.t('pages.hosts.guideTlsPasteCert')}: <code>cert.pem</code></div>
                <div><strong>TLS Client Key</strong> → ${i18n.t('pages.hosts.guideTlsPasteKey')}: <code>key.pem</code></div>
              </div>

              <div class="text-sm text-muted" style="margin-top:10px"><i class="fas fa-info-circle"></i> ${i18n.t('pages.hosts.guideTcpNote')}</div>
            </div>

            <!-- SSH Tunnel -->
            <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <i class="fas fa-terminal" style="color:var(--green);font-size:18px"></i>
                <strong style="font-size:14px">SSH Tunnel</strong>
                <span class="badge" style="font-size:10px;background:var(--surface2)">${i18n.t('pages.hosts.guideSshSecure')}</span>
              </div>
              <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.hosts.guideSshDesc')}</p>

              <div style="font-size:11px;margin-bottom:8px;font-weight:600">${i18n.t('pages.hosts.guideSshReq')}:</div>
              <ul class="text-sm" style="margin:0 0 12px;padding-left:18px;line-height:1.8">
                <li>SSH ${i18n.t('pages.hosts.guideSshAccess')}</li>
                <li>${i18n.t('pages.hosts.guideSshDockerGroup')}</li>
                <li><strong>socat</strong> ${i18n.t('pages.hosts.guideSocatNeeded')}</li>
              </ul>

              <div style="font-size:11px;margin-bottom:6px;font-weight:600"><i class="fas fa-download" style="margin-right:4px"></i>${i18n.t('pages.hosts.guideSocatInstall')}:</div>
              <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
                ${[
                  { os: 'Ubuntu / Debian 12+', cmd: 'sudo apt update && sudo apt install -y socat', icon: 'fab fa-ubuntu' },
                  { os: 'CentOS 7 / RHEL 7', cmd: 'sudo yum install -y socat', icon: 'fab fa-redhat' },
                  { os: 'CentOS Stream 8-9 / RHEL 8-9 / Rocky / Alma', cmd: 'sudo dnf install -y socat', icon: 'fab fa-redhat' },
                  { os: 'Fedora', cmd: 'sudo dnf install -y socat', icon: 'fab fa-fedora' },
                  { os: 'Alpine', cmd: 'apk add socat', icon: 'fab fa-linux' },
                  { os: 'SUSE / openSUSE', cmd: 'sudo zypper install -y socat', icon: 'fab fa-suse' },
                  { os: 'Arch / Manjaro', cmd: 'sudo pacman -S socat', icon: 'fab fa-linux' },
                ].map(d => `
                  <div style="display:flex;align-items:center;gap:8px;background:var(--surface2);padding:6px 10px;border-radius:var(--radius-sm);font-size:11px">
                    <i class="${d.icon}" style="width:16px;text-align:center;color:var(--text-dim)"></i>
                    <span style="min-width:200px;font-weight:500">${d.os}</span>
                    <code style="font-family:'JetBrains Mono',monospace;flex:1;color:var(--accent)">${d.cmd}</code>
                  </div>
                `).join('')}
              </div>

              <div style="font-size:11px;margin-bottom:6px;font-weight:600"><i class="fas fa-user-plus" style="margin-right:4px"></i>${i18n.t('pages.hosts.guideSshAddGroup')}:</div>
              <div class="code-block" style="font-size:11px;line-height:1.6;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);white-space:pre;font-family:'JetBrains Mono',monospace"># ${i18n.t('pages.hosts.guideSshAddGroupCmd')}
sudo usermod -aG docker your-user

# ${i18n.t('pages.hosts.guideSshLogout')}
# ${i18n.t('pages.hosts.guideSshVerify')}:
ssh your-user@host "docker ps"</div>

              <div style="font-size:11px;margin:12px 0 6px;font-weight:600">${i18n.t('pages.hosts.guideDdFields')}:</div>
              <div class="code-block" style="font-size:11px;line-height:1.6;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);white-space:pre;font-family:'JetBrains Mono',monospace">#   SSH Host: 192.168.1.100
#   SSH Port: 22
#   Username: your-user
#   Auth: password ${i18n.t('pages.hosts.guideSshOrKey')}</div>

              <div class="text-sm text-muted" style="margin-top:8px"><i class="fas fa-info-circle"></i> ${i18n.t('pages.hosts.guideSshNote')}</div>
            </div>

            <!-- Docker Desktop -->
            <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <i class="fab fa-docker" style="color:#2496ED;font-size:18px"></i>
                <strong style="font-size:14px">Docker Desktop</strong>
                <span class="badge" style="font-size:10px;background:var(--surface2)">Windows / Mac</span>
              </div>
              <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.hosts.guideDesktopDesc')}</p>
              <div style="font-size:11px;margin-bottom:8px;font-weight:600">${i18n.t('pages.hosts.guideSetup')}:</div>
              <div class="code-block" style="font-size:11px;line-height:1.6;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);white-space:pre;font-family:'JetBrains Mono',monospace"># Docker Desktop Settings:
# Settings → General →
#   ☑ "Expose daemon on tcp://
#      localhost:2375 without TLS"

# ${i18n.t('pages.hosts.guideDdFields')}:
#   Connection Type: TCP
#   Host: ${i18n.t('pages.hosts.guideDdHost')}
#   Port: 2375
#   TLS: ${i18n.t('pages.hosts.guideDdNoTls')}</div>
              <div class="text-sm" style="margin-top:8px;color:var(--yellow)"><i class="fas fa-exclamation-triangle"></i> ${i18n.t('pages.hosts.guideDesktopWarn')}</div>
            </div>

            <!-- Socket Local -->
            <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <i class="fas fa-plug" style="color:var(--text-dim);font-size:18px"></i>
                <strong style="font-size:14px">Unix Socket</strong>
                <span class="badge" style="font-size:10px;background:var(--surface2)">${i18n.t('pages.hosts.local')}</span>
              </div>
              <p class="text-sm text-muted" style="margin:0 0 10px">${i18n.t('pages.hosts.guideSocketDesc')}</p>
              <div class="code-block" style="font-size:11px;line-height:1.6;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);white-space:pre;font-family:'JetBrains Mono',monospace"># ${i18n.t('pages.hosts.guideSocketDefault')}:
#   /var/run/docker.sock (Linux/Mac)
#   //./pipe/docker_engine (Windows)

# ${i18n.t('pages.hosts.guideSocketMount')}:
# docker run -v /var/run/docker.sock:\\
#   /var/run/docker.sock docker-dash</div>
            </div>
          </div>

          <!-- Architecture diagram -->
          <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:16px">
            <div style="font-weight:600;margin-bottom:10px"><i class="fas fa-project-diagram" style="color:var(--accent);margin-right:6px"></i>${i18n.t('pages.hosts.guideArch')}</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.7;white-space:pre;overflow-x:auto;color:var(--text-dim)">                    ┌─────────────────────┐
                    │   Docker Dash Hub   │
                    │   (${i18n.t('pages.hosts.guideThisInstance')})  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────┴───────┐ ┌─────┴──────┐ ┌───────┴────────┐
     │ <span style="color:var(--green)">Local (Socket)</span> │ │ <span style="color:var(--accent)">Remote TCP</span> │ │ <span style="color:var(--yellow)">Remote SSH</span>   │
     │ /var/run/...   │ │ :2376+TLS  │ │ ssh://user@..  │
     └────────────────┘ └────────────┘ └────────────────┘</div>
          </div>

          <!-- Tips -->
          <div class="tip-box">
            <i class="fas fa-lightbulb"></i>
            <div>
              <strong>${i18n.t('common.tip')}:</strong> ${i18n.t('pages.hosts.guideTip')}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  destroy() {},
};

window.HostsPage = HostsPage;
