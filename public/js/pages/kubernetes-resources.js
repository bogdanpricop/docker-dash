/* ═══════════════════════════════════════════════════
   pages/kubernetes-resources.js — Kubernetes resources
   ═══════════════════════════════════════════════════ */
'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) UI: minimal read-only tabs
// for namespaces, pods, deployments, services, nodes.
//
// SCOPE DISCIPLINE (per deep-spec-sprint-5-kubernetes.md):
// This is a Docker-first operator's "is my k3s at home OK" view — NOT
// a Lens / Rancher clone. The KubeVirt YAML surface is restricted to a
// schema-checked diff and API-server dryRun=All; there is no Apply action,
// kubectl-in-browser, Helm or ingress editor.
//
// Gated in the sidebar via data-fleet-daemon="kubernetes".

const KubernetesResourcesPage = {
  _tab: 'deployments',
  _namespace: null,   // null == all namespaces
  _namespaces: [],
  _virtualizationCapabilities: null,

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
        <button class="tab active" data-tab="deployments">Deployments</button>
        <button class="tab" data-tab="pods">Pods</button>
        <button class="tab" data-tab="services">Services</button>
        <button class="tab" data-tab="namespaces">Namespaces</button>
        <button class="tab" data-tab="nodes">Nodes</button>
        <button class="tab" data-tab="virtualmachines">Virtual machines</button>
        <button class="tab" data-tab="virtualization">Virtualization platform</button>
      </div>
      <div id="k8s-tab-container">Loading...</div>
    `;
    container.querySelector('#k8s-refresh').addEventListener('click', () => this._load());
    container.querySelector('#k8s-namespace').addEventListener('change', (e) => {
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
      try { this._virtualizationCapabilities = await Api.getKubernetesVirtualizationCapabilities(); }
      catch { this._virtualizationCapabilities = null; }
      if (v) {
        infoEl.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
              <div><strong>Version:</strong> ${Utils.escapeHtml(v.gitVersion || v.version || '—')}</div>
              <div><strong>API:</strong> v${Utils.escapeHtml(v.major || '?')}.${Utils.escapeHtml(v.minor || '?')}</div>
              <div><strong>Platform:</strong> ${Utils.escapeHtml(v.platform || '—')}</div>
              <div><strong>Go version:</strong> ${Utils.escapeHtml(v.goVersion || '—')}</div>
              <div><strong>Virtualization:</strong> ${Utils.escapeHtml(this._virtualizationCapabilities?.platform || 'not discovered')}</div>
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
        case 'virtualmachines':
          rows = await Api.getKubernetesVirtualizationInventory(this._namespace);
          this._renderVirtualMachines(el, rows);
          break;
        case 'virtualization': {
          const namespace = this._namespace || 'default';
          const [capabilities, openshift, harvester] = await Promise.all([
            Api.getKubernetesVirtualizationCapabilities(),
            Api.getOpenShiftVirtualizationOverview(namespace),
            Api.getHarvesterOverview(namespace),
          ]);
          this._virtualizationCapabilities = capabilities;
          this._renderVirtualizationPlatform(el, { capabilities, openshift, harvester });
          break;
        }
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
      const ns = Utils.escapeHtml(meta.namespace || '');
      const name = Utils.escapeHtml(meta.name || '');
      return `<tr>
        <td>${ns || '—'}</td>
        <td><strong>${name || '—'}</strong></td>
        <td><code style="font-size:11px">${Utils.escapeHtml(image)}</code></td>
        <td style="color:${statusColor}">${Utils.escapeHtml(ready)}</td>
        <td>${Utils.escapeHtml(meta.creationTimestamp ? new Date(meta.creationTimestamp).toLocaleString() : '—')}</td>
        <td>
          <button class="btn btn-xs btn-secondary" data-k8s-action="scale" data-ns="${ns}" data-name="${name}" title="Scale">
            <i class="fas fa-arrows-alt-v"></i></button>
          <button class="btn btn-xs btn-secondary" data-k8s-action="restart" data-ns="${ns}" data-name="${name}" title="Rollout restart">
            <i class="fas fa-sync"></i></button>
        </td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Namespace</th><th>Name</th><th>Image</th><th>Ready</th><th>Created</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    // v8.9.8-alpha.1 — wire scale/restart buttons (Portainer G04)
    el.querySelectorAll('[data-k8s-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const action = btn.getAttribute('data-k8s-action');
        const ns = btn.getAttribute('data-ns');
        const name = btn.getAttribute('data-name');
        try {
          if (action === 'scale') {
            const replicas = window.prompt(`Scale ${name} to how many replicas?`, '1');
            if (replicas === null) return;
            const n = parseInt(replicas, 10);
            if (!Number.isInteger(n) || n < 0) { Toast.error('Invalid replicas'); return; }
            await Api.scaleKubernetesDeployment(ns, name, n);
            Toast.success(`${name} scaled to ${n}`);
          } else if (action === 'restart') {
            if (!confirm(`Rollout restart ${ns}/${name}?`)) return;
            await Api.restartKubernetesDeployment(ns, name);
            Toast.success(`${name} rollout restart triggered`);
          }
          this._load();
        } catch (err) { Toast.error(err.message); }
      });
    });
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
      const ns = Utils.escapeHtml(meta.namespace || '');
      const name = Utils.escapeHtml(meta.name || '');
      const firstCt = (spec.containers && spec.containers[0] && spec.containers[0].name) || '';
      return `<tr>
        <td>${ns || '—'}</td>
        <td><strong>${name || '—'}</strong></td>
        <td style="color:${phaseColor}">${Utils.escapeHtml(phase)}</td>
        <td>${restarts}</td>
        <td>${Utils.escapeHtml(node)}</td>
        <td><code style="font-size:11px">${Utils.escapeHtml(containers)}</code></td>
        <td>
          <button class="btn btn-xs btn-secondary" data-k8s-pod-action="logs" data-ns="${ns}" data-name="${name}" data-container="${Utils.escapeHtml(firstCt)}" title="Logs">
            <i class="fas fa-file-alt"></i></button>
          <button class="btn btn-xs btn-danger" data-k8s-pod-action="delete" data-ns="${ns}" data-name="${name}" title="Delete pod">
            <i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="table"><thead><tr>
      <th>Namespace</th><th>Name</th><th>Phase</th><th>Restarts</th><th>Node</th><th>Containers</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    // v8.9.8-alpha.1 — wire pod delete + logs (Portainer G04+G05)
    el.querySelectorAll('[data-k8s-pod-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const action = btn.getAttribute('data-k8s-pod-action');
        const ns = btn.getAttribute('data-ns');
        const name = btn.getAttribute('data-name');
        const container = btn.getAttribute('data-container');
        if (action === 'delete') {
          if (!confirm(`Delete pod ${ns}/${name}?\n\n(If it belongs to a Deployment / ReplicaSet, a replacement will be scheduled.)`)) return;
          try {
            await Api.deleteKubernetesPod(ns, name);
            Toast.success(`Pod ${name} deleted`);
            this._load();
          } catch (err) { Toast.error(err.message); }
        } else if (action === 'logs') {
          this._openPodLogsModal(ns, name, container);
        }
      });
    });
  },

  // v8.9.8-alpha.1 — Portainer G05: pod log streaming modal.
  _openPodLogsModal(ns, name, container) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="width:800px;max-width:95vw;height:600px;max-height:90vh;display:flex;flex-direction:column">
        <div class="modal-header">
          <h3><i class="fas fa-file-alt"></i> Pod logs — ${Utils.escapeHtml(ns)}/${Utils.escapeHtml(name)}${container ? ` [${Utils.escapeHtml(container)}]` : ''}</h3>
          <button class="modal-close-btn"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="flex:1;overflow:auto;padding:0">
          <pre id="k8s-log-view" style="margin:0;padding:12px;font-size:12px;background:var(--bg2,#111);color:var(--text,#eee);white-space:pre-wrap;word-wrap:break-word"></pre>
        </div>
        <div class="modal-footer">
          <button class="btn btn-sm btn-secondary" id="k8s-log-clear"><i class="fas fa-eraser"></i> Clear</button>
          <button class="btn btn-sm btn-secondary" id="k8s-log-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const logEl = modal.querySelector('#k8s-log-view');
    // EventSource can't send headers — use hostId query param supported by extractHostId middleware.
    const currentHost = (window.App && App._currentHostId) || 0;
    const esUrl = Api.streamKubernetesPodLogs(ns, name, { container, follow: true, tailLines: 500 })
      + `&hostId=${encodeURIComponent(currentHost)}`;
    const es = new EventSource(esUrl);
    es.onmessage = (evt) => {
      logEl.textContent += evt.data + '\n';
      logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
    };
    es.addEventListener('error', () => { /* SSE will retry — ignore */ });
    const close = () => { es.close(); modal.remove(); };
    modal.querySelector('.modal-close-btn').addEventListener('click', close);
    modal.querySelector('#k8s-log-close').addEventListener('click', close);
    modal.querySelector('#k8s-log-clear').addEventListener('click', () => { logEl.textContent = ''; });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  },

  _renderVirtualMachines(el, inventory) {
    const list = inventory?.virtualMachines || [];
    if (!list.length) {
      const states = inventory?.coverage ? Object.entries(inventory.coverage).map(([key, value]) => `${key}: ${value}`).join(' · ') : 'not discovered';
      el.innerHTML = `<div class="empty-msg"><i class="fas fa-desktop" style="font-size:32px;opacity:0.3;display:block;margin-bottom:8px"></i>No KubeVirt VirtualMachines. <span class="text-muted">${Utils.escapeHtml(states)}</span></div>`;
      return;
    }
    const rows = list.map(item => `<tr><td>${Utils.escapeHtml(item.namespace || '—')}</td>
      <td><strong>${Utils.escapeHtml(item.name || '—')}</strong><div class="mono text-xs">${Utils.escapeHtml(item.uid || 'no uid')}</div></td>
      <td><span class="badge ${item.ready ? 'badge-success' : item.state === 'Stopped' ? 'badge-secondary' : 'badge-warning'}">${Utils.escapeHtml(item.state)}</span><div class="text-xs text-muted">${Utils.escapeHtml(item.runStrategy || '—')}</div></td>
      <td>${Utils.escapeHtml(item.nodeName || '—')}</td><td>${item.interfaces?.map(network => Utils.escapeHtml(network.ipAddress || network.name || '—')).join('<br>') || '—'}</td>
      <td>${item.migrations?.length || 0}<div class="text-xs text-muted">${item.migrations?.[0] ? Utils.escapeHtml(item.migrations[0].phase) : 'none'}</div></td>
      <td><button class="btn btn-xs btn-secondary" data-kubevirt-edit="1" data-ns="${Utils.escapeHtml(item.namespace || '')}" data-name="${Utils.escapeHtml(item.name || '')}" title="Schema-aware YAML diff and server dry-run"><i class="fas fa-code"></i></button></td></tr>`).join('');
    el.innerHTML = `<div class="alert alert-info" style="margin-bottom:12px">VM YAML validation uses the Kubernetes API server with <code>dryRun=All</code>. There is deliberately no Apply action.</div><table class="table"><thead><tr><th>Namespace</th><th>VM</th><th>State</th><th>Node</th><th>IP</th><th>Migrations</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    el.querySelectorAll('[data-kubevirt-edit]').forEach(button => button.addEventListener('click', () =>
      this._openKubeVirtYamlEditor(button.dataset.ns, button.dataset.name)));
  },

  _renderVirtualizationPlatform(el, data) {
    const capabilities = data.capabilities || { capabilities: {} };
    const badge = state => state === 'supported' ? 'badge-success' : state === 'unknown' ? 'badge-warning' : 'badge-secondary';
    const capabilityRows = Object.entries(capabilities.capabilities || {}).map(([key, value]) => `<tr><td>${Utils.escapeHtml(key)}</td><td><span class="badge ${badge(value.state)}">${Utils.escapeHtml(value.state)}</span></td><td>${Utils.escapeHtml(value.preferredVersion || value.reason || '—')}</td><td>${(value.observedCrds || []).map(item => `<code>${Utils.escapeHtml(item)}</code>`).join('<br>') || '—'}</td></tr>`).join('');
    const openshift = data.openshift || {}; const harvester = data.harvester || {};
    el.innerHTML = `<div class="info-grid"><div class="info-item"><div class="info-label">Detected platform</div><div class="info-value">${Utils.escapeHtml(capabilities.platform || 'kubernetes')}</div></div>
      <div class="info-item"><div class="info-label">CRD discovery</div><div class="info-value">${Utils.escapeHtml(capabilities.crdDiscovery?.state || 'unknown')} · ${capabilities.crdDiscovery?.count || 0}</div></div>
      <div class="info-item"><div class="info-label">OpenShift projects</div><div class="info-value">${openshift.projects?.count ?? '—'}</div></div>
      <div class="info-item"><div class="info-label">Harvester images</div><div class="info-value">${harvester.images?.items?.length || 0}</div></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px;margin-top:12px">
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Capability discovery</h3></div><table class="table"><thead><tr><th>Capability</th><th>State</th><th>Version/reason</th><th>CRDs</th></tr></thead><tbody>${capabilityRows || '<tr><td colspan="4">No discovery evidence</td></tr>'}</tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>OpenShift Virtualization</h3></div><table class="table"><thead><tr><th>Evidence</th><th>State</th><th>Detail</th></tr></thead><tbody>
          <tr><td>Routes</td><td>${Utils.escapeHtml(openshift.routes?.state || 'unknown')}</td><td>${openshift.routes?.items?.length || 0} observed</td></tr>
          <tr><td>Operator</td><td>${Utils.escapeHtml(openshift.operators?.state || 'unknown')}</td><td>${openshift.operators?.items?.map(item => `${Utils.escapeHtml(item.displayName || item.name)} · ${Utils.escapeHtml(item.phase)}`).join('<br>') || '—'}</td></tr>
          <tr><td>Namespace RBAC</td><td>${Utils.escapeHtml(openshift.rbac?.state || 'unknown')}</td><td>${openshift.rbac?.rules?.length || 0} relevant rules</td></tr></tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-header"><h3>Harvester / Longhorn</h3></div><table class="table"><thead><tr><th>Evidence</th><th>State</th><th>Items</th></tr></thead><tbody>
          ${[['Images',harvester.images],['Networks',harvester.networks],['Backups',harvester.backups],['Longhorn volumes',harvester.longhornVolumes]].map(([label, item]) => `<tr><td>${label}</td><td>${Utils.escapeHtml(item?.state || 'unknown')}</td><td>${item?.items?.length || 0}</td></tr>`).join('')}</tbody></table></div>
      </div><div class="alert alert-info" style="margin-top:12px">All platform adapters in this view are read-only. Capability and inventory snapshots require an explicit refresh API; discovery never starts a VM, migration, backup or volume action.</div>`;
  },

  async _openKubeVirtYamlEditor(namespace, name) {
    let source;
    try { source = await Api.getKubeVirtVmYaml(namespace, name); }
    catch (error) { Toast.error(error.message); return; }
    let editor;
    const result = await Modal.form(`<p class="text-muted text-sm">Only <code>kubevirt.io/v1 VirtualMachine</code> is accepted. Identity is immutable, status is excluded and inline secret material is blocked.</p><textarea id="kubevirt-yaml-editor" class="form-control mono" rows="24"></textarea>`, {
      title: `KubeVirt dry-run · ${namespace}/${name}`, width: '1050px', confirmText: 'Validate with dryRun=All',
      onMount: content => { editor = YamlEditor.mount(content.querySelector('#kubevirt-yaml-editor'), { value: source.yaml, minHeight: 520 }); },
      onSubmit: async () => {
        const validation = editor.validate(); if (!validation.valid) { Toast.error(validation.errors[0].message); return false; }
        try { return await Api.dryRunKubeVirtVmYaml(namespace, name, editor.getValue()); }
        catch (error) { Toast.error(error.message); return false; }
      },
    });
    try { editor?.destroy(); } catch { /* modal already detached */ }
    if (!result) return;
    const validation = result.validation;
    Modal.open(`<div class="modal-header"><h3>KubeVirt server dry-run · ${Utils.escapeHtml(validation.status)}</h3><button class="modal-close-btn" id="kubevirt-result-close"><i class="fas fa-times"></i></button></div><div class="modal-body"><div class="alert ${validation.status === 'valid' ? 'alert-success' : 'alert-danger'}">Server accepted: ${validation.serverResponse.accepted ? 'yes' : 'no'} · applied: no · validation <span class="mono">${validation.validationHash}</span></div><pre class="code-block" style="max-height:55vh;overflow:auto">${Utils.escapeHtml(validation.diff || '(no diff)')}</pre><pre class="code-block">${Utils.escapeHtml(JSON.stringify(validation.serverResponse, null, 2))}</pre></div>`, { width: '1050px' });
    Modal._content.querySelector('#kubevirt-result-close').addEventListener('click', () => Modal.close());
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
