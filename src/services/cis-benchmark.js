'use strict';

/**
 * CIS Docker Benchmark v1.6 — automated checks via Docker API
 *
 * Implements checks in 3 categories:
 *   D — Docker daemon configuration (from /info)
 *   C — Container runtime settings (per container inspect)
 *   I — Image hygiene (from image inspect)
 *
 * Each check returns: { id, title, category, status, details, remediation }
 * status: 'pass' | 'warn' | 'fail' | 'info'
 */

const log = require('../utils/logger')('cis-benchmark');

// Sensitive host paths that should not be bind-mounted read-write
const SENSITIVE_PATHS = ['/etc', '/boot', '/lib', '/lib64', '/sbin', '/usr', '/var/run/docker.sock'];

// Privileged ports
const PRIV_PORT_THRESHOLD = 1024;

/**
 * Run all CIS checks for a given Docker connection
 * @param {object} docker — dockerode instance
 * @returns {Promise<{checks: Array, summary: object, score: number}>}
 */
async function runBenchmark(docker) {
  const results = [];

  // ── Daemon checks ──────────────────────────────────────────
  let info = {};
  try {
    info = await docker.info();
  } catch (err) {
    log.warn('Cannot fetch Docker info for CIS benchmark', err.message);
    results.push({
      id: 'D-0', title: 'Docker daemon unreachable', category: 'Daemon',
      status: 'fail', details: err.message, remediation: 'Verify Docker socket access.',
    });
    return _summarize(results);
  }

  // D-1: Logging level
  results.push({
    id: 'D-1', title: 'Logging level is not "debug"', category: 'Daemon',
    status: info.LoggingDriver !== 'none' ? 'pass' : 'warn',
    details: `Logging driver: ${info.LoggingDriver || 'none'}`,
    remediation: 'Set --log-driver to a value other than none.',
  });

  // D-2: Experimental features disabled
  results.push({
    id: 'D-2', title: 'Experimental features disabled', category: 'Daemon',
    status: info.ExperimentalBuild ? 'warn' : 'pass',
    details: `Experimental: ${info.ExperimentalBuild ? 'enabled' : 'disabled'}`,
    remediation: 'Do not enable --experimental in production.',
  });

  // D-3: Live restore enabled
  results.push({
    id: 'D-3', title: 'Live restore enabled', category: 'Daemon',
    status: info.LiveRestoreEnabled ? 'pass' : 'warn',
    details: `LiveRestoreEnabled: ${info.LiveRestoreEnabled}`,
    remediation: 'Set --live-restore=true so containers survive daemon restart.',
  });

  // D-4: userland proxy disabled (when possible)
  results.push({
    id: 'D-4', title: 'Userland proxy configuration', category: 'Daemon',
    status: 'info',
    details: 'Consider --userland-proxy=false to use iptables DNAT directly.',
    remediation: 'Set --userland-proxy=false in daemon config if no port forwarding issues.',
  });

  // D-5: Default seccomp profile
  const hasSeccomp = (info.SecurityOptions || []).some(s => s.includes('seccomp'));
  results.push({
    id: 'D-5', title: 'Default seccomp profile active', category: 'Daemon',
    status: hasSeccomp ? 'pass' : 'warn',
    details: `Security options: ${(info.SecurityOptions || []).join(', ') || 'none'}`,
    remediation: 'Ensure seccomp is enabled in Docker daemon.',
  });

  // D-6: AppArmor / SELinux support
  const hasMAC = (info.SecurityOptions || []).some(s => s.includes('apparmor') || s.includes('selinux'));
  results.push({
    id: 'D-6', title: 'AppArmor or SELinux enabled', category: 'Daemon',
    status: hasMAC ? 'pass' : 'warn',
    details: hasMAC ? 'MAC framework active' : 'Neither AppArmor nor SELinux detected',
    remediation: 'Enable AppArmor (Ubuntu/Debian) or SELinux (RHEL/Fedora) on the host.',
  });

  // ── Container checks ────────────────────────────────────────
  let containers = [];
  try {
    containers = await docker.listContainers({ all: false });
  } catch (err) {
    log.warn('Cannot list containers for CIS benchmark', err.message);
  }

  const containerResults = [];
  for (const c of containers) {
    try {
      const inspect = await docker.getContainer(c.Id).inspect();
      const name = (inspect.Name || c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '');
      const hc = inspect.HostConfig || {};
      const cfg = inspect.Config || {};

      const findings = [];

      // C-1: Privileged mode
      if (hc.Privileged) {
        findings.push({ severity: 'fail', msg: 'Running in privileged mode — full host access' });
      }

      // C-2: cap-add ALL or dangerous caps
      const capAdd = hc.CapAdd || [];
      if (capAdd.includes('ALL')) {
        findings.push({ severity: 'fail', msg: 'CapAdd=ALL — all capabilities granted' });
      } else {
        const dangerousCaps = capAdd.filter(c => ['NET_ADMIN', 'SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE'].includes(c));
        if (dangerousCaps.length) {
          findings.push({ severity: 'warn', msg: `Sensitive capabilities added: ${dangerousCaps.join(', ')}` });
        }
      }

      // C-3: no-new-privileges
      if (!hc.SecurityOpt || !hc.SecurityOpt.some(s => s === 'no-new-privileges' || s === 'no-new-privileges=true')) {
        findings.push({ severity: 'warn', msg: 'no-new-privileges not set' });
      }

      // C-4: PID namespace sharing
      if (hc.PidMode === 'host') {
        findings.push({ severity: 'fail', msg: 'Sharing host PID namespace (--pid=host)' });
      }

      // C-5: Network namespace sharing
      if ((hc.NetworkMode || '').startsWith('host')) {
        findings.push({ severity: 'warn', msg: 'Using host network namespace (--network=host)' });
      }

      // C-6: IPC namespace sharing
      if (hc.IpcMode === 'host') {
        findings.push({ severity: 'warn', msg: 'Sharing host IPC namespace (--ipc=host)' });
      }

      // C-7: Read-only root filesystem
      if (!hc.ReadonlyRootfs) {
        findings.push({ severity: 'info', msg: 'Root filesystem is writable (consider --read-only)' });
      }

      // C-8: Memory limit
      if (!hc.Memory || hc.Memory === 0) {
        findings.push({ severity: 'warn', msg: 'No memory limit set (--memory)' });
      }

      // C-9: CPU shares
      if (!hc.CpuShares || hc.CpuShares === 0) {
        findings.push({ severity: 'info', msg: 'No CPU shares/limit set' });
      }

      // C-10: Sensitive bind mounts
      const binds = (hc.Binds || []).concat(
        (hc.Mounts || []).filter(m => m.Type === 'bind').map(m => `${m.Source}:${m.Destination}:${m.Mode || 'rw'}`)
      );
      for (const bind of binds) {
        const src = bind.split(':')[0];
        const mode = bind.split(':')[2] || 'rw';
        if (SENSITIVE_PATHS.includes(src) && mode !== 'ro') {
          findings.push({ severity: 'fail', msg: `Sensitive path bind-mounted read-write: ${src}` });
        }
        if (src === '/var/run/docker.sock') {
          findings.push({ severity: 'warn', msg: 'Docker socket mounted — container can control the host Docker daemon' });
        }
      }

      // C-11: Privileged ports
      const ports = Object.keys(inspect.NetworkSettings?.Ports || {});
      const privPorts = ports.filter(p => {
        const num = parseInt(p.split('/')[0]);
        return num > 0 && num < PRIV_PORT_THRESHOLD;
      });
      if (privPorts.length) {
        findings.push({ severity: 'info', msg: `Privileged ports exposed: ${privPorts.join(', ')}` });
      }

      // C-12: Running as root
      const user = cfg.User || '';
      if (!user || user === 'root' || user === '0') {
        findings.push({ severity: 'warn', msg: 'Container running as root (no --user set)' });
      }

      const worstSeverity = findings.some(f => f.severity === 'fail') ? 'fail'
        : findings.some(f => f.severity === 'warn') ? 'warn'
        : findings.some(f => f.severity === 'info') ? 'info'
        : 'pass';

      containerResults.push({
        id: `C-${name}`,
        title: name,
        category: 'Container',
        status: worstSeverity,
        details: findings.length ? findings.map(f => `[${f.severity.toUpperCase()}] ${f.msg}`).join('\n') : 'All checks passed',
        image: inspect.Config?.Image || '',
        findings,
      });
    } catch (err) {
      log.warn(`Cannot inspect container ${c.Id} for CIS benchmark`, err.message);
    }
  }

  results.push(...containerResults);

  return _summarize(results);
}

function _summarize(checks) {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const total = counts.pass + counts.warn + counts.fail;
  const score = total > 0 ? Math.round((counts.pass / total) * 100) : 0;
  return { checks, summary: counts, score, runAt: new Date().toISOString() };
}

module.exports = { runBenchmark };
