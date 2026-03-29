/* ═══════════════════════════════════════════════════
   pages/volumes.js — Volumes Management
   ═══════════════════════════════════════════════════ */
'use strict';

const VolumesPage = {
  _table: null,

  async render(container) {
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
      if (btn.dataset.action === 'inspect') this._inspect(name);
      else if (btn.dataset.action === 'remove') this._remove(name);
    });

    await this._load();
    this._refreshTimer = setInterval(() => this._load(), 30000);
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
