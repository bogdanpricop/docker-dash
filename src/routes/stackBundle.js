'use strict';

const { Router } = require('express');
const bundleService = require('../services/stackBundle');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

// ─── Export ─────────────────────────────────────────

// Export a stack as a downloadable JSON bundle
router.get('/export/stack/:name', requireAuth, async (req, res) => {
  try {
    const bundle = await bundleService.exportStack(req.params.name, req.hostId);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_export', targetType: 'stack',
      targetId: req.params.name, ip: getClientIp(req),
    });

    // If ?download=true, send as file
    if (req.query.download === 'true') {
      const filename = `stack-${req.params.name}-${new Date().toISOString().substring(0, 10)}.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(JSON.stringify(bundle, null, 2));
    }

    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export a single container
router.get('/export/container/:id', requireAuth, async (req, res) => {
  try {
    const bundle = await bundleService.exportContainer(req.params.id, req.hostId);

    if (req.query.download === 'true') {
      const name = bundle.containers[0]?.name || 'container';
      const filename = `container-${name}-${new Date().toISOString().substring(0, 10)}.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(JSON.stringify(bundle, null, 2));
    }

    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate compose YAML from a bundle
router.post('/export/compose', requireAuth, (req, res) => {
  try {
    const yaml = bundleService.generateCompose(req.body);
    res.type('text/yaml').send(yaml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Import ─────────────────────────────────────────

// Import a bundle onto a host
router.post('/import', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { bundle, destHostId, autoStart, prefixName } = req.body;

    if (!bundle) return res.status(400).json({ error: 'bundle is required (JSON object)' });
    if (destHostId === undefined) return res.status(400).json({ error: 'destHostId is required' });

    const result = await bundleService.importBundle(bundle, destHostId, {
      autoStart: autoStart !== false,
      prefixName: prefixName || '',
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_import', targetType: 'stack',
      targetId: bundle.stack?.name || bundle.containers?.[0]?.name || 'bundle',
      details: JSON.stringify({
        destHostId, succeeded: result.succeeded, failed: result.failed,
      }),
      ip: getClientIp(req),
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate/preview a bundle before importing
router.post('/import/preview', requireAuth, (req, res) => {
  try {
    const { bundle } = req.body;
    if (!bundle) return res.status(400).json({ error: 'bundle is required' });

    const preview = {
      format: bundle.format,
      version: bundle.version,
      exportedAt: bundle.exportedAt,
      exportedFrom: bundle.exportedFrom,
      containers: (bundle.containers || []).map(c => ({
        name: c.name,
        service: c.service,
        image: c.image,
        ports: c.portBindings?.length || 0,
        volumes: c.volumes?.length || 0,
        envVars: c.env?.length || 0,
        restartPolicy: c.restartPolicy,
      })),
      images: bundle.images || [],
      volumes: bundle.volumes || [],
      networks: bundle.networks || [],
      hasComposeYaml: !!bundle.stack?.composeYaml,
      metadata: bundle.metadata,
    };

    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
