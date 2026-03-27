'use strict';

const { Router } = require('express');
const statsService = require('../services/stats');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

router.get('/overview', requireAuth, (req, res) => {
  try { res.json(statsService.getOverview(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/container/:id', requireAuth, (req, res) => {
  try {
    const { range } = req.query;
    res.json(statsService.query(req.params.id, { range, hostId: req.hostId }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
