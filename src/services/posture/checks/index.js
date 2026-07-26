'use strict';

// v8.9.37-alpha.1 — posture check registry. Add a check = add a module here.
// Each module: { id, category, async run(ctx) -> finding[] }. Findings carry their
// own checkId + severity. ctx = { db, hosts, log }.

const ALL = [
  require('./secrets'),
  require('./rbac'),
  require('./insecure-docker'),
  require('./fw-drift'),
  require('./exposed-port'),
  require('./egress'),
  require('./vsphere'),
  require('./proxmox'),
  require('./k8s'),
  require('./xen'),
];

module.exports = { ALL };
