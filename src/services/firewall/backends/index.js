'use strict';

// v8.9.22-alpha.1 — firewall backend registry. Detection priority: firewalld (if
// running) → ufw (if active) → iptables (if present). ufw refuses container scope.

const iptables = require('./iptables');
const firewalld = require('./firewalld');
const ufw = require('./ufw');

const BACKENDS = { iptables, firewalld, ufw };

// Order the service probes buildDetect() in. First exit-0 wins.
const DETECT_ORDER = ['firewalld', 'ufw', 'iptables'];

function get(name) { return BACKENDS[name] || null; }

module.exports = { BACKENDS, DETECT_ORDER, get, iptables, firewalld, ufw };
