'use strict';

// v8.1.0 — Retention sweep cron.
//
// Daily at 03:17 (off-:00 to spread API load across deployments).
// Leader-only via the existing _m() wrapper in jobs/index.js.
// Iterates all enabled retention policies, runs evaluate + execute,
// updates last_run_at + last_run_summary on each policy row.

const { getDb } = require('../db');
const log = require('../utils/logger')('retention-cron');
const retention = require('./retention');
const registryService = require('./registry');

/**
 * Run all enabled retention policies. Called from the daily cron.
 * Skips disabled policies (those are dry-run-only via the API; the cron
 * doesn't run them — operator triggers explicitly via Preview button).
 */
async function runAllPolicies() {
  const db = getDb();
  const policies = db.prepare(`
    SELECT
      rp.id              AS policy_id,
      rp.rule_json       AS rule_json,
      rp.enabled         AS enabled,
      rr.id              AS repo_id,
      rr.registry_id     AS registry_id,
      rr.repo_path       AS repo_path
    FROM retention_policies rp
    JOIN registry_repos rr ON rr.id = rp.registry_repo_id
    WHERE rp.enabled = 1
  `).all();

  if (policies.length === 0) {
    log.debug('No enabled retention policies to run');
    return { ran: 0, errored: 0 };
  }

  log.info(`Running ${policies.length} retention policies`);

  let ran = 0, errored = 0;
  for (const p of policies) {
    try {
      await _runOne(p);
      ran++;
    } catch (err) {
      log.error('Policy run failed', {
        policyId: p.policy_id,
        repo: p.repo_path,
        error: err.message,
      });
      errored++;
    }
  }
  return { ran, errored };
}

async function _runOne(policy) {
  const db = getDb();
  const rule = JSON.parse(policy.rule_json);

  // Fetch tags via the registry service. We need pushedAt + sizeBytes for
  // the rule to evaluate properly, so iterate manifests for each tag.
  const tags = await _gatherTagsWithMetadata(policy.registry_id, policy.repo_path);

  const plan = retention.evaluate({ tags, rule });

  if (plan.toDelete.length === 0) {
    db.prepare(`
      UPDATE retention_policies
         SET last_run_at = CURRENT_TIMESTAMP,
             last_run_summary = ?
       WHERE id = ?
    `).run(JSON.stringify({
      runAt: new Date().toISOString(),
      deleted: 0,
      bytes: 0,
      ok: true,
    }), policy.policy_id);
    return;
  }

  const result = await retention.execute({
    registryService,
    registryId: policy.registry_id,
    repoPath: policy.repo_path,
    plan,
    dryRun: false,
    auditCtx: { userId: null, username: 'retention-cron' },
  });

  db.prepare(`
    UPDATE retention_policies
       SET last_run_at = CURRENT_TIMESTAMP,
           last_run_summary = ?
     WHERE id = ?
  `).run(JSON.stringify({
    runAt: new Date().toISOString(),
    deleted: result.deleted.length,
    errors: result.errors.length,
    cappedAt: result.cappedAt,
    bytes: result.deleted.reduce((s, t) => s + (t.sizeBytes || 0), 0),
    ok: result.errors.length === 0,
  }), policy.policy_id);
}

/**
 * Gather tags + metadata for a repo. The Distribution V2 API requires
 * a manifest fetch per tag to get size + pushed-at; for repos with many
 * tags this is N requests. Refuse repositories above 1000 tags rather than
 * making a deletion plan from a truncated inventory.
 */
async function _gatherTagsWithMetadata(registryId, repoPath) {
  // For now, list tags only — pushedAt + sizeBytes come from manifests.
  // Missing timestamps are allowed; missing manifests are not safe to ignore.
  const tagNames = await registryService.tags(registryId, repoPath);
  if (!Array.isArray(tagNames) || tagNames.length === 0) return [];
  if (tagNames.length > 1000) {
    throw new Error('Retention requires a complete inventory; repositories above 1000 tags are not supported');
  }

  const out = [];
  for (const tag of tagNames.slice(0, 1000)) {
    try {
      const m = await registryService.manifest(registryId, repoPath, tag);
      const layers = m.manifest?.layers || [];
      const sizeBytes = layers.reduce((s, l) => s + (l.size || 0), 0);
      out.push({
        tag,
        digest: m.digest,
        // Distribution doesn't expose push timestamp; fall back to manifest's
        // image config "created" if available. For untagged manifests in the
        // future, this will need a different path.
        pushedAt: _extractCreated(m.manifest),
        sizeBytes,
        isTagged: true,
      });
    } catch (err) {
      log.warn('Failed to fetch manifest for tag during retention sweep', {
        repo: repoPath, tag, error: err.message,
      });
      // An unread tag might share a digest with a deletion candidate. Without
      // its metadata we cannot enforce protected aliases or the minimum floor.
      throw new Error('Retention requires complete manifest metadata; no deletions were planned');
    }
  }
  return out;
}

function _extractCreated(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest.annotations && manifest.annotations['org.opencontainers.image.created']) {
    return manifest.annotations['org.opencontainers.image.created'];
  }
  // For multi-arch indexes, no per-image created. Caller will treat as oldest.
  return null;
}

module.exports = { runAllPolicies, _internals: { _runOne, _gatherTagsWithMetadata } };
