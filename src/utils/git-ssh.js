'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { utils } = require('ssh2');

const invalid = message => Object.assign(new Error(message), { status: 400 });

function validHost(value) {
  if (/^\|1\|[A-Za-z0-9+/]{27}=\|[A-Za-z0-9+/]{27}=$/.test(value)) return true;
  const portHost = /^\[([^\]]+)\]:([0-9]{1,5})$/.exec(value);
  if (portHost) {
    if (Number(portHost[2]) < 1 || Number(portHost[2]) > 65535) return false;
    value = portHost[1];
  }
  return net.isIP(value) > 0 || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value);
}

function validateKnownHosts(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw invalid('SSH known_hosts must be text of at most 64 KiB');
  }
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length || lines.length > 128) throw invalid('Verified SSH known_hosts is required (1–128 server keys)');
  return lines.map(line => {
    const [hosts, type, encoded] = line.split(/\s+/);
    if (!hosts?.split(',').every(validHost) || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(type || '')
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded || '') || encoded.length > 16384) {
      throw invalid('Invalid SSH known_hosts entry: use exact host names and supported public server keys');
    }
    const key = utils.parseKey(`${type} ${encoded}`);
    if (key instanceof Error || Array.isArray(key) || key.type !== type
      || key.getPublicSSH().toString('base64') !== encoded) throw invalid('Invalid SSH server public key');
    return `${hosts} ${type} ${encoded}`;
  }).join('\n') + '\n';
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|SSH_|EDITOR$|VISUAL$|PAGER$|PREFIX$)/i.test(key)));
}

// Git interprets GIT_SSH_COMMAND through its POSIX shell, including Git for Windows.
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

function createSession({ privateKey, knownHosts, caCertificate, temporaryRoot = os.tmpdir() } = {}) {
  const env = { ...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_SSH_VARIANT: 'ssh',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_COMMITTER_NAME: 'Docker Dash', GIT_COMMITTER_EMAIL: 'noreply@docker-dash.local',
    GIT_SSH_COMMAND: 'exit 1' };
  if (!privateKey && !caCertificate) return { env, dispose() {} };
  const trust = privateKey ? validateKnownHosts(knownHosts) : null;
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'dd-git-ssh-'));
  const dispose = () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(temporaryRoot)
      || !path.basename(directory).startsWith('dd-git-ssh-')) throw new Error('Invalid Git SSH temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    fs.chmodSync(directory, 0o700);
    if (caCertificate) {
      const caFile = path.join(directory, 'ca.pem');
      fs.writeFileSync(caFile, caCertificate, { mode: 0o600, flag: 'wx' });
      env.GIT_SSL_CAINFO = caFile;
    }
    if (!privateKey) return { env, dispose, directory };
    const keyFile = path.join(directory, 'identity'), hostsFile = path.join(directory, 'known_hosts');
    for (const [file, data] of [[keyFile, privateKey], [hostsFile, trust]]) fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    const portable = file => process.platform === 'win32' ? file.replace(/\\/g, '/') : file;
    if (/["\x00-\x1f]/.test(hostsFile)) throw invalid('Unsupported SSH temporary directory path');
    const args = ['ssh', '-F', 'none', '-i', portable(keyFile), '-o', `UserKnownHostsFile="${portable(hostsFile)}"`,
      '-o', 'GlobalKnownHostsFile=none', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey',
      '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1'];
    env.GIT_SSH_COMMAND = args.map(shellQuote).join(' ');
    return { env, dispose, directory };
  } catch (error) { dispose(); throw error; }
}

module.exports = { validateKnownHosts, createSession };
