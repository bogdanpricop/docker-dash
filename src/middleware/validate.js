'use strict';

/**
 * Validate that req.params.id is a valid integer.
 * Returns 400 if invalid instead of passing NaN to services.
 */
function validateId(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 0) {
    return res.status(400).json({ error: 'Invalid ID parameter' });
  }
  req.params.id = String(id); // normalize
  next();
}

/**
 * Validate required fields in req.body.
 * Usage: validateBody('name', 'email')
 */
function validateBody(...requiredFields) {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body is required' });
    }
    // Prevent prototype pollution
    if (req.body.__proto__ || req.body.constructor?.name !== 'Object') {
      delete req.body.__proto__;
      delete req.body.constructor;
    }
    for (const field of requiredFields) {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
        return res.status(400).json({ error: `Field "${field}" is required` });
      }
    }
    next();
  };
}

/**
 * Sanitize req.body — strip unknown fields, prevent prototype pollution.
 * Usage: sanitizeBody('name', 'email', 'role')
 */
function sanitizeBody(...allowedFields) {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') {
      req.body = {};
      return next();
    }
    if (allowedFields.length > 0) {
      const clean = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) clean[field] = req.body[field];
      }
      req.body = clean;
    }
    // Always strip prototype pollution vectors
    delete req.body.__proto__;
    delete req.body.constructor;
    delete req.body.prototype;
    next();
  };
}

module.exports = { validateId, validateBody, sanitizeBody };
