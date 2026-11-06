'use strict';

const changes = require('../placement-changes');

const TYPE = 'placement.change';

async function execute(context, options = {}) {
  return changes.executeOperation(context.request.changeId, context, options);
}

async function reconcile(context, options = {}) {
  return changes.executeOperation(context.request.changeId, context, options);
}

async function cancel(context, options = {}) {
  return changes.cancelOperation(context.request.changeId, options);
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 86400,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = { TYPE, register, execute, reconcile, cancel };
