'use strict';

// v8.9.33-alpha.1 — READ-ONLY firewall status for non-Docker daemon hosts. These
// platforms have their own firewalls (not iptables/nftables), so we can't manage
// them through the standard backend runner — but we CAN show their state by
// reusing each platform's existing client:
//   • vSphere/ESXi → esxcli network firewall (over the host's vSphere SSH config)
//   • Proxmox      → pve-firewall via the Proxmox API (cluster + node)
//   • Incus/LXD    → network ACLs via the Incus API
// Returns a uniform { platform, available, readOnly, summary, groups[], raw } so
// the Firewall page can render any of them with one view.

const PLATFORM_TYPES = new Set(['vsphere', 'proxmox', 'incus', 'lxd']);

function isPlatformHost(daemonType) { return PLATFORM_TYPES.has(daemonType); }

async function getPlatformFirewall(row) {
  switch (row.daemon_type) {
    case 'vsphere': return _esxi(row);
    case 'proxmox': return _proxmox(row);
    case 'incus':
    case 'lxd': return _incus(row);
    default: return null;
  }
}

// ─── ESXi (esxcli over SSH) ──────────────────────────────────
async function _esxi(row) {
  const base = { platform: 'esxi', readOnly: true, groups: [], raw: '' };
  let sshConfig = null;
  try {
    const cfg = require('../vsphere').decryptDaemonConfig(row.daemon_config) || {};
    sshConfig = cfg.sshConfig;
  } catch { /* ignore */ }
  if (!sshConfig || !sshConfig.host) {
    return { ...base, available: false, summary: 'SSH access is not configured for this ESXi host. Add SSH (host/user/key) on the Hosts page to read the firewall.' };
  }
  try {
    const fw = await require('../vsphere-ssh').getFirewall(sshConfig);
    const groups = [{
      title: 'Rulesets',
      items: (fw.rulesets || []).map(r => ({
        name: r.name,
        enabled: r.enabled,
        detail: (r.allowedIps && r.allowedIps.length) ? `Allowed: ${r.allowedIps.join(', ')}` : 'Allowed: All',
      })),
    }];
    return { ...base, available: true, summary: `Firewall ${fw.enabled ? 'enabled' : 'disabled'} · default ${fw.defaultAction || '?'} · ${(fw.rulesets || []).length} ruleset(s)`, groups, raw: JSON.stringify(fw, null, 2) };
  } catch (err) {
    return { ...base, available: false, summary: `Could not read ESXi firewall: ${err.message}` };
  }
}

// ─── Proxmox (pve-firewall via API) ──────────────────────────
function _pxRuleItem(r) {
  const dir = (r.type || '').toUpperCase();
  const act = r.action || r.macro || '';
  const proto = r.proto ? ` ${r.proto}` : '';
  const dport = r.dport ? ` dport ${r.dport}` : '';
  return {
    name: `${dir} ${act}${proto}${dport}`.trim(),
    enabled: r.enable === undefined ? true : Number(r.enable) !== 0,
    detail: `${r.source || 'any'} → ${r.dest || 'any'}${r.comment ? ` · ${r.comment}` : ''}`,
  };
}

async function _proxmox(row) {
  const base = { platform: 'proxmox', readOnly: true, groups: [], raw: '' };
  try {
    const client = require('../proxmox').fromHostRow(row);
    const nodes = await client.listNodes();
    const node = nodes[0] && nodes[0].node;
    const [copts, crules, nopts, nrules] = await Promise.all([
      client.getClusterFirewallOptions().catch(() => null),
      client.getClusterFirewallRules().catch(() => []),
      node ? client.getNodeFirewallOptions(node).catch(() => null) : Promise.resolve(null),
      node ? client.getNodeFirewallRules(node).catch(() => []) : Promise.resolve([]),
    ]);
    const groups = [
      { title: 'Cluster rules', items: (crules || []).map(_pxRuleItem) },
      { title: `Node ${node || '?'} rules`, items: (nrules || []).map(_pxRuleItem) },
    ];
    const clusterOn = copts && (copts.enable === undefined ? null : Number(copts.enable) !== 0);
    return { ...base, available: true, summary: `Cluster firewall ${clusterOn === null ? 'unknown' : clusterOn ? 'enabled' : 'disabled'} · ${(crules || []).length} cluster + ${(nrules || []).length} node rule(s)`, groups, raw: JSON.stringify({ clusterOptions: copts, nodeOptions: nopts }, null, 2) };
  } catch (err) {
    return { ...base, available: false, summary: `Could not read Proxmox firewall: ${err.message}` };
  }
}

// ─── Incus / LXD (network ACLs via API) ──────────────────────
function _aclItems(acl, dir) {
  return (acl[dir] || []).map(r => ({
    name: `${dir} ${r.action || ''}${r.protocol ? ` ${r.protocol}` : ''}`.trim(),
    enabled: (r.state || 'enabled') !== 'disabled',
    detail: `${r.source || 'any'} → ${r.destination || 'any'}${r.destination_port ? `:${r.destination_port}` : ''}${r.description ? ` · ${r.description}` : ''}`,
  }));
}

async function _incus(row) {
  const base = { platform: 'incus', readOnly: true, groups: [], raw: '' };
  try {
    const client = require('../incus').fromHostRow(row);
    const acls = await client.listNetworkAcls();
    const groups = (acls || []).map(acl => ({
      title: `ACL ${acl.name}${acl.description ? ` — ${acl.description}` : ''}`,
      items: [..._aclItems(acl, 'ingress'), ..._aclItems(acl, 'egress')],
    }));
    return { ...base, available: true, summary: `${(acls || []).length} network ACL(s). Note: host-level firewall (iptables/nftables) needs an SSH-registered host.`, groups, raw: JSON.stringify(acls, null, 2) };
  } catch (err) {
    const forbidden = err && (err.status === 403 || /forbidden|untrusted/i.test(err.message || ''));
    return { ...base, available: false, trustHint: !!forbidden, summary: forbidden ? 'Incus/LXD rejected docker-dash as untrusted — trust it on the Instances page first, then reload.' : `Could not read Incus ACLs: ${err.message}` };
  }
}

module.exports = { isPlatformHost, getPlatformFirewall, PLATFORM_TYPES };
