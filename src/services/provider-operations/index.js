'use strict';

const { ProviderOperationEngine } = require('./engine');
const policy = require('./policy');
const config = require('../../config');

const engine = new ProviderOperationEngine({ policy, ...(config.providerOperations || {}) });
require('./handlers/vm-power').register(engine);
require('./handlers/vm-snapshot').register(engine);
require('./handlers/vm-provision').register(engine);
require('./handlers/vm-migration').register(engine);
require('./handlers/placement-change').register(engine);
require('./handlers/vm-backup').register(engine);
require('./handlers/vm-restore').register(engine);
require('./handlers/recovery-drill').register(engine);

module.exports = engine;
module.exports.policy = policy;
module.exports.ProviderOperationEngine = ProviderOperationEngine;
