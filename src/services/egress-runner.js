'use strict';

// Egress Runner — v6.7.0-alpha.3
//
// Orchestrates the helper-container installation of nftables rules inside a
// target container's netns, redirecting all TCP egress to the dd-egress-proxy
// sidecar (except DNS and the sidecar itself).
//
// Design: see docs/planning/v6.7/outbound-filter/02-deep-spec.md §4.
// Validated sequence in preflight P1 (2026-04-20).
//
// Invariants:
//   - Uses a short-lived helper container with NET_ADMIN (not the Docker Dash
//     container itself — keeps main app CIS-compliant).
//   - All nftables objects live in `ip ddout` table so they're identifiable.
//   - apply + apply is idempotent (rules live in the table; re-applying just
//     replaces them).
//   - remove-when-not-applied is safe (flush on an empty table is a no-op).
//   - All apply/remove ops complete in < 10 seconds.

const log = require('../utils/logger')('egress-runner');
const dockerService = require('./docker');

// The helper image runs the install/uninstall script. Uses Alpine + nftables
// package. Could switch to a pre-baked image later for faster cold-start.
const HELPER_IMAGE = process.env.DD_EGRESS_HELPER_IMAGE || 'alpine:3.24.2';

// Where the sidecar listens. Operator configures via env — runner does NOT
// auto-discover (keeps the blast radius predictable).
function _sidecarEndpoint() {
  const v = process.env.DD_EGRESS_SIDECAR_ENDPOINT;
  if (!v) {
    throw new Error('DD_EGRESS_SIDECAR_ENDPOINT not set — e.g. "172.17.0.5:29193". Configure before applying.');
  }
  const [ip, port] = v.split(':');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+$/.test(port)) {
    throw new Error(`DD_EGRESS_SIDECAR_ENDPOINT must be "ip:port", got "${v}"`);
  }
  return { ip, port: parseInt(port, 10) };
}

// ─── Apply / Remove scripts ─────────────────────────

// Installed by a helper container entered into the target's network namespace
// via `--network container:<target-id>`. Rules persist in the netns after
// helper exits (preflight P1 confirmed).
//
// Logic:
//   - Any TCP output to sidecar IP:port → accept unchanged
//   - Port 53 UDP/TCP (DNS) → accept
//   - Loopback (lo interface) → accept
//   - Destinations on the container's local bridge (RFC1918 same-subnet)
//     need to pass for service-to-service traffic — we let RFC1918 pass for
//     now. Users wanting stricter per-stack policies come to v6.7-rc2.
//   - Everything else → DNAT to sidecar, hitting the SNI/Host-peek logic
function _applyScript(sidecarIp, sidecarPort) {
  return [
    'apk add -q --no-cache nftables',
    // Idempotent: delete any previous table, then recreate
    'nft delete table ip ddout 2>/dev/null || true',
    'nft add table ip ddout',
    'nft add chain ip ddout prerouting "{ type nat hook output priority -100 ; }"',
    // Accept traffic to the sidecar itself (no loop)
    `nft add rule ip ddout prerouting ip daddr ${sidecarIp} tcp dport ${sidecarPort} return`,
    // Accept DNS (UDP/TCP port 53) — container still needs name resolution
    'nft add rule ip ddout prerouting udp dport 53 return',
    'nft add rule ip ddout prerouting tcp dport 53 return',
    // Accept loopback + RFC1918 to preserve service-to-service (will be
    // tightened per-stack in rc2)
    'nft add rule ip ddout prerouting oifname "lo" return',
    'nft add rule ip ddout prerouting ip daddr 127.0.0.0/8 return',
    'nft add rule ip ddout prerouting ip daddr 10.0.0.0/8 return',
    'nft add rule ip ddout prerouting ip daddr 172.16.0.0/12 return',
    'nft add rule ip ddout prerouting ip daddr 192.168.0.0/16 return',
    // Everything else — redirect to the sidecar
    `nft add rule ip ddout prerouting tcp dport 0-65535 dnat to ${sidecarIp}:${sidecarPort}`,
    // Print final state for audit trail
    'nft list table ip ddout',
  ].join(' && ');
}

function _removeScript() {
  return [
    'apk add -q --no-cache nftables',
    'nft delete table ip ddout 2>/dev/null || true',
    'echo removed',
  ].join(' && ');
}

function _inspectScript() {
  return [
    'apk add -q --no-cache nftables',
    '(nft list table ip ddout 2>/dev/null && echo APPLIED) || echo NOT_APPLIED',
  ].join(' && ');
}

// ─── Helper runner ───────────────────────────────────

async function _runHelper(containerId, hostId, script) {
  const docker = dockerService.getDocker(hostId || 0);
  const helper = await docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ['sh', '-c', script],
    HostConfig: {
      NetworkMode: `container:${containerId}`,
      CapAdd: ['NET_ADMIN'],
      AutoRemove: false,  // we manage removal for stdout capture
    },
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
  });

  try {
    await helper.start();
    const logsStream = await helper.logs({ stdout: true, stderr: true, follow: true });
    let out = '';
    await new Promise((resolve) => {
      logsStream.on('data', (chunk) => { out += chunk.toString('utf8', 8); });  // strip docker log framing header (8B)
      logsStream.on('end', resolve);
      logsStream.on('error', resolve);
    });
    const result = await helper.wait();
    return { exitCode: result.StatusCode, output: out };
  } finally {
    try { await helper.remove({ force: true }); } catch { /* helper already gone */ }
  }
}

// ─── Public API ──────────────────────────────────────

/**
 * Install the egress filter into a running container's netns.
 * Idempotent: re-applying replaces the ruleset cleanly.
 */
async function applyToContainer({ containerId, hostId = 0 }) {
  if (!containerId) throw new Error('containerId required');

  const { ip, port } = _sidecarEndpoint();
  const script = _applyScript(ip, port);

  log.info('Applying egress filter', { containerId, hostId, sidecar: `${ip}:${port}` });
  const { exitCode, output } = await _runHelper(containerId, hostId, script);
  if (exitCode !== 0) {
    throw new Error(`Helper exited ${exitCode}: ${output}`);
  }
  log.info('Egress filter applied', { containerId, hostId });
  return { ok: true, output: output.trim() };
}

/**
 * Remove the egress filter from a container. Safe to call when nothing is
 * installed (runs `nft delete table ip ddout || true`).
 */
async function removeFromContainer({ containerId, hostId = 0 }) {
  if (!containerId) throw new Error('containerId required');

  const script = _removeScript();
  log.info('Removing egress filter', { containerId, hostId });
  const { exitCode, output } = await _runHelper(containerId, hostId, script);
  if (exitCode !== 0) {
    throw new Error(`Helper exited ${exitCode}: ${output}`);
  }
  return { ok: true, output: output.trim() };
}

/**
 * Check whether our filter table is currently installed in a container's netns.
 */
async function isApplied({ containerId, hostId = 0 }) {
  if (!containerId) throw new Error('containerId required');

  const script = _inspectScript();
  const { exitCode, output } = await _runHelper(containerId, hostId, script);
  if (exitCode !== 0) {
    throw new Error(`Helper exited ${exitCode}: ${output}`);
  }
  // Check for NOT_APPLIED first — "APPLIED" is a substring of it.
  const applied = !/NOT_APPLIED/.test(output) && /\bAPPLIED\b/.test(output);
  return { applied, details: output.trim() };
}

// ─── Stack scope (v6.7.0-alpha.4) ────────────────────
//
// A compose "stack" is a set of containers sharing the
// `com.docker.compose.project` label. The runner iterates containers,
// applies/removes the filter per container, and aggregates results.
//
// Transactional semantics on apply: if ANY container fails canApplyFilter
// precondition, the whole stack apply aborts WITHOUT touching any container.
// If a helper fails mid-stream (docker error, rule-install failure), we
// roll back the successful installs so the stack ends up in a consistent
// pre-apply state.

async function _listStackContainers({ stackName, hostId = 0 }) {
  const docker = dockerService.getDocker(hostId || 0);
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`com.docker.compose.project=${stackName}`] }),
  });
  return containers.map((c) => ({
    id: c.Id,
    name: (c.Names && c.Names[0] || '').replace(/^\//, ''),
    service: (c.Labels || {})['com.docker.compose.service'] || null,
    state: c.State,
  }));
}

/**
 * Apply the egress filter to every container in a compose stack.
 * Transactional: on partial failure, rolls back the ones that succeeded.
 * Returns { applied: [{id, name}], skipped: [{id, reason}], failed: [{id, error}] }.
 */
async function applyToStack({ stackName, hostId = 0 }) {
  if (!stackName) throw new Error('stackName required');

  const containers = await _listStackContainers({ stackName, hostId });
  if (containers.length === 0) {
    throw new Error(`No containers found for stack "${stackName}"`);
  }

  // Precondition check: refuse the WHOLE stack if any container can't be filtered.
  // We inspect serially — small N (typical stack has 3-10 services).
  const canApplyFilter = require('./egress-filter').canApplyFilter;
  const docker = dockerService.getDocker(hostId || 0);
  const skipped = [];
  const eligible = [];
  for (const c of containers) {
    if (c.state !== 'running') {
      skipped.push({ id: c.id, name: c.name, reason: `container is ${c.state}` });
      continue;
    }
    try {
      const inspect = await docker.getContainer(c.id).inspect();
      const precheck = canApplyFilter(inspect);
      if (!precheck.ok) {
        throw new Error(precheck.reason);
      }
      eligible.push(c);
    } catch (e) {
      throw new Error(`Stack apply aborted — container ${c.name} (${c.id.slice(0, 12)}) failed precheck: ${e.message}`);
    }
  }

  if (eligible.length === 0) {
    return { applied: [], skipped, failed: [], stack: stackName };
  }

  log.info('Applying egress filter to stack', { stackName, eligibleCount: eligible.length, skippedCount: skipped.length });

  // Apply in order; track successes so we can rollback on failure.
  const applied = [];
  const failed = [];
  for (const c of eligible) {
    try {
      await applyToContainer({ containerId: c.id, hostId });
      applied.push({ id: c.id, name: c.name });
    } catch (e) {
      failed.push({ id: c.id, name: c.name, error: e.message });
      // Roll back everything applied so far
      log.warn('Stack apply failed — rolling back', { stackName, successCount: applied.length, failedAt: c.name });
      for (const succ of applied) {
        try {
          await removeFromContainer({ containerId: succ.id, hostId });
        } catch (rollbackErr) {
          log.error('Rollback failed for container', { stackName, id: succ.id, error: rollbackErr.message });
        }
      }
      throw new Error(`Stack apply failed at ${c.name}: ${e.message}. Rolled back ${applied.length} already-applied container(s).`);
    }
  }

  log.info('Stack apply complete', { stackName, appliedCount: applied.length });
  return { applied, skipped, failed, stack: stackName };
}

/**
 * Remove the egress filter from every container in a compose stack.
 * Best-effort: collects per-container errors and reports them, doesn't abort.
 */
async function removeFromStack({ stackName, hostId = 0 }) {
  if (!stackName) throw new Error('stackName required');

  const containers = await _listStackContainers({ stackName, hostId });
  if (containers.length === 0) {
    return { removed: [], failed: [], stack: stackName };
  }

  const removed = [];
  const failed = [];
  for (const c of containers) {
    if (c.state !== 'running') continue;  // no netns to clean
    try {
      await removeFromContainer({ containerId: c.id, hostId });
      removed.push({ id: c.id, name: c.name });
    } catch (e) {
      failed.push({ id: c.id, name: c.name, error: e.message });
    }
  }

  log.info('Stack remove complete', { stackName, removedCount: removed.length, failedCount: failed.length });
  return { removed, failed, stack: stackName };
}

/**
 * Report per-container applied state across a stack.
 */
async function statusOfStack({ stackName, hostId = 0 }) {
  if (!stackName) throw new Error('stackName required');

  const containers = await _listStackContainers({ stackName, hostId });
  const results = [];
  for (const c of containers) {
    if (c.state !== 'running') {
      results.push({ id: c.id, name: c.name, state: c.state, applied: false, skipped: true });
      continue;
    }
    try {
      const { applied } = await isApplied({ containerId: c.id, hostId });
      results.push({ id: c.id, name: c.name, state: c.state, applied });
    } catch (e) {
      results.push({ id: c.id, name: c.name, state: c.state, applied: false, error: e.message });
    }
  }
  const appliedCount = results.filter((r) => r.applied).length;
  return { stack: stackName, containers: results, appliedCount, totalCount: results.length };
}

module.exports = {
  applyToContainer,
  removeFromContainer,
  isApplied,
  applyToStack,
  removeFromStack,
  statusOfStack,
  _internals: { _applyScript, _removeScript, _inspectScript, _sidecarEndpoint, _listStackContainers, HELPER_IMAGE },
};
