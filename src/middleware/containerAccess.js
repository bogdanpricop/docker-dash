'use strict';

const docker = require('../services/docker');
const permissions = require('../services/permissions');
const asyncHandler = require('../utils/asyncHandler');

module.exports = function requireContainerAccess(level = 'view', parameter = 'id') {
  return asyncHandler(async (req, res, next) => {
    // Global administrators are deliberately exempt from stack overrides.
    if (req.user?.role === 'admin') return next();
    let inspection;
    try {
      inspection = await docker.inspectContainer(req.params[parameter], req.hostId);
    } catch (error) {
      return res.status(error.statusCode === 404 ? 404 : 503).json({
        error: error.statusCode === 404 ? 'Container not found' : 'Container access could not be verified',
      });
    }
    const stack = inspection.labels?.['com.docker.compose.project'] || '_standalone';
    const role = permissions.getEffectiveRole(req.user?.id, stack, req.user?.role);
    if (!permissions.hasPermission(role, level)) {
      return res.status(403).json({ error: 'Insufficient stack permissions for this container' });
    }
    next();
  });
};
