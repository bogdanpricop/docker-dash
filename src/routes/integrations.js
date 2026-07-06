'use strict';

// v8.9.9-alpha.1 — Dockge G08 closure: sibling-app auto-detection.
// Extensible to other monitoring integrations (Statping, Gatus, Kener) but
// starts with Uptime Kuma (louislam/uptime-kuma image).

const { Router } = require('express');
const dockerService = require('../services/docker');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

// GET /api/integrations/uptime-kuma — detect if Uptime Kuma is running on
// the current host. Returns { detected, container, url? }.
router.get('/uptime-kuma', requireAuth, asyncHandler(async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId, { all: true });
    const kuma = containers.find(c => {
      const img = (c.Image || c.image || '').toLowerCase();
      return img.includes('louislam/uptime-kuma') || img.includes('uptime-kuma');
    });
    if (!kuma) return res.json({ detected: false });
    // Extract published port 3001 (default)
    const ports = kuma.Ports || kuma.ports || [];
    const p = ports.find(x => (x.PrivatePort === 3001 || x.privatePort === 3001));
    const publishedPort = p && (p.PublicPort || p.publicPort);
    res.json({
      detected: true,
      container: { id: kuma.Id, name: (kuma.Names || [])[0] || null, image: kuma.Image },
      url: publishedPort ? `http://<this-host>:${publishedPort}` : null,
    });
  } catch (err) {
    res.json({ detected: false, error: err.message });
  }
}));

module.exports = router;
