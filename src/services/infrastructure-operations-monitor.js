'use strict';

const operations = require('./infrastructure-operations');
const log = require('../utils/logger')('infrastructure-operations');

let timer = null;
let initial = null;
let running = false;

async function tick(now = new Date()) {
  if (running) return { schedules: [], approvals: [] };
  if (!await require('./cluster').isLeader()) return { schedules: [], approvals: [] };
  running = true;
  try {
    const schedules = operations.runDueSchedules(now); const approvals = operations.sweepApprovals(now);
    if (schedules.length || approvals.length) log.info('Automation operation timers evaluated', {
      schedules: schedules.length, approvals: approvals.length,
      readySchedules: schedules.filter(item => item.decision === 'ready').length,
      workflowExecutionsStarted: 0, providerMutationsStarted: 0,
    });
    return { schedules, approvals };
  } finally { running = false; }
}

function start() {
  if (timer) return;
  const intervalMs = Math.max(30_000, Number(process.env.INFRASTRUCTURE_OPERATIONS_TICK_MS) || 30_000);
  initial = setTimeout(() => tick().catch(error => log.warn('Initial automation timer tick failed', { error: error.message })), 20_000);
  timer = setInterval(() => tick().catch(error => log.warn('Automation timer tick failed', { error: error.message })), intervalMs);
  initial.unref(); timer.unref();
}

function stop() {
  if (initial) clearTimeout(initial);
  if (timer) clearInterval(timer);
  initial = null; timer = null; running = false;
}

module.exports = { start, stop, tick };
