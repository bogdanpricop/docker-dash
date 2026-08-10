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
