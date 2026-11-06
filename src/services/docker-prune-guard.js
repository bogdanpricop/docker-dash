'use strict';

const { randomUUID } = require('node:crypto');
const NAME = 'dd-maintenance-prune-lock';
const LABEL = 'com.docker-dash.prune-reservation';
const PROTECT_LABEL = 'com.docker-dash.prune-protect';
// Multiple negative label values do not express the union of protected roles.
// Every newly created reservation carries one common exclusion label instead.
const CONTAINER_FILTERS = { 'label!': [PROTECT_LABEL] };
const conflict = message => Object.assign(new Error(message), { status: 409 });

// Operations create their own daemon reservation BEFORE checking this name.
// Prune creates this reservation BEFORE listing operation reservations. Thus
// either side observes the other before destructive work, across app replicas.
async function assertNoPrune(docker) {
  try { await docker.getContainer(NAME).inspect(); }
  catch (error) { if (error.statusCode === 404) return; throw error; }
  throw conflict('Docker prune or uncertain prune recovery is reserved on this daemon');
}

function recoveryContainer(container) {
  const labels = container.Labels || {};
  // A stopped release operator is durable evidence, not disposable garbage.
  // New Desktop Streamer owners also use PROTECT_LABEL before checking NAME.
  const desktopOperation = Object.hasOwn(labels, 'com.desktop-streamer.release-operation')
    || Object.hasOwn(labels, 'com.desktop-streamer.release-reservation');
  const desktopHistory = Object.hasOwn(labels, 'com.desktop-streamer.cutover-owner')
    && (container.State !== 'running'
      || (container.Names || []).some(name => /^\/?ds-cutover-host-/.test(name)));
  return Object.hasOwn(labels, 'com.docker-dash.egress-operation')
    || labels['com.docker-dash.replacement.role'] === 'lock'
    || (container.Names || []).some(name => /^\/?dd-(recovery-|replacement-lock-|egress-lock-)/.test(name))
    || desktopOperation || desktopHistory;
}

async function withPrune(docker, action) {
  // Reject known recovery work without briefly fencing its next operator.
  // The second inventory under the barrier still closes concurrent-start races.
  if ((await docker.listContainers({ all: true })).some(recoveryContainer)) {
    throw conflict('Container replacement, egress or Desktop Streamer release evidence is retained; reconcile it before pruning');
  }
  const helperRef = process.env.DD_EGRESS_HELPER_IMAGE || 'docker-dash-egress-helper:local';
  let image, helperAvailable = true;
  try { image = (await docker.getImage(helperRef).inspect()).Id; }
  catch (error) {
    if (error.statusCode !== 404) throw error;
    helperAvailable = false;
    image = (await docker.listImages())[0]?.Id;
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) {
    throw conflict('A local image is required to reserve Docker prune safely');
  }
  const token = randomUUID();
  let guard;
  try {
    // Never started. The image reference also pins the configured egress helper
    // through image prune, even when there are no active egress operations.
    guard = await docker.createContainer({ name: NAME, Image: image, Entrypoint: ['/bin/false'], Cmd: [],
      Labels: { [LABEL]: token, [PROTECT_LABEL]: 'true' }, Healthcheck: { Test: ['NONE'] },
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'], RestartPolicy: { Name: 'no' } } });
  } catch (error) {
    if (error.statusCode === 409) throw conflict('Docker prune is already reserved; inspect retained recovery before retrying');
    // A lost create response may have left the named reservation. Never adopt
    // or delete it on a blind retry.
    throw error;
  }
  let started = false, uncertain = false;
  try {
    const containers = await docker.listContainers({ all: true });
    if (containers.some(recoveryContainer)) {
      throw conflict('Container replacement, egress or Desktop Streamer release evidence is retained; reconcile it before pruning');
    }
    started = true;
    const result = await action({ helperImage: helperAvailable ? image : null });
    return { ...result, protection: { helperImageAvailable: helperAvailable,
      helperImage: helperAvailable ? image : null, recoveryReservationsChecked: true } };
  } catch (error) {
    // Docker can continue an accepted prune after the HTTP connection is lost.
    // Keep the barrier until an operator proves completion; no time-based unlock.
    uncertain = started && (!Number.isInteger(error.statusCode) || error.statusCode >= 500);
    if (uncertain) {
      error.recoveryRequired = true;
      error.recoveryContainer = NAME;
    }
    throw error;
  } finally {
    if (!uncertain) {
      const info = await guard.inspect();
      if (info.Config?.Labels?.[LABEL] !== token) throw conflict('Prune reservation ownership changed');
      await guard.remove({ v: true });
    }
  }
}

module.exports = { assertNoPrune, withPrune, recoveryContainer, NAME, LABEL, PROTECT_LABEL, CONTAINER_FILTERS };
