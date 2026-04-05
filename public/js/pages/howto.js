'use strict';

const HowToPage = {
  _guides: [],
  _category: '',
  _search: '',

  async render(container) {
    const isAdmin = App.user?.role === 'admin';

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-graduation-cap" style="color:var(--accent)"></i> How-To Guides</h2>
        <div class="page-actions">
          <div class="search-box" style="max-width:260px">
            <i class="fas fa-search"></i>
            <input type="text" id="howto-search" placeholder="Search guides...">
          </div>
          ${isAdmin ? '<button class="btn btn-sm btn-primary" id="howto-new"><i class="fas fa-plus"></i> New Guide</button>' : ''}
          <button class="btn btn-sm btn-secondary" id="howto-refresh"><i class="fas fa-sync-alt"></i></button>
        </div>
      </div>
      <div id="howto-categories" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px"></div>
      <div id="howto-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px"></div>
    `;

    // Category pills
    this._renderCategories(container);

    container.querySelector('#howto-search')?.addEventListener('input', Utils.debounce((e) => {
      this._search = e.target.value.trim();
      this._load();
    }, 300));

    container.querySelector('#howto-refresh')?.addEventListener('click', () => this._load());
    container.querySelector('#howto-new')?.addEventListener('click', () => this._openEditor());

    await this._load();
  },

  _renderCategories(container) {
    const cats = [
      { id: '', label: 'All', icon: 'fa-th' },
      { id: 'basics', label: 'Basics', icon: 'fa-play-circle' },
      { id: 'linux', label: 'Linux', icon: 'fa-terminal' },
      { id: 'networking', label: 'Networking', icon: 'fa-network-wired' },
      { id: 'security', label: 'Security', icon: 'fa-shield-alt' },
      { id: 'compose', label: 'Compose', icon: 'fa-layer-group' },
      { id: 'troubleshooting', label: 'Troubleshooting', icon: 'fa-wrench' },
      { id: 'docker-dash', label: 'Docker Dash', icon: 'fa-tachometer-alt' },
      { id: 'backup', label: 'Backup', icon: 'fa-database' },
      { id: 'performance', label: 'Performance', icon: 'fa-rocket' },
    ];

    const el = container.querySelector('#howto-categories');
    el.innerHTML = cats.map(c => `
      <button class="filter-preset ${this._category === c.id ? 'active' : ''}" data-howto-cat="${c.id}">
        <i class="fas ${c.icon}" style="margin-right:4px"></i>${c.label}
      </button>
    `).join('');

    el.querySelectorAll('[data-howto-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._category = btn.dataset.howtoCat;
        el.querySelectorAll('[data-howto-cat]').forEach(b => b.classList.toggle('active', b.dataset.howtoCat === this._category));
        this._load();
      });
    });
  },

  async _load() {
    const grid = document.getElementById('howto-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="text-muted" style="grid-column:1/-1;padding:20px;text-align:center"><i class="fas fa-spinner fa-spin"></i> Loading guides...</div>';

    const params = {};
    if (this._category) params.category = this._category;
    if (this._search) params.search = this._search;

    try {
      const data = await Api.getHowtoGuides(params);
      this._guides = data.guides || [];

      if (this._guides.length === 0) {
        grid.innerHTML = '<div class="empty-msg" style="grid-column:1/-1"><i class="fas fa-inbox"></i><p>No guides found matching your filters.</p></div>';
        return;
      }

      const isAdmin = App.user?.role === 'admin';
      // Determine language: check i18n current language
      const isRo = (typeof i18n !== 'undefined' && i18n.currentLang === 'ro');

      grid.innerHTML = this._guides.map(g => {
        const title = (isRo && g.title_ro) ? g.title_ro : g.title;
        const summary = (isRo && g.summary_ro) ? g.summary_ro : g.summary;
        const diffColor = g.difficulty === 'beginner' ? 'var(--green)' : g.difficulty === 'intermediate' ? 'var(--yellow)' : 'var(--red)';
        const diffLabel = g.difficulty === 'beginner' ? 'Beginner' : g.difficulty === 'intermediate' ? 'Intermediate' : 'Advanced';

        return `
          <div class="card howto-card" data-howto-slug="${Utils.escapeHtml(g.slug)}" style="cursor:pointer;transition:transform 0.15s,box-shadow 0.15s">
            <div class="card-body" style="padding:16px">
              <div style="display:flex;align-items:flex-start;gap:12px">
                <div style="width:40px;height:40px;border-radius:8px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                  <i class="${Utils.escapeHtml(g.icon || 'fas fa-book')}" style="color:var(--accent);font-size:16px"></i>
                </div>
                <div style="flex:1;min-width:0">
                  <h4 style="margin:0 0 4px;font-size:14px;color:var(--text-bright)">${Utils.escapeHtml(title)}</h4>
                  <p class="text-muted" style="margin:0;font-size:12px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${Utils.escapeHtml(summary)}</p>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:10px">
                <span class="badge" style="font-size:9px;background:var(--surface3);color:var(--text-dim)">${Utils.escapeHtml(g.category)}</span>
                <span class="badge" style="font-size:9px;background:${diffColor}22;color:${diffColor}">${diffLabel}</span>
                ${g.is_builtin ? '' : '<span class="badge" style="font-size:9px;background:var(--accent-dim);color:var(--accent)">Custom</span>'}
                ${isAdmin ? `<button class="action-btn" data-howto-edit="${Utils.escapeHtml(g.slug)}" style="margin-left:auto;font-size:10px" title="Edit"><i class="fas fa-edit"></i></button>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Wire card clicks
      grid.querySelectorAll('.howto-card').forEach(card => {
        card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)'; });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.boxShadow = ''; });
        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-howto-edit]')) return;
          this._openGuide(card.dataset.howtoSlug);
        });
      });

      // Wire edit buttons
      grid.querySelectorAll('[data-howto-edit]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._openEditor(btn.dataset.howtoEdit);
        });
      });

    } catch (err) {
      grid.innerHTML = `<div class="empty-msg" style="grid-column:1/-1">Error: ${err.message}</div>`;
    }
  },

  async _openGuide(slug) {
    try {
      const guide = await Api.getHowtoGuide(slug);
      const isRo = (typeof i18n !== 'undefined' && i18n.currentLang === 'ro');
      const title = (isRo && guide.title_ro) ? guide.title_ro : guide.title;
      const content = (isRo && guide.content_ro) ? guide.content_ro : guide.content;
      const summary = (isRo && guide.summary_ro) ? guide.summary_ro : guide.summary;
      const diffColor = guide.difficulty === 'beginner' ? 'var(--green)' : guide.difficulty === 'intermediate' ? 'var(--yellow)' : 'var(--red)';

      Modal.open(`
        <div class="modal-header" style="display:flex;align-items:center;gap:12px">
          <div style="width:36px;height:36px;border-radius:8px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center">
            <i class="${Utils.escapeHtml(guide.icon || 'fas fa-book')}" style="color:var(--accent)"></i>
          </div>
          <div style="flex:1">
            <h3 style="margin:0">${Utils.escapeHtml(title)}</h3>
            <div style="display:flex;gap:6px;margin-top:4px">
              <span class="badge" style="font-size:9px">${Utils.escapeHtml(guide.category)}</span>
              <span class="badge" style="font-size:9px;background:${diffColor}22;color:${diffColor}">${guide.difficulty}</span>
            </div>
          </div>
          <button class="modal-close-btn" id="howto-view-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          ${content
            ? `<div class="howto-content" style="font-size:13px;line-height:1.7;color:var(--text)">${content}</div>`
            : `<div style="padding:20px;text-align:center">
                <p style="font-size:14px;margin-bottom:8px">${Utils.escapeHtml(summary)}</p>
                <p class="text-muted text-sm">Full content not yet available for this guide.</p>
              </div>`
          }
        </div>
        <div class="modal-footer"><button class="btn btn-primary" id="howto-view-close-btn">Close</button></div>
      `, { width: '700px' });

      Modal._content.querySelector('#howto-view-close')?.addEventListener('click', () => Modal.close());
      Modal._content.querySelector('#howto-view-close-btn')?.addEventListener('click', () => Modal.close());
    } catch (err) {
      Toast.error('Failed to load guide: ' + err.message);
    }
  },

  async _openEditor(slug) {
    let guide = { slug: '', title: '', title_ro: '', category: 'general', difficulty: 'beginner', icon: 'fas fa-book', summary: '', summary_ro: '', content: '', content_ro: '' };
    const isEdit = !!slug;

    if (isEdit) {
      try { guide = await Api.getHowtoGuide(slug); } catch (err) { Toast.error(err.message); return; }
    }

    const cats = ['basics', 'linux', 'networking', 'security', 'compose', 'troubleshooting', 'docker-dash', 'backup', 'performance', 'general'];

    Modal.open(`
      <div class="modal-header">
        <h3><i class="fas fa-${isEdit ? 'edit' : 'plus'}" style="margin-right:8px;color:var(--accent)"></i>${isEdit ? 'Edit' : 'New'} Guide</h3>
        <button class="modal-close-btn" id="howto-ed-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="max-height:70vh;overflow-y:auto">
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Title (EN) *</label>
            <input id="howto-ed-title" class="form-control" value="${Utils.escapeHtml(guide.title)}" required>
          </div>
          <div class="form-group" style="flex:2">
            <label>Title (RO)</label>
            <input id="howto-ed-title-ro" class="form-control" value="${Utils.escapeHtml(guide.title_ro || '')}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Slug *</label>
            <input id="howto-ed-slug" class="form-control" value="${Utils.escapeHtml(guide.slug)}" ${isEdit ? 'disabled' : ''} placeholder="my-guide-slug">
          </div>
          <div class="form-group">
            <label>Category</label>
            <select id="howto-ed-cat" class="form-control">
              ${cats.map(c => `<option value="${c}" ${guide.category === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Difficulty</label>
            <select id="howto-ed-diff" class="form-control">
              <option value="beginner" ${guide.difficulty === 'beginner' ? 'selected' : ''}>Beginner</option>
              <option value="intermediate" ${guide.difficulty === 'intermediate' ? 'selected' : ''}>Intermediate</option>
              <option value="advanced" ${guide.difficulty === 'advanced' ? 'selected' : ''}>Advanced</option>
            </select>
          </div>
          <div class="form-group">
            <label>Icon</label>
            <input id="howto-ed-icon" class="form-control" value="${Utils.escapeHtml(guide.icon || 'fas fa-book')}" placeholder="fas fa-book">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <label>Summary (EN)</label>
            <textarea id="howto-ed-summary" class="form-control" rows="2">${Utils.escapeHtml(guide.summary || '')}</textarea>
          </div>
          <div class="form-group" style="flex:1">
            <label>Summary (RO)</label>
            <textarea id="howto-ed-summary-ro" class="form-control" rows="2">${Utils.escapeHtml(guide.summary_ro || '')}</textarea>
          </div>
        </div>
        <div class="form-group">
          <label>Content (EN) — HTML</label>
          <textarea id="howto-ed-content" class="form-control" rows="10" style="font-family:var(--mono);font-size:12px">${Utils.escapeHtml(guide.content || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Content (RO) — HTML</label>
          <textarea id="howto-ed-content-ro" class="form-control" rows="10" style="font-family:var(--mono);font-size:12px">${Utils.escapeHtml(guide.content_ro || '')}</textarea>
        </div>
        ${isEdit && !guide.is_builtin ? '<button class="btn btn-sm btn-danger" id="howto-ed-delete" style="margin-top:8px"><i class="fas fa-trash"></i> Delete Guide</button>' : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="howto-ed-cancel">Cancel</button>
        <button class="btn btn-primary" id="howto-ed-save"><i class="fas fa-save"></i> Save</button>
      </div>
    `, { width: '800px' });

    const mc = Modal._content;
    mc.querySelector('#howto-ed-close')?.addEventListener('click', () => Modal.close());
    mc.querySelector('#howto-ed-cancel')?.addEventListener('click', () => Modal.close());

    // Auto-generate slug from title
    if (!isEdit) {
      mc.querySelector('#howto-ed-title')?.addEventListener('input', (e) => {
        const slugField = mc.querySelector('#howto-ed-slug');
        if (slugField && !slugField.dataset.manual) {
          slugField.value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        }
      });
      mc.querySelector('#howto-ed-slug')?.addEventListener('input', () => {
        mc.querySelector('#howto-ed-slug').dataset.manual = '1';
      });
    }

    mc.querySelector('#howto-ed-save')?.addEventListener('click', async () => {
      const data = {
        slug: mc.querySelector('#howto-ed-slug')?.value?.trim(),
        title: mc.querySelector('#howto-ed-title')?.value?.trim(),
        title_ro: mc.querySelector('#howto-ed-title-ro')?.value?.trim() || '',
        category: mc.querySelector('#howto-ed-cat')?.value || 'general',
        difficulty: mc.querySelector('#howto-ed-diff')?.value || 'beginner',
        icon: mc.querySelector('#howto-ed-icon')?.value?.trim() || 'fas fa-book',
        summary: mc.querySelector('#howto-ed-summary')?.value?.trim() || '',
        summary_ro: mc.querySelector('#howto-ed-summary-ro')?.value?.trim() || '',
        content: mc.querySelector('#howto-ed-content')?.value || '',
        content_ro: mc.querySelector('#howto-ed-content-ro')?.value || '',
      };

      if (!data.slug || !data.title) { Toast.warning('Title and slug are required'); return; }

      const btn = mc.querySelector('#howto-ed-save');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

      try {
        if (isEdit) {
          await Api.updateHowtoGuide(slug, data);
          Toast.success('Guide updated');
        } else {
          await Api.createHowtoGuide(data);
          Toast.success('Guide created');
        }
        Modal.close();
        await this._load();
      } catch (err) {
        Toast.error(err.message);
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> Save';
      }
    });

    mc.querySelector('#howto-ed-delete')?.addEventListener('click', async () => {
      const ok = await Modal.confirm('Delete this guide? This cannot be undone.', { danger: true, confirmText: 'Delete' });
      if (!ok) return;
      try {
        await Api.deleteHowtoGuide(slug);
        Toast.success('Guide deleted');
        Modal.close();
        await this._load();
      } catch (err) { Toast.error(err.message); }
    });
  },

  destroy() {},
};

window.HowToPage = HowToPage;
