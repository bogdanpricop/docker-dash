'use strict';

const delivery = require('./infrastructure-delivery');
const log = require('../utils/logger')('infrastructure-reconcile');

let timer = null;
let initial = null;
let running = false;

async function tick() {
  if (running) return [];
  if (!await require('./cluster').isLeader()) return [];
  running = true;
  try {
    const results = delivery.runDueControllers();
    if (results.length) log.info('Continuous infrastructure reconciliation evaluated', {
      controllers: results.length, conflicts: results.filter(item => item.conflict).length,
      errors: results.filter(item => item.error).length, providerMutationsScheduled: 0,
    });
    return results;
  } finally { running = false; }
}

function start() {
  if (timer) return;
  const intervalMs = Math.max(30_000, Number(process.env.INFRASTRUCTURE_RECONCILE_TICK_MS) || 60_000);
  initial = setTimeout(() => tick().catch(error => log.warn('Initial reconciliation tick failed', { error: error.message })), 15_000);
  timer = setInterval(() => tick().catch(error => log.warn('Reconciliation tick failed', { error: error.message })), intervalMs);
  initial.unref(); timer.unref();
}

function stop() {
  if (initial) clearTimeout(initial);
  if (timer) clearInterval(timer);
  initial = null; timer = null; running = false;
}

module.exports = { start, stop, tick };
