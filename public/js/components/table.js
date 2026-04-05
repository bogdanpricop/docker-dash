/* ═══════════════════════════════════════════════════
   components/table.js — Reusable Data Table
   ═══════════════════════════════════════════════════ */
'use strict';

class DataTable {
  /**
   * @param {HTMLElement} container
   * @param {Object} opts
   * @param {Array<{key, label, render?, sortable?, width?}>} opts.columns
   * @param {Function} opts.onRowClick
   * @param {boolean} opts.selectable
   * @param {Function} opts.rowClass
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.columns = opts.columns || [];
    this.onRowClick = opts.onRowClick || null;
    this.selectable = opts.selectable || false;
    this.rowClass = opts.rowClass || null;
    this.emptyText = opts.emptyText || 'No data';

    this._data = [];
    this._sortKey = null;
    this._sortDir = 'asc';
    this._selected = new Set();
    this._filter = '';

    this._build();
  }

  _build() {
    this.container.innerHTML = '';
    this.container.className = (this.container.className || '') + ' data-table-wrapper';

    this._table = document.createElement('table');
    this._table.className = 'data-table';

    // Header
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');

    if (this.selectable) {
      const thSel = document.createElement('th');
      thSel.className = 'th-select';
      thSel.innerHTML = '<input type="checkbox" class="select-all">';
      thSel.querySelector('.select-all').addEventListener('change', (e) => {
        if (e.target.checked) {
          this._data.forEach((_, i) => this._selected.add(i));
        } else {
          this._selected.clear();
        }
        this._renderBody();
        this._emitSelectionChange();
      });
      tr.appendChild(thSel);
    }

    for (const col of this.columns) {
      const th = document.createElement('th');
      th.textContent = col.label || col.key;
      if (col.width) th.style.width = col.width;
      if (col.sortable !== false) {
        th.classList.add('sortable');
        th.addEventListener('click', () => this._sort(col.key));
      }
      th.dataset.key = col.key;
      tr.appendChild(th);
    }

    thead.appendChild(tr);
    this._table.appendChild(thead);

    // Body
    this._tbody = document.createElement('tbody');
    this._table.appendChild(this._tbody);

    this.container.appendChild(this._table);

    // Empty state
    this._emptyEl = document.createElement('div');
    this._emptyEl.className = 'table-empty';
    this._emptyEl.textContent = this.emptyText;
    this.container.appendChild(this._emptyEl);

    // Enterprise: column visibility gear icon
    this._renderColumnConfig();
  }

  setData(data) {
    this._data = data || [];
    this._selected.clear();
    this._renderBody();
  }

  setFilter(text) {
    this._filter = (text || '').toLowerCase();
    this._renderBody();
  }

  getSelected() {
    return [...this._selected].map(i => this._data[i]).filter(Boolean);
  }

  _sort(key) {
    if (this._sortKey === key) {
      this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortKey = key;
      this._sortDir = 'asc';
    }
    // Update sort indicators
    this._table.querySelectorAll('th').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.key === key) th.classList.add(`sort-${this._sortDir}`);
    });
    this._renderBody();
  }

  _getFilteredData() {
    let data = [...this._data.map((item, idx) => ({ ...item, _idx: idx }))];

    // Filter
    if (this._filter) {
      data = data.filter(item => {
        return this.columns.some(col => {
          const val = item[col.key];
          if (val == null) return false;
          return String(val).toLowerCase().includes(this._filter);
        });
      });
    }

    // Sort
    if (this._sortKey) {
      data.sort((a, b) => {
        let va = a[this._sortKey], vb = b[this._sortKey];
        if (va == null) va = '';
        if (vb == null) vb = '';
        if (typeof va === 'number' && typeof vb === 'number') {
          return this._sortDir === 'asc' ? va - vb : vb - va;
        }
        va = String(va).toLowerCase();
        vb = String(vb).toLowerCase();
        const cmp = va.localeCompare(vb);
        return this._sortDir === 'asc' ? cmp : -cmp;
      });
    }

    return data;
  }

  _renderBody() {
    const data = this._getFilteredData();
    this._tbody.innerHTML = '';

    this._emptyEl.style.display = data.length === 0 ? 'block' : 'none';
    this._table.style.display = data.length === 0 ? 'none' : '';

    for (const item of data) {
      const tr = document.createElement('tr');
      if (this.rowClass) {
        const cls = this.rowClass(item);
        if (cls) tr.className = cls;
      }
      if (this.onRowClick) {
        tr.classList.add('clickable');
        tr.addEventListener('click', (e) => {
          if (e.target.closest('.select-cell, .action-btn, button, a, input')) return;
          this.onRowClick(item);
        });
      }

      if (this.selectable) {
        const td = document.createElement('td');
        td.className = 'select-cell';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this._selected.has(item._idx);
        cb.addEventListener('change', () => {
          if (cb.checked) this._selected.add(item._idx);
          else this._selected.delete(item._idx);
          this._emitSelectionChange();
        });
        td.appendChild(cb);
        tr.appendChild(td);
      }

      for (const col of this.columns) {
        const td = document.createElement('td');
        if (col.render) {
          const result = col.render(item[col.key], item);
          if (typeof result === 'string') td.innerHTML = result;
          else if (result && result.nodeType) td.appendChild(result);
          else td.textContent = result ?? '';
        } else {
          td.textContent = item[col.key] ?? '—';
        }
        tr.appendChild(td);
      }

      this._tbody.appendChild(tr);
    }

    // Re-apply column visibility after body re-render (Enterprise mode)
    this._applyColumnVisibility();
  }

  _emitSelectionChange() {
    if (this._onSelectionChange) {
      this._onSelectionChange(this.getSelected());
    }
  }

  onSelectionChange(fn) {
    this._onSelectionChange = fn;
  }

  // ─── Enterprise: Column Visibility ────────────

  _renderColumnConfig() {
    if (document.documentElement.getAttribute('data-uimode') !== 'enterprise') return;
    if (!this._table) return;

    const wrapper = this.container.closest('.card') || this.container.parentElement;
    if (!wrapper) return;

    // Don't add twice
    if (wrapper.querySelector('.col-config-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'col-config-btn';
    btn.innerHTML = '<i class="fas fa-cog"></i>';
    btn.title = 'Configure columns';
    btn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:5;background:var(--surface3);border:1px solid var(--border);color:var(--text-dim);width:24px;height:24px;border-radius:4px;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;';

    wrapper.style.position = 'relative';
    wrapper.appendChild(btn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Remove existing dropdown
      const existing = wrapper.querySelector('.col-config-dropdown');
      if (existing) { existing.remove(); return; }

      const dropdown = document.createElement('div');
      dropdown.className = 'col-config-dropdown';
      dropdown.style.cssText = 'position:absolute;top:34px;right:8px;z-index:10;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);padding:8px 0;min-width:180px;';

      this.columns.forEach((col) => {
        if (!col.label) return; // skip action columns without labels
        const isHidden = col._hidden || false;
        const item = document.createElement('label');
        item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:12px;color:var(--text);cursor:pointer;';
        item.innerHTML = `<input type="checkbox" ${isHidden ? '' : 'checked'}> ${typeof Utils !== 'undefined' ? Utils.escapeHtml(col.label) : col.label}`;
        item.querySelector('input').addEventListener('change', (ev) => {
          col._hidden = !ev.target.checked;
          this._applyColumnVisibility();
        });
        dropdown.appendChild(item);
      });

      wrapper.appendChild(dropdown);

      // Close on click outside
      const close = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== btn) {
          dropdown.remove();
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  }

  _applyColumnVisibility() {
    if (!this._table) return;

    // Account for optional leading select column
    const offset = this.selectable ? 1 : 0;
    const ths = this._table.querySelectorAll('thead th');
    const rows = this._table.querySelectorAll('tbody tr');

    this.columns.forEach((col, i) => {
      const display = col._hidden ? 'none' : '';
      const th = ths[i + offset];
      if (th) th.style.display = display;
      rows.forEach(row => {
        const tds = row.querySelectorAll('td');
        const td = tds[i + offset];
        if (td) td.style.display = display;
      });
    });
  }
}

window.DataTable = DataTable;
