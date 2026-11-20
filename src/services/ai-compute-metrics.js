'use strict';

const { getDb } = require('../db');
const docker = require('./docker');
const ssh = require('./ssh-tunnel');

// Fixed commands only. Missing NVIDIA fields stay null on unified-memory GPUs.
const command = `printf 'CPU\\n'; head -n 1 /proc/stat; printf 'MEM\\n'; cat /proc/meminfo;
printf 'DISK\\n'; df -B1 --output=size,avail / | tail -n 1;
printf 'NET\\n'; cat /proc/net/dev;
printf 'GPU\\n'; nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null`;
const pending = new Map();
const parse = value => {
  const number = Number(value);
  return String(value ?? '').trim() && Number.isFinite(number) && number >= 0 ? number : null;
};

function decode(stdout, info, previous) {
  const parts = Object.fromEntries([...stdout.matchAll(/^(CPU|MEM|DISK|NET|GPU|CACHEDISK|RUNTIMEDISK)\n([\s\S]*?)(?=^(?:CPU|MEM|DISK|NET|GPU|CACHEDISK|RUNTIMEDISK)\n|$(?![\s\S]))/gm)]
    .map(match => [match[1], match[2]]));
  const memory = Object.fromEntries([...String(parts.MEM || '').matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB/gm)]
    .map(match => [match[1], Number(match[2]) * 1024]));
  const cpu = (parts.CPU || '').trim().split(/\s+/).slice(1, 9).map(Number);
  const total = cpu.length === 8 ? cpu.reduce((sum, value) => sum + value, 0) : null;
  const idle = cpu.length === 8 ? cpu[3] + cpu[4] : null;
  const delta = total - previous?.cpuTotal;
  const busy = delta > 0 ? 100 * (1 - (idle - previous.cpuIdle) / delta) : null;
  const disk = (parts.DISK || '').trim().split(/\s+/).map(parse);
  const cacheDisk = (parts.CACHEDISK || '').trim().split(/\s+/).map(parse);
  const runtimeDisk = (parts.RUNTIMEDISK || '').trim().split(/\s+/).map(parse);
  const gpu = (parts.GPU || '').trim().split('\n')[0].split(',').map(value => value.trim());
  const unified = /GB10/i.test(gpu[0] || '');
  const network = [...String(parts.NET || '').matchAll(/^\s*([^:]+):\s*(.+)$/gm)]
    .filter(match => match[1].trim() !== 'lo').map(match => match[2].trim().split(/\s+/).map(Number));
  const rx = network.reduce((sum, row) => sum + row[0], 0), tx = network.reduce((sum, row) => sum + row[8], 0);
  const at = new Date().toISOString();
  const seconds = previous ? (Date.parse(at) - Date.parse(previous.sampledAt)) / 1000 : 0;
  return { sampledAt: at, architecture: info.Architecture, cpus: info.NCPU, unified,
    cpuPercent: Number.isFinite(busy) ? Math.max(0, Math.min(100, busy)) : null, cpuTotal: total, cpuIdle: idle,
    memory: memory.MemTotal && Number.isFinite(memory.MemAvailable) ? { totalBytes: memory.MemTotal,
      availableBytes: memory.MemAvailable, usedBytes: memory.MemTotal - memory.MemAvailable,
      swapTotalBytes: memory.SwapTotal ?? null, swapUsedBytes: memory.SwapTotal - memory.SwapFree } : null,
    disk: disk.length === 2 && disk.every(Number.isFinite) ? { totalBytes: disk[0], availableBytes: disk[1] } : null,
    cacheDisk: cacheDisk.length === 2 && cacheDisk.every(Number.isFinite) ? { totalBytes: cacheDisk[0], availableBytes: cacheDisk[1] } : null,
    runtimeDisk: runtimeDisk.length === 2 && runtimeDisk.every(Number.isFinite) ? { totalBytes: runtimeDisk[0], availableBytes: runtimeDisk[1] } : null,
    gpu: gpu.length === 6 ? { name: gpu[0], utilizationPercent: parse(gpu[1]), temperatureC: parse(gpu[2]),
      powerWatts: parse(gpu[3]), totalBytes: unified ? null : parse(gpu[4]) === null ? null : parse(gpu[4]) * 1024 ** 2,
      usedBytes: unified ? null : parse(gpu[5]) === null ? null : parse(gpu[5]) * 1024 ** 2 } : null,
    network: { rxBytes: rx, txBytes: tx, rxBytesPerSecond: seconds > 0 && rx >= previous.network?.rxBytes ? (rx - previous.network.rxBytes) / seconds : null,
      txBytesPerSecond: seconds > 0 && tx >= previous.network?.txBytes ? (tx - previous.network.txBytes) / seconds : null } };
}

async function sample(hostId, force = false) {
  if (pending.has(hostId)) return pending.get(hostId);
  const db = getDb();
  const row = db.prepare('SELECT sample_json FROM ai_compute_samples WHERE host_id=? ORDER BY bucket DESC LIMIT 1').get(hostId);
  const previous = row ? JSON.parse(row.sample_json) : null;
  if (!force && previous && Date.now() - Date.parse(previous.sampledAt) < 30000) return previous;
  const task = (async () => {
    const info = await docker.getDocker(hostId).info();
    let result;
    try {
      let cachePath = info.DockerRootDir;
      try { cachePath = (await docker.getDocker(hostId).getVolume('docker-dash-ai-model-cache').inspect()).Mountpoint; }
      catch (err) { if (err.statusCode !== 404) cachePath = null; }
      // Only a conservative absolute host path can enter this read-only df command.
      const cacheCommand = typeof cachePath === 'string' && /^\/[a-zA-Z0-9_./-]{1,240}$/.test(cachePath)
        ? `\nprintf 'CACHEDISK\\n'; df -B1 --output=size,avail '${cachePath}' 2>/dev/null | tail -n 1` : '';
      const runtimeCommand = typeof info.DockerRootDir === 'string' && /^\/[a-zA-Z0-9_./-]{1,240}$/.test(info.DockerRootDir)
        ? `\nprintf 'RUNTIMEDISK\\n'; df -B1 --output=size,avail '${info.DockerRootDir}' 2>/dev/null | tail -n 1` : '';
      const out = await ssh.exec(hostId, command + cacheCommand + runtimeCommand, { timeoutMs: 10000 });
      result = decode(out.stdout, info, previous);
      if (!result.memory || !result.disk) result.warning = 'Some host metrics could not be collected.';
    } catch {
      result = { sampledAt: new Date().toISOString(), architecture: info.Architecture, cpus: info.NCPU,
        memory: null, disk: null, gpu: null, warning: 'Verified SSH access is required for host metrics.' };
    }
    db.prepare('INSERT OR REPLACE INTO ai_compute_samples(host_id,bucket,sampled_at,sample_json) VALUES (?,?,?,?)')
      .run(hostId, Math.floor(Date.now() / 60000), result.sampledAt, JSON.stringify(result));
    db.prepare('DELETE FROM ai_compute_samples WHERE bucket < ?').run(Math.floor(Date.now() / 60000) - 43200);
    return result;
  })();
  pending.set(hostId, task);
  try { return await task; } finally { pending.delete(hostId); }
}

function history(hostId, hours) {
  const minutes = Number(hours) * 60;
  if (![60, 1440, 10080, 43200].includes(minutes)) throw Object.assign(new Error('Invalid history range'), { status: 400 });
  const rows = getDb().prepare('SELECT bucket,sample_json FROM ai_compute_samples WHERE host_id=? AND bucket>=? ORDER BY bucket')
    .all(hostId, Math.floor(Date.now() / 60000) - minutes);
  const stride = Math.max(1, Math.ceil(rows.length / 400));
  return rows.filter((_, index) => index % stride === 0 || index === rows.length - 1).map(row => JSON.parse(row.sample_json));
}

async function capture() {
  const hosts = getDb().prepare('SELECT a.host_id FROM ai_compute_hosts a JOIN docker_hosts h ON h.id=a.host_id WHERE a.monitoring=1 AND h.is_active=1').all();
  for (const host of hosts) {
    try { await sample(host.host_id); } catch { /* The last successful sample remains dated in the UI. */ }
  }
}

module.exports = { sample, history, capture, decode };
