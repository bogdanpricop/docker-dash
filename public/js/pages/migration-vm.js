/* ═══════════════════════════════════════════════════
   pages/migration-vm.js — VM migration to Proxmox
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.2-alpha.1 — Sprint 7: cross-hypervisor VM migration to Proxmox.
//
// Positioning: this is the reason Proxmox integration exists in
// docker-dash. Proxmox has an excellent UI for MANAGING what's already
// there; docker-dash's value-add is GETTING THINGS TO Proxmox — from
// VMware VMDKs, OVA appliances, or other Proxmox clusters.
//
// This alpha ships:
//   - URL-source migration (wget on the Proxmox node)
//   - Sequential phases: download, extract (OVA), convert, create VM,
//     import disk, attach
//   - Live progress polling
//   - Phase log tailing per job
// Deferred:
//   - VMware source (needs SOAP client — see plans/research-vmware...md)
//   - File upload source (chunked upload machinery — v2)
//   - Cancel button
//   - Multi-disk OVA handling
//   - Windows driver injection via virt-v2v

const MigrationVMPage = {
  _pollTimer: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-exchange-alt"></i> VM Migration (alpha)</h1>
        <div>
          <button class="btn btn-sm btn-primary" id="migration-new">
            <i class="fas fa-plus"></i> New Migration
          </button>
          <button class="btn btn-sm btn-secondary" id="migration-refresh">
            <i class="fas fa-sync"></i> Refresh
          </button>
        </div>
      </div>
      <div class="alert alert-info" style="margin-bottom:16px">
        <i class="fas fa-info-circle"></i>
        <strong>Alpha.</strong> Migrates a disk image from a URL (VMDK/OVA/QCOW2/RAW) into a Proxmox VM.
        Prerequisite: the destination Proxmox host row must have <code>sshConfig</code> in its
        <code>daemon_config</code> — see the howto. Windows guests may need manual driver injection
        with <code>virt-v2v</code> after import. Concurrent migrations to the same VMID are not guarded.
      </div>
      <div id="migration-list-container">Loading...</div>
    `;
    container.querySelector('#migration-new').addEventListener('click', () => this._showNewJobModal());
    container.querySelector('#migration-refresh').addEventListener('click', () => this._load());
    await this._load();
    // Poll for updates every 3 s while the page is open.
    this._pollTimer = setInterval(() => this._load(), 3000);
  },

  destroy() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  async _load() {
    const el = document.getElementById('migration-list-container');
    if (!el) return;
    try {
      const jobs = await Api.listMigrationJobs();
      this._renderList(el, jobs);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _statusBadge(status) {
    const colorMap = { pending: 'yellow', running: 'blue', completed: 'green',
      failed: 'red', cancelled: 'yellow' };
    return `<span class="badge badge-${colorMap[status] || 'yellow'}">${Utils.escapeHtml(status)}</span>`;
  },

  _renderList(el, jobs) {
    if (!jobs.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-exchange-alt" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px"></i>No migration jobs yet. Click <em>New Migration</em> above.</div>`;
      return;
    }
    const rows = jobs.map(j => `
      <tr data-job-id="${j.id}" style="cursor:pointer">
        <td><strong>#${j.id}</strong></td>
        <td>${Utils.escapeHtml(j.destination_vm_name)} <span class="text-dim">(VMID ${j.destination_vmid})</span></td>
        <td>${Utils.escapeHtml(j.destination_node)}</td>
        <td>${Utils.escapeHtml(j.destination_storage)}</td>
        <td>${this._statusBadge(j.status)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <span>${j.progress}%</span>
            <div class="progress-bar" style="flex:1;min-width:80px;max-width:140px">
              <div class="progress-fill ${j.status === 'failed' ? 'red' : j.progress >= 100 ? 'green' : 'blue'}" style="width:${j.progress}%"></div>
            </div>
          </div>
        </td>
        <td class="text-dim text-sm">${Utils.escapeHtml(j.current_phase || '—')}</td>
        <td class="text-dim text-sm">${j.created_at ? Utils.formatDate(j.created_at) : '—'}</td>
      </tr>
    `).join('');
    el.innerHTML = `
      <div class="card"><div class="card-body" style="padding:0">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th><th>Target VM</th><th>Node</th><th>Storage</th>
              <th>Status</th><th>Progress</th><th>Phase</th><th>Created</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div></div>
    `;
    el.querySelectorAll('tr[data-job-id]').forEach(tr => {
      tr.addEventListener('click', () => this._showJobDetail(parseInt(tr.dataset.jobId, 10)));
    });
  },

  async _showJobDetail(jobId) {
    try {
      const job = await Api.getMigrationJob(jobId);
      const html = `
        <div class="modal-header">
          <h3><i class="fas fa-exchange-alt" style="margin-right:8px;color:var(--accent)"></i>Migration #${job.id}</h3>
          <button class="modal-close-btn" id="mig-detail-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <table class="info-table" style="margin-bottom:16px">
            <tr><td>Source URL</td><td><code style="font-size:11px">${Utils.escapeHtml(job.source_url || '—')}</code></td></tr>
            <tr><td>Source format</td><td>${Utils.escapeHtml(job.source_format || 'auto')}</td></tr>
            <tr><td>Target VM</td><td>${Utils.escapeHtml(job.destination_vm_name)} (VMID ${job.destination_vmid})</td></tr>
            <tr><td>Node / Storage</td><td>${Utils.escapeHtml(job.destination_node)} / ${Utils.escapeHtml(job.destination_storage)}</td></tr>
            <tr><td>Status</td><td>${this._statusBadge(job.status)} ${job.progress}%</td></tr>
            <tr><td>Current phase</td><td>${Utils.escapeHtml(job.current_phase || '—')}</td></tr>
            <tr><td>Started</td><td>${job.started_at ? Utils.formatDate(job.started_at) : '—'}</td></tr>
            <tr><td>Completed</td><td>${job.completed_at ? Utils.formatDate(job.completed_at) : '—'}</td></tr>
          </table>
          ${job.error ? `<div class="alert alert-danger"><strong>Error:</strong> ${Utils.escapeHtml(job.error)}</div>` : ''}
          <label><strong>Phase log</strong> (tail of stdout+stderr from remote SSH commands)</label>
          <pre class="log-viewer" style="max-height:400px;margin-top:8px">${Utils.escapeHtml(job.phase_log || '(no output yet)')}</pre>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="mig-detail-close">Close</button>
        </div>
      `;
      Modal.open(html, { width: '800px' });
      const close = () => Modal.close();
      Modal._content.querySelector('#mig-detail-x').addEventListener('click', close);
      Modal._content.querySelector('#mig-detail-close').addEventListener('click', close);
    } catch (err) { Toast.error(err.message); }
  },

  async _showNewJobModal() {
    // Pull the list of Proxmox hosts to populate the destination
    // dropdown. Only offer daemon_type=proxmox rows.
    let proxmoxHosts = [];
    try {
      const allHosts = await Api.getHosts();
      proxmoxHosts = allHosts.filter(h => h.daemonType === 'proxmox');
    } catch { /* no hosts endpoint or empty */ }
    if (!proxmoxHosts.length) {
      Toast.warning('No Proxmox hosts registered. Add one first (see the Proxmox howto).');
      return;
    }
    const hostOptions = proxmoxHosts.map(h =>
      `<option value="${h.id}">${Utils.escapeHtml(h.name)} (id ${h.id})</option>`
    ).join('');
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-plus" style="margin-right:8px;color:var(--accent)"></i>New VM Migration</h3>
        <button class="modal-close-btn" id="mig-new-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Source URL <span class="text-danger">*</span></label>
          <input id="mig-src-url" class="form-control" placeholder="https://example.com/appliance.ova"
            style="font-family:var(--mono);font-size:12px">
          <p class="text-muted text-sm" style="margin-top:4px">
            Must be an <code>http://</code> or <code>https://</code> URL that the destination Proxmox node
            can reach. Supported extensions: <code>.ova</code>, <code>.vmdk</code>, <code>.qcow2</code>,
            <code>.raw</code>, <code>.img</code>.
          </p>
        </div>
        <div class="form-group">
          <label>Source format</label>
          <select id="mig-src-format" class="form-control">
            <option value="auto" selected>auto-detect from URL</option>
            <option value="ova">OVA (VMware appliance)</option>
            <option value="vmdk">VMDK (VMware disk)</option>
            <option value="qcow2">QCOW2 (KVM/Proxmox native)</option>
            <option value="raw">RAW</option>
          </select>
        </div>
        <div class="form-group">
          <label>Destination Proxmox host <span class="text-danger">*</span></label>
          <select id="mig-dest-host" class="form-control">${hostOptions}</select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Proxmox node <span class="text-danger">*</span></label>
            <input id="mig-dest-node" class="form-control" placeholder="pve" maxlength="63">
          </div>
          <div class="form-group">
            <label>Storage <span class="text-danger">*</span></label>
            <input id="mig-dest-storage" class="form-control" placeholder="local-lvm" maxlength="63">
          </div>
          <div class="form-group">
            <label>New VMID <span class="text-danger">*</span></label>
            <input id="mig-dest-vmid" class="form-control" type="number" min="100" max="999999999" placeholder="200">
          </div>
          <div class="form-group">
            <label>New VM name <span class="text-danger">*</span></label>
            <input id="mig-dest-name" class="form-control" placeholder="migrated-web" maxlength="63">
          </div>
        </div>
        <div class="alert alert-warning" style="margin-top:12px">
          <i class="fas fa-exclamation-triangle"></i>
          The imported VM is created stopped with 2 GB RAM, 2 cores, and net0=virtio bridged to
          vmbr0. Adjust in the Proxmox UI afterwards. Linux guests generally boot as-is; Windows
          guests may need <code>virt-io</code> drivers.
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="mig-new-cancel">Cancel</button>
        <button class="btn btn-primary" id="mig-new-go"><i class="fas fa-play"></i> Start migration</button>
      </div>
    `;
    Modal.open(html, { width: '640px' });
    const close = () => Modal.close();
    Modal._content.querySelector('#mig-new-x').addEventListener('click', close);
    Modal._content.querySelector('#mig-new-cancel').addEventListener('click', close);
    Modal._content.querySelector('#mig-new-go').addEventListener('click', async () => {
      const spec = {
        sourceUrl: Modal._content.querySelector('#mig-src-url').value.trim(),
        sourceFormat: Modal._content.querySelector('#mig-src-format').value,
        destinationHostId: parseInt(Modal._content.querySelector('#mig-dest-host').value, 10),
        destinationNode: Modal._content.querySelector('#mig-dest-node').value.trim(),
        destinationStorage: Modal._content.querySelector('#mig-dest-storage').value.trim(),
        destinationVmid: parseInt(Modal._content.querySelector('#mig-dest-vmid').value, 10),
        destinationVmName: Modal._content.querySelector('#mig-dest-name').value.trim(),
      };
      try {
        const r = await Api.createMigrationJob(spec);
        Toast.success(`Migration #${r.jobId} started`);
        close();
        await this._load();
      } catch (err) { Toast.error(err.message); }
    });
  },
};

window.MigrationVMPage = MigrationVMPage;
