'use strict';

const { Router } = require('express');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const repositoryHealth = require('../services/storage-repository-health');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
router.use(requireAuth);

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.name === 'StorageRepositoryHealthError') {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      next(error);
    }
  };
}

function audit(req, action, repository, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username, action,
    targetType: 'storage_repository', targetId: String(repository.id || repository.repositoryId),
    details: { protocol: repository.protocol, state: repository.state, evidenceHash: repository.evidenceHash, ...details },
    ip: getClientIp(req),
  });
}

router.get('/', route((req, res) => {
  res.json(repositoryHealth.list(req.user, { historyLimit: req.query.historyLimit }));
}));

router.post('/', requireRole('admin'), writeable, route((req, res) => {
  const repository = repositoryHealth.create(req.body || {}, req.user);
  audit(req, 'storage_repository_create', repository);
  res.status(201).json({ repository });
}));

router.put('/:id', requireRole('admin'), writeable, route((req, res) => {
  const repository = repositoryHealth.update(req.params.id, req.body || {}, req.user);
  audit(req, 'storage_repository_update', repository);
  res.json({ repository });
}));

router.delete('/:id', requireRole('admin'), writeable, route((req, res) => {
  const repository = repositoryHealth.remove(req.params.id, req.user);
  audit(req, 'storage_repository_delete', repository);
  res.json({ ok: true, repository });
}));

router.post('/:id/probe', requireRole('admin'), writeable, route(async (req, res) => {
  const result = await repositoryHealth.probe(req.params.id, req.user);
  audit(req, 'storage_repository_health_probe', result, { writeTest: false });
  res.json({ result });
}));

router.post('/:id/write-test', requireRole('admin'), writeable, route(async (req, res) => {
  const result = await repositoryHealth.writeTest(req.params.id, req.body || {}, req.user);
  audit(req, 'storage_repository_write_test', result,
    { writeTest: true, cleanupProven: result.cleanupProven });
  res.json({ result });
}));

module.exports = router;
