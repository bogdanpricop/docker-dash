'use strict';

// v8.9.43-alpha.1 — deterministic (no-LLM) briefing. Turns the context bundle into
// prioritized recommendations with deep-links to the guarded pages. This is Tier 1
// — it always works with zero setup; the LLM narrative (Tier 2) is additive.

const RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

function recommend(ctx) {
  const recs = [];
  for (const f of (ctx.findings || [])) {
    recs.push({
      severity: f.severity, title: f.title, why: f.detail || '',
      action: (f.remediation && f.remediation.label) || 'Review',
      link: (f.remediation && f.remediation.link) || null,
      host: f.host || null,
    });
  }
  for (const b of (ctx.blueprints || [])) {
    recs.push({
      severity: 'medium', title: `Blueprint "${b.name}" has drifted`,
      why: `${b.create} rule(s) to create, ${b.remove} to remove to match the declared state.`,
      action: 'Open Reconciler', link: '#/blueprints', host: null,
    });
  }
  recs.sort((a, b) => (RANK[b.severity] || 0) - (RANK[a.severity] || 0));
  return recs.slice(0, 12);
}

function summaryLine(ctx) {
  const c = ctx.counts || {};
  return `Estate grade ${ctx.grade || '?'} (${ctx.score == null ? '?' : ctx.score}/100): `
    + `${c.critical || 0} critical, ${c.high || 0} high, ${c.medium || 0} medium open finding(s) across ${(ctx.hosts || []).length} host(s).`;
}

module.exports = { recommend, summaryLine };
