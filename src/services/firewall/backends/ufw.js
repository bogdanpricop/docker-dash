'use strict';

// v8.9.22-alpha.1 — ufw backend builder (pure). ufw carries a `comment` we tag
// with the app uuid. NOTE: ufw is host-general only — it does NOT reliably filter
// Docker published ports (those use NAT/DOCKER-USER). The service therefore refuses
// scope=docker/container on a ufw host and steers the user to an iptables host.

const NAME = 'ufw';

function commentTag(uuid, reason) {
  return reason ? `APPFW uuid=${uuid} reason=${reason}` : `APPFW uuid=${uuid}`;
}

// Build the rule argv (without the leading verb). apply prepends nothing (ufw
// <rule>); remove prepends `delete`.
function _rule(spec, tag) {
  const verb = spec.action === 'allow' ? 'allow' : 'deny';
  const r = [verb];
  if (spec.source_ip && spec.destination_port) {
    r.push('from', spec.source_ip, 'to', 'any', 'port', String(spec.destination_port), 'proto', spec.protocol);
  } else if (spec.source_ip) {
    r.push('from', spec.source_ip);
  } else if (spec.destination_port) {
    r.push(`${spec.destination_port}/${spec.protocol}`);
  }
  if (tag) r.push('comment', tag);
  return r;
}

function buildApply(spec, ctx) {
  const tag = commentTag(ctx.uuid, ctx.reason);
  const rule = _rule(spec, tag);
  return {
    commands: [{ bin: 'ufw', argv: rule }],
    chain: null,
    comment_tag: tag,
    rule_expression: `ufw ${rule.join(' ')}`,
  };
}

function buildRemove(rule) {
  const spec = {
    action: rule.action, scope: rule.scope,
    source_ip: rule.source_ip || undefined,
    destination_port: rule.destination_port || undefined,
    protocol: rule.protocol || 'tcp',
  };
  // ufw delete matches the rule spec; comment is ignored for matching, so omit it.
  const r = _rule(spec, null);
  return { commands: [{ bin: 'ufw', argv: ['delete', ...r] }] };
}

function buildSnapshot() { return { bin: 'ufw', argv: ['status', 'verbose'] }; }
function buildList() { return { bin: 'ufw', argv: ['status', 'numbered'] }; }
function buildDetect() { return { bin: 'ufw', argv: ['status'] }; }

module.exports = { name: NAME, buildApply, buildRemove, buildSnapshot, buildList, buildDetect, _internals: { _rule } };
