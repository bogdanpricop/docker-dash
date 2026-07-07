'use strict';

// v8.9.16-alpha.1 — deploy a public key to a target's authorized_keys over
// SSH using the existing ssh2 dep. The INITIAL connection uses a one-shot
// password or an existing private key (never stored). Idempotent: the key is
// only appended if not already present.

const { Client: SshClient } = require('ssh2');
const log = require('../utils/logger')('ssh-deploy');

const CONNECT_TIMEOUT_MS = 20_000;
const CMD_TIMEOUT_MS = 15_000;

// authorized_keys location per target type. `${user}` is substituted for the
// ESXi per-user keys directory.
function _authorizedKeysPath(targetType, user) {
  if (targetType === 'esxi') return `/etc/ssh/keys-${user || 'root'}/authorized_keys`;
  return '~/.ssh/authorized_keys'; // linux / docker / proxmox / generic
}

// Windows OpenSSH authorized_keys path. Members of the Administrators group are
// served from the machine-wide administrators_authorized_keys (the default
// sshd_config `Match Group administrators` block), NOT their profile — a very
// common gotcha. Standard users use their profile ~/.ssh.
function _windowsKeysPath(isAdmin) {
  return isAdmin
    ? 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
    : '%USERPROFILE%\\.ssh\\authorized_keys';
}

// PowerShell -EncodedCommand payload: base64 of UTF-16LE. Sidesteps ALL
// cmd.exe/PowerShell quoting when we exec over SSH (the Windows sshd default
// shell is cmd.exe, so we can't rely on POSIX quoting).
function _psEncode(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function _connect(connection) {
  return new Promise((resolve, reject) => {
    if (!connection || !connection.host || !connection.user) {
      return reject(new Error('host and user are required'));
    }
    if (!connection.password && !connection.privateKey) {
      return reject(new Error('an initial password or existing private key is required to deploy'));
    }
    const conn = new SshClient();
    const opts = {
      host: connection.host,
      port: parseInt(connection.port, 10) || 22,
      username: connection.user,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // One-shot deploy connection — we don't manage known_hosts here.
    };
    if (connection.privateKey) {
      opts.privateKey = connection.privateKey;
      if (connection.passphrase) opts.passphrase = connection.passphrase;
    } else {
      opts.password = connection.password;
    }
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(_friendly(err)));
    try { conn.connect(opts); } catch (err) { reject(err); }
  });
}

function _exec(conn, command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`command timed out: ${command.slice(0, 40)}…`)), CMD_TIMEOUT_MS);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let out = '', errOut = '', code = 0;
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { errOut += d.toString(); });
      stream.on('close', (c) => { clearTimeout(timer); code = c; resolve({ code, out, errOut }); });
    });
  });
}

/** POSIX single-quote escape (close-escape-reopen). */
function _q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function _friendly(err) {
  let m = (err && err.message) || 'SSH connection failed';
  if (/ECONNREFUSED/.test(m)) m = 'Connection refused — SSH is not enabled or the port is blocked. (On ESXi, start the SSH/TSM-SSH service.)';
  else if (/ETIMEDOUT|timed out/i.test(m)) m = 'Connection timed out — host unreachable or firewalled.';
  else if (/ENOTFOUND|EAI_AGAIN/.test(m)) m = 'Host not found — check the address.';
  else if (/authentication|All configured authentication methods failed/i.test(m)) m = 'Authentication failed — check the initial username/password (or key).';
  const e = new Error(m); e.original = (err && err.message) || null; return e;
}

// Windows deploy: ensure the key file, append idempotently, and (for admin
// accounts) lock the ACL to SYSTEM + Administrators with inheritance disabled —
// sshd rejects administrators_authorized_keys otherwise. Everything runs as one
// -EncodedCommand PowerShell payload so quoting survives the cmd.exe shell.
async function _deployWindows(conn, pk, blob, isAdmin) {
  const psq = (s) => String(s).replace(/'/g, "''"); // PowerShell single-quote literal escape
  const dirExpr = isAdmin ? "Join-Path $env:ProgramData 'ssh'" : "Join-Path $env:USERPROFILE '.ssh'";
  const fileName = isAdmin ? 'administrators_authorized_keys' : 'authorized_keys';
  // SIDs (not localized names): SYSTEM = S-1-5-18, Administrators = S-1-5-32-544.
  const acl = isAdmin
    ? "icacls $f /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null;"
    : '';
  const script = [
    "$ErrorActionPreference='Stop';",
    `$dir = ${dirExpr};`,
    `$f = Join-Path $dir '${fileName}';`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null;',
    'if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f | Out-Null; }',
    `$key = '${psq(pk)}';`,
    `$blob = '${psq(blob)}';`,
    '$c = Get-Content -Path $f -Raw -ErrorAction SilentlyContinue;',
    "if ($c -and $c.Contains($blob)) { $r='PRESENT'; } else { Add-Content -Path $f -Value $key; $r='ADDED'; }",
    acl,
    'Write-Output $r;',
  ].join(' ');
  const { code, out, errOut } = await _exec(conn, `powershell -NoProfile -NonInteractive -EncodedCommand ${_psEncode(script)}`);
  if (code !== 0) throw new Error((errOut && errOut.trim()) || `Windows deploy failed (exit ${code})`);
  return { alreadyPresent: /PRESENT/.test(out) };
}

/**
 * Append a public key to the target's authorized_keys (idempotent).
 * @param {object} p
 * @param {'linux'|'docker'|'esxi'|'proxmox'|'generic'} p.targetType
 * @param {object} p.connection { host, port, user, password | privateKey, passphrase }
 * @param {string} p.publicKey OpenSSH authorized_keys line
 * @returns {Promise<{ok, path, alreadyPresent}>}
 */
async function deployPublicKey({ targetType, connection, publicKey }) {
  if (!publicKey || !publicKey.trim()) throw new Error('publicKey is required');
  const pk = publicKey.trim();
  // The key body (base64 blob) is used for idempotent presence checks.
  const blob = pk.split(' ')[1] || pk;
  const conn = await _connect(connection);
  try {
    if (targetType === 'windows') {
      const isAdmin = !!(connection && connection.isAdmin);
      const r = await _deployWindows(conn, pk, blob, isAdmin);
      return { ok: true, path: _windowsKeysPath(isAdmin), alreadyPresent: r.alreadyPresent };
    }
    const path = _authorizedKeysPath(targetType, connection && connection.user);
    if (targetType === 'esxi') {
      // ESXi: /etc/ssh/keys-<user>/ ; busybox sh, no `install`. Ensure dir + file.
      const dir = path.replace(/\/authorized_keys$/, '');
      await _exec(conn, `mkdir -p ${_q(dir)} && touch ${_q(path)} && chmod 700 ${_q(dir)} 2>/dev/null; chmod 600 ${_q(path)} 2>/dev/null; true`);
    } else {
      await _exec(conn, `mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`);
    }
    // Idempotency: grep for the exact key body (the base64 blob) to avoid dupes.
    const check = await _exec(conn, `grep -qF ${_q(blob)} ${_q(path)} 2>/dev/null && echo PRESENT || echo ABSENT`);
    if (/PRESENT/.test(check.out)) {
      return { ok: true, path, alreadyPresent: true };
    }
    const append = await _exec(conn, `printf '%s\\n' ${_q(pk)} >> ${_q(path)}`);
    if (append.code !== 0) throw new Error(append.errOut || `failed to write ${path} (exit ${append.code})`);
    return { ok: true, path, alreadyPresent: false };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}

/** Verify a freshly-deployed key works: connect with it and run `true`. */
async function testKey({ connection, privateKey, passphrase }) {
  const conn = await _connect({ host: connection.host, port: connection.port, user: connection.user, privateKey, passphrase });
  try {
    const r = await _exec(conn, 'true');
    return { ok: r.code === 0 };
  } finally { try { conn.end(); } catch { /* ignore */ } }
}

/**
 * Pre-flight the INITIAL connection (password or existing key) WITHOUT touching
 * authorized_keys. Confirms we can log in and reports the remote user + the
 * authorized_keys path the deploy would write to.
 * @returns {Promise<{ok, whoami, path, targetType}>}
 */
async function testConnection({ targetType, connection }) {
  const conn = await _connect(connection);
  try {
    if (targetType === 'windows') {
      // Report the remote user AND whether it's an Administrator, so the wizard
      // can pick the right authorized_keys path automatically.
      const script = "$id=[Security.Principal.WindowsIdentity]::GetCurrent();"
        + "$adm=(New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator);"
        + "Write-Output ($id.Name + '|' + $adm)";
      const r = await _exec(conn, `powershell -NoProfile -NonInteractive -EncodedCommand ${_psEncode(script)}`);
      const [name, adm] = (r.out || '').trim().split('|');
      const isAdmin = /true/i.test(adm || '');
      return { ok: true, whoami: name || (connection && connection.user) || '?', isAdmin, path: _windowsKeysPath(isAdmin), targetType };
    }
    const r = await _exec(conn, 'whoami 2>/dev/null || id -un 2>/dev/null || echo "?"');
    const whoami = (r.out || '').trim() || (connection && connection.user) || '?';
    return { ok: true, whoami, path: _authorizedKeysPath(targetType, connection && connection.user), targetType };
  } finally { try { conn.end(); } catch { /* ignore */ } }
}

module.exports = { deployPublicKey, testKey, testConnection, _authorizedKeysPath, _internals: { _q, _friendly, _windowsKeysPath, _psEncode } };

if (false) log.info();
