'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,159}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:+/@ -]{0,299}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;

class LifecycleUpdatesError extends Error {
  constructor(message, status = 400, code = 'LIFECYCLE_UPDATES_ERROR', details) {
    super(message); this.name = 'LifecycleUpdatesError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new LifecycleUpdatesError(message, status, code, details);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const string = (value, key, max = 300, pattern) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
  return result;
};
const optionalString = (value, key, max = 300, pattern) => value == null || value === '' ? null : string(value, key, max, pattern);
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
const number = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw fail(`${key} must be between ${min} and ${max}`); return result;
};
function bounded(value, key, max = 512 * 1024) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'LIFECYCLE_EVIDENCE_TOO_LARGE');
}
function secretFree(value, path = 'evidence') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'LIFECYCLE_SECRET_FIELD');
    secretFree(child, `${path}.${key}`);
  }
}
function iso(value, key, allowFuture = true) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) throw fail(`${key} must be an ISO timestamp`);
  if (!allowFuture && date.getTime() > Date.now() + 5 * 60000) throw fail(`${key} may not be in the future`);
  return date.toISOString();
}
function dateValue(value, key) {
  if (value == null || value === '') return null;
  const result = string(value, key, 10, DATE); if (Number.isNaN(Date.parse(`${result}T00:00:00Z`))) throw fail(`${key} is not a calendar date`);
  return result;
}
function httpsUrl(value, key = 'sourceUrl') {
  const result = string(value, key, 1000); let parsed;
  try { parsed = new URL(result); } catch { throw fail(`${key} must be a valid URL`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw fail(`${key} must be an HTTPS URL without embedded credentials`);
  return parsed.toString();
}
function stringList(value, key, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw fail(`${key} must contain at most ${max} values`);
  return value.map((item, index) => string(item, `${key}[${index}]`, 500));
}
function inventoryRow(row) { return row && { id: row.id, providerHostId: row.provider_host_id,
  componentType: row.component_type, vendor: row.vendor, product: row.product, version: row.version,
  build: row.build, source: row.source, evidenceHash: row.evidence_hash, observedAt: row.observed_at,
  createdAt: row.created_at, ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(row.observed_at)) / 1000)) }; }
function supportRow(row, at = new Date()) {
  if (!row) return null; const now = at.getTime(); const eol = row.eol_date ? Date.parse(`${row.eol_date}T00:00:00Z`) : null;
  const eos = row.eos_date ? Date.parse(`${row.eos_date}T00:00:00Z`) : null;
  const state = eos && eos <= now ? 'unsupported' : eol && eol <= now ? 'eol' : 'supported';
  const boundary = state === 'supported' ? eol || eos : state === 'eol' ? eos : null;
  return { id: row.id, vendor: row.vendor, product: row.product, versionLine: row.version_line,
    gaDate: row.ga_date, eolDate: row.eol_date, eosDate: row.eos_date, recommendedTarget: row.recommended_target,
    sourceUrl: row.source_url, sourcePublishedAt: row.source_published_at, retrievedAt: row.retrieved_at, state,
    daysToBoundary: boundary == null ? null : Math.ceil((boundary - now) / 86400000), updatedAt: row.updated_at };
}
function pathRow(row) { return row && { id: row.id, vendor: row.vendor, product: row.product,
  fromVersion: row.from_version, toVersion: row.to_version, supportedHops: parse(row.supported_hops_json, []),
  prerequisites: parse(row.prerequisites_json, []), blockers: parse(row.blockers_json, []), sourceUrl: row.source_url,
  createdAt: row.created_at }; }
function catalogRow(row) { return row && { id: row.id, vendor: row.vendor, product: row.product,
  advisoryId: row.advisory_id, title: row.title, updateKind: row.update_kind, targetVersion: row.target_version,
  severity: row.severity, publishedAt: row.published_at, sourceUrl: row.source_url, sourceDigest: row.source_digest,
  metadata: parse(row.metadata_json, {}), ingestedAt: row.ingested_at }; }

class LifecycleUpdatesService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  recordInventory(body = {}, actor) {
    this._admin(actor); const componentType = body.componentType;
    if (!['host', 'control_plane', 'tool', 'firmware'].includes(componentType)) throw fail('componentType is invalid');
    const evidence = object(body.evidence); bounded(evidence, 'evidence'); secretFree(evidence);
    const record = { providerHostId: integer(body.providerHostId ?? 0, 'providerHostId'), componentType,
      vendor: string(body.vendor, 'vendor', 160, SAFE_NAME), product: string(body.product, 'product', 160, SAFE_NAME),
      version: string(body.version, 'version', 160, SAFE_REF), build: optionalString(body.build, 'build', 160, SAFE_REF),
      source: string(body.source, 'source', 160, SAFE_REF), observedAt: iso(body.observedAt || new Date(), 'observedAt', false) };
    const evidenceHash = hash({ ...record, evidence }); const db = this._db();
    db.prepare(`INSERT INTO lifecycle_version_inventory
      (provider_host_id,component_type,vendor,product,version,build,source,evidence_hash,observed_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_host_id,component_type,vendor,product) DO UPDATE SET
      version=excluded.version,build=excluded.build,source=excluded.source,evidence_hash=excluded.evidence_hash,
      observed_at=excluded.observed_at,created_by=excluded.created_by,created_at=datetime('now')`)
      .run(record.providerHostId, record.componentType, record.vendor, record.product, record.version, record.build,
        record.source, evidenceHash, record.observedAt, actor.id);
    return inventoryRow(db.prepare(`SELECT * FROM lifecycle_version_inventory
      WHERE provider_host_id=? AND component_type=? AND vendor=? AND product=?`).get(record.providerHostId,
      record.componentType, record.vendor, record.product));
  }
  inventory(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_version_inventory ORDER BY observed_at DESC,id DESC').all().map(inventoryRow); }
  saveSupport(body = {}, actor) {
    this._admin(actor); const ga = dateValue(body.gaDate, 'gaDate'); const eol = dateValue(body.eolDate, 'eolDate');
    const eos = dateValue(body.eosDate, 'eosDate');
    if (ga && eol && ga > eol) throw fail('gaDate must not be after eolDate');
    if (eol && eos && eol > eos) throw fail('eolDate must not be after eosDate');
    const values = [string(body.vendor, 'vendor', 160, SAFE_NAME), string(body.product, 'product', 160, SAFE_NAME),
      string(body.versionLine, 'versionLine', 160, SAFE_REF), ga, eol, eos,
      optionalString(body.recommendedTarget, 'recommendedTarget', 160, SAFE_REF), httpsUrl(body.sourceUrl),
      body.sourcePublishedAt ? iso(body.sourcePublishedAt, 'sourcePublishedAt') : null,
      iso(body.retrievedAt || new Date(), 'retrievedAt', false), actor.id];
    const db = this._db(); db.prepare(`INSERT INTO lifecycle_support_registry
      (vendor,product,version_line,ga_date,eol_date,eos_date,recommended_target,source_url,source_published_at,retrieved_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor,product,version_line) DO UPDATE SET ga_date=excluded.ga_date,
      eol_date=excluded.eol_date,eos_date=excluded.eos_date,recommended_target=excluded.recommended_target,
      source_url=excluded.source_url,source_published_at=excluded.source_published_at,retrieved_at=excluded.retrieved_at,
      created_by=excluded.created_by,updated_at=datetime('now')`).run(...values);
    return supportRow(db.prepare('SELECT * FROM lifecycle_support_registry WHERE vendor=? AND product=? AND version_line=?').get(...values.slice(0, 3)));
  }
  supportRegistry(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_support_registry ORDER BY vendor,product,version_line').all().map(row => supportRow(row)); }
  saveUpgradePath(body = {}, actor) {
    this._admin(actor); const hops = stringList(body.supportedHops, 'supportedHops', 20); if (!hops.length) throw fail('supportedHops is required');
    const prerequisites = stringList(body.prerequisites, 'prerequisites', 100); const blockers = stringList(body.blockers, 'blockers', 100);
    const values = [string(body.vendor, 'vendor', 160, SAFE_NAME), string(body.product, 'product', 160, SAFE_NAME),
      string(body.fromVersion, 'fromVersion', 160, SAFE_REF), string(body.toVersion, 'toVersion', 160, SAFE_REF),
      stable(hops), stable(prerequisites), stable(blockers), httpsUrl(body.sourceUrl), actor.id]; const db = this._db();
    db.prepare(`INSERT INTO lifecycle_upgrade_paths
      (vendor,product,from_version,to_version,supported_hops_json,prerequisites_json,blockers_json,source_url,created_by)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor,product,from_version,to_version) DO UPDATE SET
      supported_hops_json=excluded.supported_hops_json,prerequisites_json=excluded.prerequisites_json,
      blockers_json=excluded.blockers_json,source_url=excluded.source_url,created_by=excluded.created_by,created_at=datetime('now')`).run(...values);
    return pathRow(db.prepare(`SELECT * FROM lifecycle_upgrade_paths WHERE vendor=? AND product=? AND from_version=? AND to_version=?`).get(...values.slice(0, 4)));
  }
  upgradePaths(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_upgrade_paths ORDER BY vendor,product,from_version').all().map(pathRow); }
  advise(inventoryId, targetVersionValue, actor) {
    this._admin(actor); const inventory = inventoryRow(this._db().prepare('SELECT * FROM lifecycle_version_inventory WHERE id=?').get(integer(inventoryId, 'inventoryId', 1)));
    if (!inventory) throw fail('Version inventory item not found', 404, 'INVENTORY_NOT_FOUND');
    const targetVersion = string(targetVersionValue, 'targetVersion', 160, SAFE_REF); const db = this._db();
    const path = pathRow(db.prepare(`SELECT * FROM lifecycle_upgrade_paths WHERE vendor=? AND product=? AND from_version=? AND to_version=?`)
      .get(inventory.vendor, inventory.product, inventory.version, targetVersion));
    const targetSupport = supportRow(db.prepare(`SELECT * FROM lifecycle_support_registry WHERE vendor=? AND product=?
      AND (version_line=? OR ? LIKE version_line || '%') ORDER BY length(version_line) DESC LIMIT 1`).get(inventory.vendor, inventory.product, targetVersion, targetVersion));
    const blockers = []; if (!path) blockers.push({ code: 'PATH_NOT_REGISTERED', message: 'No vendor-supported upgrade path is registered' });
    else blockers.push(...path.blockers.map(message => ({ code: 'VENDOR_BLOCKER', message })));
    if (targetSupport?.state === 'unsupported') blockers.push({ code: 'TARGET_UNSUPPORTED', message: 'Target version is beyond end of support' });
    if (inventory.ageSeconds > 86400) blockers.push({ code: 'INVENTORY_STALE', message: 'Version inventory is older than 24 hours' });
    const advisories = db.prepare(`SELECT * FROM lifecycle_update_catalog WHERE vendor=? AND product=?
      AND (target_version IS NULL OR target_version=?) ORDER BY published_at DESC LIMIT 100`).all(inventory.vendor, inventory.product, targetVersion).map(catalogRow);
    return { inventory, targetVersion, path, targetSupport, prerequisites: path?.prerequisites || [], blockers,
      advisories, status: blockers.length ? 'blocked' : 'advisory_ready', upgradeStarted: false };
  }
  ingestCatalog(body = {}, actor) {
    this._admin(actor); const vendor = string(body.vendor, 'vendor', 160, SAFE_NAME);
    const product = string(body.product, 'product', 160, SAFE_NAME); const sourceUrl = httpsUrl(body.sourceUrl);
    if (body.sourceKind !== 'official_vendor') throw fail('sourceKind must be official_vendor', 400, 'CATALOG_SOURCE_NOT_OFFICIAL');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw fail('items must contain 1-200 entries');
    const db = this._db(); let created = 0; let updated = 0; const stored = [];
    db.transaction(() => {
      for (const [index, item] of body.items.entries()) {
        const kind = item?.updateKind; if (!['advisory', 'package', 'bundle', 'firmware'].includes(kind)) throw fail(`items[${index}].updateKind is invalid`);
        const severity = item.severity || 'info'; if (!['info', 'low', 'medium', 'high', 'critical'].includes(severity)) throw fail(`items[${index}].severity is invalid`);
        const metadata = object(item.metadata); bounded(metadata, `items[${index}].metadata`, 64 * 1024); secretFree(metadata, `items[${index}].metadata`);
        const normalized = { advisoryId: string(item.advisoryId, `items[${index}].advisoryId`, 160, SAFE_REF),
          title: string(item.title, `items[${index}].title`, 500), updateKind: kind,
          targetVersion: optionalString(item.targetVersion, `items[${index}].targetVersion`, 160, SAFE_REF), severity,
          publishedAt: iso(item.publishedAt, `items[${index}].publishedAt`), metadata: canonical(metadata) };
        const exists = db.prepare('SELECT id FROM lifecycle_update_catalog WHERE vendor=? AND product=? AND advisory_id=?').get(vendor, product, normalized.advisoryId);
        db.prepare(`INSERT INTO lifecycle_update_catalog
          (vendor,product,advisory_id,title,update_kind,target_version,severity,published_at,source_url,source_digest,metadata_json,ingested_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor,product,advisory_id) DO UPDATE SET title=excluded.title,
          update_kind=excluded.update_kind,target_version=excluded.target_version,severity=excluded.severity,
          published_at=excluded.published_at,source_url=excluded.source_url,source_digest=excluded.source_digest,
          metadata_json=excluded.metadata_json,ingested_by=excluded.ingested_by,ingested_at=datetime('now')`)
          .run(vendor, product, normalized.advisoryId, normalized.title, normalized.updateKind, normalized.targetVersion,
            normalized.severity, normalized.publishedAt, sourceUrl, hash({ sourceUrl, normalized }), stable(normalized.metadata), actor.id);
        exists ? updated++ : created++;
        stored.push(catalogRow(db.prepare('SELECT * FROM lifecycle_update_catalog WHERE vendor=? AND product=? AND advisory_id=?').get(vendor, product, normalized.advisoryId)));
      }
    })();
    return { vendor, product, sourceKind: 'official_vendor', sourceUrl, created, updated, items: stored, packagesInstalled: 0 };
  }
  catalog(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_update_catalog ORDER BY published_at DESC,id DESC LIMIT 1000').all().map(catalogRow); }
  runPrecheck(body = {}, actor) {
    this._admin(actor); const inventoryId = integer(body.inventoryId, 'inventoryId', 1);
    const targetVersion = string(body.targetVersion, 'targetVersion', 160, SAFE_REF); const evidence = object(body.evidence);
    bounded(evidence, 'evidence'); secretFree(evidence); const db = this._db();
    const inventory = inventoryRow(db.prepare('SELECT * FROM lifecycle_version_inventory WHERE id=?').get(inventoryId));
    if (!inventory) throw fail('Version inventory item not found', 404, 'INVENTORY_NOT_FOUND');
    const health = object(evidence.health); const capacity = object(evidence.capacity); const backup = object(evidence.backup);
    const compatibility = object(evidence.compatibility); const freeSpace = object(evidence.freeSpace);
    const maxBackupAge = integer(body.maxBackupAgeHours ?? 24, 'maxBackupAgeHours', 1, 720);
    const results = [
      { check: 'health', passed: health.healthy === true || ['healthy', 'ok'].includes(health.status), detail: health.status || (health.healthy ? 'healthy' : 'not healthy') },
      { check: 'capacity', passed: number(capacity.headroomPercent ?? 0, 'evidence.capacity.headroomPercent', 0, 100) >= number(capacity.requiredHeadroomPercent ?? 20, 'evidence.capacity.requiredHeadroomPercent', 0, 100), detail: `${capacity.headroomPercent ?? 0}% headroom` },
      { check: 'backup', passed: backup.verified === true && number(backup.ageHours ?? Number.MAX_SAFE_INTEGER, 'evidence.backup.ageHours', 0) <= maxBackupAge, detail: backup.verified ? `${backup.ageHours}h old` : 'backup is not verified' },
      { check: 'compatibility', passed: compatibility.compatible === true, detail: compatibility.reason || (compatibility.compatible ? 'compatible' : 'not confirmed') },
      { check: 'free_space', passed: number(freeSpace.availableBytes ?? 0, 'evidence.freeSpace.availableBytes', 0) >= number(freeSpace.requiredBytes ?? 1, 'evidence.freeSpace.requiredBytes', 1), detail: `${freeSpace.availableBytes ?? 0}/${freeSpace.requiredBytes ?? 1} bytes` },
      { check: 'inventory_freshness', passed: inventory.ageSeconds <= 86400, detail: `${inventory.ageSeconds}s old` },
    ];
    const status = results.every(result => result.passed) ? 'ready' : 'blocked'; const evidenceHash = hash({ inventoryId, targetVersion, evidence });
    const expiresAt = new Date(Date.now() + integer(body.validForMinutes ?? 120, 'validForMinutes', 5, 1440) * 60000).toISOString();
    const saved = db.prepare(`INSERT INTO lifecycle_upgrade_prechecks
      (inventory_id,target_version,evidence_hash,status,results_json,expires_at,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(inventoryId, targetVersion, evidenceHash, status, stable(results), expiresAt, actor.id);
    return { id: Number(saved.lastInsertRowid), inventoryId, targetVersion, evidenceHash, status, results, expiresAt,
      upgradeStarted: false, createdAt: db.prepare('SELECT created_at FROM lifecycle_upgrade_prechecks WHERE id=?').get(saved.lastInsertRowid).created_at };
  }
  prechecks(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_upgrade_prechecks ORDER BY id DESC LIMIT 500').all()
    .map(row => ({ id: row.id, inventoryId: row.inventory_id, targetVersion: row.target_version,
      evidenceHash: row.evidence_hash, status: row.status, results: parse(row.results_json, []),
      expiresAt: row.expires_at, createdAt: row.created_at, stale: Date.parse(row.expires_at) <= Date.now() })); }
  overview(actor) {
    this._admin(actor); const inventory = this.inventory(actor); const supportRegistry = this.supportRegistry(actor);
    const prechecks = this.prechecks(actor); return { capabilities: { versionBuildInventory: true, supportLifecycleRegistry: true,
      upgradePathAdvisor: true, officialUpdateCatalogIngestion: true, upgradePrecheckFramework: true,
      automaticUpgradeExecution: false }, inventory, supportRegistry, upgradePaths: this.upgradePaths(actor),
    catalog: this.catalog(actor), prechecks, summary: { inventoryItems: inventory.length,
      staleInventory: inventory.filter(item => item.ageSeconds > 86400).length,
      unsupportedVersions: supportRegistry.filter(item => item.state === 'unsupported').length,
      criticalUpdates: this.catalog(actor).filter(item => item.severity === 'critical').length,
      readyPrechecks: prechecks.filter(item => item.status === 'ready' && !item.stale).length } };
  }
}

const service = new LifecycleUpdatesService();
module.exports = service;
module.exports.LifecycleUpdatesService = LifecycleUpdatesService;
module.exports.LifecycleUpdatesError = LifecycleUpdatesError;
module.exports._internals = { canonical, stable, hash, supportRow, httpsUrl };
