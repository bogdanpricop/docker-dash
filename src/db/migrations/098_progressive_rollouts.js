'use strict';

exports.up = function (db) {
  try { db.exec('ALTER TABLE git_stacks ADD COLUMN rollout_policy TEXT'); } catch {}
  try { db.exec('ALTER TABLE git_deployments ADD COLUMN rollout_policy_json TEXT'); } catch {}
  try { db.exec('ALTER TABLE git_deployments ADD COLUMN target_results_json TEXT'); } catch {}
};
