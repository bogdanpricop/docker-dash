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
          <button class="btn btn-sm btn-secondary" id="host-add-non-docker"><i class="fas fa-cubes"></i> Non-Docker host <span class="badge badge-warning" style="font-size:9px">alpha</span></button>
          <button class="btn btn-sm btn-secondary" id="host-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="hosts-grid" class="hosts-grid"></div>

      <!-- v8.9.11-alpha.2 — refactored to match the multihost.js tab style
           (class="tabs" + class="tab"). Cleaner, uses the app's shared
           tab CSS. -->
      <div style="margin-top:24px">
        <div class="tabs" style="margin-bottom:16px">
          <button class="tab active" data-hosts-doc-tab="daemon-types"><i class="fas fa-info-circle" style="margin-right:4px"></i>Supported daemon types</button>
          <button class="tab" data-hosts-doc-tab="guide"><i class="fas fa-book" style="margin-right:4px"></i>How Hosts work</button>
          <button class="tab" data-hosts-doc-tab="ssh-key"><i class="fas fa-key" style="margin-right:4px"></i>SSH key setup</button>
        </div>
        <div data-hosts-doc-panel="daemon-types">${this._renderDaemonTypesTabBody()}</div>
        <div data-hosts-doc-panel="guide" style="display:none">${this._renderGuideTabBody()}</div>
        <div data-hosts-doc-panel="ssh-key" style="display:none">${this._renderSshKeyGuideTabBody()}</div>
      </div>
    `;

    container.querySelector('#host-add').addEventListener('click', () => this._addHostDialog());
    container.querySelector('#host-add-non-docker').addEventListener('click', () => this._addNonDockerHostDialog());
    container.querySelector('#host-refresh').addEventListener('click', () => this._load());

    // v8.9.11-alpha.1 — Wire the 3-tab switcher for the docs section.
    // Selected tab persists to localStorage so the user's last view survives
    // a page reload.
    const savedTab = localStorage.getItem('dd-hosts-docs-tab') || 'daemon-types';
    const applyDocTab = (which) => {
      container.querySelectorAll('[data-hosts-doc-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-hosts-doc-tab') === which);
      });
      container.querySelectorAll('[data-hosts-doc-panel]').forEach(el => {
        el.style.display = el.getAttribute('data-hosts-doc-panel') === which ? '' : 'none';
      });
      localStorage.setItem('dd-hosts-docs-tab', which);
    };
    applyDocTab(savedTab);
    container.querySelectorAll('[data-hosts-doc-tab]').forEach(btn => {
      btn.addEventListener('click', () => applyDocTab(btn.getAttribute('data-hosts-doc-tab')));
    });

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
      // v8.9.11-alpha.6 — non-Docker hosts show their daemon endpoint
      // instead of the (missing) Docker host/port.
      const isNonDocker = h.daemonType && h.daemonType !== 'docker' && h.daemonType !== 'podman';
      const daemonIconMap = { incus: 'fa-cubes', lxd: 'fa-cubes', proxmox: 'fa-server',
        kubernetes: 'fa-dharmachakra', nomad: 'fa-tasks', vsphere: 'fa-server' };
      const daemonPrefixMap = { incus: 'Incus', lxd: 'LXD', proxmox: 'Proxmox',
        kubernetes: 'K8s', nomad: 'Nomad', vsphere: 'vSphere' };
      const connIcon = isNonDocker ? (daemonIconMap[h.daemonType] || 'fa-plug')
                     : h.connectionType === 'tcp' ? 'fa-globe'
                     : h.connectionType === 'ssh' ? 'fa-terminal' : 'fa-plug';
      const connLabel = isNonDocker
                     ? `${daemonPrefixMap[h.daemonType] || h.daemonType} · ${h.daemonEndpoint || '—'}`
                     : h.connectionType === 'tcp' ? `TCP ${h.host}:${h.port || 2376}`
                     : h.connectionType === 'ssh' ? `SSH ${h.sshHost || h.host || '—'}`
                     : h.socketPath || '/var/run/docker.sock';
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
          // v8.9.11-alpha.6 — non-Docker daemon-appropriate modal.
          const dt = info.daemonType;
          const isNonDocker = dt && dt !== 'docker' && dt !== 'podman';
          const na = (v) => v && String(v) !== 'null' ? Utils.escapeHtml(String(v)) : '<span class="text-muted">—</span>';
          const bodyHtml = isNonDocker
            ? `<table class="info-table">
                 <tr><td>Daemon type</td><td><strong>${Utils.escapeHtml(info.daemonName || dt)}</strong></td></tr>
                 <tr><td>Product</td><td>${na(info.os || info.hostname)}</td></tr>
                 <tr><td>Version</td><td>${na(info.dockerVersion)}</td></tr>
                 <tr><td>API version</td><td>${na(info.apiVersion)}</td></tr>
                 ${info._connectError ? `<tr><td>Connection</td><td style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(info._connectError)}</td></tr>` : `<tr><td>Connection</td><td style="color:var(--green)"><i class="fas fa-check-circle"></i> Connected</td></tr>`}
                 ${info.capabilities ? `<tr><td>Capabilities</td><td><code style="font-size:11px">${Utils.escapeHtml(Object.keys(info.capabilities).filter(k => info.capabilities[k]).join(', '))}</code></td></tr>` : ''}
               </table>
               <div style="margin-top:14px;padding:10px;background:var(--surface2,rgba(0,0,0,.05));border-radius:6px;font-size:12px;color:var(--text-dim)">
                 <i class="fas fa-info-circle"></i> This is a <strong>${Utils.escapeHtml(info.daemonName || dt)}</strong> host — Docker fields (CPUs, memory, containers, images) do not apply. Use the daemon's dedicated page for VMs / instances / jobs / pods.
               </div>`
            : `<table class="info-table">
                <tr><td>OS</td><td>${na(info.os)}</td></tr>
                <tr><td>Docker</td><td>${na(info.dockerVersion)}</td></tr>
                <tr><td>API</td><td>${na(info.apiVersion)}</td></tr>
                <tr><td>Kernel</td><td>${na(info.kernelVersion)}</td></tr>
                <tr><td>CPUs</td><td>${info.cpus || 0}</td></tr>
                <tr><td>${i18n.t('pages.dashboard.memory')}</td><td>${Utils.formatBytes(info.memTotal || 0)}</td></tr>
                <tr><td>${i18n.t('pages.dashboard.containers')}</td><td>${info.containersRunning || 0}/${info.containers || 0}</td></tr>
                <tr><td>${i18n.t('nav.images')}</td><td>${info.images || 0}</td></tr>
                <tr><td>Storage</td><td>${na(info.storageDriver)}</td></tr>
              </table>`;
          Modal.open(`
            <div class="modal-header">
              <h3><i class="fas fa-server" style="color:var(--accent);margin-right:8px"></i>${Utils.escapeHtml(info.hostname || 'Host')}</h3>
              <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">${bodyHtml}</div>
            <div class="modal-footer"><button class="btn btn-primary" id="modal-ok">${i18n.t('common.close')}</button></div>
          `, { width: '520px' });
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

  // ─── v8.9.5-alpha.1 — Register a non-Docker daemon ────────────────
  // Wizard for adding Incus / LXD / Proxmox / Kubernetes / Nomad hosts.
  // Each type has its own daemon_config shape; the form renders the
  // right fields based on the selected type. Backend endpoint is the
  // same POST /hosts — it dispatches on the `daemonType` field.
  async _addNonDockerHostDialog() {
    const html = `
      <div class="form-group">
        <label>Daemon type</label>
        <select id="ndh-type" class="form-control">
          <option value="incus">Incus (containers + KVM VMs)</option>
          <option value="lxd">LXD (Canonical — containers + KVM VMs)</option>
          <option value="proxmox">Proxmox VE (VMs + LXC)</option>
          <option value="kubernetes">Kubernetes (k3s / k0s / MicroK8s / kubeadm)</option>
          <option value="nomad">Nomad (HashiCorp workload orchestrator)</option>
          <option value="vsphere">VMware vSphere / ESXi (VMs, hosts, datastores — read-only)</option>
        </select>
        <small class="text-muted">Each type has its own configuration shape below.</small>
      </div>
      <div class="form-group">
        <label>Host name (display label)</label>
        <input type="text" id="ndh-name" class="form-control" placeholder="prod-k3s" required>
      </div>
      <div id="ndh-type-fields"></div>
      <div class="form-group" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button type="button" class="btn btn-sm btn-secondary" id="ndh-test-btn">
          <i class="fas fa-plug"></i> Test connection
        </button>
        <span id="ndh-test-result" style="font-size:12px;color:var(--text-dim)"></span>
      </div>
    `;

    const result = await Modal.form(html, {
      title: 'Register non-Docker host (alpha)',
      width: '600px',
      onSubmit: (content) => this._collectNonDockerFormData(content),
      onMount: (content) => this._setupNonDockerFormToggle(content),
    });

    if (result) {
      try {
        await Api.createHost(result);
        Toast.success(`${result.daemonType} host registered`);
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  _setupNonDockerFormToggle(content) {
    const typeSel = content.querySelector('#ndh-type');
    const fieldsEl = content.querySelector('#ndh-type-fields');
    if (!typeSel || !fieldsEl) return;
    const wireTransportToggle = () => {
      const trSel = fieldsEl.querySelector('#ndh-transport');
      if (!trSel) return;
      const apply = () => {
        const chosen = trSel.value;
        fieldsEl.querySelectorAll('[data-transport]').forEach(el => {
          el.style.display = (el.getAttribute('data-transport') === chosen) ? '' : 'none';
        });
      };
      trSel.addEventListener('change', apply);
      apply();
    };
    const renderFields = () => {
      const type = typeSel.value;
      fieldsEl.innerHTML = this._renderNonDockerFields(type);
      wireTransportToggle();
      // v8.9.15-alpha.2 — wire the "Test SSH" button when vSphere is chosen.
      if (type === 'vsphere') this._wireSshTest(content);
      // v8.9.11-alpha.3 — reset test result on any type change
      const resultEl = content.querySelector('#ndh-test-result');
      if (resultEl) { resultEl.textContent = ''; resultEl.style.color = 'var(--text-dim)'; }
    };
    typeSel.addEventListener('change', renderFields);
    renderFields();

    // v8.9.11-alpha.3 — Test connection button.
    // Uses the same _collectNonDockerFormData() the submit path uses, so
    // the exact payload we'd save is the exact payload we test with.
    const testBtn = content.querySelector('#ndh-test-btn');
    const resultEl = content.querySelector('#ndh-test-result');
    if (testBtn && resultEl) {
      testBtn.addEventListener('click', async () => {
        // Temporarily bypass the name-required check for the test path —
        // _collectNonDockerFormData returns null on missing name.
        const nameField = content.querySelector('#ndh-name');
        const nameBackup = nameField.value;
        if (!nameField.value.trim()) nameField.value = '__test__';
        const data = this._collectNonDockerFormData(content);
        nameField.value = nameBackup;
        if (!data) {
          resultEl.textContent = 'Fill in the fields first.';
          resultEl.style.color = 'var(--yellow, #eab308)';
          return;
        }
        testBtn.disabled = true;
        resultEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing…';
        resultEl.style.color = 'var(--text-dim)';
        try {
          const r = await Api.testNonDockerHost(data.daemonType, data.daemonConfig);
          if (r && r.ok) {
            const s = r.summary || {};
            const bits = [];
            if (s.product) bits.push(Utils.escapeHtml(s.product));
            if (s.version) bits.push(`v${Utils.escapeHtml(s.version)}`);
            if (s.apiVersion) bits.push(`API ${Utils.escapeHtml(s.apiVersion)}`);
            if (s.server) bits.push(`server: ${Utils.escapeHtml(s.server)}`);
            if (s.region) bits.push(`region: ${Utils.escapeHtml(s.region)}`);
            resultEl.innerHTML = `<i class="fas fa-check-circle"></i> Connected — ${bits.join(' · ') || 'ok'}`;
            resultEl.style.color = 'var(--green, #22c55e)';
          } else {
            resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${Utils.escapeHtml((r && r.error) || 'Connection failed')}`;
            resultEl.style.color = 'var(--red, #ef4444)';
          }
        } catch (err) {
          resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}`;
          resultEl.style.color = 'var(--red, #ef4444)';
        } finally {
          testBtn.disabled = false;
        }
      });
    }
  },

  _renderNonDockerFields(type) {
    switch (type) {
      case 'incus':
      case 'lxd': {
        const defaultSocket = type === 'lxd'
          ? '/var/snap/lxd/common/lxd/unix.socket'
          : '/var/lib/incus/unix.socket';
        return `
          <div class="form-group">
            <label>Transport</label>
            <select id="ndh-transport" class="form-control">
              <option value="unix">Unix socket (local)</option>
              <option value="https">HTTPS (remote, client cert)</option>
            </select>
          </div>
          <div class="form-group" data-transport="unix">
            <label>Socket path</label>
            <input type="text" id="ndh-socket" class="form-control" value="${Utils.escapeHtml(defaultSocket)}">
            <small class="text-muted">Must be mounted into the docker-dash container.</small>
          </div>
          <div class="form-group" data-transport="https" style="display:none">
            <label>Endpoint</label>
            <input type="text" id="ndh-endpoint" class="form-control" placeholder="https://host.example.com:8443">
          </div>
          <div class="form-group" data-transport="https" style="display:none">
            <label>Client certificate (PEM)</label>
            <textarea id="ndh-cert" class="form-control" rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;..."></textarea>
          </div>
          <div class="form-group" data-transport="https" style="display:none">
            <label>Client key (PEM)</label>
            <textarea id="ndh-key" class="form-control" rows="3" placeholder="-----BEGIN PRIVATE KEY-----&#10;..."></textarea>
          </div>
          <div class="form-group" data-transport="https" style="display:none">
            <label><input type="checkbox" id="ndh-skip-tls"> Skip TLS verification (testing only)</label>
          </div>
        `;
      }
      case 'proxmox':
        return `
          <div class="form-group">
            <label>Endpoint</label>
            <input type="text" id="ndh-endpoint" class="form-control" placeholder="https://pve.example.com:8006" required>
          </div>
          <div class="form-group">
            <label>API token ID</label>
            <input type="text" id="ndh-token-id" class="form-control" placeholder="root@pam!docker-dash" required>
            <small class="text-muted">Format: <code>USER@REALM!TOKENID</code></small>
          </div>
          <div class="form-group">
            <label>API token secret (UUID)</label>
            <input type="password" id="ndh-token-secret" class="form-control" placeholder="a1b2c3d4-e5f6-..." required>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="ndh-skip-tls" checked> Skip TLS verification (self-signed cert)</label>
          </div>
        `;
      case 'kubernetes':
        return `
          <div class="form-group">
            <label>API server endpoint</label>
            <input type="text" id="ndh-endpoint" class="form-control" placeholder="https://k3s.example.com:6443" required>
          </div>
          <div class="form-group">
            <label>Bearer token (ServiceAccount)</label>
            <textarea id="ndh-token" class="form-control" rows="2" placeholder="eyJhbG..." required></textarea>
            <small class="text-muted">See <a href="#/howto/kubernetes-integration">Kubernetes integration howto</a> for the ServiceAccount + ClusterRoleBinding YAML.</small>
          </div>
          <div class="form-group">
            <label>CA certificate (PEM, optional)</label>
            <textarea id="ndh-ca" class="form-control" rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;..."></textarea>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="ndh-skip-tls"> Skip TLS verification (testing only)</label>
          </div>
        `;
      case 'nomad':
        return `
          <div class="form-group">
            <label>Endpoint</label>
            <input type="text" id="ndh-endpoint" class="form-control" placeholder="https://nomad.example.com:4646" required>
          </div>
          <div class="form-group">
            <label>ACL token (optional)</label>
            <input type="password" id="ndh-token" class="form-control" placeholder="SECRET-ID-UUID">
            <small class="text-muted">Leave empty if ACL is disabled on the cluster.</small>
          </div>
          <div class="form-group">
            <label>CA certificate (PEM, optional)</label>
            <textarea id="ndh-ca" class="form-control" rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;..."></textarea>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="ndh-skip-tls"> Skip TLS verification (testing only)</label>
          </div>
        `;
      case 'vsphere':
        return `
          <div class="form-group">
            <label>Endpoint</label>
            <input type="text" id="ndh-endpoint" class="form-control" placeholder="https://esxi.example.com" required>
            <small class="text-muted">Works with standalone ESXi (free / paid) or vCenter Server. Port 443 assumed.</small>
          </div>
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="ndh-username" class="form-control" placeholder="root (ESXi) or administrator@vsphere.local (vCenter)" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="ndh-password" class="form-control" required>
          </div>
          <div class="form-group">
            <label><input type="checkbox" id="ndh-skip-tls" checked> Skip TLS verification (default; ESXi ships with a self-signed cert)</label>
          </div>
          <details style="margin-top:6px">
            <summary style="cursor:pointer;font-size:13px">SSH access (optional — unlocks hardware sensors / VIBs / NICs)</summary>
            <div style="padding:8px 0">
              <small class="text-muted">Requires the SSH service enabled on the ESXi host. Used only for read-only esxcli telemetry.</small>
              <div class="form-group"><label>SSH host</label>
                <input type="text" id="ndh-ssh-host" class="form-control" placeholder="(defaults to the endpoint host)"></div>
              <div style="display:flex;gap:10px">
                <div class="form-group" style="flex:0 0 100px"><label>SSH port</label>
                  <input type="number" id="ndh-ssh-port" class="form-control" value="22"></div>
                <div class="form-group" style="flex:1"><label>SSH user</label>
                  <input type="text" id="ndh-ssh-user" class="form-control" value="root"></div>
              </div>
              <div class="form-group"><label>SSH password</label>
                <input type="password" id="ndh-ssh-password" class="form-control" placeholder="(or paste a private key below)"></div>
              <div class="form-group"><label>SSH private key (PEM, optional)</label>
                <textarea id="ndh-ssh-key" class="form-control" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."></textarea></div>
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <button type="button" class="btn btn-sm btn-secondary" id="ndh-ssh-test"><i class="fas fa-plug"></i> Test SSH</button>
                <span id="ndh-ssh-test-result" style="font-size:12px;color:var(--text-dim)"></span>
              </div>
            </div>
          </details>
        `;
      default:
        return '';
    }
  },

  // v8.9.15-alpha.2 — collect the SSH access fields into an sshConfig, or
  // null when incomplete. hostFallback lets the host default to the endpoint.
  _collectSshConfigFromForm(content, endpoint) {
    const val = (sel) => { const el = content.querySelector(sel); return el ? el.value : ''; };
    const user = val('#ndh-ssh-user').trim();
    const password = val('#ndh-ssh-password');
    const key = val('#ndh-ssh-key').trim();
    let host = val('#ndh-ssh-host').trim();
    if (!host && endpoint) {
      try { host = new URL(/^https?:\/\//.test(endpoint) ? endpoint : 'https://' + endpoint).hostname; }
      catch { host = endpoint; }
    }
    if (!host || !user) return null;
    return {
      host, port: parseInt(val('#ndh-ssh-port'), 10) || 22, user,
      ...(password ? { password } : {}),
      ...(key ? { privateKey: key } : {}),
    };
  },

  // Wire the "Test SSH" button (create + edit). hostId enables stored-secret
  // merge on the backend so a blank password/key in Edit still tests.
  _wireSshTest(content, hostId) {
    const btn = content.querySelector('#ndh-ssh-test');
    const resultEl = content.querySelector('#ndh-ssh-test-result');
    if (!btn || !resultEl) return;
    btn.addEventListener('click', async () => {
      const endpoint = (content.querySelector('#ndh-endpoint') || {}).value || '';
      // In Edit, host+user may be pre-filled but secrets blank — still allow
      // testing (backend merges stored secret via hostId).
      const cfg = this._collectSshConfigFromForm(content, endpoint) ||
        // fall back to a minimal cfg using stored merge when editing
        (hostId ? { host: (content.querySelector('#ndh-ssh-host')?.value || '').trim(),
          port: parseInt(content.querySelector('#ndh-ssh-port')?.value, 10) || 22,
          user: (content.querySelector('#ndh-ssh-user')?.value || '').trim() } : null);
      if (!cfg || !cfg.user) { resultEl.textContent = 'Fill in SSH user (+ host/password or key).'; resultEl.style.color = 'var(--yellow,#eab308)'; return; }
      btn.disabled = true;
      resultEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing SSH…';
      resultEl.style.color = 'var(--text-dim)';
      try {
        const r = await Api.testHostSsh(cfg, hostId);
        if (r && r.ok) {
          resultEl.innerHTML = `<i class="fas fa-check-circle"></i> Connected — ${Utils.escapeHtml(r.product || 'ESXi')} ${Utils.escapeHtml(r.version || '')}`.trim();
          resultEl.style.color = 'var(--green,#22c55e)';
        } else {
          resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${Utils.escapeHtml((r && r.error) || 'SSH failed')}`;
          resultEl.style.color = 'var(--red,#ef4444)';
        }
      } catch (err) {
        resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}`;
        resultEl.style.color = 'var(--red,#ef4444)';
      } finally { btn.disabled = false; }
    });
  },

  _collectNonDockerFormData(content) {
    // v8.9.11-alpha.7 — defensive reads. Both the create wizard (#ndh-type
    // is a <select>) and the edit dialog (#ndh-type is a hidden input) expose
    // the daemon type here, but never assume an element exists — a missing
    // field must not throw an unhandled promise rejection from the Test button.
    const val = (sel) => { const el = content.querySelector(sel); return el ? el.value : ''; };
    const daemonType = val('#ndh-type');
    if (!daemonType) return null;
    const name = val('#ndh-name').trim();
    if (!name) return null;
    const daemonConfig = {};
    // Checkbox reader (returns bool; false if the element is absent).
    const chk = (sel) => { const el = content.querySelector(sel); return el ? el.checked : false; };
    switch (daemonType) {
      case 'incus':
      case 'lxd': {
        const transport = val('#ndh-transport') || 'unix';
        daemonConfig.transport = transport;
        if (transport === 'unix') {
          daemonConfig.socket = val('#ndh-socket').trim();
        } else {
          daemonConfig.endpoint = val('#ndh-endpoint').trim();
          daemonConfig.cert = val('#ndh-cert').trim();
          daemonConfig.key = val('#ndh-key').trim();
          daemonConfig.skipTlsVerify = chk('#ndh-skip-tls');
        }
        break;
      }
      case 'proxmox':
        daemonConfig.endpoint = val('#ndh-endpoint').trim();
        daemonConfig.tokenId = val('#ndh-token-id').trim();
        daemonConfig.tokenSecret = val('#ndh-token-secret').trim();
        daemonConfig.skipTlsVerify = chk('#ndh-skip-tls');
        break;
      case 'kubernetes':
        daemonConfig.endpoint = val('#ndh-endpoint').trim();
        daemonConfig.token = val('#ndh-token').trim();
        daemonConfig.caCert = val('#ndh-ca').trim() || undefined;
        daemonConfig.skipTlsVerify = chk('#ndh-skip-tls');
        break;
      case 'nomad':
        daemonConfig.endpoint = val('#ndh-endpoint').trim();
        daemonConfig.token = val('#ndh-token').trim() || undefined;
        daemonConfig.caCert = val('#ndh-ca').trim() || undefined;
        daemonConfig.skipTlsVerify = chk('#ndh-skip-tls');
        break;
      case 'vsphere': {
        daemonConfig.endpoint = val('#ndh-endpoint').trim();
        daemonConfig.username = val('#ndh-username').trim();
        daemonConfig.password = val('#ndh-password');
        daemonConfig.skipTlsVerify = chk('#ndh-skip-tls');
        // Optional SSH config for esxcli telemetry (batch 3). Only include if
        // a host or credential was provided; default the host to the endpoint.
        const sshHost = val('#ndh-ssh-host').trim();
        const sshUser = val('#ndh-ssh-user').trim();
        const sshPassword = val('#ndh-ssh-password');
        const sshKey = val('#ndh-ssh-key').trim();
        if (sshUser && (sshPassword || sshKey)) {
          let host = sshHost;
          if (!host && daemonConfig.endpoint) {
            try { host = new URL(daemonConfig.endpoint.match(/^https?:\/\//) ? daemonConfig.endpoint : 'https://' + daemonConfig.endpoint).hostname; }
            catch { host = daemonConfig.endpoint; }
          }
          daemonConfig.sshConfig = {
            host, port: parseInt(val('#ndh-ssh-port'), 10) || 22, user: sshUser,
            ...(sshPassword ? { password: sshPassword } : {}),
            ...(sshKey ? { privateKey: sshKey } : {}),
          };
        }
        break;
      }
    }
    return { name, daemonType, daemonConfig };
  },

  // ─── v8.9.5-alpha.1 — Docs section explaining each daemon type ────
  // v8.9.11-alpha.5 — tab bodies delegate to the existing card renderers,
  // then force the inner card-body to be visible regardless of the
  // legacy `dd-hosts-*-collapsed` localStorage flags. The tab switcher
  // above controls visibility now; the inline `style="display:none"`
  // baked into the legacy render methods used to be toggled by header
  // clicks that we no longer wire, so we have to override it here.
  _stripCollapseHiding(html) {
    // Remove the `style="display:none"` that the collapsed-body branch
    // adds and drop the collapse toggle chevron so the card header is
    // no longer suggestive of a clickable region that does nothing.
    return html
      .replace(/style="display:none"/g, '')
      .replace(/style="\s*display:\s*none\s*"/g, '');
  },
  _renderDaemonTypesTabBody() { return this._stripCollapseHiding(this._renderDaemonTypesDocs()); },
  _renderGuideTabBody()       { return this._stripCollapseHiding(this._renderGuide()); },
  _renderSshKeyGuideTabBody() { return this._stripCollapseHiding(this._renderSshKeyGuide()); },

  _renderDaemonTypesDocs() {
    return `
      <div class="card" style="margin-top:24px">
        <div class="card-header" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center" id="daemon-types-toggle">
          <div><i class="fas fa-info-circle"></i> <strong>Supported daemon types</strong> <small class="text-muted">— overview of what Docker Dash can manage</small></div>
          <i class="fas fa-chevron-down"></i>
        </div>
        <div class="card-body" id="daemon-types-body">
          <table class="table" style="font-size:13px">
            <thead>
              <tr>
                <th style="width:14%">Type</th>
                <th style="width:14%">Auth</th>
                <th>What ships</th>
                <th style="width:11%">Read-only?</th>
                <th style="width:16%">Howto</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><i class="fab fa-docker"></i> <strong>Docker</strong></td>
                <td>Socket / TCP+TLS / SSH tunnel</td>
                <td>Full: containers, images, networks, volumes, compose, Swarm, buildkit, registries</td>
                <td>—</td>
                <td>(default)</td>
              </tr>
              <tr>
                <td><i class="fab fa-docker"></i> <strong>Podman</strong></td>
                <td>Socket / TCP+TLS / SSH tunnel</td>
                <td>Same as Docker minus Swarm + buildkit. Detected automatically via <code>version.Components</code>.</td>
                <td>—</td>
                <td><a href="#/howto/podman-integration">Podman</a></td>
              </tr>
              <tr>
                <td><i class="fas fa-cubes"></i> <strong>Incus</strong></td>
                <td>Unix socket / HTTPS + client cert</td>
                <td>Instances (containers + KVM VMs), snapshots, images, projects. State changes (start/stop/restart/delete).</td>
                <td>—</td>
                <td><a href="#/howto/incus-integration">Incus</a></td>
              </tr>
              <tr>
                <td><i class="fas fa-cubes"></i> <strong>LXD</strong></td>
                <td>Unix socket / HTTPS + client cert</td>
                <td>Same as Incus (shared REST API since the 2024 fork). Snap install default: <code>/var/snap/lxd/common/lxd/unix.socket</code>.</td>
                <td>—</td>
                <td><a href="#/howto/lxd-integration">LXD</a></td>
              </tr>
              <tr>
                <td><i class="fas fa-server"></i> <strong>Proxmox VE</strong></td>
                <td>API token (<code>USER@REALM!TOKENID</code>)</td>
                <td>Nodes, VMs, LXC, storages, backups. + VM Migration (VMDK/OVA/QCOW2/RAW → new VM).</td>
                <td>Read + Migrate</td>
                <td><a href="#/howto/proxmox-integration">Proxmox</a> · <a href="#/howto/vm-migration-to-proxmox">Migration</a></td>
              </tr>
              <tr>
                <td><i class="fas fa-dharmachakra"></i> <strong>Kubernetes</strong></td>
                <td>Bearer token (ServiceAccount)</td>
                <td>Deployments, Pods, Services, Namespaces, Nodes. Read-only in alpha.1.</td>
                <td>Yes (alpha.1)</td>
                <td><a href="#/howto/kubernetes-integration">Kubernetes</a></td>
              </tr>
              <tr>
                <td><i class="fas fa-tasks"></i> <strong>Nomad</strong></td>
                <td>ACL token in <code>X-Nomad-Token</code> (optional if ACL disabled)</td>
                <td>Jobs, allocations, deployments, nodes, namespaces. Read-only in alpha.1.</td>
                <td>Yes (alpha.1)</td>
                <td><a href="#/howto/nomad-integration">Nomad</a></td>
              </tr>
              <tr>
                <td><i class="fas fa-server"></i> <strong>VMware vSphere / ESXi</strong></td>
                <td>Username + password over SOAP (session cookie)</td>
                <td>VMs, ESXi hosts, datastores. Standalone ESXi + vCenter both supported. Read-only in alpha.1.</td>
                <td>Yes (alpha.1)</td>
                <td><a href="#/howto/vsphere-integration">vSphere</a></td>
              </tr>
            </tbody>
          </table>
          <div style="margin-top:12px;font-size:13px" class="text-muted">
            <strong>Wasm runtimes</strong> — When a Docker host has WasmEdge / wasmtime / Spin / etc. registered in <code>daemon.json</code>, docker-dash detects and categorizes them.
            No new daemon type — Wasm containers run through the existing Docker daemon.
            See <a href="#/howto/wasm-workloads">Wasm workloads</a>.
          </div>
          <div style="margin-top:12px;font-size:13px" class="text-muted">
            <strong>Security:</strong> every non-Docker <code>daemon_config</code> (client certs, bearer tokens, API tokens, SSH keys) is encrypted at rest via AES-256-GCM (<code>enc:</code> prefix), keyed by <code>ENCRYPTION_KEY</code> — same helper used for git credentials, Docker registry auth, and AI API keys.
          </div>
        </div>
      </div>
    `;
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

  // v8.9.11-alpha.6 — Edit dialog for non-Docker hosts. Reuses the
  // _renderNonDockerFields() template from the register wizard but
  // pre-fills with the current daemon_config (secrets marked "(already
  // set — leave blank to keep)").
  async _editNonDockerHostDialog(host) {
    const dc = host.daemonConfig || {};
    const daemonType = host.daemonType;
    const html = `
      <!-- v8.9.11-alpha.7 — hidden #ndh-type so _collectNonDockerFormData
           (shared with the create wizard) can read the daemon type here too.
           The disabled input below is display-only. -->
      <input type="hidden" id="ndh-type" value="${Utils.escapeHtml(daemonType)}">
      <div class="form-group">
        <label>Daemon type</label>
        <input type="text" class="form-control" value="${Utils.escapeHtml(daemonType)}" disabled>
        <small class="text-muted">Daemon type is fixed at create time. To change, delete and re-add.</small>
      </div>
      <div class="form-group">
        <label>Host name (display label)</label>
        <input type="text" id="ndh-name" class="form-control" value="${Utils.escapeHtml(host.name || '')}" required>
      </div>
      <div id="ndh-type-fields"></div>
      <div class="form-group" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button type="button" class="btn btn-sm btn-secondary" id="ndh-test-btn">
          <i class="fas fa-plug"></i> Test connection
        </button>
        <span id="ndh-test-result" style="font-size:12px;color:var(--text-dim)"></span>
      </div>
    `;
    const result = await Modal.form(html, {
      title: `Edit ${daemonType} host: ${host.name}`,
      width: '600px',
      onMount: (content) => {
        // Populate the fields for the fixed daemon type
        const fieldsEl = content.querySelector('#ndh-type-fields');
        fieldsEl.innerHTML = this._renderNonDockerFields(daemonType);
        // Wire transport toggle if applicable
        const trSel = fieldsEl.querySelector('#ndh-transport');
        if (trSel) {
          const apply = () => {
            const chosen = trSel.value;
            fieldsEl.querySelectorAll('[data-transport]').forEach(el => {
              el.style.display = (el.getAttribute('data-transport') === chosen) ? '' : 'none';
            });
          };
          trSel.addEventListener('change', apply);
          apply();
        }
        // Pre-fill values from current daemon_config.
        // Non-secret scalars use their real values; secrets get placeholder
        // "(already set — leave blank to keep)" and stay empty so a blank
        // submit preserves the stored secret.
        const set = (id, val) => { const el = content.querySelector(id); if (el && val !== undefined) el.value = val; };
        const setChecked = (id, val) => { const el = content.querySelector(id); if (el) el.checked = !!val; };
        const setPlaceholder = (id, present) => {
          const el = content.querySelector(id);
          if (el && present) el.placeholder = '(already set — leave blank to keep)';
        };
        switch (daemonType) {
          case 'incus':
          case 'lxd':
            if (trSel && dc.transport) trSel.value = dc.transport;
            if (trSel) trSel.dispatchEvent(new Event('change'));
            set('#ndh-socket', dc.socket);
            set('#ndh-endpoint', dc.endpoint);
            setChecked('#ndh-skip-tls', dc.skipTlsVerify);
            setPlaceholder('#ndh-cert', dc.certPresent);
            setPlaceholder('#ndh-key', dc.keyPresent);
            break;
          case 'proxmox':
            set('#ndh-endpoint', dc.endpoint);
            set('#ndh-token-id', dc.tokenId);
            setPlaceholder('#ndh-token-secret', dc.tokenSecretPresent);
            setChecked('#ndh-skip-tls', dc.skipTlsVerify);
            break;
          case 'kubernetes':
            set('#ndh-endpoint', dc.endpoint);
            setPlaceholder('#ndh-token', dc.tokenPresent);
            setPlaceholder('#ndh-ca', dc.caCertPresent);
            setChecked('#ndh-skip-tls', dc.skipTlsVerify);
            break;
          case 'nomad':
            set('#ndh-endpoint', dc.endpoint);
            setPlaceholder('#ndh-token', dc.tokenPresent);
            setPlaceholder('#ndh-ca', dc.caCertPresent);
            setChecked('#ndh-skip-tls', dc.skipTlsVerify);
            break;
          case 'vsphere':
            set('#ndh-endpoint', dc.endpoint);
            set('#ndh-username', dc.username);
            setPlaceholder('#ndh-password', dc.passwordPresent);
            setChecked('#ndh-skip-tls', dc.skipTlsVerify);
            // v8.9.15-alpha.2 — pre-fill SSH access (non-secret) + wire test.
            set('#ndh-ssh-host', dc.sshHost);
            if (dc.sshPort) set('#ndh-ssh-port', dc.sshPort);
            set('#ndh-ssh-user', dc.sshUser);
            setPlaceholder('#ndh-ssh-password', dc.sshPasswordPresent);
            setPlaceholder('#ndh-ssh-key', dc.sshKeyPresent);
            this._wireSshTest(content, host.id);
            break;
        }
        // Wire test connection button — same behavior as create wizard.
        const testBtn = content.querySelector('#ndh-test-btn');
        const resultEl = content.querySelector('#ndh-test-result');
        if (testBtn && resultEl) {
          testBtn.addEventListener('click', async () => {
            const data = this._collectNonDockerFormData(content);
            if (!data) { resultEl.textContent = 'Fill in the fields first.'; resultEl.style.color = 'var(--yellow, #eab308)'; return; }
            testBtn.disabled = true;
            resultEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing…';
            resultEl.style.color = 'var(--text-dim)';
            try {
              // Pass host.id so the backend merges stored secrets for any
              // field left blank ("already set — leave blank to keep").
              const r = await Api.testNonDockerHost(data.daemonType, data.daemonConfig, host.id);
              if (r && r.ok) {
                const s = r.summary || {};
                const bits = [];
                if (s.product) bits.push(Utils.escapeHtml(s.product));
                if (s.version) bits.push(`v${Utils.escapeHtml(s.version)}`);
                resultEl.innerHTML = `<i class="fas fa-check-circle"></i> Connected — ${bits.join(' · ') || 'ok'}`;
                resultEl.style.color = 'var(--green, #22c55e)';
              } else {
                resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${Utils.escapeHtml((r && r.error) || 'Connection failed')}`;
                resultEl.style.color = 'var(--red, #ef4444)';
              }
            } catch (err) {
              resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}`;
              resultEl.style.color = 'var(--red, #ef4444)';
            } finally { testBtn.disabled = false; }
          });
        }
      },
      onSubmit: (content) => this._collectNonDockerFormData(content),
    });

    if (result) {
      try {
        await Api.updateHost(host.id, result);
        Toast.success('Host updated');
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _editHostDialog(host) {
    // v8.9.11-alpha.6 — route non-Docker hosts to the type-appropriate
    // dialog. Docker/Podman hosts continue through the legacy path.
    const isNonDocker = host.daemonType && host.daemonType !== 'docker' && host.daemonType !== 'podman';
    if (isNonDocker) return this._editNonDockerHostDialog(host);
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

          <!-- NAS Docker — full-width row covering setup + Synology security best practices -->
          <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
              <i class="fas fa-hdd" style="color:#11457e;font-size:18px"></i>
              <strong style="font-size:14px">${i18n.t('pages.hosts.guideNasTitle')}</strong>
              <span class="badge" style="font-size:10px;background:var(--bg-dim)">${i18n.t('pages.hosts.guideNasBadge')}</span>
            </div>
            <p class="text-sm text-muted" style="margin:0 0 14px">${i18n.t('pages.hosts.guideNasIntro')}</p>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
              <!-- Connection setup -->
              <div>
                <div style="font-weight:600;margin-bottom:8px;font-size:13px">
                  <i class="fas fa-link" style="color:var(--accent);margin-right:6px"></i>${i18n.t('pages.hosts.guideNasConnTitle')}
                </div>
                <ol class="text-sm" style="padding-left:20px;line-height:1.9;margin:0;color:var(--text)">
                  <li>${i18n.t('pages.hosts.guideNasStep1')}</li>
                  <li>${i18n.t('pages.hosts.guideNasStep2')} <code>docker</code></li>
                  <li>${i18n.t('pages.hosts.guideNasStep3')} → <a href="#/howto/ssh-key-auth">${i18n.t('pages.hosts.guideNasStep3Link')}</a></li>
                  <li>${i18n.t('pages.hosts.guideNasStep4')}</li>
                  <li>${i18n.t('pages.hosts.guideNasGuides')}:
                    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
                      <a href="#/howto/synology-dsm" class="badge" style="background:#11457e;color:#fff;text-decoration:none;font-size:10px"><i class="fas fa-hdd" style="margin-right:4px"></i>Synology DSM</a>
                      <a href="#/howto/unraid" class="badge" style="background:#f15a29;color:#fff;text-decoration:none;font-size:10px"><i class="fab fa-docker" style="margin-right:4px"></i>Unraid</a>
                      <a href="#/howto/truenas-scale" class="badge" style="background:#0095d5;color:#fff;text-decoration:none;font-size:10px"><i class="fas fa-server" style="margin-right:4px"></i>TrueNAS SCALE</a>
                      <a href="#/howto/qnap-qts" class="badge" style="background:#ee3a25;color:#fff;text-decoration:none;font-size:10px"><i class="fas fa-hdd" style="margin-right:4px"></i>QNAP</a>
                      <a href="#/howto/openmediavault" class="badge" style="background:#43a047;color:#fff;text-decoration:none;font-size:10px"><i class="fas fa-server" style="margin-right:4px"></i>OpenMediaVault</a>
                    </div>
                  </li>
                </ol>
              </div>

              <!-- Synology security hardening -->
              <div>
                <div style="font-weight:600;margin-bottom:8px;font-size:13px;color:var(--green)">
                  <i class="fas fa-shield-alt" style="margin-right:6px"></i>${i18n.t('pages.hosts.guideNasSecTitle')}
                </div>
                <ul class="text-sm" style="padding-left:20px;line-height:1.9;margin:0;color:var(--text)">
                  <li>${i18n.t('pages.hosts.guideNasSec1')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec2')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec3')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec4')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec5')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec6')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec7')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec8')}</li>
                  <li>${i18n.t('pages.hosts.guideNasSec9')}</li>
                </ul>
              </div>
            </div>

            <div class="tip-box" style="margin-top:14px">
              <i class="fas fa-lightbulb"></i>
              <div>${i18n.t('pages.hosts.guideNasTip')}</div>
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

  _renderSshKeyGuide() {
    const collapsed = localStorage.getItem('dd-hosts-ssh-key-guide-collapsed') === 'true';
    return `
      <div class="card" style="margin-top:16px">
        <div class="card-header" id="ssh-key-guide-toggle" style="cursor:pointer;user-select:none">
          <h3>
            <i class="fas fa-key" style="color:var(--yellow);margin-right:8px"></i>${i18n.t('pages.hosts.guideSshKeyTitle')}
            <span class="badge" style="font-size:10px;margin-left:8px;background:var(--green-dim,rgba(74,222,128,.15));color:var(--green)">${i18n.t('pages.hosts.guideSshKeyBadge')}</span>
          </h3>
          <i class="fas ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="color:var(--text-dim)"></i>
        </div>
        <div class="card-body" id="ssh-key-guide-body" style="${collapsed ? 'display:none' : ''}">
          <p class="text-sm text-muted" style="margin:0 0 16px">${i18n.t('pages.hosts.guideSshKeyDesc')}</p>

          <!-- Step 1 -->
          <div style="font-size:11px;margin-bottom:6px;font-weight:600"><i class="fas fa-terminal" style="margin-right:4px;color:var(--accent)"></i>${i18n.t('pages.hosts.guideSshKeyStep1')}</div>
          <p class="text-sm text-muted" style="margin:0 0 6px">${i18n.t('pages.hosts.guideSshKeyStep1Sub')}</p>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
            ${[
              { os: 'Ubuntu / Debian 12+', cmd: 'ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-ubuntu' },
              { os: 'CentOS 7 / RHEL 7', cmd: 'ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-redhat' },
              { os: 'CentOS Stream 8-9 / RHEL 8-9 / Rocky / Alma', cmd: 'ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-redhat' },
              { os: 'Fedora', cmd: 'ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-fedora' },
              { os: 'Alpine', cmd: 'apk add openssh-client && ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-linux' },
              { os: 'SUSE / openSUSE', cmd: 'ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-suse' },
              { os: 'Arch / Manjaro', cmd: 'ssh-keygen -t ed25519 -C "docker-dash"', icon: 'fab fa-linux' },
            ].map(d => `
              <div style="display:flex;align-items:center;gap:8px;background:var(--surface2);padding:6px 10px;border-radius:var(--radius-sm);font-size:11px">
                <i class="${d.icon}" style="width:16px;text-align:center;color:var(--text-dim)"></i>
                <span style="min-width:200px;font-weight:500">${d.os}</span>
                <code style="font-family:'JetBrains Mono',monospace;flex:1;color:var(--accent)">${d.cmd}</code>
              </div>
            `).join('')}
          </div>

          <!-- Step 2 -->
          <div style="font-size:11px;margin-bottom:6px;font-weight:600"><i class="fas fa-upload" style="margin-right:4px;color:var(--accent)"></i>${i18n.t('pages.hosts.guideSshKeyStep2')}</div>
          <p class="text-sm text-muted" style="margin:0 0 6px">${i18n.t('pages.hosts.guideSshKeyStep2Sub')}</p>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
            ${[
              { os: 'Ubuntu / Debian 12+', cmd: 'ssh-copy-id your-user@remote-host', icon: 'fab fa-ubuntu' },
              { os: 'CentOS 7 / RHEL 7', cmd: 'sudo yum install -y openssh-clients && ssh-copy-id your-user@remote-host', icon: 'fab fa-redhat' },
              { os: 'CentOS Stream 8-9 / RHEL 8-9 / Rocky / Alma', cmd: 'sudo dnf install -y openssh-clients && ssh-copy-id your-user@remote-host', icon: 'fab fa-redhat' },
              { os: 'Fedora', cmd: 'sudo dnf install -y openssh-clients && ssh-copy-id your-user@remote-host', icon: 'fab fa-fedora' },
              { os: 'Alpine', cmd: 'apk add openssh-client && ssh-copy-id your-user@remote-host', icon: 'fab fa-linux' },
              { os: 'SUSE / openSUSE', cmd: 'sudo zypper install -y openssh && ssh-copy-id your-user@remote-host', icon: 'fab fa-suse' },
              { os: 'Arch / Manjaro', cmd: 'sudo pacman -S openssh && ssh-copy-id your-user@remote-host', icon: 'fab fa-linux' },
            ].map(d => `
              <div style="display:flex;align-items:center;gap:8px;background:var(--surface2);padding:6px 10px;border-radius:var(--radius-sm);font-size:11px">
                <i class="${d.icon}" style="width:16px;text-align:center;color:var(--text-dim)"></i>
                <span style="min-width:200px;font-weight:500">${d.os}</span>
                <code style="font-family:'JetBrains Mono',monospace;flex:1;color:var(--accent)">${d.cmd}</code>
              </div>
            `).join('')}
          </div>

          <!-- Step 3 -->
          <div style="font-size:11px;margin-bottom:6px;font-weight:600"><i class="fas fa-paste" style="margin-right:4px;color:var(--accent)"></i>${i18n.t('pages.hosts.guideSshKeyStep3')}</div>
          <p class="text-sm text-muted" style="margin:0 0 6px">${i18n.t('pages.hosts.guideSshKeyStep3Sub')}</p>
          <div class="code-block" style="font-size:11px;line-height:1.6;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);white-space:pre;font-family:'JetBrains Mono',monospace">cat ~/.ssh/id_ed25519
# Copy the entire output (including BEGIN/END lines)
# Paste it in the "SSH Private Key" field when adding a host</div>

          <div class="text-sm text-muted" style="margin-top:12px"><i class="fas fa-shield-alt" style="color:var(--green);margin-right:4px"></i>${i18n.t('pages.hosts.guideSshKeyNote')}</div>
        </div>
      </div>
    `;
  },

  destroy() {},
};

window.HostsPage = HostsPage;
