'use strict';

// v8.11 — Platform (hypervisor) firewall WRITE — Phase A (Proxmox).
//
// SECURITY-CRITICAL. Writing a firewall rule on a Proxmox host can lock the
// admin (and docker-dash) out of the host itself. Every mutation therefore runs
// through a pipeline that is STRICTER than the Linux one:
//   1. Validate the rule against a Proxmox-specific schema (reusing validate.js
//      primitives).
//   2. Lockout guard (extended) — refuse a mutation that could sever SSH (22) /
//      PVE web (8006) management access.
//   3. Snapshot the pre-mutation state (firewall_snapshots, backend='proxmox').
//   4. Apply as PROVISIONAL with a commit-confirmed auto-revert deadline: the
//      change un-does itself after DD_PLATFORM_CONFIRM_MINUTES (default 5) unless
//      an admin explicitly confirms it. If a change locks us out we can't confirm
//      it → it auto-reverts → access is restored.
//   5. Audit every confirm / revert / auto-revert (apply/remove are audited by
//      the route layer, matching the existing firewall route pattern).
//
// ESXi / Incus writes stay read-only until their own phases (supportsWrite gates
// them). Nothing here touches non-platform (Linux/Windows iptables) hosts.

const validate = require('./validate');
const lockout = require('./lockout');

function _db() { return require('../../db').getDb(); }

// Management ports we must never sever. 22 = SSH (docker-dash's own channel to
// the host), 8006 = the Proxmox VE web UI / API.
const MGMT_PORTS = [22, 8006];

const DEFAULT_CONFIRM_MINUTES = 5;

const RULE_TYPES = ['in', 'out'];
const RULE_ACTIONS = ['ACCEPT', 'DROP', 'REJECT'];
const RULE_PROTOS = ['tcp', 'udp', 'icmp'];

// ─── Capability gate ─────────────────────────────────────────
// Only Proxmox is writable in this phase. ESXi/Incus return false so the
// dispatcher keeps throwing the read-only error for them.
function supportsWrite(daemonType) { return daemonType === 'proxmox'; }

// ─── Validation ──────────────────────────────────────────────
// A Proxmox dport is a single port OR an "n:m" inclusive range.
function _validateDport(dport) {
  const s = String(dport);
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) return false;
    if (!validate.validatePort(parts[0]) || !validate.validatePort(parts[1])) return false;
    return parseInt(parts[0], 10) <= parseInt(parts[1], 10);
  }
  return validate.validatePort(s);
}

/**
 * Validate + normalize a Proxmox firewall rule. Throws on the first problem.
 * @returns {{type,action,source?,dest?,dport?,proto?,comment?}} normalized rule
 */
function validateProxmoxRule(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Missing rule spec');

  const type = String(spec.type || '').toLowerCase();
  if (!RULE_TYPES.includes(type)) throw new Error(`Invalid rule type "${spec.type}" (in|out)`);

  const action = String(spec.action || '').toUpperCase();
  if (!RULE_ACTIONS.includes(action)) throw new Error(`Invalid action "${spec.action}" (ACCEPT|DROP|REJECT)`);

  const out = { type, action };

  if (spec.source !== undefined && spec.source !== null && spec.source !== '') {
    if (!validate.validateCidrOrIp(spec.source)) throw new Error(`Invalid source IP/CIDR "${spec.source}"`);
    out.source = spec.source;
  }
  if (spec.dest !== undefined && spec.dest !== null && spec.dest !== '') {
    if (!validate.validateCidrOrIp(spec.dest)) throw new Error(`Invalid dest IP/CIDR "${spec.dest}"`);
    out.dest = spec.dest;
  }
  if (spec.dport !== undefined && spec.dport !== null && spec.dport !== '') {
    if (!_validateDport(spec.dport)) throw new Error(`Invalid destination port "${spec.dport}" (1-65535 or n:m range)`);
    out.dport = String(spec.dport);
  }
  if (spec.proto !== undefined && spec.proto !== null && spec.proto !== '') {
    const proto = String(spec.proto).toLowerCase();
    if (!RULE_PROTOS.includes(proto)) throw new Error(`Invalid protocol "${spec.proto}" (tcp|udp|icmp)`);
    out.proto = proto;
  }
  const comment = validate.sanitizeReason(spec.comment);
  if (comment) out.comment = comment;

  // A rule must constrain SOMETHING — refuse an unconstrained (blanket) rule,
  // mirroring assertSafe's "no all-traffic rule" guard.
  if (out.dport === undefined && out.source === undefined && out.dest === undefined) {
    throw new Error('A rule must specify at least a destination port, a source, or a destination (refusing an unconstrained rule)');
  }
  return out;
}

// ─── Lockout guard (extended) ────────────────────────────────
function _dportRange(dport) {
  if (dport === undefined || dport === null || dport === '') return null;
  const s = String(dport);
  if (s.includes(':')) { const [a, b] = s.split(':'); return [parseInt(a, 10), parseInt(b, 10)]; }
  const n = parseInt(s, 10);
  return [n, n];
}

// Does this dport match a management port? An ABSENT dport matches every port
// (including 22/8006), which is the most dangerous case.
function _dportCoversMgmt(dport) {
  const r = _dportRange(dport);
  if (!r) return true;
  const [lo, hi] = r;
  return MGMT_PORTS.some(p => p >= lo && p <= hi);
}

function _ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

// Does an ACCEPT rule's `source` cover the requester's IP? "any" (empty),
// an exact match, a default route, or an IPv4 CIDR that contains it all count.
// Anything we can't positively verify → false (fail safe: we'd rather refuse to
// enable than wrongly assume the admin is protected).
function _sourceMatchesIp(source, ip) {
  if (source === undefined || source === null || source === '') return true; // any
  if (!ip) return false;
  if (source === ip) return true;
  if (source === '0.0.0.0/0' || source === '::/0') return true;
  const slash = source.indexOf('/');
  if (slash !== -1 && String(ip).indexOf(':') === -1) {
    const range = source.slice(0, slash);
    const bits = parseInt(source.slice(slash + 1), 10);
    const ipN = _ipv4ToInt(ip);
    const rangeN = _ipv4ToInt(range);
    if (ipN != null && rangeN != null && bits >= 0 && bits <= 32) {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (ipN & mask) === (rangeN & mask);
    }
  }
  return false;
}

function _ruleEnabled(r) { return r.enable === undefined ? true : Number(r.enable) !== 0; }

// Is there an enabled inbound ACCEPT rule that covers (ip, port)?
function _acceptCoversPort(rules, ip, port) {
  return (rules || []).some(r => {
    if (String(r.type || '').toLowerCase() !== 'in') return false;
    if (String(r.action || '').toUpperCase() !== 'ACCEPT') return false;
    if (!_ruleEnabled(r)) return false;
    if (!_sourceMatchesIp(r.source, ip)) return false;
    const range = _dportRange(r.dport);
    if (!range) return true; // no port constraint → covers every port
    return port >= range[0] && port <= range[1];
  });
}

/**
 * The extended lockout guard for Proxmox mutations.
 * @param {object} p
 * @param {object|null} p.rule           normalized rule being added (null for set-options)
 * @param {boolean} p.enableFirewall     true if this mutation would enable the firewall
 * @param {string}  p.requesterIp        the admin's own IP
 * @param {object[]} p.currentRules      existing rules on the target scope
 * @param {object}  p.currentOptions     existing firewall options on the target scope
 * @throws Error if the mutation could sever management access
 */
function lockoutCheckProxmox({ rule, enableFirewall, requesterIp, currentRules } = {}) {
  const rules = currentRules || [];

  // (1) Enabling the firewall makes the default input policy DROP. If no ACCEPT
  //     rule protects the requester's IP on BOTH 22 and 8006, enabling = certain
  //     lockout. A pending ACCEPT rule added in the same op counts toward this.
  if (enableFirewall === true) {
    const eff = rule ? rules.concat([rule]) : rules;
    const covers22 = _acceptCoversPort(eff, requesterIp, 22);
    const covers8006 = _acceptCoversPort(eff, requesterIp, 8006);
    if (!(covers22 && covers8006)) {
      throw new Error('Refusing to enable the firewall: no ACCEPT rule protects SSH (22) / PVE web (8006) for your IP — you would be locked out.');
    }
  }

  // (2) A DROP/REJECT inbound rule with NO scoped source that would match a
  //     management port drops SSH/PVE for everyone — refuse it.
  if (rule && (rule.action === 'DROP' || rule.action === 'REJECT')) {
    const scoped = rule.source !== undefined && rule.source !== null && rule.source !== '';
    if (String(rule.type || '').toLowerCase() === 'in' && !scoped && _dportCoversMgmt(rule.dport)) {
      throw new Error(`Refusing this ${rule.action} rule: it would drop SSH (22) / PVE web (8006) for everyone (no scoped source) — lockout guard. Restrict it by source IP if you really need this.`);
    }
  }

  // (3) Always run the base lockout guard too, by mapping the Proxmox rule to its
  //     intermediate {action, destination_port, source_ip} spec. This catches
  //     "block your own IP" and single-port mgmt closes; ranges are handled by
  //     check (2) above (the base guard only understands a single numeric port).
  if (rule) {
    const mapped = {
      action: (rule.action === 'DROP' || rule.action === 'REJECT') ? 'block' : 'allow',
      source_ip: rule.source,
    };
    const range = _dportRange(rule.dport);
    if (range && range[0] === range[1]) mapped.destination_port = range[0];
    lockout.check({ sshPort: 22, spec: mapped, requesterIp });
  }
}

// Removing a rule is generally safe, but removing the ONLY inbound ACCEPT that
// protects a management port for the requester while the firewall is enabled is
// a lockout — refuse it.
function _lockoutCheckRemoval({ target, requesterIp, currentRules, currentOptions }) {
  const enabled = currentOptions && (currentOptions.enable === undefined ? false : Number(currentOptions.enable) !== 0);
  if (!enabled) return;
  if (String(target.type || '').toLowerCase() !== 'in') return;
  if (String(target.action || '').toUpperCase() !== 'ACCEPT') return;
  const remaining = (currentRules || []).filter(r => r !== target && Number(r.pos) !== Number(target.pos));
  for (const port of MGMT_PORTS) {
    if (_acceptCoversPort([target], requesterIp, port) && !_acceptCoversPort(remaining, requesterIp, port)) {
      throw new Error(`Refusing to remove this rule: it is the only ACCEPT protecting ${port === 22 ? 'SSH (22)' : 'PVE web (8006)'} for your IP while the firewall is enabled — you would be locked out.`);
    }
  }
}

// ─── Helpers: scope, client, bodies, snapshot ────────────────
function _normalizeScope(rawSpec) {
  const scope = (rawSpec && rawSpec.scope) || 'cluster';
  if (scope === 'node') {
    const node = String((rawSpec && rawSpec.node) || '').trim();
    if (!node) throw new Error('scope "node" requires a node name');
    if (validate.DANGEROUS.test(node)) throw new Error(`Invalid node name "${node}"`);
    return { scopeLabel: `node:${node}`, node };
  }
  if (scope !== 'cluster') throw new Error(`Invalid scope "${scope}" (cluster|node)`);
  return { scopeLabel: 'cluster', node: null };
}

function _nodeFromScope(scopeLabel) {
  if (typeof scopeLabel === 'string' && scopeLabel.startsWith('node:')) return scopeLabel.slice(5);
  return null;
}

function _client(hostId) {
  const row = _db().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!row) { const e = new Error(`Host ${hostId} not found`); e.status = 404; throw e; }
  return { row, client: require('../proxmox').fromHostRow(row) };
}

// Read the structured pre-state for a scope. NOT swallowed — if we can't read
// the current state we must NOT mutate (fail safe: no change without a snapshot).
async function _fetchScopeState(client, scope) {
  if (scope.node) {
    const rules = await client.getNodeFirewallRules(scope.node);
    let options = null;
    try { options = await client.getNodeFirewallOptions(scope.node); } catch { options = null; }
    return { rules: rules || [], options: options || null };
  }
  const rules = await client.getClusterFirewallRules();
  let options = null;
  try { options = await client.getClusterFirewallOptions(); } catch { options = null; }
  return { rules: rules || [], options: options || null };
}

function _ruleToBody(rule) {
  const body = { type: rule.type, action: rule.action, enable: 1 };
  if (rule.source) body.source = rule.source;
  if (rule.dest) body.dest = rule.dest;
  if (rule.proto) body.proto = rule.proto;
  if (rule.dport) body.dport = rule.dport;
  if (rule.comment) body.comment = rule.comment;
  return body;
}

// Re-create body for a raw Proxmox rule object (used on remove-rule revert).
function _rawRuleToBody(r) {
  const body = { type: r.type, action: r.action };
  ['source', 'dest', 'proto', 'dport', 'sport', 'iface', 'macro', 'comment', 'log'].forEach(k => {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') body[k] = r[k];
  });
  body.enable = (r.enable === undefined ? 1 : (Number(r.enable) ? 1 : 0));
  return body;
}

function _parseEnable(v) { return (v === true || v === 1 || v === '1') ? 1 : 0; }

function _confirmMinutes() {
  const n = parseInt(process.env.DD_PLATFORM_CONFIRM_MINUTES, 10);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : DEFAULT_CONFIRM_MINUTES;
}

function _parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// Snapshot the pre-mutation state: the getPlatformFirewall human view PLUS a
// structured proxmox pre-state (rules + options) that revert reads back.
async function _snapshotPre(row, hostId, user, scope, pre) {
  let pfView = null;
  try { pfView = await require('./platform').getPlatformFirewall(row); } catch { /* best-effort */ }
  const content = JSON.stringify({
    platform: pfView,
    proxmox: { scope: scope.scopeLabel, node: scope.node || null, rules: pre.rules, options: pre.options },
  });
  const info = _db().prepare(
    'INSERT INTO firewall_snapshots (host_id, backend, snapshot_content, created_by, reason) VALUES (?,?,?,?,?)'
  ).run(hostId, 'proxmox', content, (user && user.username) || 'system', 'pre-platform-apply');
  return info.lastInsertRowid;
}

function _audit(action, hostId, details, user) {
  try {
    require('../audit').log({
      userId: user && user.id,
      username: (user && user.username) || 'system',
      action, targetType: 'firewall', targetId: String(hostId),
      details, ip: (user && user.ip) || undefined,
    });
  } catch { /* audit is best-effort; never break the mutation on an audit failure */ }
}

// ─── Apply (add-rule / set-options), provisional ─────────────
async function applyPlatformRule(host, rawSpec, user, requesterIp) {
  if (!supportsWrite(host.daemonType)) {
    throw new Error(`${host.daemonType} firewall write is not supported in this phase (Proxmox only).`);
  }
  const db = _db();
  const scope = _normalizeScope(rawSpec);
  const { row, client } = _client(host.id);
  const pre = await _fetchScopeState(client, scope);

  const isSetOptions = !!(rawSpec && (rawSpec.operation === 'set-options' || rawSpec.setOptions === true || rawSpec.options != null));

  let operation, normalizedRule, applyFn, specForDb;
  if (isSetOptions) {
    operation = 'set-options';
    const enable = _parseEnable(rawSpec.enable != null ? rawSpec.enable : (rawSpec.options && rawSpec.options.enable));
    lockoutCheckProxmox({ rule: null, enableFirewall: enable === 1, requesterIp, currentRules: pre.rules, currentOptions: pre.options });
    normalizedRule = { enable };
    specForDb = { options: { enable }, node: scope.node || null, preOptions: pre.options || null };
    applyFn = () => scope.node
      ? client.setNodeFirewallOptions(scope.node, { enable })
      : client.setClusterFirewallOptions({ enable });
  } else {
    operation = 'add-rule';
    normalizedRule = validateProxmoxRule(rawSpec);
    lockoutCheckProxmox({ rule: normalizedRule, enableFirewall: false, requesterIp, currentRules: pre.rules, currentOptions: pre.options });
    const body = _ruleToBody(normalizedRule);
    specForDb = { rule: normalizedRule, node: scope.node || null };
    applyFn = () => scope.node
      ? client.createNodeFirewallRule(scope.node, body)
      : client.createClusterFirewallRule(body);
  }

  // Snapshot BEFORE mutating (non-negotiable rollback source).
  const snapshotId = await _snapshotPre(row, host.id, user, scope, pre);

  // Apply. On failure, record a 'failed' row so a host can never end up mutated
  // without a trace.
  try {
    await applyFn();
  } catch (err) {
    db.prepare(`INSERT INTO platform_firewall_changes
      (host_id, platform, scope, operation, spec, pre_snapshot_id, state, applied_by, error)
      VALUES (?,?,?,?,?,?,'failed',?,?)`).run(
      host.id, 'proxmox', scope.scopeLabel, operation, JSON.stringify(specForDb),
      snapshotId, (user && user.username) || 'system', String(err.message).slice(0, 500));
    throw err;
  }

  const mins = _confirmMinutes();
  const info = db.prepare(`INSERT INTO platform_firewall_changes
    (host_id, platform, scope, operation, spec, pre_snapshot_id, state, applied_by, revert_at)
    VALUES (?,?,?,?,?,?, 'provisional', ?, datetime('now', ?))`).run(
    host.id, 'proxmox', scope.scopeLabel, operation, JSON.stringify(specForDb),
    snapshotId, (user && user.username) || 'system', `+${mins} minutes`);

  const changeId = info.lastInsertRowid;
  const rowNow = db.prepare('SELECT revert_at FROM platform_firewall_changes WHERE id = ?').get(changeId);
  return { ok: true, changeId, revertAt: rowNow.revert_at, provisional: true, operation, scope: scope.scopeLabel };
}

// ─── Remove (delete a rule by position), provisional ─────────
async function removePlatformRule(host, params, user, requesterIp) {
  if (!supportsWrite(host.daemonType)) {
    throw new Error(`${host.daemonType} firewall write is not supported in this phase (Proxmox only).`);
  }
  const db = _db();
  const scope = _normalizeScope(params);
  const pos = params && params.pos;
  if (pos === undefined || pos === null || !/^\d+$/.test(String(pos))) {
    throw new Error('A numeric rule position (pos) is required to remove a platform firewall rule.');
  }
  const posN = parseInt(pos, 10);

  const { row, client } = _client(host.id);
  const pre = await _fetchScopeState(client, scope);
  const target = (pre.rules || []).find(r => Number(r.pos) === posN) || (pre.rules || [])[posN];
  if (!target) throw new Error(`No firewall rule at position ${posN} on ${scope.scopeLabel}.`);

  _lockoutCheckRemoval({ target, requesterIp, currentRules: pre.rules, currentOptions: pre.options });

  const snapshotId = await _snapshotPre(row, host.id, user, scope, pre);
  const specForDb = { pos: posN, removedRule: target, node: scope.node || null };

  try {
    if (scope.node) await client.deleteNodeFirewallRule(scope.node, posN);
    else await client.deleteClusterFirewallRule(posN);
  } catch (err) {
    db.prepare(`INSERT INTO platform_firewall_changes
      (host_id, platform, scope, operation, spec, pre_snapshot_id, state, applied_by, error)
      VALUES (?,?,?,?,?,?,'failed',?,?)`).run(
      host.id, 'proxmox', scope.scopeLabel, 'remove-rule', JSON.stringify(specForDb),
      snapshotId, (user && user.username) || 'system', String(err.message).slice(0, 500));
    throw err;
  }

  const mins = _confirmMinutes();
  const info = db.prepare(`INSERT INTO platform_firewall_changes
    (host_id, platform, scope, operation, spec, pre_snapshot_id, state, applied_by, revert_at)
    VALUES (?,?,?,?,?,?, 'provisional', ?, datetime('now', ?))`).run(
    host.id, 'proxmox', scope.scopeLabel, 'remove-rule', JSON.stringify(specForDb),
    snapshotId, (user && user.username) || 'system', `+${mins} minutes`);

  const changeId = info.lastInsertRowid;
  const rowNow = db.prepare('SELECT revert_at FROM platform_firewall_changes WHERE id = ?').get(changeId);
  return { ok: true, changeId, revertAt: rowNow.revert_at, provisional: true, operation: 'remove-rule', scope: scope.scopeLabel };
}

// ─── Confirm / Revert / Sweep ────────────────────────────────
function confirmPlatformChange(changeId, user) {
  const db = _db();
  const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(changeId);
  if (!row) throw new Error('Change not found');
  if (row.state !== 'provisional') throw new Error(`Change #${changeId} is ${row.state}, not provisional — nothing to confirm.`);
  db.prepare("UPDATE platform_firewall_changes SET state='confirmed', confirmed_at=datetime('now'), revert_at=NULL WHERE id = ?").run(changeId);
  _audit('firewall_platform_confirm', row.host_id, { changeId, operation: row.operation, scope: row.scope }, user);
  return { ok: true, changeId, state: 'confirmed' };
}

function _findMatchingRulePos(rules, rule) {
  if (!rule) return null;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (String(r.type || '').toLowerCase() !== rule.type) continue;
    if (String(r.action || '').toUpperCase() !== rule.action) continue;
    if ((r.source || '') !== (rule.source || '')) continue;
    if ((r.dest || '') !== (rule.dest || '')) continue;
    if (String(r.dport || '') !== String(rule.dport || '')) continue;
    if ((r.proto || '') !== (rule.proto || '')) continue;
    return r.pos != null ? Number(r.pos) : i;
  }
  return null;
}

function _priorOptionsFromSnapshot(changeRow) {
  if (!changeRow.pre_snapshot_id) return null;
  const snap = _db().prepare('SELECT snapshot_content FROM firewall_snapshots WHERE id = ?').get(changeRow.pre_snapshot_id);
  if (!snap) return null;
  const content = _parseJson(snap.snapshot_content);
  return content && content.proxmox ? content.proxmox.options : null;
}

// Perform the actual restore for a change row (shared by manual revert + sweep).
async function _revertChangeRow(row) {
  const db = _db();
  const spec = _parseJson(row.spec) || {};
  const node = spec.node || _nodeFromScope(row.scope);
  const scope = { scopeLabel: row.scope, node };
  const { client } = _client(row.host_id);

  if (row.operation === 'add-rule') {
    // Delete the rule we created (match by normalized fields; if it's already
    // gone the state is already what we want — treat as reverted).
    const rules = scope.node ? await client.getNodeFirewallRules(scope.node) : await client.getClusterFirewallRules();
    const pos = _findMatchingRulePos(rules || [], spec.rule);
    if (pos != null) {
      if (scope.node) await client.deleteNodeFirewallRule(scope.node, pos);
      else await client.deleteClusterFirewallRule(pos);
    }
  } else if (row.operation === 'remove-rule') {
    // Re-create the rule we deleted from its captured pre-state.
    if (spec.removedRule) {
      const body = _rawRuleToBody(spec.removedRule);
      if (scope.node) await client.createNodeFirewallRule(scope.node, body);
      else await client.createClusterFirewallRule(body);
    }
  } else if (row.operation === 'set-options') {
    // Restore prior options captured in the snapshot.
    const prior = _priorOptionsFromSnapshot(row);
    const restore = { enable: prior && prior.enable !== undefined ? (Number(prior.enable) ? 1 : 0) : 0 };
    if (scope.node) await client.setNodeFirewallOptions(scope.node, restore);
    else await client.setClusterFirewallOptions(restore);
  }

  db.prepare("UPDATE platform_firewall_changes SET state='reverted', reverted_at=datetime('now'), revert_at=NULL WHERE id = ?").run(row.id);
}

async function revertPlatformChange(changeId, user, opts = {}) {
  const db = _db();
  const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(changeId);
  if (!row) throw new Error('Change not found');
  if (row.state === 'reverted') return { ok: true, changeId, state: 'reverted', alreadyReverted: true };
  if (row.state !== 'provisional' && row.state !== 'confirmed') throw new Error(`Change #${changeId} is ${row.state} — cannot revert.`);
  await _revertChangeRow(row);
  _audit('firewall_platform_revert', row.host_id, { changeId, operation: row.operation, scope: row.scope, reason: opts.reason }, user);
  return { ok: true, changeId, state: 'reverted' };
}

function _notifyAutoRevert(row) {
  try {
    const { notifications } = require('../misc');
    let name = `host ${row.host_id}`;
    try { const h = _db().prepare('SELECT name FROM docker_hosts WHERE id = ?').get(row.host_id); if (h) name = h.name; } catch { /* ignore */ }
    notifications.create({
      userId: null, type: 'warning',
      title: `Firewall change auto-reverted on ${name}`,
      message: `Auto-reverted unconfirmed firewall change on ${name} (commit-confirmed timeout). The ${row.operation} on ${row.scope} was rolled back to the pre-change snapshot.`,
      link: '#/firewall',
    });
  } catch { /* best-effort */ }
}

// Revert every provisional change whose commit-confirmed deadline has passed.
// Best-effort per row so one host being down doesn't stall the rest.
async function sweepExpiredProvisional() {
  const db = _db();
  let rows;
  try {
    rows = db.prepare(
      "SELECT * FROM platform_firewall_changes WHERE state='provisional' AND revert_at IS NOT NULL AND revert_at <= datetime('now')"
    ).all();
  } catch { return { reverted: 0, failed: 0 }; }
  if (!rows.length) return { reverted: 0, failed: 0 };

  let reverted = 0, failed = 0;
  for (const row of rows) {
    try {
      await _revertChangeRow(row);
      reverted++;
      _audit('firewall_platform_auto_revert', row.host_id, { changeId: row.id, operation: row.operation, scope: row.scope }, { username: 'system' });
      _notifyAutoRevert(row);
    } catch (err) {
      failed++;
      // Leave it provisional so the next sweep retries (a host that's temporarily
      // down must not lose its pending auto-revert). Record the last error.
      try { db.prepare('UPDATE platform_firewall_changes SET error = ? WHERE id = ?').run(String(err.message).slice(0, 500), row.id); } catch { /* ignore */ }
    }
  }
  return { reverted, failed };
}

// 60s cadence so a 5-minute deadline fires within ~1 minute of expiry. Unref'd +
// a delayed first run so boot isn't hammered.
function startSweep(intervalMs = 60000) {
  const first = setTimeout(() => { sweepExpiredProvisional().catch(() => {}); }, 15000);
  if (first.unref) first.unref();
  const t = setInterval(() => { sweepExpiredProvisional().catch(() => {}); }, intervalMs);
  if (t.unref) t.unref();
  return t;
}

function getPendingChanges(hostId) {
  const rows = _db().prepare(
    "SELECT id, host_id, platform, scope, operation, spec, state, applied_by, applied_at, revert_at FROM platform_firewall_changes WHERE host_id = ? AND state = 'provisional' ORDER BY applied_at DESC"
  ).all(hostId);
  return { hostId, pending: rows.map(r => ({ ...r, spec: _parseJson(r.spec) })) };
}

module.exports = {
  supportsWrite,
  validateProxmoxRule,
  lockoutCheckProxmox,
  applyPlatformRule,
  removePlatformRule,
  confirmPlatformChange,
  revertPlatformChange,
  sweepExpiredProvisional,
  startSweep,
  getPendingChanges,
  _internals: {
    MGMT_PORTS, DEFAULT_CONFIRM_MINUTES, _dportRange, _dportCoversMgmt,
    _acceptCoversPort, _sourceMatchesIp, _findMatchingRulePos, _normalizeScope,
    _confirmMinutes, _lockoutCheckRemoval,
  },
};
