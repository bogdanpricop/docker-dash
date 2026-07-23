'use strict';

// Turn a raw Docker daemon / dockerode error into a short, plain-language,
// actionable message for humans. Docker surfaces things like
//   "(HTTP code 500) unexpected - --live-restore daemon configuration is
//    incompatible with swarm mode "
// which is technical and noisy. This maps the common cases to a clear sentence
// (what went wrong + how to fix it) and cleans up anything it doesn't recognise
// instead of leaking the raw HTTP-code preamble.

/** Strip the "(HTTP code 500) unexpected - " preamble + collapse whitespace. */
function cleanDockerMessage(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^\(HTTP code \d+\)\s*\w+\s*-\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Error|string} err  the caught error (or its message)
 * @returns {string} a human-friendly, actionable message
 */
function humanizeDockerError(err) {
  const raw = cleanDockerMessage((err && err.message) || err);
  const l = raw.toLowerCase();

  // ── Swarm / daemon configuration ──────────────────────────────
  if (l.includes('live-restore') && l.includes('swarm')) {
    return 'This host\'s Docker has "live-restore" turned on, which can\'t be used together with swarm mode. On that host, set "live-restore": false in /etc/docker/daemon.json and restart Docker, then try again.';
  }
  if (l.includes('multiple addresses') || l.includes('advertise-addr') || l.includes('advertise address')) {
    return 'This host has more than one IP address, so Docker can\'t decide which one to use for the swarm. Pick an Advertise address (the IP other nodes should reach this host on) and try again.';
  }
  if (l.includes('already part of a swarm') || l.includes('this node is already')) {
    return 'This host is already part of a swarm. Leave the current swarm first if you want to start a new one.';
  }
  if (l.includes('not a swarm manager')) {
    return 'This host isn\'t a swarm manager yet. Initialize a swarm here first (or join it to an existing one).';
  }
  if (l.includes('must be drained') || (l.includes('node') && l.includes('cannot remove') && l.includes('drain'))) {
    return 'Set the node to "Drain" first so its tasks move to other nodes, then remove it.';
  }

  // ── Common day-to-day Docker errors ───────────────────────────
  if (l.includes('port is already allocated') || l.includes('address already in use') || l.includes('bind: address already in use')) {
    return 'That port is already in use on the host. Stop whatever is using it, or choose a different port.';
  }
  if (l.includes('no such container')) {
    return 'That container no longer exists on the host — it may have already been removed. Refresh the list and try again.';
  }
  if (l.includes('no such image') || l.includes('image not found') || (l.includes('pull access denied'))) {
    return 'That image isn\'t available on the host (or the registry rejected the pull). Check the image name/tag and that the host can pull it.';
  }
  if (l.includes('is already in use by container') || (l.includes('name') && l.includes('already in use'))) {
    return 'That name is already taken on this host. Choose a different name, or remove the existing one first.';
  }
  if (l.includes('conflict') && l.includes('running')) {
    return 'The container is still running. Stop it first, then retry.';
  }
  if (l.includes('permission denied') || l.includes('access denied')) {
    return 'Docker refused the operation (permission denied). Check that Docker Dash can reach that host\'s daemon with enough rights.';
  }
  if (l.includes('no space left on device')) {
    return 'The host is out of disk space. Free some space (e.g. prune unused images / build cache) and try again.';
  }

  // ── Connectivity / timeouts ───────────────────────────────────
  if (l.includes('socket hang up') || l.includes('econnreset') || l.includes('etimedout') || l.includes('timed out')) {
    return 'The connection to the Docker daemon dropped before the operation finished — the host may be slow, unreachable, or the request timed out. Check the host and try again.';
  }
  if (l.includes('connection refused') || l.includes('econnrefused')) {
    return 'Couldn\'t reach the Docker daemon on that host (connection refused). Make sure Docker is running and reachable.';
  }
  if (l.includes('ehostunreach') || l.includes('enetunreach') || l.includes('no route to host')) {
    return 'The host is unreachable from Docker Dash. Check the network/connection to it and try again.';
  }
  if (l.includes('all configured authentication methods failed') || l.includes('authentication failed')) {
    return 'Couldn\'t authenticate to the host over SSH — the credentials may have changed. Update the host\'s credentials and try again.';
  }

  // ── Fallback ──────────────────────────────────────────────────
  if (!raw) return 'The operation couldn\'t be completed on the Docker host.';
  return `Docker couldn't complete this: ${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
}

module.exports = { humanizeDockerError, cleanDockerMessage };
