'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const hardware = require('../services/hardware-performance');
const devices = require('../services/hardware-devices');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (['HardwarePerformanceError', 'HardwareDeviceError'].includes(error.name)) return res.status(error.status || 400)
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

router.get('/devices', route((req, res) => res.json(devices.overview(req.user))));
router.post('/devices/snapshots', writeable, route((req, res) => {
  const snapshot = devices.record(req.body || {}, req.user);
  audit(req, 'hardware_device_snapshot_record', 'docker_host', snapshot.hostId,
    { evidenceHash: snapshot.evidenceHash, duplicate: snapshot.duplicate });
  res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
}));
router.get('/devices/hosts/:hostId/memory-tiers', route((req, res) => res.json(devices.memoryTiers(req.params.hostId, req.user))));
router.get('/devices/hosts/:hostId/pci', route((req, res) => res.json(devices.pci(req.params.hostId, req.user))));
router.get('/devices/hosts/:hostId/gpus', route((req, res) => res.json(devices.gpus(req.params.hostId, req.user))));
router.get('/devices/hosts/:hostId/usb', route((req, res) => res.json(devices.usb(req.params.hostId, req.user))));
router.post('/devices/allocations', writeable, route((req, res) => {
  const allocation = devices.planAllocation(req.body || {}, req.user);
  audit(req, 'hardware_device_allocation_plan', 'hardware_device', allocation.plan.deviceRef,
    { state: allocation.state, planHash: allocation.planHash, providerMutationsStarted: 0 });
  res.status(allocation.state === 'planned' ? 201 : 200).json({ allocation });
}));
router.post('/devices/allocations/:id/release', writeable, route((req, res) => {
  const result = devices.releaseAllocation(req.params.id, req.user);
  audit(req, 'hardware_device_allocation_release', 'hardware_device_allocation', req.params.id,
    { infrastructureMutated: false });
  res.json(result);
}));
router.post('/devices/metrics', writeable, route((req, res) => {
  const metric = devices.recordMetrics(req.body || {}, req.user);
  audit(req, 'hardware_accelerator_metric_record', 'hardware_device', req.body?.deviceRef,
    { evidenceHash: metric.evidenceHash, duplicate: metric.duplicate });
  res.status(metric.duplicate ? 200 : 201).json({ metric });
}));
router.post('/devices/reservations', writeable, route((req, res) => {
  const reservation = devices.reserve(req.body || {}, req.user);
  audit(req, 'hardware_accelerator_reservation_create', 'hardware_device', reservation.deviceRef,
    { reservationHash: reservation.reservationHash, duplicate: reservation.duplicate, providerMutationsStarted: 0 });
  res.status(reservation.duplicate ? 200 : 201).json({ reservation });
}));

module.exports = router;
