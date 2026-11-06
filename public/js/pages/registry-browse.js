/* ═══════════════════════════════════════════════════
   pages/registry-browse.js — Registry Browser (v7.5.0)

   Read-only catalog explorer for any configured Registry credential.
   Lists repositories, tags per repository, and on-demand manifest
   inspection (digest, size, layer count, content type).

   Delete is intentionally NOT here in v7.5.0 — it requires digest
   resolution + a confirmation gate (deleting a tag in production is a
   footgun) and ships in v7.6 if the workflow is needed.
   ═══════════════════════════════════════════════════ */
'use strict';

const RegistryBrowsePage = {
  _registries: [],
  _selectedId: null,
  _repos: [],
  _filter: '',
  _selectedRepo: null,
  _tags: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-warehouse" style="color:var(--accent)"></i> Registry Browser</h2>
        <div class="page-actions">
          <select id="rb-registry" class="form-control form-control-sm" style="min-width:240px">
            <option value="">— Select a registry —</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="rb-refresh" title="Refresh catalog"><i class="fas fa-sync-alt"></i></button>
          <a href="#/settings" class="btn btn-sm btn-secondary" title="Manage registry credentials" style="text-decoration:none"><i class="fas fa-cog"></i> Manage</a>
        </div>
      </div>

      <div id="rb-empty" style="display:none;text-align:center;padding:40px;color:var(--text-dim)">
        <i class="fas fa-warehouse" style="font-size:48px;margin-bottom:14px;opacity:0.3"></i>
        <p>No registries configured. Add one in <a href="#/settings" style="color:var(--accent)">Settings → Registries</a> first.</p>
        <p class="text-sm" style="margin-top:14px">Need a quick private registry? Deploy the <a href="#/templates" style="color:var(--accent)">Private Registry (Distribution) template</a>.</p>
      </div>

      <div id="rb-content" style="display:none;display:grid;grid-template-columns:minmax(280px, 380px) 1fr;gap:16px;align-items:start">
        <div class="card">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <h3 style="margin:0"><i class="fas fa-folder-tree"></i> Repositories <span class="text-muted text-sm" id="rb-repo-count"></span></h3>
            <input type="text" id="rb-filter" class="form-control form-control-sm" placeholder="Filter…" style="max-width:140px">
          </div>
          <div class="card-body" style="padding:0">
            <div id="rb-repos-list" style="max-height:60vh;overflow-y:auto"></div>
          </div>
        </div>

        <div id="rb-detail">
          <div class="card">
            <div class="card-body" style="text-align:center;padding:60px 20px;color:var(--text-dim)">
              <i class="fas fa-mouse-pointer" style="font-size:32px;margin-bottom:14px;opacity:0.3"></i>
              <p>Select a repository on the left to list its tags.</p>
            </div>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#rb-registry').addEventListener('change', (e) => {
      this._selectedId = e.target.value || null;
      if (this._selectedId) {
        try { sessionStorage.setItem('rb_last_registry', this._selectedId); } catch {}
      }
      this._loadCatalog();
    });
    container.querySelector('#rb-refresh').addEventListener('click', () => this._loadCatalog());
    container.querySelector('#rb-filter').addEventListener('input', Utils.debounce((e) => {
      this._filter = e.target.value.trim().toLowerCase();
      this._renderRepos();
    }, 150));

    await this._loadRegistries();
  },

  async _loadRegistries() {
    try {
      this._registries = await Api.get('/registries');
    } catch (err) {
      Toast.error('Could not list registries: ' + err.message);
      return;
    }
    const sel = document.getElementById('rb-registry');
    const empty = document.getElementById('rb-empty');
    const content = document.getElementById('rb-content');
    if (!Array.isArray(this._registries) || this._registries.length === 0) {
      empty.style.display = 'block';
      content.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    content.style.display = 'grid';
    sel.innerHTML = '<option value="">— Select a registry —</option>' +
      this._registries.map(r => `<option value="${r.id}">${Utils.escapeHtml(r.name)} — ${Utils.escapeHtml(r.url)}</option>`).join('');

    // Restore last-selected from sessionStorage if present, else pick first
    let preferred = null;
    try { preferred = sessionStorage.getItem('rb_last_registry'); } catch {}
    if (preferred && this._registries.find(r => String(r.id) === preferred)) {
      sel.value = preferred;
      this._selectedId = preferred;
    } else if (this._registries.length === 1) {
      sel.value = String(this._registries[0].id);
      this._selectedId = String(this._registries[0].id);
    }
    if (this._selectedId) await this._loadCatalog();
  },

  async _loadCatalog() {
    if (!this._selectedId) return;
    const list = document.getElementById('rb-repos-list');
    list.innerHTML = `<div class="text-muted text-sm" style="padding:14px;text-align:center"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    try {
      this._repos = await Api.get(`/registries/${this._selectedId}/catalog`);
      this._renderRepos();
    } catch (err) {
      list.innerHTML = `<div class="text-muted text-sm" style="padding:14px;text-align:center;color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderRepos() {
    const list = document.getElementById('rb-repos-list');
    const count = document.getElementById('rb-repo-count');
    const filtered = this._filter
      ? this._repos.filter(r => r.toLowerCase().includes(this._filter))
      : this._repos;
    count.textContent = filtered.length === this._repos.length
      ? `(${this._repos.length})`
      : `(${filtered.length} / ${this._repos.length})`;
    if (filtered.length === 0) {
      list.innerHTML = `<div class="text-muted text-sm" style="padding:14px;text-align:center">No repositories${this._filter ? ' match the filter' : ''}.</div>`;
      return;
    }
    list.innerHTML = filtered.map(repo => `
      <div class="rb-repo-row" data-repo="${Utils.escapeHtml(repo)}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-family:'JetBrains Mono',monospace;font-size:12px;${this._selectedRepo === repo ? 'background:rgba(56,139,253,0.12);color:var(--accent)' : ''}">
        <i class="fas fa-folder" style="margin-right:6px;font-size:10px"></i>${Utils.escapeHtml(repo)}
      </div>
    `).join('');
    list.querySelectorAll('.rb-repo-row').forEach(el => {
      el.addEventListener('click', () => this._selectRepo(el.dataset.repo));
      el.addEventListener('mouseenter', () => { if (this._selectedRepo !== el.dataset.repo) el.style.background = 'var(--surface2)'; });
      el.addEventListener('mouseleave', () => { if (this._selectedRepo !== el.dataset.repo) el.style.background = ''; });
    });
  },

  async _selectRepo(repo) {
    this._selectedRepo = repo;
    this._renderRepos();
    const isAdmin = window.App?.user?.role === 'admin';
    const detail = document.getElementById('rb-detail');
    detail.innerHTML = `
      <div id="rb-repo-type-banner" style="display:none;margin-bottom:10px"></div>
      <div class="card">
        <div class="card-header"><h3><i class="fas fa-tags"></i> ${Utils.escapeHtml(repo)} — tags</h3></div>
        <div class="card-body" id="rb-tags-body">
          <div class="text-muted text-sm" style="text-align:center;padding:14px"><i class="fas fa-spinner fa-spin"></i> Loading tags…</div>
        </div>
      </div>
      <div class="card" style="margin-top:14px;display:none" id="rb-manifest-card">
        <div class="card-header"><h3><i class="fas fa-file-code"></i> Manifest <span id="rb-manifest-tag" style="color:var(--text-dim);font-weight:normal;font-size:13px;margin-left:6px"></span></h3></div>
        <div class="card-body" id="rb-manifest-body"></div>
      </div>
      ${isAdmin ? `
        <details class="card" style="margin-top:14px">
          <summary style="cursor:pointer;padding:12px 14px;list-style:none;user-select:none;display:flex;align-items:center;gap:10px">
            <i class="fas fa-cog" style="color:var(--accent)"></i>
            <strong>Repository settings</strong>
            <span class="text-muted text-sm" style="margin-left:auto;font-size:11px">type · retention</span>
          </summary>
          <div style="padding:0 14px 14px 14px">
            <div id="rb-repo-type-editor" style="margin-top:8px"></div>
            <hr class="divider" style="margin:14px 0">
            <div id="rb-retention-editor"></div>
          </div>
        </details>
      ` : ''}
    `;
    try {
      const [tags, repos] = await Promise.all([
        Api.get(`/registries/${this._selectedId}/tags/${repo}`),
        Api.get(`/registries/${this._selectedId}/repos`).catch(() => []),
      ]);
      this._tags = tags;
      this._repoEntries = repos || [];
      this._renderTags(repo);
      this._renderRepoTypeBanner(repo);
      if (isAdmin) {
        this._renderRepoTypeEditor(repo);
        this._renderRetentionEditor(repo);
      }
    } catch (err) {
      document.getElementById('rb-tags-body').innerHTML = `<div class="text-muted text-sm" style="text-align:center;padding:14px;color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  // v8.1.0 — find the registry_repos entry for the currently-selected repo,
  // falling back to the catch-all "*" row if no specific entry exists.
  _findRepoEntry(repo) {
    if (!Array.isArray(this._repoEntries)) return null;
    return this._repoEntries.find(r => r.repoPath === repo)
        || this._repoEntries.find(r => r.repoPath === '*')
        || null;
  },

  _renderRepoTypeBanner(repo) {
    const entry = this._findRepoEntry(repo);
    const banner = document.getElementById('rb-repo-type-banner');
    if (!entry || !banner) return;
    const styles = {
      local:   { bg: 'rgba(110,118,129,0.15)', color: 'var(--text-dim)', icon: 'fa-folder' },
      remote:  { bg: 'rgba(56,139,253,0.15)',  color: 'var(--accent)',   icon: 'fa-cloud-download-alt' },
      virtual: { bg: 'rgba(46,160,67,0.15)',   color: 'var(--green)',    icon: 'fa-project-diagram' },
    };
    const s = styles[entry.type] || styles.local;
    const upstream = entry.upstreamUrl ? ` · upstream: <code style="font-family:'JetBrains Mono',monospace;font-size:11px">${Utils.escapeHtml(entry.upstreamUrl)}</code>` : '';
    banner.style.display = 'block';
    banner.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:12px;background:${s.bg};color:${s.color};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">
        <i class="fas ${s.icon}" style="font-size:10px"></i>${entry.type}
      </span>
      <span class="text-muted text-sm" style="margin-left:8px">${entry.repoPath === '*' ? 'catch-all default' : `path: <code style="font-family:'JetBrains Mono',monospace;font-size:11px">${Utils.escapeHtml(entry.repoPath)}</code>`}${upstream}</span>
    `;
  },

  _renderRepoTypeEditor(repo) {
    const entry = this._findRepoEntry(repo);
    const el = document.getElementById('rb-repo-type-editor');
    if (!el) return;
    const currentType = entry?.type || 'local';
    const upstreamUrl = entry?.upstreamUrl || '';
    el.innerHTML = `
      <h4 style="margin:0 0 8px;font-size:13px"><i class="fas fa-tag"></i> Repository type</h4>
      <p class="text-muted text-sm" style="margin-bottom:10px;font-size:11px">
        <strong>local</strong> = push target ·
        <strong>remote</strong> = caching proxy of an upstream registry ·
        <strong>virtual</strong> = aggregator routing across multiple repos
      </p>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        ${['local', 'remote', 'virtual'].map(t => `
          <label style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid ${t === currentType ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius-sm);cursor:pointer;background:${t === currentType ? 'rgba(56,139,253,0.08)' : 'transparent'};font-size:12px">
            <input type="radio" name="rb-type" value="${t}" ${t === currentType ? 'checked' : ''}>${t}
          </label>
        `).join('')}
      </div>
      <div id="rb-type-fields"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-sm btn-primary" id="rb-type-save"><i class="fas fa-save"></i> Save</button>
        <span id="rb-type-status" class="text-sm" style="align-self:center"></span>
      </div>
    `;
    const renderTypeFields = (type) => {
      const f = document.getElementById('rb-type-fields');
      if (type === 'remote') {
        f.innerHTML = `
          <div class="form-group" style="margin-bottom:8px">
            <label style="font-size:12px">Upstream URL <span class="text-red">*</span></label>
            <input type="text" id="rb-upstream-url" class="form-control form-control-sm" value="${Utils.escapeHtml(upstreamUrl)}" placeholder="https://registry-1.docker.io">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">Upstream username</label>
              <input type="text" id="rb-upstream-user" class="form-control form-control-sm" value="${Utils.escapeHtml(entry?.upstreamUsername || '')}" placeholder="(optional)">
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">Upstream password</label>
              <input type="password" id="rb-upstream-pass" class="form-control form-control-sm" placeholder="(leave blank to keep)" autocomplete="new-password">
            </div>
          </div>
        `;
      } else {
        f.innerHTML = '';
      }
    };
    renderTypeFields(currentType);
    el.querySelectorAll('input[name="rb-type"]').forEach(r =>
      r.addEventListener('change', () => renderTypeFields(r.value))
    );
    document.getElementById('rb-type-save').addEventListener('click', async () => {
      const type = el.querySelector('input[name="rb-type"]:checked')?.value;
      const status = document.getElementById('rb-type-status');
      const body = { repoPath: repo, type };
      if (type === 'remote') {
        body.upstreamUrl = document.getElementById('rb-upstream-url').value.trim();
        body.upstreamUsername = document.getElementById('rb-upstream-user').value.trim() || undefined;
        const pw = document.getElementById('rb-upstream-pass').value;
        if (pw) body.upstreamPassword = pw;
        if (!body.upstreamUrl) { status.innerHTML = `<span style="color:var(--red)">Upstream URL required</span>`; return; }
      }
      status.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving…`;
      try {
        await Api.post(`/registries/${this._selectedId}/repos`, body);
        Toast.success('Repository type saved');
        this._repoEntries = await Api.get(`/registries/${this._selectedId}/repos`);
        this._renderRepoTypeBanner(repo);
        status.innerHTML = `<span style="color:var(--green)"><i class="fas fa-check"></i> Saved</span>`;
      } catch (err) {
        status.innerHTML = `<span style="color:var(--red)">${Utils.escapeHtml(err.message)}</span>`;
      }
    });
  },

  // ─── Retention policies (v8.1.0) ─────────────────────────────────
  async _renderRetentionEditor(repo) {
    const el = document.getElementById('rb-retention-editor');
    if (!el) return;
    el.innerHTML = `<div class="text-muted text-sm" style="padding:8px"><i class="fas fa-spinner fa-spin"></i> Loading retention policy…</div>`;
    let policy = null;
    try {
      const r = await Api.get(`/registries/${this._selectedId}/repos/${encodeURIComponent(repo)}/retention`);
      policy = r && r.exists !== false ? r : null;
    } catch (err) { /* no policy yet */ }
    this._currentRetention = policy;
    const currentRule = policy?.rule || { keepLastN: 10, minTagsToKeep: 3 };
    const enabled = policy?.enabled === true;
    const lastSummary = policy?.lastRunSummary;
    el.innerHTML = `
      <h4 style="margin:0 0 8px;font-size:13px"><i class="fas fa-broom"></i> Retention policy</h4>
      <p class="text-muted text-sm" style="margin-bottom:10px;font-size:11px">
        Rules with 5 safety layers: dry-run by default, min-floor of 3 tags,
        protected patterns (<code>latest, v*, main, master, prod-*, stable</code>),
        200-deletion cap per run, immutable audit trail per delete.
      </p>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-sm" data-tpl="keepLast10"><i class="fas fa-history"></i> Keep last 10</button>
        <button class="btn btn-sm" disabled title="Distribution does not provide an untagged-manifest inventory; this operation is unavailable."><i class="fas fa-clock"></i> Untagged cleanup unavailable</button>
        <button class="btn btn-sm" data-tpl="aggressive"><i class="fas fa-bolt"></i> Keep last 5</button>
        <button class="btn btn-sm" data-tpl="reset"><i class="fas fa-undo"></i> Reset</button>
      </div>
      <textarea id="rb-rule-json" class="form-control mono" rows="6" style="font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.4">${Utils.escapeHtml(JSON.stringify(currentRule, null, 2))}</textarea>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-sm btn-secondary" id="rb-retention-preview"><i class="fas fa-eye"></i> Preview (dry-run)</button>
        <button class="btn btn-sm btn-primary" id="rb-retention-save"><i class="fas fa-save"></i> Save (dry-run)</button>
        ${policy ? `
          <label style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;font-size:12px;align-self:center">
            <input type="checkbox" id="rb-retention-enabled" ${enabled ? 'checked' : ''}>
            <strong>Enable for real (will delete on cron)</strong>
          </label>
          <button class="btn btn-sm btn-danger" id="rb-retention-delete" style="margin-left:auto"><i class="fas fa-trash"></i> Delete policy</button>
        ` : ''}
      </div>
      <div id="rb-retention-status" style="margin-top:10px"></div>
      ${policy ? `
        <div class="text-muted text-sm" style="margin-top:14px;padding:8px;background:var(--bg-dim);border-radius:var(--radius-sm);font-size:11px">
          <strong>State:</strong> ${enabled ? '<span style="color:var(--green)">enabled (will run daily)</span>' : '<span style="color:var(--text-dim)">dry-run only</span>'}
          ${policy.lastRunAt ? ` · <strong>Last run:</strong> ${Utils.escapeHtml(policy.lastRunAt)}` : ''}
          ${lastSummary ? ` · <strong>Last result:</strong> ${lastSummary.deleted || 0} deleted${lastSummary.errors ? `, ${lastSummary.errors} errors` : ''}${lastSummary.cappedAt ? ` (capped at ${lastSummary.cappedAt})` : ''}` : ''}
        </div>
      ` : ''}
    `;
    el.querySelectorAll('[data-tpl]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tpl = btn.dataset.tpl;
        const ta = document.getElementById('rb-rule-json');
        const tpls = {
          keepLast10:  { keepLastN: 10, minTagsToKeep: 3 },
          aggressive:  { keepLastN: 5, protectTagPatterns: ['latest', 'v*', 'main', 'prod-*'], minTagsToKeep: 3 },
          reset:       { keepLastN: 10, minTagsToKeep: 3 },
        };
        ta.value = JSON.stringify(tpls[tpl], null, 2);
      });
    });
    document.getElementById('rb-retention-preview').addEventListener('click', () => this._retentionPreview(repo));
    document.getElementById('rb-retention-save').addEventListener('click', () => this._retentionSave(repo, false));
    document.getElementById('rb-retention-enabled')?.addEventListener('change', (e) => this._retentionSave(repo, e.target.checked));
    document.getElementById('rb-retention-delete')?.addEventListener('click', () => this._retentionDelete(repo));
  },

  _parseRule() {
    const raw = document.getElementById('rb-rule-json').value;
    try { return JSON.parse(raw); }
    catch (err) {
      Toast.error('Rule JSON is invalid: ' + err.message);
      return null;
    }
  },

  async _retentionPreview(repo) {
    const rule = this._parseRule();
    if (!rule) return;
    const status = document.getElementById('rb-retention-status');
    status.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Fetching tags + previewing…`;
    try {
      const plan = await Api.post(`/registries/${this._selectedId}/repos/${encodeURIComponent(repo)}/retention/preview`, { rule });
      this._renderRetentionPreview(plan);
    } catch (err) {
      status.innerHTML = `<span style="color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</span>`;
    }
  },

  _renderRetentionPreview(plan) {
    const status = document.getElementById('rb-retention-status');
    const fmtBytes = (b) => Utils.formatBytes(b || 0);
    const renderRow = (t, willDelete) => `
      <tr>
        <td style="padding:3px 6px"><code class="mono" style="font-size:11px">${Utils.escapeHtml(t.tag || '<untagged>')}</code></td>
        <td style="padding:3px 6px;color:var(--text-dim);font-size:11px">${Utils.escapeHtml((t.digest || '').substring(0, 16))}</td>
        <td style="padding:3px 6px;text-align:right;font-size:11px">${fmtBytes(t.sizeBytes)}</td>
        <td style="padding:3px 6px"><span class="badge" style="background:${willDelete ? 'rgba(248,113,113,0.15)' : 'rgba(46,160,67,0.15)'};color:${willDelete ? 'var(--red)' : 'var(--green)'};padding:2px 6px;border-radius:8px;font-size:10px">${Utils.escapeHtml(t.reason)}</span></td>
      </tr>
    `;
    status.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:12px">
          <i class="fas fa-eye" style="color:var(--accent)"></i>
          Dry-run preview: <span style="color:var(--red)">${plan.toDelete.length} delete</span>
          · <span style="color:var(--green)">${plan.toKeep.length} keep</span>
          · ${fmtBytes(plan.summary.bytes)} reclaimed
          ${plan.summary.cappedAt ? ` · <span style="color:var(--yellow)">capped at ${plan.summary.cappedAt}</span>` : ''}
        </strong>
      </div>
      <details ${plan.toDelete.length > 0 ? 'open' : ''}>
        <summary style="cursor:pointer;font-size:12px;color:var(--red)"><i class="fas fa-trash"></i> Would delete (${plan.toDelete.length})</summary>
        <table class="data-table compact" style="margin-top:6px;width:100%">
          <thead><tr><th style="text-align:left">Tag</th><th style="text-align:left">Digest</th><th style="text-align:right">Size</th><th style="text-align:left">Reason</th></tr></thead>
          <tbody>${plan.toDelete.slice(0, 50).map(t => renderRow(t, true)).join('') || '<tr><td colspan="4" class="text-muted">Nothing matched the rule.</td></tr>'}</tbody>
        </table>
        ${plan.toDelete.length > 50 ? `<div class="text-muted text-sm" style="font-size:10px;margin-top:4px">…+${plan.toDelete.length - 50} more not shown</div>` : ''}
      </details>
      <details>
        <summary style="cursor:pointer;font-size:12px;color:var(--green);margin-top:6px"><i class="fas fa-shield-alt"></i> Would keep (${plan.toKeep.length})</summary>
        <table class="data-table compact" style="margin-top:6px;width:100%">
          <thead><tr><th style="text-align:left">Tag</th><th style="text-align:left">Digest</th><th style="text-align:right">Size</th><th style="text-align:left">Reason</th></tr></thead>
          <tbody>${plan.toKeep.slice(0, 50).map(t => renderRow(t, false)).join('')}</tbody>
        </table>
        ${plan.toKeep.length > 50 ? `<div class="text-muted text-sm" style="font-size:10px;margin-top:4px">…+${plan.toKeep.length - 50} more not shown</div>` : ''}
      </details>
    `;
  },

  async _retentionSave(repo, enable) {
    const rule = this._parseRule();
    if (!rule) return;
    const status = document.getElementById('rb-retention-status');
    status.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving…`;
    try {
      await Api.put(`/registries/${this._selectedId}/repos/${encodeURIComponent(repo)}/retention`,
        { rule, enabled: enable === true });
      Toast.success(`Policy saved${enable ? ' (enabled)' : ' (dry-run only)'}`);
      this._renderRetentionEditor(repo);
    } catch (err) {
      status.innerHTML = `<span style="color:var(--red)">${Utils.escapeHtml(err.message)}</span>`;
    }
  },

  async _retentionDelete(repo) {
    if (!confirm(`Delete the retention policy for ${repo}? This stops scheduled cleanup; existing artifacts are NOT affected.`)) return;
    try {
      await Api.delete(`/registries/${this._selectedId}/repos/${encodeURIComponent(repo)}/retention`);
      Toast.success('Policy deleted');
      this._renderRetentionEditor(repo);
    } catch (err) { Toast.error(err.message); }
  },

  _renderTags(repo) {
    const body = document.getElementById('rb-tags-body');
    if (!this._tags || this._tags.length === 0) {
      body.innerHTML = `<div class="text-muted text-sm" style="text-align:center;padding:14px">No tags found.</div>`;
      return;
    }
    body.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:300px;overflow-y:auto">
        ${this._tags.map(tag => `
          <button class="rb-tag-btn badge" data-tag="${Utils.escapeHtml(tag)}" style="background:var(--surface2);color:var(--text);padding:5px 10px;border:none;border-radius:14px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11px">
            ${Utils.escapeHtml(tag)}
          </button>
        `).join('')}
      </div>
    `;
    body.querySelectorAll('.rb-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => this._inspectManifest(repo, btn.dataset.tag));
    });
  },

  async _inspectManifest(repo, tag) {
    const card = document.getElementById('rb-manifest-card');
    const body = document.getElementById('rb-manifest-body');
    const titleTag = document.getElementById('rb-manifest-tag');
    card.style.display = 'block';
    titleTag.textContent = `${repo}:${tag}`;
    body.innerHTML = `<div class="text-muted text-sm" style="text-align:center;padding:14px"><i class="fas fa-spinner fa-spin"></i> Inspecting…</div>`;
    try {
      const data = await Api.get(`/registries/${this._selectedId}/manifest/${repo}:${tag}`);
      this._renderManifest(data, repo, tag);
    } catch (err) {
      body.innerHTML = `<div class="text-muted text-sm" style="text-align:center;padding:14px;color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderManifest(data, repo, tag) {
    const body = document.getElementById('rb-manifest-body');
    const m = data.manifest || {};
    // Detect format. Multi-arch indexes have "manifests" array; single-arch has "layers".
    const isIndex = Array.isArray(m.manifests);
    const layers = m.layers || [];
    const totalSize = layers.reduce((sum, l) => sum + (l.size || 0), 0);

    body.innerHTML = `
      <table class="info-table" style="width:100%">
        <tr><td>Digest</td><td><code style="font-family:'JetBrains Mono',monospace;font-size:11px">${Utils.escapeHtml(data.digest || 'unknown')}</code></td></tr>
        <tr><td>Content type</td><td><code style="font-family:'JetBrains Mono',monospace;font-size:11px">${Utils.escapeHtml(data.contentType || 'unknown')}</code></td></tr>
        <tr><td>Schema version</td><td>${m.schemaVersion || '?'}</td></tr>
        ${isIndex
          ? `<tr><td>Architectures</td><td>${m.manifests.map(mm => `<span class="badge badge-info" style="margin-right:4px">${Utils.escapeHtml((mm.platform?.os || '?') + '/' + (mm.platform?.architecture || '?'))}</span>`).join('')}</td></tr>`
          : `<tr><td>Layers</td><td>${layers.length} (${Utils.formatBytes(totalSize)} total)</td></tr>`}
      </table>
      ${this._renderProvenance(data.provenance)}
      ${!isIndex && layers.length > 0 ? `
        <details style="margin-top:14px">
          <summary style="cursor:pointer;font-size:13px;color:var(--accent);user-select:none"><i class="fas fa-layer-group"></i> Layer breakdown</summary>
          <div style="margin-top:8px;background:var(--bg-dim);padding:10px;border-radius:var(--radius-sm);max-height:240px;overflow-y:auto;font-family:'JetBrains Mono',monospace;font-size:11px">
            ${layers.map((l, i) => `
              <div style="display:flex;justify-content:space-between;padding:2px 0">
                <span><span class="text-muted">#${i + 1}</span> ${Utils.escapeHtml((l.digest || '').substring(0, 24))}</span>
                <span class="text-muted">${Utils.formatBytes(l.size || 0)}</span>
              </div>
            `).join('')}
          </div>
        </details>
      ` : ''}
      ${isIndex ? `
        <p class="text-sm text-muted" style="margin-top:10px">
          <i class="fas fa-info-circle" style="margin-right:4px"></i>
          This is a multi-architecture image index. Per-arch manifests can be inspected by clicking a digest below.
        </p>
        <div style="margin-top:10px">
          ${m.manifests.map(mm => `
            <div style="padding:6px 10px;background:var(--bg-dim);margin-bottom:4px;border-radius:var(--radius-sm);font-family:'JetBrains Mono',monospace;font-size:11px;display:flex;justify-content:space-between">
              <span>${Utils.escapeHtml((mm.platform?.os || '?') + '/' + (mm.platform?.architecture || '?'))}${mm.platform?.variant ? '/' + Utils.escapeHtml(mm.platform.variant) : ''}</span>
              <span class="text-muted">${Utils.escapeHtml((mm.digest || '').substring(0, 24))} · ${Utils.formatBytes(mm.size || 0)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" id="rb-copy-pull">
          <i class="fas fa-clipboard"></i> Copy pull command
        </button>
        ${window.App?.user?.role === 'admin' ? `
          <button class="btn btn-sm btn-danger" id="rb-delete-tag">
            <i class="fas fa-trash"></i> Delete this tag
          </button>
        ` : ''}
      </div>
    `;
    document.getElementById('rb-copy-pull')?.addEventListener('click', () => {
      const reg = this._registries.find(r => String(r.id) === String(this._selectedId));
      const host = reg ? new URL(reg.url).host : '';
      const cmd = `docker pull ${host}/${repo}:${tag}`;
      navigator.clipboard.writeText(cmd).then(
        () => Toast.success('Pull command copied'),
        () => Toast.error('Copy failed')
      );
    });
    document.getElementById('rb-delete-tag')?.addEventListener('click', () => {
      this._confirmDeleteTag(repo, tag, data.digest);
    });
  },

  // v8.1.0 — Build provenance panel. Reads OCI annotations + cosign signature
  // presence from the manifest. Pure rendering — server already parsed.
  _renderProvenance(p) {
    if (!p || !p.hasProvenance) {
      return `
        <details style="margin-top:14px">
          <summary style="cursor:pointer;font-size:13px;color:var(--text-dim);user-select:none">
            <i class="fas fa-fingerprint"></i> Provenance
          </summary>
          <div style="margin-top:8px;padding:10px;background:var(--bg-dim);border-radius:var(--radius-sm);font-size:12px;color:var(--text-dim)">
            <i class="fas fa-info-circle"></i> No provenance metadata in this manifest.
            <a href="https://docs.docker.com/build/metadata/attestations/slsa-provenance/" target="_blank" rel="noopener" style="color:var(--accent);margin-left:6px">Tutorial: enable buildx provenance</a>
          </div>
        </details>
      `;
    }
    const k = p.known;
    const _row = (label, value) =>
      `<tr><td style="padding:4px 8px;color:var(--text-dim);width:120px;vertical-align:top">${label}</td><td style="padding:4px 8px">${value}</td></tr>`;
    const _fmtDate = (iso) => {
      try { return new Date(iso).toISOString().replace('T', ' ').substring(0, 19) + ' UTC'; }
      catch { return iso; }
    };
    return `
      <details style="margin-top:14px" open>
        <summary style="cursor:pointer;font-size:13px;color:var(--accent);user-select:none;font-weight:600">
          <i class="fas fa-fingerprint"></i> Provenance
        </summary>
        <div style="margin-top:8px">
          <table class="info-table" style="width:100%;font-size:12px">
            ${k.source ? _row('Source', k.sourceLink ? `<a href="${Utils.escapeHtml(k.sourceLink)}" target="_blank" rel="noopener" style="color:var(--accent)">${Utils.escapeHtml(k.source)}</a> <i class="fas fa-external-link-alt" style="font-size:9px;color:var(--text-dim);margin-left:4px"></i>` : Utils.escapeHtml(k.source)) : ''}
            ${k.revision ? _row('Commit', `<code class="mono" title="${Utils.escapeHtml(k.revision)}">${Utils.escapeHtml(k.revisionShort)}</code>${k.created ? ` <span class="text-muted" style="font-size:11px">(${Utils.escapeHtml(_fmtDate(k.created))})</span>` : ''}`) : ''}
            ${k.authors ? _row('Authors', Utils.escapeHtml(k.authors)) : ''}
            ${k.licenses ? _row('License', `<code class="mono" style="font-size:11px">${Utils.escapeHtml(k.licenses)}</code>`) : ''}
            ${k.vendor ? _row('Vendor', Utils.escapeHtml(k.vendor)) : ''}
            ${k.version ? _row('Version', `<code class="mono">${Utils.escapeHtml(k.version)}</code>`) : ''}
            ${k.url ? _row('URL', k.urlLink ? `<a href="${Utils.escapeHtml(k.urlLink)}" target="_blank" rel="noopener" style="color:var(--accent)">${Utils.escapeHtml(k.url)}</a>` : Utils.escapeHtml(k.url)) : ''}
            ${k.documentation ? _row('Docs', k.documentationLink ? `<a href="${Utils.escapeHtml(k.documentationLink)}" target="_blank" rel="noopener" style="color:var(--accent)">${Utils.escapeHtml(k.documentation)}</a>` : Utils.escapeHtml(k.documentation)) : ''}
            ${k.baseName ? _row('Base image', `<code class="mono" style="font-size:11px">${Utils.escapeHtml(k.baseName)}</code>`) : ''}
            ${k.signed ? _row('Signed', `<span style="color:var(--green)"><i class="fas fa-check-circle"></i> Yes${k.signer ? ` <span class="text-muted" style="font-size:11px">(${Utils.escapeHtml(k.signer.substring(0, 60))})</span>` : ''}</span> <span class="text-muted" style="font-size:11px;margin-left:6px">— signature presence detected, not cryptographically verified</span>`) : ''}
          </table>
          ${p.otherCount > 0 ? `
            <details style="margin-top:8px">
              <summary style="cursor:pointer;font-size:11px;color:var(--text-dim)">Show all annotations (${p.totalAnnotations})</summary>
              <pre class="mono" style="margin-top:6px;padding:10px;background:var(--bg);border-radius:var(--radius-sm);font-size:10px;max-height:200px;overflow-y:auto;line-height:1.4">${Utils.escapeHtml(JSON.stringify(Object.fromEntries(Object.entries(p.other).sort()), null, 2))}</pre>
            </details>
          ` : ''}
        </div>
      </details>
    `;
  },

  // v7.6.0 — Delete-tag confirmation. Two-step: type the full repo:tag
  // string to confirm. Tag deletion is by-digest under the hood; the
  // server resolves it. Garbage collection of orphaned blobs is operator
  // responsibility (documented in modal footnote).
  _confirmDeleteTag(repo, tag, digest) {
    const fullRef = `${repo}:${tag}`;
    Modal.open(`
      <div class="modal-header">
        <h3 style="color:var(--red)"><i class="fas fa-exclamation-triangle" style="margin-right:10px"></i> Delete tag</h3>
        <button class="modal-close-btn" id="modal-x"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">
        <p>You are about to permanently delete the tag:</p>
        <div style="background:var(--bg-dim);padding:10px 12px;border-radius:var(--radius-sm);margin:10px 0;font-family:'JetBrains Mono',monospace;font-size:13px">
          <div>${Utils.escapeHtml(fullRef)}</div>
          <div class="text-muted text-sm" style="margin-top:4px;font-size:11px">${Utils.escapeHtml(digest || 'unknown digest')}</div>
        </div>
        <p class="text-sm text-muted">
          Anyone (or any CI job) currently pulling <code>${Utils.escapeHtml(fullRef)}</code> will fail until the tag is re-pushed.
          This action is audited.
        </p>
        <p class="text-sm" style="margin-top:14px">Type <code style="background:var(--bg-dim);padding:2px 6px;border-radius:3px;font-family:'JetBrains Mono',monospace">${Utils.escapeHtml(fullRef)}</code> to confirm:</p>
        <input type="text" id="rb-delete-confirm" class="form-control" autocomplete="off" placeholder="${Utils.escapeHtml(fullRef)}">
        <p class="text-sm text-muted" style="margin-top:14px;font-size:11px">
          <i class="fas fa-info-circle" style="margin-right:4px"></i>
          Manifest is removed immediately. Layer blobs are reclaimed when the operator runs <code>registry garbage-collect</code> on the host (Distribution doesn't auto-GC).
        </p>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-sm" id="rb-delete-cancel">Cancel</button>
        <button class="btn btn-sm btn-danger" id="rb-delete-go" disabled><i class="fas fa-trash"></i> Delete tag</button>
      </div>
    `, { size: 'md' });

    const input = document.getElementById('rb-delete-confirm');
    const goBtn = document.getElementById('rb-delete-go');
    input.addEventListener('input', () => {
      goBtn.disabled = input.value.trim() !== fullRef;
    });
    document.getElementById('rb-delete-cancel').addEventListener('click', () => Modal.close());
    document.getElementById('modal-x').addEventListener('click', () => Modal.close());
    goBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      goBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting…';
      try {
        await Api.delete(`/registries/${this._selectedId}/tag/${fullRef}`);
        Modal.close();
        Toast.success(`Deleted ${fullRef}`);
        // Refresh the tag list — the deleted tag is gone, the manifest panel hides
        await this._selectRepo(repo);
      } catch (err) {
        Toast.error(err.message);
        goBtn.disabled = false;
        goBtn.innerHTML = '<i class="fas fa-trash"></i> Delete tag';
      }
    });
    setTimeout(() => input.focus(), 50);
  },

  destroy() {
    /* nothing to clean up */
  },
};

window.RegistryBrowsePage = RegistryBrowsePage;
