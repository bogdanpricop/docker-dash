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
          <button class="btn btn-sm btn-secondary" id="registry-browse-btn">
            <i class="fas fa-warehouse"></i> Registries
          </button>
          <input type="file" id="import-file" accept=".tar,.tar.gz" style="display:none">
          <button class="prune-help-btn" id="images-help" title="${i18n.t('pages.images.helpTooltip')}">?</button>
          <button class="prune-help-btn" id="images-guide" title="Actions guide" style="background:var(--accent);color:#fff;border-color:var(--accent)">i</button>
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
    container.querySelector('#images-guide').addEventListener('click', () => this._showActionsGuide());
    container.querySelector('#images-refresh').addEventListener('click', () => this._load());
    container.querySelector('#registry-browse-btn').addEventListener('click', () => this._registryBrowser());

    // Event delegation for table action buttons
    container.querySelector('#images-table').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'scan') this._showScanMenu(e, id, btn);
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
    const REGISTRIES = [
      { label: 'Docker Hub',                  prefix: '',                        example: 'nginx:latest' },
      { label: 'GitHub Container Registry',   prefix: 'ghcr.io/',                example: 'ghcr.io/home-assistant/home-assistant:stable' },
      { label: 'Microsoft (MCR)',             prefix: 'mcr.microsoft.com/',      example: 'mcr.microsoft.com/dotnet/aspnet:8.0' },
      { label: 'Quay.io (Red Hat)',           prefix: 'quay.io/',                example: 'quay.io/prometheus/prometheus:latest' },
      { label: 'Amazon ECR Public',           prefix: 'public.ecr.aws/',         example: 'public.ecr.aws/nginx/nginx:latest' },
      { label: 'Google GCR',                  prefix: 'gcr.io/',                 example: 'gcr.io/google-containers/pause:latest' },
      { label: 'Custom / Private registry',   prefix: '',                        example: 'registry.mycompany.com/myapp:v1.0' },
    ];

    const result = await Modal.form(`
      <div class="form-group">
        <label>Registry</label>
        <select id="pull-registry" class="form-control" style="margin-bottom:8px">
          ${REGISTRIES.map((r, i) => `<option value="${i}">${Utils.escapeHtml(r.label)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>${i18n.t('pages.images.pullLabel')}</label>
        <div style="display:flex;align-items:center;gap:0">
          <span id="pull-prefix" style="padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-right:none;border-radius:var(--radius-sm) 0 0 var(--radius-sm);font-size:12px;font-family:var(--mono);color:var(--text-dim);white-space:nowrap"></span>
          <input type="text" id="pull-image-name" placeholder="nginx:latest" class="form-control" style="border-radius:0 var(--radius-sm) var(--radius-sm) 0;flex:1">
        </div>
        <small id="pull-hint" class="text-muted" style="margin-top:4px;display:block"></small>
      </div>
    `, {
      title: i18n.t('pages.images.pullTitle'),
      width: '480px',
      onMount: (content) => {
        const sel = content.querySelector('#pull-registry');
        const prefixEl = content.querySelector('#pull-prefix');
        const input = content.querySelector('#pull-image-name');
        const hint = content.querySelector('#pull-hint');

        const update = () => {
          const r = REGISTRIES[parseInt(sel.value)];
          prefixEl.style.display = r.prefix ? '' : 'none';
          prefixEl.textContent = r.prefix;
          input.placeholder = r.prefix ? r.example.replace(r.prefix, '') : r.example;
          hint.textContent = `e.g. ${r.example}`;
        };
        update();
        sel.addEventListener('change', update);
      },
      onSubmit: (content) => {
        const sel = content.querySelector('#pull-registry');
        const r = REGISTRIES[parseInt(sel.value)];
        const name = (r.prefix + content.querySelector('#pull-image-name').value.trim()).trim();
        if (!name || name === r.prefix) { Toast.warning(i18n.t('pages.images.pullNameRequired')); return false; }
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

  _showScanMenu(event, id, triggerBtn) {
    event.stopPropagation();
    // Remove any existing scan menu
    document.querySelectorAll('.scan-context-menu').forEach(el => el.remove());

    const btn = triggerBtn || event.currentTarget;
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
      <div class="scan-menu-item" data-scanner="grype">
        <i class="fas fa-shield-alt"></i> Grype
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
    // ── Dockerfile templates ──────────────────────────────────────
    const TEMPLATES = [
      { name: 'Node.js',     icon: 'fab fa-node-js',  color: '#3fb950',
        dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]' },
      { name: 'Python',      icon: 'fab fa-python',   color: '#4584b6',
        dockerfile: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 8000\nCMD ["python", "app.py"]' },
      { name: 'Nginx',       icon: 'fas fa-server',   color: '#d29922',
        dockerfile: 'FROM nginx:alpine\nCOPY nginx.conf /etc/nginx/nginx.conf\nCOPY ./dist /usr/share/nginx/html\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]' },
      { name: 'Go',          icon: 'fas fa-code',     color: '#79c0ff',
        dockerfile: 'FROM golang:1.22-alpine AS builder\nWORKDIR /app\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o main .\n\nFROM alpine:latest\nWORKDIR /app\nCOPY --from=builder /app/main .\nEXPOSE 8080\nCMD ["./main"]' },
      { name: 'Java',        icon: 'fab fa-java',     color: '#f97316',
        dockerfile: 'FROM eclipse-temurin:21-jdk-alpine AS builder\nWORKDIR /app\nCOPY . .\nRUN ./mvnw package -DskipTests\n\nFROM eclipse-temurin:21-jre-alpine\nWORKDIR /app\nCOPY --from=builder /app/target/*.jar app.jar\nEXPOSE 8080\nCMD ["java", "-jar", "app.jar"]' },
      { name: 'Alpine',      icon: 'fas fa-mountain', color: '#8b949e',
        dockerfile: 'FROM alpine:3.19\nRUN apk add --no-cache bash curl\nWORKDIR /app\nCOPY . .\nCMD ["/bin/bash"]' },
      { name: 'PostgreSQL',  icon: 'fas fa-database', color: '#336791',
        dockerfile: 'FROM postgres:16-alpine\nENV POSTGRES_DB=mydb\nENV POSTGRES_USER=user\nENV POSTGRES_PASSWORD=password\nCOPY init.sql /docker-entrypoint-initdb.d/\nEXPOSE 5432' },
      { name: 'Blank',       icon: 'fas fa-file-alt', color: '#8b949e',
        dockerfile: '' },
    ];

    // ── Live validation ───────────────────────────────────────────
    const validateDockerfile = (text) => {
      const warnings = [];
      if (!text.trim()) return warnings;
      const lines = text.split('\n').map(l => l.trim());
      const hasNonRootUser = lines.some(l => /^USER\s+(?!root\b)/i.test(l));
      const runCount = lines.filter(l => /^RUN\s+/i.test(l)).length;
      const hasCopyAll = lines.some(l => /^COPY\s+\.\s+/i.test(l));
      const hasAptGet = lines.some(l => /apt-get install/i.test(l));
      const hasAptNoRec = lines.some(l => /--no-install-recommends/i.test(l));
      const hasAptClean = lines.some(l => /apt-get clean|rm -rf \/var\/lib\/apt/i.test(l));
      if (!hasNonRootUser)
        warnings.push({ icon: 'fa-user-shield', color: 'var(--yellow)', msg: 'No non-root USER instruction — container will run as root' });
      if (runCount > 4)
        warnings.push({ icon: 'fa-layer-group', color: '#d29922', msg: `${runCount} RUN instructions — consider combining with && to reduce image layers` });
      if (hasCopyAll)
        warnings.push({ icon: 'fa-copy', color: '#58a6ff', msg: 'COPY . . detected — add a .dockerignore to exclude node_modules, .git, etc.' });
      if (hasAptGet && !hasAptNoRec)
        warnings.push({ icon: 'fa-box', color: 'var(--yellow)', msg: 'apt-get install without --no-install-recommends increases image size' });
      if (hasAptGet && !hasAptClean)
        warnings.push({ icon: 'fa-trash', color: 'var(--yellow)', msg: 'apt-get without cleanup — add && rm -rf /var/lib/apt/lists/*' });
      return warnings;
    };

    const detectStages = (text) => {
      const stages = [];
      for (const line of text.split('\n')) {
        const m = line.trim().match(/^FROM\s+\S+\s+AS\s+(\S+)/i);
        if (m) stages.push(m[1]);
      }
      return stages;
    };

    // ── Build form modal ──────────────────────────────────────────
    const templateCards = TEMPLATES.map((t, i) => `
      <button class="build-tpl-btn" data-tpl="${i}" title="${t.name}" style="
        background:var(--surface3);border:1px solid var(--border);border-radius:var(--radius-sm);
        padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;align-items:center;
        gap:4px;font-size:11px;color:var(--text-muted);min-width:68px;transition:border-color .15s">
        <i class="${t.icon}" style="font-size:17px;color:${t.color}"></i>
        <span>${t.name}</span>
      </button>`).join('');

    const buildParams = await new Promise((resolve) => {
      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-hammer" style="margin-right:8px;color:var(--accent)"></i>Build Image</h3>
          <button class="modal-close-btn" id="bd-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">

          <div class="form-group" style="margin:0">
            <label style="display:block;margin-bottom:6px;font-weight:600">
              Image Tag <span style="color:var(--red)">*</span>
            </label>
            <input type="text" id="bd-tag" class="form-control" placeholder="myapp:latest" style="font-family:monospace">
            <div id="bd-tag-hint" class="text-sm text-muted" style="margin-top:4px;min-height:18px"></div>
          </div>

          <div>
            <label style="display:block;margin-bottom:8px;font-weight:600;font-size:13px">Quick Templates</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px" id="bd-templates">${templateCards}</div>
          </div>

          <div class="form-group" style="margin:0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <label style="font-weight:600;margin:0">Dockerfile <span style="color:var(--red)">*</span></label>
              <button class="btn btn-sm btn-secondary" id="bd-upload-btn" style="font-size:11px;padding:3px 10px">
                <i class="fas fa-upload" style="margin-right:4px"></i>Upload file
              </button>
              <input type="file" id="bd-upload-input" accept=".dockerfile,*" style="display:none">
            </div>
            <textarea id="bd-dockerfile" class="form-control" rows="11"
              style="font-family:'Courier New',monospace;font-size:12px;line-height:1.6;tab-size:2;resize:vertical"
              spellcheck="false"
              placeholder="FROM alpine:latest&#10;WORKDIR /app&#10;COPY . .&#10;CMD [&quot;sh&quot;]"></textarea>
          </div>

          <div id="bd-warnings" style="display:none"></div>

          <div>
            <button class="btn btn-sm btn-secondary" id="bd-adv-toggle"
              style="font-size:12px;padding:4px 12px">
              <i class="fas fa-chevron-right" id="bd-adv-icon"
                style="transition:transform .2s;margin-right:6px;font-size:10px"></i>Advanced Options
            </button>
            <div id="bd-advanced" style="display:none">
              <div style="margin-top:10px;padding:14px;background:var(--surface2);border-radius:var(--radius-sm);
                          display:flex;flex-direction:column;gap:14px">

                <div>
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                    <label style="font-size:13px;font-weight:600;margin:0">Build Arguments</label>
                    <button class="btn btn-sm btn-secondary" id="bd-arg-add"
                      style="padding:2px 10px;font-size:11px"><i class="fas fa-plus"></i> Add</button>
                  </div>
                  <div id="bd-args-list" style="display:flex;flex-direction:column;gap:6px"></div>
                  <div class="text-sm text-muted" style="margin-top:4px">
                    Reference in Dockerfile as <code>ARG KEY</code> then <code>$KEY</code>
                  </div>
                </div>

                <div id="bd-target-section" style="display:none">
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">
                    Target Stage <span class="text-muted" style="font-weight:400">(multi-stage)</span>
                  </label>
                  <select id="bd-target" class="form-control" style="font-family:monospace"></select>
                </div>

                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:0">
                  <input type="checkbox" id="bd-nocache" style="width:15px;height:15px">
                  <span><strong>No cache</strong> — force rebuild all layers from scratch</span>
                </label>

              </div>
            </div>
          </div>

        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="bd-cancel">Cancel</button>
          <button class="btn btn-primary" id="bd-submit">
            <i class="fas fa-hammer" style="margin-right:6px"></i>Build
          </button>
        </div>
      `, { width: '680px', closeable: false });

      const mc = Modal._content;
      const tagEl       = mc.querySelector('#bd-tag');
      const dfEl        = mc.querySelector('#bd-dockerfile');
      const warningsEl  = mc.querySelector('#bd-warnings');
      const advEl       = mc.querySelector('#bd-advanced');
      const advIcon     = mc.querySelector('#bd-adv-icon');
      const targetSect  = mc.querySelector('#bd-target-section');
      const targetSel   = mc.querySelector('#bd-target');
      const argsListEl  = mc.querySelector('#bd-args-list');

      const closeResolve = (val) => { Modal.close(); resolve(val); };

      mc.querySelector('#bd-x').addEventListener('click', () => closeResolve(null));
      mc.querySelector('#bd-cancel').addEventListener('click', () => closeResolve(null));

      // Template picker
      mc.querySelector('#bd-templates').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tpl]');
        if (!btn) return;
        const tpl = TEMPLATES[parseInt(btn.dataset.tpl)];
        dfEl.value = tpl.dockerfile;
        dfEl.dispatchEvent(new Event('input'));
        mc.querySelectorAll('.build-tpl-btn').forEach(b => b.style.borderColor = '');
        btn.style.borderColor = 'var(--accent)';
      });

      // Upload Dockerfile
      mc.querySelector('#bd-upload-btn').addEventListener('click', () =>
        mc.querySelector('#bd-upload-input').click());
      mc.querySelector('#bd-upload-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => { dfEl.value = ev.target.result; dfEl.dispatchEvent(new Event('input')); };
        reader.readAsText(file);
        e.target.value = '';
      });

      // Tag hint
      tagEl.addEventListener('input', () => {
        const v = tagEl.value.trim();
        const hint = mc.querySelector('#bd-tag-hint');
        hint.textContent = (v && !v.includes(':')) ? 'Tip: add a tag, e.g. myapp:1.0.0 or myapp:latest' : '';
      });

      // Live validation
      dfEl.addEventListener('input', () => {
        const text = dfEl.value;
        const warns = validateDockerfile(text);
        if (warns.length === 0) {
          warningsEl.style.display = 'none';
        } else {
          warningsEl.style.display = '';
          warningsEl.innerHTML = warns.map(w => `
            <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 10px;
              border-left:3px solid ${w.color};background:rgba(210,153,34,0.07);
              border-radius:0 var(--radius-sm) var(--radius-sm) 0;
              margin-bottom:3px;font-size:12px">
              <i class="fas ${w.icon}" style="color:${w.color};margin-top:2px;flex-shrink:0"></i>
              <span>${w.msg}</span>
            </div>`).join('');
        }
        // Multi-stage target dropdown
        const stages = detectStages(text);
        if (stages.length > 0) {
          targetSect.style.display = '';
          targetSel.innerHTML = '<option value="">— Final stage (default) —</option>' +
            stages.map(s => `<option value="${Utils.escapeHtml(s)}">${Utils.escapeHtml(s)}</option>`).join('');
        } else {
          targetSect.style.display = 'none';
        }
      });

      // Advanced toggle
      mc.querySelector('#bd-adv-toggle').addEventListener('click', () => {
        const open = advEl.style.display !== 'none';
        advEl.style.display = open ? 'none' : '';
        advIcon.style.transform = open ? '' : 'rotate(90deg)';
      });

      // Build args — add row
      mc.querySelector('#bd-arg-add').addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'bd-arg-row';
        row.style.cssText = 'display:flex;gap:6px;align-items:center';
        row.innerHTML = `
          <input type="text" class="form-control arg-key" placeholder="KEY"
            style="flex:1;font-family:monospace;font-size:12px">
          <span style="color:var(--text-muted);flex-shrink:0">=</span>
          <input type="text" class="form-control arg-val" placeholder="value"
            style="flex:2;font-family:monospace;font-size:12px">
          <button class="btn btn-sm btn-secondary" style="padding:3px 8px;flex-shrink:0">
            <i class="fas fa-times"></i>
          </button>`;
        row.querySelector('button').addEventListener('click', () => row.remove());
        argsListEl.appendChild(row);
        row.querySelector('.arg-key').focus();
      });

      // Submit
      mc.querySelector('#bd-submit').addEventListener('click', () => {
        const tag = tagEl.value.trim();
        const dockerfile = dfEl.value.trim();
        if (!tag) {
          tagEl.style.borderColor = 'var(--red)';
          tagEl.focus();
          return;
        }
        if (!dockerfile) {
          dfEl.style.borderColor = 'var(--red)';
          dfEl.focus();
          return;
        }
        const buildArgs = {};
        argsListEl.querySelectorAll('.bd-arg-row').forEach(row => {
          const k = row.querySelector('.arg-key').value.trim();
          const v = row.querySelector('.arg-val').value;
          if (k) buildArgs[k] = v;
        });
        closeResolve({
          tag,
          dockerfile,
          buildArgs,
          target: targetSel.value || '',
          noCache: mc.querySelector('#bd-nocache').checked,
        });
      });
    });

    if (!buildParams) return;

    // ── Streaming output modal ────────────────────────────────────
    const colorizeText = (text) => text.split('\n').map(line => {
      const e = Utils.escapeHtml(line);
      if (/^Step \d+\/\d+/i.test(line))               return `<span style="color:var(--accent);font-weight:700">${e}</span>`;
      if (/Successfully (built|tagged)/i.test(line))   return `<span style="color:var(--green);font-weight:600">${e}</span>`;
      if (/\berror\b/i.test(line))                     return `<span style="color:var(--red)">${e}</span>`;
      if (/\bwarn/i.test(line))                        return `<span style="color:var(--yellow)">${e}</span>`;
      if (/^--->/.test(line))                          return `<span style="color:var(--text-muted)">${e}</span>`;
      if (/^Removing intermediate container/.test(line)) return `<span style="opacity:0.45">${e}</span>`;
      return e;
    }).join('\n');

    const tagBadges = [
      buildParams.noCache ? '<span class="badge badge-warning" style="margin-left:8px">no-cache</span>' : '',
      buildParams.target  ? `<span class="badge badge-info" style="margin-left:4px">→ ${Utils.escapeHtml(buildParams.target)}</span>` : '',
    ].join('');

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-hammer" style="margin-right:8px;color:var(--accent)"></i>
          Building <code style="font-size:14px">${Utils.escapeHtml(buildParams.tag)}</code>${tagBadges}
        </h3>
      </div>
      <div class="modal-body">
        <div id="bd-out-status" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px">
          <i class="fas fa-spinner fa-spin" style="color:var(--accent)"></i>
          <span>Building…</span>
        </div>
        <pre id="bd-output" style="max-height:55vh;overflow:auto;background:var(--surface2);padding:12px;
          border-radius:var(--radius-sm);font-size:11.5px;line-height:1.6;margin:0;white-space:pre-wrap"></pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="bd-copy-log"><i class="fas fa-copy"></i> Copy Log</button>
        <button class="btn btn-primary" id="bd-out-close" disabled>Close</button>
      </div>
    `, { width: '740px', closeable: false });

    const outputEl  = document.getElementById('bd-output');
    const statusEl  = document.getElementById('bd-out-status');
    const closeBtn  = document.getElementById('bd-out-close');
    let rawLog = '';

    document.getElementById('bd-copy-log').addEventListener('click', () =>
      Utils.copyToClipboard(rawLog).then(() => Toast.success('Log copied!')));

    const appendText = (text) => {
      rawLog += text;
      outputEl.innerHTML += colorizeText(text);
      outputEl.scrollTop = outputEl.scrollHeight;
    };

    try {
      const hostParam = Api.getHostId() ? `?hostId=${Api.getHostId()}` : '';
      const response = await fetch(`/api/images/build${hostParam}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(Api._bearerToken ? { 'Authorization': `Bearer ${Api._bearerToken}` } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify(buildParams),
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
              appendText(data.text);
            } else if (data.type === 'error') {
              appendText('\nERROR: ' + data.text + '\n');
            } else if (data.type === 'done') {
              appendText('\n\u2713 Build complete!\n');
              statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i>
                <span style="color:var(--green);font-weight:600">Build complete — ${Utils.escapeHtml(buildParams.tag)}</span>`;
              Toast.success('Image built successfully');
              this._load();
            }
          } catch {}
        }
      }
    } catch (err) {
      appendText('\nBuild failed: ' + err.message + '\n');
      statusEl.innerHTML = `<i class="fas fa-times-circle" style="color:var(--red)"></i>
        <span style="color:var(--red)">Build failed</span>`;
      Toast.error('Build failed: ' + err.message);
    }

    closeBtn.disabled = false;
    closeBtn.addEventListener('click', () => Modal.close());
  },

  _showActionsGuide() {
    const overlay = document.createElement('div');
    overlay.id = 'images-guide-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10000;
      background:rgba(0,0,0,.65);backdrop-filter:blur(3px);
      display:flex;align-items:center;justify-content:center;padding:16px;
    `;

    overlay.innerHTML = `
      <div style="
        background:var(--surface);border:1px solid var(--border);border-radius:var(--radius,8px);
        max-width:960px;width:100%;max-height:90vh;display:flex;flex-direction:column;
        box-shadow:0 24px 64px rgba(0,0,0,.4);overflow:hidden;
      ">
        <div style="display:flex;align-items:center;gap:12px;padding:18px 24px;border-bottom:1px solid var(--border);flex-shrink:0">
          <div style="width:36px;height:36px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-images" style="color:#fff;font-size:15px"></i>
          </div>
          <div>
            <div style="font-weight:700;font-size:16px">Images — Actions Guide</div>
            <div style="font-size:12px;color:var(--text-dim)">Every button, every action — explained</div>
          </div>
          <button id="img-guide-close" style="margin-left:auto;background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:4px;line-height:1" title="Close">&times;</button>
        </div>

        <div style="overflow-y:auto;padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:16px">

          <!-- Image actions -->
          <div style="grid-column:1/-1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <i class="fas fa-th-large" style="color:var(--accent);font-size:14px"></i>
              <span style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">Image actions</span>
              <div style="flex:1;height:1px;background:var(--border);margin-left:4px"></div>
            </div>
          </div>

          ${[
            { icon:'fa-shield-alt', color:'var(--yellow)', label:'Scan for vulnerabilities', desc:'Opens a scanner picker (Auto / Trivy / Grype / Docker Scout). Scans the image for known CVEs in OS packages and language dependencies. Results show Critical → Low counts with per-CVE detail and fix versions.' },
            { icon:'fa-tag', color:'var(--accent)', label:'Tag', desc:'Adds a new tag to the image locally (e.g. <code>myapp:stable</code>). Does not push to a registry — use the registry page for that.' },
            { icon:'fa-file-export', color:'var(--accent)', label:'Export', desc:'Exports the image as a <code>.tar</code> archive (<code>docker save</code>). Download it and import on another host with <code>docker load</code>.' },
            { icon:'fa-search', color:'var(--accent)', label:'Inspect', desc:'Shows the raw Docker inspect output: layers, environment variables, entrypoint, exposed ports, labels, and creation metadata.' },
            { icon:'fa-trash', color:'var(--red)', label:'Remove', desc:'Deletes the image from the local Docker daemon. Fails if a container (even stopped) is still using it — remove the container first.' },
          ].map(a => `
            <div style="display:flex;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas ${a.icon}" style="color:${a.color};font-size:14px"></i>
              </div>
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px">${a.label}</div>
                <div style="font-size:12px;color:var(--text-dim);line-height:1.5">${a.desc}</div>
              </div>
            </div>
          `).join('')}

          <!-- Toolbar actions -->
          <div style="grid-column:1/-1;margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <i class="fas fa-tools" style="color:var(--accent);font-size:14px"></i>
              <span style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">Toolbar actions</span>
              <div style="flex:1;height:1px;background:var(--border);margin-left:4px"></div>
            </div>
          </div>

          ${[
            { icon:'fa-search-plus', color:'var(--yellow)', label:'Scan All', desc:'Queues a vulnerability scan for every image in the list using the auto-detected scanner. Results appear in Security → Scan History.' },
            { icon:'fa-file-import', color:'var(--accent)', label:'Import (.tar)', desc:'Loads an image from a <code>.tar</code> archive exported with <code>docker save</code> or this app\'s Export action. The image is loaded with its original name and tag.' },
            { icon:'fa-server', color:'var(--accent)', label:'Browse Registry', desc:'Opens the registry browser to pull images from configured private or public registries. Search by name, pick a tag, and pull directly into the local daemon.' },
            { icon:'fa-broom', color:'var(--red)', label:'Prune', desc:'Removes <strong>all dangling images</strong> (untagged images not referenced by any container). Optionally removes all unused images (not used by any container, even stopped). Frees disk space.' },
          ].map(a => `
            <div style="display:flex;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas ${a.icon}" style="color:${a.color};font-size:14px"></i>
              </div>
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px">${a.label}</div>
                <div style="font-size:12px;color:var(--text-dim);line-height:1.5">${a.desc}</div>
              </div>
            </div>
          `).join('')}

          <!-- Scan scanners -->
          <div style="grid-column:1/-1;margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <i class="fas fa-microscope" style="color:var(--accent);font-size:14px"></i>
              <span style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)">Vulnerability scanners</span>
              <div style="flex:1;height:1px;background:var(--border);margin-left:4px"></div>
            </div>
          </div>

          ${[
            { icon:'fa-magic', color:'var(--accent)', label:'Auto', desc:'Tries Trivy first, then Grype, then Docker Scout. Picks the first available scanner. Recommended for most users.' },
            { icon:'fa-search', color:'#38bdf8', label:'Trivy', desc:'Open-source scanner by Aqua Security. Scans OS packages + language dependencies (npm, pip, gem, etc.). No authentication needed. <strong>Recommended.</strong>' },
            { icon:'fa-shield-alt', color:'#a855f7', label:'Grype', desc:'Open-source scanner by Anchore. Checks against NVD, GitHub Advisories, Alpine SecDB, and more. Fast and accurate. No authentication needed.' },
            { icon:'fab fa-docker', color:'#388bfd', label:'Docker Scout', desc:'Official Docker tool. Requires Docker Hub authentication. Provides supply chain insights, base image recommendations, and CVE tracking with policy evaluation.' },
          ].map(a => `
            <div style="display:flex;gap:12px;padding:12px 14px;background:var(--surface2);border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="width:32px;height:32px;border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="${a.icon.startsWith('fab') ? a.icon : 'fas ' + a.icon}" style="color:${a.color};font-size:14px"></i>
              </div>
              <div>
                <div style="font-weight:600;font-size:13px;margin-bottom:3px">${a.label}</div>
                <div style="font-size:12px;color:var(--text-dim);line-height:1.5">${a.desc}</div>
              </div>
            </div>
          `).join('')}

        </div>

        <div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;flex-shrink:0">
          <button id="img-guide-close-footer" class="btn btn-secondary">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#img-guide-close').addEventListener('click', close);
    overlay.querySelector('#img-guide-close-footer').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
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

  async _registryBrowser() {
    let registries = [];
    try {
      registries = await Api.getRegistries();
    } catch { /* no registries configured */ }

    if (registries.length === 0) {
      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-warehouse" style="color:var(--accent);margin-right:8px"></i>Registry Browser</h3>
          <button class="modal-close-btn" id="rb-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <div class="empty-msg" style="padding:24px">
            <i class="fas fa-warehouse" style="font-size:32px;color:var(--text-dim);margin-bottom:12px"></i>
            <p>No registries configured.</p>
            <p class="text-sm text-muted">Go to <strong>System &gt; Tools</strong> or use the API to add a registry.</p>
            <div style="margin-top:16px">
              <button class="btn btn-sm btn-primary" id="rb-add-registry"><i class="fas fa-plus"></i> Add Registry</button>
            </div>
          </div>
        </div>
      `, { width: '500px' });
      Modal._content.querySelector('#rb-close').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#rb-add-registry').addEventListener('click', () => {
        Modal.close();
        this._addRegistryDialog();
      });
      return;
    }

    // Show registry list with browse capability
    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-warehouse" style="color:var(--accent);margin-right:8px"></i>Registry Browser</h3>
        <button class="modal-close-btn" id="rb-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
          ${registries.map(r => `
            <button class="btn btn-sm btn-secondary rb-reg-btn" data-id="${r.id}" title="${Utils.escapeHtml(r.url)}">
              <i class="fas fa-server"></i> ${Utils.escapeHtml(r.name)}
            </button>
          `).join('')}
          <button class="btn btn-sm btn-primary" id="rb-add"><i class="fas fa-plus"></i> Add</button>
        </div>
        <div id="rb-catalog" class="text-muted text-sm">Select a registry to browse its repositories.</div>
      </div>
    `, { width: '700px' });

    Modal._content.querySelector('#rb-close').addEventListener('click', () => Modal.close());
    Modal._content.querySelector('#rb-add').addEventListener('click', () => {
      Modal.close();
      this._addRegistryDialog();
    });

    Modal._content.querySelectorAll('.rb-reg-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const regId = parseInt(btn.dataset.id);
        const catalog = Modal._content.querySelector('#rb-catalog');
        catalog.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading repositories...';

        try {
          const repos = await Api.getRegistryCatalog(regId);
          if (!repos.length) {
            catalog.innerHTML = '<div class="empty-msg">No repositories found in this registry.</div>';
            return;
          }

          catalog.innerHTML = `
            <table class="data-table compact">
              <thead><tr><th>Repository</th><th style="width:100px">Actions</th></tr></thead>
              <tbody>
                ${repos.map(repo => `
                  <tr>
                    <td class="mono text-sm">${Utils.escapeHtml(repo)}</td>
                    <td>
                      <button class="btn btn-xs btn-secondary rb-tags" data-reg="${regId}" data-repo="${Utils.escapeHtml(repo)}"><i class="fas fa-tags"></i> Tags</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `;

          catalog.querySelectorAll('.rb-tags').forEach(tagBtn => {
            tagBtn.addEventListener('click', async () => {
              const rid = parseInt(tagBtn.dataset.reg);
              const repoName = tagBtn.dataset.repo;
              tagBtn.disabled = true;
              tagBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
              try {
                const tags = await Api.getRegistryTags(rid, repoName);
                const reg = registries.find(r => r.id === rid);
                const registryHost = reg ? new URL(reg.url).host : '';

                // Replace the catalog content with tags + pull buttons
                catalog.innerHTML = `
                  <div style="margin-bottom:8px">
                    <button class="btn btn-xs btn-secondary" id="rb-back"><i class="fas fa-arrow-left"></i> Back</button>
                    <strong class="mono" style="margin-left:8px">${Utils.escapeHtml(repoName)}</strong>
                    <span class="badge badge-info" style="margin-left:6px">${tags.length} tags</span>
                  </div>
                  <table class="data-table compact">
                    <thead><tr><th>Tag</th><th style="width:150px">Actions</th></tr></thead>
                    <tbody>
                      ${(tags || []).map(tag => `
                        <tr>
                          <td class="mono text-sm">${Utils.escapeHtml(tag)}</td>
                          <td>
                            <button class="btn btn-xs btn-primary rb-pull" data-reg="${rid}" data-image="${Utils.escapeHtml(repoName)}" data-tag="${Utils.escapeHtml(tag)}">
                              <i class="fas fa-download"></i> Pull
                            </button>
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                `;

                catalog.querySelector('#rb-back').addEventListener('click', () => btn.click());
                catalog.querySelectorAll('.rb-pull').forEach(pullBtn => {
                  pullBtn.addEventListener('click', async () => {
                    pullBtn.disabled = true;
                    pullBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pulling...';
                    try {
                      await Api.pullFromRegistry(parseInt(pullBtn.dataset.reg), pullBtn.dataset.image, pullBtn.dataset.tag);
                      Toast.success(`Pulled ${registryHost}/${pullBtn.dataset.image}:${pullBtn.dataset.tag}`);
                      pullBtn.innerHTML = '<i class="fas fa-check"></i> Done';
                    } catch (err) {
                      Toast.error('Pull failed: ' + err.message);
                      pullBtn.disabled = false;
                      pullBtn.innerHTML = '<i class="fas fa-download"></i> Pull';
                    }
                  });
                });
              } catch (err) {
                Toast.error('Failed to load tags: ' + err.message);
                tagBtn.disabled = false;
                tagBtn.innerHTML = '<i class="fas fa-tags"></i> Tags';
              }
            });
          });
        } catch (err) {
          catalog.innerHTML = `<div class="text-sm" style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
        }
      });
    });
  },

  async _addRegistryDialog() {
    const result = await Modal.form(`
      <div class="form-group">
        <label>Name *</label>
        <input type="text" id="reg-name" class="form-control" placeholder="My Registry">
      </div>
      <div class="form-group">
        <label>URL *</label>
        <input type="url" id="reg-url" class="form-control" placeholder="https://registry.example.com">
      </div>
      <div class="form-group">
        <label>Username (optional)</label>
        <input type="text" id="reg-user" class="form-control">
      </div>
      <div class="form-group">
        <label>Password (optional)</label>
        <input type="password" id="reg-pass" class="form-control">
      </div>
    `, {
      title: 'Add Registry',
      width: '450px',
      onSubmit: (content) => {
        const name = content.querySelector('#reg-name').value.trim();
        const url = content.querySelector('#reg-url').value.trim();
        if (!name || !url) { Toast.error('Name and URL are required'); return false; }
        return {
          name, url,
          username: content.querySelector('#reg-user').value.trim() || undefined,
          password: content.querySelector('#reg-pass').value || undefined,
        };
      },
    });
    if (!result) return;
    try {
      await Api.createRegistry(result);
      Toast.success('Registry added');
    } catch (err) {
      Toast.error(err.message);
    }
  },

  destroy() {
    clearInterval(this._refreshTimer);
  },
};

window.ImagesPage = ImagesPage;
