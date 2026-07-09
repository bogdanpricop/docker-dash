'use strict';

// v8.9.22-alpha.1 — firewalld backend builder (pure). Uses permanent rich rules /
// ports in the given zone (default "public") followed by --reload. firewalld rich
// rules don't carry a stable app comment, so the uuid lives in the DB; removal
// rebuilds the identical rich rule and --remove-rich-rule's it.

const NAME = 'firewalld';
const net = require('net');

function _zone(spec) { return spec.zone || 'public'; }
function _family(ip) { return net.isIP(ip) === 6 ? 'ipv6' : 'ipv4'; }

// Build the rich-rule string (one argv token). accept|drop from action.
function _richRule(spec) {
  const parts = ['rule'];
  if (spec.source_ip) parts.push(`family="${_family(spec.source_ip)}"`, `source address="${spec.source_ip}"`);
  if (spec.destination_port) parts.push(`port port="${spec.destination_port}" protocol="${spec.protocol}"`);
  parts.push(spec.action === 'allow' ? 'accept' : 'drop');
  return parts.join(' ');
}

// A port-only open/close (no source) is cleaner as add-port/remove-port.
function _isPortOnly(spec) { return !spec.source_ip && !!spec.destination_port; }

function buildApply(spec, _ctx) {
  const zone = _zone(spec);
  let addFlag;
  if (_isPortOnly(spec) && spec.action === 'allow') {
    addFlag = `--add-port=${spec.destination_port}/${spec.protocol}`;
  } else if (_isPortOnly(spec) && spec.action === 'block') {
    // Blocking a port for everyone → drop rich rule on that port.
    addFlag = `--add-rich-rule=${_richRule(spec)}`;
  } else {
    addFlag = `--add-rich-rule=${_richRule(spec)}`;
  }
  return {
    commands: [
      { bin: 'firewall-cmd', argv: ['--permanent', `--zone=${zone}`, addFlag] },
      { bin: 'firewall-cmd', argv: ['--reload'] },
    ],
    chain: zone,
    comment_tag: null,
    rule_expression: `firewall-cmd --permanent --zone=${zone} ${addFlag}`,
  };
}

function buildRemove(rule) {
  const spec = {
    action: rule.action, scope: rule.scope, zone: rule.chain_name || 'public',
    source_ip: rule.source_ip || undefined,
    destination_port: rule.destination_port || undefined,
    protocol: rule.protocol || 'tcp',
  };
  const zone = _zone(spec);
  let rmFlag;
  if (_isPortOnly(spec) && spec.action === 'allow') {
    rmFlag = `--remove-port=${spec.destination_port}/${spec.protocol}`;
  } else {
    rmFlag = `--remove-rich-rule=${_richRule(spec)}`;
  }
  return {
    commands: [
      { bin: 'firewall-cmd', argv: ['--permanent', `--zone=${zone}`, rmFlag] },
      { bin: 'firewall-cmd', argv: ['--reload'] },
    ],
  };
}

function buildSnapshot() { return { bin: 'firewall-cmd', argv: ['--list-all-zones'] }; }
function buildList() { return { bin: 'firewall-cmd', argv: ['--list-all'] }; }
function buildDetect() { return { bin: 'firewall-cmd', argv: ['--state'] }; }

module.exports = { name: NAME, buildApply, buildRemove, buildSnapshot, buildList, buildDetect, _internals: { _richRule, _isPortOnly } };
