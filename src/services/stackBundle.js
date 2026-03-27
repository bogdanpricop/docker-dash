'use strict';

const dockerService = require('./docker');
const log = require('../utils/logger')('stack-bundle');
const { now } = require('../utils/helpers');

class StackBundleService {
  /**
   * Export a compose stack as a portable bundle.
   * Bundle includes: compose config, env vars, container configs, volume info, network info.
   */
  async exportStack(stackName, hostId = 0) {
    const docker = dockerService.getDocker(hostId);
    const allContainers = await docker.listContainers({ all: true });
    const stackContainers = allContainers.filter(c =>
      c.Labels?.['com.docker.compose.project'] === stackName
    );

    if (stackContainers.length === 0) {
      throw new Error(`No containers found for stack "${stackName}"`);
    }

    // Get compose file if available
    const workingDir = stackContainers[0]?.Labels?.['com.docker.compose.project.working_dir'];
    let composeYaml = null;
    if (workingDir) {
      try {
        const { execSync } = require('child_process');
        // Try reading the compose file
        const configFiles = stackContainers[0]?.Labels?.['com.docker.compose.project.config_files'] || '';
        const mainFile = configFiles.split(',')[0]?.trim();
        if (mainFile) {
          composeYaml = execSync(`cat "${mainFile}" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        }
      } catch {}
    }

    // Inspect each container for full config
    const containers = [];
    const volumes = new Set();
    const networks = new Set();
    const images = new Set();

    for (const c of stackContainers) {
      const inspect = await docker.getContainer(c.Id).inspect();
      const name = inspect.Name.replace(/^\//, '');
      const service = inspect.Config.Labels?.['com.docker.compose.service'] || name;
      images.add(inspect.Config.Image);

      // Collect volumes
      for (const mount of (inspect.Mounts || [])) {
        if (mount.Type === 'volume') volumes.add(mount.Name);
      }

      // Collect networks
      for (const net of Object.keys(inspect.NetworkSettings?.Networks || {})) {
        if (net !== 'bridge' && net !== 'host' && net !== 'none') networks.add(net);
      }

      containers.push({
        service,
        name,
        image: inspect.Config.Image,
        env: inspect.Config.Env || [],
        cmd: inspect.Config.Cmd,
        entrypoint: inspect.Config.Entrypoint,
        workingDir: inspect.Config.WorkingDir,
        hostname: inspect.Config.Hostname,
        user: inspect.Config.User || '',
        exposedPorts: Object.keys(inspect.Config.ExposedPorts || {}),
        portBindings: this._extractPorts(inspect.NetworkSettings?.Ports || {}),
        volumes: (inspect.Mounts || []).map(m => ({
          type: m.Type,
          source: m.Type === 'volume' ? m.Name : m.Source,
          destination: m.Destination,
          readOnly: !m.RW,
        })),
        networks: Object.keys(inspect.NetworkSettings?.Networks || {}),
        restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
        memoryLimit: inspect.HostConfig?.Memory || 0,
        cpuShares: inspect.HostConfig?.CpuShares || 0,
        labels: this._filterLabels(inspect.Config.Labels || {}),
        healthcheck: inspect.Config.Healthcheck || null,
        state: inspect.State.Status,
      });
    }

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      exportedAt: new Date().toISOString(),
      exportedFrom: { hostId, stackName },
      stack: {
        name: stackName,
        workingDir,
        composeYaml,
      },
      containers,
      images: [...images],
      volumes: [...volumes],
      networks: [...networks],
      metadata: {
        containerCount: containers.length,
        totalImages: images.size,
        totalVolumes: volumes.size,
        totalNetworks: networks.size,
      },
    };

    log.info('Stack exported', { stackName, containers: containers.length });
    return bundle;
  }

  /**
   * Export a single container as a bundle.
   */
  async exportContainer(containerId, hostId = 0) {
    const docker = dockerService.getDocker(hostId);
    const inspect = await docker.getContainer(containerId).inspect();
    const name = inspect.Name.replace(/^\//, '');

    const container = {
      service: name,
      name,
      image: inspect.Config.Image,
      env: inspect.Config.Env || [],
      cmd: inspect.Config.Cmd,
      entrypoint: inspect.Config.Entrypoint,
      workingDir: inspect.Config.WorkingDir,
      hostname: inspect.Config.Hostname,
      user: inspect.Config.User || '',
      exposedPorts: Object.keys(inspect.Config.ExposedPorts || {}),
      portBindings: this._extractPorts(inspect.NetworkSettings?.Ports || {}),
      volumes: (inspect.Mounts || []).map(m => ({
        type: m.Type,
        source: m.Type === 'volume' ? m.Name : m.Source,
        destination: m.Destination,
        readOnly: !m.RW,
      })),
      networks: Object.keys(inspect.NetworkSettings?.Networks || {}),
      restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
      memoryLimit: inspect.HostConfig?.Memory || 0,
      cpuShares: inspect.HostConfig?.CpuShares || 0,
      labels: this._filterLabels(inspect.Config.Labels || {}),
      healthcheck: inspect.Config.Healthcheck || null,
      state: inspect.State.Status,
    };

    return {
      format: 'docker-dash-container-bundle',
      version: 2,
      exportedAt: new Date().toISOString(),
      exportedFrom: { hostId, containerName: name },
      containers: [container],
      images: [inspect.Config.Image],
      volumes: container.volumes.filter(v => v.type === 'volume').map(v => v.source),
      networks: container.networks.filter(n => !['bridge', 'host', 'none'].includes(n)),
      metadata: { containerCount: 1 },
    };
  }

  /**
   * Import a bundle onto a host — pull images + create containers.
   */
  async importBundle(bundle, destHostId, { autoStart = true, prefixName = '', onProgress } = {}) {
    if (!bundle.format?.startsWith('docker-dash-')) {
      throw new Error('Invalid bundle format. Expected docker-dash-stack-bundle or docker-dash-container-bundle.');
    }

    const docker = dockerService.getDocker(destHostId);
    const progress = (msg) => {
      log.info(`Import: ${msg}`);
      if (onProgress) onProgress(msg);
    };

    const results = [];

    // Step 1: Pull all images
    for (const image of (bundle.images || [])) {
      progress(`Pulling ${image}...`);
      try {
        await new Promise((resolve, reject) => {
          docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
          });
        });
      } catch (err) {
        progress(`Warning: Failed to pull ${image}: ${err.message}`);
      }
    }

    // Step 2: Create volumes
    for (const vol of (bundle.volumes || [])) {
      try {
        await docker.createVolume({ Name: vol });
        progress(`Volume "${vol}" created`);
      } catch {
        progress(`Volume "${vol}" already exists (reusing)`);
      }
    }

    // Step 3: Create and optionally start containers
    const existingContainers = await docker.listContainers({ all: true });
    const existingNames = existingContainers.map(c => c.Names?.[0]?.replace(/^\//, ''));

    for (const c of (bundle.containers || [])) {
      const baseName = prefixName ? `${prefixName}-${c.name}` : c.name;
      const finalName = existingNames.includes(baseName) ? `${baseName}-${Date.now().toString(36)}` : baseName;

      progress(`Creating ${finalName}...`);

      try {
        const createOpts = {
          name: finalName,
          Image: c.image,
          Cmd: c.cmd,
          Env: c.env,
          Entrypoint: c.entrypoint,
          WorkingDir: c.workingDir || undefined,
          Hostname: c.hostname || undefined,
          User: c.user || undefined,
          ExposedPorts: c.exposedPorts?.reduce((acc, p) => { acc[p] = {}; return acc; }, {}) || undefined,
          Labels: {
            ...(c.labels || {}),
            'docker-dash.imported-at': new Date().toISOString(),
            'docker-dash.imported-from': JSON.stringify(bundle.exportedFrom || {}),
          },
          Healthcheck: c.healthcheck || undefined,
          HostConfig: {
            PortBindings: this._buildPortBindings(c.portBindings),
            Binds: c.volumes?.filter(v => v.type === 'volume' || v.type === 'bind').map(v =>
              `${v.source}:${v.destination}${v.readOnly ? ':ro' : ''}`
            ) || [],
            RestartPolicy: { Name: c.restartPolicy || 'no' },
            Memory: c.memoryLimit || 0,
            CpuShares: c.cpuShares || 0,
          },
        };

        const newContainer = await docker.createContainer(createOpts);

        if (autoStart) {
          await newContainer.start();
          progress(`${finalName} started`);
        }

        results.push({ name: finalName, originalName: c.name, id: newContainer.id, status: 'created', started: autoStart });
      } catch (err) {
        results.push({ name: finalName, originalName: c.name, status: 'failed', error: err.message });
        progress(`Failed to create ${finalName}: ${err.message}`);
      }
    }

    return {
      ok: true,
      importedAt: new Date().toISOString(),
      destHostId,
      containers: results,
      succeeded: results.filter(r => r.status === 'created').length,
      failed: results.filter(r => r.status === 'failed').length,
    };
  }

  /**
   * Generate a compose YAML from a bundle (for manual deployment).
   */
  generateCompose(bundle) {
    if (bundle.stack?.composeYaml) return bundle.stack.composeYaml;

    // Generate compose from container configs
    let yaml = 'services:\n';
    for (const c of (bundle.containers || [])) {
      const svc = c.service || c.name;
      yaml += `  ${svc}:\n`;
      yaml += `    image: ${c.image}\n`;
      if (c.cmd) yaml += `    command: ${JSON.stringify(c.cmd)}\n`;
      if (c.env?.length) {
        yaml += `    environment:\n`;
        for (const e of c.env) {
          const eq = e.indexOf('=');
          if (eq > 0) yaml += `      - ${e}\n`;
        }
      }
      if (c.portBindings?.length) {
        yaml += `    ports:\n`;
        for (const p of c.portBindings) yaml += `      - "${p.host}:${p.container}/${p.protocol || 'tcp'}"\n`;
      }
      if (c.volumes?.length) {
        yaml += `    volumes:\n`;
        for (const v of c.volumes) yaml += `      - ${v.source}:${v.destination}${v.readOnly ? ':ro' : ''}\n`;
      }
      if (c.restartPolicy && c.restartPolicy !== 'no') yaml += `    restart: ${c.restartPolicy}\n`;
      yaml += '\n';
    }

    if (bundle.volumes?.length) {
      yaml += 'volumes:\n';
      for (const v of bundle.volumes) yaml += `  ${v}:\n`;
    }

    return yaml;
  }

  // ─── Helpers ──────────────────────────────────────

  _extractPorts(portsObj) {
    const result = [];
    for (const [containerPort, bindings] of Object.entries(portsObj)) {
      if (!bindings) continue;
      const [port, protocol] = containerPort.split('/');
      for (const b of bindings) {
        result.push({ host: b.HostPort, container: port, protocol: protocol || 'tcp', ip: b.HostIp });
      }
    }
    return result;
  }

  _buildPortBindings(portBindings) {
    if (!portBindings?.length) return {};
    const result = {};
    for (const p of portBindings) {
      const key = `${p.container}/${p.protocol || 'tcp'}`;
      if (!result[key]) result[key] = [];
      result[key].push({ HostPort: String(p.host), HostIp: p.ip || '' });
    }
    return result;
  }

  _filterLabels(labels) {
    // Remove Docker Compose internal labels (they'll be recreated)
    const filtered = {};
    for (const [k, v] of Object.entries(labels)) {
      if (!k.startsWith('com.docker.compose.')) filtered[k] = v;
    }
    return filtered;
  }
}

module.exports = new StackBundleService();
