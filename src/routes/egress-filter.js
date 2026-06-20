'use strict';

// Outbound Network Filter routes — v6.7 (alpha.1)
// Spec: docs/planning/v6.7/outbound-filter/01-feature-spec.md §3
//
// This alpha exposes the CRUD surface. Policies created here are persisted
// but NOT enforced until the rc2 sidecar lands. API responses include an
// `enforced: false` flag so frontends can surface "config only" UX.

const { Router } = require('express');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const auditService = require('../services/audit');
const dockerService = require('../services/docker');
const egressFilter = require('../services/egress-filter');
const egressRunner = require('../services/egress-runner');
const log = require('../utils/logger')('egress-filter');

const router = Router();

// Enforcement became real in v6.7.0-alpha.3 — opt-in via `apply` API.
const ENFORCEMENT_ACTIVE = true;

// ─── Presets ────────────────────────────────────────────

// GET /presets — return the catalog of preset allowlists
router.get('/presets', requireAuth, requireRole('admin'), (_req, res) => {
  try {
    res.json({
      presets: egressFilter.listPresets(),
      imdsAlwaysBlocked: egressFilter._internals.IMDS_ENDPOINTS,
      enforced: ENFORCEMENT_ACTIVE,
    });
  } catch (err) {
    log.error('list presets', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Policy CRUD ────────────────────────────────────────

// GET /policies — list active policies (optional host filter)
router.get('/policies', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const hostId = req.query.hostId != null ? parseInt(req.query.hostId, 10) : undefined;
    res.json({
      policies: egressFilter.listPolicies({ hostId }),
      enforced: ENFORCEMENT_ACTIVE,
    });
  } catch (err) {
    log.error('list policies', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /policies/:id — show one
router.get('/policies/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const policy = egressFilter.getPolicy(id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    res.json({ policy, enforced: ENFORCEMENT_ACTIVE });
  } catch (err) {
    log.error('get policy', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /policies — create or upsert
router.post('/policies', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { scopeType, scopeKey, hostId, preset, customAllowlist, mode } = req.body || {};

    if (!['container', 'stack'].includes(scopeType)) {
      return res.status(400).json({ error: 'scopeType must be "container" or "stack"' });
    }
    if (!scopeKey || typeof scopeKey !== 'string') {
      return res.status(400).json({ error: 'scopeKey is required' });
    }
    if (scopeType === 'container' && !/^[a-f0-9]{12,64}$/.test(scopeKey)) {
      return res.status(400).json({ error: 'scopeKey must be a Docker container id (12-64 hex chars)' });
    }

    // Precondition: for container scope, verify the target isn't privileged / NET_ADMIN / etc.
    if (scopeType === 'container') {
      try {
        const docker = dockerService.getDocker(hostId || 0);
        const inspect = await docker.getContainer(scopeKey).inspect();
        const precheck = egressFilter.canApplyFilter(inspect);
        if (!precheck.ok) {
          return res.status(422).json({ error: precheck.reason });
        }
      } catch (e) {
        // If the container can't be inspected, persist anyway (user may be pre-provisioning).
        // Log it but don't block. Real enforcement will re-check at apply time.
        log.warn('egress policy created without container precheck', { scopeKey, err: e.message });
      }
    }

    const result = egressFilter.createPolicy({
      scopeType,
      scopeKey,
      hostId: hostId || 0,
      preset,
      customAllowlist,
      mode,
      createdBy: req.user?.id,
    });

    await auditService.log({
      userId: req.user?.id,
      username: req.user?.username,
      ip: getClientIp(req),
      action: result.updated ? 'egress_policy_updated' : 'egress_policy_created',
      details: { policyId: result.policyId, scopeType, scopeKey, preset, mode: result.mode, allowlistSize: result.allowlist.length },
    });

    res.status(result.updated ? 200 : 201).json({
      ok: true,
      policyId: result.policyId,
      updated: result.updated,
      allowlist: result.allowlist,
      mode: result.mode,
      enforced: ENFORCEMENT_ACTIVE,
      note: 'Policy persisted. Call POST /apply to install the iptables redirect into the target container\'s netns.',
    });
  } catch (err) {
    // Validation errors come from the service layer as regular Error
    const msg = err.message || 'Internal server error';
    if (/validation|required|Unknown preset|Invalid /i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    log.error('create egress policy', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /policies/:id — update (preset change, allowlist edit, mode flip)
router.patch('/policies/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = egressFilter.getPolicy(id);
    if (!existing) return res.status(404).json({ error: 'Policy not found' });

    const updated = egressFilter.updatePolicy(id, req.body || {});

    await auditService.log({
      userId: req.user?.id,
      username: req.user?.username,
      ip: getClientIp(req),
      action: 'egress_policy_updated',
      details: { policyId: id, preset: updated.preset, mode: updated.mode, allowlistSize: updated.allowlist.length },
    });

    res.json({ ok: true, policy: updated, enforced: ENFORCEMENT_ACTIVE });
  } catch (err) {
    const msg = err.message || 'Internal server error';
    if (/validation|required|Unknown preset|Invalid /i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    log.error('update egress policy', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /policies/:id — emergency disable (soft-delete, active=0)
router.delete('/policies/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = egressFilter.getPolicy(id);
    if (!existing) return res.status(404).json({ error: 'Policy not found' });

    const reason = (req.body && req.body.reason) || 'unspecified';
    egressFilter.removePolicy(id, { reason });

    await auditService.log({
      userId: req.user?.id,
      username: req.user?.username,
      ip: getClientIp(req),
      action: 'egress_emergency_disable',
      details: { policyId: id, scopeType: existing.scopeType, scopeKey: existing.scopeKey, reason },
    });

    res.json({ ok: true, removed: true, enforced: ENFORCEMENT_ACTIVE });
  } catch (err) {
    log.error('remove egress policy', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Block log ──────────────────────────────────────────

// ─── Enforcement (v6.7.0-alpha.3) ───────────────────────

// POST /policies/:id/apply — install iptables redirect for this policy's scope.
// Requires DD_EGRESS_SIDECAR_ENDPOINT env to be set on the Docker Dash container.
router.post('/policies/:id/apply', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const policy = egressFilter.getPolicy(id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    if (!policy.active) return res.status(400).json({ error: 'Policy is soft-deleted — recreate to re-apply' });

    if (policy.scopeType === 'stack') {
      // Stack scope: runner does precondition check + transactional apply internally.
      const result = await egressRunner.applyToStack({
        stackName: policy.scopeKey,
        hostId: policy.hostId || 0,
      });
      await auditService.log({
        userId: req.user?.id,
        username: req.user?.username,
        ip: getClientIp(req),
        action: 'egress_policy_applied',
        details: { policyId: id, stackName: policy.scopeKey, hostId: policy.hostId, appliedCount: result.applied.length, skippedCount: result.skipped.length },
      });
      return res.json({ ok: true, scope: 'stack', ...result });
    }

    // Container scope: precondition check
    try {
      const docker = dockerService.getDocker(policy.hostId || 0);
      const inspect = await docker.getContainer(policy.scopeKey).inspect();
      const precheck = egressFilter.canApplyFilter(inspect);
      if (!precheck.ok) return res.status(422).json({ error: precheck.reason });
    } catch (e) {
      return res.status(404).json({ error: `Container ${policy.scopeKey} not found or unreachable: ${e.message}` });
    }

    const result = await egressRunner.applyToContainer({
      containerId: policy.scopeKey,
      hostId: policy.hostId || 0,
    });

    await auditService.log({
      userId: req.user?.id,
      username: req.user?.username,
      ip: getClientIp(req),
      action: 'egress_policy_applied',
      details: { policyId: id, containerId: policy.scopeKey, hostId: policy.hostId },
    });

    res.json({ ok: true, scope: 'container', applied: true, output: result.output });
  } catch (err) {
    const msg = err.message || 'Internal server error';
    if (/DD_EGRESS_SIDECAR_ENDPOINT/.test(msg)) {
      return res.status(503).json({ error: msg });
    }
    log.error('apply egress policy', err);
    res.status(500).json({ error: msg });
  }
});

// POST /policies/:id/unapply — remove iptables redirect for this policy's scope.
router.post('/policies/:id/unapply', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const policy = egressFilter.getPolicy(id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    if (policy.scopeType === 'stack') {
      const result = await egressRunner.removeFromStack({
        stackName: policy.scopeKey,
        hostId: policy.hostId || 0,
      });
      await auditService.log({
        userId: req.user?.id,
        username: req.user?.username,
        ip: getClientIp(req),
        action: 'egress_policy_unapplied',
        details: { policyId: id, stackName: policy.scopeKey, hostId: policy.hostId, removedCount: result.removed.length },
      });
      return res.json({ ok: true, scope: 'stack', ...result });
    }

    const result = await egressRunner.removeFromContainer({
      containerId: policy.scopeKey,
      hostId: policy.hostId || 0,
    });

    await auditService.log({
      userId: req.user?.id,
      username: req.user?.username,
      ip: getClientIp(req),
      action: 'egress_policy_unapplied',
      details: { policyId: id, containerId: policy.scopeKey, hostId: policy.hostId },
    });

    res.json({ ok: true, scope: 'container', applied: false, output: result.output });
  } catch (err) {
    log.error('unapply egress policy', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET /policies/:id/status — is the filter currently installed in the target's netns?
router.get('/policies/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const policy = egressFilter.getPolicy(id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    if (policy.scopeType === 'stack') {
      const result = await egressRunner.statusOfStack({
        stackName: policy.scopeKey,
        hostId: policy.hostId || 0,
      });
      return res.json({ policyId: id, scope: 'stack', ...result });
    }
    const result = await egressRunner.isApplied({
      containerId: policy.scopeKey,
      hostId: policy.hostId || 0,
    });
    res.json({ policyId: id, scope: 'container', applied: result.applied, details: result.details });
  } catch (err) {
    log.error('status egress policy', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET /policies/:id/block-log/grouped — deny counts grouped by hostname (v6.9.1)
router.get('/policies/:id/block-log/grouped', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const policy = egressFilter.getPolicy(id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    const sinceHours = parseInt(req.query.sinceHours, 10) || 168;
    // v8.7.33 — cap at 1000, matching the sibling endpoint at line 372 of this file.
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const groups = egressFilter.getBlockLogGrouped(id, { sinceHours, limit });
    res.json({ policyId: id, sinceHours, groups });
  } catch (err) {
    log.error('block log grouped', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /policies/:id/allow-hostname — quick-action: add a hostname to this
// policy's allowlist. Switches preset to 'custom' if necessary. (v6.9.1)
router.post('/policies/:id/allow-hostname', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { hostname } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });

    const result = egressFilter.allowHostnameOnPolicy(id, hostname);

    await auditService.log({
      userId: req.user?.id,
      username: req.user?.username,
      ip: getClientIp(req),
      action: 'egress_policy_allowlist_added',
      details: { policyId: id, hostname: hostname.trim().toLowerCase(), added: result.added },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err.message || 'Internal server error';
    if (/not found|required|Invalid|soft-deleted/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    log.error('allow hostname', err);
    res.status(500).json({ error: msg });
  }
});

// GET /policies/:id/block-log — paginated deny log for this policy
router.get('/policies/:id/block-log', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const policy = egressFilter.getPolicy(id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const sinceId = parseInt(req.query.sinceId, 10) || 0;
    const entries = egressFilter.getBlockLog(id, { limit, sinceId });

    res.json({
      entries,
      policyId: id,
      enforced: ENFORCEMENT_ACTIVE,
      note: entries.length === 0
        ? 'No deny events logged yet. If enforcement is applied (see /status), either traffic is all allowed, nothing has tried to exfiltrate, or the sidecar\'s local deny log hasn\'t been ingested to the DB yet (ingestion pipeline lands in rc1).'
        : undefined,
    });
  } catch (err) {
    log.error('block log', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
