'use strict';

// B118/B120/B121 provider-native evidence capture. Provider reads are bounded
// and normalized into the existing immutable stores. This service never runs
// traffic, guest commands, failovers, or provider mutations.

const crypto = require('crypto');
const { getDb } = require('../../db');
const registry = require('./registry');
const ipAddressInventory = require('./ip-address-inventory');
const dependencyMap = require('../network-dependency-map');
const mtuDetector = require('../network-mtu-detector');
const bondHealth = require('../network-bond-health');

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const MAX_PATHS = 200;

class NetworkEvidenceCaptureError extends Error {
  constructor(message, code = 'NETWORK_EVIDENCE_CAPTURE_ERROR', status = 400) {
    super(message);
    this.name = 'NetworkEvidenceCaptureError';
    this.code = code;
    this.status = status;
  }
}

function _admin(actor) {
  if (!actor?.id) throw new NetworkEvidenceCaptureError('Authentication required', 'AUTH_REQUIRED', 401);
  if (actor.role !== 'admin' && !actor.roles?.includes('admin')) {
    throw new NetworkEvidenceCaptureError('Administrator required', 'ADMIN_REQUIRED', 403);
  }
  return { ...actor, role: 'admin' };
}

function _safeError(error, fallback) {
  return {
    code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(error?.code || '')) ? error.code : fallback,
    message: 'Provider evidence source is unavailable',
  };
}

function _dedupeAddresses(entries) {
  const seen = new Set();
  const rows = [];
  for (const entry of entries || []) {
    const address = String(entry?.address || '');
    const resourceKey = String(entry?.vm?.id || '');
    const source = String(entry?.source || 'provider');
    const signature = `${address}|${resourceKey}|${source}`;
    if (!address || !SAFE_KEY.test(resourceKey) || seen.has(signature)) continue;
    seen.add(signature);
    rows.push({
      address, resourceKey, resourceKind: 'virtualMachine',
      displayName: String(entry.vm?.displayName || resourceKey).slice(0, 300),
      source: SAFE_KEY.test(source) ? source : 'provider',
    });
  }
  return rows.slice(0, 5000);
}

function _mtu(value) {
  return Number.isInteger(value) && value >= 576 && value <= 65535 ? value : null;
}

function _networkPaths(host, inventory, nativeEvidence) {
  const paths = [];
  for (const network of inventory?.items || []) {
    if (!SAFE_KEY.test(String(network.id || ''))) continue;
    paths.push({
      pathKey: `path:${network.id}`, purpose: 'workload',
      sourceKey: `provider:${host.id}`, targetKey: network.id,
      requiredPayloadMtu: 1500, requiresDf: false, dfState: 'not_applicable',
      segments: [{
        segmentKey: network.id, kind: 'virtual_network',
        mtu: _mtu(network.spec?.mtu),
        encapsulationOverheadBytes: 0, evidenceRef: network.id,
      }],
    });
  }
  for (const item of nativeEvidence?.switches || []) {
    const switchKey = String(item.switchKey || '');
    const hostKey = String(item.hostKey || `provider:${host.id}`);
    if (!SAFE_KEY.test(switchKey) || !SAFE_KEY.test(hostKey)) continue;
    paths.push({
      pathKey: `path:${switchKey}`, purpose: 'workload', sourceKey: hostKey,
      targetKey: switchKey, requiredPayloadMtu: 1500,
      requiresDf: false, dfState: 'not_applicable',
      segments: [{
        segmentKey: switchKey, kind: 'switch',
        mtu: _mtu(item.mtu),
        encapsulationOverheadBytes: 0, evidenceRef: switchKey,
      }],
    });
  }
  const unique = new Map();
  for (const path of paths) if (!unique.has(path.pathKey)) unique.set(path.pathKey, path);
  return [...unique.values()].slice(0, MAX_PATHS);
}

function _hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function captureForHost(host, actor, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) {
    throw new NetworkEvidenceCaptureError('Valid provider host required', 'INVALID_HOST');
  }
  const admin = _admin(actor);
  const database = options.database || getDb();
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new NetworkEvidenceCaptureError('now is invalid', 'INVALID_NOW');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh !== false });
  if (capabilities.probe?.status !== 'reachable') {
    throw new NetworkEvidenceCaptureError('Provider endpoint is currently unreachable',
      'PROVIDER_UNREACHABLE', 502);
  }

  const [ipResult, networkResult, nativeResult] = await Promise.allSettled([
    ipAddressInventory.inventoryForHost(host, { database }),
    registry.resourcesForHost(host, 'networks', { limit: 500, database }),
    registry.nativeNetworkEvidenceForHost(host, { capabilities }),
  ]);
  const features = [];

  if (ipResult.status === 'fulfilled') {
    const addresses = _dedupeAddresses(ipResult.value.addresses);
    if (addresses.length) {
      try {
        const saved = database.transaction(() => {
          const observation = dependencyMap.recordAddressObservation({
            source: `provider:${capabilities.provider.type}:ip-inventory`, providerHostId: Number(host.id),
            observedAt: ipResult.value.observedAt || now.toISOString(),
            coverage: {
              complete: ipResult.value.coverage?.complete === true,
              reason: ipResult.value.coverage?.complete === true
                ? 'All bounded provider-visible VM IP evidence was normalized'
                : 'Provider-visible VM IP evidence is incomplete or bounded',
            }, addresses,
          }, admin, { database });
          const snapshot = dependencyMap.build({
            scopeKey: 'global', freshnessHours: 24, maxEdges: 5000,
            includeDenied: false,
          }, admin, { database, now });
          return { observation, snapshot };
        })();
        features.push({ featureId: 'B118', state: 'captured',
          recordId: saved.snapshot.id, recordHash: saved.snapshot.snapshotHash,
          addressObservationId: saved.observation.id, observedItems: addresses.length });
      } catch (error) {
        features.push({ featureId: 'B118', state: 'unavailable', observedItems: 0,
          error: _safeError(error, 'IP_EVIDENCE_NORMALIZATION_FAILED') });
      }
    } else {
      features.push({ featureId: 'B118', state: 'not_observed', observedItems: 0,
        reason: 'Provider returned no VM IP address evidence; absence is not treated as success' });
    }
  } else {
    features.push({ featureId: 'B118', state: 'unavailable', observedItems: 0,
      error: _safeError(ipResult.reason, 'IP_EVIDENCE_UNAVAILABLE') });
  }

  const inventory = networkResult.status === 'fulfilled' ? networkResult.value : null;
  const nativeEvidence = nativeResult.status === 'fulfilled' ? nativeResult.value : null;
  const paths = _networkPaths(host, inventory, nativeEvidence);
  if (paths.length) {
    try {
      const result = mtuDetector.assess({
        source: `provider:${capabilities.provider.type}:network-evidence`,
        providerHostId: Number(host.id), observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        coverage: {
          complete: false,
          reason: 'Provider-native segment MTU is captured, but an end-to-end path and DF behavior are not inferred',
        }, paths,
      }, admin, { database, now });
      features.push({ featureId: 'B120', state: 'captured', recordId: result.id,
        recordHash: result.assessmentHash, observedItems: paths.length,
        assessmentState: result.summary.state });
    } catch (error) {
      features.push({ featureId: 'B120', state: 'unavailable', observedItems: 0,
        error: _safeError(error, 'NETWORK_EVIDENCE_NORMALIZATION_FAILED') });
    }
  } else {
    const errors = [networkResult, nativeResult].filter(item => item.status === 'rejected')
      .map(item => _safeError(item.reason, 'NETWORK_EVIDENCE_UNAVAILABLE'));
    features.push({ featureId: 'B120', state: errors.length ? 'unavailable' : 'not_observed',
      observedItems: 0, reason: errors.length ? undefined
        : 'Provider returned no virtual-network or switch MTU evidence', ...(errors.length ? { errors } : {}) });
  }

  if ((nativeEvidence?.bonds || []).length) {
    try {
      const result = bondHealth.record({
        source: `provider:${capabilities.provider.type}:bond-evidence`,
        providerHostId: Number(host.id), observedAt: nativeEvidence.observedAt || now.toISOString(),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        coverage: {
          complete: false,
          reason: 'Provider-native membership and link evidence is captured; traffic deltas, partner and failover history remain unobserved',
        }, bonds: nativeEvidence.bonds,
      }, admin, { database, now });
      features.push({ featureId: 'B121', state: 'captured', recordId: result.id,
        recordHash: result.observationHash, observedItems: nativeEvidence.bonds.length,
        assessmentState: result.summary.state });
    } catch (error) {
      features.push({ featureId: 'B121', state: 'unavailable', observedItems: 0,
        error: _safeError(error, 'BOND_EVIDENCE_NORMALIZATION_FAILED') });
    }
  } else {
    features.push({ featureId: 'B121',
      state: nativeResult.status === 'rejected' ? 'unavailable' : 'not_observed', observedItems: 0,
      reason: nativeResult.status === 'rejected'
        ? undefined : nativeEvidence?.supported === false
          ? 'This provider has no registered physical Bond/LAG collector'
          : 'No multi-uplink standard switch was observed; absence is not treated as healthy',
      ...(nativeResult.status === 'rejected'
        ? { error: _safeError(nativeResult.reason, 'BOND_EVIDENCE_UNAVAILABLE') } : {}),
    });
  }

  const summary = {
    captured: features.filter(item => item.state === 'captured').length,
    notObserved: features.filter(item => item.state === 'not_observed').length,
    unavailable: features.filter(item => item.state === 'unavailable').length,
    providerReadsStarted: 3, providerMutationsStarted: 0,
    activeProbesStarted: 0, guestCommandsStarted: 0,
  };
  return {
    schemaVersion: '1.0', provider: { type: capabilities.provider.type, endpointId: Number(host.id) },
    capturedAt: now.toISOString(), features, summary,
    evidenceHash: _hash({ hostId: Number(host.id), capturedAt: now.toISOString(), features, summary }),
    limitations: [
      'Provider inventory reads are not data-plane reachability or DF probes.',
      'Segment-only MTU evidence remains incomplete and cannot prove an end-to-end path.',
      'Missing Bond/LAG evidence is not interpreted as healthy or not applicable.',
    ],
  };
}

module.exports = {
  NetworkEvidenceCaptureError, captureForHost,
  _internals: { _dedupeAddresses, _networkPaths, _safeError, _mtu },
};
