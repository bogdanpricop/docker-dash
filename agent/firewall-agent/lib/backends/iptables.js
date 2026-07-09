'use strict';

// v8.9.22-alpha.1 — iptables backend builder (pure). Container traffic goes in
// DOCKER-USER with conntrack --ctorigdstport (the port BEFORE Docker's DNAT);
// host traffic goes in INPUT. Every app rule carries an APPFW comment so it can
// be found/removed deterministically. Builders return argv arrays; the runner
// executes them directly (agent) or POSIX-quotes them into a command (SSH).

const NAME = 'iptables';

function commentTag(uuid, reason) {
  return reason ? `APPFW uuid=${uuid} reason=${reason}` : `APPFW uuid=${uuid}`;
}

// Match+target body shared by apply (-I) and remove (-D). Order matters:
// -p before --dport; conntrack module before its option.
function _body(spec, tag) {
  const chain = (spec.scope === 'docker' || spec.scope === 'container') ? 'DOCKER-USER' : 'INPUT';
  const b = [];
  if (spec.destination_port) {
    if (chain === 'DOCKER-USER') {
      b.push('-p', spec.protocol, '-m', 'conntrack', '--ctorigdstport', String(spec.destination_port));
    } else {
      b.push('-p', spec.protocol, '--dport', String(spec.destination_port));
    }
  }
  if (spec.source_ip) b.push('-s', spec.source_ip);
  b.push('-m', 'comment', '--comment', tag);
  b.push('-j', spec.action === 'allow' ? 'ACCEPT' : 'DROP');
  return { chain, body: b };
}

function buildApply(spec, ctx) {
  const tag = commentTag(ctx.uuid, ctx.reason);
  const { chain, body } = _body(spec, tag);
  const argv = ['-I', chain, ...body];
  return {
    commands: [{ bin: 'iptables', argv }],
    chain,
    comment_tag: tag,
    rule_expression: `iptables -I ${chain} ${body.join(' ')}`,
  };
}

// Rebuild the exact tuple from the stored row and delete it (-D matches by spec,
// position-independent). Requires the same fields used at apply time.
function buildRemove(rule) {
  const spec = {
    action: rule.action, scope: rule.scope,
    source_ip: rule.source_ip || undefined,
    destination_port: rule.destination_port || undefined,
    protocol: rule.protocol || 'tcp',
  };
  const { chain, body } = _body(spec, rule.comment_tag);
  return { commands: [{ bin: 'iptables', argv: ['-D', chain, ...body] }] };
}

// Full dump for rollback (restore with iptables-restore).
function buildSnapshot() { return { bin: 'iptables-save', argv: [] }; }
// Human-readable list for display.
function buildList() { return { bin: 'iptables', argv: ['-S'] }; }
// Availability probe: exit 0 if iptables is usable.
function buildDetect() { return { bin: 'iptables', argv: ['-S', '-t', 'filter'] }; }

module.exports = { name: NAME, buildApply, buildRemove, buildSnapshot, buildList, buildDetect, _internals: { commentTag, _body } };
