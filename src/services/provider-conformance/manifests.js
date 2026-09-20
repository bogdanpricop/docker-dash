'use strict';

const { sha256 } = require('../../utils/crypto');

const MANIFEST_SCHEMA_VERSION = '1.0';
const RINGS = new Set(['internal', 'canary', 'beta', 'ga']);
const COMPATIBILITY_STATES = new Set(['declared', 'fixture-tested', 'endpoint-tested', 'deprecated']);
const SAFE_TYPE = /^[a-z][a-z0-9_-]{1,39}$/;

const MANIFESTS = Object.freeze({
  proxmox: Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    providerType: 'proxmox', displayName: 'Proxmox VE',
    owner: Object.freeze({ service: 'virtualization', team: 'platform', runbook: '/docs/features/provider-conformance' }),
    variants: Object.freeze([
      Object.freeze({ id: 'pve', apiFamilies: Object.freeze(['pve-api2-json']), releaseRing: 'canary' }),
    ]),
    compatibility: Object.freeze([
      Object.freeze({ variant: 'pve', status: 'fixture-tested', evidence: 'fixture:proxmox-pve-json' }),
    ]),
    mutationRequirements: Object.freeze({ idempotency: true, locking: true, reconciliation: true, postValidation: true, canary: true, waves: true }),
    deprecations: Object.freeze([]),
  }),
  vsphere: Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    providerType: 'vsphere', displayName: 'VMware vSphere / ESXi',
    owner: Object.freeze({ service: 'virtualization', team: 'platform', runbook: '/docs/features/provider-conformance' }),
    variants: Object.freeze([
      Object.freeze({ id: 'vcenter', apiFamilies: Object.freeze(['vSphere SOAP']), releaseRing: 'canary' }),
      Object.freeze({ id: 'esxi', apiFamilies: Object.freeze(['vSphere SOAP']), releaseRing: 'canary' }),
    ]),
    compatibility: Object.freeze([
      Object.freeze({ variant: 'vcenter', status: 'fixture-tested', evidence: 'fixture:vsphere-vcenter-soap' }),
      Object.freeze({ variant: 'esxi', status: 'endpoint-tested', evidence: 'staging:esxi-readonly' }),
    ]),
    mutationRequirements: Object.freeze({ idempotency: true, locking: true, reconciliation: true, postValidation: true, canary: true, waves: true }),
    deprecations: Object.freeze([]),
  }),
  xen: Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    providerType: 'xen', displayName: 'Xen / XCP-ng / XenServer',
    owner: Object.freeze({ service: 'virtualization', team: 'platform', runbook: '/docs/features/provider-conformance' }),
    variants: Object.freeze([
      Object.freeze({ id: 'xo', apiFamilies: Object.freeze(['Xen Orchestra REST']), releaseRing: 'beta' }),
      Object.freeze({ id: 'xapi', apiFamilies: Object.freeze(['XAPI JSON-RPC', 'XAPI XML-RPC']), releaseRing: 'beta' }),
      Object.freeze({ id: 'raw', apiFamilies: Object.freeze(['SSH xl', 'SSH xm']), releaseRing: 'internal' }),
    ]),
    compatibility: Object.freeze([
      Object.freeze({ variant: 'xo', status: 'fixture-tested', evidence: 'fixture:xen-xo-rest' }),
      Object.freeze({ variant: 'xapi', status: 'fixture-tested', evidence: 'fixture:xen-xapi-rpc' }),
      Object.freeze({ variant: 'raw', status: 'fixture-tested', evidence: 'fixture:xen-raw-cli' }),
    ]),
    mutationRequirements: Object.freeze({ idempotency: true, locking: true, reconciliation: true, postValidation: true, canary: true, waves: true }),
    deprecations: Object.freeze([
      Object.freeze({ variant: 'raw', apiFamily: 'SSH xm', state: 'warning', replacement: 'SSH xl or XAPI', removalAfter: null }),
    ]),
  }),
});

function _text(value, max = 160) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Provider manifest must be an object');
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (!SAFE_TYPE.test(manifest.providerType || '')) errors.push('providerType is invalid');
  if (!_text(manifest.displayName)) errors.push('displayName is required');
  if (!_text(manifest.owner?.service, 80) || !_text(manifest.owner?.team, 80) || !_text(manifest.owner?.runbook, 240)) errors.push('owner service/team/runbook are required');
  if (!Array.isArray(manifest.variants) || !manifest.variants.length) errors.push('variants are required');
  const variantIds = new Set();
  for (const variant of manifest.variants || []) {
    if (!SAFE_TYPE.test(variant?.id || '') || variantIds.has(variant.id)) errors.push('variant id is invalid or duplicated');
    else variantIds.add(variant.id);
    if (!Array.isArray(variant?.apiFamilies) || !variant.apiFamilies.length) errors.push(`${variant?.id || 'variant'} apiFamilies are required`);
    if (!RINGS.has(variant?.releaseRing)) errors.push(`${variant?.id || 'variant'} releaseRing is invalid`);
  }
  for (const entry of manifest.compatibility || []) {
    if (!variantIds.has(entry?.variant)) errors.push('compatibility variant is unknown');
    if (!COMPATIBILITY_STATES.has(entry?.status)) errors.push('compatibility status is invalid');
    if (!_text(entry?.evidence, 240)) errors.push('compatibility evidence is required');
  }
  const safetyKeys = ['idempotency', 'locking', 'reconciliation', 'postValidation', 'canary', 'waves'];
  if (safetyKeys.some(key => typeof manifest.mutationRequirements?.[key] !== 'boolean')) errors.push('mutationRequirements contract is incomplete');
  if (!Array.isArray(manifest.deprecations)) errors.push('deprecations must be an array');
  if (errors.length) throw new Error(`Invalid provider manifest: ${errors.join('; ')}`);
  return true;
}

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function manifestHash(manifest) {
  validateManifest(manifest);
  const { manifestHash: _publishedHash, ...contract } = manifest;
  return sha256(_canonical(contract));
}

function getManifest(providerType) {
  return MANIFESTS[String(providerType || '').toLowerCase()] || null;
}

function listManifests() {
  return Object.values(MANIFESTS).map(manifest => ({ ...manifest, manifestHash: manifestHash(manifest) }));
}

for (const manifest of Object.values(MANIFESTS)) validateManifest(manifest);

module.exports = {
  MANIFEST_SCHEMA_VERSION, RINGS, COMPATIBILITY_STATES,
  getManifest, listManifests, validateManifest, manifestHash,
  _internals: { _canonical },
};
