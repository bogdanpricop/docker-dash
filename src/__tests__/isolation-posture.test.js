'use strict';

// v8.94.0 — isolation posture assessment tests.
//
// The load-bearing behaviour is `actionable`: it is what decides whether an
// operator gets a posture finding or silence. Its three-way gate (has reach,
// not already sandboxed, sandbox installed) gets the most coverage here.

const { assess, reachSignals } = require('../services/isolation-posture');

const HOST_WITH_SANDBOX = { sandboxed: ['runsc'], default: 'runc' };
const HOST_WITHOUT = { sandboxed: [], default: 'runc' };

const container = (isolation = {}, mounts = []) => ({ isolation, mounts });

describe('isolation-posture — reachSignals', () => {
  it('finds nothing on a plain container', () => {
    expect(reachSignals({ capAdd: [], securityOpt: [] }, [])).toEqual([]);
  });

  it('flags privileged as critical', () => {
    const s = reachSignals({ privileged: true }, []);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'privileged', severity: 'critical' });
  });

  it('does not re-list capabilities when already privileged', () => {
    // Privileged implies every capability — enumerating them again is noise.
    const s = reachSignals({ privileged: true, capAdd: ['SYS_ADMIN', 'NET_ADMIN'] }, []);
    expect(s.map(x => x.id)).toEqual(['privileged']);
  });

  it('flags a docker socket mount once, however many times it is mounted', () => {
    const s = reachSignals({}, [
      { Source: '/var/run/docker.sock' },
      { Source: '/run/docker.sock' },
    ]);
    expect(s.filter(x => x.id === 'docker-socket')).toHaveLength(1);
  });

  it('accepts either mount key casing', () => {
    expect(reachSignals({}, [{ source: '/var/run/docker.sock' }])[0].id).toBe('docker-socket');
  });

  it('does not mistake a lookalike path for the socket', () => {
    expect(reachSignals({}, [{ Source: '/data/not-docker.sock.bak' }])).toEqual([]);
    expect(reachSignals({}, [{ Source: '/data/dockerXsock' }])).toEqual([]);
  });

  it('normalises capability spelling', () => {
    for (const cap of ['SYS_ADMIN', 'cap_sys_admin', 'CAP_SYS_ADMIN', ' sys_admin ']) {
      expect(reachSignals({ capAdd: [cap] }, [])[0].id).toBe('cap-sys-admin');
    }
  });

  it('deduplicates a repeated capability', () => {
    const s = reachSignals({ capAdd: ['SYS_ADMIN', 'CAP_SYS_ADMIN'] }, []);
    expect(s).toHaveLength(1);
  });

  it('ignores capabilities that do not change the isolation answer', () => {
    expect(reachSignals({ capAdd: ['CHOWN', 'SETUID', 'NET_BIND_SERVICE'] }, [])).toEqual([]);
  });

  it('flags host namespace sharing but not container-joined namespaces', () => {
    expect(reachSignals({ pidMode: 'host' }, [])[0].id).toBe('pid-host');
    expect(reachSignals({ pidMode: 'container:abc123' }, [])).toEqual([]);
    expect(reachSignals({ networkMode: 'host' }, [])[0].id).toBe('network-host');
    expect(reachSignals({ networkMode: 'bridge' }, [])).toEqual([]);
    expect(reachSignals({ ipcMode: 'host' }, [])[0].id).toBe('ipc-host');
  });

  it('flags disabled mandatory access control', () => {
    expect(reachSignals({ securityOpt: ['seccomp=unconfined'] }, [])[0].id).toBe('seccomp-unconfined');
    expect(reachSignals({ securityOpt: ['apparmor=unconfined'] }, [])[0].id).toBe('apparmor-unconfined');
    expect(reachSignals({ securityOpt: ['label=disable'] }, [])[0].id).toBe('selinux-disabled');
  });

  it('leaves a normal seccomp profile alone', () => {
    expect(reachSignals({ securityOpt: ['seccomp=/etc/docker/profile.json', 'no-new-privileges'] }, [])).toEqual([]);
  });

  it('tolerates missing and malformed input', () => {
    expect(reachSignals(undefined, undefined)).toEqual([]);
    expect(reachSignals(null, null)).toEqual([]);
    expect(reachSignals({ capAdd: 'not-an-array', securityOpt: 5 }, 'nope')).toEqual([]);
  });
});

describe('isolation-posture — runtime resolution', () => {
  it('resolves an empty runtime to the daemon default', () => {
    expect(assess(container({ runtime: '' }), HOST_WITHOUT).runtime).toBe('runc');
  });

  it('prefers the explicitly declared runtime', () => {
    expect(assess(container({ runtime: 'runsc' }), HOST_WITH_SANDBOX).runtime).toBe('runsc');
  });

  it('reports sandboxed only when the runtime is one the host registered as such', () => {
    expect(assess(container({ runtime: 'runsc' }), HOST_WITH_SANDBOX).sandboxed).toBe(true);
    expect(assess(container({ runtime: 'runc' }), HOST_WITH_SANDBOX).sandboxed).toBe(false);
    // Same runtime name, but this host never registered it — not sandboxed here.
    expect(assess(container({ runtime: 'runsc' }), HOST_WITHOUT).sandboxed).toBe(false);
  });

  it('returns a null runtime when neither container nor host declares one', () => {
    expect(assess(container({}), {}).runtime).toBeNull();
  });
});

describe('isolation-posture — actionable gate', () => {
  const risky = { privileged: true };

  it('is actionable: reach + shared kernel + a sandbox available', () => {
    const r = assess(container(risky), HOST_WITH_SANDBOX);
    expect(r.actionable).toBe(true);
    expect(r.severity).toBe('critical');
    expect(r.sandboxOptions).toEqual(['runsc']);
  });

  it('is silent when no sandboxed runtime is installed', () => {
    // We do not nag operators about software they have not installed — CIS
    // already flags the privileged container itself.
    const r = assess(container(risky), HOST_WITHOUT);
    expect(r.actionable).toBe(false);
    expect(r.sandboxAvailable).toBe(false);
    expect(r.signals).toHaveLength(1); // the reach is still reported
  });

  it('is silent when the container already runs sandboxed', () => {
    const r = assess(container({ ...risky, runtime: 'runsc' }), HOST_WITH_SANDBOX);
    expect(r.actionable).toBe(false);
    expect(r.sandboxed).toBe(true);
  });

  it('is silent for a container with no host-level reach', () => {
    const r = assess(container({ runtime: 'runc' }), HOST_WITH_SANDBOX);
    expect(r.actionable).toBe(false);
    expect(r.severity).toBeNull();
  });
});

describe('isolation-posture — severity', () => {
  it('takes the highest severity among the signals', () => {
    const r = assess(container({ networkMode: 'host', capAdd: ['SYS_MODULE'] }), HOST_WITH_SANDBOX);
    expect(r.severity).toBe('critical'); // SYS_MODULE outranks network-host
  });

  it('reports medium when only medium signals are present', () => {
    expect(assess(container({ networkMode: 'host' }), HOST_WITH_SANDBOX).severity).toBe('medium');
  });

  it('reports a stable signal order across calls', () => {
    const c = container({ privileged: true, pidMode: 'host', networkMode: 'host' }, []);
    const a = assess(c, HOST_WITH_SANDBOX).signals.map(s => s.id);
    const b = assess(c, HOST_WITH_SANDBOX).signals.map(s => s.id);
    expect(a).toEqual(b);
    expect(a).toEqual(['privileged', 'pid-host', 'network-host']);
  });
});

describe('isolation-posture — robustness', () => {
  it('never throws on absent input', () => {
    expect(() => assess()).not.toThrow();
    expect(() => assess(null, null)).not.toThrow();
    expect(assess().actionable).toBe(false);
  });

  it('ignores empty entries in the sandboxed runtime list', () => {
    const r = assess(container({ privileged: true }), { sandboxed: ['', null], default: 'runc' });
    expect(r.sandboxAvailable).toBe(false);
    expect(r.actionable).toBe(false);
  });
});

// ── v8.95.0 — Wasm as a first-class isolation class ──────────────────────────
//
// The regression these pin: before v8.95.0 `assess` compared the runtime only
// against the sandboxed list, so a Wasm runtime fell through to "not sandboxed".
// A Wasm container was reported as SHARED KERNEL, and on a host that also had
// gVisor it produced a finding telling the operator to move the workload onto
// gVisor — advice to downgrade isolation.

const WASM_RT = 'io.containerd.wasmedge.v1';
const HOST_BOTH = { sandboxed: ['runsc'], wasm: [WASM_RT], default: 'runc' };

describe('isolation-posture — Wasm isolation class', () => {
  it('classifies a Wasm runtime as wasm, not shared kernel', () => {
    const r = assess(container({ runtime: WASM_RT }), HOST_BOTH);
    expect(r.isolationClass).toBe('wasm');
    expect(r.sandboxed).toBe(false);   // derived field: wasm is not "sandboxed"
  });

  it('ranks wasm above sandboxed above standard', () => {
    const rank = c => assess(container({ runtime: c }), HOST_BOTH).classRank;
    expect(rank(WASM_RT)).toBeGreaterThan(rank('runsc'));
    expect(rank('runsc')).toBeGreaterThan(rank('runc'));
  });

  it('never advises moving a Wasm workload anywhere', () => {
    // The exact shape of the old bug: reach signal + a sandboxed runtime present.
    const r = assess(container({ runtime: WASM_RT, networkMode: 'host' }), HOST_BOTH);
    expect(r.signals).toHaveLength(1);
    expect(r.actionable).toBe(false);
    expect(r.upgradeOptions).toEqual([]);
    expect(r.strongerAvailable).toEqual([]);
  });

  it('still flags a standard container when a sandboxed runtime exists', () => {
    const r = assess(container({ runtime: 'runc', privileged: true }), HOST_BOTH);
    expect(r.actionable).toBe(true);
    expect(r.upgradeOptions).toEqual(['runsc']);
  });

  it('does not advise a sandboxed container to move, even though wasm outranks it', () => {
    // Wasm is stronger, but it needs a rebuilt .wasm artifact rather than a flag,
    // so it is reported as stronger-available and never offered as an upgrade.
    const r = assess(container({ runtime: 'runsc', privileged: true }), HOST_BOTH);
    expect(r.strongerAvailable).toEqual(['wasm']);
    expect(r.upgradeOptions).toEqual([]);
    expect(r.actionable).toBe(false);
  });

  it('never offers wasm as an upgrade option to a standard container', () => {
    const r = assess(container({ runtime: 'runc', privileged: true }), HOST_BOTH);
    expect(r.upgradeOptions).not.toContain(WASM_RT);
  });

  it('reports wasm availability on the host independently of the container', () => {
    const r = assess(container({ runtime: 'runc' }), HOST_BOTH);
    expect(r.wasmAvailable).toBe(true);
  });

  it('treats a wasm default runtime as wasm for containers that inherit it', () => {
    const r = assess(container({ runtime: '' }), { sandboxed: [], wasm: [WASM_RT], default: WASM_RT });
    expect(r.isolationClass).toBe('wasm');
  });

  it('classifies an unknown runtime as standard, not unknown', () => {
    expect(assess(container({ runtime: 'some-custom-runtime' }), HOST_BOTH).isolationClass).toBe('standard');
  });

  it('reports unknown only when there is no runtime at all', () => {
    expect(assess(container({}), {}).isolationClass).toBe('unknown');
  });
});
