'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) foundation. Read-only client.
//
// SCOPE OF THIS ALPHA:
// Thin HTTPS client + a handful of read operations on namespaces, pods,
// deployments, services, and nodes. Enough to prove the architecture
// works end-to-end against a k3s / k0s / MicroK8s homelab cluster.
// Write operations (scale, rollout-restart, delete pod) land in the
// next alpha once real-world use verifies the plumbing.
//
// SCOPE DISCIPLINE (per deep-spec-sprint-5-kubernetes.md):
// - We are NOT competing with Lens / Rancher / Portainer. This is a
//   dashboard for a Docker-first operator who happens to run a small
//   k3s at home.
// - Everything below is minimum viable: list + status.
// - Helm, Ingress/RBAC editing, kubectl-in-browser and Secret viewing stay
//   out. The later KubeVirt surface permits only a VirtualMachine YAML
//   schema/diff plus server dryRun=All; it exposes no Apply endpoint.
//
// TRANSPORT
// Bearer-token auth over HTTPS. Kubernetes API server typically at
// port 6443 (k3s, k0s) or 8443 (MicroK8s). CA cert verification is
// preferred; skipTlsVerify=true is available for testing but strongly
// discouraged and callable out in howto.
//
// daemon_config shape (encrypted at rest via enc: prefix):
// {
//   endpoint: 'https://k3s.example.com:6443',
//   token: 'eyJhbG...',                    // ServiceAccount bearer token
//   caCert: '-----BEGIN CERTIFICATE-----...', // optional PEM
//   skipTlsVerify: false,                  // testing only
//   namespace: 'default'                   // default ns filter
// }
//
// TIMEOUT + SIZE CAPS
// 30 s per request. 16 MB response cap (namespace with 500 pods returns
// ~2 MB — 16 MB is comfortable headroom).

const https = require('https');
const log = require('../utils/logger')('kubernetes');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * KubernetesClient — thin wrapper over a single Kubernetes API server.
 *
 * Usage:
 *   const c = new KubernetesClient({
 *     endpoint: 'https://k3s.local:6443', token: '...', caCert: '...',
 *   });
 *   const nss = await c.listNamespaces();
 */
class KubernetesClient {
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('KubernetesClient: config object required');
    }
    if (!config.endpoint) throw new Error('KubernetesClient: config.endpoint required');
    if (!config.token) throw new Error('KubernetesClient: config.token required');
    // v8.9.11-alpha.6 — normalize: prepend https:// if bare hostname.
    if (!/^https?:\/\//i.test(config.endpoint)) {
      config = { ...config, endpoint: 'https://' + config.endpoint };
    }
    this._config = config;
    // Custom Agent with the CA cert loaded if provided; otherwise fall
    // back to system CAs (won't verify a self-signed cluster cert).
    const agentOpts = {
      keepAlive: true,
      rejectUnauthorized: !config.skipTlsVerify,
    };
    if (config.caCert) agentOpts.ca = config.caCert;
    this._agent = new https.Agent(agentOpts);
  }

  /** Which daemon type this client serves. Constant for now — the class is k8s-specific. */
  get daemonType() { return 'kubernetes'; }

  /** Low-level request. Returns parsed JSON or throws. */
  async _request(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = new URL(path, this._config.endpoint);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      method,
      path: url.pathname + url.search,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${this._config.token}`,
      },
      agent: this._agent,
    };
    const bodyBuf = body == null ? null : Buffer.from(opts.rawBody ? String(body) : JSON.stringify(body));
    if (bodyBuf) {
      // v8.9.8-alpha.1 — Kubernetes PATCH requests need a strategic-merge
      // patch content type; callers can override via opts.contentType.
      reqOpts.headers['Content-Type'] = opts.contentType
        || (method === 'PATCH' ? 'application/strategic-merge-patch+json' : 'application/json');
      reqOpts.headers['Content-Length'] = bodyBuf.length;
    }
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks = [];
      let settled = false;
      const finish = (result, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { req.destroy(); } catch { /* ignore */ }
        finish(null, new Error(`Kubernetes request timeout after ${timeoutMs / 1000}s: ${method} ${path}`));
      }, timeoutMs);
      const req = https.request(reqOpts, (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            try { req.destroy(); } catch { /* ignore */ }
            finish(null, new Error(`Kubernetes response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; }
          catch (e) {
            return finish(null, new Error(`Kubernetes response not JSON (status ${res.statusCode}): ${e.message}`));
          }
          if (res.statusCode >= 400) {
            const msg = (parsed && (parsed.message || parsed.reason)) || `HTTP ${res.statusCode}`;
            return finish(null, Object.assign(new Error(`Kubernetes API error: ${msg}`), {
              status: res.statusCode, kubernetesResponse: parsed,
            }));
          }
          finish(parsed);
        });
      });
      req.on('error', (err) => finish(null, err));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  // ─── Health / version ───────────────────────────────────

  /**
   * GET /version — apiserver version + build info. Used for the
   * connectivity pill on the frontend "connected/not connected" badge.
   */
  async version() { return this._request('GET', '/version'); }

  // ─── v8.62.0 — KubeVirt / OpenShift Virtualization / Harvester ───

  async _probe(method, path, body, opts) {
    try { return { state: 'supported', value: await this._request(method, path, body, opts) }; }
    catch (error) {
      if (error.status === 403) return { state: 'unknown', reason: 'forbidden', status: 403 };
      if (error.status === 404) return { state: 'unsupported', reason: 'not_found', status: 404 };
      return { state: 'unknown', reason: 'request_failed', status: error.status || null,
        message: String(error.message || 'request failed').slice(0, 300) };
    }
  }

  async discoverVirtualizationCapabilities() {
    const groupsResponse = await this._request('GET', '/apis');
    const groups = new Map(((groupsResponse && groupsResponse.groups) || []).map(group => [group.name, group]));
    const crdProbe = await this._probe('GET', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500');
    const crdNames = new Set(((crdProbe.value && crdProbe.value.items) || [])
      .map(item => item.metadata && item.metadata.name).filter(Boolean));
    const capability = (group, crds = []) => {
      const apiGroup = groups.get(group); const observedCrds = crds.filter(name => crdNames.has(name));
      if (apiGroup || observedCrds.length) return { state: 'supported', group,
        preferredVersion: apiGroup?.preferredVersion?.groupVersion || null, observedCrds };
      if (crdProbe.state === 'unknown') return { state: 'unknown', group, reason: 'crd_discovery_forbidden', observedCrds: [] };
      return { state: 'unsupported', group, reason: 'api_group_absent', observedCrds: [] };
    };
    const capabilities = {
      virtualMachines: capability('kubevirt.io', ['virtualmachines.kubevirt.io', 'virtualmachineinstances.kubevirt.io']),
      dataVolumes: capability('cdi.kubevirt.io', ['datavolumes.cdi.kubevirt.io']),
      migrations: capability('kubevirt.io', ['virtualmachineinstancemigrations.kubevirt.io']),
      snapshots: capability('snapshot.kubevirt.io', ['virtualmachinesnapshots.snapshot.kubevirt.io']),
      consoles: capability('subresources.kubevirt.io', ['virtualmachineinstances.kubevirt.io']),
      openshiftRoutes: capability('route.openshift.io', ['routes.route.openshift.io']),
      openshiftProjects: capability('project.openshift.io', ['projects.project.openshift.io']),
      operatorLifecycle: capability('operators.coreos.com', ['clusterserviceversions.operators.coreos.com']),
      harvester: capability('harvesterhci.io', ['virtualmachineimages.harvesterhci.io', 'virtualmachinebackups.harvesterhci.io']),
      longhorn: capability('longhorn.io', ['volumes.longhorn.io']),
      networkAttachments: capability('k8s.cni.cncf.io', ['network-attachment-definitions.k8s.cni.cncf.io']),
    };
    const platform = capabilities.harvester.state === 'supported' ? 'harvester'
      : capabilities.openshiftRoutes.state === 'supported' ? 'openshift-virtualization'
        : capabilities.virtualMachines.state === 'supported' ? 'kubevirt' : 'kubernetes';
    return { platform, capabilities, apiGroupsObserved: [...groups.keys()].sort(),
      crdDiscovery: { state: crdProbe.state, count: crdNames.size, reason: crdProbe.reason || null },
      observedAt: new Date().toISOString(), providerMutationsStarted: 0 };
  }

  async _listCustom(groupVersion, plural, namespace) {
    const path = namespace
      ? `/apis/${groupVersion}/namespaces/${encodeURIComponent(namespace)}/${plural}`
      : `/apis/${groupVersion}/${plural}`;
    const response = await this._request('GET', path);
    return (response && response.items) || [];
  }

  async listKubeVirtVirtualMachines(namespace) {
    return this._listCustom('kubevirt.io/v1', 'virtualmachines', namespace);
  }

  async listKubeVirtVirtualMachineInstances(namespace) {
    return this._listCustom('kubevirt.io/v1', 'virtualmachineinstances', namespace);
  }

  async listKubeVirtMigrations(namespace) {
    return this._listCustom('kubevirt.io/v1', 'virtualmachineinstancemigrations', namespace);
  }

  async kubeVirtInventory(namespace) {
    const [vmProbe, vmiProbe, migrationProbe] = await Promise.all([
      this._probe('GET', namespace
        ? `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines`
        : '/apis/kubevirt.io/v1/virtualmachines'),
      this._probe('GET', namespace
        ? `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstances`
        : '/apis/kubevirt.io/v1/virtualmachineinstances'),
      this._probe('GET', namespace
        ? `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstancemigrations`
        : '/apis/kubevirt.io/v1/virtualmachineinstancemigrations'),
    ]);
    const vms = (vmProbe.value?.items || []); const vmis = (vmiProbe.value?.items || []);
    const migrations = (migrationProbe.value?.items || []);
    const vmiByKey = new Map(vmis.map(item => [`${item.metadata?.namespace}/${item.metadata?.name}`, item]));
    const migrationsByVmi = new Map();
    for (const migration of migrations) {
      const ns = migration.metadata?.namespace || ''; const name = migration.spec?.vmiName || '';
      const key = `${ns}/${name}`; if (!migrationsByVmi.has(key)) migrationsByVmi.set(key, []);
      migrationsByVmi.get(key).push({ uid: migration.metadata?.uid || null, name: migration.metadata?.name || null,
        phase: migration.status?.phase || 'Unknown', sourceNode: migration.status?.migrationState?.sourceNode || null,
        targetNode: migration.status?.migrationState?.targetNode || null,
        startedAt: migration.status?.migrationState?.startTimestamp || null,
        completedAt: migration.status?.migrationState?.endTimestamp || null });
    }
    const normalized = vms.map(vm => {
      const metadata = vm.metadata || {}; const key = `${metadata.namespace || ''}/${metadata.name || ''}`;
      const vmi = vmiByKey.get(key); const printable = vm.status?.printableStatus || null;
      const ready = (vm.status?.conditions || []).find(condition => condition.type === 'Ready');
      return { uid: metadata.uid || null, namespace: metadata.namespace || null, name: metadata.name || null,
        resourceVersion: metadata.resourceVersion || null, createdAt: metadata.creationTimestamp || null,
        desiredRunning: vm.spec?.runStrategy ? vm.spec.runStrategy !== 'Halted' : !!vm.spec?.running,
        runStrategy: vm.spec?.runStrategy || (vm.spec?.running ? 'Always' : 'Halted'),
        state: printable || vmi?.status?.phase || (vmi ? 'Unknown' : 'Stopped'), ready: ready?.status === 'True',
        nodeName: vmi?.status?.nodeName || null, guestOsInfo: vmi?.status?.guestOSInfo || null,
        interfaces: (vmi?.status?.interfaces || []).map(item => ({ name: item.name || null,
          ipAddress: item.ipAddress || null, mac: item.mac || null })), migrations: migrationsByVmi.get(key) || [] };
    });
    return { namespace: namespace || null, virtualMachines: normalized,
      orphanInstances: vmis.filter(item => !vms.some(vm => vm.metadata?.namespace === item.metadata?.namespace
        && vm.metadata?.name === item.metadata?.name)).map(item => ({ uid: item.metadata?.uid || null,
        namespace: item.metadata?.namespace || null, name: item.metadata?.name || null,
        phase: item.status?.phase || 'Unknown', nodeName: item.status?.nodeName || null })),
      migrations: migrations.map(item => ({ uid: item.metadata?.uid || null, namespace: item.metadata?.namespace || null,
        name: item.metadata?.name || null, vmiName: item.spec?.vmiName || null, phase: item.status?.phase || 'Unknown' })),
      coverage: { virtualMachines: vmProbe.state, instances: vmiProbe.state, migrations: migrationProbe.state },
      providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async reviewNamespaceAccess(namespace = 'default') {
    const probe = await this._probe('POST', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', {
      apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace },
    });
    if (probe.state !== 'supported') return { state: probe.state, reason: probe.reason || 'unavailable', namespace };
    const rules = probe.value?.status?.resourceRules || [];
    const relevant = rules.filter(rule => (rule.apiGroups || []).some(group => ['kubevirt.io', 'cdi.kubevirt.io',
      'route.openshift.io', 'project.openshift.io', 'harvesterhci.io', 'longhorn.io'].includes(group)));
    return { state: probe.value?.status?.incomplete ? 'unknown' : 'supported', namespace,
      incomplete: !!probe.value?.status?.incomplete, evaluationError: probe.value?.status?.evaluationError || null,
      rules: relevant.map(rule => ({ apiGroups: rule.apiGroups || [], resources: rule.resources || [], verbs: rule.verbs || [] })) };
  }

  async openShiftVirtualizationOverview(namespace = 'default') {
    const ns = encodeURIComponent(namespace);
    const [discovery, projects, routes, operators, rbac] = await Promise.all([
      this.discoverVirtualizationCapabilities(), this._probe('GET', '/apis/project.openshift.io/v1/projects'),
      this._probe('GET', `/apis/route.openshift.io/v1/namespaces/${ns}/routes`),
      this._probe('GET', '/apis/operators.coreos.com/v1alpha1/clusterserviceversions'),
      this.reviewNamespaceAccess(namespace),
    ]);
    const operatorItems = (operators.value?.items || []).filter(item => /kubevirt|virtualization|hyperconverged|cnv/i
      .test(`${item.metadata?.name || ''} ${item.spec?.displayName || ''}`));
    return { platform: discovery.platform, namespace, projects: { state: projects.state,
      count: projects.value?.items?.length ?? null }, routes: { state: routes.state,
      items: (routes.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        host: item.spec?.host || null, admitted: (item.status?.ingress || []).some(ingress =>
          (ingress.conditions || []).some(condition => condition.type === 'Admitted' && condition.status === 'True')) })) },
    operators: { state: operators.state, items: operatorItems.map(item => ({ name: item.metadata?.name || null,
      displayName: item.spec?.displayName || null, phase: item.status?.phase || 'Unknown',
      conditions: (item.status?.conditions || []).map(condition => ({ phase: condition.phase || null,
        reason: condition.reason || null, message: condition.message || null })) })) },
    rbac, capabilities: discovery.capabilities, providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async harvesterOverview(namespace = 'default') {
    const ns = encodeURIComponent(namespace);
    const [discovery, images, networks, backups, longhornVolumes] = await Promise.all([
      this.discoverVirtualizationCapabilities(),
      this._probe('GET', `/apis/harvesterhci.io/v1beta1/namespaces/${ns}/virtualmachineimages`),
      this._probe('GET', `/apis/k8s.cni.cncf.io/v1/namespaces/${ns}/network-attachment-definitions`),
      this._probe('GET', `/apis/harvesterhci.io/v1beta1/namespaces/${ns}/virtualmachinebackups`),
      this._probe('GET', '/apis/longhorn.io/v1beta2/volumes'),
    ]);
    const summarize = (probe, mapper) => ({ state: probe.state, reason: probe.reason || null,
      items: (probe.value?.items || []).map(mapper) });
    return { platform: discovery.platform, namespace,
      images: summarize(images, item => ({ name: item.metadata?.name || null, displayName: item.spec?.displayName || null,
        url: item.spec?.url || null, progress: item.status?.progress ?? null, state: item.status?.storageClassName ? 'ready' : 'pending' })),
      networks: summarize(networks, item => ({ name: item.metadata?.name || null,
        type: item.spec?.config ? 'cni' : 'unknown', annotations: item.metadata?.annotations || {} })),
      backups: summarize(backups, item => ({ name: item.metadata?.name || null,
        vmName: item.spec?.source?.name || null, state: item.status?.readyToUse ? 'ready' : 'pending',
        createdAt: item.metadata?.creationTimestamp || null })),
      longhornVolumes: summarize(longhornVolumes, item => ({ name: item.metadata?.name || null,
        state: item.status?.state || 'unknown', robustness: item.status?.robustness || 'unknown',
        size: item.spec?.size || null, nodeId: item.status?.currentNodeID || null })),
      capabilities: discovery.capabilities, providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async getKubeVirtVirtualMachine(namespace, name) {
    return this._request('GET', `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines/${encodeURIComponent(name)}`);
  }

  async dryRunKubeVirtVirtualMachine(namespace, name, yamlText) {
    const query = '?dryRun=All&fieldManager=docker-dash&force=false';
    return this._request('PATCH', `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines/${encodeURIComponent(name)}${query}`,
      yamlText, { rawBody: true, contentType: 'application/apply-patch+yaml' });
  }

  // ─── v8.63.0 — CDI, templates, storage and network convergence ───

  async dataVolumeInventory(namespace) {
    const path = namespace
      ? `/apis/cdi.kubevirt.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/datavolumes`
      : '/apis/cdi.kubevirt.io/v1beta1/datavolumes';
    const probe = await this._probe('GET', path);
    const sourceKind = source => ['http', 'registry', 'pvc', 'upload', 'blank', 'snapshot', 'imageio', 'vddk']
      .find(key => source && source[key] != null) || 'unknown';
    const safeUrl = value => {
      try { const url = new URL(String(value || '')); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return null; }
    };
    const safeSource = source => {
      const kind = sourceKind(source); const value = source?.[kind] || {};
      if (['http', 'registry', 'imageio', 'vddk'].includes(kind)) return { [kind]: {
        url: safeUrl(value.url), secretRef: value.secretRef || value.secretName || null } };
      if (['pvc', 'snapshot'].includes(kind)) return { [kind]: {
        namespace: value.namespace || null, name: value.name || null } };
      return { [kind]: {} };
    };
    const safeMessage = value => String(value || '').replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
      .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]').slice(0, 1000) || null;
    return { namespace: namespace || null, state: probe.state, reason: probe.reason || null,
      items: (probe.value?.items || []).map(item => ({
        uid: item.metadata?.uid || null, namespace: item.metadata?.namespace || null,
        name: item.metadata?.name || null, sourceKind: sourceKind(item.spec?.source),
        source: safeSource(item.spec?.source), storage: item.spec?.storage || item.spec?.pvc || {},
        phase: item.status?.phase || 'Unknown', progress: item.status?.progress || null,
        restartCount: item.status?.restartCount || 0,
        conditions: (item.status?.conditions || []).map(condition => ({ type: condition.type || null,
          status: condition.status || null, reason: condition.reason || null, message: safeMessage(condition.message) })),
        createdAt: item.metadata?.creationTimestamp || null,
      })), providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async dryRunCreateDataVolume(namespace, manifest) {
    return this._request('POST', `/apis/cdi.kubevirt.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/datavolumes?dryRun=All`, manifest);
  }

  async createDataVolume(namespace, manifest) {
    return this._request('POST', `/apis/cdi.kubevirt.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/datavolumes`, manifest);
  }

  async getDataVolume(namespace, name) {
    return this._request('GET', `/apis/cdi.kubevirt.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/datavolumes/${encodeURIComponent(name)}`);
  }

  async virtualizationTemplateInventory(namespace) {
    const ns = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
    const [templates, clusterTypes, types, clusterPreferences, preferences] = await Promise.all([
      this._probe('GET', `/apis/template.openshift.io/v1${ns}/templates`),
      this._probe('GET', '/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterinstancetypes'),
      this._probe('GET', `/apis/instancetype.kubevirt.io/v1beta1${ns}/virtualmachineinstancetypes`),
      this._probe('GET', '/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterpreferences'),
      this._probe('GET', `/apis/instancetype.kubevirt.io/v1beta1${ns}/virtualmachinepreferences`),
    ]);
    const summarize = (probe, scope) => ({ state: probe.state, reason: probe.reason || null,
      items: (probe.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        namespace: item.metadata?.namespace || null, scope, description: item.metadata?.annotations?.description || null,
        labels: item.metadata?.labels || {}, spec: item.spec || {},
        parameters: (item.parameters || []).map(parameter => ({ name: parameter.name || null,
          displayName: parameter.displayName || null, description: parameter.description || null,
          required: parameter.required === true, hasDefault: parameter.value != null,
          generated: !!parameter.generate })),
        objectKinds: (item.objects || []).map(object => `${object.apiVersion || '?'}/${object.kind || '?'}`) })) });
    return { namespace: namespace || null, templates: summarize(templates, namespace ? 'namespace' : 'cluster'),
      instancetypes: { cluster: summarize(clusterTypes, 'cluster'), namespaced: summarize(types, 'namespace') },
      preferences: { cluster: summarize(clusterPreferences, 'cluster'), namespaced: summarize(preferences, 'namespace') },
      providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async getVirtualizationTemplate(namespace, name) {
    return this._request('GET', `/apis/template.openshift.io/v1/namespaces/${encodeURIComponent(namespace)}/templates/${encodeURIComponent(name)}`);
  }

  async dryRunCreateKubeVirtVirtualMachine(namespace, manifest) {
    return this._request('POST', `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines?dryRun=All`, manifest);
  }

  async createKubeVirtVirtualMachine(namespace, manifest) {
    return this._request('POST', `/apis/kubevirt.io/v1/namespaces/${encodeURIComponent(namespace)}/virtualmachines`, manifest);
  }

  async virtualizationCreationPrerequisites(input = {}) {
    const namespace = encodeURIComponent(input.namespace || 'default');
    const checks = [{ kind: 'namespace', name: input.namespace,
      probe: await this._probe('GET', `/api/v1/namespaces/${namespace}`) }];
    for (const storageClass of [...new Set(input.storageClassNames || [])]) {
      checks.push({ kind: 'storageClass', name: storageClass,
        probe: await this._probe('GET', `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(storageClass)}`) });
    }
    for (const pvc of input.pvcSources || []) {
      const sourceNamespace = encodeURIComponent(pvc.namespace || input.namespace);
      checks.push({ kind: 'persistentVolumeClaim', name: `${pvc.namespace || input.namespace}/${pvc.name}`,
        probe: await this._probe('GET', `/api/v1/namespaces/${sourceNamespace}/persistentvolumeclaims/${encodeURIComponent(pvc.name)}`) });
    }
    for (const attachment of [...new Set(input.networkAttachments || [])]) {
      const parts = attachment.split('/'); const attachmentNamespace = parts.length === 2 ? parts[0] : input.namespace;
      const name = parts.length === 2 ? parts[1] : parts[0];
      checks.push({ kind: 'networkAttachmentDefinition', name: `${attachmentNamespace}/${name}`,
        probe: await this._probe('GET', `/apis/k8s.cni.cncf.io/v1/namespaces/${encodeURIComponent(attachmentNamespace)}/network-attachment-definitions/${encodeURIComponent(name)}`) });
    }
    return { checks: checks.map(check => ({ kind: check.kind, name: check.name,
      state: check.probe.state, reason: check.probe.reason || null,
      uid: check.probe.value?.metadata?.uid || null,
      resourceVersion: check.probe.value?.metadata?.resourceVersion || null })),
    valid: checks.every(check => check.probe.state === 'supported'), providerMutationsStarted: 0 };
  }

  async migrationConfiguration() {
    const probe = await this._probe('GET', '/apis/kubevirt.io/v1/kubevirts');
    return { state: probe.state, reason: probe.reason || null,
      items: (probe.value?.items || []).map(item => ({ namespace: item.metadata?.namespace || null,
        name: item.metadata?.name || null, migrationConfiguration: item.spec?.configuration?.migrationConfiguration || {},
        observedGeneration: item.status?.observedGeneration || null })), providerMutationsStarted: 0,
      observedAt: new Date().toISOString() };
  }

  async nodeDrainVirtualMachineAwareness() {
    const [nodes, vms, vmis] = await Promise.all([
      this._probe('GET', '/api/v1/nodes'), this._probe('GET', '/apis/kubevirt.io/v1/virtualmachines'),
      this._probe('GET', '/apis/kubevirt.io/v1/virtualmachineinstances'),
    ]);
    const vmByKey = new Map((vms.value?.items || []).map(vm =>
      [`${vm.metadata?.namespace}/${vm.metadata?.name}`, vm]));
    const items = (nodes.value?.items || []).map(node => {
      const name = node.metadata?.name || null;
      const guests = (vmis.value?.items || []).filter(vmi => vmi.status?.nodeName === name).map(vmi => {
        const key = `${vmi.metadata?.namespace}/${vmi.metadata?.name}`; const vm = vmByKey.get(key);
        const migratable = (vmi.status?.conditions || []).find(condition => condition.type === 'LiveMigratable');
        const strategy = vmi.spec?.evictionStrategy || vm?.spec?.template?.spec?.evictionStrategy || 'None';
        const blockers = [];
        if (migratable?.status !== 'True') blockers.push(migratable?.message || migratable?.reason || 'VMI is not LiveMigratable');
        if (!['LiveMigrate', 'LiveMigrateIfPossible'].includes(strategy)) blockers.push(`evictionStrategy=${strategy}`);
        return { namespace: vmi.metadata?.namespace || null, name: vmi.metadata?.name || null,
          evictionStrategy: strategy, liveMigratable: migratable?.status === 'True', blockers };
      });
      const evidenceComplete = vms.state === 'supported' && vmis.state === 'supported';
      return { name, unschedulable: !!node.spec?.unschedulable, ready: (node.status?.conditions || [])
        .some(condition => condition.type === 'Ready' && condition.status === 'True'), virtualMachines: guests,
      drainReady: evidenceComplete ? guests.every(vm => vm.blockers.length === 0) : null,
      evidenceComplete, blockerCount: guests.reduce((sum, vm) => sum + vm.blockers.length, 0) };
    });
    return { coverage: { nodes: nodes.state, virtualMachines: vms.state, instances: vmis.state }, items,
      providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async csiSnapshotCapabilityMap() {
    const [classes, drivers, storageClasses] = await Promise.all([
      this._probe('GET', '/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses'),
      this._probe('GET', '/apis/storage.k8s.io/v1/csidrivers'),
      this._probe('GET', '/apis/storage.k8s.io/v1/storageclasses'),
    ]);
    const driverMap = new Map((drivers.value?.items || []).map(item => [item.metadata?.name, item]));
    return { state: classes.state, reason: classes.reason || null,
      snapshotClasses: (classes.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        driver: item.driver || null, deletionPolicy: item.deletionPolicy || null,
        isDefault: item.metadata?.annotations?.['snapshot.storage.kubernetes.io/is-default-class'] === 'true',
        apiDriverKnown: driverMap.has(item.driver) })),
      csiDrivers: (drivers.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        attachRequired: item.spec?.attachRequired ?? null, podInfoOnMount: item.spec?.podInfoOnMount ?? null,
        storageCapacity: item.spec?.storageCapacity ?? null, volumeLifecycleModes: item.spec?.volumeLifecycleModes || [] })),
      storageClasses: (storageClasses.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        provisioner: item.provisioner || null, reclaimPolicy: item.reclaimPolicy || null,
        volumeBindingMode: item.volumeBindingMode || null,
        snapshotClasses: (classes.value?.items || []).filter(cls => cls.driver === item.provisioner).map(cls => cls.metadata?.name) })),
      quiesceSupport: 'workload-agent-dependent', restoreSupport: classes.state === 'supported' ? 'csi-snapshot-api' : classes.state,
      coverage: { snapshotClasses: classes.state, csiDrivers: drivers.state, storageClasses: storageClasses.state },
      providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async multusNetworkInventory(namespace) {
    const ns = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
    const [nads, vms] = await Promise.all([
      this._probe('GET', `/apis/k8s.cni.cncf.io/v1${ns}/network-attachment-definitions`),
      this._probe('GET', `/apis/kubevirt.io/v1${ns}/virtualmachines`),
    ]);
    const networks = (nads.value?.items || []).map(item => {
      let config = {}; let parseError = null;
      try { config = item.spec?.config ? JSON.parse(item.spec.config) : {}; } catch (error) { parseError = error.message; }
      return { namespace: item.metadata?.namespace || null, name: item.metadata?.name || null,
        cniVersion: config.cniVersion || null, pluginType: config.type || null, bridge: config.bridge || null,
        vlan: config.vlan ?? null, ipam: config.ipam ? { type: config.ipam.type || null,
          subnet: config.ipam.subnet || config.ipam.range || null, rangeStart: config.ipam.range_start || null,
          rangeEnd: config.ipam.range_end || null, gateway: config.ipam.gateway || null,
          routeCount: Array.isArray(config.ipam.routes) ? config.ipam.routes.length : 0 } : null,
        configValid: !parseError, parseError };
    });
    const attachments = (vms.value?.items || []).flatMap(vm => {
      const interfaces = vm.spec?.template?.spec?.domain?.devices?.interfaces || [];
      return (vm.spec?.template?.spec?.networks || []).filter(network => network.multus).map(network => ({
        vmNamespace: vm.metadata?.namespace || null, vmName: vm.metadata?.name || null, networkName: network.name || null,
        attachment: network.multus?.networkName || null, default: !!network.multus?.default,
        interface: interfaces.find(item => item.name === network.name) || null,
      }));
    });
    return { namespace: namespace || null, state: nads.state, reason: nads.reason || null, networks, attachments,
      coverage: { networkAttachmentDefinitions: nads.state, virtualMachines: vms.state }, providerMutationsStarted: 0,
      observedAt: new Date().toISOString() };
  }

  async nmStateNetworkIntent() {
    const [policies, states] = await Promise.all([
      this._probe('GET', '/apis/nmstate.io/v1beta1/nodenetworkconfigurationpolicies'),
      this._probe('GET', '/apis/nmstate.io/v1beta1/nodenetworkstates'),
    ]);
    return { policies: { state: policies.state, reason: policies.reason || null,
      items: (policies.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        nodeSelector: item.spec?.nodeSelector || {}, desiredState: {
          interfaces: (item.spec?.desiredState?.interfaces || []).map(iface => ({ name: iface.name || null,
            type: iface.type || null, state: iface.state || null, mtu: iface.mtu || null })),
          routeCount: item.spec?.desiredState?.routes?.config?.length || 0,
          dnsServerCount: item.spec?.desiredState?.dnsResolver?.config?.server?.length || 0 },
        conditions: (item.status?.conditions || []).map(condition => ({ type: condition.type || null,
          status: condition.status || null, reason: condition.reason || null, message: condition.message || null })),
        enactments: item.status?.lastUnavailableNodeCount ?? null })) },
    nodeStates: { state: states.state, reason: states.reason || null,
      items: (states.value?.items || []).map(item => ({ name: item.metadata?.name || null,
        interfaces: (item.status?.currentState?.interfaces || []).map(iface => ({ name: iface.name || null,
          type: iface.type || null, state: iface.state || null, mtu: iface.mtu || null, ipv4: iface.ipv4 || null })) })) },
    providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  async virtualMachineExposure(namespace) {
    const ns = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : '';
    const [vms, services, routes, ingresses] = await Promise.all([
      this._probe('GET', `/apis/kubevirt.io/v1${ns}/virtualmachines`),
      this._probe('GET', namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/services` : '/api/v1/services'),
      this._probe('GET', `/apis/route.openshift.io/v1${ns}/routes`),
      this._probe('GET', `/apis/networking.k8s.io/v1${ns}/ingresses`),
    ]);
    const serviceItems = services.value?.items || []; const routeItems = routes.value?.items || [];
    const ingressItems = ingresses.value?.items || [];
    const entries = (vms.value?.items || []).map(vm => {
      const namespaceValue = vm.metadata?.namespace || null; const name = vm.metadata?.name || null;
      const labels = { ...(vm.metadata?.labels || {}), 'kubevirt.io/domain': name, 'vm.kubevirt.io/name': name };
      const selected = serviceItems.filter(service => {
        const selectors = Object.entries(service.spec?.selector || {});
        return service.metadata?.namespace === namespaceValue && selectors.length > 0
          && selectors.every(([key, value]) => labels[key] === value);
      });
      return { namespace: namespaceValue, vmName: name, services: selected.map(service => {
        const serviceName = service.metadata?.name || null;
        return { name: serviceName, type: service.spec?.type || 'ClusterIP', clusterIP: service.spec?.clusterIP || null,
          externalIPs: service.spec?.externalIPs || [], ports: service.spec?.ports || [],
          routes: routeItems.filter(route => route.metadata?.namespace === namespaceValue
            && route.spec?.to?.name === serviceName).map(route => ({ name: route.metadata?.name || null,
              host: route.spec?.host || null, tls: !!route.spec?.tls })),
          ingresses: ingressItems.filter(ingress => ingress.metadata?.namespace === namespaceValue
            && (ingress.spec?.rules || []).some(rule => (rule.http?.paths || []).some(path =>
              path.backend?.service?.name === serviceName))).map(ingress => ({ name: ingress.metadata?.name || null,
            hosts: (ingress.spec?.rules || []).map(rule => rule.host).filter(Boolean), tls: !!ingress.spec?.tls?.length })) };
      }) };
    });
    return { namespace: namespace || null, entries,
      coverage: { virtualMachines: vms.state, services: services.state, routes: routes.state, ingresses: ingresses.state },
      providerMutationsStarted: 0, observedAt: new Date().toISOString() };
  }

  // ─── Namespaces ─────────────────────────────────────────

  /**
   * GET /api/v1/namespaces — list namespaces. The response shape is a
   * standard k8s List: { kind, items: [...] }. We surface items only.
   */
  async listNamespaces() {
    const resp = await this._request('GET', '/api/v1/namespaces');
    return (resp && resp.items) || [];
  }

  // ─── Pods ───────────────────────────────────────────────

  /**
   * List pods, optionally scoped to a namespace. The unscoped variant
   * uses /api/v1/pods (all namespaces), which returns items with a
   * .metadata.namespace field so the frontend can group.
   */
  async listPods(namespace) {
    const path = namespace
      ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
      : '/api/v1/pods';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  // ─── Deployments ────────────────────────────────────────

  /**
   * List Deployments (apps/v1 group). Only extension: we return items.
   */
  async listDeployments(namespace) {
    const path = namespace
      ? `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`
      : '/apis/apps/v1/deployments';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  // ─── Services ───────────────────────────────────────────

  async listServices(namespace) {
    const path = namespace
      ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`
      : '/api/v1/services';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  // ─── Nodes ──────────────────────────────────────────────

  /** GET /api/v1/nodes — cluster nodes. */
  async listNodes() {
    const resp = await this._request('GET', '/api/v1/nodes');
    return (resp && resp.items) || [];
  }

  // ─── v8.9.8-alpha.1 — Portainer G04 closure: Kubernetes write ops.
  // Scale, rollout restart, delete pod, cordon/uncordon nodes. Deep-spec
  // anti-features stay OUT: no YAML editor, no Helm, no exec-into-pod.

  /** PATCH /apis/apps/v1/namespaces/{ns}/deployments/{name}/scale */
  async scaleDeployment(namespace, name, replicas) {
    if (!Number.isInteger(replicas) || replicas < 0) {
      throw new Error('replicas must be a non-negative integer');
    }
    return this._request('PATCH', `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`,
      { spec: { replicas } });
  }

  /** Rollout restart via patch on template.metadata.annotations.
   *  Matches `kubectl rollout restart deployment/x`. */
  async restartDeployment(namespace, name) {
    const stamp = new Date().toISOString();
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': stamp,
            },
          },
        },
      },
    };
    return this._request('PATCH', `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
      patch);
  }

  /** DELETE /api/v1/namespaces/{ns}/pods/{name} — deletes the pod
   *  (Deployment reschedules a replacement if the pod belongs to one). */
  async deletePod(namespace, name) {
    return this._request('DELETE', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`);
  }

  /** PATCH node spec to cordon (unschedulable=true) or uncordon (false). */
  async cordonNode(name, unschedulable = true) {
    return this._request('PATCH', `/api/v1/nodes/${encodeURIComponent(name)}`,
      { spec: { unschedulable } });
  }

  /**
   * Stream pod logs — returns { on: (event, cb), destroy: fn }.
   * Uses the raw http.request path so we can pipe out the response
   * without buffering. Emits 'data' per chunk, 'end', 'error'.
   */
  streamPodLogs(namespace, name, { container, follow = true, tailLines = 200 } = {}) {
    const url = new URL(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/log`,
      this._config.endpoint);
    url.searchParams.set('follow', follow ? 'true' : 'false');
    if (container) url.searchParams.set('container', container);
    if (tailLines) url.searchParams.set('tailLines', String(tailLines));
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      method: 'GET',
      path: url.pathname + url.search,
      headers: {
        'Accept': 'text/plain',
        'Authorization': `Bearer ${this._config.token}`,
      },
      agent: this._agent,
    };
    const listeners = { data: [], end: [], error: [] };
    const emit = (evt, arg) => listeners[evt].forEach(fn => fn(arg));
    let req;
    let ended = false;
    const start = () => {
      req = https.request(reqOpts, (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const err = new Error(`Kubernetes log stream failed: HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`);
            err.status = res.statusCode;
            emit('error', err);
            ended = true;
            emit('end');
          });
          return;
        }
        res.on('data', chunk => { if (!ended) emit('data', chunk); });
        res.on('end', () => { if (!ended) { ended = true; emit('end'); } });
        res.on('error', err => { if (!ended) { ended = true; emit('error', err); } });
      });
      req.on('error', err => { if (!ended) { ended = true; emit('error', err); } });
      req.end();
    };
    // Kick off asynchronously so listeners have time to register.
    setImmediate(start);
    return {
      on(evt, cb) { if (listeners[evt]) listeners[evt].push(cb); return this; },
      destroy() { if (req) try { req.destroy(); } catch { /* ignore */ } ended = true; },
    };
  }

  // ─── v8.9.7-alpha.1 — Portainer G13 closure: Ingress + NetworkPolicy read
  // Read-only. No editing (anti-feature per Sprint 5 deep-spec).

  async listIngresses(namespace) {
    const path = namespace
      ? `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`
      : '/apis/networking.k8s.io/v1/ingresses';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  async listNetworkPolicies(namespace) {
    const path = namespace
      ? `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/networkpolicies`
      : '/apis/networking.k8s.io/v1/networkpolicies';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }
}

// v8.9.7-alpha.1 — Portainer G08 closure: kubeconfig generator.
// Builds a valid kubeconfig YAML from the stored daemon_config so the user
// can drop it in ~/.kube/config to use kubectl locally. Uses the same
// bearer token stored in daemon_config — no token exchange for now.
function buildKubeconfig(row) {
  if (!row) throw new Error('row required');
  if (row.daemon_type !== 'kubernetes') throw new Error('row is not a Kubernetes host');
  const cfg = decryptDaemonConfig(row.daemon_config);
  const clusterName = (row.name || 'docker-dash-cluster').replace(/[^a-zA-Z0-9._-]/g, '_');
  const contextName = `${clusterName}@docker-dash`;
  const userName = `docker-dash-${clusterName}`;
  const caB64 = cfg.caCert ? Buffer.from(cfg.caCert).toString('base64') : null;
  const clusterBlock = [
    `- cluster:`,
    caB64 ? `    certificate-authority-data: ${caB64}` : `    insecure-skip-tls-verify: true`,
    `    server: ${cfg.endpoint}`,
    `  name: ${clusterName}`,
  ].join('\n');
  return [
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${contextName}`,
    'clusters:',
    clusterBlock,
    'contexts:',
    `- context:`,
    `    cluster: ${clusterName}`,
    `    user: ${userName}`,
    `  name: ${contextName}`,
    'users:',
    `- name: ${userName}`,
    `  user:`,
    `    token: ${cfg.token}`,
    '',
  ].join('\n');
}

// daemon_config encryption at rest — same enc: prefix pattern as Incus /
// Proxmox / git credentials. Keyed by ENCRYPTION_KEY.

function decryptDaemonConfig(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return {};
  if (raw.startsWith('enc:')) {
    const { decrypt } = require('../utils/crypto');
    let plain;
    try { plain = decrypt(raw.slice(4)); }
    catch (e) { throw new Error(`daemon_config decrypt failed (ENCRYPTION_KEY changed?): ${e.message}`); }
    return JSON.parse(plain);
  }
  return JSON.parse(raw);
}

function encryptDaemonConfig(cfg) {
  const { encrypt } = require('../utils/crypto');
  const plain = JSON.stringify(cfg || {});
  return 'enc:' + encrypt(plain);
}

/** Build a KubernetesClient from a docker_hosts row. */
function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'kubernetes') {
    throw new Error(`fromHostRow: row is not a Kubernetes host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config: ${e.message}`); }
  return new KubernetesClient(cfg);
}

module.exports = {
  KubernetesClient,
  fromHostRow,
  decryptDaemonConfig,
  encryptDaemonConfig,
  buildKubeconfig,
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};

if (false) log.info();
