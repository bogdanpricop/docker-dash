'use strict';

const path = require('node:path').posix;
const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const { finished } = require('node:stream/promises');
const dockerService = require('./docker');
const { applicationImage } = require('./docker-helper-image');
const { runCompose } = require('./compose-runner');

function unavailable() {
  return Object.assign(new Error('The original Compose project files are unavailable. Mount the project directory at the same path in Docker Dash or ask an administrator to check it on the Docker host.'), { status: 422 });
}

function bindable(directory) {
  // Never shadow image/system directories or mount a whole user home.
  return /^\/(?:home\/[^/]+\/|root\/|opt\/|srv\/|source\/|tmp\/|var\/www\/)[^/]/.test(directory)
    && path.normalize(directory) === directory;
}

async function runProjectCheck({ stack, directory, files, hostId, local, allowHostProject, dockerCliContext }, args, options) {
  const composeArgs = ['--project-name', stack, ...files.flatMap(file => ['-f', file]), ...args];
  let visible = false;
  try { visible = local && fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory(); } catch {}
  if (visible) {
    const context = dockerCliContext(hostId);
    try { return await runCompose(composeArgs, { ...options, cwd: directory, env: context.env }); }
    finally { context.cleanup(); }
  }

  if (!allowHostProject || !bindable(directory) || files.some(file => !file.startsWith(directory + '/'))) {
    throw unavailable();
  }
  const docker = dockerService.getDocker(hostId);
  const image = await applicationImage(docker);
  if (!image) throw unavailable();

  const mounts = [{ Type: 'bind', Source: directory, Target: directory, ReadOnly: true }];
  let entrypoint = ['/usr/local/bin/docker'];
  let command = ['compose', '--ansi', 'never', ...composeArgs];
  if (args.includes('--dry-run')) {
    const daemonId = (await docker.info()).ID;
    if (!daemonId) throw new Error('Cannot verify the Docker daemon for this Compose plan');
    mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true });
    entrypoint = ['/bin/sh', '-ec'];
    command = [
      'if [ "$(docker info --format "{{.ID}}")" != "$1" ]; then echo "Compose plan socket does not match the selected Docker host" >&2; exit 1; fi; shift; exec docker "$@"',
      '--', daemonId, ...command,
    ];
  }
  let container;
  try {
    container = await docker.createContainer({
      Image: image, WorkingDir: directory, Entrypoint: entrypoint,
      Cmd: command, Env: ['HOME=/tmp', 'DOCKER_HOST=unix:///var/run/docker.sock'],
      Healthcheck: { Test: ['NONE'] }, AttachStdout: true, AttachStderr: true,
      Labels: { 'com.docker-dash.compose-check': 'true' },
      HostConfig: {
        Mounts: mounts, ReadonlyRootfs: true, NetworkMode: 'none', Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        CapDrop: ['ALL'], CapAdd: ['DAC_READ_SEARCH'], SecurityOpt: ['no-new-privileges'],
        PidsLimit: 64, Memory: 384 * 1024 * 1024,
      },
    });
  } catch (error) {
    if (/bind source path does not exist/i.test(error.message)) throw unavailable();
    throw error;
  }

  let stream;
  let timer;
  const started = Date.now();
  try {
    stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const buffers = { stdout: [], stderr: [], output: [] };
    let bytes = 0;
    let truncated = false;
    for (const [key, output] of Object.entries({ stdout, stderr })) {
      output.on('data', chunk => {
        const part = chunk.subarray(0, Math.max(0, options.maxBytes - bytes));
        if (part.length) {
          buffers[key].push(part);
          buffers.output.push(part);
        }
        bytes += part.length;
        truncated ||= part.length < chunk.length;
      });
    }
    const closed = finished(stream, { writable: false });
    docker.modem.demuxStream(stream, stdout, stderr);
    const completion = Promise.all([container.start().then(() => container.wait()), closed]);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Docker Compose verification timed out')), options.timeoutMs);
    });
    const [exit] = await Promise.race([completion, timeout]);
    const result = Object.fromEntries(Object.entries(buffers).map(([key, chunks]) => [key, Buffer.concat(chunks).toString('utf8')]));
    Object.assign(result, { exitCode: exit.StatusCode, durationMs: Date.now() - started, truncated });
    if (exit.StatusCode !== 0) throw Object.assign(new Error('Docker Compose verification failed'), result);
    return result;
  } finally {
    clearTimeout(timer);
    stream?.destroy();
    await container.remove({ force: true }).catch(() => {});
  }
}

module.exports = { runProjectCheck, bindable };
