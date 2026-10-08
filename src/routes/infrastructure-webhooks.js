'use strict';

const { Router } = require('express');
const delivery = require('../services/infrastructure-delivery');

const router = Router();

router.post('/:token', (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const result = delivery.receiveWebhook(req.params.token, req.headers, rawBody);
    res.status(202).json(result);
  } catch (error) {
    if (error.name === 'InfrastructureDeliveryError') {
      return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
    }
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
