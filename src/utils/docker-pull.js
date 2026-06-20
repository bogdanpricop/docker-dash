'use strict';

// v8.7.28 — shared docker.pull wrapper with a wall-clock timeout.
//
// dockerode's docker.pull returns a streaming response; followProgress
// resolves when the stream ends. There is NO timeout — a registry that
// stops responding mid-pull (network drop after handshake, slow-loris
// registry, layer server hang) blocks the caller indefinitely.
//
// Five call sites in the codebase pre-fix had no timeout:
//   - src/services/pipeline.js (auto-deploy pipeline)
//   - src/services/docker.js (pullImage method)
//   - src/services/stackBundle.js (bundle export)
//   - src/routes/containers.js (image pull endpoint)
//   - src/routes/containers.js (stack creation pull)
//
// All five now route through this helper for consistent behavior:
// 10-minute wall clock by default (generous for multi-GB images;
// most mainstream images pull in < 2 min), stream destroyed on
// timeout so the descriptor and event-loop slot get released.
//
// migration.js uses followProgress directly without docker.pull (the
// stream comes from getImage().push() instead) — separate code path,
// not covered here. v8.7.10 already bounded git ops; the migration
// case is more nuanced because it streams between two daemons.

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/**
 * Pull an image with an explicit wall-clock timeout. Returns a Promise
 * that resolves with the dockerode pull output array on success or
 * rejects on network error / pull failure / timeout.
 *
 * @param {Docker} docker          dockerode client
 * @param {string} image           image ref to pull
 * @param {object} [opts]          { timeoutMs, authconfig }
 * @returns {Promise<Array>}       progress events from followProgress
 */
function pullImage(docker, image, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pullOpts = opts.authconfig ? { authconfig: opts.authconfig } : undefined;

  return new Promise((resolve, reject) => {
    let stream;
    let finished = false;
    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (stream) { try { stream.destroy(); } catch { /* ignore */ } }
      reject(new Error(`docker pull timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const pullCb = (err, s) => {
      if (finished) return;
      if (err) { finished = true; clearTimeout(timeoutId); return reject(err); }
      stream = s;
      docker.modem.followProgress(stream, (err2, output) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);
        if (err2) reject(err2); else resolve(output);
      });
    };

    if (pullOpts) {
      docker.pull(image, pullOpts, pullCb);
    } else {
      docker.pull(image, pullCb);
    }
  });
}

module.exports = { pullImage, DEFAULT_TIMEOUT_MS };
