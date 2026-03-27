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
