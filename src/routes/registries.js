'use strict';

const { Router } = require('express');
const registryService = require('../services/registry');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  res.json(registryService.list());
}));

router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const { name, url, username, password } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const id = registryService.create({ name, url, username, password, createdBy: req.user.id });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'registry_create', targetType: 'registry', targetId: String(id),
    details: { name, url }, ip: getClientIp(req),
  });
  res.status(201).json({ id, name, url });
}));

router.put('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const { name, url, username, password } = req.body;
  registryService.update(parseInt(req.params.id), { name, url, username, password });
  res.json({ ok: true });
}));

router.delete('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  registryService.remove(parseInt(req.params.id));
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'registry_delete', targetType: 'registry', targetId: req.params.id,
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

router.post('/:id/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await registryService.testConnection(parseInt(req.params.id));
  res.json(result);
}));

router.get('/:id/catalog', requireAuth, asyncHandler(async (req, res) => {
  const repos = await registryService.catalog(parseInt(req.params.id));
  res.json(repos);
}));

router.get('/:id/tags/*repo', requireAuth, asyncHandler(async (req, res) => {
  // Express 5 / path-to-regexp v8 returns splat params as arrays. Re-join
  // so downstream code keeps receiving "library/nginx"-style strings.
  const repo = Array.isArray(req.params.repo) ? req.params.repo.join('/') : req.params.repo;
  const tags = await registryService.tags(parseInt(req.params.id), repo);
  res.json(tags);
}));

// v7.6.0 — Delete a tag from a remote registry. Admin only, audited.
// Resolves tag → digest first via HEAD, then DELETEs by digest. Errors with
// a clear message when the registry has deletion disabled (REGISTRY_STORAGE_
// DELETE_ENABLED=false). Idempotent: a 404 from the delete is treated as
// success (already gone).
router.delete('/:id/tag/*ref', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const raw = Array.isArray(req.params.ref) ? req.params.ref.join('/') : req.params.ref;
  const lastColon = raw.lastIndexOf(':');
  if (lastColon === -1) return res.status(400).json({ error: 'ref must be repo:tag' });
  const repo = raw.substring(0, lastColon);
  const tag = raw.substring(lastColon + 1);

  let result;
  try {
    result = await registryService.deleteTag(parseInt(req.params.id), repo, tag);
  } catch (err) {
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'registry_tag_delete_failed', targetType: 'registry-tag',
      targetId: `${req.params.id}/${repo}:${tag}`,
      details: { error: err.message.substring(0, 300) },
      ip: getClientIp(req),
    });
    return res.status(502).json({ error: err.message });
  }

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'registry_tag_delete', targetType: 'registry-tag',
    targetId: `${req.params.id}/${repo}:${tag}`,
    details: { repo, tag, digest: result.digest },
    ip: getClientIp(req),
  });
  res.json(result);
}));

// v7.5.0 — Manifest inspect for the Browse page. Returns the raw manifest
// (so the UI can show layer count + sizes), digest, and content type.
router.get('/:id/manifest/*ref', requireAuth, asyncHandler(async (req, res) => {
  // splat is "<repo>/...":<tag-or-digest>". Repo can have slashes; the LAST
  // colon-separated chunk is the ref. Example: "library/nginx:latest" →
  // repo="library/nginx", ref="latest". Digest refs include their own
  // colon ("sha256:...") so we split from the right after a "@" or last ":".
  const raw = Array.isArray(req.params.ref) ? req.params.ref.join('/') : req.params.ref;
  let repo, ref;
  if (raw.includes('@')) {
    [repo, ref] = raw.split('@');
  } else {
    const lastColon = raw.lastIndexOf(':');
    if (lastColon === -1) return res.status(400).json({ error: 'ref must be repo:tag or repo@digest' });
    repo = raw.substring(0, lastColon);
    ref = raw.substring(lastColon + 1);
  }
  const data = await registryService.manifest(parseInt(req.params.id), repo, ref);
  // v8.1.0 — surface build provenance parsed from OCI annotations
  const provenance = require('../services/registry-provenance').parse(data);
  res.json({ ...data, provenance });
}));

// v7.5.0 — Push action. Tags + pushes a local image to the configured
// registry; streams progress as SSE (text/event-stream) so the UI can show
// per-layer progress in real time. Operator + admin only; admin-only would
// be too strict (operators manage app deployments). Audited on success or
// failure, with the size of the pushed image when known.
router.post('/:id/push', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { sourceImage, targetRepo, targetTag } = req.body || {};
  if (!sourceImage || !targetRepo || !targetTag) {
    return res.status(400).json({ error: 'sourceImage, targetRepo, targetTag are all required' });
  }

  const dockerService = require('../services/docker');
  const startedAt = Date.now();

  let push;
  try {
    push = await registryService.pushImage(
      dockerService, req.hostId, parseInt(req.params.id),
      sourceImage, targetRepo, targetTag,
    );
  } catch (err) {
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'registry_push_failed', targetType: 'image', targetId: sourceImage,
      details: { error: err.message.substring(0, 300), targetRepo, targetTag },
      ip: getClientIp(req),
    });
    return res.status(502).json({ error: err.message });
  }

  // Stream NDJSON push events to the client as SSE. Each layer/status line
  // gets one `data:` event. On error inside the stream we still send a final
  // event so the UI can show the message; HTTP status stays 200 because we
  // already sent headers.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx/Caddy buffering for this response
  });

  let pushFailed = false;
  let lastError = null;

  const docker = dockerService.getDocker(req.hostId);
  docker.modem.followProgress(push.stream,
    (err) => {
      if (err || pushFailed) {
        const msg = (err?.message) || lastError || 'Push failed';
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`); } catch { /* client closed */ }
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: 'registry_push_failed', targetType: 'image', targetId: push.fullImage,
          details: {
            error: msg.substring(0, 300),
            registry: push.registry,
            sourceImage, targetRepo, targetTag,
            durationMs: Date.now() - startedAt,
          },
          ip: getClientIp(req),
        });
      } else {
        try { res.write(`event: done\ndata: ${JSON.stringify({ ok: true, image: push.fullImage })}\n\n`); } catch { /* client closed */ }
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: 'registry_push', targetType: 'image', targetId: push.fullImage,
          details: {
            registry: push.registry,
            sourceImage, targetRepo, targetTag,
            durationMs: Date.now() - startedAt,
          },
          ip: getClientIp(req),
        });
      }
      try { res.end(); } catch { /* already ended */ }
    },
    (event) => {
      // Each progress event: { status, id?, progressDetail?, error? }
      if (event && event.error) {
        pushFailed = true;
        lastError = event.error;
      }
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client closed */ }
    }
  );
}));

// Pull image from a configured registry
router.post('/:id/pull', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { image, tag } = req.body;
  if (!image) return res.status(400).json({ error: 'image name is required' });

  const registry = registryService.get(parseInt(req.params.id));
  if (!registry) return res.status(404).json({ error: 'Registry not found' });

  // Build full image name with registry prefix
  const registryHost = new URL(registry.url).host;
  const fullImage = `${registryHost}/${image}:${tag || 'latest'}`;

  // Get Docker and pull with auth
  const dockerService = require('../services/docker');
  const docker = dockerService.getDocker(req.hostId);

  // v8.7.28 — shared 10-min timeout via utils/docker-pull, authconfig forwarded.
  const auth = registryService.getAuthForImage(fullImage);
  await require('../utils/docker-pull').pullImage(docker, fullImage, auth ? { authconfig: auth } : undefined);

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'registry_pull', targetType: 'image', targetId: fullImage,
    details: { registry: registry.name, image: fullImage }, ip: getClientIp(req),
  });

  res.json({ ok: true, image: fullImage });
}));

// ───────────────────────────────────────────────────────────────────────
// v8.1.0 — Registry Hygiene Pack
//
// Adds three orthogonal feature surfaces:
//   1. Repository typing (local / remote / virtual) — `/repos` endpoints
//   2. Retention policies with dry-run — `/retention` endpoints
//   3. Build provenance — already wired into the `/manifest` endpoint above
//
// All admin-gated for writes; reads inherit the existing audit-log requirement.
// ───────────────────────────────────────────────────────────────────────

// List configured repository entries for a registry credential.
// Auto-creates a default 'local *' row on first read so existing UX
// (Browse, Push) just works for v7.5.0 operators upgrading to v8.1.0.
router.get('/:id/repos', requireAuth, asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const repos = registryService.listRepos(registryId);
  if (repos.length === 0) {
    // Auto-seed default local catch-all (deep-spec D1)
    registryService.upsertRepo({
      registryId, repoPath: '*', type: 'local',
    }, req.user.id);
    res.json(registryService.listRepos(registryId));
    return;
  }
  res.json(repos);
}));

// Create or update a repository entry. Validates type + required fields per type.
router.post('/:id/repos', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { repoPath, type, upstreamUrl, upstreamUsername, upstreamPassword, virtualMemberIds } = req.body || {};
  if (!repoPath || !type) return res.status(400).json({ error: 'repoPath and type are required' });
  if (!['local', 'remote', 'virtual'].includes(type)) return res.status(400).json({ error: 'type must be local, remote, or virtual' });
  if (type === 'remote' && !upstreamUrl) return res.status(400).json({ error: 'upstreamUrl is required for remote type' });
  if (type === 'virtual' && (!Array.isArray(virtualMemberIds) || virtualMemberIds.length === 0)) {
    return res.status(400).json({ error: 'virtualMemberIds (non-empty array) is required for virtual type' });
  }
  const id = registryService.upsertRepo({
    registryId, repoPath, type, upstreamUrl, upstreamUsername, upstreamPassword, virtualMemberIds,
  }, req.user.id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'registry_repo_create', targetType: 'registry-repo',
    targetId: `${registryId}/${repoPath}`,
    details: { type, upstreamUrl: upstreamUrl ? new URL(upstreamUrl).host : null },
    ip: getClientIp(req),
  });
  res.status(201).json({ id, registryId, repoPath, type });
}));

router.delete('/:id/repos/:repoId', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const repoId = parseInt(req.params.repoId);
  const before = registryService.listRepos(parseInt(req.params.id)).find(r => r.id === repoId);
  if (!before) return res.status(404).json({ error: 'Repository entry not found' });
  registryService.deleteRepo(repoId);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'registry_repo_delete', targetType: 'registry-repo',
    targetId: `${req.params.id}/${before.repoPath}`,
    details: { type: before.type },
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// ─── Retention Policies ────────────────────────────────────────────────

// Helper: resolve registry_repos.id from registryId + repoPath, auto-creating
// the row if it doesn't exist yet (so retention works even when operator
// hasn't manually classified the repo as local).
function _resolveRepoId(registryId, repoPath, userId) {
  const existing = registryService.listRepos(registryId).find(r => r.repoPath === repoPath);
  if (existing) return existing.id;
  return registryService.upsertRepo({
    registryId, repoPath, type: 'local',
  }, userId);
}

// Read a policy (or null if none).
router.get('/:id/repos/:repoPath/retention', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const repoPath = req.params.repoPath;
  const repoId = _resolveRepoId(registryId, repoPath, req.user.id);
  const policy = registryService.getRetentionPolicy(repoId);
  res.json(policy || { repoId, exists: false });
}));

// Save a policy (create or update). Defaults to enabled=0 (dry-run only).
router.put('/:id/repos/:repoPath/retention', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { rule, enabled, scheduleCron } = req.body || {};
  if (!rule || typeof rule !== 'object') return res.status(400).json({ error: 'rule (object) is required' });
  const registryId = parseInt(req.params.id);
  const repoPath = req.params.repoPath;
  const repoId = _resolveRepoId(registryId, repoPath, req.user.id);
  const existed = !!registryService.getRetentionPolicy(repoId);
  registryService.upsertRetentionPolicy({
    registryRepoId: repoId, rule, enabled: enabled === true, scheduleCron,
  }, req.user.id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: existed ? 'retention_policy_update' : 'retention_policy_create',
    targetType: 'registry-repo', targetId: `${registryId}/${repoPath}`,
    details: { rule, enabled: enabled === true },
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

router.delete('/:id/repos/:repoPath/retention', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const repoPath = req.params.repoPath;
  const repoId = _resolveRepoId(registryId, repoPath, req.user.id);
  registryService.deleteRetentionPolicy(repoId);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'retention_policy_delete', targetType: 'registry-repo',
    targetId: `${registryId}/${repoPath}`,
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// Preview (dry-run) — fetches tags + manifests, evaluates rule, returns plan.
router.post('/:id/repos/:repoPath/retention/preview', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { rule } = req.body || {};
  if (!rule || typeof rule !== 'object') return res.status(400).json({ error: 'rule (object) is required' });
  const registryId = parseInt(req.params.id);
  const repoPath = req.params.repoPath;
  const retentionCron = require('../services/retention-cron');
  const retention = require('../services/retention');
  const tags = await retentionCron._internals._gatherTagsWithMetadata(registryId, repoPath);
  const plan = retention.evaluate({ tags, rule });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'retention_dry_run', targetType: 'registry-repo',
    targetId: `${registryId}/${repoPath}`,
    details: {
      candidateTags: tags.length, wouldDelete: plan.toDelete.length,
      bytes: plan.summary.bytes, cappedAt: plan.summary.cappedAt,
    },
    ip: getClientIp(req),
  });
  res.json(plan);
}));

// Run now (manual trigger of an enabled or disabled policy — admin override).
router.post('/:id/repos/:repoPath/retention/run', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { rule, dryRun } = req.body || {};
  if (!rule || typeof rule !== 'object') return res.status(400).json({ error: 'rule (object) is required' });
  const registryId = parseInt(req.params.id);
  const repoPath = req.params.repoPath;
  const retentionCron = require('../services/retention-cron');
  const retention = require('../services/retention');
  const tags = await retentionCron._internals._gatherTagsWithMetadata(registryId, repoPath);
  const plan = retention.evaluate({ tags, rule });
  const result = await retention.execute({
    registryService, registryId, repoPath, plan, dryRun: dryRun !== false,
    auditCtx: { userId: req.user.id, username: req.user.username, ip: getClientIp(req) },
  });
  res.json({ plan: plan.summary, result });
}));

module.exports = router;
