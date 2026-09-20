'use strict';

// v8.95.0 — Isolation posture. Assesses how far a single container can reach
// past its runtime, and whether the runtime backing it actually contains that
// reach.
//
// Origin: the "Solaris Zones give full isolation, LXC shares the host kernel"
// argument from the SmartOS article. Docker Dash detects alternative OCI runtimes
// at the HOST level (docker.js → getInfo → runtimeCategories); this is the
// per-container half, without which "you have Kata installed" is not actionable.
//
// DELIBERATELY NOT A DUPLICATE OF THE CIS BENCHMARK. cis-benchmark.js already
// reports "this container is privileged" / "CapAdd=ALL" / "PidMode=host" as
// standalone failures. Here those same switches are *inputs*, not findings: they
// establish that a container has host-level reach, which is what makes running
// it under a weaker runtime worth flagging. CIS says the door is open; this says
// you own a lock and haven't used it.
//
// v8.95.0 replaced a `sandboxed` boolean with an ORDERED class. The boolean was
// the bug: a Wasm runtime is not in `runtimeCategories.sandboxed`, so a Wasm
// container fell through to "not sandboxed" — reported as SHARED KERNEL, and on a
// host that also had gVisor it produced advice to move a Wasm workload onto
// gVisor, which is a downgrade. With an ordering, "should this move?" is a
// comparison rather than a special case, and the next runtime category added
// cannot repeat the mistake.
//
// This module is PURE. No DB, no Docker API, no fs.

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// Ordered strongest-first. Wasm outranks sandboxed because a module has no
// syscall surface at all: it cannot fork, ptrace or open a raw socket, and its
// filesystem/network access must be granted explicitly through WASI. A sandboxed
// runtime still presents a (much reduced) kernel ABI.
const CLASS_RANK = { wasm: 3, sandboxed: 2, standard: 1, unknown: 0 };

// Classes an operator can move an EXISTING workload to by changing how it runs.
// Wasm is deliberately absent: it needs a `.wasm` artifact, not a flag, so
// offering it as an "upgrade" for a Linux container would be advice nobody can
// act on. It still counts as stronger for ranking — it just is not an option.
const REACHABLE_BY_FLAG = ['sandboxed'];

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
 * Which isolation class a runtime name belongs to, given the host's categories.
 * Classification lives in docker.js `_categorizeRuntimes`; this only reads the
 * result, so the runtime taxonomy stays in exactly one place.
 */
function classify(runtime, categories) {
  if (!runtime) return 'unknown';
  if ((categories.wasm || []).includes(runtime)) return 'wasm';
  if ((categories.sandboxed || []).includes(runtime)) return 'sandboxed';
  return 'standard';
}

/**
 * Assess one container's isolation.
 *
 * @param {object} container `{ isolation, mounts }` from inspectContainer
 * @param {object} [hostRuntimes]
 * @param {string[]} [hostRuntimes.sandboxed] sandboxed runtimes registered on the host
 * @param {string[]} [hostRuntimes.wasm]      wasm runtimes registered on the host
 * @param {string}   [hostRuntimes.default]   the daemon's default runtime
 */
function assess(container, hostRuntimes) {
  const c = container && typeof container === 'object' ? container : {};
  const hr = hostRuntimes && typeof hostRuntimes === 'object' ? hostRuntimes : {};
  const categories = {
    sandboxed: (Array.isArray(hr.sandboxed) ? hr.sandboxed : []).filter(Boolean),
    wasm: (Array.isArray(hr.wasm) ? hr.wasm : []).filter(Boolean),
  };

  // An empty HostConfig.Runtime means "the daemon default", not "unknown".
  const declared = _norm(c.isolation && c.isolation.runtime);
  const runtime = declared || _norm(hr.default) || null;

  const isolationClass = classify(runtime, categories);
  const classRank = CLASS_RANK[isolationClass];

  // Classes present on this host that outrank the container's — informational.
  const strongerAvailable = Object.keys(CLASS_RANK)
    .filter(cls => CLASS_RANK[cls] > classRank)
    .filter(cls => (categories[cls] || []).length > 0)
    .sort((a, b) => CLASS_RANK[b] - CLASS_RANK[a]);

  // Of those, the ones an operator can actually switch to without rebuilding the
  // workload. This is what a finding may recommend.
  const upgradeOptions = strongerAvailable.includes('sandboxed') && REACHABLE_BY_FLAG.includes('sandboxed')
    ? categories.sandboxed.slice()
    : [];

  const signals = reachSignals(c.isolation, c.mounts);

  let severity = null;
  for (const s of signals) {
    if (!severity || (SEV_RANK[s.severity] || 0) > (SEV_RANK[severity] || 0)) severity = s.severity;
  }

  return {
    runtime,
    isolationClass,
    classRank,
    strongerAvailable,
    upgradeOptions,
    // Retained so existing callers and the v8.94.0 UI keep working. Derived, not
    // authoritative — `isolationClass` is.
    sandboxed: isolationClass === 'sandboxed',
    sandboxAvailable: categories.sandboxed.length > 0,
    sandboxOptions: categories.sandboxed.slice(),
    wasmAvailable: categories.wasm.length > 0,
    signals,
    severity,
    // Worth raising only when the container has host-level reach AND there is a
    // stronger class it can actually be moved to. A Wasm container has nothing
    // above it, so it can never produce a finding — not by special-casing Wasm,
    // but because nothing outranks it.
    actionable: signals.length > 0 && upgradeOptions.length > 0,
  };
}

module.exports = {
  assess, reachSignals, classify,
  _internals: { CAP_RISK, DOCKER_SOCKET, SEV_RANK, CLASS_RANK, REACHABLE_BY_FLAG },
};
