'use strict';

const RESOURCE_KINDS = Object.freeze({
  'virtual-machines': Object.freeze({ kind: 'virtualMachine', prefix: 'vm', capability: 'inventory.vm' }),
  hosts: Object.freeze({ kind: 'host', prefix: 'host', capability: 'inventory.host' }),
  clusters: Object.freeze({ kind: 'cluster', prefix: 'cluster', capability: 'inventory.cluster' }),
  storages: Object.freeze({ kind: 'storage', prefix: 'storage', capability: 'inventory.storage' }),
  networks: Object.freeze({ kind: 'network', prefix: 'network', capability: 'inventory.network' }),
  tasks: Object.freeze({ kind: 'task', prefix: 'task', capability: 'inventory.task' }),
});

const BY_KIND = new Map(Object.entries(RESOURCE_KINDS).map(([slug, value]) => [value.kind, { slug, ...value }]));

function resolveResourceKind(input) {
  const value = RESOURCE_KINDS[String(input || '').toLowerCase()];
  if (!value) return null;
  return { slug: String(input).toLowerCase(), ...value };
}

function resourceKind(kind) {
  return BY_KIND.get(kind) || null;
}

module.exports = { RESOURCE_KINDS, resolveResourceKind, resourceKind };
