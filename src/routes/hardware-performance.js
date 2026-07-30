'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const hardware = require('../services/hardware-performance');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'HardwarePerformanceError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(hardware.overview(req.user))));
router.post('/snapshots', writeable, route((req, res) => {
  const snapshot = hardware.recordSnapshot(req.body || {}, req.user);
  audit(req, 'hardware_snapshot_record', 'docker_host', snapshot.hostId, { providerType: snapshot.providerType,
    clusterRef: snapshot.clusterRef, evidenceHash: snapshot.evidenceHash, duplicate: snapshot.duplicate });
  res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
}));
router.get('/clusters/:clusterRef/compatibility', route((req, res) => res.json(hardware.compatibilityMatrix(req.params.clusterRef, req.user))));
router.get('/clusters/:clusterRef/cpu-baseline', route((req, res) => res.json(hardware.cpuBaseline(req.params.clusterRef, req.user))));
router.put('/clusters/:clusterRef/cpu-policy', writeable, route((req, res) => {
  const policy = hardware.saveCpuPolicy(req.params.clusterRef, req.body || {}, req.user);
  audit(req, 'hardware_cpu_policy_save', 'hardware_cluster', policy.clusterRef, { mode: policy.mode,
    adapterState: policy.adapterState, state: policy.state, planHash: policy.planHash, providerMutationsStarted: 0 });
  res.json({ policy });
}));
router.get('/clusters/:clusterRef/cpu-pinning', route((req, res) => res.json(hardware.cpuPinning(req.params.clusterRef, req.user))));
router.get('/hosts/:hostId/numa', route((req, res) => res.json(hardware.numaTopology(req.params.hostId, req.user))));
router.get('/hosts/:hostId/hugepages', route((req, res) => res.json(hardware.hugepageDashboard(req.params.hostId, req.user))));
router.get('/hosts/:hostId/memory', route((req, res) => res.json(hardware.memoryDashboard(req.params.hostId, req.user))));
router.get('/vms/:resourceKey/numa-fit', route((req, res) => res.json(hardware.analyzeNumaFit(req.params.resourceKey, req.query.hostId, req.user))));
router.get('/vms/:resourceKey/realtime-profile', route((req, res) => res.json(hardware.realtimeProfile(req.params.resourceKey, req.query.hostId, req.user))));

module.exports = router;
