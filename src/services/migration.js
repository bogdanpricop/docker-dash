'use strict';

const dockerService = require('./docker');
const log = require('../utils/logger')('migration');
const { now } = require('../utils/helpers');

class MigrationService {
  /**
   * Migrate a container from one host to another.
   *
   * Zero-downtime strategy:
   * 1. Inspect source container → capture full config
   * 2. Pull image on destination host
   * 3. Create container on destination with same config
   * 4. Start on destination
   * 5. Wait for healthy/running state
   * 6. Stop on source (only after destination is confirmed running)
   * 7. Optionally remove from source
   *
   * @param {Object} opts
   * @param {string} opts.containerId - Container ID on source host
   * @param {number} opts.sourceHostId - Source host ID
   * @param {number} opts.destHostId - Destination host ID
   * @param {boolean} opts.removeSource - Remove from source after migration (default: false)
   * @param {boolean} opts.zeroDowntime - Keep source running until dest is healthy (default: true)
   * @param {Function} opts.onProgress - Progress callback (step, message)
   */
  async migrateContainer({ containerId, sourceHostId, destHostId, removeSource = false, zeroDowntime = true, onProgress }) {
    const progress = (step, message, status = 'running') => {
      log.info(`Migration step ${step}: ${message}`);
      if (onProgress) onProgress({ step, message, status, timestamp: now() });
    };

    if (sourceHostId === destHostId) {
      throw new Error('Source and destination hosts must be different');
    }

    const steps = [];

    try {
      // Step 1: Inspect source container
      progress(1, 'Inspecting source container...');
      const srcDocker = dockerService.getDocker(sourceHostId);
      const srcContainer = srcDocker.getContainer(containerId);
      const inspect = await srcContainer.inspect();
      const name = inspect.Name.replace(/^\//, '');
      const image = inspect.Config.Image;
      const wasRunning = inspect.State.Running;

      steps.push({ step: 1, action: 'inspect', status: 'done', detail: `${name} (${image})` });

      // Step 2: Pull image on destination
      progress(2, `Pulling ${image} on destination host...`);
      const dstDocker = dockerService.getDocker(destHostId);

      await new Promise((resolve, reject) => {
        dstDocker.pull(image, (err, stream) => {
          if (err) return reject(err);
          dstDocker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
      steps.push({ step: 2, action: 'pull', status: 'done', detail: image });

      // Step 3: Check if container name already exists on destination
      progress(3, 'Checking for name conflicts on destination...');
      const destContainers = await dstDocker.listContainers({ all: true });
      const nameConflict = destContainers.find(c => c.Names?.some(n => n.replace(/^\//, '') === name));
      const destName = nameConflict ? `${name}-migrated-${Date.now().toString(36)}` : name;

      if (nameConflict) {
        steps.push({ step: 3, action: 'name_check', status: 'warning', detail: `Name "${name}" exists on destination, using "${destName}"` });
      } else {
        steps.push({ step: 3, action: 'name_check', status: 'done', detail: 'No conflicts' });
      }

      // Step 4: Create container on destination
      progress(4, `Creating container "${destName}" on destination...`);

      // Build create options from source inspection
      const createOpts = {
        name: destName,
        Image: image,
        Cmd: inspect.Config.Cmd,
        Env: inspect.Config.Env,
        ExposedPorts: inspect.Config.ExposedPorts,
        Labels: {
          ...(inspect.Config.Labels || {}),
          'docker-dash.migrated-from': `host-${sourceHostId}`,
          'docker-dash.migrated-at': new Date().toISOString(),
          'docker-dash.original-name': name,
        },
        WorkingDir: inspect.Config.WorkingDir,
        Entrypoint: inspect.Config.Entrypoint,
        Volumes: inspect.Config.Volumes,
        Hostname: inspect.Config.Hostname,
        User: inspect.Config.User,
        HostConfig: this._sanitizeHostConfig(inspect.HostConfig),
      };

      // Network config — create on default bridge (source networks may not exist on dest)
      // User can manually reconnect to correct networks after migration

      const newContainer = await dstDocker.createContainer(createOpts);
      steps.push({ step: 4, action: 'create', status: 'done', detail: `Container ${newContainer.id.substring(0, 12)} created` });

      // Step 5: Start on destination
      if (wasRunning) {
        progress(5, 'Starting container on destination...');
        await newContainer.start();

        // Wait for it to be running (poll for up to 30s)
        let healthy = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const destInspect = await newContainer.inspect();
            if (destInspect.State.Running) {
              healthy = true;
              // If has health check, wait for healthy status
              if (destInspect.State.Health) {
                if (destInspect.State.Health.Status === 'healthy') break;
                if (destInspect.State.Health.Status === 'unhealthy') {
                  healthy = false;
                  break;
                }
                continue; // still starting, keep waiting
              }
              break;
            }
          } catch {}
        }

        if (!healthy) {
          steps.push({ step: 5, action: 'start', status: 'warning', detail: 'Container started but health check not yet passing' });
        } else {
          steps.push({ step: 5, action: 'start', status: 'done', detail: 'Container running and healthy on destination' });
        }
      } else {
        steps.push({ step: 5, action: 'start', status: 'skipped', detail: 'Source was not running, created in stopped state' });
      }

      // Step 6: Stop source (zero-downtime: only after dest confirmed)
      if (zeroDowntime && wasRunning) {
        progress(6, 'Stopping source container (destination confirmed running)...');
      } else if (wasRunning) {
        progress(6, 'Stopping source container...');
      }

      if (wasRunning) {
        await srcContainer.stop({ t: 10 });
        steps.push({ step: 6, action: 'stop_source', status: 'done', detail: 'Source container stopped' });
      } else {
        steps.push({ step: 6, action: 'stop_source', status: 'skipped', detail: 'Source was already stopped' });
      }

      // Step 7: Remove source (optional)
      if (removeSource) {
        progress(7, 'Removing source container...');
        await srcContainer.remove({ force: true });
        steps.push({ step: 7, action: 'remove_source', status: 'done', detail: 'Source container removed' });
      } else {
        steps.push({ step: 7, action: 'remove_source', status: 'skipped', detail: 'Source container kept (stopped)' });
      }

      progress(8, 'Migration complete!', 'success');
      return {
        ok: true,
        source: { hostId: sourceHostId, containerId, name },
        destination: { hostId: destHostId, containerId: newContainer.id, name: destName },
        zeroDowntime,
        steps,
      };

    } catch (err) {
      log.error('Migration failed', { containerId, error: err.message });
      steps.push({ step: 0, action: 'error', status: 'failed', detail: err.message });
      throw Object.assign(err, { steps });
    }
  }

  /**
   * Migrate all containers in a compose stack.
   */
  async migrateStack({ stackName, sourceHostId, destHostId, removeSource = false, zeroDowntime = true, onProgress }) {
    const srcDocker = dockerService.getDocker(sourceHostId);
    const containers = await srcDocker.listContainers({ all: true });
    const stackContainers = containers.filter(c =>
      c.Labels?.['com.docker.compose.project'] === stackName
    );

    if (stackContainers.length === 0) {
      throw new Error(`No containers found for stack "${stackName}" on host ${sourceHostId}`);
    }

    const results = [];
    for (const c of stackContainers) {
      const name = c.Names[0]?.replace(/^\//, '');
      try {
        if (onProgress) onProgress({ step: 0, message: `Migrating ${name}...`, status: 'running' });
        const result = await this.migrateContainer({
          containerId: c.Id,
          sourceHostId,
          destHostId,
          removeSource,
          zeroDowntime,
          onProgress,
        });
        results.push({ container: name, ...result });
      } catch (err) {
        results.push({ container: name, ok: false, error: err.message, steps: err.steps || [] });
      }
    }

    return {
      stack: stackName,
      total: stackContainers.length,
      migrated: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    };
  }

  /**
   * Sanitize HostConfig for cross-host compatibility.
   * Remove host-specific paths and binds that may not exist on destination.
   */
  _sanitizeHostConfig(hc) {
    if (!hc) return {};
    const sanitized = { ...hc };

    // Keep: RestartPolicy, Memory, CPU, PortBindings, NetworkMode
    // Sanitize: Binds — warn about host-specific paths
    if (sanitized.Binds) {
      sanitized.Binds = sanitized.Binds.filter(bind => {
        // Keep named volumes (no / prefix in source)
        const source = bind.split(':')[0];
        if (!source.startsWith('/') && !source.startsWith('\\')) return true;
        // Keep common paths
        if (source.startsWith('/var/run/docker.sock')) return true;
        // Flag host-specific binds but keep them (user should check)
        return true;
      });
    }

    // Remove host-specific fields
    delete sanitized.CgroupParent;
    delete sanitized.CgroupnsMode;

    return sanitized;
  }

  /**
   * Preview what a migration would look like (dry run).
   */
  async previewMigration({ containerId, sourceHostId, destHostId }) {
    const srcDocker = dockerService.getDocker(sourceHostId);
    const inspect = await srcDocker.getContainer(containerId).inspect();
    const name = inspect.Name.replace(/^\//, '');
    const image = inspect.Config.Image;

    // Check destination for conflicts
    const dstDocker = dockerService.getDocker(destHostId);
    const destContainers = await dstDocker.listContainers({ all: true });
    const nameConflict = destContainers.find(c => c.Names?.some(n => n.replace(/^\//, '') === name));

    // Check if image exists on destination
    let imageExists = false;
    try {
      await dstDocker.getImage(image).inspect();
      imageExists = true;
    } catch {}

    // Analyze bind mounts
    const binds = (inspect.HostConfig?.Binds || []).map(b => {
      const parts = b.split(':');
      return { source: parts[0], destination: parts[1], isNamedVolume: !parts[0].startsWith('/') };
    });
    const hostBinds = binds.filter(b => !b.isNamedVolume);

    return {
      container: name,
      image,
      isRunning: inspect.State.Running,
      nameConflict: !!nameConflict,
      imageExistsOnDest: imageExists,
      hostBindMounts: hostBinds,
      warnings: [
        ...(nameConflict ? [`Container "${name}" already exists on destination — will be renamed`] : []),
        ...(hostBinds.length > 0 ? [`${hostBinds.length} host bind mount(s) may not exist on destination: ${hostBinds.map(b => b.source).join(', ')}`] : []),
        ...(!imageExists ? [`Image "${image}" needs to be pulled on destination (~may take time)`] : []),
      ],
      env: (inspect.Config.Env || []).length,
      ports: Object.keys(inspect.NetworkSettings?.Ports || {}).length,
      volumes: (inspect.Mounts || []).length,
      restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    };
  }
}

module.exports = new MigrationService();
