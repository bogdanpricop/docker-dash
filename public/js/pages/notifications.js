/* ═══════════════════════════════════════════════════
   pages/notifications.js — Notifications Center
   ═══════════════════════════════════════════════════ */
'use strict';

const NotificationsPage = {
  _page: 1,
  _limit: 25,
  _filter: 'all', // all | unread | read
  _typeFilter: '',
  _selectedIds: new Set(),

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2><i class="fas fa-bell"></i> ${i18n.t('notifications.title')}</h2>
          <div class="page-subtitle">Notification history and management</div>
        </div>
        <div class="page-actions" style="gap:8px">
          <select id="notif-type-filter" class="form-control form-control-sm" style="width:140px">
            <option value="">All types</option>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
          <select id="notif-read-filter" class="form-control form-control-sm" style="width:130px">
            <option value="all">All</option>
            <option value="unread">Unread only</option>
            <option value="read">Read only</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="notif-mark-all" title="${i18n.t('notifications.markAllRead')}">
            <i class="fas fa-check-double"></i> Mark all read
          </button>
          <button class="btn btn-sm btn-danger" id="notif-bulk-delete" style="display:none">
            <i class="fas fa-trash"></i> Delete selected (<span id="notif-sel-count">0</span>)
          </button>
          <button class="btn btn-sm btn-secondary" id="notif-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div id="notif-content"><div class="text-muted"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div></div>
      <div id="notif-pagination" style="margin-top:16px;display:flex;justify-content:center;gap:8px"></div>
    `;

    container.querySelector('#notif-refresh').addEventListener('click', () => this._load());
    container.querySelector('#notif-mark-all').addEventListener('click', async () => {
      await Api.markAllNotificationsRead();
      Toast.success('All notifications marked as read');
      this._load();
    });
    container.querySelector('#notif-bulk-delete').addEventListener('click', async () => {
      if (this._selectedIds.size === 0) return;
      const ok = await Modal.confirm(`Delete ${this._selectedIds.size} notification(s)?`, { danger: true });
      if (!ok) return;
      await Api.bulkNotifications([...this._selectedIds], 'delete');
      this._selectedIds.clear();
      Toast.success('Notifications deleted');
      this._load();
    });
    container.querySelector('#notif-read-filter').addEventListener('change', (e) => {
      this._filter = e.target.value;
      this._page = 1;
      this._load();
    });
    container.querySelector('#notif-type-filter').addEventListener('change', (e) => {
      this._typeFilter = e.target.value;
      this._page = 1;
      this._load();
    });

    await this._load();
  },

  async _load() {
    const el = document.getElementById('notif-content');
    if (!el) return;

    try {
      const params = { page: this._page, limit: this._limit };
      if (this._filter === 'unread') params.unreadOnly = 'true';
      if (this._typeFilter) params.type = this._typeFilter;

      const data = await Api.getNotifications(params);
      const items = data.items || data || [];
      const total = data.total || items.length;
      const totalPages = Math.ceil(total / this._limit);

      // Filter read on client side (backend supports unreadOnly but not readOnly)
      const filtered = this._filter === 'read' ? items.filter(n => n.is_read) : items;

      if (filtered.length === 0) {
        el.innerHTML = `
          <div class="empty-msg" style="padding:48px">
            <i class="fas fa-bell-slash" style="font-size:48px;opacity:0.3;margin-bottom:12px"></i>
            <p>${i18n.t('notifications.empty')}</p>
          </div>`;
        document.getElementById('notif-pagination').innerHTML = '';
        return;
      }

      el.innerHTML = `
        <div class="card">
          <div class="card-body" style="padding:0">
            <table class="data-table" style="margin:0">
              <thead>
                <tr>
                  <th style="width:40px"><input type="checkbox" id="notif-select-all" title="Select all"></th>
                  <th style="width:40px">Type</th>
                  <th>Title</th>
                  <th>Message</th>
                  <th style="width:140px">Time</th>
                  <th style="width:80px">Status</th>
                  <th style="width:100px">${i18n.t('common.actions')}</th>
                </tr>
              </thead>
              <tbody id="notif-tbody">
                ${filtered.map(n => this._renderRow(n)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Select all checkbox
      el.querySelector('#notif-select-all')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        el.querySelectorAll('.notif-checkbox').forEach(cb => {
          cb.checked = checked;
          const id = parseInt(cb.dataset.id);
          if (checked) this._selectedIds.add(id);
          else this._selectedIds.delete(id);
        });
        this._updateBulkBtn();
      });

      // Individual checkboxes
      el.querySelectorAll('.notif-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const id = parseInt(cb.dataset.id);
          if (e.target.checked) this._selectedIds.add(id);
          else this._selectedIds.delete(id);
          this._updateBulkBtn();
        });
      });

      // Mark read buttons
      el.querySelectorAll('.notif-read-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await Api.markNotificationRead(parseInt(btn.dataset.id));
          this._load();
        });
      });

      // Delete buttons
      el.querySelectorAll('.notif-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await Api.deleteNotification(parseInt(btn.dataset.id));
          Toast.success('Notification deleted');
          this._load();
        });
      });

      // Pagination
      this._renderPagination(totalPages);
    } catch (err) {
      el.innerHTML = `<div class="empty-msg" style="padding:24px;color:var(--red)"><i class="fas fa-exclamation-triangle"></i> Failed to load: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderRow(n) {
    const severity = n.type || 'info';
    const icons = {
      error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle',
      success: 'fa-check-circle', info: 'fa-info-circle',
    };
    const colors = {
      error: 'var(--red)', warning: 'var(--yellow)',
      success: 'var(--green)', info: 'var(--accent)',
    };
    const iconClass = icons[severity] || icons.info;
    const color = colors[severity] || colors.info;
    const isSelected = this._selectedIds.has(n.id);

    return `
      <tr style="${n.is_read ? 'opacity:0.7' : 'font-weight:500'}">
        <td><input type="checkbox" class="notif-checkbox" data-id="${n.id}" ${isSelected ? 'checked' : ''}></td>
        <td><i class="fas ${iconClass}" style="color:${color}" title="${Utils.escapeHtml(severity)}"></i></td>
        <td>${Utils.escapeHtml(n.title || '')}${n.link ? ` <a href="${Utils.escapeHtml(n.link)}" style="color:var(--accent);font-size:12px"><i class="fas fa-external-link-alt"></i></a>` : ''}</td>
        <td class="text-muted text-sm">${Utils.escapeHtml(n.message || '')}</td>
        <td class="text-muted text-sm" title="${Utils.formatDate(n.created_at)}">${Utils.timeAgo(n.created_at)}</td>
        <td>${n.is_read ? '<span class="badge" style="background:var(--surface2);color:var(--text-muted)">Read</span>' : '<span class="badge badge-info">Unread</span>'}</td>
        <td style="display:flex;gap:4px">
          ${!n.is_read ? `<button class="action-btn notif-read-btn" data-id="${n.id}" title="Mark read"><i class="fas fa-check"></i></button>` : ''}
          <button class="action-btn notif-delete-btn" data-id="${n.id}" title="${i18n.t('common.delete')}"><i class="fas fa-trash"></i></button>
        </td>
      </tr>
    `;
  },

  _renderPagination(totalPages) {
    const pagEl = document.getElementById('notif-pagination');
    if (!pagEl || totalPages <= 1) { if (pagEl) pagEl.innerHTML = ''; return; }

    let html = '';
    if (this._page > 1) html += `<button class="btn btn-sm btn-secondary" data-p="${this._page - 1}"><i class="fas fa-chevron-left"></i></button>`;
    for (let p = 1; p <= totalPages; p++) {
      html += `<button class="btn btn-sm ${p === this._page ? 'btn-primary' : 'btn-secondary'}" data-p="${p}">${p}</button>`;
    }
    if (this._page < totalPages) html += `<button class="btn btn-sm btn-secondary" data-p="${this._page + 1}"><i class="fas fa-chevron-right"></i></button>`;
    pagEl.innerHTML = html;

    pagEl.querySelectorAll('button[data-p]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._page = parseInt(btn.dataset.p);
        this._load();
      });
    });
  },

  _updateBulkBtn() {
    const btn = document.getElementById('notif-bulk-delete');
    const count = document.getElementById('notif-sel-count');
    if (btn) btn.style.display = this._selectedIds.size > 0 ? '' : 'none';
    if (count) count.textContent = this._selectedIds.size;
  },

  destroy() {
    this._selectedIds.clear();
    this._page = 1;
  },
};

window.NotificationsPage = NotificationsPage;
