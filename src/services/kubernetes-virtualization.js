'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const Diff = require('diff');
const { getDb } = require('../db');
const { fromHostRow } = require('./kubernetes');

const INLINE_SECRET = /^(password|token|privateKey|userData|userDataBase64|networkData|networkDataBase64)$/i;

class KubernetesVirtualizationError extends Error {
  constructor(message, status = 400, code = 'KUBERNETES_VIRTUALIZATION_ERROR', details) {
    super(message); this.name = 'KubernetesVirtualizationError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new KubernetesVirtualizationError(message, status, code, details);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const safeSegment = (value, key) => {
  const result = String(value ?? '').trim();
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(result) || result.length > 253) throw fail(`${key} is invalid`);
  return result;
};
function bounded(value, key, max = 512 * 1024) {
  const bytes = Buffer.byteLength(typeof value === 'string' ? value : stable(value));
  if (bytes > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'DOCUMENT_TOO_LARGE');
}
function inlineSecretPaths(value, base = 'document', result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    const path = `${base}.${key}`;
    if (INLINE_SECRET.test(key) && child != null && child !== '') result.push(path);
    inlineSecretPaths(child, path, result);
  }
  return result;
}
function sanitizeVm(value) {
  const result = JSON.parse(JSON.stringify(value || {}));
  delete result.status;
  if (result.metadata) {
    for (const key of ['managedFields', 'resourceVersion', 'uid', 'creationTimestamp', 'generation', 'selfLink']) {
      delete result.metadata[key];
    }
  }
  return result;
}

class KubernetesVirtualizationService {
  constructor(dbProvider = getDb, clientFactory = fromHostRow) {
    this._dbProvider = dbProvider; this._clientFactory = clientFactory;
  }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _host(row) {
    if (!row?.id || row.daemon_type !== 'kubernetes') throw fail('A registered Kubernetes host is required', 400, 'KUBERNETES_HOST_REQUIRED');
  }
  _capabilityRow(row) { return row && { id: row.id, hostId: row.host_id, platform: row.platform,
    capabilities: parse(row.capabilities_json, {}), evidenceHash: row.evidence_hash,
    snapshotHash: row.snapshot_hash, createdAt: row.created_at }; }
  _inventoryRow(row) { return row && { id: row.id, hostId: row.host_id, namespace: row.namespace_scope,
    vmCount: row.vm_count, vmiCount: row.vmi_count, migrationCount: row.migration_count,
    inventory: parse(row.inventory_json, {}), evidenceHash: row.evidence_hash,
    snapshotHash: row.snapshot_hash, createdAt: row.created_at }; }
  _dryRunRow(row) { return row && { id: row.id, hostId: row.host_id, namespace: row.namespace,
    vmName: row.vm_name, status: row.status, originalHash: row.original_hash, desiredHash: row.desired_hash,
    diff: row.diff_text, serverResponse: parse(row.server_response_json, {}), validationHash: row.validation_hash,
    applied: false, createdAt: row.created_at }; }

  async discover(row) {
    this._host(row); return this._clientFactory(row).discoverVirtualizationCapabilities();
  }
  async refreshDiscovery(row, actor) {
    this._admin(actor); const evidence = await this.discover(row); bounded(evidence, 'capabilities');
    const evidenceHash = hash(evidence); const snapshotHash = hash({ hostId: row.id, evidenceHash }); const db = this._db();
    const existing = db.prepare('SELECT * FROM kubernetes_virtualization_capability_snapshots WHERE snapshot_hash=?').get(snapshotHash);
    if (existing) return { ...this._capabilityRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO kubernetes_virtualization_capability_snapshots
      (host_id,platform,capabilities_json,evidence_hash,snapshot_hash,created_by) VALUES (?,?,?,?,?,?)`)
      .run(row.id, evidence.platform, stable(evidence), evidenceHash, snapshotHash, actor.id);
    return { ...this._capabilityRow(db.prepare('SELECT * FROM kubernetes_virtualization_capability_snapshots WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }

  async inventory(row, namespace) {
    this._host(row); const scope = namespace ? safeSegment(namespace, 'namespace') : undefined;
    return this._clientFactory(row).kubeVirtInventory(scope);
  }
  async refreshInventory(row, namespace, actor) {
    this._admin(actor); const inventory = await this.inventory(row, namespace); bounded(inventory, 'inventory', 2 * 1024 * 1024);
    const evidenceHash = hash(inventory); const snapshotHash = hash({ hostId: row.id, namespace: inventory.namespace, evidenceHash });
    const db = this._db(); const existing = db.prepare('SELECT * FROM kubernetes_virtualization_inventory_snapshots WHERE snapshot_hash=?').get(snapshotHash);
    if (existing) return { ...this._inventoryRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO kubernetes_virtualization_inventory_snapshots
      (host_id,namespace_scope,vm_count,vmi_count,migration_count,inventory_json,evidence_hash,snapshot_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(row.id, inventory.namespace, inventory.virtualMachines.length,
      inventory.virtualMachines.length + inventory.orphanInstances.length, inventory.migrations.length,
      stable(inventory), evidenceHash, snapshotHash, actor.id);
    return { ...this._inventoryRow(db.prepare('SELECT * FROM kubernetes_virtualization_inventory_snapshots WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }

  async openShiftOverview(row, namespace) {
    this._host(row); return this._clientFactory(row).openShiftVirtualizationOverview(safeSegment(namespace || 'default', 'namespace'));
  }
  async harvesterOverview(row, namespace) {
    this._host(row); return this._clientFactory(row).harvesterOverview(safeSegment(namespace || 'default', 'namespace'));
  }

  async virtualMachineYaml(row, namespace, name) {
    this._host(row); const ns = safeSegment(namespace, 'namespace'); const vmName = safeSegment(name, 'name');
    const current = sanitizeVm(await this._clientFactory(row).getKubeVirtVirtualMachine(ns, vmName));
    const sensitive = inlineSecretPaths(current);
    if (sensitive.length) throw fail('VM contains inline secret material and cannot be opened in the editor', 409,
      'INLINE_SECRET_MATERIAL', { paths: sensitive });
    return { namespace: ns, name: vmName, yaml: YAML.stringify(current, { lineWidth: 0 }),
      originalHash: hash(current), editable: true, statusExcluded: true, providerMutationsStarted: 0 };
  }

  _parseVmYaml(yamlText, namespace, name) {
    if (typeof yamlText !== 'string' || !yamlText.trim()) throw fail('yaml is required');
    bounded(yamlText, 'yaml');
    const documents = YAML.parseAllDocuments(yamlText, { prettyErrors: true, uniqueKeys: true, maxAliasCount: 0 });
    if (documents.length !== 1) throw fail('Exactly one YAML document is required');
    if (documents[0].errors.length) throw fail(`YAML syntax error: ${documents[0].errors[0].message}`, 400, 'YAML_SYNTAX_ERROR');
    const desired = documents[0].toJS({ maxAliasCount: 0 });
    if (!desired || Array.isArray(desired) || typeof desired !== 'object') throw fail('YAML must contain an object');
    if (desired.apiVersion !== 'kubevirt.io/v1' || desired.kind !== 'VirtualMachine') {
      throw fail('Only kubevirt.io/v1 VirtualMachine documents are supported', 400, 'VM_SCHEMA_REQUIRED');
    }
    if (desired.metadata?.namespace !== namespace || desired.metadata?.name !== name) {
      throw fail('metadata.namespace and metadata.name must match the route target', 409, 'VM_IDENTITY_MISMATCH');
    }
    if (!desired.spec || typeof desired.spec !== 'object' || !desired.spec.template?.spec?.domain) {
      throw fail('VirtualMachine spec.template.spec.domain is required', 400, 'VM_SCHEMA_REQUIRED');
    }
    if (desired.status != null) throw fail('status is server-owned and must not be submitted');
    const sensitive = inlineSecretPaths(desired);
    if (sensitive.length) throw fail('Inline secret material is not accepted; use Kubernetes Secret references', 400,
      'INLINE_SECRET_MATERIAL', { paths: sensitive });
    return sanitizeVm(desired);
  }

  async dryRunVirtualMachine(row, namespace, name, yamlText, actor) {
    this._admin(actor); this._host(row); const ns = safeSegment(namespace, 'namespace'); const vmName = safeSegment(name, 'name');
    const desired = this._parseVmYaml(yamlText, ns, vmName); const client = this._clientFactory(row);
    const current = sanitizeVm(await client.getKubeVirtVirtualMachine(ns, vmName));
    const currentSensitive = inlineSecretPaths(current);
    if (currentSensitive.length) throw fail('Current VM contains inline secret material; dry-run is blocked', 409,
      'INLINE_SECRET_MATERIAL', { paths: currentSensitive });
    const originalYaml = YAML.stringify(current, { lineWidth: 0 });
    const desiredYaml = YAML.stringify(desired, { lineWidth: 0 });
    const diffText = Diff.createTwoFilesPatch(`${ns}/${vmName}:current`, `${ns}/${vmName}:desired`,
      originalYaml, desiredYaml, '', '', { context: 4 });
    bounded(diffText, 'diff');
    let status = 'valid'; let serverResponse;
    try {
      const response = await client.dryRunKubeVirtVirtualMachine(ns, vmName, desiredYaml);
      serverResponse = { accepted: true, apiVersion: response?.apiVersion || null, kind: response?.kind || null,
        namespace: response?.metadata?.namespace || ns, name: response?.metadata?.name || vmName,
        resourceVersion: response?.metadata?.resourceVersion || null, dryRun: 'All' };
    } catch (error) {
      status = 'rejected';
      serverResponse = { accepted: false, status: error.status || null,
        reason: error.kubernetesResponse?.reason || null,
        message: String(error.kubernetesResponse?.message || error.message || 'Kubernetes dry-run rejected').slice(0, 1000),
        details: error.kubernetesResponse?.details || null, dryRun: 'All' };
    }
    bounded(serverResponse, 'serverResponse');
    const originalHash = hash(current); const desiredHash = hash(desired);
    const validationHash = hash({ hostId: row.id, namespace: ns, vmName, originalHash, desiredHash, serverResponse });
    const db = this._db(); const existing = db.prepare('SELECT * FROM kubernetes_virtualization_dry_runs WHERE validation_hash=?').get(validationHash);
    if (existing) return { ...this._dryRunRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO kubernetes_virtualization_dry_runs
      (host_id,namespace,vm_name,status,original_hash,desired_hash,diff_text,server_response_json,validation_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.id, ns, vmName, status, originalHash, desiredHash, diffText,
      stable(serverResponse), validationHash, actor.id);
    return { ...this._dryRunRow(db.prepare('SELECT * FROM kubernetes_virtualization_dry_runs WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }

  evidence(hostId, actor) {
    this._admin(actor); const id = Number(hostId);
    if (!Number.isSafeInteger(id) || id < 1) throw fail('hostId is invalid'); const db = this._db();
    return { capabilitySnapshots: db.prepare(`SELECT * FROM kubernetes_virtualization_capability_snapshots
        WHERE host_id=? ORDER BY id DESC LIMIT 20`).all(id).map(row => this._capabilityRow(row)),
      inventorySnapshots: db.prepare(`SELECT * FROM kubernetes_virtualization_inventory_snapshots
        WHERE host_id=? ORDER BY id DESC LIMIT 20`).all(id).map(row => this._inventoryRow(row)),
      dryRuns: db.prepare(`SELECT * FROM kubernetes_virtualization_dry_runs
        WHERE host_id=? ORDER BY id DESC LIMIT 50`).all(id).map(row => this._dryRunRow(row)) };
  }
}

const service = new KubernetesVirtualizationService();
module.exports = service;
module.exports.KubernetesVirtualizationService = KubernetesVirtualizationService;
module.exports.KubernetesVirtualizationError = KubernetesVirtualizationError;
module.exports._internals = { canonical, stable, hash, inlineSecretPaths, sanitizeVm };
