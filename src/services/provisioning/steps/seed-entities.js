'use strict';

// Step 4 — seed_entities (kind: db). v8.18.0, Phase 4.
//
// Upserts the declaration's entities[] + relations[] (template defaults merged
// under the user's explicit entries — see template-merge.js) into
// tenant_entities / tenant_entity_relations for the run's tenant. Both are keyed
// on their natural UNIQUE constraints so a re-applied declaration CONVERGES
// instead of duplicating:
//   - entities:  UNIQUE(tenant_id, entity_type, code)
//   - relations: UNIQUE(tenant_id, from_entity_id, to_entity_id, relation_type)
//
// Relations reference entities by (type, code); the step resolves those to ids
// AFTER upserting the entities (validateDeclaration already proved every
// endpoint is declared, so the lookup can never miss). Rows written here are
// REAL config — `seed_run_id` is left NULL, so a demo purge can never touch them
// (the mock generator's synthetic entities, seed/entities.js, are the tagged
// ones).
//
// Compensation deletes ONLY the rows THIS run inserted (relations first, then
// entities — child before parent). Rows that already existed and were merely
// refreshed are left alone; the create_tenant cascade is still the backstop when
// the whole tenant goes away.

module.exports = {
  key: 'seed_entities',
  kind: 'db',

  run(ctx) {
    const { db, decl, tenantId } = ctx;
    const entities = decl.entities || [];
    const relations = decl.relations || [];
    if (!entities.length && !relations.length) {
      return { tenantId, insertedEntities: [], insertedRelations: [], updatedEntities: 0 };
    }

    const findE = db.prepare('SELECT id FROM tenant_entities WHERE tenant_id = ? AND entity_type = ? AND code = ?');
    const upsertE = db.prepare(`
      INSERT INTO tenant_entities (tenant_id, entity_type, code, name, meta_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, entity_type, code) DO UPDATE SET
        name = excluded.name, meta_json = excluded.meta_json
    `);

    const insertedEntities = [];
    let updatedEntities = 0;
    const idByKey = new Map();
    for (const e of entities) {
      const pre = findE.get(tenantId, e.entityType, e.code);
      upsertE.run(tenantId, e.entityType, e.code, e.name, e.meta ? JSON.stringify(e.meta) : null);
      const row = pre || findE.get(tenantId, e.entityType, e.code);
      idByKey.set(`${e.entityType}::${e.code.toLowerCase()}`, row.id);
      if (pre) updatedEntities += 1;
      else insertedEntities.push({ entityType: e.entityType, code: e.code });
    }

    const findR = db.prepare(
      'SELECT id FROM tenant_entity_relations WHERE tenant_id = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ?',
    );
    const upsertR = db.prepare(`
      INSERT INTO tenant_entity_relations (tenant_id, from_entity_id, to_entity_id, relation_type, meta_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, from_entity_id, to_entity_id, relation_type) DO UPDATE SET
        meta_json = excluded.meta_json
    `);

    const insertedRelations = [];
    for (const r of relations) {
      const fromId = idByKey.get(`${r.fromType}::${r.fromCode.toLowerCase()}`);
      const toId = idByKey.get(`${r.toType}::${r.toCode.toLowerCase()}`);
      if (fromId == null || toId == null) continue; // unreachable (validator guarantees both)
      const pre = findR.get(tenantId, fromId, toId, r.relationType);
      upsertR.run(tenantId, fromId, toId, r.relationType, r.meta ? JSON.stringify(r.meta) : null);
      if (!pre) insertedRelations.push({ fromType: r.fromType, fromCode: r.fromCode, toType: r.toType, toCode: r.toCode, relationType: r.relationType });
    }

    ctx.audit('tenant_entity_seed', 'tenant', String(tenantId), {
      entities: entities.length, insertedEntities: insertedEntities.length, updatedEntities,
      relations: relations.length, insertedRelations: insertedRelations.length,
    });
    return { tenantId, insertedEntities, insertedRelations, updatedEntities };
  },

  compensate(ctx, cp) {
    const { db } = ctx;
    const tenantId = (cp && cp.tenantId) || ctx.tenantId;
    if (!tenantId) return;
    const relations = (cp && cp.insertedRelations) || [];
    const entities = (cp && cp.insertedEntities) || [];

    // Relations first (children), then entities (parents). Idempotent: a second
    // pass resolves nothing / deletes nothing.
    const findE = db.prepare('SELECT id FROM tenant_entities WHERE tenant_id = ? AND entity_type = ? AND code = ?');
    const delR = db.prepare('DELETE FROM tenant_entity_relations WHERE tenant_id = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ?');
    for (const r of relations) {
      const from = findE.get(tenantId, r.fromType, r.fromCode);
      const to = findE.get(tenantId, r.toType, r.toCode);
      if (from && to) delR.run(tenantId, from.id, to.id, r.relationType);
    }
    const delE = db.prepare('DELETE FROM tenant_entities WHERE tenant_id = ? AND entity_type = ? AND code = ?');
    for (const e of entities) delE.run(tenantId, e.entityType, e.code);
  },

  estimate(ctx) {
    const decl = ctx.decl || {};
    return { entities: (decl.entities || []).length, relations: (decl.relations || []).length };
  },
};
