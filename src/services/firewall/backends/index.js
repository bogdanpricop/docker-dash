'use strict';

// v8.9.22-alpha.1 — firewall backend registry. Detection priority: firewalld (if
// running) → ufw (if active) → iptables (if present). ufw refuses container scope.

const iptables = require('./iptables');
const firewalld = require('./firewalld');
const ufw = require('./ufw');
const nftables = require('./nftables');

const BACKENDS = { iptables, firewalld, ufw, nftables };

// Order the service probes buildDetect() in. First exit-0 wins. nftables is last
// so it's only picked on nft-native hosts that lack the iptables command (the
// common iptables-nft case still resolves to 'iptables').
const DETECT_ORDER = ['firewalld', 'ufw', 'iptables', 'nftables'];

// Backends that cannot filter Docker published ports → refuse docker/container scope.
const HOST_ONLY = new Set(['ufw', 'nftables']);

function get(name) { return BACKENDS[name] || null; }

module.exports = { BACKENDS, DETECT_ORDER, HOST_ONLY, get, iptables, firewalld, ufw, nftables };
