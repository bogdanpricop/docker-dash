'use strict';

// Child of smoke-ha-lease.js; no HTTP server, production DB or Docker client.
const cluster = require('../../src/services/cluster');
const messages = [];
process.on('message', async ({ id, command, args = [] }) => {
  try {
    let result;
    switch (command) {
      case 'leader': result = await cluster.isLeader(); break;
      case 'status': result = cluster.getStatus(); break;
      case 'quota': result = await cluster.rateLimitTick(...args); break;
      case 'subscribe': cluster.subscribe('canary', p => messages.push(p)); result = true; break;
      case 'publish': await cluster.publish('canary', args[0]); result = true; break;
      case 'messages': result = messages; break;
      case 'shutdown': await cluster.shutdown(); result = true; break;
      default: throw new Error('Unknown canary command');
    }
    process.send({ id, result });
  } catch (e) { process.send({ id, error: e.message }); }
});
