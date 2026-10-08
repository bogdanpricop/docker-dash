'use strict';

// v8.94.0 — CLI Transparency preview endpoint.
//
// Returns the `docker` / `docker compose` command a Docker Dash action is
// equivalent to. Read-only by construction: it formats a string and touches
// nothing. `requireAuth` is therefore the whole authorization story — there is
// no state to protect, and gating it behind `operator` would hide the
// explanation from exactly the viewers who most need it.
//
// POST rather than GET despite being read-only: the params are structured
// (bulk subject arrays, full container definitions) and do not survive a query
// string intact. No `writeable`, no `requireRole`, no audit entry — nothing
// happened.
//
// The endpoint NEVER accepts a command string. It accepts an action key from
// cli-transparency's fixed table plus typed params. See
// plans/feature-spec-cli-transparency.md §2 "Must not".

const { Router } = require('express');
const cli = require('../services/cli-transparency');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// Bulk previews are capped by the service at 100 rendered lines; this bound just
// stops a caller handing us a million-element array to iterate over first.
const MAX_SUBJECTS = 1000;

router.get('/actions', requireAuth, asyncHandler((_req, res) => {
  res.json({ actions: cli.listActions() });
}));

router.post('/', requireAuth, asyncHandler((req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = typeof body.action === 'string' ? body.action.trim() : '';

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }
  if (!cli.listActions().includes(action)) {
    // Explicit 400 rather than a silent `available:false` — an unknown action
    // key is a caller bug, not an action that happens to have no equivalent.
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  const params = body.params && typeof body.params === 'object' ? body.params : {};
  if (Array.isArray(params.subjects) && params.subjects.length > MAX_SUBJECTS) {
    return res.status(400).json({ error: `Too many subjects (max ${MAX_SUBJECTS})` });
  }

  res.json(cli.describe(action, params));
}));

module.exports = router;
