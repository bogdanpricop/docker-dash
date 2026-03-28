/* ═══════════════════════════════════════════════════
   pages/about.js — About & Open Source Files
   ═══════════════════════════════════════════════════ */
'use strict';

const AboutPage = {
  _files: [],
  _version: '',
  _editingFile: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-info-circle"></i> ${i18n.t('pages.about.title')}</h2>
      </div>
      <div id="about-content"><div class="text-muted" style="padding:20px"><i class="fas fa-spinner fa-spin"></i> ${i18n.t('common.loading')}</div></div>
    `;
    await this._load();
  },

  async _load() {
    const el = document.getElementById('about-content');
    if (!el) return;
    try {
      const data = await Api.getAboutFiles();
      this._files = data.files || [];
      this._version = data.version || '?';
      this._render();
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">${err.message}</div>`;
    }
  },

  _render() {
    const el = document.getElementById('about-content');
    if (!el) return;

    const fileIcons = {
      'README.md': 'fa-book-open',
      'LICENSE': 'fa-balance-scale',
      'CONTRIBUTING.md': 'fa-hands-helping',
      '.env.example': 'fa-key',
      '.gitignore': 'fa-eye-slash',
    };
    const fileDescs = {
      'README.md': i18n.t('pages.about.readmeDesc'),
      'LICENSE': i18n.t('pages.about.licenseDesc'),
      'CONTRIBUTING.md': i18n.t('pages.about.contributingDesc'),
      '.env.example': i18n.t('pages.about.envDesc'),
      '.gitignore': i18n.t('pages.about.gitignoreDesc'),
    };

    el.innerHTML = `
      <!-- App Info Card -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <h3><i class="fas fa-whale" style="color:var(--accent);margin-right:8px"></i>Docker Dash</h3>
        </div>
        <div class="card-body">
          <table class="info-table">
            <tr><td>${i18n.t('pages.about.version')}</td><td><strong>v${Utils.escapeHtml(this._version)}</strong></td></tr>
            <tr><td>${i18n.t('pages.about.license')}</td><td>MIT</td></tr>
            <tr><td>${i18n.t('pages.about.tech')}</td><td>Node.js, Express, SQLite, Vanilla JS</td></tr>
            <tr><td>${i18n.t('pages.about.repo')}</td><td><a href="https://github.com/bogdanpricop/docker-dash" target="_blank" rel="noopener" style="color:var(--accent)"><i class="fab fa-github" style="margin-right:4px"></i>bogdanpricop/docker-dash</a></td></tr>
            <tr><td>Author</td><td>Bogdan Pricop — <a href="mailto:bogdan.pricop@gmail.com" style="color:var(--accent)">bogdan.pricop@gmail.com</a></td></tr>
          </table>
        </div>
      </div>

      <!-- Open Source Files -->
      <div class="card">
        <div class="card-header">
          <h3><i class="fab fa-github" style="color:var(--accent);margin-right:8px"></i>${i18n.t('pages.about.filesTitle')}</h3>
          <span class="text-dim text-sm">${i18n.t('pages.about.filesDesc')}</span>
        </div>
        <div class="card-body" style="padding:0">
          <table class="data-table compact">
            <thead><tr>
              <th>${i18n.t('pages.about.fileName')}</th>
              <th>${i18n.t('pages.about.fileDescription')}</th>
              <th>${i18n.t('pages.about.fileStatus')}</th>
              <th style="width:120px"></th>
            </tr></thead>
            <tbody>
              ${this._files.map(f => `
                <tr>
                  <td>
                    <i class="fas ${fileIcons[f.name] || 'fa-file'}" style="color:var(--accent);margin-right:6px;width:16px;text-align:center"></i>
                    <span class="mono">${Utils.escapeHtml(f.name)}</span>
                  </td>
                  <td class="text-sm text-muted">${fileDescs[f.name] || ''}</td>
                  <td>
                    ${f.exists
                      ? `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> ${Utils.formatBytes(f.size)}</span>`
                      : `<span style="color:var(--red)"><i class="fas fa-times-circle"></i> ${i18n.t('pages.about.missing')}</span>`}
                  </td>
                  <td>
                    <div class="action-btns">
                      ${f.exists ? `<button class="action-btn about-view" data-name="${f.name}" title="${i18n.t('pages.about.view')}"><i class="fas fa-eye"></i></button>
                      <button class="action-btn about-edit" data-name="${f.name}" title="${i18n.t('pages.about.edit')}"><i class="fas fa-edit"></i></button>` : ''}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Security Checklist -->
      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <h3><i class="fas fa-shield-alt" style="color:var(--yellow);margin-right:8px"></i>${i18n.t('pages.about.checklistTitle')}</h3>
        </div>
        <div class="card-body">
          <p class="text-sm text-muted" style="margin-bottom:12px">${i18n.t('pages.about.checklistDesc')}</p>
          <div id="about-checklist" style="display:flex;flex-direction:column;gap:6px">
            ${this._renderChecklist()}
          </div>
        </div>
      </div>
    `;

    // Bind view/edit buttons
    el.querySelectorAll('.about-view').forEach(btn => {
      btn.addEventListener('click', () => this._viewFile(btn.dataset.name));
    });
    el.querySelectorAll('.about-edit').forEach(btn => {
      btn.addEventListener('click', () => this._editFile(btn.dataset.name));
    });
  },

  _renderChecklist() {
    const checks = [
      { key: 'gitignore', icon: 'fa-eye-slash', ok: this._files.find(f => f.name === '.gitignore')?.exists },
      { key: 'license', icon: 'fa-balance-scale', ok: this._files.find(f => f.name === 'LICENSE')?.exists },
      { key: 'readme', icon: 'fa-book-open', ok: this._files.find(f => f.name === 'README.md')?.exists },
      { key: 'envExample', icon: 'fa-key', ok: this._files.find(f => f.name === '.env.example')?.exists },
      { key: 'contributing', icon: 'fa-hands-helping', ok: this._files.find(f => f.name === 'CONTRIBUTING.md')?.exists },
    ];

    return checks.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--surface2)">
        <i class="fas ${c.ok ? 'fa-check-circle' : 'fa-times-circle'}" style="color:${c.ok ? 'var(--green)' : 'var(--red)'};width:16px"></i>
        <i class="fas ${c.icon}" style="color:var(--text-dim);width:16px;text-align:center"></i>
        <span class="text-sm">${i18n.t('pages.about.check_' + c.key)}</span>
      </div>
    `).join('');
  },

  async _viewFile(name) {
    try {
      const data = await Api.getAboutFile(name);
      const isMarkdown = name.endsWith('.md');
      Modal.open(`
        <div class="modal-header">
          <h3><i class="fas fa-file-alt" style="color:var(--accent);margin-right:8px"></i>${Utils.escapeHtml(name)}</h3>
          <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body">
          <pre style="white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;max-height:70vh;overflow-y:auto;background:var(--surface2);padding:14px;border-radius:var(--radius-sm)">${Utils.escapeHtml(data.content)}</pre>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="about-copy"><i class="fas fa-copy"></i> ${i18n.t('pages.about.copy')}</button>
          <button class="btn btn-primary" id="modal-ok">${i18n.t('common.close')}</button>
        </div>
      `, { width: '800px' });
      Modal._content.querySelector('#modal-x').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#modal-ok').addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#about-copy').addEventListener('click', () => {
        Utils.copyToClipboard(data.content);
        Toast.success(i18n.t('pages.about.copied'));
      });
    } catch (err) {
      Toast.error(err.message);
    }
  },

  async _editFile(name) {
    try {
      const data = await Api.getAboutFile(name);
      const result = await Modal.form(`
        <div style="margin-bottom:8px">
          <span class="text-sm text-muted"><i class="fas fa-info-circle"></i> ${i18n.t('pages.about.editHint')}</span>
        </div>
        <textarea id="about-editor" class="form-control" rows="25"
          style="font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.5;resize:vertical;white-space:pre;tab-size:2"
        >${Utils.escapeHtml(data.content)}</textarea>
      `, {
        title: `${i18n.t('pages.about.edit')} ${name}`,
        width: '900px',
        onSubmit: (content) => content.querySelector('#about-editor').value,
      });

      if (result !== null && result !== undefined) {
        await Api.saveAboutFile(name, result);
        Toast.success(i18n.t('pages.about.saved', { name }));
        await this._load();
      }
    } catch (err) {
      Toast.error(err.message);
    }
  },

  destroy() {},
};

window.AboutPage = AboutPage;
