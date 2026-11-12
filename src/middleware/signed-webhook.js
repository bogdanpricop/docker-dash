'use strict';

const express = require('express');
const stripUnsafeBodyKeys = require('./request-body');

function isSignedWebhookPost(req) {
  return req.method === 'POST' &&
    /^\/api\/(?:git\/webhook|automation\/webhooks)\/[a-zA-Z0-9_-]{1,128}\/?$/i.test(req.path);
}

function signedWebhookJson(limit) {
  return [
    express.json({
      limit,
      inflate: false,
      verify: (req, _res, bytes) => { req.rawBody = bytes; },
    }),
    stripUnsafeBodyKeys,
  ];
}

function hasSignedBody(req) {
  return Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0;
}

module.exports = { isSignedWebhookPost, signedWebhookJson, hasSignedBody };
