'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic `nomenclatures` rows.
//
// Locale-aware lookup lists (regions/currencies/units/environments/…). Every row
// is tagged `seed_run_id` so it purges with the batch; the REAL nomenclatures the
// `seed_nomenclatures` provisioning step writes from a template keep
// `seed_run_id IS NULL` and are structurally untouchable by a purge.
//
// `kind` values come from the in-service catalog (catalog.NOMENCLATURE_KINDS) —
// 091 deliberately has no CHECK, so this module is one of the write-time validators.

const { validateNomenclatureKind } = require('../catalog');

// Locale-neutral base lists. `label` is what the UI shows; `code` is the key.
const BASE = {
  environment: [
    ['dev', 'Development'], ['test', 'Test'], ['stage', 'Staging'], ['prod', 'Production'],
  ],
  severity: [
    ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['info', 'Informational'],
  ],
  priority: [['p1', 'P1 — Urgent'], ['p2', 'P2 — High'], ['p3', 'P3 — Normal'], ['p4', 'P4 — Low']],
  plant_type: [['assembly', 'Assembly'], ['press', 'Press shop'], ['packaging', 'Packaging'], ['printing', 'Printing'], ['warehouse', 'Warehouse']],
  shift: [['a', 'Shift A (06-14)'], ['b', 'Shift B (14-22)'], ['c', 'Shift C (22-06)']],
  line: [['l1', 'Line 1'], ['l2', 'Line 2'], ['l3', 'Line 3'], ['l4', 'Line 4']],
  department: [['ops', 'Operations'], ['it', 'IT'], ['qa', 'Quality'], ['maint', 'Maintenance'], ['logistics', 'Logistics']],
  service_tier: [['bronze', 'Bronze'], ['silver', 'Silver'], ['gold', 'Gold']],
  industry: [['manufacturing', 'Manufacturing'], ['logistics', 'Logistics'], ['retail', 'Retail'], ['msp', 'Managed services']],
  unit: [['kg', 'Kilogram'], ['m', 'Metre'], ['l', 'Litre'], ['pcs', 'Pieces'], ['pal', 'Pallets']],
  unitImperial: [['lb', 'Pound'], ['ft', 'Foot'], ['gal', 'Gallon'], ['pcs', 'Pieces'], ['pal', 'Pallets']],
};

// Emission order — earlier kinds survive truncation to the profile's row count.
const ORDER = ['environment', 'severity', 'priority', 'department', 'plant_type', 'line', 'shift', 'service_tier', 'industry'];

/**
 * @param {object} ctx generator context (see seed/index.js)
 * @returns {{count:number}}
 */
function generate(ctx) {
  const { db, rng, datasetId, tenantId, profile, pool } = ctx;
  const target = profile.nomenclatures;

  const rows = [];
  // 1. currency + region + unit are locale-derived (Step-2 regional tie-in).
  rows.push({ kind: 'currency', code: pool.defaults.currency, label: pool.defaults.currency, sort: 0 });
  for (const alt of ['EUR', 'USD', 'GBP']) {
    if (alt !== pool.defaults.currency) rows.push({ kind: 'currency', code: alt, label: alt, sort: 1 });
  }
  const unitList = pool.defaults.unitSystem === 'imperial' ? BASE.unitImperial : BASE.unit;
  unitList.forEach(([code, label], i) => rows.push({ kind: 'unit', code, label, sort: i }));
  // Regions are drawn from the locale's fictional city pool.
  pool.cities.slice(0, 6).forEach((city, i) => {
    rows.push({ kind: 'region', code: `r-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 40), label: city, sort: i });
  });
  // 2. the locale-neutral remainder, in a stable order.
  for (const kind of ORDER) {
    BASE[kind].forEach(([code, label], i) => rows.push({ kind, code, label, sort: i }));
  }

  // Trim to the profile budget; a tiny deterministic jitter on `sort` keeps the
  // lists from looking machine-generated without touching identity.
  const wanted = rows.slice(0, target);

  const exists = db.prepare('SELECT 1 AS ok FROM nomenclatures WHERE tenant_id = ? AND kind = ? AND code = ?');
  // created_at is written EXPLICITLY (never left to the datetime('now') DEFAULT):
  // a synthetic row must carry a synthetic, PRNG-derived timestamp, otherwise the
  // dataset would silently depend on wall-clock and stop being reproducible.
  const ins = db.prepare(`
    INSERT INTO nomenclatures (tenant_id, kind, code, label, sort, meta_json, created_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const n of wanted) {
    validateNomenclatureKind(n.kind);
    // A pre-existing (real or template) row wins — never overwrite real config.
    if (exists.get(tenantId, n.kind, n.code)) continue;
    ins.run(tenantId, n.kind, n.code, n.label, n.sort + (rng.bool(0.15) ? 1 : 0),
      JSON.stringify({ synthetic: true }),
      rng.dateBetween(ctx.nowMs - 400 * 864e5, ctx.nowMs - 30 * 864e5), datasetId);
    count += 1;
  }
  ctx.count('nomenclatures', count);
  return { count };
}

module.exports = { generate };
