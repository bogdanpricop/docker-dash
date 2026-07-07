/* ═══════════════════════════════════════════════════
   pages/nomad-jobs.js — Nomad jobs / allocations / nodes
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.5-alpha.1 — Sprint 10 (Nomad) UI: minimal read-only tabs for
// jobs, allocations, nodes, deployments. Gated in the sidebar via
// data-fleet-daemon="nomad".

const NomadJobsPage = {
  _tab: 'jobs',
  _namespace: null,
  _namespaces: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-tasks"></i> Nomad workloads <span class="badge badge-warning">alpha</span></h1>
        <div>
          <select id="nomad-namespace" class="form-control" style="width:auto;display:inline-block">
            <option value="">(default)</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="nomad-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div id="nomad-info-panel"></div>
      <div class="tabs" style="margin-bottom:12px">
        <button class="tab active" data-tab="jobs">Jobs</button>
        <button class="tab" data-tab="allocations">Allocations</button>
        <button class="tab" data-tab="deployments">Deployments</button>
        <button class="tab" data-tab="nodes">Nodes</button>
      </div>
      <div id="nomad-tab-container">Loading...</div>
    `;
    container.querySelector('#nomad-refresh').addEventListener('click', () => this._load());
    container.querySelector('#nomad-namespace').addEventListener('change', (e) => {
      this._namespace = e.target.value || null;
      this._load();
    });
    container.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._tab = e.target.getAttribute('data-tab');
        container.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === e.target));
        this._load();
      });
    });
    await this._loadNamespaces();
    await this._loadInfo();
    await this._load();
  },

  async _loadNamespaces() {
    try {
      this._namespaces = await Api.getNomadNamespaces();
      const sel = document.getElementById('nomad-namespace');
      if (!sel) return;
      const opts = ['<option value="">(default)</option>'];
      for (const ns of this._namespaces || []) {
        const name = ns.Name || '';
        if (!name || name === 'default') continue;
        const sel2 = name === this._namespace ? ' selected' : '';
        opts.push(`<option value="${Utils.escapeHtml(name)}"${sel2}>${Utils.escapeHtml(name)}</option>`);
      }
      sel.innerHTML = opts.join('');
    } catch { /* OSS returns no namespaces — dropdown stays 'default' */ }
  },

  async _loadInfo() {
    const infoEl = document.getElementById('nomad-info-panel');
    if (!infoEl) return;
    try {
      const self = await Api.getNomadInfo();
      const member = (self && self.member) || {};
      const tags = member.Tags || {};
      infoEl.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
            <div><strong>Name:</strong> ${Utils.escapeHtml(member.Name || '—')}</div>
            <div><strong>Version:</strong> ${Utils.escapeHtml(tags.build || tags.version || '—')}</div>
            <div><strong>Region:</strong> ${Utils.escapeHtml(tags.region || '—')}</div>
            <div><strong>DC:</strong> ${Utils.escapeHtml(tags.dc || '—')}</div>
          </div>
        </div>
      `;
    } catch (err) {
      infoEl.innerHTML = `<div class="alert alert-danger">Nomad connect error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _load() {
    const el = document.getElementById('nomad-tab-container');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading ${Utils.escapeHtml(this._tab)}...</div>`;
    try {
      let rows;
      switch (this._tab) {
        case 'jobs':
          rows = await Api.getNomadJobs(this._namespace);
          this._renderJobs(el, rows);
          break;
        case 'allocations':
          rows = await Api.getNomadAllocations(this._namespace);
          this._renderAllocations(el, rows);
          break;
        case 'deployments':
          rows = await Api.getNomadDeployments(this._namespace);
          this._renderDeployments(el, rows);
          break;
        case 'nodes':
          rows = await Api.getNomadNodes();
          this._renderNodes(el, rows);
          break;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error loading ${Utils.escapeHtml(this._tab)}: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderJobs(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-tasks" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px"></i>No jobs in ${Utils.escapeHtml(this._namespace || 'default')}.</div>`;
      return;
    }
    const rows = list.map(j => {
      const status = j.Status || '—';
      const statusColor = status === 'running' ? 'green' : status === 'dead' ? 'red' : 'yellow';
      const summary = j.JobSummary && j.JobSummary.Summary || {};
      const totalRunning = Object.values(summary).reduce((s, g) => s + ((g && g.Running) || 0), 0);
      return `<tr>
        <td><strong>${Utils.escapeHtml(j.Name || j.ID || '—')}</strong></td>
        <td>${Utils.escapeHtml(j.Type || '—')}</td>
        <td style="color:${statusColor}">${Utils.escapeHtml(status)}</td>
        <td>${totalRunning}</td>
        <td>${Utils.escapeHtml(j.Priority !== undefined ? String(j.Priority) : '—')}</td>
        <td>${Utils.escapeHtml((j.Datacenters || []).join(', ') || '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Type</th><th>Status</th><th>Running</th><th>Priority</th><th>DCs</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderAllocations(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No allocations.</div>`;
      return;
    }
    const rows = list.slice(0, 500).map(a => {
      const status = a.ClientStatus || '—';
      const statusColor = status === 'running' ? 'green' : status === 'complete' ? 'gray' : status === 'failed' ? 'red' : 'yellow';
      return `<tr>
        <td><code>${Utils.escapeHtml((a.ID || '').slice(0, 8))}</code></td>
        <td>${Utils.escapeHtml(a.JobID || '—')}</td>
        <td>${Utils.escapeHtml(a.TaskGroup || '—')}</td>
        <td style="color:${statusColor}">${Utils.escapeHtml(status)}</td>
        <td>${Utils.escapeHtml(a.DesiredStatus || '—')}</td>
        <td>${Utils.escapeHtml((a.NodeName || a.NodeID || '').slice(0, 12) || '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>ID</th><th>Job</th><th>Task group</th><th>Client status</th><th>Desired</th><th>Node</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderDeployments(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No active deployments.</div>`;
      return;
    }
    const rows = list.map(d => {
      const status = d.Status || '—';
      const statusColor = status === 'successful' ? 'green' : status === 'failed' ? 'red' : 'yellow';
      return `<tr>
        <td><code>${Utils.escapeHtml((d.ID || '').slice(0, 8))}</code></td>
        <td>${Utils.escapeHtml(d.JobID || '—')}</td>
        <td style="color:${statusColor}">${Utils.escapeHtml(status)}</td>
        <td>${Utils.escapeHtml(d.StatusDescription || '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>ID</th><th>Job</th><th>Status</th><th>Description</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderNodes(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No nodes.</div>`;
      return;
    }
    const rows = list.map(n => {
      const ready = n.Status === 'ready';
      const eligible = n.SchedulingEligibility === 'eligible';
      const statusColor = ready ? 'green' : 'red';
      return `<tr>
        <td><strong>${Utils.escapeHtml(n.Name || '—')}</strong></td>
        <td style="color:${statusColor}">${Utils.escapeHtml(n.Status || '—')}</td>
        <td>${Utils.escapeHtml(eligible ? 'eligible' : n.SchedulingEligibility || '—')}</td>
        <td>${Utils.escapeHtml(n.NodeClass || '—')}</td>
        <td>${Utils.escapeHtml(n.Datacenter || '—')}</td>
        <td>${Utils.escapeHtml(n.Version || '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Status</th><th>Scheduling</th><th>Node class</th><th>DC</th><th>Version</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },
};
