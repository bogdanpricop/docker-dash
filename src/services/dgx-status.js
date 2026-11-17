'use strict';

const docker = require('./docker');
const ssh = require('./ssh-tunnel');
const dgx = require('./ai/dgx');

function number(value) {
  const parsed = Number(value);
  return String(value ?? '').trim() && Number.isFinite(parsed) ? parsed : null;
}

async function status(hostId) {
  const client = docker.getDocker(hostId);
  const info = await client.info();
  const result = { sampledAt: new Date().toISOString(), architecture: info.Architecture, gateway: null, gpu: null, memory: null, errors: [] };
  const outcomes = await Promise.allSettled([
    dgx.test(),
    ssh.exec(hostId, 'nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu --format=csv,noheader,nounits; printf "\nDGX_MEMINFO\n"; head -n 6 /proc/meminfo', { timeoutMs: 8000 }),
  ]);
  const [gateway, metrics] = outcomes;
  if (gateway.status === 'fulfilled') result.gateway = { available: true, ...gateway.value };
  else result.gateway = { available: false, error: gateway.reason.message };
  if (metrics.status === 'fulfilled') {
    const [gpu, memory] = metrics.value.stdout.split('DGX_MEMINFO');
    const row = gpu.trim().split('\n')[0].split(',').map(value => value.trim());
    if (row.length === 3) result.gpu = { name: row[0], utilizationPercent: number(row[1]), temperatureC: number(row[2]) };
    else result.errors.push('GPU metrics unavailable. Check NVIDIA drivers and nvidia-smi.');
    const fields = Object.fromEntries(Array.from((memory || '').matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB/gm), match => [match[1], Number(match[2]) * 1024]));
    if (fields.MemTotal && fields.MemAvailable !== undefined) result.memory = { totalBytes: fields.MemTotal, usedBytes: fields.MemTotal - fields.MemAvailable };
    else result.errors.push('Unified memory metrics unavailable.');
  } else result.errors.push(metrics.reason.message);
  return result;
}

module.exports = { status, number };
