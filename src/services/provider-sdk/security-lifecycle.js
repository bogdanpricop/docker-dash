'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const secretReferenceAdmission = require('../secret-reference-admission');

const SCHEMA_VERSION = '1.0';
const PLAN_TTL_MS = 10 * 60 * 1000;
const RESOURCE_ID = /^ddr_(vm|host)_[a-f0-9]{26}$/;
const CVE_ID = /^CVE-\d{4}-\d{4,8}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,500}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const ACTION_RISK = Object.freeze({
  disable_legacy_protocol: 'low',
  rotate_certificate: 'moderate',
  upgrade_provider_build: 'high',
  remove_legacy_device: 'low',
  enforce_secret_reference: 'low',
});
const AUTOMATED_ACTIONS = new Set([
  'disable_legacy_protocol', 'remove_legacy_device', 'enforce_secret_reference',
]);
const SEVERITY_BASE = Object.freeze({ info: 10, low: 25, medium: 45, high: 70, critical: 85 });

class ProviderSecurityLifecycleError extends Error {
  constructor(message, code = 'PROVIDER_SECURITY_LIFECYCLE_ERROR', status = 400, details = null) {
    super(message); this.name = 'ProviderSecurityLifecycleError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _enabled(options = {}) {
  return options.enabled === undefined ? config.features.providerSecurityLifecycle : options.enabled === true;
}
function _automationEnabled(options = {}) {
  return options.automationEnabled === undefined
    ? config.features.providerSecurityLowRiskRemediation : options.automationEnabled === true;
}
function _assertEnabled(options) {
  if (!_enabled(options)) throw new ProviderSecurityLifecycleError(
    'Provider security lifecycle is disabled by release policy', 'PROVIDER_SECURITY_LIFECYCLE_DISABLED', 404);
}
function _assertOperate(options) {
  if (options.canOperate !== true) throw new ProviderSecurityLifecycleError(
    'Operate permission is required', 'PERMISSION_BLOCKED', 403);
}
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function _json(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _text(value, label, max = 500) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || !SAFE_TEXT.test(result)) throw new ProviderSecurityLifecycleError(
    `${label} is invalid`, 'INVALID_SECURITY_LIFECYCLE_INPUT');
  return result;
}
function _integer(value, label, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new ProviderSecurityLifecycleError(
    `${label} must be an integer between ${min} and ${max}`, 'INVALID_SECURITY_LIFECYCLE_INPUT');
  return result;
}
function _timestamp(value, label, future = false) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime()) || (future && date.getTime() <= Date.now())) {
    throw new ProviderSecurityLifecycleError(`${label} is invalid`, 'INVALID_SECURITY_LIFECYCLE_INPUT');
  }
  return date.toISOString();
}
function _bounded(value, label, max = 64 * 1024) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { /* handled below */ }
  if (!encoded || Buffer.byteLength(encoded) > max) throw new ProviderSecurityLifecycleError(
    `${label} is too large or not JSON serializable`, 'INVALID_SECURITY_LIFECYCLE_INPUT', 413);
}
function _secretFree(value, path = 'document') {
  if (typeof value === 'string') {
    if (PRIVATE_KEY.test(value) || /:\/\/[^\s/:]+:[^\s/@]+@/.test(value)) throw new ProviderSecurityLifecycleError(
      `${path} may not contain secret material`, 'SECURITY_SECRET_MATERIAL_FORBIDDEN');
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new ProviderSecurityLifecycleError(
      `${path}.${key} may not contain secret material`, 'SECURITY_SECRET_MATERIAL_FORBIDDEN');
    _secretFree(child, `${path}.${key}`);
  }
}
function _table(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function _host(database, hostId) {
  const id = Number(hostId);
  const row = Number.isInteger(id) && id > 0
    ? database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(id) : null;
  if (!row) throw new ProviderSecurityLifecycleError(
    'Provider endpoint was not found', 'PROVIDER_ENDPOINT_NOT_FOUND', 404);
  return row;
}
function _resource(database, hostId, idInput) {
  const id = String(idInput || `endpoint:${Number(hostId)}`);
  if (id === `endpoint:${Number(hostId)}`) return { kind: 'endpoint', id, name: `Endpoint ${hostId}` };
  if (!RESOURCE_ID.test(id)) throw new ProviderSecurityLifecycleError(
    'Advisory resource is invalid', 'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
  const row = database.prepare(`SELECT i.resource_kind,s.display_name FROM provider_resource_identities i
    LEFT JOIN provider_resource_snapshots s ON s.canonical_id=i.canonical_id
    WHERE i.canonical_id=? AND i.host_id=?`).get(id, Number(hostId));
  if (!row || !['host', 'virtualMachine'].includes(row.resource_kind)) throw new ProviderSecurityLifecycleError(
    'Advisory resource is outside the endpoint scope', 'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
  return { kind: row.resource_kind, id, name: row.display_name || id };
}
function _stringList(value, label, { max = 100, pattern = SAFE_TEXT, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && !value.length)) {
    throw new ProviderSecurityLifecycleError(`${label} is invalid`, 'INVALID_SECURITY_LIFECYCLE_INPUT');
  }
  const result = [...new Set(value.map(item => String(item).trim()))];
  if (result.some(item => !item || item.length > 500 || !pattern.test(item))) throw new ProviderSecurityLifecycleError(
    `${label} contains an invalid value`, 'INVALID_SECURITY_LIFECYCLE_INPUT');
  return result;
}
function _advisoryMetadata(raw) {
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.securityAdvisory : null;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const allowed = new Set(['cveIds', 'cvss', 'affectedVersions', 'affectedBuilds',
    'fixedVersion', 'affectedResourceIds']);
  if (Object.keys(root).some(key => !allowed.has(key))) throw new ProviderSecurityLifecycleError(
    'Security advisory metadata contains an unsupported field', 'INVALID_SECURITY_ADVISORY_METADATA');
  const cveIds = _stringList(root.cveIds || [], 'securityAdvisory.cveIds', { max: 64, pattern: CVE_ID });
  const affectedVersions = _stringList(root.affectedVersions || [], 'securityAdvisory.affectedVersions');
  const affectedBuilds = _stringList(root.affectedBuilds || [], 'securityAdvisory.affectedBuilds');
  if (!affectedVersions.length && !affectedBuilds.length) return null;
  const cvss = root.cvss === undefined || root.cvss === null ? null : Number(root.cvss);
  if (cvss !== null && (!Number.isFinite(cvss) || cvss < 0 || cvss > 10)) throw new ProviderSecurityLifecycleError(
    'securityAdvisory.cvss is invalid', 'INVALID_SECURITY_ADVISORY_METADATA');
  const fixedVersion = root.fixedVersion == null ? null : _text(root.fixedVersion,
    'securityAdvisory.fixedVersion', 160);
  const affectedResourceIds = _stringList(root.affectedResourceIds || [],
    'securityAdvisory.affectedResourceIds', { max: 500 });
  return { cveIds, cvss, affectedVersions, affectedBuilds, fixedVersion, affectedResourceIds };
}
function _exposure(database, hostId, resourceId) {
  const row = database.prepare(`SELECT facts_json,evidence_hash,observed_at FROM provider_security_evidence
    WHERE host_id=? AND resource_id=? ORDER BY observed_at DESC LIMIT 1`).get(Number(hostId), resourceId);
  const facts = _json(row?.facts_json, {}); const value = facts.exposure;
  if (!value || typeof value !== 'object') return { criticality: 'unknown', reachability: 'unknown',
    protections: [], evidenceHash: row?.evidence_hash || null, observedAt: row?.observed_at || null };
  return { criticality: value.criticality || 'unknown', reachability: value.reachability || 'unknown',
    protections: Array.isArray(value.protections) ? value.protections : [],
    evidenceHash: row?.evidence_hash || null, observedAt: row?.observed_at || null };
}
function _priority(severity, exposure) {
  const criticality = { low: 0, medium: 5, high: 10, critical: 15 }[exposure.criticality] || 0;
  const reachability = exposure.reachability === 'internet' ? 10
    : exposure.reachability === 'restricted' ? 3 : 0;
  return Math.min(100, (SEVERITY_BASE[severity] || 10) + criticality + reachability);
}
function _confidence(exposure) {
  const known = [exposure.criticality, exposure.reachability].filter(value => value && value !== 'unknown').length;
  return known === 2 ? 'high' : known === 1 ? 'medium' : 'low';
}
function _activeException(database, findingId) {
  const row = database.prepare(`SELECT * FROM provider_security_finding_exceptions
    WHERE finding_id=? AND revoked_at IS NULL AND expires_at>datetime('now')
    ORDER BY created_at DESC LIMIT 1`).get(findingId);
  return row ? { id: row.id, owner: row.owner, reason: row.reason, expiresAt: row.expires_at,
    compensatingControls: _json(row.compensating_controls_json, []), exceptionHash: row.exception_hash,
    createdAt: row.created_at } : null;
}
function _planRow(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, findingId: row.finding_id,
    actionKey: row.action_key, risk: row.risk, steps: _json(row.steps_json, []),
    downtimeSeconds: Number(row.downtime_seconds), dependencies: _json(row.dependencies_json, []),
    rollback: _json(row.rollback_json, {}), dryRun: _json(row.dry_run_json, {}),
    planHash: row.plan_hash, allowed: !!row.allowed, state: row.state, expiresAt: row.expires_at,
    createdAt: row.created_at } : null;
}
function _findingRow(database, row) {
  if (!row) return null;
  const exception = _activeException(database, row.id);
  const plan = _planRow(database.prepare(`SELECT * FROM provider_security_remediation_plans
    WHERE finding_id=? ORDER BY created_at DESC LIMIT 1`).get(row.id));
  return { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    inventoryId: Number(row.inventory_id), advisoryCatalogId: Number(row.advisory_catalog_id),
    resourceKind: row.resource_kind, resourceId: row.resource_id, resourceName: row.resource_name,
    advisoryId: row.advisory_id, cveIds: _json(row.cve_ids_json, []), severity: row.severity,
    priorityScore: Number(row.priority_score), confidence: row.confidence,
    exposure: _json(row.exposure_json, {}), matchEvidence: _json(row.match_evidence_json, {}),
    evidenceHash: row.evidence_hash, state: exception ? 'excepted' : row.state === 'excepted' ? 'open' : row.state,
    exception, remediationPlan: plan, observedAt: row.observed_at, updatedAt: row.updated_at };
}
function _refreshExceptionStates(database, hostId) {
  database.prepare(`UPDATE provider_security_findings SET state='open',updated_at=datetime('now')
    WHERE host_id=? AND state='excepted' AND NOT EXISTS (
      SELECT 1 FROM provider_security_finding_exceptions e WHERE e.finding_id=provider_security_findings.id
      AND e.revoked_at IS NULL AND e.expires_at>datetime('now'))`).run(Number(hostId));
}

function correlate(host, options = {}) {
  _assertEnabled(options); _assertOperate(options);
  const database = _database(options); _host(database, host.id); const hostId = Number(host.id);
  const inventories = database.prepare(`SELECT * FROM lifecycle_version_inventory
    WHERE provider_host_id=? ORDER BY id`).all(hostId);
  const selectCatalog = database.prepare(`SELECT * FROM lifecycle_update_catalog
    WHERE update_kind='advisory' AND lower(vendor)=lower(?) AND lower(product)=lower(?) ORDER BY id`);
  let matched = 0; let skipped = 0; const findingIds = [];
  const save = database.prepare(`INSERT INTO provider_security_findings
    (id,host_id,inventory_id,advisory_catalog_id,resource_kind,resource_id,resource_name,
      advisory_id,cve_ids_json,severity,priority_score,confidence,exposure_json,match_evidence_json,
      evidence_hash,state,observed_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(host_id,inventory_id,advisory_catalog_id,resource_id) DO UPDATE SET
      resource_kind=excluded.resource_kind,resource_name=excluded.resource_name,cve_ids_json=excluded.cve_ids_json,
      severity=excluded.severity,priority_score=excluded.priority_score,confidence=excluded.confidence,
      exposure_json=excluded.exposure_json,match_evidence_json=excluded.match_evidence_json,
      evidence_hash=excluded.evidence_hash,observed_at=excluded.observed_at,updated_at=datetime('now')`);
  database.transaction(() => {
    for (const inventory of inventories) {
      for (const advisory of selectCatalog.all(inventory.vendor, inventory.product)) {
        const metadata = _advisoryMetadata(_json(advisory.metadata_json, {}));
        if (!metadata) { skipped++; continue; }
        const versionMatch = metadata.affectedVersions.includes(inventory.version);
        const buildMatch = !!inventory.build && metadata.affectedBuilds.includes(inventory.build);
        if (!versionMatch && !buildMatch) { skipped++; continue; }
        const resources = metadata.affectedResourceIds.length
          ? metadata.affectedResourceIds.map(id => _resource(database, hostId, id))
          : [_resource(database, hostId, `endpoint:${hostId}`)];
        for (const resource of resources) {
          const exposure = _exposure(database, hostId, resource.id);
          const matchEvidence = { componentType: inventory.component_type, vendor: inventory.vendor,
            product: inventory.product, version: inventory.version, build: inventory.build || null,
            versionMatch, buildMatch, fixedVersion: metadata.fixedVersion, cvss: metadata.cvss,
            inventoryEvidenceHash: inventory.evidence_hash, advisorySourceDigest: advisory.source_digest,
            advisorySourceUrl: advisory.source_url };
          const semantic = { hostId, inventoryId: inventory.id, advisoryCatalogId: advisory.id,
            resource, advisoryId: advisory.advisory_id, cveIds: metadata.cveIds,
            severity: advisory.severity, exposure, matchEvidence };
          const evidenceHash = sha256(_canonical(semantic));
          const existing = database.prepare(`SELECT id FROM provider_security_findings WHERE host_id=?
            AND inventory_id=? AND advisory_catalog_id=? AND resource_id=?`)
            .get(hostId, inventory.id, advisory.id, resource.id);
          const id = existing?.id || `psfd_${generateToken(13)}`;
          save.run(id, hostId, inventory.id, advisory.id, resource.kind, resource.id, resource.name,
            advisory.advisory_id, JSON.stringify(metadata.cveIds), advisory.severity,
            _priority(advisory.severity, exposure), _confidence(exposure), JSON.stringify(exposure),
            JSON.stringify(matchEvidence), evidenceHash, 'open', inventory.observed_at,
            options.createdBy || null);
          findingIds.push(id); matched++;
        }
      }
    }
    _refreshExceptionStates(database, hostId);
  })();
  const findings = findingIds.map(id => _findingRow(database,
    database.prepare('SELECT * FROM provider_security_findings WHERE id=?').get(id)));
  return { schemaVersion: SCHEMA_VERSION, hostId, matched, skipped, findings,
    source: 'official_catalog', networkCallsStarted: 0, packagesInstalled: 0,
    limitations: ['Only exact affected-version or affected-build matches create findings.',
      'Unmatched and absent advisory metadata remains unknown; findings are never inferred from version ranges.',
      'Correlation does not fetch advisories or modify provider resources.'] };
}

function createException(host, findingId, input = {}, options = {}) {
  _assertEnabled(options); _assertOperate(options); const database = _database(options);
  const finding = database.prepare('SELECT * FROM provider_security_findings WHERE id=? AND host_id=?')
    .get(String(findingId), Number(host.id));
  if (!finding) throw new ProviderSecurityLifecycleError(
    'Security finding was not found', 'SECURITY_FINDING_NOT_FOUND', 404);
  const expiresAt = _timestamp(input.expiresAt, 'Exception expiry', true);
  if (Date.parse(expiresAt) > Date.now() + 366 * 86400000) throw new ProviderSecurityLifecycleError(
    'Exception expiry may not exceed 366 days', 'INVALID_SECURITY_EXCEPTION');
  const normalized = { owner: _text(input.owner, 'Exception owner', 160),
    reason: _text(input.reason, 'Exception reason'), expiresAt,
    compensatingControls: _stringList(input.compensatingControls, 'Compensating controls',
      { max: 20, allowEmpty: false }) };
  const id = `psfx_${generateToken(13)}`; const exceptionHash = sha256(_canonical({
    findingId: finding.id, ...normalized }));
  database.transaction(() => {
    database.prepare(`INSERT INTO provider_security_finding_exceptions
      (id,finding_id,owner,reason,expires_at,compensating_controls_json,exception_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, finding.id, normalized.owner, normalized.reason,
      normalized.expiresAt, JSON.stringify(normalized.compensatingControls), exceptionHash,
      options.createdBy || null);
    database.prepare("UPDATE provider_security_findings SET state='excepted',updated_at=datetime('now') WHERE id=?")
      .run(finding.id);
  })();
  return _findingRow(database, database.prepare('SELECT * FROM provider_security_findings WHERE id=?').get(finding.id));
}

function revokeException(host, findingId, exceptionId, options = {}) {
  _assertEnabled(options); _assertOperate(options); const database = _database(options);
  const row = database.prepare(`SELECT e.id FROM provider_security_finding_exceptions e
    JOIN provider_security_findings f ON f.id=e.finding_id
    WHERE e.id=? AND e.finding_id=? AND f.host_id=? AND e.revoked_at IS NULL`)
    .get(String(exceptionId), String(findingId), Number(host.id));
  if (!row) throw new ProviderSecurityLifecycleError(
    'Active security exception was not found', 'SECURITY_EXCEPTION_NOT_FOUND', 404);
  database.transaction(() => {
    database.prepare(`UPDATE provider_security_finding_exceptions
      SET revoked_by=?,revoked_at=datetime('now') WHERE id=?`).run(options.createdBy || null, row.id);
    database.prepare("UPDATE provider_security_findings SET state='open',updated_at=datetime('now') WHERE id=?")
      .run(String(findingId));
  })();
  return _findingRow(database, database.prepare('SELECT * FROM provider_security_findings WHERE id=?')
    .get(String(findingId)));
}

function _steps(value) {
  const items = _stringList(value, 'Remediation steps', { max: 20, allowEmpty: false });
  return items.map((title, index) => ({ order: index + 1, title }));
}
function _dependencies(value) {
  if (!Array.isArray(value) || value.length > 20) throw new ProviderSecurityLifecycleError(
    'Remediation dependencies are invalid', 'INVALID_SECURITY_REMEDIATION_PLAN');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'passed', 'evidence'].includes(key))) {
      throw new ProviderSecurityLifecycleError(
        `Remediation dependency ${index + 1} is invalid`, 'INVALID_SECURITY_REMEDIATION_PLAN');
    }
    return { id: _text(item.id, `Dependency ${index + 1} ID`, 120), passed: item.passed === true,
      evidence: _text(item.evidence, `Dependency ${index + 1} evidence`) };
  });
}
function planRemediation(host, findingId, input = {}, options = {}) {
  _assertEnabled(options); _assertOperate(options); const database = _database(options);
  const finding = database.prepare('SELECT * FROM provider_security_findings WHERE id=? AND host_id=?')
    .get(String(findingId), Number(host.id));
  if (!finding) throw new ProviderSecurityLifecycleError(
    'Security finding was not found', 'SECURITY_FINDING_NOT_FOUND', 404);
  const actionKey = String(input.actionKey || ''); const risk = ACTION_RISK[actionKey];
  if (!risk) throw new ProviderSecurityLifecycleError(
    'Remediation action is not allowlisted', 'SECURITY_REMEDIATION_ACTION_BLOCKED', 409);
  const steps = _steps(input.steps); const dependencies = _dependencies(input.dependencies || []);
  const rollback = input.rollback;
  if (!rollback || typeof rollback !== 'object' || Array.isArray(rollback)
    || Object.keys(rollback).some(key => !['strategy', 'verified'].includes(key))) {
    throw new ProviderSecurityLifecycleError(
      'A closed-schema rollback plan is required', 'INVALID_SECURITY_REMEDIATION_PLAN');
  }
  const normalizedRollback = { strategy: _text(rollback.strategy, 'Rollback strategy'),
    verified: rollback.verified === true };
  const dryRun = input.dryRun;
  if (!dryRun || typeof dryRun !== 'object' || Array.isArray(dryRun)
    || Object.keys(dryRun).some(key => !['passed', 'evidence'].includes(key))) {
    throw new ProviderSecurityLifecycleError(
      'Closed-schema dry-run evidence is required', 'INVALID_SECURITY_REMEDIATION_PLAN');
  }
  const normalizedDryRun = { passed: dryRun.passed === true,
    evidence: _text(dryRun.evidence, 'Dry-run evidence') };
  _bounded({ steps, dependencies, rollback: normalizedRollback, dryRun: normalizedDryRun }, 'Remediation plan');
  _secretFree({ steps, dependencies, rollback: normalizedRollback, dryRun: normalizedDryRun });
  const blockers = [];
  if (_activeException(database, finding.id)) blockers.push('Security finding has an active exception');
  if (!normalizedDryRun.passed) blockers.push('Dry-run did not pass');
  if (dependencies.some(item => !item.passed)) blockers.push('One or more dependencies did not pass');
  if (!normalizedRollback.verified) blockers.push('Rollback plan is not verified');
  const downtimeSeconds = _integer(input.downtimeSeconds ?? 0, 'Downtime seconds', 0, 604800);
  const semantic = { findingId: finding.id, actionKey, risk, steps, downtimeSeconds,
    dependencies, rollback: normalizedRollback, dryRun: normalizedDryRun,
    findingEvidenceHash: finding.evidence_hash, blockers };
  const planHash = sha256(_canonical(semantic)); const id = `psrp_${generateToken(13)}`;
  const allowed = blockers.length === 0; const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();
  try {
    database.transaction(() => {
      database.prepare(`INSERT INTO provider_security_remediation_plans
        (id,finding_id,action_key,risk,steps_json,downtime_seconds,dependencies_json,rollback_json,
          dry_run_json,plan_hash,allowed,state,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, finding.id, actionKey, risk, JSON.stringify(steps), downtimeSeconds,
          JSON.stringify(dependencies), JSON.stringify(normalizedRollback), JSON.stringify(normalizedDryRun),
          planHash, allowed ? 1 : 0, allowed ? 'planned' : 'blocked', expiresAt, options.createdBy || null);
      if (allowed) database.prepare("UPDATE provider_security_findings SET state='planned',updated_at=datetime('now') WHERE id=?")
        .run(finding.id);
    })();
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw new ProviderSecurityLifecycleError(
      'An identical remediation plan already exists', 'SECURITY_REMEDIATION_PLAN_EXISTS', 409);
    throw error;
  }
  return { ...semantic, ..._planRow(database.prepare(
    'SELECT * FROM provider_security_remediation_plans WHERE id=?').get(id)), blockers,
  executionAuthorized: false };
}

async function executeLowRisk(host, planId, input = {}, options = {}) {
  _assertEnabled(options); _assertOperate(options);
  if (!_automationEnabled(options)) throw new ProviderSecurityLifecycleError(
    'Low-risk security remediation is disabled by release policy',
    'PROVIDER_SECURITY_REMEDIATION_DISABLED', 404);
  const database = _database(options); const row = database.prepare(`SELECT p.*,f.host_id,f.evidence_hash finding_hash
    FROM provider_security_remediation_plans p JOIN provider_security_findings f ON f.id=p.finding_id
    WHERE p.id=? AND f.host_id=?`).get(String(planId), Number(host.id));
  const plan = _planRow(row);
  if (!plan) throw new ProviderSecurityLifecycleError(
    'Remediation plan was not found', 'SECURITY_REMEDIATION_PLAN_NOT_FOUND', 404);
  if (!plan.allowed || plan.state !== 'planned' || plan.risk !== 'low'
    || !AUTOMATED_ACTIONS.has(plan.actionKey) || Date.parse(plan.expiresAt) <= Date.now()) {
    throw new ProviderSecurityLifecycleError(
      'A current allowlisted low-risk plan is required', 'SECURITY_REMEDIATION_PLAN_BLOCKED', 409);
  }
  if (input.planHash !== plan.planHash || input.confirmation !== `EXECUTE SECURITY PLAN ${plan.id}`) {
    throw new ProviderSecurityLifecycleError(
      'Plan hash or typed confirmation does not match', 'SECURITY_REMEDIATION_CONFIRMATION_MISMATCH', 409);
  }
  const adapterKey = _text(input.adapterKey, 'Remediation adapter key', 120);
  if (!/^[a-z][a-z0-9_.-]{1,119}$/.test(adapterKey)) throw new ProviderSecurityLifecycleError(
    'Remediation adapter key is invalid', 'INVALID_SECURITY_LIFECYCLE_INPUT');
  const adapter = options.remediationAdapters?.[adapterKey];
  if (typeof adapter !== 'function') throw new ProviderSecurityLifecycleError(
    'No conformance-tested remediation adapter is registered', 'SECURITY_REMEDIATION_ADAPTER_UNAVAILABLE', 409);
  const finding = _findingRow(database, database.prepare(
    'SELECT * FROM provider_security_findings WHERE id=?').get(plan.findingId));
  const currentPlanHash = sha256(_canonical({ findingId: plan.findingId, actionKey: plan.actionKey,
    risk: plan.risk, steps: plan.steps, downtimeSeconds: plan.downtimeSeconds,
    dependencies: plan.dependencies, rollback: plan.rollback, dryRun: plan.dryRun,
    findingEvidenceHash: finding.evidenceHash, blockers: [] }));
  if (finding.evidenceHash !== row.finding_hash || currentPlanHash !== plan.planHash || finding.exception) {
    throw new ProviderSecurityLifecycleError(
    'Finding evidence or exception state changed after planning', 'SECURITY_REMEDIATION_REVALIDATION_FAILED', 409);
  }
  const canary = await adapter({ phase: 'canary', host, plan, finding });
  _bounded(canary, 'Canary evidence'); _secretFree(canary, 'canaryEvidence');
  if (canary?.ready !== true || canary?.providerMutationsStarted === true) throw new ProviderSecurityLifecycleError(
    'Read-only canary did not pass', 'SECURITY_REMEDIATION_CANARY_FAILED', 409);
  const runId = `psrr_${generateToken(13)}`; let mutationStarted = false;
  let evidence = { canary, apply: null, verify: null, rollback: null };
  database.transaction(() => {
    database.prepare(`INSERT INTO provider_security_remediation_runs
      (id,plan_id,adapter_key,state,provider_mutations_started,evidence_json,evidence_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(runId, plan.id, adapterKey, 'executing', 0,
      JSON.stringify(evidence), sha256(_canonical(evidence)), options.createdBy || null);
    database.prepare("UPDATE provider_security_remediation_plans SET state='executing',updated_at=datetime('now') WHERE id=?")
      .run(plan.id);
  })();
  try {
    mutationStarted = true;
    database.prepare('UPDATE provider_security_remediation_runs SET provider_mutations_started=1 WHERE id=?')
      .run(runId);
    evidence.apply = await adapter({ phase: 'apply', host, plan, finding, canary });
    _bounded(evidence.apply, 'Apply evidence'); _secretFree(evidence.apply, 'applyEvidence');
    evidence.verify = await adapter({ phase: 'verify', host, plan, finding,
      canary, applyEvidence: evidence.apply });
    _bounded(evidence.verify, 'Verification evidence'); _secretFree(evidence.verify, 'verifyEvidence');
    if (evidence.verify?.verified !== true) throw new ProviderSecurityLifecycleError(
      'Post-remediation verification failed', 'SECURITY_REMEDIATION_VERIFY_FAILED', 409);
    database.transaction(() => {
      database.prepare(`UPDATE provider_security_remediation_runs SET state='succeeded',evidence_json=?,
        evidence_hash=?,completed_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(evidence), sha256(_canonical(evidence)), runId);
      database.prepare("UPDATE provider_security_remediation_plans SET state='succeeded',updated_at=datetime('now') WHERE id=?")
        .run(plan.id);
      database.prepare("UPDATE provider_security_findings SET state='remediated',updated_at=datetime('now') WHERE id=?")
        .run(plan.findingId);
    })();
  } catch (error) {
    let state = 'failed';
    if (mutationStarted) {
      try {
        evidence.rollback = await adapter({ phase: 'rollback', host, plan, finding,
          canary, applyEvidence: evidence.apply });
        _bounded(evidence.rollback, 'Rollback evidence'); _secretFree(evidence.rollback, 'rollbackEvidence');
        state = evidence.rollback?.rolledBack === true ? 'failed' : 'rollback_required';
      } catch (rollbackError) {
        evidence.rollback = { rolledBack: false, error: String(rollbackError?.message || rollbackError).slice(0, 500) };
        state = 'rollback_required';
      }
    }
    evidence.error = { code: error.code || 'SECURITY_REMEDIATION_FAILED',
      message: String(error.message || error).slice(0, 500) };
    database.transaction(() => {
      database.prepare(`UPDATE provider_security_remediation_runs SET state=?,evidence_json=?,evidence_hash=?,
        completed_at=datetime('now') WHERE id=?`).run(state, JSON.stringify(evidence),
        sha256(_canonical(evidence)), runId);
      database.prepare('UPDATE provider_security_remediation_plans SET state=?,updated_at=datetime(\'now\') WHERE id=?')
        .run(state, plan.id);
      database.prepare("UPDATE provider_security_findings SET state='open',updated_at=datetime('now') WHERE id=?")
        .run(plan.findingId);
    })();
  }
  const run = database.prepare('SELECT * FROM provider_security_remediation_runs WHERE id=?').get(runId);
  return { schemaVersion: SCHEMA_VERSION, id: run.id, planId: run.plan_id, adapterKey: run.adapter_key,
    state: run.state, providerMutationsStarted: !!run.provider_mutations_started,
    evidence: _json(run.evidence_json, {}), evidenceHash: run.evidence_hash,
    createdAt: run.created_at, completedAt: run.completed_at };
}

function _validateReferences(document) {
  return secretReferenceAdmission._internals.inspectDocument(document);
}
function validateSecretReferences(host, input = {}, options = {}) {
  _assertEnabled(options); _assertOperate(options); const database = _database(options);
  _host(database, host.id); let admission;
  try { admission = secretReferenceAdmission.inspectSecretReferences(input); } catch (error) {
    if (error?.name === 'SecretReferenceAdmissionError') throw new ProviderSecurityLifecycleError(
      error.message, error.code, error.status, error.details);
    throw error;
  }
  const { documentKind, documentHash, referenceHashes, state, findings } = admission;
  const existing = database.prepare(`SELECT id FROM provider_secret_reference_validations
    WHERE host_id=? AND document_kind=? AND document_hash=?`).get(Number(host.id), documentKind, documentHash);
  const id = existing?.id || `psrv_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_secret_reference_validations
    (id,host_id,document_kind,document_hash,reference_hashes_json,state,findings_json,created_by)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(host_id,document_kind,document_hash) DO UPDATE SET
      reference_hashes_json=excluded.reference_hashes_json,state=excluded.state,
      findings_json=excluded.findings_json,created_by=excluded.created_by,created_at=datetime('now')`)
    .run(id, Number(host.id), documentKind, documentHash, JSON.stringify(referenceHashes), state,
      JSON.stringify(findings), options.createdBy || null);
  return { schemaVersion: SCHEMA_VERSION, id, hostId: Number(host.id), documentKind, documentHash,
    state, referenceCount: referenceHashes.length, referenceHashes, findings,
    networkCallsStarted: 0, documentStored: false };
}

function _certificateRotation(database, hostId) {
  if (!['tracked_certificates', 'lifecycle_certificate_ownership',
    'lifecycle_certificate_renewal_jobs'].every(name => _table(database, name))) return [];
  return database.prepare(`SELECT c.id,c.name,c.subject,c.issuer,c.sans,c.not_after,c.fingerprint_sha256,
      c.self_signed,c.last_checked_at,c.last_error,o.id ownership_id,o.owner,o.environment,
      o.resource_type,o.resource_ref,j.id renewal_id,j.adapter_key,j.state renewal_state,
      j.plan_hash,j.rollback_on_failure,j.approved_at,j.completed_at
    FROM tracked_certificates c LEFT JOIN lifecycle_certificate_ownership o ON o.certificate_id=c.id
    LEFT JOIN lifecycle_certificate_renewal_jobs j ON j.id=(
      SELECT j2.id FROM lifecycle_certificate_renewal_jobs j2 WHERE j2.ownership_id=o.id
      ORDER BY j2.id DESC LIMIT 1)
    WHERE c.host_id=? ORDER BY c.not_after,lower(c.name)`).all(Number(hostId)).map(row => ({
      certificateId: Number(row.id), name: row.name, subject: row.subject, issuer: row.issuer,
      sans: String(row.sans || '').split(',').map(value => value.trim()).filter(Boolean),
      expiresAt: row.not_after, fingerprintSha256: row.fingerprint_sha256,
      selfSigned: !!row.self_signed, lastCheckedAt: row.last_checked_at,
      lastError: row.last_error || null, ownership: row.ownership_id ? {
        id: Number(row.ownership_id), owner: row.owner, environment: row.environment,
        resourceType: row.resource_type, resourceRef: row.resource_ref } : null,
      latestRenewal: row.renewal_id ? { id: Number(row.renewal_id), adapterKey: row.adapter_key,
        state: row.renewal_state, planHash: row.plan_hash, rollbackOnFailure: !!row.rollback_on_failure,
        approvedAt: row.approved_at, completedAt: row.completed_at } : null,
    }));
}
function overview(host, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id);
  _refreshExceptionStates(database, host.id);
  const rows = database.prepare(`SELECT * FROM provider_security_findings WHERE host_id=?
    ORDER BY priority_score DESC,updated_at DESC LIMIT 500`).all(Number(host.id));
  const findings = rows.map(row => _findingRow(database, row));
  const validations = database.prepare(`SELECT id,document_kind,document_hash,state,reference_hashes_json,
    findings_json,created_at FROM provider_secret_reference_validations WHERE host_id=?
    ORDER BY created_at DESC LIMIT 100`).all(Number(host.id)).map(row => ({ id: row.id,
    documentKind: row.document_kind, documentHash: row.document_hash, state: row.state,
    referenceCount: _json(row.reference_hashes_json, []).length,
    findings: _json(row.findings_json, []), createdAt: row.created_at }));
  const counts = Object.fromEntries(['open', 'excepted', 'planned', 'remediated'].map(state => [state,
    findings.filter(item => item.state === state).length]));
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), hostId: Number(host.id),
    counts, findings, certificateRotation: _certificateRotation(database, host.id), validations,
    automation: { enabled: _automationEnabled(options), allowlistedActions: [...AUTOMATED_ACTIONS],
      adapterRequired: true, executionAuthorized: false },
    limitations: ['Advisory correlation uses previously ingested official-catalog evidence; no web request is made.',
      'Certificate renewal execution remains in the approval-bound lifecycle renewal workflow.',
      'Low-risk remediation requires a separate release flag, current plan, canary, adapter and verification.'] };
}

module.exports = {
  ProviderSecurityLifecycleError, ACTION_RISK, correlate, overview, createException,
  revokeException, planRemediation, executeLowRisk, validateSecretReferences,
  _internals: { _advisoryMetadata, _priority, _confidence, _validateReferences, _canonical },
};
