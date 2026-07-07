'use strict';

// v8.9.x-alpha — ESXi SSH telemetry (esxcli / vim-cmd) — batch 3 of the
// vSphere feature expansion.
//
// WHY THIS EXISTS
//   The SOAP client in ./vsphere.js already returns host CPU/mem/uptime/
//   version/build, VM list, datastores, networks, services and host info
//   (DNS/NTP/BIOS/serial/license/boot). This module is DELIBERATELY narrow:
//   it collects ONLY the telemetry the SOAP API cannot easily surface —
//   physical hardware sensors (fans/PSU/temp/voltage), installed patches
//   (VIBs), and physical NIC link state — by running a CURATED set of
//   READ-ONLY esxcli commands over SSH.
//
// CONNECTION
//   Reuses the same daemon_config crypto as the SOAP client. In addition to
//   { endpoint, username, password, skipTlsVerify } the host's daemon_config
//   may carry an OPTIONAL `sshConfig = { host, port?, user, privateKey|password,
//   passphrase? }` (identical shape to the Proxmox SSH config used by
//   migration-vm.js). SSH telemetry is only available when sshConfig is set.
//
// SECURITY / ROBUSTNESS
//   - Every command is a STATIC string. No user input is ever interpolated
//     into a shell command, so there is no injection surface.
//   - Commands are strictly read-only (get / list). Nothing mutates state.
//   - stdout is capped (MAX_STDOUT_BYTES) so a runaway command can't OOM us.
//   - Per-command timeout + an SSH connect timeout. conn.end() in finally.
//   - Connect errors are mapped to friendly messages: connection refused ->
//     "SSH not enabled on this ESXi host", auth failure, host unreachable, etc.
//
// JSON-FIRST PARSING
//   esxcli accepts a global `--formatter=json` option (esxcli 6.5+). We use it
//   for every command here and JSON.parse the result, falling back to null on
//   parse failure. The parsers are tolerant of key casing/spacing differences
//   between ESXi 6.7 / 7.0 / 8.0 via a normalized `pick()` lookup, so they hold
//   up across versions without brittle exact-key matching.

const { Client: SshClient } = require('ssh2');
const { decryptDaemonConfig } = require('./vsphere');
const log = require('../utils/logger')('vsphere-ssh');

const SSH_CONNECT_TIMEOUT_MS = 20_000;
const CMD_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 512 * 1024;

// Curated read-only commands. STATIC strings only — never interpolate input.
// `--formatter=json` is a global esxcli option and goes right after `esxcli`.
const CMD = {
  version:   'esxcli --formatter=json system version get',
  hostname:  'esxcli --formatter=json system hostname get',
  platform:  'esxcli --formatter=json hardware platform get',
  cpuGlobal: 'esxcli --formatter=json hardware cpu global get',
  cpuList:   'esxcli --formatter=json hardware cpu list',
  memory:    'esxcli --formatter=json hardware memory get',
  ipmiSdr:   'esxcli --formatter=json hardware ipmi sdr list',
  vibList:   'esxcli --formatter=json software vib list',
  nicList:   'esxcli --formatter=json network nic list',
};

// ─── Public API ──────────────────────────────────────────────

/**
 * Build an SSH telemetry client bound to a docker_hosts row.
 * @param {object} row a docker_hosts row (daemon_type must be 'vsphere').
 * @returns {object} client with bound methods (testSsh/getSensors/…).
 * @throws if the row is not a vSphere host, or has no usable sshConfig.
 */
function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'vsphere') {
    throw new Error(`fromHostRow: row is not a vSphere host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config: ${e.message}`); }
  const sshConfig = cfg.sshConfig;
  _validateSshConfig(sshConfig);
  return {
    sshConfig,
    testSsh:    () => testSsh(sshConfig),
    getSensors: () => getSensors(sshConfig),
    getVibs:    () => getVibs(sshConfig),
    getNics:    () => getNics(sshConfig),
    getSystem:  () => getSystem(sshConfig),
    collectAll: () => collectAll(sshConfig),
  };
}

/** Trivial connectivity probe for a "Test SSH" button. */
async function testSsh(sshConfig) {
  const ssh = await _connectSsh(sshConfig);
  try {
    const parsed = await _runJson(ssh, CMD.version);
    const v = parseVersion(parsed);
    return { ok: true, version: v.version, product: v.product, build: v.build };
  } finally { _end(ssh); }
}

/** Physical hardware sensors via IPMI SDR (server-class BMC hardware only). */
async function getSensors(sshConfig) {
  const ssh = await _connectSsh(sshConfig);
  try { return parseSensors(await _runJson(ssh, CMD.ipmiSdr)); }
  finally { _end(ssh); }
}

/** Installed patches / VIBs. */
async function getVibs(sshConfig) {
  const ssh = await _connectSsh(sshConfig);
  try { return parseVibs(await _runJson(ssh, CMD.vibList)); }
  finally { _end(ssh); }
}

/** Physical NICs (link/speed/duplex/driver/MAC). */
async function getNics(sshConfig) {
  const ssh = await _connectSsh(sshConfig);
  try { return parseNics(await _runJson(ssh, CMD.nicList)); }
  finally { _end(ssh); }
}

/** System summary (version/hostname/platform/cpu/memory). */
async function getSystem(sshConfig) {
  const ssh = await _connectSsh(sshConfig);
  try {
    const version   = await _runJsonSafe(ssh, CMD.version);
    const hostname  = await _runJsonSafe(ssh, CMD.hostname);
    const platform  = await _runJsonSafe(ssh, CMD.platform);
    const cpuGlobal = await _runJsonSafe(ssh, CMD.cpuGlobal);
    const cpuList   = await _runJsonSafe(ssh, CMD.cpuList);
    const memory    = await _runJsonSafe(ssh, CMD.memory);
    return parseSystem({ version, hostname, platform, cpuGlobal, cpuList, memory });
  } finally { _end(ssh); }
}

/**
 * Best-effort collect of every section over a SINGLE connection. A failing
 * sub-command yields null for that section rather than failing the whole call.
 * @returns {Promise<{sensors, vibs, nics, system}>}
 */
async function collectAll(sshConfig) {
  const ssh = await _connectSsh(sshConfig);
  try {
    const sensors = await _section('sensors', () => _runJson(ssh, CMD.ipmiSdr).then(parseSensors));
    const vibs    = await _section('vibs',    () => _runJson(ssh, CMD.vibList).then(parseVibs));
    const nics    = await _section('nics',    () => _runJson(ssh, CMD.nicList).then(parseNics));
    const system  = await _section('system',  async () => {
      const version   = await _runJsonSafe(ssh, CMD.version);
      const hostname  = await _runJsonSafe(ssh, CMD.hostname);
      const platform  = await _runJsonSafe(ssh, CMD.platform);
      const cpuGlobal = await _runJsonSafe(ssh, CMD.cpuGlobal);
      const cpuList   = await _runJsonSafe(ssh, CMD.cpuList);
      const memory    = await _runJsonSafe(ssh, CMD.memory);
      return parseSystem({ version, hostname, platform, cpuGlobal, cpuList, memory });
    });
    return { sensors, vibs, nics, system };
  } finally { _end(ssh); }
}

// ─── SSH plumbing (mirrors migration-vm.js idiom) ────────────

function _validateSshConfig(sshConfig) {
  if (!sshConfig || typeof sshConfig !== 'object') {
    throw new Error('SSH telemetry unavailable: this host has no daemon_config.sshConfig. ' +
      'Add sshConfig { host, user, privateKey|password } to enable esxcli/vim-cmd collection.');
  }
  if (!sshConfig.host || !sshConfig.user || !(sshConfig.privateKey || sshConfig.password)) {
    throw new Error('daemon_config.sshConfig requires host, user, and privateKey or password.');
  }
}

async function _connectSsh(sshConfig) {
  _validateSshConfig(sshConfig);
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const timer = setTimeout(() => {
      try { client.end(); } catch { /* ignore */ }
      reject(new Error(`SSH connect timeout after ${SSH_CONNECT_TIMEOUT_MS / 1000}s to ${sshConfig.host}`));
    }, SSH_CONNECT_TIMEOUT_MS);
    client.on('ready', () => { clearTimeout(timer); resolve(client); });
    client.on('error', (err) => { clearTimeout(timer); reject(_friendlySshError(err, sshConfig)); });
    client.connect({
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.user,
      privateKey: sshConfig.privateKey,
      passphrase: sshConfig.passphrase,
      password: sshConfig.password,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    });
  });
}

async function _sshExec(ssh, command, opts = {}) {
  const timeoutMs = opts.timeoutMs || CMD_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let truncated = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`SSH exec timeout after ${timeoutMs / 1000}s: ${command.slice(0, 80)}`));
    }, timeoutMs);
    ssh.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => {
        if (stdout.length >= MAX_STDOUT_BYTES) { truncated = true; return; }
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_STDOUT_BYTES) { stdout = stdout.slice(0, MAX_STDOUT_BYTES); truncated = true; }
      });
      stream.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_STDOUT_BYTES) stderr += chunk.toString('utf8');
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, code, truncated });
      });
    });
  });
}

/** Exec a command and JSON.parse its stdout; throw a friendly error on failure. */
async function _runJson(ssh, command) {
  const { stdout, stderr, code } = await _sshExec(ssh, command);
  if (code !== 0) throw _cmdError(command, code, stderr);
  const parsed = parseJson(stdout);
  if (parsed == null) throw new Error(`Could not parse JSON output of: ${command}`);
  return parsed;
}

/** Like _runJson but returns null (and logs) instead of throwing. */
async function _runJsonSafe(ssh, command) {
  try { return await _runJson(ssh, command); }
  catch (e) { log.debug('esxcli command failed (best-effort)', { command, error: e.message }); return null; }
}

async function _section(name, fn) {
  try { return await fn(); }
  catch (e) { log.warn('collectAll section failed', { section: name, error: e.message }); return null; }
}

function _end(ssh) { try { ssh.end(); } catch { /* ignore */ } }

function _friendlySshError(err, sshConfig) {
  const host = (sshConfig && sshConfig.host) || 'host';
  const port = (sshConfig && sshConfig.port) || 22;
  const code = err && err.code;
  if (code === 'ECONNREFUSED') {
    return new Error(`SSH not enabled on this ESXi host (connection refused by ${host}:${port}). ` +
      'Enable it in the ESXi UI: Host → Actions → Services → Enable Secure Shell (SSH).');
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new Error(`ESXi host ${host} is unreachable over SSH (${code}).`);
  }
  if (code === 'ENOTFOUND') {
    return new Error(`ESXi host ${host} could not be resolved (DNS lookup failed).`);
  }
  const msg = (err && err.message) || String(err);
  if (/authentication|permission denied|all configured authentication methods failed/i.test(msg)) {
    return new Error(`SSH authentication failed for ${(sshConfig && sshConfig.user) || 'user'}@${host}. ` +
      'Check the username and key/password.');
  }
  return err instanceof Error ? err : new Error(msg);
}

function _cmdError(command, code, stderr) {
  const s = (stderr || '').trim();
  if (/not found|no such|unknown command|invalid command/i.test(s)) {
    return new Error(`Command unavailable on this ESXi host: ${command}${s ? ' — ' + s.slice(0, 120) : ''}`);
  }
  if (/permission|not allowed|denied/i.test(s)) {
    return new Error(`Permission denied running: ${command}${s ? ' — ' + s.slice(0, 120) : ''}`);
  }
  return new Error(`Command exited ${code}: ${command}${s ? ' — ' + s.slice(0, 160) : ''}`);
}

// ─── Pure parsers (unit-tested via _internals) ───────────────

/** Normalize a key to lowercase alphanumerics for tolerant lookup. */
function _norm(key) { return String(key).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** Tolerant JSON.parse: accepts already-parsed objects, tolerates a leading
 *  shell banner, returns null on failure. */
function parseJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const str = String(text).trim();
  if (!str) return null;
  try { return JSON.parse(str); } catch { /* try to locate the JSON body */ }
  const start = str.search(/[[{]/);
  if (start > 0) {
    try { return JSON.parse(str.slice(start)); } catch { /* give up */ }
  }
  return null;
}

/** First meaningful value for any of `candidates`, matched key-insensitively. */
function pick(obj, candidates, dflt = null) {
  if (!obj || typeof obj !== 'object') return dflt;
  const map = {};
  for (const k of Object.keys(obj)) map[_norm(k)] = obj[k];
  for (const c of candidates) {
    const v = map[_norm(c)];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return dflt;
}

function asArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return [];
}

function firstRow(parsed) {
  if (Array.isArray(parsed)) return parsed[0] || null;
  if (parsed && typeof parsed === 'object') return parsed;
  return null;
}

function _int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function _asBool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  return /^(true|yes|1|enabled)$/i.test(String(v).trim());
}

/** esxcli system version get */
function parseVersion(parsed) {
  const r = firstRow(parsed) || {};
  return {
    product: pick(r, ['Product', 'ProductName']),
    version: pick(r, ['Version']),
    build:   pick(r, ['Build']),
    update:  pick(r, ['Update']),
    patch:   pick(r, ['Patch']),
  };
}

/** esxcli system hostname get */
function parseHostname(parsed) {
  const r = firstRow(parsed) || {};
  return {
    hostname: pick(r, ['HostName', 'Host Name']),
    fqdn:     pick(r, ['FullyQualifiedDomainName', 'FQDN']),
    domain:   pick(r, ['DomainName', 'Domain Name']),
  };
}

/** esxcli hardware platform get */
function parsePlatform(parsed) {
  const r = firstRow(parsed) || {};
  return {
    vendor: pick(r, ['VendorName', 'Vendor', 'Vendor Name']),
    model:  pick(r, ['ProductName', 'Product Name', 'Model']),
    serial: pick(r, ['SerialNumber', 'Serial Number']),
    uuid:   pick(r, ['UUID']),
    enclosureSerial: pick(r, ['EnclosureSerialNumber', 'Enclosure Serial Number']),
    ipmiSupported:   _asBool(pick(r, ['IPMISupported', 'IPMI Supported'])),
  };
}

/** esxcli hardware cpu global get (+ hardware cpu list for the brand string) */
function parseCpu(cpuGlobalParsed, cpuListParsed) {
  const g = firstRow(cpuGlobalParsed) || {};
  const first = firstRow(cpuListParsed) || {};
  return {
    model:    pick(first, ['Brand', 'Model', 'CPU Brand']),
    cores:    _int(pick(g, ['CPUCores', 'CPU Cores'])),
    threads:  _int(pick(g, ['CPUThreads', 'CPU Threads'])),
    packages: _int(pick(g, ['CPUPackages', 'CPU Packages'])),
    hyperthreadingActive: _asBool(pick(g, ['HyperthreadingActive', 'Hyperthreading Active'])),
  };
}

/** esxcli hardware memory get */
function parseMemory(parsed) {
  const r = firstRow(parsed) || {};
  return {
    memoryBytes: _int(pick(r, ['PhysicalMemory', 'Physical Memory'])),
    numaNodes:   _int(pick(r, ['NUMANodeCount', 'NUMA Node Count'])),
  };
}

/** Combine the system sub-command outputs into one card. Returns null if
 *  nothing at all came back. */
function parseSystem(inputs) {
  const { version = null, hostname = null, platform = null,
    cpuGlobal = null, cpuList = null, memory = null } = inputs || {};
  if (version == null && hostname == null && platform == null &&
      cpuGlobal == null && cpuList == null && memory == null) return null;
  const v = parseVersion(version);
  const h = parseHostname(hostname);
  const p = parsePlatform(platform);
  const c = parseCpu(cpuGlobal, cpuList);
  const m = parseMemory(memory);
  return {
    version: v.version,
    product: v.product,
    build: v.build,
    update: v.update,
    patch: v.patch,
    hostname: h.hostname,
    fqdn: h.fqdn,
    domain: h.domain,
    platform: {
      vendor: p.vendor, model: p.model, serial: p.serial, uuid: p.uuid,
      enclosureSerial: p.enclosureSerial, ipmiSupported: p.ipmiSupported,
    },
    cpu: { model: c.model, cores: c.cores, threads: c.threads, packages: c.packages },
    memoryBytes: m.memoryBytes,
    numaNodes: m.numaNodes,
  };
}

/** esxcli software vib list */
function parseVibs(parsed) {
  return asArray(parsed).map(r => ({
    name: pick(r, ['Name']),
    version: pick(r, ['Version']),
    vendor: pick(r, ['Vendor']),
    acceptanceLevel: pick(r, ['AcceptanceLevel', 'Acceptance Level']),
    installDate: pick(r, ['InstallDate', 'Install Date']),
    creationDate: pick(r, ['CreationDate', 'Creation Date']),
    id: pick(r, ['ID', 'Id']),
  })).filter(v => v.name);
}

/** esxcli network nic list */
function parseNics(parsed) {
  return asArray(parsed).map(r => ({
    name: pick(r, ['Name']),
    driver: pick(r, ['Driver']),
    link: pick(r, ['Link', 'LinkStatus', 'Link Status']),
    speedMbps: _int(pick(r, ['Speed', 'LinkSpeed', 'Link Speed'])),
    duplex: pick(r, ['Duplex']),
    mac: pick(r, ['MACAddress', 'MAC Address', 'MAC']),
    description: pick(r, ['Description']),
    mtu: _int(pick(r, ['MTU'])),
    pciDevice: pick(r, ['PCIDevice', 'PCI Device']),
    adminStatus: pick(r, ['AdminStatus', 'Admin Status']),
  })).filter(n => n.name);
}

/** Classify a sensor health/state string into ok / warning / critical / unknown. */
function _sensorSeverity(state) {
  if (state === null || state === undefined || state === '') return 'unknown';
  const s = String(state).toLowerCase();
  if (/critical|non-?recoverable|fail|error|\bred\b/.test(s)) return 'critical';
  if (/warn|degrad|yellow|assert/.test(s)) return 'warning';
  if (/normal|\bok\b|healthy|good|present|\bgreen\b|enabled/.test(s)) return 'ok';
  return 'unknown';
}

/** esxcli hardware ipmi sdr list -> categorized sensor buckets + overall. */
function parseSensors(parsed) {
  const rows = asArray(parsed);
  const out = { fans: [], powerSupplies: [], temperatures: [], voltages: [], other: [] };
  const degraded = [];
  let anyCritical = false;
  let anyWarning = false;
  for (const r of rows) {
    const name = pick(r, ['Name', 'SensorName', 'Sensor', 'Description', 'Id', 'SensorNumber']);
    const type = String(pick(r, ['SensorType', 'Type', 'EntityName']) || '');
    const reading = pick(r, ['Reading', 'SensorReading', 'Value', 'Reading Value']);
    const units = pick(r, ['Units', 'Unit', 'BaseUnit', 'SensorUnits', 'RateUnit']);
    const state = pick(r, ['SensorState', 'State', 'Health', 'Status', 'ReadingState', 'Reading State']);
    const severity = _sensorSeverity(state);
    const entry = { name, type: type || null, reading: _num(reading), units: units || null, state: state || null, severity };

    const t = type.toLowerCase();
    const n = String(name || '').toLowerCase();
    if (/fan/.test(t) || /fan/.test(n)) out.fans.push(entry);
    else if (/temp/.test(t) || /temp/.test(n) || /celsius|degrees/i.test(String(units || ''))) out.temperatures.push(entry);
    else if (/volt/.test(t) || /volt/.test(n)) out.voltages.push(entry);
    else if (/power|current|watt|psu|supply/.test(t) || /psu|power supply|power unit/.test(n)) out.powerSupplies.push(entry);
    else out.other.push(entry);

    if (severity === 'critical') { anyCritical = true; degraded.push(name || type || 'sensor'); }
    else if (severity === 'warning') { anyWarning = true; degraded.push(name || type || 'sensor'); }
  }
  const total = rows.length;
  const overall = {
    total,
    degraded,
    healthy: total > 0 && degraded.length === 0,
    status: total === 0 ? 'unknown' : (anyCritical ? 'red' : anyWarning ? 'yellow' : 'green'),
  };
  return {
    fans: out.fans, powerSupplies: out.powerSupplies,
    temperatures: out.temperatures, voltages: out.voltages,
    other: out.other, overall,
  };
}

module.exports = {
  fromHostRow,
  testSsh, getSensors, getVibs, getNics, getSystem, collectAll,
  CMD,
  _internals: {
    parseJson, pick, asArray, firstRow, _norm, _int, _num, _asBool,
    parseVersion, parseHostname, parsePlatform, parseCpu, parseMemory, parseSystem,
    parseVibs, parseNics, parseSensors, _sensorSeverity,
    _validateSshConfig, _friendlySshError, _cmdError,
  },
};
