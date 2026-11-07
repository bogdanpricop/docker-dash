'use strict';

const config = require('../config');
const dockerService = require('./docker');
const forwarder = require('./log-forwarder');
const { getDb } = require('../db');
const { logReader } = require('../utils/docker-log-reader');
const log = require('../utils/logger')('log-forwarder-source');
const { isSeededHost } = require('./provisioning/seed/mock-docker');

const POLL_INTERVAL = 5000;
const MAX_STREAMS = 512;
const MAX_OPENING = 16;
const EXCLUDE = 'com.docker-dash.log-forwarding';
let timer, session;

function closeEntry(entry) {
  entry.controller?.abort();
  entry.stream?.destroy();
}

function clearSession() {
  const previous = session;
  session = undefined;
  for (const entry of previous?.entries.values() || []) closeEntry(entry);
}

function flushRecords(current, entry, records) {
  if (!records.length || session !== current || current.entries.get(entry.key) !== entry) return;
  forwarder.ingestLines(records);
}

async function open(current, entry) {
  const controller = new AbortController();
  entry.controller = controller;
  current.streamCount++;
  current.opening++;
  let opening = true;
  const opened = () => {
    if (!opening) return;
    opening = false;
    current.opening--;
    pump(current);
  };
  const deadline = setTimeout(() => controller.abort(), 15000).unref();
  const valid = () => session === current && current.entries.get(entry.key) === entry && !controller.signal.aborted;
  let stream;
  try {
    const container = dockerService.getDocker(entry.hostId).getContainer(entry.id);
    const info = await container.inspect({ abortSignal: controller.signal });
    if (!valid()) return;
    if (info.Config?.Labels?.[EXCLUDE] === 'disabled' || info.HostConfig?.LogConfig?.Type === 'none') {
      entry.excluded = true;
      return;
    }
    entry.name = info.Name?.replace(/^\//, '') || entry.name;
    const checkpoints = { ...entry.cursors };
    const replayed = { stdout: 0, stderr: 0 };
    stream = await dockerService.getContainerLogStream(entry.hostId, entry.id, {
      since: Math.max(0, Math.floor((entry.latest ?? current.since) / 1000) - 1),
      abortSignal: controller.signal,
    });
    if (!valid()) { stream.destroy(); return; }
    clearTimeout(deadline);
    entry.stream = stream;
    entry.failed = false;
    opened();
    let records = [];
    const reader = logReader(Boolean(info.Config?.Tty), record => {
      const cursor = entry.cursors[record.stream];
      const checkpoint = checkpoints[record.stream];
      if (record.milliseconds < current.since || record.timestamp < (cursor?.timestamp || '')) return;
      if (checkpoint && record.timestamp === checkpoint.timestamp && ++replayed[record.stream] <= checkpoint.count) return;
      const count = record.timestamp === cursor?.timestamp ? cursor.count + 1 : 1;
      entry.cursors[record.stream] = { timestamp: record.timestamp, count };
      entry.latest = Math.max(entry.latest ?? current.since, record.milliseconds);
      records.push({ containerId: entry.id, containerName: entry.name, hostId: entry.hostId, hostName: entry.hostName,
        timestamp: record.timestamp, stream: record.stream, line: record.line });
      if (records.length === 100) {
        flushRecords(current, entry, records);
        records = [];
      }
    });
    await new Promise((resolve, reject) => {
      stream.once('error', reject);
      stream.once('close', resolve);
      stream.once('end', () => {
        if (valid()) {
          reader.end();
          flushRecords(current, entry, records);
          records = [];
          entry.complete = true;
        }
        resolve();
      });
      stream.on('data', chunk => {
        if (!valid()) return;
        try {
          reader.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          flushRecords(current, entry, records);
          records = [];
        } catch (error) { stream.destroy(error); }
      });
    });
  } catch {
    if (session === current && current.entries.get(entry.key) === entry) {
      if (!entry.failed) log.warn('Container log stream unavailable; retrying', { hostId: entry.hostId, containerId: entry.id });
      entry.failed = true;
    }
  } finally {
    clearTimeout(deadline);
    if (stream && !stream.destroyed) stream.destroy();
    entry.controller = undefined;
    entry.stream = undefined;
    entry.retryAt = Date.now() + (entry.failed ? 30000 : POLL_INTERVAL);
    current.streamCount--;
    opened();
    pump(current);
  }
}

function pump(current) {
  if (session !== current) return;
  while (current.queue.size && current.opening < MAX_OPENING && current.streamCount < MAX_STREAMS) {
    const entry = current.queue.values().next().value;
    current.queue.delete(entry);
    if (current.entries.get(entry.key) === entry && !entry.controller) void open(current, entry);
  }
  if (current.queue.size && current.streamCount >= MAX_STREAMS && !current.limitReported) {
    current.limitReported = true;
    log.warn('Container log stream limit reached', { limit: MAX_STREAMS });
  }
}

function observe(current, host, id, name, running, restart = false) {
  if (!id || dockerService.isSelf(id)) return;
  const key = host.id + ':' + id;
  let entry = current.entries.get(key);
  if (!entry) {
    entry = { key, id, name: name || id.slice(0, 12), hostId: host.id, hostName: host.name, running, cursors: {} };
    current.entries.set(key, entry);
  }
  if (restart || (running && !entry.running)) {
    entry.complete = false;
    entry.retryAt = 0;
  }
  entry.running = running;
  if (entry.excluded || entry.controller || (!running && entry.complete) || Date.now() < (entry.retryAt || 0)) return;
  current.queue.add(entry);
  pump(current);
}

async function scanHost(current, host) {
  if (current.scanning.has(host.id)) return;
  current.scanning.add(host.id);
  const started = Date.now();
  try {
    const docker = dockerService.getDocker(host.id);
    const containers = await docker.listContainers({ all: true });
    if (session !== current || !current.hosts.has(host.id)) return;
    const seen = new Set();
    for (const item of containers) {
      seen.add(item.Id);
      const key = host.id + ':' + item.Id;
      const running = item.State === 'running' || item.State === 'paused';
      if (item.Labels?.[EXCLUDE] === 'disabled') continue;
      if (running || current.entries.has(key) || item.Created >= Math.floor(current.since / 1000)) {
        observe(current, host, item.Id, item.Names?.[0]?.replace(/^\//, ''), running);
      }
    }
    for (const [key, entry] of current.entries) {
      if (entry.hostId !== host.id || seen.has(entry.id) || entry.eventAt >= started) continue;
      current.entries.delete(key);
      closeEntry(entry);
    }
  } catch {
    // Other hosts keep streaming while this daemon is unreachable.
  } finally { current.scanning.delete(host.id); }
}

function refresh() {
  if (!timer) return;
  try {
    if (config.features.readOnly || !getDb().prepare('SELECT 1 FROM log_forwarders WHERE enabled = 1 LIMIT 1').get()) {
      clearSession();
      forwarder.stopAll();
      return;
    }
    session ||= { since: Date.now(), hosts: new Map(), entries: new Map(), scanning: new Set(),
      queue: new Set(), streamCount: 0, opening: 0 };
    const current = session;
    current.hosts = new Map(dockerService.getActiveHosts()
      .filter(host => ['docker', 'podman'].includes(host.daemonType || 'docker') && !host.credentialError && !isSeededHost(host.id))
      .map(host => [host.id, host]));
    for (const [key, entry] of current.entries) {
      if (current.hosts.has(entry.hostId)) continue;
      current.entries.delete(key);
      closeEntry(entry);
    }
    for (const host of current.hosts.values()) void scanHost(current, host);
  } catch { /* retry at the next poll */ }
}

function onContainerEvent(event) {
  if (!session || event.type !== 'container' || !['start', 'die', 'destroy'].includes(event.action)) return;
  const host = session.hosts.get(event.hostId);
  if (!host || event.attributes?.[EXCLUDE] === 'disabled') return;
  if (event.action === 'destroy') {
    const key = host.id + ':' + event.actorId;
    const entry = session.entries.get(key);
    if (entry && !entry.stream) {
      session.entries.delete(key);
      closeEntry(entry);
    }
    return;
  }
  observe(session, host, event.actorId, event.actorName, event.action === 'start', event.action === 'start');
  const entry = session.entries.get(host.id + ':' + event.actorId);
  if (entry) entry.eventAt = Date.now();
}

function start() {
  if (timer) return;
  timer = setInterval(refresh, POLL_INTERVAL).unref();
  refresh();
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  clearSession();
  forwarder.stopAll();
}

module.exports = { start, stop, refresh, onContainerEvent };
