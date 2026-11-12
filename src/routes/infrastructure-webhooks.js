'use strict';

const { Router } = require('express');
const { signedWebhookJson, hasSignedBody } = require('../middleware/signed-webhook');
const delivery = require('../services/infrastructure-delivery');

const router = Router();

router.post('/:token', signedWebhookJson('256kb'), (req, res) => {
  if (!hasSignedBody(req)) return res.status(415).json({ error: 'An application/json webhook body is required' });
  try {
    const result = delivery.receiveWebhook(req.params.token, req.headers, req.rawBody);
    res.status(202).json(result);
  } catch (error) {
    if (error.name === 'InfrastructureDeliveryError') {
      return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
    }
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
