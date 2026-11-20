'use strict';

exports.up = db => db.exec(`
  ALTER TABLE ai_compute_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';
  DROP INDEX ai_compute_host_job;
  CREATE UNIQUE INDEX ai_compute_host_job ON ai_compute_jobs(host_id)
    WHERE action!='download' AND status IN ('queued','running','needs_review');
  CREATE UNIQUE INDEX ai_compute_host_download ON ai_compute_jobs(host_id)
    WHERE action='download' AND status='running';
  CREATE UNIQUE INDEX ai_compute_model_download ON ai_compute_jobs(host_id,json_extract(plan_json,'$.recipeId'))
    WHERE action='download' AND status IN ('queued','running');
`);
