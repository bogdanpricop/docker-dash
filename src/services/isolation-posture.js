'use strict';

// v8.94.0 — Isolation posture. Assesses how far a single container can reach
// past its runtime, and whether the runtime backing it actually contains that
// reach.
//
// Origin: the "Solaris Zones give full isolation, LXC shares the host kernel"
// argument from the SmartOS article. Docker Dash already detects sandboxed OCI
// runtimes at the HOST level (docker.js → getInfo → runtimeCategories, badged in
// the System page). What was missing is the per-container half: knowing Kata is
// installed is not actionable until you know which containers aren't using it.
//
// DELIBERATELY NOT A DUPLICATE OF THE CIS BENCHMARK. cis-benchmark.js already
// reports "this container is privileged" / "CapAdd=ALL" / "PidMode=host" as
// standalone failures. Here those same switches are *inputs*, not findings: they
// establish that a container has host-level reach, which is what makes running
// it under a shared-kernel runtime worth flagging. CIS says the door is open;
// this says you own a lock and haven't used it.
//
// This module is PURE. No DB, no Docker API, no fs. Input is a plain object,
// output is a plain object.

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// Capabilities that meaningfully extend a container's reach toward the host.
// Not an exhaustive capability list — only the ones whose presence changes the
// isolation answer.
const CAP_RISK = {
  ALL: { severity: 'critical', label: 'All capabilities granted (CapAdd=ALL)' },
  SYS_ADMIN: { severity: 'high', label: 'CAP_SYS_ADMIN — mount, namespace and cgroup control' },
  SYS_MODULE: { severity: 'critical', label: 'CAP_SYS_MODULE — can load kernel modules' },
  SYS_RAWIO: { severity: 'high', label: 'CAP_SYS_RAWIO — raw I/O port and memory access' },
  SYS_PTRACE: { severity: 'medium', label: 'CAP_SYS_PTRACE — can trace other processes' },
  SYS_BOOT: { severity: 'medium', label: 'CAP_SYS_BOOT — can reboot the host' },
  NET_ADMIN: { severity: 'medium', label: 'CAP_NET_ADMIN — full network stack control' },
  DAC_READ_SEARCH: { severity: 'medium', label: 'CAP_DAC_READ_SEARCH — bypasses file read permission checks' },
};

// A bind mount of the daemon socket is root-equivalent on the host, and no OCI
// runtime contains it — worth naming separately from generic mounts.
const DOCKER_SOCKET = /(^|[/\\])docker\.sock$/i;

function _norm(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function _capName(cap) {
  // Docker accepts both `SYS_ADMIN` and `CAP_SYS_ADMIN`, any case.
  return _norm(cap).toUpperCase().replace(/^CAP_/, '');
}

/**
 * Which mode strings count as sharing a host namespace.
 * Docker reports `host` for the host namespace and `container:<id>` when joining
 * another container's — only the former reaches the host.
 */
function _isHost(mode) {
  return _norm(mode).toLowerCase() === 'host';
}

function _securityOptRisks(securityOpt) {
  const out = [];
  for (const raw of Array.isArray(securityOpt) ? securityOpt : []) {
    const opt = _norm(raw).toLowerCase();
    if (opt === 'seccomp=unconfined' || opt === 'seccomp:unconfined') {
      out.push({ id: 'seccomp-unconfined', severity: 'high', label: 'Seccomp disabled (seccomp=unconfined) — the full syscall surface is reachable' });
    }
    if (opt === 'apparmor=unconfined' || opt === 'apparmor:unconfined') {
      out.push({ id: 'apparmor-unconfined', severity: 'high', label: 'AppArmor disabled (apparmor=unconfined)' });
    }
    if (opt.startsWith('label=disable') || opt.startsWith('label:disable')) {
      out.push({ id: 'selinux-disabled', severity: 'medium', label: 'SELinux labelling disabled (label=disable)' });
    }
  }
  return out;
}

/**
 * Enumerate the ways a container can reach past its runtime.
 *
 * Order is stable (declaration order) so findings don't churn between scans.
 *
 * @param {object} isolation the `isolation` block from dockerService.inspectContainer
 * @param {Array}  mounts    the `mounts` array from the same inspect payload
 * @returns {Array<{id: string, severity: string, label: string}>}
 */
function reachSignals(isolation, mounts) {
  const iso = isolation && typeof isolation === 'object' ? isolation : {};
  const out = [];

  if (iso.privileged) {
    out.push({ id: 'privileged', severity: 'critical', label: 'Privileged — every capability plus host device access' });
  }

  for (const m of Array.isArray(mounts) ? mounts : []) {
    const source = _norm(m && (m.Source || m.source));
    if (source && DOCKER_SOCKET.test(source)) {
      out.push({ id: 'docker-socket', severity: 'critical', label: 'Mounts the Docker socket — root-equivalent control of the daemon' });
      break; // one signal is enough; two mounts of the socket is not twice the problem
    }
  }

  // `privileged` already implies every capability — listing them again is noise.
  if (!iso.privileged) {
    const seen = new Set();
    for (const cap of Array.isArray(iso.capAdd) ? iso.capAdd : []) {
      const name = _capName(cap);
      const risk = CAP_RISK[name];
      if (risk && !seen.has(name)) {
        seen.add(name);
        out.push({ id: `cap-${name.toLowerCase().replace(/_/g, '-')}`, severity: risk.severity, label: risk.label });
      }
    }
  }

  if (_isHost(iso.pidMode)) {
    out.push({ id: 'pid-host', severity: 'high', label: 'Shares the host PID namespace — can see and signal host processes' });
  }
  if (_isHost(iso.networkMode)) {
    out.push({ id: 'network-host', severity: 'medium', label: 'Shares the host network namespace — no network isolation' });
  }
  if (_isHost(iso.ipcMode)) {
    out.push({ id: 'ipc-host', severity: 'medium', label: 'Shares the host IPC namespace' });
  }

  out.push(..._securityOptRisks(iso.securityOpt));
  return out;
}

/**
 * Assess one container's isolation.
 *
 * @param {object} container `{ isolation, mounts }` from inspectContainer
 * @param {object} [hostRuntimes]
 * @param {string[]} [hostRuntimes.sandboxed]  sandboxed runtimes registered on the host
 * @param {string}   [hostRuntimes.default]    the daemon's default runtime
 * @returns {{
 *   runtime: string|null, sandboxed: boolean, sandboxAvailable: boolean,
 *   sandboxOptions: string[], signals: Array, severity: string|null, actionable: boolean
 * }}
 */
function assess(container, hostRuntimes) {
  const c = container && typeof container === 'object' ? container : {};
  const hr = hostRuntimes && typeof hostRuntimes === 'object' ? hostRuntimes : {};
  const sandboxOptions = (Array.isArray(hr.sandboxed) ? hr.sandboxed : []).filter(Boolean);

  // An empty HostConfig.Runtime means "the daemon default", not "unknown".
  const declared = _norm(c.isolation && c.isolation.runtime);
  const runtime = declared || _norm(hr.default) || null;

  const sandboxed = !!runtime && sandboxOptions.includes(runtime);
  const signals = reachSignals(c.isolation, c.mounts);

  let severity = null;
  for (const s of signals) {
    if (!severity || (SEV_RANK[s.severity] || 0) > (SEV_RANK[severity] || 0)) severity = s.severity;
  }

  return {
    runtime,
    sandboxed,
    sandboxAvailable: sandboxOptions.length > 0,
    sandboxOptions,
    signals,
    severity,
    // The finding is worth raising only when all three hold: the container has
    // host-level reach, it is NOT already sandboxed, and the operator has a
    // sandboxed runtime installed. Without the third we would be telling people
    // to go install software — which is a different conversation, and one CIS
    // already opens by flagging the privileged container itself.
    actionable: signals.length > 0 && !sandboxed && sandboxOptions.length > 0,
  };
}

module.exports = { assess, reachSignals, _internals: { CAP_RISK, DOCKER_SOCKET, SEV_RANK } };
