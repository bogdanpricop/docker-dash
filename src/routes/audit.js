'use strict';

const { Router } = require('express');
const auditService = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// Query audit log (admin only)
router.get('/', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const { action, targetType, userId, page, limit, since, until } = req.query;
  const result = auditService.query({
    action,
    targetType,
    userId: userId ? parseInt(userId) : undefined,
    page: parseInt(page) || 1,
    limit: Math.min(parseInt(limit) || 50, 500),
    since,
    until,
  });
  res.json(result);
}));

// v8.0.0 — NL search. Translates a natural-language query into a structured
// filter via the AI service, then runs that filter through the existing
// audit query path. NL → JSON-with-fixed-schema, never NL → SQL. The user
// sees the parsed filter in the response so they can verify what the LLM
// understood.
router.post('/ai-search', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { query } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query (string) required' });
  }
  // v8.7.21 — explicit length cap. The express body-parser limit is 2MB
  // globally; without this check, a hostile (or merely careless) admin
  // could send a megabyte-scale "query" string straight to the configured
  // LLM provider. Audit-search queries are natural-language questions
  // ("who deleted prod-redis last Tuesday?") — they should be well under
  // 200 chars. 2000 is generous headroom. Without this, a single bad call
  // at OpenAI/Anthropic pricing (~$3-15 per 1M input tokens, ~4 chars per
  // token) could be $1.50-$7.50; an automated mistake in client code
  // could run up real money fast. The response side is already capped by
  // audit-search.js maxTokens: 256 and the schema validator.
  if (query.length > 2000) {
    return res.status(400).json({ error: 'query too long (max 2000 chars)' });
  }

  const aiService = require('../services/ai');
  if (!aiService.isEnabled()) {
    return res.status(400).json({ error: 'AI is not configured. Enable it in Settings → AI.' });
  }

  const auditSearch = require('../services/ai/features/audit-search');
  const { getClientIp } = require('../utils/helpers');

  let translation;
  try {
    translation = await auditSearch.translateQuery({
      query,
      audit: {
        userId: req.user.id,
        username: req.user.username,
        ip: getClientIp(req),
      },
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  // Run the existing query with the parsed filter
  const f = translation.filter;
  const result = auditService.query({
    action: f.action,
    page: 1,
    limit: f.limit || 100,
    since: f.since,
    until: f.until,
  });

  // Post-filter for actor / host / resource if present. The existing query()
  // doesn't index on these, but the result set is already capped at limit so
  // a Node-side filter is fine for v8.0.0.
  let rows = result.rows || result.entries || result.events || (Array.isArray(result) ? result : []);
  if (Array.isArray(rows)) {
    if (f.actor) rows = rows.filter(r => (r.username || '').toLowerCase().includes(f.actor.toLowerCase()));
    if (f.host) rows = rows.filter(r => JSON.stringify(r.details || {}).toLowerCase().includes(f.host.toLowerCase()));
    if (f.resource) rows = rows.filter(r => (r.target_id || r.targetId || '').toLowerCase().includes(f.resource.toLowerCase()));
  }

  res.json({
    parsedFilter: f,
    rows: rows || [],
    totalMatched: Array.isArray(rows) ? rows.length : 0,
    aiMeta: {
      provider: translation.raw.provider,
      latencyMs: translation.raw.latencyMs,
      usage: translation.raw.usage,
      redactionsApplied: translation.raw.redactions,
    },
  });
}));

// Verify audit log integrity (admin only)
router.get('/verify', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const { from, to } = req.query;
  const result = auditService.verify({
    fromId: from ? parseInt(from) : undefined,
    toId: to ? parseInt(to) : undefined,
  });
  res.json(result);
}));

// Export audit log (admin only)
router.get('/export', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const { format, since, until, action, userId } = req.query;
  const validFormats = ['json', 'csv', 'syslog'];
  const fmt = validFormats.includes(format) ? format : 'json';

  const data = auditService.export(fmt, {
    since,
    until,
    action,
    userId: userId ? parseInt(userId) : undefined,
  });

  const contentTypes = {
    json: 'application/json',
    csv: 'text/csv',
    syslog: 'text/plain',
  };

  const extensions = { json: 'json', csv: 'csv', syslog: 'log' };

  res.setHeader('Content-Type', contentTypes[fmt]);
  res.setHeader('Content-Disposition', `attachment; filename="audit-export.${extensions[fmt]}"`);
  res.send(data);
}));

module.exports = router;
