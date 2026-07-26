'use strict';

const { ProviderOperationEngine } = require('./engine');
const policy = require('./policy');
const config = require('../../config');

const engine = new ProviderOperationEngine({ policy, ...(config.providerOperations || {}) });

module.exports = engine;
module.exports.policy = policy;
module.exports.ProviderOperationEngine = ProviderOperationEngine;
