'use strict';

// A named helper reserves each canonical target on the selected Docker daemon.
// It stays alive through snapshot/apply/rollback. Failed recovery retains the
// stopped helper and its private snapshot instead of releasing its reservation.
const crypto = require('node:crypto');
const dockerService = require('./docker');
const nft = require('./egress-nft');
const log = require('../utils/logger')('egress-runner');
const HELPER_IMAGE = process.env.DD_EGRESS_HELPER_IMAGE || 'alpine:3.24.2';
const TIMEOUT_MS = 45000;
const MAX_OUTPUT = 128 * 1024;

function _sidecarEndpoint() {
  const match = /^(\d+\.\d+\.\d+\.\d+):([1-9]\d{0,4})$/.exec(process.env.DD_EGRESS_SIDECAR_ENDPOINT || '');
  if (!match) throw new Error('DD_EGRESS_SIDECAR_ENDPOINT must be IPv4 ip:port');
  return nft.endpoint(match[1], Number(match[2]));
}

function bounded(promise, timeoutMs = TIMEOUT_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Egress helper deadline exceeded'), { uncertain: true })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function readOutput(stream) {
  const chunks = [];
  let pending = Buffer.alloc(0), bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT) throw new Error('Egress helper output limit exceeded');
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      if (![1, 2].includes(pending[0]) || pending[1] || pending[2] || pending[3]) throw new Error('Invalid Docker output frame');
      const length = pending.readUInt32BE(4);
      if (length > MAX_OUTPUT) throw new Error('Egress helper output limit exceeded');
      if (pending.length < 8 + length) break;
      chunks.push(pending.subarray(8, 8 + length));
      pending = pending.subarray(8 + length);
    }
  }
  if (pending.length) throw new Error('Truncated Docker output frame');
  return Buffer.concat(chunks).toString('utf8');
}

async function targetInfo(docker, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('containerId required (12-64 hex characters)');
  const info = await bounded(docker.getContainer(id).inspect());
  if (!/^[a-f0-9]{64}$/.test(info.Id || '') || !info.Id.startsWith(id)) throw new Error('Docker container identity mismatch');
  if (!info.State?.Running || info.State.Paused || info.State.Restarting || !info.State.StartedAt) throw new Error('Container must be running and stable');
  const precheck = require('./egress-filter').canApplyFilter(info);
  if (!precheck.ok) throw new Error(precheck.reason);
  return info;
}

async function checkTarget(session) {
  const info = await targetInfo(session.docker, session.info.Id);
  if (info.State.StartedAt !== session.info.State.StartedAt || info.State.Pid !== session.info.State.Pid) {
    throw new Error('Container restarted during egress operation; namespace changed');
  }
}

async function execute(session, script) {
  let stream, expired = false;
  const work = (async () => {
    const command = await session.helper.exec({ Cmd: ['sh', '-c', script], AttachStdout: true, AttachStderr: true, Tty: false });
    if (expired) throw new Error('Egress command cancelled before start');
    stream = await command.start({});
    if (expired) { stream.destroy(); throw new Error('Egress command outcome unknown'); }
    const output = await readOutput(stream);
    const result = await command.inspect();
    if (result.Running || !Number.isInteger(result.ExitCode)) throw new Error('Egress helper exit status missing');
    if (result.ExitCode !== 0) throw Object.assign(new Error(`Egress helper exited ${result.ExitCode}`), { confirmedExit: true });
    return output;
  })();
  try { return await bounded(work); }
  catch (error) {
    if (!error.confirmedExit) session.uncertain = true;
    throw error;
  } finally { expired = true; stream?.destroy(); }
}

async function closeSession(session) {
  if (session.recovery || session.uncertain) {
    try { await bounded(session.helper.stop({ t: 0 })); } catch (error) {
      if (error.statusCode !== 304) log.error('Cannot stop egress recovery helper', { helper: session.name });
    }
    return session.name;
  }
  try { await bounded(session.helper.remove({ force: true })); return null; }
  catch (error) {
    if (error.statusCode === 404) return null;
    try { await bounded(session.helper.stop({ t: 0 })); } catch { /* retain reservation when cleanup cannot be confirmed */ }
    return session.name;
  }
}

async function withSessions(infos, docker, action) {
  const sessions = [], operationId = crypto.randomUUID();
  let result, failure;
  try {
    // Stable ordering prevents overlapping stack operations from acquiring the
    // same daemon reservations in opposite orders, including across HA workers.
    for (const info of [...infos].sort((a, b) => a.Id.localeCompare(b.Id))) {
      const name = 'dd-egress-lock-' + info.Id;
      let helper;
      try {
        helper = await bounded(docker.createContainer({ name, Image: HELPER_IMAGE, User: '0:0', Entrypoint: ['/bin/sh'], Tty: false,
          Cmd: ['-c', 'trap "exit 0" TERM INT; while :; do sleep 30 & wait $!; done'],
          Labels: { 'com.docker-dash.egress-operation': operationId, 'com.docker-dash.egress-target': info.Id,
            'com.docker-dash.egress-started-at': info.State.StartedAt, 'com.docker-dash.egress-pid': String(info.State.Pid) },
          Healthcheck: { Test: ['NONE'] },
          HostConfig: { NetworkMode: `container:${info.Id}`, CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'],
            SecurityOpt: ['no-new-privileges'], Memory: 128 * 1024 ** 2, NanoCpus: 500000000,
            PidsLimit: 32, RestartPolicy: { Name: 'no' }, AutoRemove: false },
        }));
      } catch (error) {
        const conflict = error.statusCode === 409;
        const uncertain = !Number.isInteger(error.statusCode) || error.statusCode >= 500;
        throw Object.assign(new Error(conflict ? `Egress operation or recovery already holds ${name}` : `Cannot reserve egress helper ${name}`), {
          operationId, recoveryRequired: uncertain, recoveryHelpers: uncertain ? [name] : [],
        });
      }
      const session = { docker, info, helper, name, operationId, uncertain: false, recovery: false };
      sessions.push(session);
      await bounded(helper.start());
      await checkTarget(session);
      // The legacy Alpine fallback is prepared BEFORE any firewall mutation.
      // A prebuilt docker/egress-helper image avoids this network requirement.
      await execute(session, 'set -eu; command -v nft >/dev/null 2>&1 || timeout 30 apk add -q --no-cache nftables');
    }
    result = await action(sessions);
  } catch (error) { failure = error; }
  const retained = [];
  for (const session of sessions.reverse()) {
    const name = await closeSession(session);
    if (name) retained.push(name);
  }
  if (retained.length) {
    failure ||= new Error('Egress rules changed, but helper cleanup requires recovery');
    failure.recoveryRequired = true;
    failure.recoveryHelpers = [...new Set([...(failure.recoveryHelpers || []), ...retained])];
  }
  if (failure) { failure.operationId = operationId; throw failure; }
  return result;
}

async function snapshot(session) {
  const output = (await execute(session, nft.snapshotScript())).trim();
  if (!['DD_PRESENT', 'DD_ABSENT'].includes(output)) throw new Error('Invalid egress snapshot response');
  return output === 'DD_PRESENT';
}

async function applyInfos(infos, hostId) {
  const { ip, port } = _sidecarEndpoint();
  const docker = dockerService.getDocker(hostId);
  return withSessions(infos, docker, async sessions => {
    // All snapshots precede all mutations. An absent table is a valid snapshot.
    for (const session of sessions) { await checkTarget(session); await snapshot(session); }
    const attempted = [];
    try {
      for (const session of sessions) {
        await checkTarget(session);
        attempted.push(session);
        await execute(session, nft.applyScript(ip, port));
        await checkTarget(session);
      }
      return sessions.map(s => ({ id: s.info.Id, name: (s.info.Name || '').replace(/^\//, '') }));
    } catch (error) {
      const restored = [], failed = [];
      for (const session of attempted.reverse()) {
        if (session.uncertain) { session.recovery = true; failed.push(session.info.Id); continue; }
        try { await execute(session, nft.restoreScript()); restored.push(session.info.Id); }
        catch { session.recovery = true; failed.push(session.info.Id); }
      }
      error.rollback = { restored, failed };
      error.message = `Egress apply failed: ${error.message}. Restored ${restored.length}; recovery required for ${failed.length}.`;
      throw error;
    }
  });
}

async function applyToContainer({ containerId, hostId = 0 }) {
  const docker = dockerService.getDocker(hostId), info = await targetInfo(docker, containerId);
  await applyInfos([info], hostId);
  return { ok: true, output: 'IPv4 egress table replaced atomically' };
}

async function removeFromContainer({ containerId, hostId = 0 }) {
  const docker = dockerService.getDocker(hostId), info = await targetInfo(docker, containerId);
  return withSessions([info], docker, async ([session]) => {
    await checkTarget(session); await snapshot(session);
    await execute(session, nft.removeScript()); await checkTarget(session);
    return { ok: true, output: 'IPv4 egress table removed' };
  });
}

async function isApplied({ containerId, hostId = 0 }) {
  const docker = dockerService.getDocker(hostId), info = await targetInfo(docker, containerId);
  return withSessions([info], docker, async ([session]) => {
    const applied = await snapshot(session);
    await checkTarget(session);
    return { applied, details: applied ? 'IPv4 ddout table present; protocol coverage is not verified by this status' : 'IPv4 ddout table absent' };
  });
}

async function _listStackContainers({ stackName, hostId = 0 }) {
  if (typeof stackName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(stackName)) throw new Error('stackName required (valid Compose project name)');
  const containers = await bounded(dockerService.getDocker(hostId).listContainers({ all: true,
    filters: JSON.stringify({ label: [`com.docker.compose.project=${stackName}`] }) }));
  if (containers.length > 100) throw new Error('Egress stack exceeds 100-container operation limit');
  return containers.map(c => ({ id: c.Id, name: (c.Names?.[0] || '').replace(/^\//, ''), state: c.State }));
}

async function applyToStack({ stackName, hostId = 0 }) {
  const containers = await _listStackContainers({ stackName, hostId });
  if (!containers.length) throw new Error(`No containers found for stack "${stackName}"`);
  const docker = dockerService.getDocker(hostId), infos = [], skipped = [];
  for (const c of containers) {
    if (c.state !== 'running') { skipped.push({ id: c.id, name: c.name, reason: `container is ${c.state}` }); continue; }
    const info = await targetInfo(docker, c.id);
    if (info.Config?.Labels?.['com.docker.compose.project'] !== stackName) throw new Error('Stack membership changed before apply');
    infos.push(info);
  }
  const applied = infos.length ? await applyInfos(infos, hostId) : [];
  return { applied, skipped, failed: [], stack: stackName };
}

async function removeFromStack({ stackName, hostId = 0 }) {
  const containers = await _listStackContainers({ stackName, hostId }), removed = [], failed = [];
  for (const c of containers.filter(c => c.state === 'running')) {
    try { await removeFromContainer({ containerId: c.id, hostId }); removed.push({ id: c.id, name: c.name }); }
    catch (error) { failed.push({ id: c.id, name: c.name, error: error.message,
      recoveryRequired: !!error.recoveryRequired, recoveryHelpers: error.recoveryHelpers || [] }); }
  }
  return { removed, failed, stack: stackName };
}

async function statusOfStack({ stackName, hostId = 0 }) {
  const containers = await _listStackContainers({ stackName, hostId }), results = [];
  for (const c of containers) {
    if (c.state !== 'running') { results.push({ ...c, applied: false, skipped: true }); continue; }
    try { results.push({ ...c, ...(await isApplied({ containerId: c.id, hostId })) }); }
    catch (error) { results.push({ ...c, applied: null, error: error.message }); }
  }
  return { stack: stackName, containers: results, appliedCount: results.filter(r => r.applied === true).length, totalCount: results.length };
}

module.exports = { applyToContainer, removeFromContainer, isApplied, applyToStack, removeFromStack, statusOfStack,
  _internals: { _applyScript: nft.applyScript, _removeScript: nft.removeScript, _inspectScript: nft.snapshotScript,
    _sidecarEndpoint, _listStackContainers, HELPER_IMAGE, readOutput, bounded } };
