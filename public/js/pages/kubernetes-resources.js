/* ═══════════════════════════════════════════════════
   pages/kubernetes-resources.js — Kubernetes resources
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) UI: minimal read-only tabs
// for namespaces, pods, deployments, services, nodes.
//
// SCOPE DISCIPLINE (per deep-spec-sprint-5-kubernetes.md):
// This is a Docker-first operator's "is my k3s at home OK" view — NOT
// a Lens / Rancher clone. No edit / apply / kubectl-in-browser / helm /
// ingress editing. Ever.
//
// Gated in the sidebar via data-fleet-daemon="kubernetes".

const KubernetesResourcesPage = {
  _tab: 'deployments',
  _namespace: null,   // null == all namespaces
  _namespaces: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1><i class="fas fa-dharmachakra"></i> Kubernetes resources <span class="badge badge-warning">alpha</span></h1>
        <div>
          <select id="k8s-namespace" class="form-control" style="width:auto;display:inline-block">
            <option value="">(all namespaces)</option>
          </select>
          <button class="btn btn-sm btn-secondary" id="k8s-refresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div id="k8s-info-panel"></div>
      <div class="tabs" style="margin-bottom:12px">
        <button class="tab-btn active" data-tab="deployments">Deployments</button>
        <button class="tab-btn" data-tab="pods">Pods</button>
        <button class="tab-btn" data-tab="services">Services</button>
        <button class="tab-btn" data-tab="namespaces">Namespaces</button>
        <button class="tab-btn" data-tab="nodes">Nodes</button>
      </div>
      <div id="k8s-tab-container">Loading...</div>
    `;
    container.querySelector('#k8s-refresh').addEventListener('click', () => this._load());
    container.querySelector('#k8s-namespace').addEventListener('change', (e) => {
      this._namespace = e.target.value || null;
      this._load();
    });
    container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._tab = e.target.getAttribute('data-tab');
        container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === e.target));
        this._load();
      });
    });
    await this._loadNamespaces();
    await this._loadInfo();
    await this._load();
  },

  async _loadNamespaces() {
    try {
      this._namespaces = await Api.getKubernetesNamespaces();
      const sel = document.getElementById('k8s-namespace');
      if (!sel) return;
      const opts = ['<option value="">(all namespaces)</option>'];
      for (const ns of this._namespaces) {
        const name = (ns.metadata && ns.metadata.name) || '';
        const sel2 = name === this._namespace ? ' selected' : '';
        opts.push(`<option value="${Utils.escapeHtml(name)}"${sel2}>${Utils.escapeHtml(name)}</option>`);
      }
      sel.innerHTML = opts.join('');
    } catch { /* namespace fetch is best-effort — leave dropdown empty */ }
  },

  async _loadInfo() {
    const infoEl = document.getElementById('k8s-info-panel');
    if (!infoEl) return;
    try {
      const v = await Api.getKubernetesVersion();
      if (v) {
        infoEl.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
              <div><strong>Version:</strong> ${Utils.escapeHtml(v.gitVersion || v.version || '—')}</div>
              <div><strong>API:</strong> v${Utils.escapeHtml(v.major || '?')}.${Utils.escapeHtml(v.minor || '?')}</div>
              <div><strong>Platform:</strong> ${Utils.escapeHtml(v.platform || '—')}</div>
              <div><strong>Go version:</strong> ${Utils.escapeHtml(v.goVersion || '—')}</div>
            </div>
          </div>
        `;
      }
    } catch (err) {
      infoEl.innerHTML = `<div class="alert alert-danger">Kubernetes connect error: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _load() {
    const el = document.getElementById('k8s-tab-container');
    if (!el) return;
    el.innerHTML = `<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i> Loading ${Utils.escapeHtml(this._tab)}...</div>`;
    try {
      let rows;
      switch (this._tab) {
        case 'deployments':
          rows = await Api.getKubernetesDeployments(this._namespace);
          this._renderDeployments(el, rows);
          break;
        case 'pods':
          rows = await Api.getKubernetesPods(this._namespace);
          this._renderPods(el, rows);
          break;
        case 'services':
          rows = await Api.getKubernetesServices(this._namespace);
          this._renderServices(el, rows);
          break;
        case 'namespaces':
          rows = this._namespaces && this._namespaces.length
            ? this._namespaces
            : await Api.getKubernetesNamespaces();
          this._renderNamespaces(el, rows);
          break;
        case 'nodes':
          rows = await Api.getKubernetesNodes();
          this._renderNodes(el, rows);
          break;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-msg">Error loading ${Utils.escapeHtml(this._tab)}: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  _renderDeployments(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-cube" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px"></i>No Deployments in ${Utils.escapeHtml(this._namespace || 'this cluster')}.</div>`;
      return;
    }
    const rows = list.map(d => {
      const meta = d.metadata || {};
      const spec = d.spec || {};
      const status = d.status || {};
      const image = ((spec.template && spec.template.spec && spec.template.spec.containers) || [])
        .map(c => c.image).join(', ') || '—';
      const ready = `${status.readyReplicas || 0}/${spec.replicas || 0}`;
      const ok = (status.readyReplicas || 0) === (spec.replicas || 0);
      const statusColor = ok ? 'green' : 'yellow';
      return `<tr>
        <td>${Utils.escapeHtml(meta.namespace || '—')}</td>
        <td><strong>${Utils.escapeHtml(meta.name || '—')}</strong></td>
        <td><code style="font-size:11px">${Utils.escapeHtml(image)}</code></td>
        <td style="color:${statusColor}">${Utils.escapeHtml(ready)}</td>
        <td>${Utils.escapeHtml(meta.creationTimestamp ? new Date(meta.creationTimestamp).toLocaleString() : '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Namespace</th><th>Name</th><th>Image</th><th>Ready</th><th>Created</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderPods(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No Pods.</div>`;
      return;
    }
    const rows = list.map(p => {
      const meta = p.metadata || {};
      const spec = p.spec || {};
      const status = p.status || {};
      const phase = status.phase || '—';
      const phaseColor = phase === 'Running' ? 'green' : phase === 'Pending' ? 'yellow' : 'red';
      const restarts = (status.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
      const node = spec.nodeName || '—';
      const containers = (spec.containers || []).map(c => c.name).join(', ');
      return `<tr>
        <td>${Utils.escapeHtml(meta.namespace || '—')}</td>
        <td><strong>${Utils.escapeHtml(meta.name || '—')}</strong></td>
        <td style="color:${phaseColor}">${Utils.escapeHtml(phase)}</td>
        <td>${restarts}</td>
        <td>${Utils.escapeHtml(node)}</td>
        <td><code style="font-size:11px">${Utils.escapeHtml(containers)}</code></td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Namespace</th><th>Name</th><th>Phase</th><th>Restarts</th><th>Node</th><th>Containers</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderServices(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No Services.</div>`;
      return;
    }
    const rows = list.map(s => {
      const meta = s.metadata || {};
      const spec = s.spec || {};
      const type = spec.type || 'ClusterIP';
      const ports = (spec.ports || []).map(p =>
        `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol || 'TCP'}`
      ).join(', ') || '—';
      const clusterIp = spec.clusterIP || '—';
      const externalIp = (spec.externalIPs || []).join(', ')
        || (spec.type === 'LoadBalancer' && s.status && s.status.loadBalancer && (s.status.loadBalancer.ingress || []).map(i => i.ip || i.hostname).join(', '))
        || '—';
      return `<tr>
        <td>${Utils.escapeHtml(meta.namespace || '—')}</td>
        <td><strong>${Utils.escapeHtml(meta.name || '—')}</strong></td>
        <td>${Utils.escapeHtml(type)}</td>
        <td>${Utils.escapeHtml(clusterIp)}</td>
        <td>${Utils.escapeHtml(externalIp)}</td>
        <td><code style="font-size:11px">${Utils.escapeHtml(ports)}</code></td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Namespace</th><th>Name</th><th>Type</th><th>Cluster IP</th><th>External</th><th>Ports</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderNamespaces(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No namespaces.</div>`;
      return;
    }
    const rows = list.map(ns => {
      const meta = ns.metadata || {};
      const status = (ns.status && ns.status.phase) || '—';
      const statusColor = status === 'Active' ? 'green' : 'red';
      return `<tr>
        <td><strong>${Utils.escapeHtml(meta.name || '—')}</strong></td>
        <td style="color:${statusColor}">${Utils.escapeHtml(status)}</td>
        <td>${Utils.escapeHtml(meta.creationTimestamp ? new Date(meta.creationTimestamp).toLocaleString() : '—')}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Status</th><th>Created</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },

  _renderNodes(el, list) {
    if (!list || !list.length) {
      el.innerHTML = `<div class="empty-msg">No nodes.</div>`;
      return;
    }
    const rows = list.map(n => {
      const meta = n.metadata || {};
      const status = n.status || {};
      const conds = status.conditions || [];
      const ready = conds.find(c => c.type === 'Ready');
      const isReady = ready && ready.status === 'True';
      const readyColor = isReady ? 'green' : 'red';
      const readyText = isReady ? 'Ready' : 'NotReady';
      const roles = Object.keys(meta.labels || {})
        .filter(k => k.startsWith('node-role.kubernetes.io/'))
        .map(k => k.replace('node-role.kubernetes.io/', ''))
        .join(', ') || 'worker';
      const ver = (status.nodeInfo && status.nodeInfo.kubeletVersion) || '—';
      const os = (status.nodeInfo && status.nodeInfo.osImage) || '—';
      const cpu = (status.capacity && status.capacity.cpu) || '—';
      const mem = (status.capacity && status.capacity.memory) || '—';
      return `<tr>
        <td><strong>${Utils.escapeHtml(meta.name || '—')}</strong></td>
        <td style="color:${readyColor}">${Utils.escapeHtml(readyText)}</td>
        <td>${Utils.escapeHtml(roles)}</td>
        <td>${Utils.escapeHtml(ver)}</td>
        <td>${Utils.escapeHtml(os)}</td>
        <td>${Utils.escapeHtml(cpu)} CPU / ${Utils.escapeHtml(mem)}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Name</th><th>Status</th><th>Roles</th><th>Kubelet</th><th>OS</th><th>Capacity</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  },
};
