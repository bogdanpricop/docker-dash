'use strict';

// v8.94.0 — containers with host-level reach that are NOT using an available
// sandboxed runtime.
//
// The finding exists only where it is one config line away from fixed: the
// operator has already installed Kata / gVisor / Firecracker on this host, and
// a container that can reach past its runtime is still on the shared-kernel
// default. Where no sandboxed runtime is registered, this check stays silent —
// telling people to go install a runtime is a different conversation, and CIS
// already flags the privileged container on its own terms.
//
// That gate is also what makes the check cheap: the per-container inspect loop
// runs only on hosts that have a sandboxed runtime, which is a rare setup. Every
// other host costs one cached `docker info` that other checks share anyway.

const isolationPosture = require('../../isolation-posture');

// Pathological-estate guard. A host with more running containers than this gets
// a truncated assessment rather than an unbounded inspect storm; the omission is
// reported in the finding rather than hidden.
const MAX_CONTAINERS_PER_HOST = 200;

module.exports = {
  id: 'isolation',
  category: 'isolation',
  async run(ctx) {
    const out = [];
    const dockerService = require('../../docker');

    for (const h of ctx.hosts) {
      const dt = h.daemon_type || 'docker';
      if (dt !== 'docker' && dt !== 'podman') continue;

      let info;
      try { info = await ctx.docker.info(h.id); } catch { continue; }
      const categories = (info && info.runtimeCategories) || {};
      const sandboxed = categories.sandboxed || [];
      const wasm = categories.wasm || [];
      // The cost gate is unchanged in effect: a finding can only recommend a
      // class reachable by a flag, which today means a sandboxed runtime. With
      // none registered, nothing on this host can be actionable, so the
      // per-container inspect loop never runs.
      if (!sandboxed.length) continue;

      let containers;
      try { containers = await dockerService.listContainers(h.id); } catch { continue; }
      const running = (containers || []).filter(c => c.state === 'running');
      const examined = running.slice(0, MAX_CONTAINERS_PER_HOST);
      const omitted = running.length - examined.length;

      for (const c of examined) {
        let insp;
        try { insp = await dockerService.inspectContainer(c.id, h.id); }
        catch { continue; } // a container that vanished mid-scan is not a finding
        if (insp && insp.isSelf) continue; // Docker Dash's own reach is a separate conversation

        // Passing `wasm` is what stops a Wasm container being read as
        // shared-kernel and advised onto a weaker runtime.
        const r = isolationPosture.assess(insp, { sandboxed, wasm, default: info.defaultRuntime });
        if (!r.actionable) continue;

        const reasons = r.signals.map(s => s.label);
        const name = c.name || c.shortId || c.id;
        out.push({
          checkId: 'isolation.shared-kernel',
          severity: r.severity === 'critical' ? 'high' : r.severity,
          hostId: h.id,
          subject: `host:${h.id}:container:${name}`,
          title: `${name} has host-level reach on the shared-kernel runtime — ${h.name}`,
          detail: `This container can reach past its runtime (${reasons.length} signal${reasons.length === 1 ? '' : 's'}) but runs under "${r.runtime}", which shares the host kernel. ${h.name} already has the sandboxed runtime${r.upgradeOptions.length === 1 ? '' : 's'} ${r.upgradeOptions.join(', ')} registered — moving this workload onto one contains the reach instead of trusting it.${omitted > 0 ? ` (${omitted} further running containers on this host were not assessed — scan cap.)` : ''}`,
          evidence: `runtime=${r.runtime}; ${reasons.join('; ')}`,
          remediation: {
            type: 'guide',
            label: 'Move to a sandboxed runtime',
            link: '#/containers',
            steps: `Recreate this container with \`--runtime=${r.upgradeOptions[0]}\` (Compose: \`runtime: ${r.upgradeOptions[0]}\` on the service). Verify the workload still starts — Kata and gVisor do not support every syscall or device passthrough, which is why this is guidance and not a one-click fix. If it must stay on the shared kernel, reduce the reach instead: drop the capabilities listed above, or remove the privileged flag / socket mount.`,
          },
        });
      }
    }
    return out;
  },
};
