'use strict';

// v8.9.22-alpha.1 — firewall backend registry. Detection priority: firewalld (if
// running) → ufw (if active) → iptables (if present). ufw refuses container scope.

const iptables = require('./iptables');
const firewalld = require('./firewalld');
const ufw = require('./ufw');
const nftables = require('./nftables');
const windows = require('./windows');

const BACKENDS = { iptables, firewalld, ufw, nftables, windows };

// Order the service probes buildDetect() in. First exit-0 wins. nftables is
// before windows so the common iptables-nft Linux case still resolves to
// iptables; windows is last (its PowerShell probe fails fast on Linux).
const DETECT_ORDER = ['firewalld', 'ufw', 'iptables', 'nftables', 'windows'];

// Backends that cannot filter Docker published ports → refuse docker/container scope.
const HOST_ONLY = new Set(['ufw', 'nftables', 'windows']);

function get(name) { return BACKENDS[name] || null; }

module.exports = { BACKENDS, DETECT_ORDER, HOST_ONLY, get, iptables, firewalld, ufw, nftables, windows };
