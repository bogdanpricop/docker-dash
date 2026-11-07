'use strict';

const config = require('../config');
const { getDb } = require('../db');
const docker = require('./docker');

function claimAutomatic(db, schedule, now) {
  if (config.features.readOnly) return false;
  const slot = Math.floor(now.getTime() / 60000);
  // A later tick must never be replaced by an older worker that resumed late.
  return db.prepare(`
    UPDATE scheduled_actions SET last_auto_run_slot = ?
    WHERE id = ? AND enabled = 1 AND cron = ? AND action = ? AND host_id = ? AND container_id = ?
      AND (last_auto_run_slot IS NULL OR last_auto_run_slot < ?)
  `).run(slot, schedule.id, schedule.cron, schedule.action, schedule.host_id, schedule.container_id, slot).changes === 1;
}

async function execute(schedule, db = getDb()) {
  const start = Date.now();
  let failure;
  try { await docker.containerAction(schedule.container_id, schedule.action, schedule.host_id); }
  catch (error) { failure = error; }
  const duration = Date.now() - start;
  try {
    db.transaction(() => {
      // Deleting a schedule while Docker is running must not resurrect its history.
      if (!db.prepare('SELECT 1 FROM scheduled_actions WHERE id = ?').get(schedule.id)) return;
      const status = failure ? 'error' : 'success';
      const reason = failure ? String(failure.message || 'Docker action failed').slice(0, 1000) : null;
      db.prepare(`INSERT INTO schedule_history
        (schedule_id, container_id, action, status, error_message, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(schedule.id, schedule.container_id, schedule.action, status, reason, duration);
      db.prepare(`UPDATE scheduled_actions SET last_run_at = datetime('now'), last_run_status = ?,
        last_run_error = ?, run_count = run_count + ? WHERE id = ?`)
        .run(status, reason, failure ? 0 : 1, schedule.id);
    })();
  } catch (error) {
    // Docker has already answered. A metadata failure must never encourage
    // retrying a successful Docker operation.
    if (!failure) return { duration, historyRecorded: false };
    throw failure;
  }
  if (failure) throw failure;
  return { duration, historyRecorded: true };
}

module.exports = { claimAutomatic, execute };
