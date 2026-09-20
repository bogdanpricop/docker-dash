'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { getDb } = require('../db');
const history = require('./container-history');
const LABEL = 'com.docker-dash.replacement';
const { options, endpoints } = require('../utils/container-config');
const operational = (message, status = 409) => Object.assign(new Error(message), { status });
const missing = error => error.statusCode === 404;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function fingerprint(inspect) {
  return JSON.stringify(stable({ Id: inspect.Id, Name: inspect.Name, Image: inspect.Image,
    Config: inspect.Config, HostConfig: inspect.HostConfig, Mounts: inspect.Mounts,
    Networks: inspect.NetworkSettings?.Networks, Running: inspect.State?.Running,
    Paused: inspect.State?.Paused, Restarting: inspect.State?.Restarting }));
}
async function verify(container, { wasRunning, skipHealth = false, timeoutMs = 30000, intervalMs = 1000, stabilizeMs = 5000, restartCount = 0 }) {
  const started = Date.now(), deadline = started + timeoutMs;
  do {
    const inspection = await container.inspect(), state = inspection.State;
    if (!wasRunning) {
      if (state.Running || state.Restarting) throw operational('Replacement unexpectedly started', 502);
      return;
    }
    if (!state.Running || state.Restarting || state.Dead || (inspection.RestartCount || 0) > restartCount) throw operational('Replacement is not running reliably', 502);
    if (!skipHealth && state.Health?.Status === 'healthy') return;
    if ((skipHealth || !state.Health) && Date.now() - started >= stabilizeMs) return;
    if (!skipHealth && state.Health?.Status === 'unhealthy') throw operational('Replacement health check failed', 502);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw operational('Replacement health check timed out', 502);
}

async function replace({ docker, inspect, imageId, hostId = 0, action, username, saved,
  skipHealth = false, commit = () => {}, onPhase = () => {}, verification = {} }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId || '')) throw operational('An immutable replacement image is required', 400);
  const name = inspect.Name.replace(/^\//, ''), id = randomUUID();
  if (/^dd-(recovery-|replacement-lock-)/.test(name)) throw operational('Retained recovery and lock containers require explicit reconciliation');
  const create = options(inspect, imageId, saved);
  if (inspect.HostConfig?.AutoRemove || create.HostConfig.AutoRemove) throw operational('Auto-remove containers cannot retain a recovery copy');
  if (inspect.State?.Paused || inspect.State?.Restarting || inspect.State?.Dead) throw operational('Container must be running normally or stopped before replacement');
  if (inspect.Config?.Labels?.['com.docker.swarm.service.id']) throw operational('Use the Swarm service update workflow for this container');
  // A missing historical volume must not silently become a new empty volume.
  for (const mount of (saved?.Mounts || inspect.Mounts || []).filter(m => m.Type === 'volume' && m.Name)) {
    try { await docker.getVolume(mount.Name).inspect(); }
    catch { throw operational('A required data volume is unavailable; restore it before replacement'); }
  }
  const daemonId = (await docker.info()).ID;
  if (!daemonId) throw operational('Docker daemon identity could not be verified', 503);
  const lockName = 'dd-replacement-lock-' + createHash('sha256').update(name).digest('hex').slice(0, 32);
  const recoveryName = 'dd-recovery-' + id;
  const db = getDb(), old = docker.getContainer(inspect.Id);
  let lock, candidate, result, changed = false, committed = false, phase = 'prepared';
  const disconnected = [];
  const originalEndpoints = endpoints(inspect);
  const restartPolicy = inspect.HostConfig?.RestartPolicy || { Name: 'no' };
  const update = (next, error = null) => {
    db.prepare("UPDATE container_replacements SET phase=?, candidate_id=?, lock_id=?, error=?, updated_at=datetime('now') WHERE id=?")
      .run(next, candidate?.id || null, lock?.id || null, error, id);
    phase = next;
    if (['locked', 'retaining', 'stopped', 'creating', 'created', 'verifying'].includes(next)) onPhase(next);
  };
  db.prepare(`INSERT INTO container_replacements
    (id,host_id,daemon_id,container_name,original_id,recovery_name,phase,was_running,restart_policy)
    VALUES (?,?,?,?,?,?,'prepared',?,?)`).run(id, hostId, daemonId, name, inspect.Id, recoveryName, inspect.State.Running ? 1 : 0, JSON.stringify(restartPolicy));
  try {
    try {
      lock = await docker.createContainer({ name: lockName, Image: inspect.Image,
        Entrypoint: ['/bin/false'], Cmd: [], Labels: { [LABEL]: id, [LABEL + '.role']: 'lock',
          [require('./docker-prune-guard').PROTECT_LABEL]: 'true',
          [LABEL + '.original']: inspect.Id, [LABEL + '.name']: name },
        HostConfig: { NetworkMode: 'none', RestartPolicy: { Name: 'no' }, ReadonlyRootfs: true } });
    } catch (error) {
      if (error.statusCode === 409) throw operational('A replacement already holds this container lock; inspect its recovery record');
      throw error;
    }
    update('locked');
    await require('./docker-prune-guard').assertNoPrune(docker);
    const current = await old.inspect();
    if (fingerprint(current) !== fingerprint(inspect)) throw operational('Container changed while the update was being prepared; retry with fresh state');
    const historyId = history.record({ inspect: current, hostId, action, username });
    db.prepare('UPDATE container_replacements SET history_id=? WHERE id=?').run(historyId, id);
    update('retaining'); changed = true;
    await old.update({ RestartPolicy: { Name: 'no' } });
    await old.rename({ name: recoveryName });
    if (inspect.State.Running) await old.stop();
    update('stopped');
    for (const network of Object.keys(originalEndpoints).filter(n => !['bridge', 'host', 'none'].includes(n))) {
      // Record intent first; an HTTP response may be lost after disconnection.
      disconnected.push(network);
      await docker.getNetwork(network).disconnect({ Container: inspect.Id });
    }
    update('creating');
    create.name = name;
    create.Labels = { ...(create.Labels || {}), [LABEL]: id, [LABEL + '.role']: 'candidate' };
    try { candidate = await docker.createContainer(create); }
    catch (error) {
      // Reconcile a lost create response by immutable operation label, not name alone.
      try {
        const found = await docker.getContainer(name).inspect();
        if (found.Config?.Labels?.[LABEL] === id) candidate = docker.getContainer(found.Id);
      } catch (lookup) { if (!missing(lookup)) throw lookup; }
      throw error;
    }
    update('created');
    if (inspect.State.Running) await candidate.start();
    update('verifying');
    await verify(candidate, { ...verification, wasRunning: inspect.State.Running, skipHealth });
    // Required audit/state writes and the commit marker share one SQLite transaction.
    // Callbacks must be synchronous and use this same database.
    db.transaction(() => {
      const result = commit(candidate.id, id);
      if (result?.then) throw new Error('Replacement commit must be synchronous');
      db.prepare("UPDATE container_replacements SET phase='committed', updated_at=datetime('now') WHERE id=?").run(id);
    })();
    phase = 'committed'; committed = true;
    try { await old.remove({ v: false }); }
    catch {
      try { update('cleanup_required'); } catch { /* The committed journal and lock remain. */ }
      return result = { id: candidate.id, operationId: id, cleanupRequired: true, recoveryName };
    }
    try { update('complete'); } catch { return result = { id: candidate.id, operationId: id, cleanupRequired: true, recoveryName }; }
    return result = { id: candidate.id, operationId: id, cleanupRequired: false };
  } catch (error) {
    if (!committed && changed) {
      try {
        update('recovering');
        if (candidate) {
          try {
            const owned = await candidate.inspect();
            if (owned.Config?.Labels?.[LABEL] !== id) throw new Error('Candidate ownership changed');
            await candidate.remove({ force: true, v: false });
          } catch (lookup) { if (!missing(lookup)) throw lookup; }
        }
        const original = await old.inspect();
        if (![name, recoveryName].includes(original.Name.replace(/^\//, ''))) throw new Error('Original name changed externally');
        if (original.Name !== '/' + name) await old.rename({ name });
        for (const network of disconnected) {
          const fresh = await old.inspect();
          if (!fresh.NetworkSettings?.Networks?.[network]) await docker.getNetwork(network).connect({ Container: inspect.Id, EndpointConfig: originalEndpoints[network] });
        }
        await old.update({ RestartPolicy: restartPolicy });
        if (inspect.State.Running && !(await old.inspect()).State.Running) await old.start();
        await verify(old, { ...verification, wasRunning: inspect.State.Running, skipHealth: true, restartCount: inspect.RestartCount || 0 });
        update('recovered');
      } catch {
        try { update('recovery_required', 'Inspect retained containers and the operation record before manual recovery'); } catch { /* Durable intent and daemon lock remain. */ }
        const failure = operational(`Replacement interrupted; manual recovery required (operation ${id}, original ${inspect.Id})`, 503);
        failure.operationId = id; throw failure;
      }
    } else if (!committed) { try { update('failed'); } catch { /* Preserve lock if state cannot be recorded. */ } }
    const failure = operational(`Replacement failed${phase === 'recovered' ? '; original container restored' : ''} (operation ${id}): ${error.message}`, error.status || 502);
    failure.operationId = id; failure.recovered = phase === 'recovered'; throw failure;
  } finally {
    if (lock && ['complete', 'recovered', 'failed'].includes(phase)) {
      try {
        const owned = await lock.inspect();
        if (owned.Config?.Labels?.[LABEL] !== id) throw new Error('Lock ownership changed');
        await lock.remove({ v: true });
      } catch (error) {
        if (!missing(error) && result) {
          result.cleanupRequired = true;
          try { update('cleanup_required'); } catch { /* The committed record identifies the retained lock. */ }
        }
      }
    }
  }
}

module.exports = { replace, options, endpoints, verify, LABEL };
