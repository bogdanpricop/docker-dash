'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const network = require('../services/network-advanced');
const intentValidator = require('../services/network-intent-validator');
const dependencyMap = require('../services/network-dependency-map');
const mtuDetector = require('../services/network-mtu-detector');
const bondHealth = require('../services/network-bond-health');
const loadBalancerInventory = require('../services/network-load-balancer-inventory');
const publicIpPlans = require('../services/network-public-ip-plans');
const reachability = require('../services/network-reachability');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) { if (['NetworkAdvancedError', 'NetworkIntentValidationError', 'NetworkDependencyMapError', 'NetworkReachabilityError', 'NetworkMtuDetectorError', 'NetworkBondHealthError', 'NetworkLoadBalancerInventoryError', 'NetworkPublicIpPlanError'].includes(error.name)) return res.status(error.status || 400).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }); next(error); } }; }
function audit(req, action, targetType, result) { auditService.log({ userId: req.user.id, username: req.user.username, action, targetType, targetId: String(result.id), details: { state: result.state || result.verdict || result.summary?.state, hash: result.planHash || result.profileHash || result.observationHash || result.policyHash || result.batchHash || result.validationHash || result.snapshotHash || result.assessmentHash, providerMutationsStarted: result.providerMutationsStarted || 0, externalMutationsStarted: result.externalMutationsStarted || 0, networkCallsStarted: result.networkCallsStarted || 0 }, ip: getClientIp(req) }); }
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
create('/intent-validations', intentValidator.validate.bind(intentValidator), 'network_intent_validation', 'network_intent_validation');
create('/dependency-address-observations', dependencyMap.recordAddressObservation.bind(dependencyMap), 'network_dependency_address_observation', 'network_dependency_address_observation');
create('/dependency-dns-observations', dependencyMap.recordDnsObservation.bind(dependencyMap), 'network_dependency_dns_observation', 'network_dependency_dns_observation');
create('/dependency-snapshots', dependencyMap.build.bind(dependencyMap), 'network_dependency_snapshot', 'network_dependency_snapshot');
create('/reachability-assessments', reachability.assess.bind(reachability), 'network_reachability_assessment', 'network_reachability_assessment');
create('/mtu-assessments', mtuDetector.assess.bind(mtuDetector), 'network_mtu_assessment', 'network_mtu_assessment');
create('/bond-health-observations', bondHealth.record.bind(bondHealth), 'network_bond_health_observation', 'network_bond_health_observation');
create('/load-balancer-observations', loadBalancerInventory.record.bind(loadBalancerInventory), 'network_load_balancer_observation', 'network_load_balancer_observation');
create('/public-ip-plans', publicIpPlans.create.bind(publicIpPlans), 'network_public_ip_plan', 'network_public_ip_plan');
router.get('/dependency-snapshots/:snapshotId/impact', route((req, res) => res.json(dependencyMap.impact(
  req.params.snapshotId, req.query.resourceKey, req.user, { maxDepth: req.query.maxDepth }
))));

module.exports = router;
