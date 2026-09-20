'use strict';

// v8.1.0 — Retention policy evaluator + executor.
//
// evaluate() is pure: given tags + manifests + rule, return the deletion plan.
//   No I/O, no DB, no network. Trivially testable.
// execute() runs the plan against a real registry via existing deleteTag().
//   Each delete writes its own audit_log entry (registry_tag_delete).
//   The umbrella retention_executed entry summarizes the whole run.
//
// Safety layers (per deep-spec §9, ordered by which kicks in first):
//   1. Policies default to enabled=0 (dry-run only)
//   2. minTagsToKeep hard floor (default 3, can't go below 1)
//   3. protectTagPatterns default ['latest','v*','main','master','prod-*','stable']
//   4. Server-side cap: 200 deletions per single run (SERVER_HARD_CAP)
//   5. Per-deletion audit log (immutable hash-chained)

const log = require('../utils/logger')('retention');

const SERVER_HARD_CAP = 200;
const DEFAULT_PROTECTED = ['latest', 'v*', 'main', 'master', 'prod-*', 'stable'];

/**
 * Pure: evaluate a rule against the current state of a repo.
 *
 * @param {object} input
 * @param {Array<{tag, digest, pushedAt, sizeBytes, isTagged}>} input.tags
 * @param {object} input.rule
 * @returns {{ toDelete, toKeep, summary }}
 */
function evaluate({ tags, rule }) {
  if (!Array.isArray(tags)) tags = [];
  if (!rule || typeof rule !== 'object') rule = {};

  const minFloor = Math.max(1, parseInt(rule.minTagsToKeep, 10) || 3);
  const protectPatterns = (Array.isArray(rule.protectTagPatterns) ? rule.protectTagPatterns : DEFAULT_PROTECTED)
    .map(_globToRegex);

  // Sort newest-first by pushedAt. Missing pushedAt → treat as oldest.
  const sorted = [...tags].sort((a, b) => {
    const aP = a.pushedAt || '';
    const bP = b.pushedAt || '';
    if (!aP && !bP) return 0;
    if (!aP) return 1;
    if (!bP) return -1;
    return bP.localeCompare(aP);
  });

  const toKeep = [];
  const toDelete = [];

  // Pass 1: apply protect-pattern + min-floor unconditionally
  const candidates = [];
  for (const t of sorted) {
    if (t.tag && protectPatterns.some(re => re.test(t.tag))) {
      toKeep.push({ ...t, reason: 'protected-pattern' });
      continue;
    }
    if (toKeep.length < minFloor) {
      toKeep.push({ ...t, reason: 'min-floor' });
      continue;
    }
    candidates.push(t);
  }

  // Pass 2: apply rule clauses to remaining candidates
  let kept = 0;
  const deleteTagPatterns = Array.isArray(rule.deleteTagPatterns)
    ? rule.deleteTagPatterns.map(_globToRegex)
    : [];

  for (const t of candidates) {
    let deleteReason = null;

    // keepLastN — keep the first N candidates (which are newest, since sorted)
    if (rule.keepLastN != null && kept < rule.keepLastN) {
      kept++;
      toKeep.push({ ...t, reason: 'keep-last-n' });
      continue;
    }
    if (rule.keepLastN != null && kept >= rule.keepLastN) {
      deleteReason = `older than keepLastN=${rule.keepLastN}`;
    }

    // deleteUntaggedAfterDays — only kicks in for untagged manifests
    if (rule.deleteUntaggedAfterDays != null && t.isTagged === false) {
      const daysOld = _daysBetween(t.pushedAt, new Date().toISOString());
      if (daysOld >= rule.deleteUntaggedAfterDays) {
        deleteReason = `untagged ${daysOld}d old`;
      }
    }

    // deleteTagPatterns — explicit pattern match
    if (deleteTagPatterns.length > 0 && t.tag) {
      if (deleteTagPatterns.some(re => re.test(t.tag))) {
        deleteReason = `matches deleteTagPattern`;
      }
    }

    if (deleteReason) {
      toDelete.push({ ...t, reason: deleteReason });
    } else {
      toKeep.push({ ...t, reason: 'no-rule-matched' });
    }
  }

  // Apply server hard cap. Anything past 200 moves back to toKeep with reason.
  let cappedAt = null;
  if (toDelete.length > SERVER_HARD_CAP) {
    cappedAt = SERVER_HARD_CAP;
    const overflow = toDelete.slice(SERVER_HARD_CAP);
    toDelete.length = SERVER_HARD_CAP;
    for (const t of overflow) toKeep.push({ ...t, reason: 'server-cap' });
  }

  // Distribution deletes manifests by digest, removing EVERY tag referencing
  // that manifest. A disposable alias must not delete a protected/kept tag.
  const keptDigests = new Set(toKeep.map(t => t.digest).filter(Boolean));
  for (let i = toDelete.length - 1; i >= 0; i--) {
    if (toDelete[i].digest && keptDigests.has(toDelete[i].digest)) {
      toKeep.push({ ...toDelete.splice(i, 1)[0], reason: 'shared-kept-digest' });
    }
  }

  const summary = {
    count: toDelete.length,
    bytes: toDelete.reduce((s, t) => s + (t.sizeBytes || 0), 0),
    cappedAt,
    reasonCounts: _countBy(toDelete, t => t.reason),
  };

  return { toDelete, toKeep, summary };
}

/**
 * Execute a deletion plan. Dry-run = no actual delete calls.
 *
 * @param {object} input
 * @param {object} input.registryService  — reference to ../services/registry
 * @param {number} input.registryId
 * @param {string} input.repoPath
 * @param {object} input.plan             — output of evaluate()
 * @param {boolean} input.dryRun
 * @param {object} input.auditCtx         — { userId, username, ip }
 */
async function execute({ registryService, registryId, repoPath, plan, dryRun, auditCtx = {} }) {
  if (dryRun) {
    return {
      deleted: plan.toDelete.map(t => ({
        tag: t.tag, digest: t.digest, sizeBytes: t.sizeBytes, reason: t.reason,
      })),
      errors: [],
      dryRun: true,
      cappedAt: plan.summary.cappedAt,
    };
  }

  const deleted = [];
  const errors = [];

  for (const t of plan.toDelete) {
    if (!t.tag) {
      // Untagged manifest: delete by digest directly. Distribution allows
      // DELETE /v2/<repo>/manifests/<digest> the same way.
      // The existing registry.deleteTag() requires a tag, so untagged manifests
      // need a separate path. v8.1.0 punts: skip untagged, document in CHANGELOG.
      // (deleteUntaggedAfterDays still has value as a future hook.)
      errors.push({ digest: t.digest, error: 'Untagged manifest deletion not implemented in v8.1.0' });
      continue;
    }
    try {
      if (!t.digest) throw new Error('Missing planned manifest digest; refresh the retention plan');
      await registryService.deleteTag(registryId, repoPath, t.tag, { expectedDigest: t.digest });
      deleted.push({ tag: t.tag, digest: t.digest, sizeBytes: t.sizeBytes, reason: t.reason });
      require('./audit').log({
        ...auditCtx, action: 'registry_tag_delete', targetType: 'registry-repo',
        targetId: `${registryId}/${repoPath}`,
        details: { tag: t.tag, digest: t.digest, reason: t.reason, source: 'retention' },
      });
    } catch (err) {
      log.warn('Retention deletion failed', { repo: repoPath, tag: t.tag, error: err.message });
      errors.push({ tag: t.tag, error: String(err.message).substring(0, 200) });
      // Continue — never bail on first error
    }
  }

  // Umbrella audit entry summarizing the whole run
  try {
    require('./audit').log({
      userId: auditCtx.userId,
      username: auditCtx.username,
      ip: auditCtx.ip,
      action: 'retention_executed',
      targetType: 'registry-repo',
      targetId: `${registryId}/${repoPath}`,
      details: {
        deletedCount: deleted.length,
        errorCount: errors.length,
        bytesReclaimed: deleted.reduce((s, t) => s + (t.sizeBytes || 0), 0),
        cappedAt: plan.summary.cappedAt,
      },
    });
  } catch (auditErr) {
    log.warn('Retention audit log failed (non-fatal)', { error: auditErr.message });
  }

  return { deleted, errors, dryRun: false, cappedAt: plan.summary.cappedAt };
}

// Helpers — exported via _internals for tests

function _globToRegex(glob) {
  // Escape regex specials except `*` (which we map to `.*`)
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function _daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.floor((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}

function _countBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const k = fn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = {
  evaluate,
  execute,
  SERVER_HARD_CAP,
  DEFAULT_PROTECTED,
  _internals: { _globToRegex, _daysBetween, _countBy },
};
