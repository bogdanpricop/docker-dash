/* ═══════════════════════════════════════════════════
   pages/volumes.js — Volumes Management
   ═══════════════════════════════════════════════════ */
'use strict';

const VolumesPage = {
  _table: null,
  _view: 'list',

  async render(container, params = {}) {
    if (params.id) {
      this._view = 'detail';
      await this._renderDetail(container, params.id);
    } else {
      this._view = 'list';
      container.innerHTML = `
        <div class="page-header">
          <h2><i class="fas fa-database"></i> ${i18n.t('pages.volumes.title')}</h2>
          <div class="page-actions">
            <div class="search-box">
              <i class="fas fa-search"></i>
              <input type="text" id="vol-search" placeholder="${i18n.t('pages.volumes.filterPlaceholder')}">
            </div>
            <button class="btn btn-sm btn-primary" id="vol-create">
              <i class="fas fa-plus"></i> Create
            </button>
            <button class="prune-help-btn" id="vol-help" title="${i18n.t('pages.volumes.helpTooltip')}">?</button>
            <button class="btn btn-sm btn-secondary" id="vol-refresh">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
        </div>
        <div id="vol-table"></div>
        <div id="vol-footer" class="table-footer" style="display:none"></div>
      `;

      this._table = new DataTable(container.querySelector('#vol-table'), {
        columns: [
          { key: 'name', label: i18n.t('pages.volumes.name'), render: v => `<span class="mono">${Utils.escapeHtml(v && v.length > 40 ? v.substring(0, 12) + '...' : (v || ''))}</span>` },
          { key: 'driver', label: i18n.t('pages.volumes.driver') },
          { key: 'mountpoint', label: i18n.t('pages.volumes.mountpoint'), render: v => `<span class="mono text-sm">${Utils.escapeHtml(v || '')}</span>` },
          { key: 'scope', label: i18n.t('pages.volumes.scope') },
          { key: 'size', label: i18n.t('pages.images.size'), render: v => v >= 0 ? Utils.formatBytes(v) : '—' },
          { key: '_created', label: i18n.t('pages.volumes.created'), render: (_, row) => Utils.timeAgo(row.created) },
          { key: '_actions', label: '', sortable: false, width: '100px', render: (_, row) => `
            <div class="action-btns">
              <button class="action-btn" data-action="inspect" data-name="${Utils.escapeHtml(row.name)}" title="${i18n.t('pages.volumes.inspect')}"><i class="fas fa-info-circle"></i></button>
              <button class="action-btn danger" data-action="remove" data-name="${Utils.escapeHtml(row.name)}" title="${i18n.t('common.remove')}"><i class="fas fa-trash"></i></button>
            </div>
          `},
        ],
        emptyText: i18n.t('pages.volumes.noVolumes'),
      });

      container.querySelector('#vol-search').addEventListener('input',
        Utils.debounce(e => this._table.setFilter(e.target.value), 200));
      container.querySelector('#vol-create').addEventListener('click', () => this._createDialog());
      container.querySelector('#vol-help').addEventListener('click', () => this._showHelp());
      container.querySelector('#vol-refresh').addEventListener('click', () => this._load());

      // Event delegation for table action buttons
      container.querySelector('#vol-table').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const name = btn.dataset.name;
        if (btn.dataset.action === 'inspect') App.navigate(`/volumes/${encodeURIComponent(name)}`);
        else if (btn.dataset.action === 'remove') this._remove(name);
      });

      // Right-click context menu for volume rows
      container.querySelector('#vol-table').addEventListener('contextmenu', (e) => {
        const btn = e.target.closest('[data-name]');
        if (!btn) return;
        e.preventDefault();
        const name = btn.dataset.name;
        ContextMenu.show(e, [
          { label: 'View Details', icon: 'fa-info-circle', action: () => App.navigate(`/volumes/${encodeURIComponent(name)}`) },
          { label: 'Inspect JSON', icon: 'fa-code', action: () => this._inspect(name) },
          { type: 'separator' },
          { label: 'Remove', icon: 'fa-trash', action: () => this._remove(name), danger: true },
        ]);
      });

      await this._load();
      this._refreshTimer = setInterval(() => this._load(), 30000);
    }
  },

  async _renderDetail(container, volumeName) {
    container.innerHTML = `
      <div class="page-header">
        <div class="breadcrumb">
          <a href="#/volumes"><i class="fas fa-arrow-left"></i> Volumes</a>
          <span class="bc-sep">/</span>
          <span id="vol-detail-name">Loading...</span>
        </div>
      </div>
      <div class="tabs" id="vol-tabs">
        <button class="tab active" data-tab="overview">Overview</button>
        <button class="tab" data-tab="containers">Connected Containers</button>
        <button class="tab" data-tab="inspect">Inspect</button>
      </div>
      <div id="vol-detail-content"></div>
    `;

    try {
      const vol = await Api.getVolume(decodeURIComponent(volumeName));
      this._volData = vol;
      container.querySelector('#vol-detail-name').textContent = vol.Name || volumeName;

      // Tab switching
      container.querySelectorAll('#vol-tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
          container.querySelectorAll('#vol-tabs .tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          this._renderVolTab(tab.dataset.tab);
        });
      });

      this._renderVolTab('overview');
    } catch (err) {
      container.querySelector('#vol-detail-content').innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
    }
  },

  _renderVolTab(tab) {
    const el = document.getElementById('vol-detail-content');
    const vol = this._volData;
    if (!el || !vol) return;

    if (tab === 'overview') {
      const labels = Object.entries(vol.Labels || {}).map(([k, v]) =>
        `<tr><td class="mono text-sm">${Utils.escapeHtml(k)}</td><td class="mono text-sm">${Utils.escapeHtml(v)}</td></tr>`
      ).join('') || '<tr><td colspan="2" class="text-muted">No labels</td></tr>';

      el.innerHTML = `
        <div class="info-grid">
          <div class="card">
            <div class="card-header"><h3>General</h3></div>
            <div class="card-body">
              <table class="info-table">
                <tr><td>Name</td><td class="mono">${Utils.escapeHtml(vol.Name)}</td></tr>
                <tr><td>Driver</td><td>${Utils.escapeHtml(vol.Driver)}</td></tr>
                <tr><td>Scope</td><td><span class="badge badge-info">${Utils.escapeHtml(vol.Scope)}</span></td></tr>
                <tr><td>Mountpoint</td><td class="mono text-sm" style="word-break:break-all">${Utils.escapeHtml(vol.Mountpoint)}</td></tr>
                <tr><td>Created</td><td>${vol.CreatedAt ? Utils.timeAgo(vol.CreatedAt) : '—'}</td></tr>
              </table>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><h3>Labels</h3></div>
            <div class="card-body">
              <table class="data-table compact"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${labels}</tbody></table>
            </div>
          </div>
        </div>
      `;
    } else if (tab === 'containers') {
      el.innerHTML = '<div class="text-muted"><i class="fas fa-spinner fa-spin"></i> Finding connected containers...</div>';
      Api.getContainers(true).then(containers => {
        const connected = containers.filter(c =>
          (c.mounts || []).some(m => m.Name === vol.Name || m.Source === vol.Mountpoint)
        );
        if (connected.length === 0) {
          el.innerHTML = '<div class="empty-msg"><i class="fas fa-inbox"></i><p>No containers use this volume.</p></div>';
        } else {
          const rows = connected.map(c => {
            const mount = (c.mounts || []).find(m => m.Name === vol.Name || m.Source === vol.Mountpoint);
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.innerHTML = `
              <td>${Utils.escapeHtml(c.name)}</td>
              <td class="text-sm text-muted">${Utils.escapeHtml(c.image)}</td>
              <td><span class="badge ${Utils.statusBadgeClass(c.state)}">${c.state}</span></td>
              <td class="mono text-sm">${Utils.escapeHtml(mount?.Destination || '—')}</td>
            `;
            tr.addEventListener('click', () => App.navigate(`/containers/${c.id}`));
            return tr;
          });
          el.innerHTML = `
            <div class="card">
              <div class="card-header"><h3>${connected.length} Container(s) Using This Volume</h3></div>
              <div class="card-body">
                <table class="data-table compact">
                  <thead><tr><th>Container</th><th>Image</th><th>Status</th><th>Mount Path</th></tr></thead>
                  <tbody id="vol-containers-tbody"></tbody>
                </table>
              </div>
            </div>
          `;
          const tbody = el.querySelector('#vol-containers-tbody');
          rows.forEach(tr => tbody.appendChild(tr));
        }
      }).catch(err => {
        el.innerHTML = `<div class="empty-msg">Error: ${err.message}</div>`;
      });
    } else if (tab === 'inspect') {
      el.innerHTML = `
        <div class="card">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <h3>Raw Inspect</h3>
            <button class="btn btn-sm btn-secondary" id="vol-copy-inspect"><i class="fas fa-copy"></i> Copy</button>
          </div>
          <div class="card-body">
            <pre class="inspect-json" style="max-height:60vh;overflow:auto">${Utils.escapeHtml(JSON.stringify(vol, null, 2))}</pre>
          </div>
        </div>
      `;
      el.querySelector('#vol-copy-inspect')?.addEventListener('click', () => {
        Utils.copyToClipboard(JSON.stringify(vol, null, 2)).then(() => Toast.success('Copied'));
      });
    }
  },

  async _load() {
    try {
      const volumes = await Api.getVolumes();
      // API returns array directly from dockerService.listVolumes()
      const list = Array.isArray(volumes) ? volumes : (volumes.Volumes || []);
      list.forEach(v => { v._created = v.created; });
      this._table.setData(list);

      // Update footer
      const footer = document.getElementById('vol-footer');
      if (footer) {
        const withSize = list.filter(v => v.size >= 0);
        const totalSize = withSize.reduce((s, v) => s + v.size, 0);
        const sizeText = withSize.length > 0 ? ` &mdash; <strong>${Utils.formatBytes(totalSize)}</strong> total` : '';
        footer.innerHTML = `<i class="fas fa-database" style="margin-right:6px"></i><strong>${list.length}</strong> volumes${sizeText}`;
        footer.style.display = list.length > 0 ? '' : 'none';
      }
    } catch (err) {
      Toast.error(i18n.t('pages.volumes.loadFailed', { message: err.message }));
    }
  },

  async _createDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>Volume Name</label>
        <input type="text" id="vol-name" class="form-control" placeholder="my-volume" required>
      </div>
      <div class="form-group">
        <label>Driver</label>
        <select id="vol-driver" class="form-control">
          <option value="local" selected>local</option>
        </select>
      </div>
    `, {
      title: 'Create Volume',
      width: '420px',
      onSubmit: (content) => {
        const name = content.querySelector('#vol-name').value.trim();
        if (!name) { Toast.warning('Volume name is required'); return false; }
        return { name, driver: content.querySelector('#vol-driver').value };
      },
    });

    if (result) {
      try {
        await Api.createVolume(result);
        Toast.success(`Volume "${result.name}" created`);
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  async _inspect(name) {
    try {
      const data = await Api.getVolume(name);
      Modal.open(`
        <div class="modal-header"><h3>${i18n.t('pages.volumes.volumeTitle', { name: Utils.escapeHtml(name) })}</h3>
          <button class="modal-close-btn" id="vol-modal-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body"><pre class="inspect-json">${Utils.escapeHtml(JSON.stringify(data, null, 2))}</pre></div>
        <div class="modal-footer"><button class="btn btn-primary" id="vol-modal-close-btn">${i18n.t('common.close')}</button></div>
      `, { width: '600px' });
      Modal._content.querySelector('#vol-modal-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#vol-modal-close-btn').addEventListener('click', () => Modal.close());
    } catch (err) { Toast.error(err.message); }
  },

  async _remove(name) {
    const ok = await Modal.confirm(i18n.t('pages.volumes.removeConfirm', { name }), { danger: true, confirmText: i18n.t('common.remove') });
    if (!ok) return;
    try {
      await Api.removeVolume(name);
      Toast.success(i18n.t('pages.volumes.removed'));
      await this._load();
    } catch (err) { Toast.error(err.message); }
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.volumes.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.volumes.help.intro')}</p>

        <h4><i class="fas fa-database"></i> ${i18n.t('pages.volumes.help.storageTitle')}</h4>
        <p>${i18n.t('pages.volumes.help.storageBody')}</p>

        <h4><i class="fas fa-hdd"></i> ${i18n.t('pages.volumes.help.driverTitle')}</h4>
        <p>${i18n.t('pages.volumes.help.driverBody')}</p>

        <h4><i class="fas fa-map-marker-alt"></i> ${i18n.t('pages.volumes.help.mountpointTitle')}</h4>
        <p>${i18n.t('pages.volumes.help.mountpointBody')}</p>

        <h4><i class="fas fa-globe"></i> ${i18n.t('pages.volumes.help.scopeTitle')}</h4>
        <p>${i18n.t('pages.volumes.help.scopeBody')}</p>

        <div class="danger-text" style="margin-top:12px">
          <i class="fas fa-exclamation-circle"></i> <strong>${i18n.t('common.warning')}:</strong> ${i18n.t('pages.volumes.help.warningText')}
        </div>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          <strong>${i18n.t('common.tip')}:</strong> ${i18n.t('pages.volumes.help.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '600px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  destroy() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  },
};

window.VolumesPage = VolumesPage;
