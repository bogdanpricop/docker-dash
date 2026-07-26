'use strict';

const { ProviderOperationEngine } = require('./engine');
const policy = require('./policy');
const config = require('../../config');

const engine = new ProviderOperationEngine({ policy, ...(config.providerOperations || {}) });
require('./handlers/vm-power').register(engine);
require('./handlers/vm-snapshot').register(engine);
require('./handlers/vm-provision').register(engine);

module.exports = engine;
module.exports.policy = policy;
module.exports.ProviderOperationEngine = ProviderOperationEngine;
