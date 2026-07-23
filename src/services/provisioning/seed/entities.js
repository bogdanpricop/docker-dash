'use strict';

// v8.18.0 (Onboarding — Phase 4) — synthetic tenant entities + relations.
//
// A small, COHERENT domain graph per batch: sites → departments → applications,
// wired with `belongs_to` (dept→site, app→dept) and `depends_on` (app→app). The
// SHAPE is deterministic given the profile so profiles.estimate() can predict
// the exact row counts without a write (the volume-guard test asserts
// generate.total ≈ estimate.total).
//
// Every row is tagged `seed_run_id = datasetId`, so it purges with the batch;
// the REAL entities the `seed_entities` provisioning step writes from a template
// keep `seed_run_id IS NULL` and are structurally untouchable by a purge (`NULL =
// x` is never true).
//
// `code` embeds the datasetId so two batches seeded into the SAME tenant never
// collide on UNIQUE(tenant_id, entity_type, code) — and because a fresh DB's
// first dataset is always id 1, the codes are still byte-identical across two
// clean determinism runs. `entity_type` / `relation_type` come from the
// in-service catalog (094 has no CHECK), so this module is one of their
// write-time validators.

const { validateEntityType, validateRelationType } = require('../catalog');
const { SERVICE_NAMES } = require('./words');

const DEPT_NAMES = ['Operations', 'Engineering', 'Quality', 'Logistics', 'IT', 'Maintenance', 'Procurement', 'Finance', 'Safety'];

/**
 * @param {object} ctx generator context (see seed/index.js)
 * @returns {{entities:number, relations:number}}
 */
function generate(ctx) {
  const { db, rng, datasetId, tenantId, profile, pool, nowMs } = ctx;
  const nSites = profile.entitySites || 0;
  const nDepts = profile.entityDepartments || 0;
  const nApps = profile.entityApplications || 0;
  if (!nSites && !nDepts && !nApps) return { entities: 0, relations: 0 };

  validateEntityType('site'); validateEntityType('department'); validateEntityType('application');
  validateRelationType('belongs_to'); validateRelationType('depends_on');

  // created_at is written EXPLICITLY (never the datetime('now') DEFAULT) so the
  // dataset never depends on wall-clock — a PRNG-derived synthetic timestamp.
  const insE = db.prepare(`
    INSERT INTO tenant_entities (tenant_id, entity_type, code, name, meta_json, created_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insR = db.prepare(`
    INSERT INTO tenant_entity_relations (tenant_id, from_entity_id, to_entity_id, relation_type, meta_json, created_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const ts = () => rng.dateBetween(nowMs - 300 * 864e5, nowMs - 5 * 864e5);
  const meta = JSON.stringify({ synthetic: true });

  const cities = (pool && pool.cities) || ['Rivertown', 'Lakeside', 'Hillford', 'Northgate', 'Westport'];

  const sites = [];
  for (let i = 0; i < nSites; i++) {
    const city = cities[i % cities.length];
    const id = Number(insE.run(
      tenantId, 'site', `site-${datasetId}-${i}`, `${city} Site`,
      JSON.stringify({ synthetic: true, city }), ts(), datasetId,
    ).lastInsertRowid);
    sites.push(id);
  }

  let relCount = 0;
  const depts = [];
  for (let i = 0; i < nDepts; i++) {
    const id = Number(insE.run(
      tenantId, 'department', `dept-${datasetId}-${i}`, DEPT_NAMES[i % DEPT_NAMES.length],
      meta, ts(), datasetId,
    ).lastInsertRowid);
    depts.push(id);
    if (sites.length) { insR.run(tenantId, id, sites[i % sites.length], 'belongs_to', meta, ts(), datasetId); relCount += 1; }
  }

  const apps = [];
  for (let i = 0; i < nApps; i++) {
    const svc = SERVICE_NAMES[i % SERVICE_NAMES.length];
    const id = Number(insE.run(
      tenantId, 'application', `app-${datasetId}-${i}`, `${svc}-${Math.floor(i / SERVICE_NAMES.length) + 1}`,
      meta, ts(), datasetId,
    ).lastInsertRowid);
    apps.push(id);
    if (depts.length) { insR.run(tenantId, id, depts[i % depts.length], 'belongs_to', meta, ts(), datasetId); relCount += 1; }
  }

  // depends_on: pair up applications deterministically (every other one depends
  // on its successor) → exactly floor(nApps/2) edges, matching the estimator.
  for (let i = 0; i + 1 < apps.length; i += 2) {
    insR.run(tenantId, apps[i], apps[i + 1], 'depends_on', meta, ts(), datasetId);
    relCount += 1;
  }

  const entities = sites.length + depts.length + apps.length;
  ctx.count('tenant_entities', entities);
  ctx.count('tenant_entity_relations', relCount);
  return { entities, relations: relCount };
}

module.exports = { generate };
