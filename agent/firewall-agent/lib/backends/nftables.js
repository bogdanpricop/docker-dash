'use strict';

// v8.9.25-alpha.1 — nftables backend builder (pure). Targets `inet filter input`
// (the standard chain on nftables-native systems). Host scope only — container
// traffic on nft-backed Docker still lives in iptables-nft tables, so the service
// refuses docker/container scope here (like ufw). Rules carry an `APPFW uuid=…`
// comment; removal finds the rule's handle by that comment and deletes it.

const NAME = 'nftables';
const net = require('net');

const TABLE = 'inet filter';
const CHAIN = 'input';

function commentTag(uuid, reason) {
  return reason ? `APPFW uuid=${uuid} reason=${reason}` : `APPFW uuid=${uuid}`;
}
function _sfam(ip) { return net.isIP(ip) === 6 ? 'ip6' : 'ip'; }

function _match(spec) {
  const m = [];
  if (spec.source_ip) m.push(_sfam(spec.source_ip), 'saddr', spec.source_ip);
  if (spec.destination_port) m.push(spec.protocol, 'dport', String(spec.destination_port));
  return m;
}

function buildApply(spec, ctx) {
  const tag = commentTag(ctx.uuid, ctx.reason);
  const verdict = spec.action === 'allow' ? 'accept' : 'drop';
  const argv = ['add', 'rule', 'inet', 'filter', CHAIN, ..._match(spec), verdict, 'comment', tag];
  return {
    commands: [{ bin: 'nft', argv }],
    chain: `${TABLE} ${CHAIN}`,
    comment_tag: tag,
    rule_expression: `nft add rule inet filter ${CHAIN} ${_match(spec).join(' ')} ${verdict} comment "${tag}"`,
  };
}

// nft deletes by handle, not by spec. Find the handle whose rule carries our
// comment (POSIX awk — no grep -P dependency) and delete it. Runs via `sh -c`
// (SSH channel POSIX-quotes it; the agent execFile's sh -c directly).
function buildRemove(rule) {
  const tag = rule.comment_tag || `APPFW uuid=${rule.rule_uuid}`;
  const safeTag = String(tag).replace(/'/g, ''); // tag is app-generated; strip quotes defensively
  const script = `h=$(nft -a list chain inet filter ${CHAIN} 2>/dev/null | awk '/${safeTag}/{for(i=1;i<=NF;i++) if($i=="handle") print $(i+1)}' | head -1); ` +
    `if [ -n "$h" ]; then nft delete rule inet filter ${CHAIN} handle "$h"; else echo "rule not found"; fi`;
  return { commands: [{ bin: 'sh', argv: ['-c', script] }] };
}

function buildSnapshot() { return { bin: 'nft', argv: ['list', 'ruleset'] }; }
function buildList() { return { bin: 'nft', argv: ['-a', 'list', 'chain', 'inet', 'filter', CHAIN] }; }
function buildDetect() { return { bin: 'nft', argv: ['list', 'ruleset'] }; }

module.exports = { name: NAME, buildApply, buildRemove, buildSnapshot, buildList, buildDetect, _internals: { _match, commentTag } };
