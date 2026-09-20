'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

class PlatformFoundationError extends Error {
  constructor(message, status = 400, code = 'PLATFORM_FOUNDATION_ERROR', details) {
    super(message); this.name = 'PlatformFoundationError'; this.status = status; this.code = code; this.details = details;
  }
}
const fail = (message, status, code, details) => new PlatformFoundationError(message, status, code, details);
const FIELD = /^[a-zA-Z][a-zA-Z0-9_.:/@+-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const FORBIDDEN = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token/i;
const PROFILE_FORBIDDEN = /script|command|user.?data|private.?key|password|credential/i;
const FORMATS = ['iso','qcow2','vmdk','vhdx','raw','vhd','ova'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const string = (value, field, max = 300) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw fail(`${field} is invalid`);
  return result;
};
const key = (value, field) => { const result = string(value, field, 160); if (!FIELD.test(result)) throw fail(`${field} is invalid`); return result; };
const integer = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${field} is invalid`); return result;
};
const number = (value, field, min, max) => {
  const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw fail(`${field} is invalid`); return result;
};
const choice = (value, field, values) => { const result = String(value || ''); if (!values.includes(result)) throw fail(`${field} is invalid`); return result; };
const checksum = (value, field) => { const result = String(value || '').toLowerCase(); if (!HASH.test(result)) throw fail(`${field} is invalid`); return result; };
const bool = (value, field) => { if (typeof value !== 'boolean') throw fail(`${field} is invalid`); return value; };
const instant = (value, field) => { const result = string(value, field, 40); if (!Number.isFinite(Date.parse(result))) throw fail(`${field} is invalid`); return new Date(result).toISOString(); };
function exact(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${field} is invalid`);
  const unexpected = Object.keys(value).filter(item => !allowed.includes(item));
  if (unexpected.length) {
    const secret = unexpected.find(item => FORBIDDEN.test(item));
    throw fail(secret ? `${field}.${secret} may not contain secret material` : `Unexpected ${field} fields: ${unexpected.join(', ')}`,
      400, secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
  return value;
}
function safeObject(value, field, maxBytes = 128 * 1024, forbidden = FORBIDDEN) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(stable(value)) > maxBytes) throw fail(`${field} is invalid`);
  const walk = (node, path, depth = 0) => {
    if (depth > 8) throw fail(`${field} is too deeply nested`);
    if (!node || typeof node !== 'object') return;
    for (const [childKey, child] of Object.entries(node)) {
      if (forbidden.test(childKey)) throw fail(`${path}.${childKey} is not allowed`, 400, 'SECRET_FIELD');
      walk(child, `${path}.${childKey}`, depth + 1);
    }
  };
  walk(value, field); return canonical(value);
}
function boundedArray(value, field, max, mapper) {
  if (!Array.isArray(value) || value.length > max) throw fail(`${field} is invalid`);
  return value.map((item, index) => mapper(item, index));
}
function safeRegex(value) {
  const source = string(value, 'selector.value', 120);
  if (/\\[1-9]|\(\?|\([^)]*[+*][^)]*\)[+*{]|\{\d{4,}/.test(source)) throw fail('selector regex is unsafe', 400, 'UNSAFE_REGEX');
  try { return new RegExp(source, 'i'); } catch { throw fail('selector regex is invalid'); }
}

class PlatformFoundationService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) { if (!actor?.id) throw fail('Authentication required', 401); if (actor.role !== 'admin') throw fail('Administrator required', 403); }
  _row(table, idValue, label) {
    const id = integer(idValue, `${label}Id`, 1); const row = this._db().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) throw fail(`${label} not found`, 404, 'NOT_FOUND'); return row;
  }
  _deltaResource(item, index, field) {
    exact(item, `${field}[${index}]`, ['resourceKey','version','etag','payloadHash']);
    return { resourceKey: key(item.resourceKey, `${field}[${index}].resourceKey`), version: string(item.version, `${field}[${index}].version`, 100),
      etag: item.etag == null ? null : string(item.etag, `${field}[${index}].etag`, 160),
      payloadHash: item.payloadHash == null ? null : checksum(item.payloadHash, `${field}[${index}].payloadHash`) };
  }

  recordEvent(body, actor) {
    this._admin(actor); exact(body, 'event', ['providerHostId','providerType','cursor','nativeEventId','eventType','severity','resourceKey','occurredAt','message','attributes']);
    const event = { providerHostId: integer(body.providerHostId, 'providerHostId', 1), providerType: key(body.providerType, 'providerType'),
      cursor: string(body.cursor, 'cursor', 300), nativeEventId: body.nativeEventId == null ? null : string(body.nativeEventId, 'nativeEventId', 300),
      eventType: key(body.eventType, 'eventType'), severity: choice(body.severity, 'severity', ['debug','info','warning','error','critical']),
      resourceKey: body.resourceKey == null ? null : key(body.resourceKey, 'resourceKey'), occurredAt: instant(body.occurredAt, 'occurredAt'),
      message: string(body.message, 'message', 2000), attributes: safeObject(body.attributes || {}, 'attributes', 32 * 1024) };
    const fingerprint = hash({ providerHostId: event.providerHostId, identity: event.nativeEventId || event.cursor, eventType: event.eventType, resourceKey: event.resourceKey });
    const db = this._db(); const byCursor = db.prepare('SELECT id,fingerprint FROM normalized_provider_events WHERE provider_host_id=? AND cursor=?').get(event.providerHostId, event.cursor);
    if (byCursor && byCursor.fingerprint !== fingerprint) throw fail('Event cursor already identifies different evidence', 409, 'CURSOR_CONFLICT');
    const found = byCursor || db.prepare('SELECT id,fingerprint FROM normalized_provider_events WHERE fingerprint=?').get(fingerprint);
    if (found) return { id: found.id, ...event, fingerprint, duplicate: true };
    const saved = db.prepare(`INSERT INTO normalized_provider_events
      (provider_host_id,provider_type,cursor,native_event_id,event_type,severity,resource_key,occurred_at,message,attributes_json,fingerprint,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.providerHostId,event.providerType,event.cursor,event.nativeEventId,event.eventType,event.severity,event.resourceKey,event.occurredAt,event.message,stable(event.attributes),fingerprint,actor.id);
    return { id: Number(saved.lastInsertRowid), ...event, fingerprint, duplicate: false };
  }

  recordInventoryDelta(body, actor) {
    this._admin(actor); exact(body, 'inventoryDelta', ['providerHostId','resourceType','previousCursor','cursor','added','updated','removed']);
    const providerHostId = integer(body.providerHostId, 'providerHostId', 1); const resourceType = key(body.resourceType, 'resourceType');
    const previousCursor = body.previousCursor == null ? null : string(body.previousCursor, 'previousCursor', 300); const cursor = string(body.cursor, 'cursor', 300);
    if (cursor === previousCursor) throw fail('cursor must advance', 409, 'CURSOR_NOT_ADVANCED');
    const added = boundedArray(body.added || [], 'added', 5000, (item,index) => this._deltaResource(item,index,'added'));
    const updated = boundedArray(body.updated || [], 'updated', 5000, (item,index) => this._deltaResource(item,index,'updated'));
    const removed = boundedArray(body.removed || [], 'removed', 5000, (item,index) => key(typeof item === 'string' ? item : item?.resourceKey, `removed[${index}]`));
    const keys = [...added,...updated].map(item => item.resourceKey).concat(removed); if (new Set(keys).size !== keys.length) throw fail('Delta contains duplicate resource keys');
    const db = this._db(); const duplicate = db.prepare('SELECT id,delta_hash FROM inventory_delta_syncs WHERE provider_host_id=? AND resource_type=? AND cursor=?').get(providerHostId,resourceType,cursor);
    if (duplicate) return { id: duplicate.id, providerHostId, resourceType, previousCursor, cursor, added, updated, removed, deltaHash: duplicate.delta_hash, duplicate: true };
    const latest = db.prepare('SELECT cursor FROM inventory_delta_syncs WHERE provider_host_id=? AND resource_type=? ORDER BY id DESC LIMIT 1').get(providerHostId,resourceType);
    if ((latest?.cursor || null) !== previousCursor) throw fail('Inventory cursor continuity check failed', 409, 'CURSOR_GAP', { expectedPreviousCursor: latest?.cursor || null });
    const deltaHash = hash({ providerHostId,resourceType,previousCursor,cursor,added,updated,removed });
    const saved = db.prepare('INSERT INTO inventory_delta_syncs (provider_host_id,resource_type,previous_cursor,cursor,added_json,updated_json,removed_json,delta_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(providerHostId,resourceType,previousCursor,cursor,stable(added),stable(updated),stable(removed),deltaHash,actor.id);
    return { id: Number(saved.lastInsertRowid), providerHostId,resourceType,previousCursor,cursor,added,updated,removed,deltaHash,duplicate:false };
  }

  saveCollection(body, actor) {
    this._admin(actor); exact(body, 'collection', ['name','selectors','expectedVersion']); const name = string(body.name, 'name', 120);
    const selectors = boundedArray(body.selectors, 'selectors', 20, (item,index) => {
      exact(item, `selectors[${index}]`, ['field','operator','value']); const field = choice(item.field, 'selector.field', ['kind','name','providerType','site','state','tag']);
      const operator = choice(item.operator, 'selector.operator', ['equals','contains','in','regex']);
      const value = operator === 'in' ? boundedArray(item.value, 'selector.value', 50, (entry) => string(entry, 'selector.value', 160)) : string(item.value, 'selector.value', 160);
      if (operator === 'regex') safeRegex(value); return { field,operator,value };
    });
    if (!selectors.length) throw fail('selectors must not be empty'); const db = this._db(); const existing = db.prepare('SELECT * FROM dynamic_resource_collections WHERE name=?').get(name);
    const expectedVersion = body.expectedVersion == null ? null : integer(body.expectedVersion, 'expectedVersion', 1);
    if (existing && expectedVersion !== existing.version) throw fail('Collection version conflict', 409, 'VERSION_CONFLICT', { currentVersion: existing.version });
    if (!existing && expectedVersion != null) throw fail('Collection does not exist', 409, 'VERSION_CONFLICT');
    const version = existing ? existing.version + 1 : 1; const definitionHash = hash({ name,selectors,version });
    if (existing) db.prepare("UPDATE dynamic_resource_collections SET selectors_json=?,version=?,definition_hash=?,updated_at=datetime('now') WHERE id=?").run(stable(selectors),version,definitionHash,existing.id);
    else db.prepare('INSERT INTO dynamic_resource_collections (name,selectors_json,version,definition_hash,created_by) VALUES (?,?,?,?,?)').run(name,stable(selectors),version,definitionHash,actor.id);
    return { id: existing?.id || db.prepare('SELECT id FROM dynamic_resource_collections WHERE name=?').get(name).id, name,selectors,version,definitionHash };
  }

  evaluateCollection(idValue, body, actor) {
    this._admin(actor); exact(body, 'collectionEvaluation', ['resources']); const row = this._row('dynamic_resource_collections', idValue, 'Collection');
    const selectors = JSON.parse(row.selectors_json); const resources = boundedArray(body.resources, 'resources', 5000, (item,index) => {
      exact(item, `resources[${index}]`, ['resourceKey','kind','name','providerType','site','state','tags']);
      return { resourceKey:key(item.resourceKey,'resourceKey'),kind:key(item.kind,'kind'),name:string(item.name,'name',300),providerType:key(item.providerType,'providerType'),
        site:string(item.site,'site',160),state:key(item.state,'state'),tags:boundedArray(item.tags || [],'tags',100, tag => string(tag,'tag',160)) };
    });
    const matchesSelector = (resource, selector) => {
      const actual = selector.field === 'tag' ? resource.tags : resource[selector.field]; const values = Array.isArray(actual) ? actual : [actual];
      if (selector.operator === 'equals') return values.some(value => String(value) === selector.value);
      if (selector.operator === 'contains') return values.some(value => String(value).toLowerCase().includes(selector.value.toLowerCase()));
      if (selector.operator === 'in') return values.some(value => selector.value.includes(String(value)));
      const regex = safeRegex(selector.value); return values.some(value => regex.test(String(value)));
    };
    const members = resources.filter(resource => selectors.every(selector => matchesSelector(resource,selector))).map(resource => resource.resourceKey);
    return { collectionId: row.id, definitionHash: row.definition_hash, evaluatedResources: resources.length, members, evaluationHash: hash({ definitionHash:row.definition_hash,resources,members }) };
  }

  saveMetadataSchema(body, actor) {
    this._admin(actor); exact(body, 'metadataSchema', ['schemaKey','label','valueType','resourceTypes','required','enumValues','sensitivity','expectedVersion']);
    const schemaKey = key(body.schemaKey, 'schemaKey'); const label = string(body.label, 'label', 120); const valueType = choice(body.valueType,'valueType',['string','integer','boolean','enum','url','date']);
    const resourceTypes = boundedArray(body.resourceTypes,'resourceTypes',30,item=>key(item,'resourceType')); if (!resourceTypes.length) throw fail('resourceTypes must not be empty');
    const required = bool(body.required,'required'); const enumValues = boundedArray(body.enumValues || [],'enumValues',100,item=>string(item,'enumValue',160));
    if (valueType === 'enum' && !enumValues.length) throw fail('enumValues are required for enum metadata'); if (valueType !== 'enum' && enumValues.length) throw fail('enumValues require enum metadata');
    const sensitivity = choice(body.sensitivity,'sensitivity',['public','internal','confidential']); const db = this._db(); const existing = db.prepare('SELECT * FROM custom_metadata_schemas WHERE schema_key=?').get(schemaKey);
    const expectedVersion = body.expectedVersion == null ? null : integer(body.expectedVersion,'expectedVersion',1);
    if (existing && expectedVersion !== existing.version) throw fail('Metadata schema version conflict',409,'VERSION_CONFLICT',{currentVersion:existing.version});
    if (!existing && expectedVersion != null) throw fail('Metadata schema does not exist',409,'VERSION_CONFLICT');
    const version = existing ? existing.version + 1 : 1; const schemaHash = hash({schemaKey,label,valueType,resourceTypes,required,enumValues,sensitivity,version});
    if (existing) db.prepare("UPDATE custom_metadata_schemas SET label=?,value_type=?,resource_types_json=?,required=?,enum_values_json=?,sensitivity=?,version=?,schema_hash=?,updated_at=datetime('now') WHERE id=?")
      .run(label,valueType,stable(resourceTypes),required?1:0,stable(enumValues),sensitivity,version,schemaHash,existing.id);
    else db.prepare('INSERT INTO custom_metadata_schemas (schema_key,label,value_type,resource_types_json,required,enum_values_json,sensitivity,version,schema_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(schemaKey,label,valueType,stable(resourceTypes),required?1:0,stable(enumValues),sensitivity,version,schemaHash,actor.id);
    return { id:existing?.id || db.prepare('SELECT id FROM custom_metadata_schemas WHERE schema_key=?').get(schemaKey).id,schemaKey,label,valueType,resourceTypes,required,enumValues,sensitivity,version,schemaHash };
  }

  setMetadata(resourceKeyValue, schemaKeyValue, body, actor) {
    this._admin(actor); exact(body,'metadataValue',['resourceType','value','expectedVersion']); const resourceKey = key(resourceKeyValue,'resourceKey'); const schemaKey = key(schemaKeyValue,'schemaKey');
    const resourceType = key(body.resourceType,'resourceType'); const db = this._db(); const schema = db.prepare('SELECT * FROM custom_metadata_schemas WHERE schema_key=?').get(schemaKey);
    if (!schema) throw fail('Metadata schema not found',404,'NOT_FOUND'); if (!JSON.parse(schema.resource_types_json).includes(resourceType)) throw fail('Metadata schema does not apply to resource type');
    let value = body.value;
    if (schema.value_type === 'string') value = string(value,'value',500);
    else if (schema.value_type === 'integer') value = integer(value,'value',-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
    else if (schema.value_type === 'boolean') value = bool(value,'value');
    else if (schema.value_type === 'enum') { value = string(value,'value',160); if (!JSON.parse(schema.enum_values_json).includes(value)) throw fail('value is not in enumValues'); }
    else if (schema.value_type === 'url') { value = string(value,'value',500); let parsed; try { parsed = new URL(value); } catch { throw fail('value is not a valid URL'); } if (!['http:','https:'].includes(parsed.protocol)) throw fail('value URL must use HTTP(S)'); }
    else { value = string(value,'value',10); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw fail('value is not a valid date'); }
    const existing = db.prepare('SELECT version FROM custom_metadata_values WHERE resource_key=? AND schema_key=?').get(resourceKey,schemaKey);
    const expectedVersion = body.expectedVersion == null ? null : integer(body.expectedVersion,'expectedVersion',1);
    if (existing && expectedVersion !== existing.version) throw fail('Metadata value version conflict',409,'VERSION_CONFLICT',{currentVersion:existing.version});
    if (!existing && expectedVersion != null) throw fail('Metadata value does not exist',409,'VERSION_CONFLICT'); const version = existing ? existing.version + 1 : 1; const valueHash = hash({resourceKey,resourceType,schemaKey,value,version});
    db.prepare(`INSERT INTO custom_metadata_values (resource_key,resource_type,schema_key,value_json,version,value_hash,updated_by) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(resource_key,schema_key) DO UPDATE SET resource_type=excluded.resource_type,value_json=excluded.value_json,version=excluded.version,value_hash=excluded.value_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(resourceKey,resourceType,schemaKey,stable(value),version,valueHash,actor.id);
    return { resourceKey,resourceType,schemaKey,value,version,valueHash,sensitivity:schema.sensitivity };
  }

  recordRelationshipGraph(body, actor) {
    this._admin(actor); exact(body,'relationshipGraph',['observedAt','resources','edges']); const observedAt = instant(body.observedAt,'observedAt');
    const resources = boundedArray(body.resources,'resources',10000,(item,index)=>{ exact(item,`resources[${index}]`,['resourceKey','kind','name']); return {resourceKey:key(item.resourceKey,'resourceKey'),kind:key(item.kind,'kind'),name:string(item.name,'name',300)}; });
    const keys = new Set(resources.map(item=>item.resourceKey)); if (keys.size !== resources.length) throw fail('resources contain duplicate keys');
    const edges = boundedArray(body.edges,'edges',30000,(item,index)=>{ exact(item,`edges[${index}]`,['source','target','relationship']); const edge={source:key(item.source,'source'),target:key(item.target,'target'),relationship:key(item.relationship,'relationship')}; if (!keys.has(edge.source)||!keys.has(edge.target)||edge.source===edge.target) throw fail(`edges[${index}] has invalid endpoints`); return edge; });
    const graphHash=hash({resources,edges}); const found=this._db().prepare('SELECT id FROM resource_relationship_graphs WHERE graph_hash=?').get(graphHash);
    const id=found?.id || Number(this._db().prepare('INSERT INTO resource_relationship_graphs (observed_at,resources_json,edges_json,graph_hash,created_by) VALUES (?,?,?,?,?)').run(observedAt,stable(resources),stable(edges),graphHash,actor.id).lastInsertRowid);
    return {id,observedAt,resources,edges,graphHash,duplicate:Boolean(found)};
  }

  graphImpact(idValue, resourceKeyValue, actor) {
    this._admin(actor); const row=this._row('resource_relationship_graphs',idValue,'Relationship graph'); const resourceKey=key(resourceKeyValue,'resourceKey'); const resources=JSON.parse(row.resources_json); const edges=JSON.parse(row.edges_json);
    if (!resources.some(item=>item.resourceKey===resourceKey)) throw fail('Resource not found in graph',404,'NOT_FOUND'); const adjacency=new Map();
    for (const edge of edges) { if (!adjacency.has(edge.source)) adjacency.set(edge.source,[]); adjacency.get(edge.source).push({resourceKey:edge.target,relationship:edge.relationship}); }
    const queue=[{resourceKey,depth:0,path:[]}]; const seen=new Set([resourceKey]); const impacted=[]; while(queue.length){const current=queue.shift(); for(const next of adjacency.get(current.resourceKey)||[]){if(seen.has(next.resourceKey))continue;seen.add(next.resourceKey);const item={resourceKey:next.resourceKey,depth:current.depth+1,path:[...current.path,next.relationship]};impacted.push(item);if(item.depth<20)queue.push(item);}}
    return {graphId:row.id,graphHash:row.graph_hash,sourceResourceKey:resourceKey,impacted,cyclesSuppressed:true};
  }

  scanHygiene(body, actor) {
    this._admin(actor); exact(body,'hygieneScan',['scopeKey','resources']); const scopeKey=key(body.scopeKey,'scopeKey');
    const resources=boundedArray(body.resources,'resources',10000,(item,index)=>{exact(item,`resources[${index}]`,['resourceKey','kind','owner','attached','usageCount','ageDays']);return{resourceKey:key(item.resourceKey,'resourceKey'),kind:key(item.kind,'kind'),owner:item.owner==null?null:string(item.owner,'owner',160),attached:item.attached==null?null:bool(item.attached,'attached'),usageCount:item.usageCount==null?null:integer(item.usageCount,'usageCount'),ageDays:item.ageDays==null?null:integer(item.ageDays,'ageDays',0,100000)};});
    const findings=[]; for(const resource of resources){if(!resource.owner)findings.push({resourceKey:resource.resourceKey,code:'owner_missing',severity:'warning'});if(resource.kind==='disk'&&resource.attached===false)findings.push({resourceKey:resource.resourceKey,code:'detached_disk',severity:'warning'});if(['image','template'].includes(resource.kind)&&resource.usageCount===0&&(resource.ageDays||0)>=30)findings.push({resourceKey:resource.resourceKey,code:'unused_image',severity:'info'});}
    const summary={resources:resources.length,findings:findings.length,ownerMissing:findings.filter(item=>item.code==='owner_missing').length,detachedDisks:findings.filter(item=>item.code==='detached_disk').length,unusedImages:findings.filter(item=>item.code==='unused_image').length}; const scanHash=hash({scopeKey,resources,findings}); const found=this._db().prepare('SELECT id FROM resource_hygiene_scans WHERE scan_hash=?').get(scanHash);
    const id=found?.id||Number(this._db().prepare('INSERT INTO resource_hygiene_scans (scope_key,findings_json,summary_json,scan_hash,created_by) VALUES (?,?,?,?,?)').run(scopeKey,stable(findings),stable(summary),scanHash,actor.id).lastInsertRowid);return{id,scopeKey,findings,summary,scanHash,cleanupStarted:false,duplicate:Boolean(found)};
  }

  observeRateBudget(endpointKeyValue, body, actor) {
    this._admin(actor); exact(body,'rateBudget',['providerHostId','limit','remaining','resetAt','inFlight','latencyMs','errorRate']); const endpointKey=key(endpointKeyValue,'endpointKey'); const providerHostId=integer(body.providerHostId,'providerHostId',1); const limit=integer(body.limit,'limit',1,1000000000);const remaining=integer(body.remaining,'remaining',0,limit);const resetAt=instant(body.resetAt,'resetAt');const inFlight=integer(body.inFlight,'inFlight',0,100000);const latencyMs=integer(body.latencyMs,'latencyMs',0,3600000);const errorRate=number(body.errorRate,'errorRate',0,1);
    const ratio=remaining/limit;const state=remaining===0?'exhausted':(ratio<0.2||errorRate>=0.1?'degraded':'available');let recommendedConcurrency=state==='exhausted'?0:Math.max(1,Math.min(32,Math.floor(1+ratio*15)));if(errorRate>=0.1)recommendedConcurrency=Math.min(recommendedConcurrency,2);if(latencyMs>5000)recommendedConcurrency=Math.min(recommendedConcurrency,1);recommendedConcurrency=Math.max(0,recommendedConcurrency-inFlight);
    const observation={limit,remaining,resetAt,inFlight,latencyMs,errorRate,remainingRatio:Number(ratio.toFixed(4))};const budgetHash=hash({providerHostId,endpointKey,observation,state,recommendedConcurrency});const found=this._db().prepare('SELECT id FROM provider_rate_limit_budgets WHERE budget_hash=?').get(budgetHash);const id=found?.id||Number(this._db().prepare('INSERT INTO provider_rate_limit_budgets (provider_host_id,endpoint_key,observation_json,state,recommended_concurrency,budget_hash,created_by) VALUES (?,?,?,?,?,?,?)').run(providerHostId,endpointKey,stable(observation),state,recommendedConcurrency,budgetHash,actor.id).lastInsertRowid);return{id,providerHostId,endpointKey,observation,state,recommendedConcurrency,budgetHash,duplicate:Boolean(found)};
  }

  planLinkedClone(body, actor) {
    this._admin(actor); exact(body,'linkedClone',['providerType','sourceArtifactKey','targetName','currentStorage','targetStorage','backingDepth','sourceSnapshotState','capabilities']); const providerType=choice(body.providerType,'providerType',['proxmox','xapi','xen-orchestra','vsphere','openstack','cloudstack']);const sourceArtifactKey=key(body.sourceArtifactKey,'sourceArtifactKey');const targetName=string(body.targetName,'targetName',160);const currentStorage=key(body.currentStorage,'currentStorage');const targetStorage=key(body.targetStorage,'targetStorage');const backingDepth=integer(body.backingDepth,'backingDepth',0,128);const sourceSnapshotState=choice(body.sourceSnapshotState,'sourceSnapshotState',['clean','consolidating','locked','unknown']);exact(body.capabilities,'capabilities',['linkedClone','sharedBacking','maxBackingDepth','requiresSameStorage']);const capabilities={linkedClone:bool(body.capabilities.linkedClone,'linkedClone'),sharedBacking:bool(body.capabilities.sharedBacking,'sharedBacking'),maxBackingDepth:integer(body.capabilities.maxBackingDepth,'maxBackingDepth',1,128),requiresSameStorage:bool(body.capabilities.requiresSameStorage,'requiresSameStorage')};
    const blockers=[];if(!capabilities.linkedClone)blockers.push('linked_clone_unsupported');if(!capabilities.sharedBacking)blockers.push('shared_backing_unavailable');if(backingDepth+1>capabilities.maxBackingDepth)blockers.push('backing_depth_limit');if(capabilities.requiresSameStorage&&currentStorage!==targetStorage)blockers.push('same_storage_required');if(sourceSnapshotState!=='clean')blockers.push(`source_snapshot_${sourceSnapshotState}`);const state=blockers.length?'blocked':'ready';const planHash=hash({providerType,sourceArtifactKey,targetName,currentStorage,targetStorage,backingDepth:backingDepth+1,capabilities,blockers,state});const found=this._db().prepare('SELECT id FROM linked_clone_plans WHERE plan_hash=?').get(planHash);const id=found?.id||Number(this._db().prepare('INSERT INTO linked_clone_plans (provider_type,source_artifact_key,target_name,target_storage,backing_depth,blockers_json,state,plan_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(providerType,sourceArtifactKey,targetName,targetStorage,backingDepth+1,stable(blockers),state,planHash,actor.id).lastInsertRowid);return{id,providerType,sourceArtifactKey,targetName,targetStorage,backingDepth:backingDepth+1,blockers,state,planHash,providerMutationsStarted:0,executeEndpoint:null};
  }

  saveCustomizationProfile(body, actor) {
    this._admin(actor); exact(body,'customizationProfile',['name','version','osFamily','settings','secretRefs']);const name=string(body.name,'name',120);const version=string(body.version,'version',80);if(!SEMVER.test(version))throw fail('version must be semantic');const osFamily=choice(body.osFamily,'osFamily',['linux','windows']);const settings=safeObject(body.settings,'settings',64*1024,PROFILE_FORBIDDEN);const secretRefs=boundedArray(body.secretRefs||[],'secretRefs',30,(item,index)=>{const ref=string(item,`secretRefs[${index}]`,500);if(!/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._~:/?#@!$&'()*+,;=%-]*$/i.test(ref))throw fail(`secretRefs[${index}] is invalid`);return ref;});const profileHash=hash({name,version,osFamily,settings,secretRefs});const db=this._db();const existing=db.prepare('SELECT id,profile_hash FROM guest_customization_profiles WHERE name=? AND version=?').get(name,version);if(existing&&existing.profile_hash!==profileHash)throw fail('Profile version is immutable',409,'IMMUTABLE_VERSION');if(existing)return{id:existing.id,name,version,osFamily,settings,secretRefs,profileHash,duplicate:true};const id=Number(db.prepare('INSERT INTO guest_customization_profiles (name,version,os_family,settings_json,secret_refs_json,profile_hash,created_by) VALUES (?,?,?,?,?,?,?)').run(name,version,osFamily,stable(settings),stable(secretRefs),profileHash,actor.id).lastInsertRowid);return{id,name,version,osFamily,settings,secretRefs,profileHash,duplicate:false};
  }

  mapFlavor(body, actor) {
    this._admin(actor); exact(body,'flavorMapping',['profileKey','providerType','requirements','offerings']);const profileKey=key(body.profileKey,'profileKey');const providerType=key(body.providerType,'providerType');exact(body.requirements,'requirements',['cpu','memoryBytes','diskBytes','gpus','architecture']);const requirements={cpu:integer(body.requirements.cpu,'cpu',1,4096),memoryBytes:integer(body.requirements.memoryBytes,'memoryBytes',1),diskBytes:integer(body.requirements.diskBytes,'diskBytes',1),gpus:integer(body.requirements.gpus||0,'gpus',0,128),architecture:key(body.requirements.architecture,'architecture')};const offerings=boundedArray(body.offerings,'offerings',1000,(item,index)=>{exact(item,`offerings[${index}]`,['offeringKey','cpu','memoryBytes','diskBytes','gpus','architecture','costScore']);const offering={offeringKey:key(item.offeringKey,'offeringKey'),cpu:integer(item.cpu,'cpu',1,4096),memoryBytes:integer(item.memoryBytes,'memoryBytes',1),diskBytes:integer(item.diskBytes,'diskBytes',1),gpus:integer(item.gpus||0,'gpus',0,128),architecture:key(item.architecture,'architecture'),costScore:number(item.costScore,'costScore',0,100)};const blockers=[];for(const field of ['cpu','memoryBytes','diskBytes','gpus'])if(offering[field]<requirements[field])blockers.push(`${field}_insufficient`);if(offering.architecture!==requirements.architecture)blockers.push('architecture_mismatch');const waste=((offering.cpu-requirements.cpu)/requirements.cpu)+((offering.memoryBytes-requirements.memoryBytes)/requirements.memoryBytes);return{...offering,blockers,eligible:blockers.length===0,score:blockers.length?0:Number(Math.max(0,100-waste*20-offering.costScore*0.2).toFixed(2))};}).sort((a,b)=>b.score-a.score);const selected=offerings.find(item=>item.eligible)||null;const state=selected?'ready':'blocked';const mappingHash=hash({profileKey,providerType,requirements,offerings,state});const found=this._db().prepare('SELECT id FROM flavor_offering_mappings WHERE mapping_hash=?').get(mappingHash);const id=found?.id||Number(this._db().prepare('INSERT INTO flavor_offering_mappings (profile_key,provider_type,requirements_json,candidates_json,selected_offering_key,state,mapping_hash,created_by) VALUES (?,?,?,?,?,?,?,?)').run(profileKey,providerType,stable(requirements),stable(offerings),selected?.offeringKey||null,state,mappingHash,actor.id).lastInsertRowid);return{id,profileKey,providerType,requirements,candidates:offerings,selectedOfferingKey:selected?.offeringKey||null,state,mappingHash};
  }

  recordImageObservations(body, actor) {
    this._admin(actor); exact(body,'imageLibrary',['observedAt','observations']);const observedAt=instant(body.observedAt,'observedAt');const observations=boundedArray(body.observations,'observations',5000,(item,index)=>{exact(item,`observations[${index}]`,['providerHostId','providerType','artifactKey','kind','name','digestSha256','sizeBytes','format','provenance']);return{providerHostId:integer(item.providerHostId,'providerHostId',1),providerType:key(item.providerType,'providerType'),artifactKey:key(item.artifactKey,'artifactKey'),kind:choice(item.kind,'kind',['vmTemplate','iso','containerTemplate','diskImage','contentLibraryItem']),name:string(item.name,'name',300),digestSha256:item.digestSha256==null?null:checksum(item.digestSha256,'digestSha256'),sizeBytes:item.sizeBytes==null?null:integer(item.sizeBytes,'sizeBytes',0),format:item.format==null?null:choice(item.format,'format',FORMATS),provenance:safeObject(item.provenance||{},'provenance',32*1024)};});const db=this._db();let inserted=0;for(const item of observations){const observationHash=hash({...item,observedAt});const result=db.prepare('INSERT OR IGNORE INTO image_library_observations (provider_host_id,provider_type,artifact_key,image_kind,name,digest_sha256,size_bytes,format,provenance_json,observation_hash,created_by,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(item.providerHostId,item.providerType,item.artifactKey,item.kind,item.name,item.digestSha256,item.sizeBytes,item.format,stable(item.provenance),observationHash,actor.id,observedAt);inserted+=result.changes;}const digestGroups=new Map();for(const item of observations)if(item.digestSha256){if(!digestGroups.has(item.digestSha256))digestGroups.set(item.digestSha256,[]);digestGroups.get(item.digestSha256).push({providerHostId:item.providerHostId,artifactKey:item.artifactKey});}return{observedAt,received:observations.length,inserted,deduplicated:observations.length-inserted,replicas:[...digestGroups.entries()].map(([digestSha256,locations])=>({digestSha256,locations})),rawProviderReferencesStored:false};
  }

  createImageUploadSession(body, actor) {
    this._admin(actor); exact(body,'imageUploadSession',['providerHostId','fileName','totalBytes','chunkSize','expectedSha256','inputFormat','targetFormat','destinationRef']);const providerHostId=integer(body.providerHostId,'providerHostId',1);const fileName=string(body.fileName,'fileName',255);if(/[\\/]/.test(fileName)||fileName==='.'||fileName==='..')throw fail('fileName must not contain a path');const totalBytes=integer(body.totalBytes,'totalBytes',1,1099511627776);const chunkSize=integer(body.chunkSize,'chunkSize',1048576,67108864);const expectedSha256=checksum(body.expectedSha256,'expectedSha256');const inputFormat=choice(body.inputFormat,'inputFormat',FORMATS);const targetFormat=choice(body.targetFormat,'targetFormat',FORMATS);const destinationRef=key(body.destinationRef,'destinationRef');const saved=this._db().prepare('INSERT INTO image_upload_sessions (provider_host_id,file_name,total_bytes,chunk_size,expected_sha256,input_format,target_format,destination_ref,state,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(providerHostId,fileName,totalBytes,chunkSize,expectedSha256,inputFormat,targetFormat,destinationRef,'uploading',actor.id);return{id:Number(saved.lastInsertRowid),providerHostId,fileName,totalBytes,chunkSize,expectedSha256,inputFormat,targetFormat,destinationRef,state:'uploading',dataBytesStored:0,providerMutationsStarted:0};
  }

  recordImageChunk(sessionId, body, actor) {
    this._admin(actor); exact(body,'chunkReceipt',['offsetBytes','sizeBytes','sha256']);const session=this._row('image_upload_sessions',sessionId,'Image upload session');if(session.state!=='uploading')throw fail('Image upload session is not accepting chunks',409,'INVALID_STATE');const offsetBytes=integer(body.offsetBytes,'offsetBytes',0,session.total_bytes-1);const sizeBytes=integer(body.sizeBytes,'sizeBytes',1,session.chunk_size);if(offsetBytes%session.chunk_size!==0)throw fail('Chunk offset is not aligned');if(offsetBytes+sizeBytes>session.total_bytes)throw fail('Chunk exceeds totalBytes');if(offsetBytes+sizeBytes<session.total_bytes&&sizeBytes!==session.chunk_size)throw fail('Only the final chunk may be shorter');const sha256=checksum(body.sha256,'sha256');const receiptHash=hash({sessionId:session.id,offsetBytes,sizeBytes,sha256});const db=this._db();const existing=db.prepare('SELECT * FROM image_upload_chunk_receipts WHERE session_id=? AND offset_bytes=?').get(session.id,offsetBytes);if(existing&&existing.receipt_hash!==receiptHash)throw fail('Chunk receipt conflicts with recorded offset',409,'CHUNK_CONFLICT');if(!existing)db.prepare('INSERT INTO image_upload_chunk_receipts (session_id,offset_bytes,size_bytes,chunk_sha256,receipt_hash,created_by) VALUES (?,?,?,?,?,?)').run(session.id,offsetBytes,sizeBytes,sha256,receiptHash,actor.id);const received=db.prepare('SELECT COALESCE(SUM(size_bytes),0) bytes,COUNT(*) chunks FROM image_upload_chunk_receipts WHERE session_id=?').get(session.id);return{sessionId:session.id,offsetBytes,sizeBytes,sha256,receiptHash,duplicate:Boolean(existing),receivedBytes:received.bytes,chunks:received.chunks,dataBytesStored:0};
  }

  finalizeImageUpload(sessionId, body, actor) {
    this._admin(actor); exact(body,'imageUploadFinalize',['observedSha256']);const session=this._row('image_upload_sessions',sessionId,'Image upload session');if(session.state!=='uploading')throw fail('Image upload session is already finalized',409,'INVALID_STATE');const observedSha256=checksum(body.observedSha256,'observedSha256');const receipts=this._db().prepare('SELECT offset_bytes,size_bytes,chunk_sha256 FROM image_upload_chunk_receipts WHERE session_id=? ORDER BY offset_bytes').all(session.id);let cursor=0;for(const receipt of receipts){if(receipt.offset_bytes!==cursor)throw fail('Chunk receipt coverage has a gap',409,'CHUNK_GAP',{expectedOffset:cursor});cursor+=receipt.size_bytes;}if(cursor!==session.total_bytes)throw fail('Chunk receipt coverage is incomplete',409,'CHUNK_GAP',{receivedBytes:cursor,totalBytes:session.total_bytes});const blockers=[];if(observedSha256!==session.expected_sha256)blockers.push('full_checksum_mismatch');const state=blockers.length?'blocked':'ready';const conversion=session.input_format===session.target_format?null:{tool:'qemu-img',inputFormat:session.input_format,targetFormat:session.target_format,executor:'approved-external-data-plane'};const planHash=hash({sessionId:session.id,receipts,observedSha256,destinationRef:session.destination_ref,conversion,blockers,state});this._db().prepare("UPDATE image_upload_sessions SET observed_sha256=?,state=?,plan_hash=?,updated_at=datetime('now') WHERE id=?").run(observedSha256,state,planHash,session.id);return{sessionId:session.id,observedSha256,receiptCount:receipts.length,receivedBytes:cursor,conversion,blockers,state,planHash,dataBytesStored:0,providerMutationsStarted:0,executeEndpoint:null};
  }

  overview(actor) {
    this._admin(actor);const db=this._db();const tables={events:'normalized_provider_events',inventoryDeltas:'inventory_delta_syncs',collections:'dynamic_resource_collections',metadataSchemas:'custom_metadata_schemas',metadataValues:'custom_metadata_values',graphs:'resource_relationship_graphs',hygieneScans:'resource_hygiene_scans',rateBudgets:'provider_rate_limit_budgets',linkedClonePlans:'linked_clone_plans',customizationProfiles:'guest_customization_profiles',flavorMappings:'flavor_offering_mappings',images:'image_library_observations',imageUploadSessions:'image_upload_sessions',imageChunkReceipts:'image_upload_chunk_receipts'};const summary=Object.fromEntries(Object.entries(tables).map(([name,table])=>[name,db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));const events=db.prepare('SELECT id,provider_host_id providerHostId,provider_type providerType,event_type eventType,severity,resource_key resourceKey,occurred_at occurredAt,fingerprint FROM normalized_provider_events ORDER BY id DESC LIMIT 50').all();const sessions=db.prepare('SELECT id,file_name fileName,total_bytes totalBytes,input_format inputFormat,target_format targetFormat,state,plan_hash planHash,created_at createdAt FROM image_upload_sessions ORDER BY id DESC LIMIT 50').all();return{capabilities:{commonEventModel:true,incrementalInventorySync:true,resourceCollections:true,customMetadataFields:true,resourceRelationshipGraph:true,duplicateOrphanDetector:true,rateLimitBudgetManager:true,linkedThinClonePlanner:true,guestCustomizationProfiles:true,flavorOfferingMapper:true,imageLibraryAggregator:true,resumableImageImportReceipts:true},safety:{providerMutationsStarted:0,cleanupStarted:0,imageBytesStored:0,executeEndpoints:[],dataPlane:'separately approved adapter'},summary,events,sessions};
  }
}

const service = new PlatformFoundationService();
module.exports = service;
module.exports.PlatformFoundationService = PlatformFoundationService;
module.exports.PlatformFoundationError = PlatformFoundationError;
