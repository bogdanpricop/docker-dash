'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic registries.
//
// URLs land on the RFC 2606 reserved `.example` TLD so a demo registry can never
// be contacted. The (fake) token is still written through `crypto.encrypt` — the
// demo exercises the real credential path and `password_encrypted` never holds a
// bare value.

const { encrypt } = require('../../../utils/crypto');

function generate(ctx) {
  const { db, rng, datasetId, profile, org, refs } = ctx;
  const createdBy = refs.users.length ? rng.pick(refs.users).id : null;

  const ins = db.prepare(`
    INSERT INTO registries (name, url, username, password_encrypted, is_default, created_by, created_at, last_used_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const exists = db.prepare('SELECT 1 AS ok FROM registries WHERE url = ?');

  const flavours = [
    { suffix: '', label: 'Registry' },
    { suffix: '-staging', label: 'Staging registry' },
    { suffix: '-mirror', label: 'Upstream mirror' },
  ];

  let count = 0;
  for (let i = 0; i < profile.registries; i++) {
    const f = flavours[i % flavours.length];
    const url = `https://registry${f.suffix}.${org.slug}.example`;   // RFC 2606
    if (exists.get(url)) continue;
    ins.run(
      `${org.name} ${f.label}`,
      url,
      'demo-puller',
      encrypt(`placeholder-registry-token-${rng.hex(12)}`),
      i === 0 ? 0 : 0,                                  // never steal `is_default` from a real registry
      createdBy,
      rng.dateBetween(ctx.nowMs - 300 * 864e5, ctx.nowMs - 30 * 864e5),
      rng.dateBetween(ctx.nowMs - 10 * 864e5, ctx.nowMs),
      datasetId,
    );
    count += 1;
  }
  ctx.count('registries', count);
  return { count };
}

module.exports = { generate };
