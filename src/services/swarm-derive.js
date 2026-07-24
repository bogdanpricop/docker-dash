'use strict';

// Derive a proposed Swarm *service* spec from a standalone container's
// `docker inspect` output. This is the (a)-bridge of the deploy-to-swarm
// feature: it does NOT create anything — it translates what it safely can
// from a single-host container into a cluster-wide service spec, and
// returns human-readable warnings for everything that doesn't map cleanly.
//
// Kept as a pure function (inspect in → { spec, warnings } out) so it is
// trivially unit-testable without a live Docker daemon.

// Compose/stack bookkeeping labels — stripped from the derived service so
// the promoted service doesn't masquerade as part of the original project.
const INTERNAL_LABEL_PREFIXES = ['com.docker.compose.', 'com.docker.stack.'];

/** Sanitize a container name into a valid Swarm service name. */
function sanitizeName(raw) {
  const base = String(raw || '').replace(/^\//, '');
  if (!base) return 'service';
  // Swarm service names must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}
  let name = base.replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (!/^[a-zA-Z0-9]/.test(name)) name = `svc_${name}`;
  name = name.slice(0, 63);
  return name || 'service';
}

/**
 * Map a Docker container HostConfig.RestartPolicy to a simplified Swarm
 * restart-policy shape ({ condition, maxAttempts? }). The route folds this
 * into the dockerode TaskTemplate.RestartPolicy on create.
 */
function mapRestartPolicy(rp) {
  const name = (rp && rp.Name) || '';
  if (name === 'always' || name === 'unless-stopped') {
    return { condition: 'any' };
  }
  if (name === 'on-failure') {
    return { condition: 'on-failure', maxAttempts: (rp && rp.MaximumRetryCount) || 0 };
  }
  // '' or 'no' → don't restart automatically.
  return { condition: 'none' };
}

/** Derive published ports (host-bound only) → [{ published, target, protocol }]. */
function derivePorts(inspect) {
  const out = [];
  const seen = new Set();
  const pb = (inspect.HostConfig && inspect.HostConfig.PortBindings) || {};
  const nsp = (inspect.NetworkSettings && inspect.NetworkSettings.Ports) || {};
  // Prefer explicit host bindings; fall back to NetworkSettings.Ports.
  const source = Object.keys(pb).length ? pb : nsp;
  for (const [portProto, bindings] of Object.entries(source)) {
    if (!Array.isArray(bindings) || bindings.length === 0) continue; // exposed-only, not published
    const [tPort, proto] = String(portProto).split('/');
    const target = parseInt(tPort, 10);
    if (!target) continue;
    for (const b of bindings) {
      const published = parseInt(b && b.HostPort, 10);
      if (!published) continue;
      const key = `${published}/${proto || 'tcp'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ published, target, protocol: proto || 'tcp' });
    }
  }
  return out;
}

/**
 * @param {object} inspect  raw `docker inspect` output for one container
 * @returns {{ spec: object, warnings: string[] }}
 */
function deriveServiceSpecFromInspect(inspect) {
  if (!inspect || typeof inspect !== 'object') {
    throw new Error('deriveServiceSpecFromInspect: an inspect object is required');
  }
  const config = inspect.Config || {};
  const hostConfig = inspect.HostConfig || {};
  const warnings = [];

  // Labels — strip compose/stack internal bookkeeping.
  const labels = {};
  for (const [k, v] of Object.entries(config.Labels || {})) {
    if (INTERNAL_LABEL_PREFIXES.some(p => k.startsWith(p))) continue;
    labels[k] = v;
  }

  const ports = derivePorts(inspect);
  const restartPolicy = mapRestartPolicy(hostConfig.RestartPolicy);

  const spec = {
    name: sanitizeName(inspect.Name),
    image: config.Image || '',
    replicas: 1,
    env: Array.isArray(config.Env) ? config.Env.slice() : [],
    command: (Array.isArray(config.Cmd) && config.Cmd.length) ? config.Cmd.slice() : null,
    ports,
    labels,
    restartPolicy,
  };

  // ── Warnings — things that don't cleanly convert ────────────────

  // Bind mounts (from HostConfig.Binds and/or Mounts of type bind).
  const binds = Array.isArray(hostConfig.Binds) ? hostConfig.Binds : [];
  const bindMounts = (Array.isArray(inspect.Mounts) ? inspect.Mounts : [])
    .filter(m => m && m.Type === 'bind');
  const bindPaths = [
    ...binds.map(b => String(b).split(':')[0]),
    ...bindMounts.map(m => m.Source),
  ].filter(Boolean);
  if (bindPaths.length) {
    warnings.push(`Bind mounts detected (${[...new Set(bindPaths)].join(', ')}). Bind-mounted host paths do not travel with a Swarm service — these paths must exist on ALL swarm nodes that could run a task, or the task will fail to start.`);
  }

  // Named volumes are node-local unless a cluster-aware driver is used.
  const namedVolumes = (Array.isArray(inspect.Mounts) ? inspect.Mounts : [])
    .filter(m => m && m.Type === 'volume').map(m => m.Name).filter(Boolean);
  if (namedVolumes.length) {
    warnings.push(`Named volumes (${[...new Set(namedVolumes)].join(', ')}) are node-local by default — on a multi-node swarm each node gets its own empty copy unless you use a cluster-aware volume driver.`);
  }

  // Interactive containers (-it / tty / stdin).
  if (config.Tty || config.OpenStdin) {
    warnings.push('This container was started interactively (-it / tty / stdin). Interactive containers aren\'t supported as Swarm services — the service will run detached.');
  }

  // network_mode host / container:<id>.
  const nm = hostConfig.NetworkMode || '';
  if (nm === 'host' || String(nm).startsWith('container:')) {
    warnings.push(`network_mode "${nm}" isn't supported for Swarm services — the service will attach to the default overlay/ingress network instead.`);
  }

  // Privileged.
  if (hostConfig.Privileged) {
    warnings.push('--privileged isn\'t honored by Swarm services — the promoted service will run unprivileged.');
  }

  // Device mappings.
  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length) {
    warnings.push('Device mappings (--device) aren\'t supported by Swarm services and were dropped from the derived spec.');
  }

  // Legacy container links.
  if (Array.isArray(hostConfig.Links) && hostConfig.Links.length) {
    warnings.push('Legacy container links (--link) aren\'t supported by Swarm — use an overlay network and service discovery instead.');
  }

  // Entrypoint override — Swarm's ContainerSpec.Command replaces the image
  // entrypoint, so the operator may need to fold it in.
  if (Array.isArray(config.Entrypoint) && config.Entrypoint.length) {
    warnings.push(`This container overrides the image ENTRYPOINT (${config.Entrypoint.join(' ')}). Review the Command field — Swarm's ContainerSpec.Command replaces the image entrypoint, so you may need to fold the entrypoint into it.`);
  }

  // Published ports become ingress / routing-mesh ports.
  if (ports.length) {
    warnings.push('Published ports become Swarm ingress ports (routing mesh) — they\'ll be reachable on every node\'s IP and load-balanced across replicas.');
  }

  return { spec, warnings };
}

// ════════════════════════════════════════════════════════════════
// Reverse direction: swarm stack → compose YAML object
// ════════════════════════════════════════════════════════════════
//
// Given the running swarm services that belong to one stack (same
// com.docker.stack.namespace label), reconstruct a compose-style object that
// the existing "Deploy Stack from YAML" flow could re-consume. This is the
// inverse of the POST /stacks/:name deploy mapping and deliberately mirrors
// exactly the fields that flow supports — nothing more — so a round-trip
// (export → redeploy) is faithful for the supported surface. Anything that
// doesn't round-trip (volumes, secrets, configs, custom networks,
// healthchecks) is reported in `notes` instead of being silently dropped.
//
// Pure function (service list in → { services, notes } out): the route wraps
// it with a header comment and YAML.stringify.

/** Strip compose/stack bookkeeping labels; return a plain {k:v} object. */
function cleanServiceLabels(labels) {
  const out = {};
  for (const [k, v] of Object.entries(labels || {})) {
    if (INTERNAL_LABEL_PREFIXES.some(p => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

/** Derive "published:target[/proto]" port strings from a service's endpoint. */
function derivePublishedPorts(svc) {
  const spec = svc.Spec || {};
  const list = (svc.Endpoint && Array.isArray(svc.Endpoint.Ports) && svc.Endpoint.Ports)
    || (spec.EndpointSpec && Array.isArray(spec.EndpointSpec.Ports) && spec.EndpointSpec.Ports)
    || [];
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!p || !p.PublishedPort || !p.TargetPort) continue; // internal-only, skip
    const proto = (p.Protocol && p.Protocol !== 'tcp') ? `/${p.Protocol}` : '';
    const s = `${p.PublishedPort}:${p.TargetPort}${proto}`;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {object[]} serviceInspects  services from listServices() in this stack
 * @param {string}   stackName        namespace to strip from "<stack>_<svc>" names
 *                                     (pass '' for the synthetic _standalone bucket)
 * @returns {{ services: object, notes: string[] }}
 */
function deriveComposeFromStackServices(serviceInspects, stackName) {
  if (!Array.isArray(serviceInspects)) {
    throw new Error('deriveComposeFromStackServices: an array of services is required');
  }
  const notes = [];
  const services = {};

  for (const svc of serviceInspects) {
    const spec = svc.Spec || {};
    const fullName = spec.Name || svc.ID || 'service';
    const key = (stackName && fullName.startsWith(stackName + '_'))
      ? fullName.slice(stackName.length + 1)
      : fullName;

    const tt = spec.TaskTemplate || {};
    const cs = tt.ContainerSpec || {};
    const out = {};

    // image (strip a pinned @sha256 digest so the YAML stays human-editable)
    out.image = String(cs.Image || '').replace(/@sha256:[a-f0-9]+$/i, '');

    // command: compose `command:` lands in ContainerSpec.Args on a real stack
    // deploy; this app's own deploy path uses Command. Prefer Args, fall back
    // to Command so both round-trip.
    const cmd = (Array.isArray(cs.Args) && cs.Args.length) ? cs.Args
      : (Array.isArray(cs.Command) && cs.Command.length) ? cs.Command : null;
    if (cmd) out.command = cmd.slice();

    if (Array.isArray(cs.Env) && cs.Env.length) out.environment = cs.Env.slice();

    const ports = derivePublishedPorts(svc);
    if (ports.length) out.ports = ports;

    const labels = cleanServiceLabels({ ...(cs.Labels || {}), ...(spec.Labels || {}) });
    if (Object.keys(labels).length) out.labels = labels;

    // deploy: mode/replicas, restart_policy (only when non-default), placement
    const deploy = {};
    const mode = spec.Mode || {};
    if (mode.Global) {
      deploy.mode = 'global';
    } else {
      deploy.replicas = (mode.Replicated && typeof mode.Replicated.Replicas === 'number')
        ? mode.Replicated.Replicas : 1;
    }
    const rp = tt.RestartPolicy;
    if (rp) {
      const cond = rp.Condition || 'any';
      const delaySec = (typeof rp.Delay === 'number') ? Math.round(rp.Delay / 1e9) : undefined;
      const maxAtt = rp.MaxAttempts || 0;
      // The deploy default is { any, 5s, 0 } — only emit when it differs.
      if (cond !== 'any' || maxAtt !== 0 || (delaySec !== undefined && delaySec !== 5)) {
        deploy.restart_policy = { condition: cond };
        if (delaySec !== undefined) deploy.restart_policy.delay = `${delaySec}s`;
        if (maxAtt) deploy.restart_policy.max_attempts = maxAtt;
      }
    }
    const constraints = tt.Placement && Array.isArray(tt.Placement.Constraints)
      ? tt.Placement.Constraints : [];
    if (constraints.length) deploy.placement = { constraints: constraints.slice() };
    if (Object.keys(deploy).length) out.deploy = deploy;

    // Notes for things the deploy flow can't round-trip.
    if (Array.isArray(cs.Mounts) && cs.Mounts.length) {
      notes.push(`${key}: has ${cs.Mounts.length} mount(s) (volumes/binds) — not included in the exported YAML; re-add them by hand if needed.`);
    }
    if (Array.isArray(tt.Networks) && tt.Networks.length) {
      notes.push(`${key}: attached to custom network(s) — not exported (redeployed services join the default network).`);
    }
    if (Array.isArray(cs.Secrets) && cs.Secrets.length) notes.push(`${key}: uses secrets — not exported.`);
    if (Array.isArray(cs.Configs) && cs.Configs.length) notes.push(`${key}: uses configs — not exported.`);
    if (cs.Healthcheck) notes.push(`${key}: has a healthcheck — not exported.`);

    services[key] = out;
  }

  return { services, notes };
}

module.exports = {
  deriveServiceSpecFromInspect,
  sanitizeName,
  mapRestartPolicy,
  derivePorts,
  deriveComposeFromStackServices,
  derivePublishedPorts,
  cleanServiceLabels,
};
