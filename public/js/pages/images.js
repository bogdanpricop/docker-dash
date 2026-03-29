/* ═══════════════════════════════════════════════════
   pages/images.js — Images Management
   ═══════════════════════════════════════════════════ */
'use strict';

const ImagesPage = {
  _table: null,
  _refreshTimer: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-layer-group"></i> ${i18n.t('pages.images.title')}</h2>
        <div class="page-actions">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" id="image-search" placeholder="${i18n.t('pages.images.filterPlaceholder')}">
          </div>
          <button class="btn btn-sm btn-primary" id="pull-btn">
            <i class="fas fa-download"></i> ${i18n.t('pages.images.pullImage')}
          </button>
          <button class="btn btn-sm btn-secondary" id="build-btn">
            <i class="fas fa-hammer"></i> Build
          </button>
          <button class="btn btn-sm btn-secondary" id="import-btn">
            <i class="fas fa-file-import"></i> Import
          </button>
          <input type="file" id="import-file" accept=".tar,.tar.gz" style="display:none">
          <button class="prune-help-btn" id="images-help" title="${i18n.t('pages.images.helpTooltip')}">?</button>
          <button class="btn btn-sm btn-secondary" id="images-refresh">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div id="images-table"></div>
      <div id="images-footer" class="table-footer" style="display:none"></div>
    `;

    this._table = new DataTable(container.querySelector('#images-table'), {
      columns: [
        { key: '_repo', label: i18n.t('pages.images.repository'), render: (v, row) => this._renderRepo(row) },
        { key: '_tag', label: i18n.t('pages.images.tag'), render: v => `<span class="badge badge-info">${Utils.escapeHtml(v || 'none')}</span>` },
        { key: 'size', label: i18n.t('pages.images.size'), render: v => Utils.formatBytes(v) },
        { key: '_created', label: i18n.t('pages.images.created'), render: (_, row) => Utils.timeAgo(new Date(row.created * 1000).toISOString()) },
        { key: '_id', label: i18n.t('pages.images.id'), render: (_, row) => `<span class="mono text-sm">${Utils.shortImageId(row.id)}</span>` },
        { key: '_actions', label: '', sortable: false, width: '180px', render: (_, row) => `
          <div class="action-btns">
            <div class="scan-dropdown-wrap" style="position:relative;display:inline-block">
              <button class="action-btn" data-action="scan" data-id="${row.id}" title="${i18n.t('pages.images.scanImage')}"><i class="fas fa-shield-alt"></i></button>
            </div>
            <button class="action-btn" data-action="tag" data-id="${row.id}" title="Tag"><i class="fas fa-tag"></i></button>
            <button class="action-btn" data-action="export" data-id="${row.id}" title="Export"><i class="fas fa-file-export"></i></button>
            <button class="action-btn" data-action="inspect" data-id="${row.id}" title="${i18n.t('pages.images.inspect')}"><i class="fas fa-info-circle"></i></button>
            <button class="action-btn danger" data-action="remove" data-id="${row.id}" title="${i18n.t('common.remove')}"><i class="fas fa-trash"></i></button>
          </div>
        `},
      ],
      emptyText: i18n.t('pages.images.noImages'),
    });

    container.querySelector('#image-search').addEventListener('input',
      Utils.debounce(e => this._table.setFilter(e.target.value), 200));

    container.querySelector('#pull-btn').addEventListener('click', () => this._pullDialog());
    container.querySelector('#build-btn').addEventListener('click', () => this._buildDialog());
    container.querySelector('#import-btn').addEventListener('click', () => document.getElementById('import-file').click());
    container.querySelector('#import-file').addEventListener('change', (e) => this._importImage(e));
    container.querySelector('#images-help').addEventListener('click', () => this._showHelp());
    container.querySelector('#images-refresh').addEventListener('click', () => this._load());

    // Event delegation for table action buttons
    container.querySelector('#images-table').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'scan') this._showScanMenu(e, id);
      else if (btn.dataset.action === 'tag') this._tagDialog(id);
      else if (btn.dataset.action === 'export') this._exportImage(id);
      else if (btn.dataset.action === 'inspect') this._inspect(id);
      else if (btn.dataset.action === 'remove') this._remove(id);
    });

    await this._load();
  },

  async _load() {
    try {
      const images = await Api.getImages();
      images.forEach(img => {
        const tag = (img.repoTags || [])[0] || '<none>:<none>';
        const [repo, t] = tag.split(':');
        img._repo = repo;
        img._tag = t;
        img._id = img.id;
        img._created = img.created;
      });
      this._table.setData(images);

      // Update footer
      const footer = document.getElementById('images-footer');
      if (footer) {
        const totalSize = images.reduce((s, img) => s + (img.size || 0), 0);
        footer.innerHTML = `<i class="fas fa-layer-group" style="margin-right:6px"></i><strong>${images.length}</strong> images &mdash; <strong>${Utils.formatBytes(totalSize)}</strong> total`;
        footer.style.display = images.length > 0 ? '' : 'none';
      }
    } catch (err) {
      Toast.error(i18n.t('pages.images.loadFailed', { message: err.message }));
    }
  },

  _renderRepo(row) {
    const tags = row.repoTags || [];
    const repo = tags[0] ? tags[0].split(':')[0] : '<none>';
    return `<span class="mono">${Utils.escapeHtml(repo)}</span>`;
  },

  async _pullDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>${i18n.t('pages.images.pullLabel')}</label>
        <input type="text" id="pull-image-name" placeholder="${i18n.t('pages.images.pullPlaceholder')}" class="form-control">
      </div>
    `, {
      title: i18n.t('pages.images.pullTitle'),
      width: '420px',
      onSubmit: (content) => {
        const name = content.querySelector('#pull-image-name').value.trim();
        if (!name) { Toast.warning(i18n.t('pages.images.pullNameRequired')); return false; }
        return name;
      }
    });

    if (!result) return;

    // Show pull progress modal with SSE streaming
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-download" style="margin-right:8px"></i>Pulling ${Utils.escapeHtml(result)}</h3>
      </div>
      <div class="modal-body">
        <div id="pull-layers" style="max-height:50vh;overflow:auto"></div>
        <div id="pull-overall" style="margin-top:12px">
          <div class="text-sm text-muted"><i class="fas fa-spinner fa-spin"></i> Starting pull...</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="pull-close" disabled>Close</button>
      </div>
    `, { width: '600px', closeable: false });

    const layersEl = document.getElementById('pull-layers');
    const overallEl = document.getElementById('pull-overall');
    const closeBtn = document.getElementById('pull-close');
    const layers = {};
    let completedLayers = 0;
    let totalLayers = 0;

    const updateLayerUI = () => {
      const ids = Object.keys(layers);
      layersEl.innerHTML = ids.map(id => {
        const l = layers[id];
        const pct = (l.total > 0) ? Math.round((l.current / l.total) * 100) : 0;
        const done = l.status === 'Pull complete' || l.status === 'Already exists' || l.status === 'Download complete';
        const barColor = done ? 'var(--green)' : 'var(--accent)';
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">
          <span class="mono" style="width:80px;flex-shrink:0;color:var(--text-muted)">${Utils.escapeHtml(id.substring(0, 12))}</span>
          <div style="flex:1;height:6px;background:var(--surface3);border-radius:3px;overflow:hidden">
            <div style="width:${done ? 100 : pct}%;height:100%;background:${barColor};border-radius:3px;transition:width 0.2s"></div>
          </div>
          <span style="width:140px;text-align:right;flex-shrink:0;color:${done ? 'var(--green)' : 'var(--text-muted)'}">${Utils.escapeHtml(l.status)}</span>
        </div>`;
      }).join('');
      layersEl.scrollTop = layersEl.scrollHeight;

      completedLayers = ids.filter(id => {
        const s = layers[id].status;
        return s === 'Pull complete' || s === 'Already exists';
      }).length;
      totalLayers = ids.length;
      if (totalLayers > 0) {
        overallEl.innerHTML = `<div class="text-sm text-muted"><i class="fas fa-layer-group" style="margin-right:4px"></i> ${completedLayers}/${totalLayers} layers complete</div>`;
      }
    };

    try {
      const hostParam = Api.getHostId() ? `?hostId=${Api.getHostId()}` : '';
      const response = await fetch(`/api/images/pull-stream${hostParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(Api._bearerToken ? { 'Authorization': `Bearer ${Api._bearerToken}` } : {}) },
        credentials: 'same-origin',
        body: JSON.stringify({ image: result }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress' && data.id) {
              if (!layers[data.id]) layers[data.id] = { status: '', current: 0, total: 0 };
              layers[data.id].status = data.status;
              if (data.total) {
                layers[data.id].current = data.current;
                layers[data.id].total = data.total;
              }
              if (data.status === 'Pull complete' || data.status === 'Already exists') {
                layers[data.id].current = layers[data.id].total || 1;
              }
              updateLayerUI();
            } else if (data.type === 'done') {
              overallEl.innerHTML = `<div class="text-sm" style="color:var(--green)"><i class="fas fa-check-circle" style="margin-right:4px"></i> Pull complete!</div>`;
              Toast.success(i18n.t('pages.images.pullSuccess', { image: result }));
              this._load();
            } else if (data.type === 'error') {
              overallEl.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-times-circle" style="margin-right:4px"></i> ${Utils.escapeHtml(data.message)}</div>`;
              Toast.error(i18n.t('pages.images.pullFailed', { message: data.message }));
            }
          } catch {}
        }
      }
    } catch (err) {
      overallEl.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-times-circle"></i> ${Utils.escapeHtml(err.message)}</div>`;
      Toast.error(i18n.t('pages.images.pullFailed', { message: err.message }));
    }

    closeBtn.disabled = false;
    closeBtn.addEventListener('click', () => Modal.close());
  },

  async _inspect(id) {
    try {
      const data = await Api.getImage(id);
      const json = JSON.stringify(data, null, 2);
      Modal.open(`
        <div class="modal-header">
          <h3>${i18n.t('pages.images.inspectTitle')}</h3>
          <button class="modal-close-btn" id="img-inspect-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <pre class="inspect-json" style="max-height:60vh;overflow:auto">${Utils.escapeHtml(json)}</pre>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="inspect-copy-btn">
            <i class="fas fa-copy"></i> ${i18n.t('common.copy')}
          </button>
          <button class="btn btn-primary" id="img-inspect-close-btn">${i18n.t('common.close')}</button>
        </div>
      `, { width: '700px' });
      Modal._content.querySelector('#img-inspect-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#img-inspect-close-btn').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#inspect-copy-btn')?.addEventListener('click', () => {
        Utils.copyToClipboard(json).then(() => Toast.success(i18n.t('common.copied')));
      });
    } catch (err) {
      Toast.error(i18n.t('pages.images.inspectFailed', { message: err.message }));
    }
  },

  async _remove(id) {
    const ok = await Modal.confirm(i18n.t('pages.images.removeConfirm'), { danger: true, confirmText: i18n.t('common.remove') });
    if (!ok) return;
    try {
      await Api.removeImage(id, true);
      Toast.success(i18n.t('pages.images.removed'));
      await this._load();
    } catch (err) {
      Toast.error(i18n.t('pages.images.removeFailed', { message: err.message }));
    }
  },

  _showScanMenu(event, id) {
    event.stopPropagation();
    // Remove any existing scan menu
    document.querySelectorAll('.scan-context-menu').forEach(el => el.remove());

    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'scan-context-menu';
    menu.innerHTML = `
      <div class="scan-menu-item" data-scanner="auto">
        <i class="fas fa-magic"></i> ${i18n.t('pages.images.scanAuto')}
      </div>
      <div class="scan-menu-item" data-scanner="trivy">
        <i class="fas fa-search"></i> Trivy
      </div>
      <div class="scan-menu-item" data-scanner="docker-scout">
        <i class="fab fa-docker"></i> Docker Scout
      </div>
    `;
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = (rect.left - 100) + 'px';
    menu.style.zIndex = '9999';

    menu.querySelectorAll('.scan-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        menu.remove();
        this._scan(id, item.dataset.scanner);
      });
    });

    document.body.appendChild(menu);

    // Close on outside click
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 10);
  },

  async _scan(id, scanner = 'auto') {
    Toast.info(i18n.t('pages.images.scanning'));
    try {
      const data = await Api.scanImage(id, scanner);
      const s = data.summary || {};
      const vulns = data.vulnerabilities || [];

      if (data.message) {
        // No scanner available
        Modal.open(`
          <div class="modal-header">
            <h3><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.images.scanTitle')}</h3>
            <button class="modal-close-btn" id="scan-noscan-close-x"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body">
            <div class="empty-msg"><i class="fas fa-info-circle"></i> ${Utils.escapeHtml(data.message)}</div>
          </div>
          <div class="modal-footer"><button class="btn btn-primary" id="scan-noscan-close-btn">${i18n.t('common.close')}</button></div>
        `, { width: '500px' });
        Modal._content.querySelector('#scan-noscan-close-x').addEventListener('click', () => Modal.close());
        Modal._content.querySelector('#scan-noscan-close-btn').addEventListener('click', () => Modal.close());
        return;
      }

      const sevColor = sev => ({ critical: 'var(--red)', high: '#f97316', medium: 'var(--yellow)', low: 'var(--text-dim)' }[sev] || 'var(--text)');

      const vulnRows = vulns.slice(0, 100).map(v => {
        const hasDetails = v.description || v.url || v.title;
        const detailsHtml = hasDetails ? `
          <tr class="vuln-details" style="display:none">
            <td colspan="6" style="text-align:left;padding:8px 16px;background:var(--surface2)">
              ${v.title ? `<div class="text-sm" style="margin-bottom:4px"><strong>${Utils.escapeHtml(v.title)}</strong></div>` : ''}
              ${v.description ? `<div class="text-sm text-muted" style="margin-bottom:4px">${Utils.escapeHtml(v.description.substring(0, 300))}${v.description.length > 300 ? '...' : ''}</div>` : ''}
              ${v.cvss ? `<div class="text-sm" style="margin-bottom:4px"><span class="badge" style="background:${v.cvss >= 9 ? 'var(--red)' : v.cvss >= 7 ? '#f97316' : 'var(--yellow)'};color:#fff">CVSS ${v.cvss}</span></div>` : ''}
              ${v.fixedIn ? `<div class="text-sm" style="margin-bottom:4px"><i class="fas fa-wrench" style="color:var(--green);margin-right:4px"></i>Fix: upgrade <strong>${Utils.escapeHtml(v.package)}</strong> from ${Utils.escapeHtml(v.version)} to <strong>${Utils.escapeHtml(v.fixedIn)}</strong></div>` : '<div class="text-sm text-muted"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>No fix available yet</div>'}
              ${v.url ? `<div class="text-sm"><a href="${Utils.escapeHtml(v.url)}" target="_blank" rel="noopener" style="color:var(--accent)"><i class="fas fa-external-link-alt" style="margin-right:4px"></i>${Utils.escapeHtml(v.id)} details</a></div>` : ''}
            </td>
          </tr>` : '';

        return `
          <tr class="vuln-row" style="cursor:pointer" title="Click for details">
            <td class="mono text-sm" style="color:${sevColor(v.severity)};font-weight:600">${v.severity.toUpperCase()}</td>
            <td class="mono text-sm">${Utils.escapeHtml(v.id)}</td>
            <td class="text-sm">${Utils.escapeHtml(v.package)}</td>
            <td class="text-sm">${Utils.escapeHtml(v.version)}</td>
            <td class="text-sm">${v.fixedIn ? `<span style="color:var(--green)">${Utils.escapeHtml(v.fixedIn)}</span>` : '<span class="text-muted">—</span>'}</td>
            <td class="text-sm">${v.cvss ? `<span style="color:${v.cvss >= 9 ? 'var(--red)' : v.cvss >= 7 ? '#f97316' : 'var(--yellow)'}">${v.cvss}</span>` : ''}</td>
          </tr>
          ${detailsHtml}`;
      }).join('');

      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.images.scanTitle')} — ${Utils.escapeHtml(data.image)}</h3>
          <button class="modal-close-btn" id="scan-results-close-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:12px;margin-bottom:16px">
            <div style="flex:1;text-align:center;padding:12px;background:var(--red-dim);border-radius:var(--radius-sm)">
              <div style="font-size:24px;font-weight:700;color:var(--red)">${s.critical || 0}</div>
              <div class="text-sm">Critical</div>
            </div>
            <div style="flex:1;text-align:center;padding:12px;background:rgba(249,115,22,0.1);border-radius:var(--radius-sm)">
              <div style="font-size:24px;font-weight:700;color:#f97316">${s.high || 0}</div>
              <div class="text-sm">High</div>
            </div>
            <div style="flex:1;text-align:center;padding:12px;background:var(--yellow-dim);border-radius:var(--radius-sm)">
              <div style="font-size:24px;font-weight:700;color:var(--yellow)">${s.medium || 0}</div>
              <div class="text-sm">Medium</div>
            </div>
            <div style="flex:1;text-align:center;padding:12px;background:var(--surface3);border-radius:var(--radius-sm)">
              <div style="font-size:24px;font-weight:700">${s.low || 0}</div>
              <div class="text-sm">Low</div>
            </div>
          </div>
          <div class="text-sm text-muted" style="margin-bottom:8px">${i18n.t('pages.images.scannerUsed')}: ${Utils.escapeHtml(data.scanner)} | ${i18n.t('pages.images.totalVulns')}: ${s.total || 0}</div>
          ${data.recommendations?.length > 0 ? `
          <div style="margin-bottom:16px">
            <h4 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--text-muted)"><i class="fas fa-lightbulb" style="margin-right:6px;color:var(--yellow)"></i>Recommendations</h4>
            ${data.recommendations.filter(r => r.type !== 'summary').map(r => {
              const icon = r.priority === 'critical' ? 'fa-exclamation-circle' : r.priority === 'high' ? 'fa-arrow-up' : r.priority === 'medium' ? 'fa-tools' : 'fa-info-circle';
              const color = r.priority === 'critical' ? 'var(--red)' : r.priority === 'high' ? '#f97316' : r.priority === 'medium' ? 'var(--yellow)' : 'var(--text-muted)';
              return `<div style="padding:8px 12px;margin-bottom:6px;border-left:3px solid ${color};background:var(--surface2);border-radius:0 var(--radius-sm) var(--radius-sm) 0">
                <div style="font-weight:600;font-size:13px"><i class="fas ${icon}" style="color:${color};margin-right:6px"></i>${Utils.escapeHtml(r.title)}</div>
                <div class="text-sm text-muted" style="margin-top:2px">${Utils.escapeHtml(r.description)}</div>
                ${r.command ? `<div style="position:relative;margin-top:6px"><code style="display:block;padding:6px 10px;padding-right:36px;background:var(--surface);border-radius:4px;font-size:11px;color:var(--accent);white-space:pre-wrap">${Utils.escapeHtml(r.command)}</code><button class="btn-icon" style="position:absolute;top:4px;right:4px;padding:2px 6px;font-size:10px;color:var(--text-muted)" title="Copy" data-copy-prev="1"><i class="fas fa-copy"></i></button></div>` : ''}
              </div>`;
            }).join('')}
          </div>` : ''}
          ${vulns.length > 0 ? `
          <div style="max-height:350px;overflow-y:auto">
            <table class="data-table compact" id="vuln-table">
              <thead><tr><th>${i18n.t('pages.images.severity')}</th><th>CVE</th><th>${i18n.t('pages.images.package')}</th><th>${i18n.t('pages.images.version')}</th><th>${i18n.t('pages.images.fixedIn')}</th><th>CVSS</th></tr></thead>
              <tbody>${vulnRows}</tbody>
            </table>
          </div>` : `<div class="empty-msg" style="color:var(--green)"><i class="fas fa-check-circle"></i> ${i18n.t('pages.images.noVulns')}</div>`}
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="scan-results-close-btn">${i18n.t('common.close')}</button></div>
      `, { width: '850px' });

      Modal._content.querySelector('#scan-results-close-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#scan-results-close-btn').addEventListener('click', () => Modal.close());

      // Click-to-expand vulnerability details
      const vulnTable = Modal._content.querySelector('#vuln-table');
      if (vulnTable) {
        vulnTable.querySelectorAll('.vuln-row').forEach(row => {
          row.addEventListener('click', () => {
            const details = row.nextElementSibling;
            if (details?.classList.contains('vuln-details')) {
              details.style.display = details.style.display === 'none' ? '' : 'none';
              row.style.background = details.style.display === 'none' ? '' : 'var(--surface2)';
            }
          });
        });
      }

      // Wire copy buttons in modal (recommendation commands)
      Modal._content.querySelectorAll('[data-copy-prev]').forEach(btn => {
        btn.addEventListener('click', () => {
          const text = btn.previousElementSibling?.textContent;
          if (text) Utils.copyToClipboard(text).then(() => Toast.success('Copied!'));
        });
      });
    } catch (err) {
      Toast.error(i18n.t('pages.images.scanFailed', { message: err.message }));
    }
  },

  async _tagDialog(id) {
    const result = await Modal.form(`
      <div class="form-group">
        <label>Repository</label>
        <input type="text" id="tag-repo" class="form-control" placeholder="myregistry.com/myimage">
      </div>
      <div class="form-group">
        <label>Tag</label>
        <input type="text" id="tag-tag" class="form-control" placeholder="latest" value="latest">
      </div>
    `, {
      title: 'Tag Image',
      width: '420px',
      onSubmit: (content) => ({
        repo: content.querySelector('#tag-repo').value.trim(),
        tag: content.querySelector('#tag-tag').value.trim() || 'latest',
      }),
    });

    if (result && result.repo) {
      try {
        await Api.post(`/images/${encodeURIComponent(id)}/tag`, result);
        Toast.success(`Tagged as ${result.repo}:${result.tag}`);
        await this._load();
      } catch (err) { Toast.error(err.message); }
    }
  },

  _exportImage(id) {
    window.open(`/api/images/${encodeURIComponent(id)}/export`, '_blank');
  },

  async _importImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    Toast.info(`Importing ${file.name}...`);
    try {
      const response = await fetch('/api/images/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-tar' },
        credentials: 'same-origin',
        body: file,
      });
      const result = await response.json();
      if (result.ok) {
        Toast.success('Image imported successfully');
        await this._load();
      } else {
        Toast.error(result.error || 'Import failed');
      }
    } catch (err) {
      Toast.error('Import failed: ' + err.message);
    }
  },

  async _buildDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>Image Tag</label>
        <input type="text" id="build-tag" class="form-control" placeholder="myapp:latest">
      </div>
      <div class="form-group">
        <label>Dockerfile</label>
        <textarea id="build-dockerfile" class="form-control" rows="12" style="font-family:monospace;font-size:12px" placeholder="FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD [&quot;node&quot;, &quot;server.js&quot;]"></textarea>
      </div>
    `, {
      title: 'Build Image',
      width: '600px',
      onSubmit: (content) => ({
        tag: content.querySelector('#build-tag').value.trim(),
        dockerfile: content.querySelector('#build-dockerfile').value,
      }),
    });

    if (!result || !result.tag || !result.dockerfile) return;

    // Show build output modal
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-hammer" style="margin-right:8px"></i>Building ${Utils.escapeHtml(result.tag)}</h3>
      </div>
      <div class="modal-body">
        <pre id="build-output" style="max-height:50vh;overflow:auto;background:var(--surface2);padding:12px;border-radius:var(--radius-sm);font-size:12px"></pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="build-close" disabled>Close</button>
      </div>
    `, { width: '700px', closeable: false });

    const outputEl = document.getElementById('build-output');
    const closeBtn = document.getElementById('build-close');

    try {
      const response = await fetch('/api/images/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(result),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'output' || data.type === 'status') {
              outputEl.textContent += data.text;
            } else if (data.type === 'error') {
              outputEl.textContent += '\nERROR: ' + data.text + '\n';
            } else if (data.type === 'done') {
              outputEl.textContent += '\nBuild complete!\n';
              Toast.success('Image built successfully');
              this._load();
            }
            outputEl.scrollTop = outputEl.scrollHeight;
          } catch {}
        }
      }
    } catch (err) {
      outputEl.textContent += '\nBuild failed: ' + err.message;
      Toast.error('Build failed: ' + err.message);
    }

    closeBtn.disabled = false;
    closeBtn.addEventListener('click', () => Modal.close());
  },

  _showHelp() {
    const html = `
      <div class="modal-header">
        <h3><i class="fas fa-info-circle" style="color:var(--accent);margin-right:8px"></i> ${i18n.t('pages.images.help.title')}</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body prune-help-content">
        <p>${i18n.t('pages.images.help.intro')}</p>

        <h4><i class="fas fa-tag"></i> ${i18n.t('pages.images.help.repoTagTitle')}</h4>
        <p>${i18n.t('pages.images.help.repoTagBody')}</p>

        <h4><i class="fas fa-download"></i> ${i18n.t('pages.images.help.pullTitle')}</h4>
        <p>${i18n.t('pages.images.help.pullBody')}</p>

        <h4><i class="fas fa-hdd"></i> ${i18n.t('pages.images.help.sizeTitle')}</h4>
        <p>${i18n.t('pages.images.help.sizeBody')}</p>

        <h4><i class="fas fa-layer-group"></i> ${i18n.t('pages.images.help.layersTitle')}</h4>
        <p>${i18n.t('pages.images.help.layersBody')}</p>

        <h4><i class="fas fa-ghost"></i> ${i18n.t('pages.images.help.danglingTitle')}</h4>
        <p>${i18n.t('pages.images.help.danglingBody')}</p>

        <div class="danger-text" style="margin-top:12px">
          <i class="fas fa-exclamation-circle"></i> ${i18n.t('pages.images.help.warningText')}
        </div>

        <div class="tip-box">
          <i class="fas fa-lightbulb"></i>
          ${i18n.t('pages.images.help.tipText')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="modal-ok">${i18n.t('common.understood')}</button>
      </div>
    `;
    Modal.open(html, { width: '620px' });
    Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
  },

  destroy() {
    clearInterval(this._refreshTimer);
  },
};

window.ImagesPage = ImagesPage;
