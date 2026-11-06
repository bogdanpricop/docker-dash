'use strict';

const { Client } = require('ssh2');
const { getDb } = require('../db');
const { decryptSshConfig } = require('./host-config-crypto');
const { hostKeyOptions } = require('../utils/ssh-host-key');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGES = 500;

// Fixed, read-only probe. It uses the package metadata already present on the
// host and never refreshes repositories or installs anything.
const PROBE_SCRIPT = String.raw`export LC_ALL=C LANG=C
if command -v apt >/dev/null 2>&1; then
  printf '__DD_PACKAGE_MANAGER__:apt\n'
  apt list --upgradable 2>/dev/null
  printf '__DD_EXIT_CODE__:%s\n' "$?"
elif command -v dnf >/dev/null 2>&1; then
  printf '__DD_PACKAGE_MANAGER__:dnf\n'
  dnf -q --cacheonly check-update 2>&1
  printf '__DD_EXIT_CODE__:%s\n' "$?"
elif command -v yum >/dev/null 2>&1; then
  printf '__DD_PACKAGE_MANAGER__:yum\n'
  yum -q -C check-update 2>&1
  printf '__DD_EXIT_CODE__:%s\n' "$?"
elif command -v zypper >/dev/null 2>&1; then
  printf '__DD_PACKAGE_MANAGER__:zypper\n'
  zypper --non-interactive --no-refresh list-updates 2>&1
  printf '__DD_EXIT_CODE__:%s\n' "$?"
elif command -v apk >/dev/null 2>&1; then
  printf '__DD_PACKAGE_MANAGER__:apk\n'
  apk version -l '<' 2>&1
  printf '__DD_EXIT_CODE__:%s\n' "$?"
elif command -v pacman >/dev/null 2>&1; then
  printf '__DD_PACKAGE_MANAGER__:pacman\n'
  pacman -Qu 2>&1
  printf '__DD_EXIT_CODE__:%s\n' "$?"
else
  printf '__DD_PACKAGE_MANAGER__:unsupported\n__DD_EXIT_CODE__:127\n'
fi`;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveHost(hostId) {
  const db = getDb();
  const id = Number.parseInt(hostId, 10) || 0;
  if (id > 0) {
    return db.prepare('SELECT id, name, is_active, ssh_config FROM docker_hosts WHERE id = ?').get(id) || null;
  }
  return db.prepare('SELECT id, name, is_active, ssh_config FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT id, name, is_active, ssh_config FROM docker_hosts ORDER BY id LIMIT 1').get()
    || null;
}

function runProbe(connection, { timeoutMs = 30000 } = {}) {
  const identity = hostKeyOptions(connection);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let stream = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stream?.destroy(); } catch { /* best effort */ }
      try { client.end(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(result);
    };
    const append = (chunk, target) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        const error = new Error('Host package check returned too much output');
        error.code = 'HOST_UPDATE_OUTPUT_LIMIT';
        finish(error);
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    const timer = setTimeout(() => {
      const error = new Error('Host package check timed out');
      error.code = 'HOST_UPDATE_TIMEOUT';
      finish(error);
    }, timeoutMs);

    client.on('ready', () => {
      client.exec(`sh -c ${shellQuote(PROBE_SCRIPT)}`, { pty: false }, (error, channel) => {
        if (error) return finish(error);
        stream = channel;
        channel.on('data', chunk => append(chunk, 'stdout'));
        channel.stderr.on('data', chunk => append(chunk, 'stderr'));
        channel.on('error', finish);
        channel.on('close', exitCode => finish(null, { stdout, stderr, exitCode }));
      });
    });
    client.on('error', finish);
    client.on('close', () => {
      if (!settled && !stream) finish(new Error('SSH connection closed before the host package check started'));
    });

    const options = {
      ...identity,
      host: connection.host,
      port: connection.port || 22,
      username: connection.username,
      readyTimeout: Math.min(timeoutMs, 15000),
      keepaliveInterval: 5000,
      keepaliveCountMax: 2,
    };
    if (connection.privateKey) {
      options.privateKey = connection.privateKey;
      if (connection.passphrase) options.passphrase = connection.passphrase;
    } else {
      options.password = connection.password;
    }
    try { client.connect(options); } catch (error) { finish(error); }
  });
}

function parseApt(lines) {
  return lines.flatMap(line => {
    const match = line.match(/^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*(.+?)\]$/);
    return match ? [{ name: match[1], oldVersion: match[3], newVersion: match[2] }] : [];
  });
}

function parseRpm(lines) {
  return lines.flatMap(line => {
    const value = line.trim();
    if (!value || /^(Last metadata|Obsoleting Packages|Security:|Update notice)/i.test(value)) return [];
    const parts = value.split(/\s+/);
    if (parts.length < 3 || !/^[A-Za-z0-9_+.-]+\.[A-Za-z0-9_+-]+$/.test(parts[0])) return [];
    const dot = parts[0].lastIndexOf('.');
    return [{ name: parts[0].slice(0, dot), architecture: parts[0].slice(dot + 1), oldVersion: '?', newVersion: parts[1] }];
  });
}

function parseZypper(lines) {
  return lines.flatMap(line => {
    const parts = line.split('|').map(value => value.trim());
    if (parts.length < 6 || parts[0] !== 'v') return [];
    return [{ name: parts[2], oldVersion: parts[3], newVersion: parts[4], architecture: parts[5] }];
  });
}

function parseApk(lines) {
  return lines.flatMap(line => {
    const match = line.trim().match(/^(.+)-([0-9][^\s]*)\s+<\s+(\S+)$/);
    return match ? [{ name: match[1], oldVersion: match[2], newVersion: match[3] }] : [];
  });
}

function parsePacman(lines) {
  return lines.flatMap(line => {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+->\s+(\S+)$/);
    return match ? [{ name: match[1], oldVersion: match[2], newVersion: match[3] }] : [];
  });
}

function parseProbe(output) {
  const lines = String(output || '').replace(/\r/g, '').split('\n');
  const managerLine = lines.find(line => line.startsWith('__DD_PACKAGE_MANAGER__:'));
  const exitLine = lines.find(line => line.startsWith('__DD_EXIT_CODE__:'));
  const manager = managerLine?.slice('__DD_PACKAGE_MANAGER__:'.length) || 'unknown';
  const exitCode = Number.parseInt(exitLine?.slice('__DD_EXIT_CODE__:'.length), 10);
  const content = lines.filter(line => !line.startsWith('__DD_'));
  const parser = {
    apt: parseApt,
    dnf: parseRpm,
    yum: parseRpm,
    zypper: parseZypper,
    apk: parseApk,
    pacman: parsePacman,
  }[manager];
  const packages = parser ? parser(content) : [];
  const acceptedExitCodes = manager === 'dnf' || manager === 'yum' ? [0, 100] : [0, 1];
  return {
    manager,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    packages,
    error: manager === 'unsupported'
      ? 'No supported package manager was found on the selected host'
      : (!parser || !acceptedExitCodes.includes(exitCode) ? 'The host package manager could not complete the update check' : null),
  };
}

async function checkHostPackageUpdates(hostId) {
  const host = resolveHost(hostId);
  if (!host) return { total: 0, packages: [], updateAvailable: false, available: false, error: 'Selected host was not found' };
  if (!host.is_active) return { total: 0, packages: [], updateAvailable: false, available: false, hostId: host.id, hostName: host.name, error: 'Selected host is inactive' };
  if (!host.ssh_config) {
    return { total: 0, packages: [], updateAvailable: false, available: false, hostId: host.id, hostName: host.name,
      error: 'Configure pinned SSH access for this host to check host packages' };
  }

  const connection = decryptSshConfig(host.ssh_config) || {};
  if (!connection.host || !connection.username || !(connection.privateKey || connection.password)) {
    return { total: 0, packages: [], updateAvailable: false, available: false, hostId: host.id, hostName: host.name,
      error: 'The selected host has incomplete SSH credentials' };
  }

  const probe = await runProbe(connection);
  const parsed = parseProbe(probe.stdout + '\n' + probe.stderr);
  const packages = parsed.packages
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PACKAGES);
  return {
    hostId: host.id,
    hostName: host.name,
    source: 'host-ssh',
    packageManager: parsed.manager,
    checkedAt: new Date().toISOString(),
    available: !parsed.error,
    total: parsed.packages.length,
    packages,
    truncated: parsed.packages.length > packages.length,
    updateAvailable: parsed.packages.length > 0,
    error: parsed.error,
  };
}

module.exports = {
  checkHostPackageUpdates,
  _internals: { PROBE_SCRIPT, parseProbe, parseApt, parseRpm, parseZypper, parseApk, parsePacman, shellQuote },
};
