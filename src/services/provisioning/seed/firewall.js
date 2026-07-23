'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic firewall snapshots + app-managed rules.
//
// Mirrors the real 080 shape so the Firewall page renders authentically:
//   * a pre-mutation `firewall_snapshots` dump per host, and
//   * `firewall_rules` carrying the real `APPFW uuid=<uuid>` comment tag plus the
//     exact backend command in `rule_expression`.
// Every address is RFC 1918 (internal) or TEST-NET (the "external partner"
// ranges) — never routable, so a demo rule can never describe a real network.

const BACKENDS = [['iptables', 5], ['nftables', 2], ['firewalld', 2], ['ufw', 1]];
const { FIREWALL_REASONS } = require('./words');

function _expression(backend, rule) {
  const src = rule.source_ip ? ` -s ${rule.source_ip}` : '';
  const proto = rule.protocol ? ` -p ${rule.protocol}` : '';
  const dport = rule.destination_port ? ` --dport ${rule.destination_port}` : '';
  const verdict = rule.action === 'allow' ? 'ACCEPT' : 'DROP';
  switch (backend) {
    case 'nftables':
      return `nft add rule inet filter ${rule.chain_name} ip saddr ${rule.source_ip || '0.0.0.0/0'} ${rule.protocol || 'tcp'} dport ${rule.destination_port || 0} ${rule.action === 'allow' ? 'accept' : 'drop'} comment "${rule.comment_tag}"`;
    case 'firewalld':
      return `firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address="${rule.source_ip || '0.0.0.0/0'}" port port="${rule.destination_port || 0}" protocol="${rule.protocol || 'tcp'}" ${rule.action === 'allow' ? 'accept' : 'drop'}'`;
    case 'ufw':
      return `ufw ${rule.action === 'allow' ? 'allow' : 'deny'} from ${rule.source_ip || 'any'} to any port ${rule.destination_port || 0} proto ${rule.protocol || 'tcp'} comment '${rule.comment_tag}'`;
    default:
      return `iptables -I ${rule.chain_name} 1${src}${proto}${dport} -m comment --comment "${rule.comment_tag}" -j ${verdict}`;
  }
}

function _snapshotBody(rng, backend, host) {
  return [
    `# ${backend} ruleset dump (synthetic demo) — ${host.name} (${host.ip})`,
    '*filter',
    ':INPUT DROP [0:0]',
    ':FORWARD DROP [0:0]',
    ':OUTPUT ACCEPT [0:0]',
    ':DOCKER-USER - [0:0]',
    `-A INPUT -s ${rng.rfc1918Cidr()} -p tcp --dport 22 -j ACCEPT`,
    `-A DOCKER-USER -s ${rng.rfc1918Cidr()} -j RETURN`,
    'COMMIT',
  ].join('\n');
}

function generate(ctx) {
  const { db, rng, datasetId, profile, scenario, refs } = ctx;
  if (!refs.hosts.length) return { count: 0 };

  const insSnap = db.prepare(`
    INSERT INTO firewall_snapshots (host_id, backend, snapshot_content, created_at, created_by, reason, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insRule = db.prepare(`
    INSERT INTO firewall_rules (
      rule_uuid, host_id, backend, scope, action, source_ip, destination_ip, destination_port,
      protocol, chain_name, rule_expression, comment_tag, reason, created_by, created_at,
      is_temporary, is_active, seed_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  const backendByHost = new Map();
  const snapHosts = refs.hosts.slice(0, Math.min(profile.firewallSnapshots, refs.hosts.length));
  let snapshots = 0;
  for (const h of snapHosts) {
    const backend = rng.weighted(BACKENDS);
    backendByHost.set(h.id, backend);
    insSnap.run(
      h.id, backend, _snapshotBody(rng, backend, h),
      rng.dateBetween(ctx.nowMs - 60 * 864e5, ctx.nowMs - 864e5),
      'demo-ops', 'pre-mutation snapshot (synthetic)', datasetId,
    );
    snapshots += 1;
  }

  let rules = 0;
  for (let i = 0; i < profile.firewallRules; i++) {
    const h = rng.pick(refs.hosts);
    const backend = backendByHost.get(h.id) || rng.weighted(BACKENDS);
    const external = rng.bool(scenario.firewallExternalRatio);
    // rule_uuid is globally UNIQUE, so it is DATASET-SCOPED rather than pure-PRNG:
    // two batches sharing a seed would otherwise collide on it.
    const uuid = ctx.uuidFor('fw', i);
    const rule = {
      action: external ? rng.weighted([['block', 3], ['allow', 1]]) : rng.weighted([['allow', 4], ['block', 1]]),
      source_ip: external ? rng.testNetCidr() : rng.rfc1918Cidr(),   // TEST-NET / RFC1918 only
      destination_ip: rng.bool(0.25) ? h.ip : null,
      destination_port: rng.pick([22, 80, 443, 2376, 5432, 6379, 8080, 9090, 3000]),
      protocol: rng.weighted([['tcp', 8], ['udp', 2]]),
      chain_name: rng.weighted([['DOCKER-USER', 5], ['INPUT', 3]]),
      comment_tag: `APPFW uuid=${uuid}`,
      scope: rng.weighted([['docker', 5], ['host', 3]]),
    };
    insRule.run(
      uuid, h.id, backend, rule.scope, rule.action, rule.source_ip, rule.destination_ip,
      rule.destination_port, rule.protocol, rule.chain_name,
      _expression(backend, rule), rule.comment_tag,
      rng.pick(FIREWALL_REASONS), 'demo-ops',
      rng.dateBetween(ctx.nowMs - 90 * 864e5, ctx.nowMs), 0, datasetId,
    );
    rules += 1;
  }

  ctx.count('firewall_snapshots', snapshots);
  ctx.count('firewall_rules', rules);
  ctx.refs.firewallRules = rules;
  return { count: snapshots + rules };
}

module.exports = { generate };
