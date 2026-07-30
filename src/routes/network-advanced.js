'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const network = require('../services/network-advanced');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.name === 'NetworkAdvancedError') return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details }); next(error); } }; }
function audit(req, action, targetType, result) { auditService.log({ userId: req.user.id, username: req.user.username, action, targetType, targetId: String(result.id), details: { state: result.state || result.summary?.state, hash: result.planHash || result.profileHash || result.observationHash || result.policyHash || result.batchHash, providerMutationsStarted: result.providerMutationsStarted || 0, externalMutationsStarted: result.externalMutationsStarted || 0, networkCallsStarted: result.networkCallsStarted || 0 }, ip: getClientIp(req) }); }
function create(path, method, action, targetType) { router.post(path, writeable, route((req, res) => { const result = method(req.body || {}, req.user); audit(req, action, targetType, result); res.status(result.duplicate ? 200 : 201).json({ result }); })); }

router.get('/', route((req, res) => res.json(network.overview(req.user))));
create('/nic-attach-plans', network.planNicAttach.bind(network), 'network_nic_attach_plan', 'network_nic_change_plan');
create('/nic-detach-plans', network.planNicDetach.bind(network), 'network_nic_detach_plan', 'network_nic_change_plan');
create('/mapping-profiles', network.saveMappingProfile.bind(network), 'network_mapping_profile_save', 'network_mapping_profile');
create('/segment-plans', network.planSegment.bind(network), 'network_segment_plan', 'network_segment_plan');
create('/tenant-network-plans', network.planTenantNetworkChange.bind(network), 'tenant_network_change_plan', 'tenant_network_change_plan');
create('/address-change-plans', network.planAddressChange.bind(network), 'network_address_change_plan', 'network_address_change_plan');
create('/security-group-observations', network.recordSecurityGroupInventory.bind(network), 'security_group_inventory_observation', 'security_group_inventory');
create('/security-group-change-plans', network.planSecurityGroupChange.bind(network), 'security_group_change_plan', 'security_group_change_plan');
create('/distributed-firewall-observations', network.recordDistributedFirewall.bind(network), 'distributed_firewall_observation', 'distributed_firewall');
create('/microsegmentation-policies', network.saveMicrosegmentationPolicy.bind(network), 'microsegmentation_policy_save', 'microsegmentation_policy');
create('/flow-log-batches', network.ingestFlowLogs.bind(network), 'network_flow_log_ingest', 'network_flow_log_batch');

module.exports = router;
