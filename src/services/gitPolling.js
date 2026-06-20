'use strict';

const { getDb } = require('../db');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('git-polling');

class GitPollingManager {
  constructor() {
    this._intervals = new Map(); // stackId → intervalId
    this._checking = new Set();  // prevent overlap
  }

  startAll() {
    const db = getDb();
    let stacks = [];
    try {
      stacks = db.prepare('SELECT id, polling_interval_seconds FROM git_stacks WHERE polling_enabled = 1').all();
    } catch { /* table may not exist yet */ }

    for (const stack of stacks) {
      this.start(stack.id, stack.polling_interval_seconds);
    }

    if (stacks.length > 0) {
      log.info(`Git polling started for ${stacks.length} stack(s)`);
    }

    // v8.7.23 — subscribe to cluster pubsub so that when an admin toggles
    // polling on a stack via the API on a READER replica, the LEADER
    // (which is the only replica that actually runs polling) reconciles
    // its in-memory _intervals to match the new DB row. In standalone
    // mode cluster.subscribe is a no-op. We register the subscription
    // here (inside startAll, which fires onBecomeLeader) rather than at
    // module load, so a replica that becomes leader later still picks
    // up reconcile messages — and one that becomes reader stops getting
    // them via the cluster.onBecomeReader → stopAll path.
    try {
      const cluster = require('./cluster');
      cluster.subscribe('git-polling:reconcile', (payload) => {
        if (payload && Number.isInteger(payload.stackId)) {
          this.reconcileStack(payload.stackId).catch((e) =>
            log.warn(`reconcile via pubsub failed for stack ${payload.stackId}`, e.message));
        }
      });
    } catch { /* cluster not loaded — standalone only, no fanout needed */ }
  }

  start(stackId, intervalSeconds) {
    this.stop(stackId);
    const ms = Math.max(intervalSeconds || 300, 60) * 1000;
    const intervalId = setInterval(() => this._check(stackId), ms);
    this._intervals.set(stackId, intervalId);
    log.debug(`Polling started for stack ${stackId} every ${Math.max(intervalSeconds || 300, 60)}s`);
  }

  stop(stackId) {
    const intervalId = this._intervals.get(stackId);
    if (intervalId) {
      clearInterval(intervalId);
      this._intervals.delete(stackId);
    }
  }

  stopAll() {
    for (const [, intervalId] of this._intervals) {
      clearInterval(intervalId);
    }
    this._intervals.clear();
    log.info('All git polling stopped');
  }

  restart(stackId, intervalSeconds) {
    this.start(stackId, intervalSeconds);
  }

  /**
   * v8.7.23 — reconcile in-memory polling state for a single stack to
   * match what's currently in the DB. Called from the API route after
   * a user toggles `polling_enabled` or changes `polling_interval_seconds`,
   * so the change takes effect immediately instead of waiting for the
   * next server restart.
   *
   * Leader-gated: in HA mode, only the leader has any intervals at all
   * (per the cluster.onBecomeLeader hook in jobs/index.js that gates
   * startAll/stopAll). Calling start() on a reader would create a
   * duplicate polling loop racing with the leader; we just skip and
   * rely on the cluster pubsub fanout (below) to tell the actual
   * leader to reconcile.
   *
   * In standalone, cluster.isLeader() always resolves true synchronously
   * (per cluster.js stub), so this branch always reconciles.
   */
  async reconcileStack(stackId) {
    try {
      const cluster = require('./cluster');
      if (!(await cluster.isLeader())) return;
    } catch { /* cluster not loaded yet — treat as standalone */ }

    const db = getDb();
    let stack;
    try {
      stack = db.prepare(
        'SELECT polling_enabled, polling_interval_seconds FROM git_stacks WHERE id = ?'
      ).get(stackId);
    } catch { /* table missing on a partially-migrated install — skip */ return; }

    if (!stack) {
      // Stack was deleted — make sure no interval lingers.
      this.stop(stackId);
      return;
    }
    if (stack.polling_enabled) {
      // start() is idempotent — it calls this.stop(stackId) first, so
      // an interval-change or a no-op re-enable both behave correctly.
      this.start(stackId, stack.polling_interval_seconds);
    } else {
      this.stop(stackId);
    }
  }

  async _check(stackId) {
    if (this._checking.has(stackId)) return;
    this._checking.add(stackId);

    try {
      const gitService = require('./git');
      const result = await gitService.checkForUpdates(stackId);
      const db = getDb();

      db.prepare('UPDATE git_stacks SET last_check_at = ? WHERE id = ?').run(now(), stackId);

      if (result.has_updates) {
        const stack = gitService.getStack(stackId);
        if (stack?.deploy_on_push) {
          await gitService.triggerDeploy(stackId, 'polling');
          log.info('Polling triggered deploy', { stackId, behind: result.commits_behind });
        } else {
          gitService._broadcast('git:update:available', {
            stack_id: stackId, stack_name: stack?.stack_name,
            commits_behind: result.commits_behind,
          });
        }
      }
    } catch (err) {
      log.error(`Polling check failed for stack ${stackId}`, err.message);
    } finally {
      this._checking.delete(stackId);
    }
  }
}

module.exports = new GitPollingManager();
