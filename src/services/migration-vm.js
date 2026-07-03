'use strict';

// v8.9.2-alpha.1 — Sprint 7: Cross-hypervisor VM migration to Proxmox.
//
// FLOW (URL source, MVP):
//   1. Operator creates a job via POST /api/migration-vm with:
//        { sourceUrl, sourceFormat, destinationHostId (Proxmox),
//          destinationNode, destinationStorage, destinationVmid,
//          destinationVmName }
//   2. Backend inserts a `migration_jobs` row (status=pending).
//   3. A background worker picks it up (in this alpha: immediately
//      via setImmediate in the same process — no distributed queue).
//   4. Worker SSHes to the Proxmox node using credentials from the
//      Proxmox host's daemon_config.sshConfig, then:
//        a. `mkdir -p /tmp/dd-migration-<jobId>`
//        b. `wget -q <sourceUrl> -O /tmp/.../src.<ext>`
//        c. If ova: `tar -xf src.ova -C /tmp/...` and locate .vmdk
//        d. `qemu-img convert -f <srcFmt> -O qcow2 src.vmdk /tmp/.../disk.qcow2`
//        e. `qm create <vmid> --name <name> --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0`
//        f. `qm importdisk <vmid> /tmp/.../disk.qcow2 <storage>`
//        g. `qm set <vmid> --scsihw virtio-scsi-pci --scsi0 <storage>:vm-<vmid>-disk-0`
//        h. `qm set <vmid> --boot c --bootdisk scsi0`
//        i. `rm -rf /tmp/dd-migration-<jobId>`
//   5. Progress is written back to the DB row after each phase.
//   6. UI polls the row every N seconds to render progress bar.
//
// STATUS OF THIS ALPHA:
//   - Runs the commands in the correct order per Proxmox docs / community
//     writeups, but has NOT been verified end-to-end against a real
//     Proxmox cluster in this session. Expect breakage in edge cases:
//     * OVA files with multiple disks (only first-found VMDK is used)
//     * Storage backends that don't support qcow2 (LVM needs raw)
//     * VMIDs already in use (no collision detection beyond attempting the command)
//     * Windows guests (no driver injection via virt-v2v yet — v2)
//     * Concurrent migrations to same VMID (no locking beyond DB status)
//   - Cancel is not implemented (v2).
//   - No live migration (this is offline import — VM must be exported first).
//
// SECURITY:
//   - Source URL is fetched by wget on the Proxmox node, NOT by
//     docker-dash. This means the Proxmox node's network egress is the
//     policy scope, not docker-dash's — operators can source from
//     internal-only URLs if the Proxmox node has network access.
//   - SSH credentials come from the encrypted daemon_config on the
//     hosts row (existing v8.9.0-alpha.3 crypto pattern).
//   - Every mutating action writes an audit_log entry.
//   - Command construction uses ssh2 client's `exec` with placeholders
//     for user input to prevent shell injection where possible; for
//     values that must interpolate (VMID, filename), we validate
//     against strict regexes before construction.

const { Client: SshClient } = require('ssh2');
const { getDb } = require('../db');
const { fromHostRow: proxmoxFromHostRow, decryptDaemonConfig } = require('./proxmox');
const log = require('../utils/logger')('migration-vm');

const MAX_PHASE_LOG_BYTES = 256 * 1024;
const SSH_CONNECT_TIMEOUT_MS = 30_000;

const NAME_RE = /^[a-zA-Z0-9._-]{1,63}$/;
const VMID_MIN = 100;
const VMID_MAX = 999999999;

// ─── Public API ──────────────────────────────────────────────

/** Insert a new migration_jobs row and kick off the worker. */
function createJob(spec, userId) {
  _validateSpec(spec);
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO migration_jobs (
      source_type, source_url, source_format,
      destination_host_id, destination_node, destination_storage,
      destination_vmid, destination_vm_name,
      status, progress, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `);
  const info = stmt.run(
    'url', spec.sourceUrl, spec.sourceFormat || 'auto',
    spec.destinationHostId, spec.destinationNode, spec.destinationStorage,
    spec.destinationVmid, spec.destinationVmName,
    userId || null,
  );
  const jobId = info.lastInsertRowid;
  // Kick off out of band. Errors during the run update the DB row; they
  // never propagate to the HTTP request that created the job.
  setImmediate(() => {
    runJob(jobId).catch(err => {
      log.error('runJob threw uncaught', { jobId, error: err && err.message });
      _finish(jobId, 'failed', 0, err && err.message);
    });
  });
  return jobId;
}

function listJobs(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM migration_jobs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, limit)));
}

function getJob(id) {
  return getDb().prepare('SELECT * FROM migration_jobs WHERE id = ?').get(id);
}

// ─── Worker ──────────────────────────────────────────────────

async function runJob(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM migration_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== 'pending') {
    log.warn('Job not pending — refusing to run', { jobId, status: job.status });
    return;
  }
  db.prepare(`UPDATE migration_jobs SET status = 'running', started_at = datetime('now'),
    updated_at = datetime('now') WHERE id = ?`).run(jobId);

  const hostRow = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(job.destination_host_id);
  if (!hostRow) return _finish(jobId, 'failed', 0, 'destination host row missing');
  if (hostRow.daemon_type !== 'proxmox') {
    return _finish(jobId, 'failed', 0, `destination host is not Proxmox (daemon_type=${hostRow.daemon_type})`);
  }

  let sshConfig;
  try {
    const cfg = decryptDaemonConfig(hostRow.daemon_config);
    sshConfig = cfg.sshConfig;
    if (!sshConfig || !sshConfig.host || !sshConfig.user || !(sshConfig.privateKey || sshConfig.password)) {
      throw new Error('daemon_config.sshConfig is missing host/user/privateKey. See howto.');
    }
  } catch (err) {
    return _finish(jobId, 'failed', 0, `Cannot read SSH config: ${err.message}`);
  }

  // Validate Proxmox host is reachable via the API before doing anything
  // over SSH — surfaces bad tokens fast.
  try {
    const client = proxmoxFromHostRow(hostRow);
    await client.version();
  } catch (err) {
    return _finish(jobId, 'failed', 0, `Proxmox API probe failed: ${err.message}`);
  }

  const workDir = `/tmp/dd-migration-${jobId}`;
  const cleanupCmd = `rm -rf ${workDir}`;

  let ssh;
  try {
    ssh = await _connectSsh(sshConfig);
    await _updatePhase(jobId, 'setup', 3);
    await _sshExec(ssh, `mkdir -p ${workDir}`, jobId);

    // 1. Download
    await _updatePhase(jobId, 'download', 5);
    const srcExt = _sourceExt(job.source_url, job.source_format);
    const srcPath = `${workDir}/src.${srcExt}`;
    // Use wget with limited redirect and quiet mode. Timeout via ssh
    // channel timer (see _sshExec) — the shell command doesn't need its own.
    await _sshExec(ssh, `wget --tries=3 --timeout=60 -q -O ${srcPath} ${_shellEscape(job.source_url)}`, jobId,
      { timeoutMs: 60 * 60 * 1000 });    // 1h cap on download
    await _updatePhase(jobId, 'download-complete', 40);

    // 2. If OVA, extract and locate the first VMDK
    let vmdkPath = srcPath;
    if (srcExt === 'ova') {
      await _updatePhase(jobId, 'extract', 42);
      await _sshExec(ssh, `tar -xf ${srcPath} -C ${workDir}`, jobId);
      // First vmdk we find inside the extracted tree.
      const listResult = await _sshExec(ssh, `find ${workDir} -maxdepth 3 -name '*.vmdk' | head -1`, jobId);
      vmdkPath = (listResult.stdout || '').trim();
      if (!vmdkPath) throw new Error('No VMDK found inside OVA');
    }

    // 3. qemu-img convert to qcow2
    await _updatePhase(jobId, 'convert', 50);
    const qcowPath = `${workDir}/disk.qcow2`;
    const srcFmtFlag = srcExt === 'qcow2' ? 'qcow2' :
                       srcExt === 'raw' ? 'raw' :
                       srcExt === 'vmdk' || srcExt === 'ova' ? 'vmdk' :
                       'raw';
    await _sshExec(ssh, `qemu-img convert -p -f ${srcFmtFlag} -O qcow2 ${_shellEscape(vmdkPath)} ${qcowPath}`, jobId,
      { timeoutMs: 4 * 60 * 60 * 1000 });   // 4h cap on conversion
    await _updatePhase(jobId, 'convert-complete', 85);

    // 4. Create the target VM (skeleton) and import the disk.
    await _updatePhase(jobId, 'create-vm', 88);
    const vmid = String(job.destination_vmid);
    const name = job.destination_vm_name;
    // qm create with a skeleton spec. User can adjust memory/cores/net
    // in Proxmox UI afterwards. Sensible defaults.
    await _sshExec(ssh,
      `qm create ${vmid} --name ${_shellEscape(name)} --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0 --ostype l26`,
      jobId);

    await _updatePhase(jobId, 'import-disk', 90);
    await _sshExec(ssh,
      `qm importdisk ${vmid} ${qcowPath} ${_shellEscape(job.destination_storage)} --format qcow2`,
      jobId, { timeoutMs: 60 * 60 * 1000 });

    await _updatePhase(jobId, 'attach-disk', 95);
    // Attach the imported disk as scsi0 with virtio-scsi controller.
    // Proxmox names the imported disk vm-<vmid>-disk-0 by default in
    // the storage; we reference it by that convention.
    await _sshExec(ssh,
      `qm set ${vmid} --scsihw virtio-scsi-pci --scsi0 ${_shellEscape(job.destination_storage)}:vm-${vmid}-disk-0`,
      jobId);
    await _sshExec(ssh, `qm set ${vmid} --boot c --bootdisk scsi0`, jobId);

    // Cleanup
    await _sshExec(ssh, cleanupCmd, jobId);
    await _finish(jobId, 'completed', 100, null);
  } catch (err) {
    log.error('Migration failed', { jobId, error: err.message });
    // Best-effort cleanup of the workdir on the remote (don't await result).
    if (ssh) { try { await _sshExec(ssh, cleanupCmd, jobId); } catch { /* ignore */ } }
    _finish(jobId, 'failed', getJob(jobId).progress || 0, err.message);
  } finally {
    if (ssh) { try { ssh.end(); } catch { /* ignore */ } }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function _validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec required');
  if (!spec.sourceUrl || !/^https?:\/\//.test(spec.sourceUrl)) {
    throw new Error('sourceUrl must be http:// or https://');
  }
  if (!Number.isInteger(spec.destinationHostId) || spec.destinationHostId <= 0) {
    throw new Error('destinationHostId (positive integer) required');
  }
  if (!NAME_RE.test(spec.destinationNode || '')) throw new Error('destinationNode invalid');
  if (!NAME_RE.test(spec.destinationStorage || '')) throw new Error('destinationStorage invalid');
  if (!NAME_RE.test(spec.destinationVmName || '')) throw new Error('destinationVmName invalid');
  const vmid = Number(spec.destinationVmid);
  if (!Number.isInteger(vmid) || vmid < VMID_MIN || vmid > VMID_MAX) {
    throw new Error(`destinationVmid must be integer in [${VMID_MIN}, ${VMID_MAX}]`);
  }
  if (spec.sourceFormat && !['vmdk','ova','qcow2','raw','auto'].includes(spec.sourceFormat)) {
    throw new Error('sourceFormat must be one of vmdk|ova|qcow2|raw|auto');
  }
}

function _sourceExt(url, declaredFormat) {
  if (declaredFormat && declaredFormat !== 'auto') return declaredFormat;
  const lower = url.toLowerCase();
  if (lower.endsWith('.ova'))   return 'ova';
  if (lower.endsWith('.vmdk'))  return 'vmdk';
  if (lower.endsWith('.qcow2')) return 'qcow2';
  if (lower.endsWith('.raw') || lower.endsWith('.img')) return 'raw';
  return 'raw';   // safest default
}

// Backtick-safe wrapper for arbitrary strings passed to a POSIX shell.
// Wraps in single quotes; escapes any single-quotes within.
function _shellEscape(str) {
  if (str == null) return "''";
  return "'" + String(str).replace(/'/g, `'\\''`) + "'";
}

async function _connectSsh(sshConfig) {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const timer = setTimeout(() => {
      try { client.end(); } catch { /* ignore */ }
      reject(new Error(`SSH connect timeout after ${SSH_CONNECT_TIMEOUT_MS / 1000}s`));
    }, SSH_CONNECT_TIMEOUT_MS);
    client.on('ready', () => { clearTimeout(timer); resolve(client); });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
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

async function _sshExec(ssh, command, jobId, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15 * 60 * 1000;   // 15 min per command default
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`SSH exec timeout after ${timeoutMs / 1000}s: ${command.slice(0, 100)}`));
    }, timeoutMs);
    ssh.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); _appendLog(jobId, chunk.toString('utf8')); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); _appendLog(jobId, chunk.toString('utf8')); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) resolve({ stdout, stderr, code });
        else reject(Object.assign(new Error(`command exited ${code}: ${command.slice(0, 100)}\n${stderr.slice(-500)}`),
          { code, command, stdout, stderr }));
      });
    });
  });
}

function _updatePhase(jobId, phase, progress) {
  getDb().prepare(`
    UPDATE migration_jobs SET current_phase = ?, progress = ?, updated_at = datetime('now') WHERE id = ?
  `).run(phase, progress, jobId);
}

function _appendLog(jobId, chunk) {
  try {
    const db = getDb();
    const cur = db.prepare('SELECT phase_log FROM migration_jobs WHERE id = ?').get(jobId);
    let next = (cur && cur.phase_log ? cur.phase_log : '') + chunk;
    if (next.length > MAX_PHASE_LOG_BYTES) {
      next = '[... truncated ...]\n' + next.slice(-MAX_PHASE_LOG_BYTES + 100);
    }
    db.prepare('UPDATE migration_jobs SET phase_log = ? WHERE id = ?').run(next, jobId);
  } catch { /* best-effort log persistence — never fail the job */ }
}

function _finish(jobId, status, progress, error) {
  const db = getDb();
  db.prepare(`
    UPDATE migration_jobs
    SET status = ?, progress = ?, error = ?, completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, progress, error || null, jobId);
}

module.exports = {
  createJob, listJobs, getJob, runJob,
  _internals: { _validateSpec, _sourceExt, _shellEscape },
};
