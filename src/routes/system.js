'use strict';

const { Router } = require('express');
const fs = require('fs');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { dockerEvents } = require('../services/misc');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { getDb } = require('../db');
const sslService = require('../services/ssl');
const cisBenchmark = require('../services/cis-benchmark');
const { humanizeDockerError } = require('../utils/docker-errors');
const log = require('../utils/logger')('system');

const { extractHostId } = require('../middleware/hostId');

const { isAllowedCertPath } = require('../services/cert-paths');

const router = Router();
router.use(extractHostId);

// ─── Database Info & Maintenance ─────────────────────────────

router.get('/info', requireAuth, async (req, res) => {
  try { res.json(await dockerService.getInfo(req.hostId)); }
  catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/disk-usage', requireAuth, async (req, res) => {
  try { res.json(await dockerService.getDiskUsage(req.hostId)); }
  catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/events', requireAuth, (req, res) => {
  try {
    const { type, action, since, limit } = req.query;
    // v8.7.33 — cap user-supplied limit at 1000. Pre-fix a caller could
    // pass ?limit=1000000 and receive a multi-hundred-MB response from
    // the docker_events table. Server-side ceiling matches the pattern
    // already used by AI search (v8.7.21), audit query (page-based),
    // and other paginated endpoints.
    const MAX_LIMIT = 1000;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), MAX_LIMIT);
    res.json(dockerEvents.query({ type, action, since, limit: safeLimit }));
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/prune', requireAuth, requireRole('admin'), writeable, requireFeature('prune'), async (req, res) => {
  try {
    const { containers, images, volumes, networks } = req.body;
    const results = await dockerService.prune({ containers, images, volumes, networks }, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'system_prune', details: req.body, ip: getClientIp(req) });
    res.json(results);
  } catch (err) { res.status(500).json({ error: humanizeDockerError(err) }); }
});

// Per-type prune — the frontend (System → Tools → Prune buttons) sends
// /prune/containers | images | volumes | networks | all. Translates the
// URL segment into the boolean-flag body that dockerService.prune expects,
// reusing the same audit + permission stack as /prune. The legacy /prune
// route above remains for any external caller using the old contract.
router.post('/prune/:type', requireAuth, requireRole('admin'), writeable, requireFeature('prune'), async (req, res) => {
  const type = String(req.params.type || '').toLowerCase();
  const validTypes = ['containers', 'images', 'volumes', 'networks', 'buildcache', 'all'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid prune type "${type}". Expected one of: ${validTypes.join(', ')}.` });
  }
  // 'all' == `docker system prune -a --volumes` + build cache (the biggest reclaimable).
  const flags = type === 'all'
    ? { containers: true, images: true, volumes: true, networks: true, buildCache: true }
    : (type === 'buildcache' ? { buildCache: true } : { [type]: true });
  try {
    const results = await dockerService.prune(flags, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'system_prune', details: { type, ...flags }, ip: getClientIp(req) });
    res.json(results);
  } catch (err) {
    log.error('Prune failed', { type, message: err.message || String(err) });
    res.status(500).json({ error: humanizeDockerError(err) });
  }
});

// ─── Update Checks ───────────────────────────────────────────
const { execFileSync } = require('child_process');
const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DockerDash/1.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

router.get('/check-updates', requireAuth, async (req, res) => {
  try {
    const result = { docker: null, os: null, app: null };

    // ── Docker Engine update check ──
    try {
      const version = await dockerService.getDocker(req.hostId).version();
      const currentDocker = version.Version;
      // Fetch latest stable from Docker GitHub releases
      const releases = await fetchJSON('https://api.github.com/repos/moby/moby/releases?per_page=10');
      let latestDocker = null;
      if (Array.isArray(releases)) {
        for (const r of releases) {
          if (r.prerelease || r.draft) continue;
          const tag = (r.tag_name || '').replace(/^v/, '');
          if (/^\d+\.\d+\.\d+$/.test(tag)) { latestDocker = tag; break; }
        }
      }
      result.docker = {
        current: currentDocker,
        latest: latestDocker,
        updateAvailable: latestDocker && currentDocker ? latestDocker !== currentDocker && latestDocker > currentDocker : false,
      };
    } catch (e) {
      result.docker = { current: '?', latest: null, updateAvailable: false, error: e.message };
    }

    // ── OS update check (apt-based) ──
    try {
      const raw = execFileSync('apt', ['list', '--upgradable'], { timeout: 15000, encoding: 'utf8', stdio: 'pipe' }).trim();
      const lines = raw ? raw.split('\n').filter(l => l.includes('upgradable')) : [];
      const packages = lines.map(l => {
        const name = l.split('/')[0];
        const versions = l.match(/\[upgradable from: (.*?)\]/);
        const newVer = l.match(/\s(\S+)\s/)?.[1];
        return { name, newVersion: newVer || '?', oldVersion: versions?.[1] || '?' };
      });
      result.os = {
        total: packages.length,
        packages: packages.slice(0, 30), // limit to 30
        updateAvailable: packages.length > 0,
      };
    } catch {
      result.os = { total: 0, packages: [], updateAvailable: false, error: 'apt not available' };
    }

    // ── Docker Dash app version ──
    // v7.3.2: surface the same data the sidebar badge uses, so System →
    // Updates and System Settings → General agree.
    try {
      const updateCheck = require('../services/update-check');
      // Best-effort live refresh so the user sees fresh data after clicking
      // "Check Updates"; throttled internally so spamming the button is safe.
      await updateCheck.refresh({ force: true });
      const status = updateCheck.getStatus();
      result.app = {
        version: status.current,
        current: status.current,
        latest: status.latest,
        updateAvailable: status.hasUpdate,
        releaseUrl: status.releaseUrl,
        publishedAt: status.publishedAt,
        lastChecked: status.lastChecked,
        enabled: status.enabled,
      };
    } catch {
      result.app = { version: require('../version') };
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Firewall (UFW) ───────────────────────────────────────────

function runCmd(bin, args = []) {
  try {
    return execFileSync(bin, args, { timeout: 10000, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (err) {
    return err.stdout?.trim() || err.stderr?.trim() || err.message;
  }
}

router.get('/firewall', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const statusRaw = runCmd('ufw', ['status', 'numbered']);
    const verboseRaw = runCmd('ufw', ['status', 'verbose']);

    // Check if ufw is available
    if (statusRaw.includes('command not found') || statusRaw.includes('not found')) {
      // Try iptables as fallback
      const iptables = runCmd('iptables', ['-L', '-n', '--line-numbers']);
      return res.json({
        available: !!iptables && !iptables.includes('not found'),
        backend: 'iptables',
        status: 'unknown',
        rules: [],
        raw: iptables,
      });
    }

    // Parse UFW status
    const isActive = verboseRaw.includes('Status: active');
    const defaultPolicy = verboseRaw.match(/Default:\s*(.*)/)?.[1] || '';
    const logging = verboseRaw.match(/Logging:\s*(.*)/)?.[1] || '';

    // Parse rules
    const rules = [];
    const ruleLines = statusRaw.split('\n');
    for (const line of ruleLines) {
      const match = line.match(/\[\s*(\d+)\]\s+(.*?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)?\s*(.*)/);
      if (match) {
        rules.push({
          number: parseInt(match[1]),
          to: match[2].trim(),
          action: match[3],
          direction: (match[4] || 'IN').trim(),
          from: (match[5] || 'Anywhere').trim(),
        });
      }
    }

    // Get listening ports
    const listening = runCmd('ss', ['-tlnp']);

    res.json({
      available: true,
      backend: 'ufw',
      status: isActive ? 'active' : 'inactive',
      defaultPolicy,
      logging,
      rules,
      listening,
      raw: statusRaw,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/firewall/rule', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { action, port, proto, from, direction } = req.body;

    if (!action || !port) {
      return res.status(400).json({ error: 'action and port required' });
    }

    // Validate action
    if (!['allow', 'deny', 'limit', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use: allow, deny, limit, reject' });
    }

    // Strict input validation — prevent command injection
    if (!/^\d{1,5}(:\d{1,5})?$/.test(String(port))) {
      return res.status(400).json({ error: 'Port must be a number or range (e.g., 80 or 8000:9000)' });
    }
    if (from && !/^[\d./]+$/.test(from)) {
      return res.status(400).json({ error: 'From must be an IP address or CIDR (e.g., 192.168.1.0/24)' });
    }
    if (proto && !['tcp', 'udp', 'any'].includes(proto)) {
      return res.status(400).json({ error: 'Protocol must be tcp, udp, or any' });
    }

    // Build UFW args array (no shell interpolation)
    const args = [action];
    if (direction === 'out') args.push('out');
    if (from) { args.push('from', from); }
    args.push(proto && proto !== 'any' ? `${port}/${proto}` : String(port));

    const result = execFileSync('ufw', args, { timeout: 10000, encoding: 'utf8' }).trim();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'firewall_add_rule', details: { action, port, proto, from, direction, result },
      ip: getClientIp(req),
    });

    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/firewall/rule/:number', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const num = parseInt(req.params.number);
    if (!num || num < 1) return res.status(400).json({ error: 'Invalid rule number' });

    const result = execFileSync('ufw', ['--force', 'delete', String(num)], { timeout: 10000, encoding: 'utf8' }).trim();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'firewall_delete_rule', details: { ruleNumber: num, result },
      ip: getClientIp(req),
    });

    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Health Overview ─────────────────────────────────────────
router.get('/health-overview', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const docker = dockerService.getDocker(req.hostId);
    const healthData = [];

    for (const c of containers) {
      try {
        const full = await docker.getContainer(c.id).inspect();
        const health = full.State.Health || null;
        healthData.push({
          id: c.id,
          name: c.name,
          state: c.state,
          status: c.status,
          restartCount: full.RestartCount || 0,
          startedAt: full.State.StartedAt,
          finishedAt: full.State.FinishedAt,
          health: health ? {
            status: health.Status,
            failingStreak: health.FailingStreak,
            lastLog: health.Log?.slice(-3) || [],
          } : null,
          uptime: full.State.Running ? (Date.now() - new Date(full.State.StartedAt).getTime()) : 0,
        });
      } catch { /* skip */ }
    }

    res.json({ containers: healthData });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Compose Stack Management ────────────────────────────────

// ─── Backup & Restore ────────────────────────────────────────

// ─── Resource Limits Update ──────────────────────────────────
router.put('/containers/:id/resources', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { memory, cpuQuota, cpuPeriod } = req.body;
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);

    const updateBody = {};
    if (memory !== undefined) updateBody.Memory = memory;
    if (cpuQuota !== undefined) updateBody.CpuQuota = cpuQuota;
    if (cpuPeriod !== undefined) updateBody.CpuPeriod = cpuPeriod || 100000;

    await container.update(updateBody);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_update_resources', targetType: 'container', targetId: req.params.id,
      details: updateBody, ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Container Templates ─────────────────────────────────
const TEMPLATES = [
  { id: 'nginx', name: 'Nginx', icon: 'fa-globe', category: 'web', description: 'High-performance web server & reverse proxy',
    config: { Image: 'nginx:alpine', ExposedPorts: { '80/tcp': {} }, HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'postgres', name: 'PostgreSQL', icon: 'fa-database', category: 'database', description: 'Powerful open-source relational database',
    config: { Image: 'postgres:16-alpine', Env: ['POSTGRES_PASSWORD=changeme', 'POSTGRES_DB=mydb'], ExposedPorts: { '5432/tcp': {} }, HostConfig: { PortBindings: { '5432/tcp': [{ HostPort: '5432' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'redis', name: 'Redis', icon: 'fa-bolt', category: 'database', description: 'In-memory data structure store & cache',
    config: { Image: 'redis:7-alpine', ExposedPorts: { '6379/tcp': {} }, HostConfig: { PortBindings: { '6379/tcp': [{ HostPort: '6379' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'mysql', name: 'MySQL', icon: 'fa-database', category: 'database', description: 'Popular open-source relational database',
    config: { Image: 'mysql:8', Env: ['MYSQL_ROOT_PASSWORD=changeme', 'MYSQL_DATABASE=mydb'], ExposedPorts: { '3306/tcp': {} }, HostConfig: { PortBindings: { '3306/tcp': [{ HostPort: '3306' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'mongo', name: 'MongoDB', icon: 'fa-leaf', category: 'database', description: 'Document-oriented NoSQL database',
    config: { Image: 'mongo:7', ExposedPorts: { '27017/tcp': {} }, HostConfig: { PortBindings: { '27017/tcp': [{ HostPort: '27017' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'mariadb', name: 'MariaDB', icon: 'fa-database', category: 'database', description: 'Community-developed fork of MySQL',
    config: { Image: 'mariadb:11', Env: ['MARIADB_ROOT_PASSWORD=changeme', 'MARIADB_DATABASE=mydb'], ExposedPorts: { '3306/tcp': {} }, HostConfig: { PortBindings: { '3306/tcp': [{ HostPort: '3307' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'adminer', name: 'Adminer', icon: 'fa-table', category: 'tool', description: 'Lightweight database management UI',
    config: { Image: 'adminer:latest', ExposedPorts: { '8080/tcp': {} }, HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '8081' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'portainer', name: 'Portainer', icon: 'fa-ship', category: 'tool', description: 'Docker management UI',
    config: { Image: 'portainer/portainer-ce:latest', ExposedPorts: { '9443/tcp': {} }, HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'portainer_data:/data'], PortBindings: { '9443/tcp': [{ HostPort: '9443' }] }, RestartPolicy: { Name: 'always' } } } },
  { id: 'traefik', name: 'Traefik', icon: 'fa-random', category: 'web', description: 'Modern reverse proxy & load balancer',
    config: { Image: 'traefik:v3.0', Cmd: ['--api.dashboard=true', '--providers.docker'], ExposedPorts: { '80/tcp': {}, '8080/tcp': {} }, HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'], PortBindings: { '80/tcp': [{ HostPort: '80' }], '8080/tcp': [{ HostPort: '8082' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'prometheus', name: 'Prometheus', icon: 'fa-fire', category: 'monitoring', description: 'Metrics collection & monitoring',
    config: { Image: 'prom/prometheus:latest', ExposedPorts: { '9090/tcp': {} }, HostConfig: { PortBindings: { '9090/tcp': [{ HostPort: '9090' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'grafana', name: 'Grafana', icon: 'fa-chart-line', category: 'monitoring', description: 'Analytics & monitoring dashboards',
    config: { Image: 'grafana/grafana:latest', ExposedPorts: { '3000/tcp': {} }, HostConfig: { PortBindings: { '3000/tcp': [{ HostPort: '3000' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'rabbitmq', name: 'RabbitMQ', icon: 'fa-exchange-alt', category: 'messaging', description: 'Message broker with management UI',
    config: { Image: 'rabbitmq:3-management-alpine', ExposedPorts: { '5672/tcp': {}, '15672/tcp': {} }, HostConfig: { PortBindings: { '5672/tcp': [{ HostPort: '5672' }], '15672/tcp': [{ HostPort: '15672' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
];

router.get('/templates', requireAuth, (req, res) => {
  res.json(TEMPLATES);
});

// ─── Health Check Logs ───────────────────────────────────
router.get('/containers/:id/health-logs', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const data = await container.inspect();
    const health = data.State.Health || null;
    if (!health) return res.json({ logs: [], message: 'No health check configured' });
    res.json({
      status: health.Status,
      failingStreak: health.FailingStreak,
      logs: (health.Log || []).map(l => ({
        start: l.Start,
        end: l.End,
        exitCode: l.ExitCode,
        output: l.Output?.trim() || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Network Topology (container connections) ────────────
router.get('/topology', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const docker = dockerService.getDocker(req.hostId);
    const networks = await docker.listNetworks();

    const nodes = [];
    const links = [];
    const networkMap = {};

    // Add container nodes
    for (const c of containers) {
      nodes.push({ id: c.id, label: c.name, type: 'container', state: c.state, image: c.image });
    }

    // Inspect each network to find connections
    for (const net of networks) {
      if (['none', 'host'].includes(net.Name)) continue;
      try {
        const detail = await docker.getNetwork(net.Id).inspect();
        const containerIds = Object.keys(detail.Containers || {});
        if (containerIds.length === 0) continue;

        networkMap[net.Id] = { id: net.Id, name: net.Name, driver: net.Driver, subnet: detail.IPAM?.Config?.[0]?.Subnet || '' };

        // Create links between containers sharing this network
        for (let i = 0; i < containerIds.length; i++) {
          for (let j = i + 1; j < containerIds.length; j++) {
            links.push({ source: containerIds[i], target: containerIds[j], network: net.Name });
          }
        }
      } catch { /* skip */ }
    }

    res.json({ nodes, links, networks: Object.values(networkMap) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Stacks Management ───────────────────────────────────────


// ─── S3 Backup ─────────────────────────────────────────────

// ─── Secrets Audit ──────────────────────────────────────────

// GET /secrets-audit — analyze secret hygiene across all containers
// Concurrency: inspect up to 20 containers in parallel (Docker socket handles
// this fine; sequential with 100+ containers was taking 30+ seconds).
// Query params:
//   ?limit=N    cap the scan (default: all containers)
//   ?offset=N   skip first N containers (for pagination — UI doesn't use yet)
router.get('/secrets-audit', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const allContainers = await docker.listContainers({ all: true });
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.max(1, parseInt(req.query.limit) || allContainers.length);
    const containers = allContainers.slice(offset, offset + limit);

    const CONCURRENCY = 20;
    async function inspectOne(c) {
      try {
        const container = docker.getContainer(c.Id);
        const inspect = await container.inspect();
        const name = inspect.Name.replace(/^\//, '');
        const env = inspect.Config?.Env || [];
        const mounts = inspect.Mounts || [];

        // Check for secrets mount (/run/secrets/)
        const secretMounts = mounts.filter(m =>
          m.Destination?.startsWith('/run/secrets') || m.Source?.includes('secrets')
        );

        // Check env vars for potential secrets (passwords, keys, tokens in plain text)
        const sensitivePatterns = /password|secret|token|api_key|apikey|private_key|auth|credential/i;
        const plainSecrets = env.filter(e => {
          const [key, ...val] = e.split('=');
          const value = val.join('=');
          return sensitivePatterns.test(key) && value && !value.includes('/run/secrets') && !key.endsWith('_FILE') && value !== '' && !value.startsWith('${');
        }).map(e => e.split('=')[0]); // Return only key names

        // Check for _FILE pattern (Docker secrets best practice)
        const filePatternVars = env.filter(e => e.match(/_FILE=/)).map(e => e.split('=')[0]);

        // Security flags
        const privileged = inspect.HostConfig?.Privileged || false;
        const socketMount = mounts.some(m =>
          m.Source?.includes('docker.sock') || m.Destination?.includes('docker.sock')
        );
        const noNewPrivs = (inspect.HostConfig?.SecurityOpt || []).includes('no-new-privileges');
        const readOnly = inspect.HostConfig?.ReadonlyRootfs || false;
        const hasMemLimit = (inspect.HostConfig?.Memory || 0) > 0;
        const hasCpuLimit = (inspect.HostConfig?.NanoCpus || 0) > 0;

        let score = 100;
        const issues = [];

        if (plainSecrets.length > 0) {
          score -= Math.min(40, plainSecrets.length * 10);
          issues.push({ severity: 'critical', message: plainSecrets.length + ' sensitive env var(s) as plain text: ' + plainSecrets.join(', '), fix: 'Use Docker secrets with _FILE pattern or a secrets manager' });
        }
        if (secretMounts.length === 0 && plainSecrets.length > 0) {
          score -= 10;
          issues.push({ severity: 'warning', message: 'No /run/secrets mount detected', fix: 'Mount secrets via docker-compose secrets: block' });
        }
        if (privileged) {
          score -= 30;
          issues.push({ severity: 'critical', message: 'Container runs in privileged mode', fix: 'Remove privileged flag; use specific capabilities instead' });
        }
        if (socketMount) {
          score -= 15;
          issues.push({ severity: 'warning', message: 'Docker socket is mounted', fix: 'Use read-only mount (:ro) or a Docker socket proxy' });
        }
        if (!noNewPrivs) {
          score -= 5;
          issues.push({ severity: 'info', message: 'no-new-privileges not set', fix: 'Add security_opt: [no-new-privileges] to compose' });
        }
        if (!hasMemLimit) {
          score -= 5;
          issues.push({ severity: 'info', message: 'No memory limit set', fix: 'Add mem_limit to prevent OOM impact on host' });
        }

        return {
          name, id: c.Id.substring(0, 12), image: c.Image, state: c.State,
          labels: inspect.Config?.Labels || {},
          stack: (inspect.Config?.Labels || {})['com.docker.compose.project'] || null,
          service: (inspect.Config?.Labels || {})['com.docker.compose.service'] || null,
          score: Math.max(0, score),
          secretMounts: secretMounts.length,
          filePatternVars: filePatternVars.length,
          plainSecrets: plainSecrets.length,
          privileged, socketMount, noNewPrivs, readOnly, hasMemLimit, hasCpuLimit,
          issues,
        };
      } catch { return null; /* skip containers we can't inspect */ }
    }

    // Parallel batches of CONCURRENCY
    const results = [];
    for (let i = 0; i < containers.length; i += CONCURRENCY) {
      const batch = containers.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(inspectOne));
      for (const r of batchResults) if (r) results.push(r);
    }

    const avgScore = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 100;
    const criticalCount = results.reduce((s, r) => s + r.issues.filter(i => i.severity === 'critical').length, 0);
    const warningCount = results.reduce((s, r) => s + r.issues.filter(i => i.severity === 'warning').length, 0);

    res.json({
      containers: results,
      avgScore, criticalCount, warningCount,
      total: results.length,
      scanned: containers.length,
      hostTotal: allContainers.length,
      offset, limit,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Egress Audit ───────────────────────────────────────────

// GET /egress-audit — analyze outbound network posture across all containers.
// Read-only: flags containers that can reach public internet + IMDS endpoints.
// Enforcement (whitelist, iptables, squid sidecar) is deferred to v6.7.
router.get('/egress-audit', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const egressAudit = require('../services/egress-audit');
    const docker = dockerService.getDocker(req.hostId);
    const allContainers = await docker.listContainers({ all: true });
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.max(1, parseInt(req.query.limit) || allContainers.length);
    const containers = allContainers.slice(offset, offset + limit);

    // Pre-fetch all networks on the host so we can resolve `Internal` per network without
    // re-inspecting for every container. Small N (typically <20 networks), cheap.
    const allNetworks = await docker.listNetworks();
    const networksByName = new Map();
    await Promise.all(allNetworks.map(async n => {
      try {
        const full = await docker.getNetwork(n.Id).inspect();
        networksByName.set(full.Name, full);
      } catch { /* ignore unreadable networks */ }
    }));

    const CONCURRENCY = 20;
    async function inspectOne(c) {
      try {
        const inspect = await docker.getContainer(c.Id).inspect();
        const name = inspect.Name.replace(/^\//, '');
        const analysis = egressAudit.analyzeContainer(inspect, networksByName);
        return {
          id: c.Id.substring(0, 12),
          fullId: c.Id,
          name,
          image: c.Image,
          state: c.State,
          stack: (inspect.Config?.Labels || {})['com.docker.compose.project'] || null,
          service: (inspect.Config?.Labels || {})['com.docker.compose.service'] || null,
          ...analysis,
        };
      } catch { return null; }
    }

    const results = [];
    for (let i = 0; i < containers.length; i += CONCURRENCY) {
      const batch = containers.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(inspectOne));
      for (const r of batchResults) if (r) results.push(r);
    }

    const avgScore = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 100;
    const criticalCount = results.reduce((s, r) => s + r.findings.filter(i => i.severity === 'critical').length, 0);
    const warningCount = results.reduce((s, r) => s + r.findings.filter(i => i.severity === 'warning').length, 0);
    const internetReachable = results.filter(r => r.canReachInternet).length;
    const imdsReachable = results.filter(r => r.canReachIMDS).length;

    res.json({
      containers: results,
      avgScore,
      criticalCount,
      warningCount,
      internetReachable,
      imdsReachable,
      total: results.length,
      scanned: containers.length,
      hostTotal: allContainers.length,
      offset, limit,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deploy-validate — pre-deploy checklist for env + compose
router.post('/deploy-validate', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { envContent, composeContent } = req.body;
    const checks = [];

    if (envContent) {
      const todoMatches = (envContent.match(/<TODO[^>]*>/g) || []);
      checks.push({
        name: 'No TODO placeholders',
        status: todoMatches.length === 0 ? 'pass' : 'fail',
        details: todoMatches.length > 0 ? 'Found ' + todoMatches.length + ' unfilled placeholder(s)' : 'All placeholders filled',
      });

      const lines = envContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      const sensitiveKeys = lines.filter(l => {
        const [key, ...val] = l.split('=');
        const value = val.join('=').trim();
        return /password|secret|token|api_key|private_key/i.test(key) && value && !value.includes('/run/secrets') && !key.endsWith('_FILE');
      }).map(l => l.split('=')[0]);

      checks.push({
        name: 'No plain-text secrets in env',
        status: sensitiveKeys.length === 0 ? 'pass' : 'warn',
        details: sensitiveKeys.length > 0 ? sensitiveKeys.length + ' sensitive var(s) as plain text. Use _FILE pattern with Docker secrets.' : 'All sensitive vars use file references',
      });

      const hasAppSecret = lines.some(l => /^(APP_SECRET|ENCRYPTION_KEY|JWT_SECRET)/i.test(l.split('=')[0]));
      checks.push({
        name: 'App secret configured',
        status: hasAppSecret ? 'pass' : 'warn',
        details: hasAppSecret ? 'App secret/encryption key found' : 'No APP_SECRET or ENCRYPTION_KEY found',
      });
    }

    if (composeContent) {
      const hasRestart = /restart:\s*(always|unless-stopped|on-failure)/i.test(composeContent);
      checks.push({
        name: 'Restart policy set',
        status: hasRestart ? 'pass' : 'warn',
        details: hasRestart ? 'Restart policy configured' : 'No restart policy — containers won\'t auto-restart',
      });

      const hasHealthcheck = /healthcheck:/i.test(composeContent);
      checks.push({
        name: 'Health check configured',
        status: hasHealthcheck ? 'pass' : 'warn',
        details: hasHealthcheck ? 'Health check found' : 'No healthcheck — Docker can\'t detect unhealthy containers',
      });

      const hasLimits = /mem_limit|memory:|cpus:|deploy.*resources/i.test(composeContent);
      checks.push({
        name: 'Resource limits set',
        status: hasLimits ? 'pass' : 'info',
        details: hasLimits ? 'Resource limits configured' : 'No memory/CPU limits — runaway container can affect host',
      });

      const hasLogging = /logging:/i.test(composeContent);
      checks.push({
        name: 'Logging configured',
        status: hasLogging ? 'pass' : 'info',
        details: hasLogging ? 'Logging driver configured' : 'No logging config — using default json-file without rotation',
      });

      const hasSecrets = /^secrets:|^\s+secrets:/m.test(composeContent);
      checks.push({
        name: 'Docker secrets used',
        status: hasSecrets ? 'pass' : 'info',
        details: hasSecrets ? 'Secrets block found' : 'Consider Docker secrets for sensitive data',
      });

      const hasPrivileged = /privileged:\s*true/i.test(composeContent);
      checks.push({
        name: 'No privileged mode',
        status: hasPrivileged ? 'fail' : 'pass',
        details: hasPrivileged ? 'privileged: true detected — major security risk!' : 'No privileged containers',
      });

      const hasSecOpt = /security_opt/i.test(composeContent);
      checks.push({
        name: 'Security options set',
        status: hasSecOpt ? 'pass' : 'info',
        details: hasSecOpt ? 'security_opt configured' : 'Add no-new-privileges security option',
      });
    }

    const passed = checks.filter(c => c.status === 'pass').length;
    const failed = checks.filter(c => c.status === 'fail').length;
    const warned = checks.filter(c => c.status === 'warn').length;

    res.json({ checks, summary: { total: checks.length, passed, failed, warned } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Secrets Wizard ─────────────────────────────────────────

// POST /secrets-wizard/analyze — parse .env, classify secrets, return structured analysis
router.post('/secrets-wizard/analyze', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { envContent } = req.body;
    if (!envContent) return res.status(400).json({ error: 'envContent required' });

    // Classification patterns (order matters — first match wins)
    const classifiers = [
      { pattern: /fingerprint/i, type: 'ssh_fingerprint', label: 'SSH Host Key Fingerprint', action: 'ssh-keyscan', generator: null, rotation: 0 },
      { pattern: /masterkey/i, type: 'hmac_masterkey', label: 'HMAC Masterkey (32B base64)', action: 'generate', generator: 'openssl rand -base64 32', rotation: 180 },
      { pattern: /jwt|signing_key/i, type: 'jwt_key', label: 'JWT Signing Key (32B base64)', action: 'generate', generator: 'openssl rand -base64 32', rotation: 180 },
      { pattern: /django.*secret|secret.*django|glitchtip.*secret/i, type: 'django_secret', label: 'Django Secret Key (50 chars)', action: 'generate', generator: `python3 -c 'import secrets,string; print("".join(secrets.choice(string.ascii_letters+string.digits+"!@#$%^&*(-_=+)") for _ in range(50)))'`, rotation: 180 },
      { pattern: /tunnel_token/i, type: 'cf_tunnel', label: 'Cloudflare Tunnel Token', action: 'provider', provider: 'Cloudflare Zero Trust → Networks → Tunnels → Create tunnel → Copy token', rotation: 365 },
      { pattern: /turnstile.*secret/i, type: 'cf_turnstile', label: 'Cloudflare Turnstile Secret', action: 'provider', provider: 'Cloudflare dashboard → Turnstile → Add site → Copy secret', rotation: 365 },
      { pattern: /(entra|ms_).*secret|graph.*secret/i, type: 'entra_secret', label: 'Microsoft Entra ID Client Secret', action: 'provider', provider: 'Azure Portal → Entra ID → App registrations → [app] → Certificates & secrets → New client secret (6-month expiry)', rotation: 180 },
      { pattern: /oauth.*secret/i, type: 'oauth_secret', label: 'OAuth Client Secret', action: 'provider', provider: 'OAuth provider dashboard → App settings → Generate client secret', rotation: 365 },
      { pattern: /client_cert|\.crt_file|client\.pem/i, type: 'tls_cert', label: 'TLS Client Certificate', action: 'upload', provider: 'PEM file — signed by your CA', rotation: 365 },
      { pattern: /client_key|_key_file$|\.key_file/i, type: 'tls_key', label: 'TLS Private Key', action: 'upload', provider: 'PEM file — matching the client cert', rotation: 365 },
      { pattern: /ca_file|ca_path|_ca_/i, type: 'tls_ca', label: 'CA Bundle', action: 'upload', provider: 'CA certificate bundle (PEM)', rotation: 3650 },
      { pattern: /sftp.*key|ssh.*private_key|private_key_path/i, type: 'ssh_key', label: 'SSH Private Key', action: 'upload', provider: 'Private key (ed25519 recommended) — SysAdmin provides via password manager', rotation: 365 },
      { pattern: /smtp.*password|email.*password/i, type: 'smtp_password', label: 'SMTP Password', action: 'provider', provider: 'Email provider admin panel → App password or SMTP credentials', rotation: 365 },
      { pattern: /cerm.*password|partner.*password|vendor.*password/i, type: 'vendor_password', label: 'Vendor API Password', action: 'provider', provider: 'Contact vendor support to obtain/rotate credentials', rotation: 365 },
      { pattern: /db.*password|mssql.*password|postgres.*password|mysql.*password/i, type: 'db_password', label: 'Database Password (24B base64)', action: 'generate', generator: 'openssl rand -base64 24', rotation: 90 },
      { pattern: /migrator.*password/i, type: 'db_migrator_password', label: 'DB Migrator Password (24B base64)', action: 'generate', generator: 'openssl rand -base64 24', rotation: 90 },
      { pattern: /grafana.*password/i, type: 'grafana_password', label: 'Grafana Admin Password (16B base64)', action: 'generate', generator: 'openssl rand -base64 16', rotation: 90 },
      { pattern: /password(?!.*_file).*file|password_file/i, type: 'generic_password', label: 'Password (24B base64)', action: 'generate', generator: 'openssl rand -base64 24', rotation: 90 },
      { pattern: /secret_file|secret$/i, type: 'generic_secret', label: 'Secret (32B base64)', action: 'generate', generator: 'openssl rand -base64 32', rotation: 180 },
      { pattern: /token_file|_token$/i, type: 'generic_token', label: 'API Token (32B base64)', action: 'generate', generator: 'openssl rand -base64 32', rotation: 180 },
    ];

    const lines = envContent.split('\n');
    const secretFiles = []; // *_FILE entries pointing to /run/secrets/*
    const todoPlaceholders = []; // <TODO_*> values that need manual provisioning

    lines.forEach((line, lineNum) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match) return;

      const [, key, value] = match;

      // Case 1: *_FILE variable pointing to /run/secrets/
      if (key.endsWith('_FILE') && value.includes('/run/secrets/')) {
        const secretName = value.split('/').pop();
        let classification = classifiers.find(c => c.pattern.test(key) || c.pattern.test(secretName));
        if (!classification) {
          classification = { type: 'unknown', label: 'Unknown secret (review required)', action: 'manual', generator: null, provider: 'Manually provision — classification not detected', rotation: 180 };
        }
        secretFiles.push({
          envKey: key,
          secretName,
          hostPath: '/etc/${APP_NAME}/secrets/' + secretName,
          containerPath: value,
          line: lineNum + 1,
          ...classification,
        });
        return;
      }

      // Case 2: <TODO_*> placeholder that needs provisioning
      const todoMatch = value.match(/^<TODO[^>]*>$/);
      if (todoMatch) {
        let classification = classifiers.find(c => c.pattern.test(key));
        if (!classification) {
          classification = { type: 'config_placeholder', label: 'Config placeholder', action: 'inline', generator: null, provider: 'Replace with actual value (non-secret public config)', rotation: 0 };
        }
        todoPlaceholders.push({
          envKey: key,
          placeholder: value,
          line: lineNum + 1,
          ...classification,
        });
      }
    });

    // Group by action type for UI rendering
    const summary = {
      total: secretFiles.length + todoPlaceholders.length,
      generate: secretFiles.filter(s => s.action === 'generate').length,
      provider: secretFiles.filter(s => s.action === 'provider').length + todoPlaceholders.filter(s => s.action === 'provider').length,
      upload: secretFiles.filter(s => s.action === 'upload').length,
      inline: todoPlaceholders.filter(s => s.action === 'inline').length,
      fingerprint: secretFiles.filter(s => s.action === 'ssh-keyscan').length,
      unknown: secretFiles.filter(s => s.type === 'unknown').length,
    };

    res.json({ secretFiles, todoPlaceholders, summary });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /secrets-wizard/preflight — check tool availability on the server running docker-dash
router.get('/secrets-wizard/preflight', requireAuth, requireRole('admin'), async (req, res) => {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  async function probeCommand(cmd, args) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 3000 });
      return { available: true, version: (stdout || stderr || '').trim().split('\n')[0] };
    } catch (err) {
      if (err.code === 'ENOENT') return { available: false, version: '' };
      // Some tools (like ssh -V) exit non-zero but still write version to stderr
      if (err.stderr || err.stdout) {
        return { available: true, version: ((err.stderr || err.stdout) + '').trim().split('\n')[0] };
      }
      return { available: false, version: '' };
    }
  }

  try {
    const [opensslResult, sshResult] = await Promise.all([
      probeCommand('openssl', ['version']),
      probeCommand('ssh', ['-V']),
    ]);

    res.json({
      openssl: opensslResult.available,
      opensslVersion: opensslResult.version,
      ssh: sshResult.available,
      sshVersion: sshResult.version,
      sftp: sshResult.available, // sftp ships with OpenSSH, same binary set
    });
  } catch (err) {
    log.error('secrets-wizard preflight', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /secrets-wizard/generate-script — returns a full bash setup script
router.post('/secrets-wizard/generate-script', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { appName = 'myapp', secretDir, secretFiles = [], providerValues = {} } = req.body;
    const dir = secretDir || ('/etc/' + appName + '/secrets');

    let script = '#!/bin/bash\n';
    script += '# ============================================================================\n';
    script += '# Generated by Docker Dash — Secrets Wizard\n';
    script += '# App: ' + appName + '\n';
    script += '# Generated: ' + new Date().toISOString() + '\n';
    script += '# ============================================================================\n';
    script += '# CRITICAL RULES:\n';
    script += '#   - Always use printf, NEVER echo (echo appends \\n, breaks credentials)\n';
    script += '#   - Files must be 600, directory 750, owner root:docker\n';
    script += '#   - Run as root: sudo bash generated-secrets.sh\n';
    script += '# ============================================================================\n\n';
    script += 'set -euo pipefail\n\n';
    script += 'DIR="' + dir + '"\n\n';
    script += '# --- 1. Prepare directory ---\n';
    script += 'echo "[1/3] Preparing secrets directory $DIR"\n';
    script += 'mkdir -p "$DIR"\n';
    script += 'chown root:docker "$DIR"\n';
    script += 'chmod 750 "$DIR"\n\n';
    script += '# Optional: tmpfs mount (secrets never hit disk plaintext)\n';
    script += '# Add to /etc/fstab:\n';
    script += '#   tmpfs ' + dir + ' tmpfs size=8m,mode=750,uid=0,gid=\\$(getent group docker | cut -d: -f3) 0 0\n\n';
    script += '# --- 2. Generate secrets ---\n';
    script += 'echo "[2/3] Generating secrets..."\n\n';

    let idx = 0;
    for (const s of secretFiles) {
      idx++;
      script += '# (' + idx + '/' + secretFiles.length + ') ' + s.envKey + ' — ' + s.label + '\n';
      const targetPath = '$DIR/' + s.secretName;

      if (s.action === 'generate' && s.generator) {
        script += 'if [ ! -f "' + targetPath + '" ]; then\n';
        script += '  printf "%s" "$(' + s.generator + ')" > "' + targetPath + '"\n';
        script += '  chmod 600 "' + targetPath + '"\n';
        script += '  chown root:docker "' + targetPath + '"\n';
        script += '  echo "  ✓ Generated ' + s.secretName + '"\n';
        script += 'else\n';
        script += '  echo "  ⚠ Already exists: ' + s.secretName + ' (skipping — delete manually to regenerate)"\n';
        script += 'fi\n\n';
      } else if (s.action === 'provider') {
        const val = providerValues[s.envKey];
        if (val) {
          // Base64-encode to safely embed in script
          const b64 = Buffer.from(val).toString('base64');
          script += 'if [ ! -f "' + targetPath + '" ]; then\n';
          script += '  printf "%s" "$(printf "%s" "' + b64 + '" | base64 -d)" > "' + targetPath + '"\n';
          script += '  chmod 600 "' + targetPath + '"\n';
          script += '  chown root:docker "' + targetPath + '"\n';
          script += '  echo "  ✓ Stored provider-issued: ' + s.secretName + '"\n';
          script += 'else\n';
          script += '  echo "  ⚠ Already exists: ' + s.secretName + '"\n';
          script += 'fi\n\n';
        } else {
          script += '# MANUAL: ' + s.provider + '\n';
          script += '# Run this AFTER obtaining the value:\n';
          script += '#   sudo sh -c \'printf "%s" "<PASTED_VALUE>" > ' + targetPath + '\'\n';
          script += '#   sudo chmod 600 ' + targetPath + '\n';
          script += '#   sudo chown root:docker ' + targetPath + '\n';
          script += 'echo "  ⏸ MANUAL REQUIRED: ' + s.secretName + ' (see instructions)"\n\n';
        }
      } else if (s.action === 'upload') {
        script += '# UPLOAD FILE: ' + s.provider + '\n';
        script += '#   sudo install -m 600 -o root -g docker /path/to/source ' + targetPath + '\n';
        script += 'echo "  ⏸ UPLOAD REQUIRED: ' + s.secretName + '"\n\n';
      } else if (s.action === 'ssh-keyscan') {
        script += '# SSH Host Key Pin:\n';
        script += '#   ssh-keyscan -t ed25519 -p 22 <host> 2>/dev/null | ssh-keygen -lf -\n';
        script += '#   Paste "SHA256:..." into ' + s.envKey + ' in .env (NOT a file)\n';
        script += 'echo "  ⚠ SSH FINGERPRINT: run ssh-keyscan for ' + s.envKey + '"\n\n';
      } else {
        script += '# MANUAL: ' + (s.provider || 'Provision manually') + '\n';
        script += '#   sudo sh -c \'printf "%s" "<PASTED_VALUE>" > ' + targetPath + '\'\n';
        script += '#   sudo chmod 600 ' + targetPath + '\n';
        script += '#   sudo chown root:docker ' + targetPath + '\n';
        script += 'echo "  ⏸ MANUAL REQUIRED: ' + s.secretName + ' (unknown type — review)"\n\n';
      }
    }

    script += '# --- 3. Verification ---\n';
    script += 'echo "[3/3] Verifying permissions..."\n';
    script += 'BAD=$(find "$DIR" -type f ! -perm 600 2>/dev/null)\n';
    script += 'if [ -n "$BAD" ]; then\n';
    script += '  echo "FAIL — files with wrong permissions:"\n';
    script += '  echo "$BAD"\n';
    script += '  exit 1\n';
    script += 'fi\n\n';
    script += 'echo ""\n';
    script += 'echo "============================================================================"\n';
    script += 'echo "  ✓ Secrets provisioned at $DIR"\n';
    script += 'echo "  Next steps:"\n';
    script += 'echo "    1. Fill any MANUAL/UPLOAD required secrets (listed above)"\n';
    script += 'echo "    2. Run: docker compose up -d"\n';
    script += 'echo "    3. Record this deployment in your password manager"\n';
    script += 'echo "============================================================================"\n';

    res.type('text/plain').send(script);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /secrets-wizard/deploy-remote — upload + execute script on a remote SSH host
router.post('/secrets-wizard/deploy-remote', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const crypto = require('crypto');
    const { hostId, appName = 'myapp', script, useSudo = true } = req.body;
    if (!hostId) return res.status(400).json({ error: 'hostId required' });
    if (!script || typeof script !== 'string') return res.status(400).json({ error: 'script required' });

    // FIX #6.1 — validate appName against allowlist regex (prevents path traversal)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(appName)) {
      return res.status(400).json({ error: 'appName must match ^[a-zA-Z0-9_-]{1,64}$' });
    }

    // FIX #6.2 — cap script size at 1MB
    if (Buffer.byteLength(script, 'utf8') > 1024 * 1024) {
      return res.status(413).json({ error: 'script exceeds 1MB limit' });
    }

    // FIX #6.3 — compute scriptSha256 for audit log
    const scriptSha256 = crypto.createHash('sha256').update(script).digest('hex');
    const scriptPreviewFirst = script.slice(0, 200);
    const scriptPreviewLast = script.length > 200 ? script.slice(-200) : '';

    // FIX #6.4 — scan for suspicious shell patterns
    const SUSPICIOUS_PATTERNS = [/\$\(/, /`/, /\beval\b/, /curl\s+[^|]+\|\s*sh/, /wget\s+[^|]+\|\s*sh/];
    const scriptWarnings = [];
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(script)) scriptWarnings.push(pattern.toString());
    }

    const db = getDb();
    const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(parseInt(hostId));
    if (!host) return res.status(404).json({ error: 'Host not found' });
    if (host.connection_type !== 'ssh') return res.status(400).json({ error: 'Host does not have SSH configuration' });

    // FIX #6.5 — per-host authorization via allowed_deploy_roles
    if (host.allowed_deploy_roles) {
      let allowedRoles;
      try { allowedRoles = JSON.parse(host.allowed_deploy_roles); } catch { allowedRoles = []; }
      if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
        if (!allowedRoles.includes(req.user.role)) {
          return res.status(403).json({
            error: `Your role '${req.user.role}' is not authorized to deploy to this host. Allowed: ${allowedRoles.join(', ')}`,
          });
        }
      }
    }

    let sshConfig;
    try { sshConfig = JSON.parse(host.ssh_config || '{}'); }
    catch { return res.status(400).json({ error: 'Invalid SSH configuration' }); }
    if (!sshConfig.host || !sshConfig.username) return res.status(400).json({ error: 'SSH host/username missing' });

    const { Client } = require('ssh2');
    const client = new Client();
    const connectOpts = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username,
      readyTimeout: 15000,
    };
    if (sshConfig.privateKey) {
      connectOpts.privateKey = sshConfig.privateKey;
      if (sshConfig.passphrase) connectOpts.passphrase = sshConfig.passphrase;
    } else if (sshConfig.password) {
      connectOpts.password = sshConfig.password;
    } else {
      return res.status(400).json({ error: 'SSH host has no authentication configured' });
    }

    const remotePath = '/tmp/docker-dash-secrets-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.sh';

    const result = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => { try { client.end(); } catch {} reject(new Error('Remote execution timeout (120s)')); }, 120000);

      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) { clearTimeout(timeout); client.end(); return reject(new Error('SFTP init failed: ' + err.message)); }

          const stream = sftp.createWriteStream(remotePath, { mode: 0o755 });
          stream.on('error', (e) => { clearTimeout(timeout); client.end(); reject(new Error('SFTP write failed: ' + e.message)); });
          stream.on('close', () => {
            // chmod + execute
            const execCmd = (useSudo ? 'sudo -n bash ' : 'bash ') + remotePath + ' 2>&1; RC=$?; rm -f ' + remotePath + '; exit $RC';
            client.exec(execCmd, { pty: false }, (err2, ch) => {
              if (err2) { clearTimeout(timeout); client.end(); return reject(new Error('exec failed: ' + err2.message)); }
              ch.on('data', (d) => { output += d.toString(); });
              ch.stderr.on('data', (d) => { output += d.toString(); });
              ch.on('close', (code) => {
                clearTimeout(timeout);
                client.end();
                resolve({ output, exitCode: code });
              });
            });
          });
          stream.end(script);
        });
      });

      client.on('error', (e) => { clearTimeout(timeout); reject(e); });
      client.connect(connectOpts);
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secrets_deploy_remote', targetType: 'host', targetId: String(hostId),
      details: {
        appName,
        exitCode: result.exitCode,
        useSudo,
        outputLen: result.output.length,
        scriptSha256,
        scriptPreviewFirst,
        scriptPreviewLast,
        scriptWarnings,
      },
      ip: getClientIp(req),
    });

    res.json({ ok: result.exitCode === 0, exitCode: result.exitCode, output: result.output });
  } catch (err) {
    log.error('secrets deploy-remote', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /secrets-wizard/generate-compose — returns docker-compose secrets block
router.post('/secrets-wizard/generate-compose', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { appName = 'myapp', secretDir, secretFiles = [] } = req.body;
    const dir = secretDir || ('/etc/' + appName + '/secrets');

    let yaml = '# ============================================================================\n';
    yaml += '# Generated by Docker Dash — Secrets Wizard\n';
    yaml += '# Append this to your docker-compose.yml\n';
    yaml += '# ============================================================================\n\n';
    yaml += '# Under each service that needs secrets, add:\n';
    yaml += '#   secrets:\n';
    secretFiles.forEach(s => { yaml += '#     - ' + s.secretName + '\n'; });
    yaml += '\n';
    yaml += '# Top-level secrets block:\n';
    yaml += 'secrets:\n';
    secretFiles.forEach(s => {
      yaml += '  ' + s.secretName + ':\n';
      yaml += '    file: ' + dir + '/' + s.secretName + '\n';
    });

    res.type('text/plain').send(yaml);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Certificate Management ─────────────────────────────────

const certService = require('../services/certificates');

// GET /certificates — list tracked certs with computed status
router.get('/certificates', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT id, name, source_type, source_path, subject, issuer, sans,
      not_before, not_after, fingerprint_sha256, self_signed, host_id, notes, last_checked_at, last_error,
      created_at, updated_at FROM tracked_certificates ORDER BY not_after ASC`).all();
    const enriched = rows.map(r => {
      const days = certService.daysUntil(r.not_after);
      return { ...r, daysUntilExpiry: days, status: certService.statusForDays(days) };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /certificates — add a tracked cert (PEM content or path)
router.post('/certificates', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, pemContent, sourcePath = '', hostId = 0, notes = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    // FIX #14 — sourcePath allow-list check
    if (sourcePath && !isAllowedCertPath(sourcePath)) {
      return res.status(400).json({
        error: `sourcePath '${sourcePath}' is not in the allowed certificate directories. ` +
               'Configure CERT_ALLOWED_PATHS env var to extend the allow-list.',
      });
    }

    let pem = pemContent;
    let sourceType = 'uploaded';
    if (!pem && sourcePath) {
      if (!fs.existsSync(sourcePath)) return res.status(400).json({ error: 'sourcePath not found' });
      pem = fs.readFileSync(sourcePath, 'utf8');
      sourceType = 'file';
    }
    if (!pem) return res.status(400).json({ error: 'pemContent or sourcePath required' });

    let info;
    try { info = certService.parsePem(pem); }
    catch (e) { return res.status(400).json({ error: 'PEM parse failed: ' + e.message }); }

    const notBeforeIso = info.notBefore ? new Date(info.notBefore).toISOString() : null;
    const notAfterIso = info.notAfter ? new Date(info.notAfter).toISOString() : null;

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO tracked_certificates
        (name, source_type, source_path, pem_content, subject, issuer, sans, not_before, not_after,
         fingerprint_sha256, self_signed, host_id, notes, last_checked_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(name, sourceType, sourcePath, pem, info.subject, info.issuer, info.sans || '',
      notBeforeIso, notAfterIso, info.fingerprintSha256, info.selfSigned ? 1 : 0,
      Number(hostId) || 0, notes, req.user.id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'cert_track', targetType: 'certificate', targetId: String(result.lastInsertRowid),
      details: { name, subject: info.subject, notAfter: info.notAfter },
      ip: getClientIp(req),
    });

    res.status(201).json({ ok: true, id: result.lastInsertRowid, info });
  } catch (err) {
    // FIX #27 — UNIQUE constraint → 409
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `A certificate named "${req.body?.name}" is already tracked`, code: 'DUPLICATE_NAME' });
    }
    log.error('cert POST', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /certificates/:id/refresh — re-read source (file) and re-parse
router.post('/certificates/:id/refresh', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tracked_certificates WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });

    // FIX #14 — validate stored source_path before reading it
    if (row.source_type === 'file' && row.source_path && !isAllowedCertPath(row.source_path)) {
      return res.status(400).json({
        error: `Stored sourcePath '${row.source_path}' is not in the allowed certificate directories. ` +
               'Update the certificate entry with an allowed path or configure CERT_ALLOWED_PATHS.',
      });
    }

    let pem = row.pem_content;
    if (row.source_type === 'file' && row.source_path && fs.existsSync(row.source_path)) {
      pem = fs.readFileSync(row.source_path, 'utf8');
    }
    try {
      const info = certService.parsePem(pem);
      const notBeforeIso = info.notBefore ? new Date(info.notBefore).toISOString() : null;
      const notAfterIso = info.notAfter ? new Date(info.notAfter).toISOString() : null;
      db.prepare(`UPDATE tracked_certificates
        SET pem_content = ?, subject = ?, issuer = ?, sans = ?, not_before = ?, not_after = ?,
            fingerprint_sha256 = ?, self_signed = ?, last_checked_at = datetime('now'),
            last_error = '', updated_at = datetime('now')
        WHERE id = ?`).run(pem, info.subject, info.issuer, info.sans || '',
          notBeforeIso, notAfterIso, info.fingerprintSha256, info.selfSigned ? 1 : 0, row.id);
      res.json({ ok: true, info });
    } catch (e) {
      db.prepare(`UPDATE tracked_certificates SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?`)
        .run(e.message, row.id);
      res.status(400).json({ error: 'Refresh failed: ' + e.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /certificates/:id
router.delete('/certificates/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT id, name FROM tracked_certificates WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM tracked_certificates WHERE id = ?').run(row.id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'cert_untrack', targetType: 'certificate', targetId: String(row.id),
      details: { name: row.name }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /certificates/csr — generate CSR + private key
router.post('/certificates/csr', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { commonName, organization, organizationalUnit, country, state, locality, emailAddress, sans, keyType } = req.body || {};
    if (!commonName) return res.status(400).json({ error: 'commonName required' });

    const result = certService.generateCsr({
      commonName, organization, organizationalUnit, country, state, locality, emailAddress,
      sans: Array.isArray(sans) ? sans : (sans ? String(sans).split(',') : []),
      keyType: keyType === 'ec' ? 'ec' : 'rsa',
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'cert_csr_generate', targetType: 'certificate', targetId: commonName,
      details: { commonName, keyType, sansCount: (sans || []).length },
      ip: getClientIp(req),
    });

    res.json({ ok: true, csr: result.csr, privateKey: result.privateKey });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── SSL/TLS Management ─────────────────────────────────────

// GET /api/system/ssl/status — current SSL status
router.get('/ssl/status', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const status = sslService.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/system/ssl/self-signed — generate self-signed certificate
router.post('/ssl/self-signed', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const result = sslService.generateSelfSigned(domain);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'ssl_generate_self_signed',
      targetType: 'ssl', targetId: domain,
      ip: getClientIp(req),
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/system/ssl/caddy — save Caddyfile configuration
router.post('/ssl/caddy', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { domain, upstreamPort } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const result = sslService.saveCaddyfile(domain, upstreamPort);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'ssl_save_caddyfile',
      targetType: 'ssl', targetId: domain,
      ip: getClientIp(req),
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/system/ssl/cert/:filename — download certificate file
router.get('/ssl/cert/:filename', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const content = sslService.readCert(req.params.filename);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.send(content);
  } catch (err) {
    res.status(err.message === 'File not found' ? 404 : 500).json({ error: err.message });
  }
});

// DELETE /api/system/ssl — remove SSL configuration
router.delete('/ssl', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    sslService.removeSsl();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'ssl_remove',
      targetType: 'ssl', targetId: 'all',
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── CIS Benchmark ──────────────────────────────────────────

// GET /api/system/cis-benchmark — run CIS Docker benchmark on a host
router.get('/cis-benchmark', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const result = await cisBenchmark.runBenchmark(docker);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'cis_benchmark_run',
      targetType: 'system', targetId: String(req.hostId || 'local'),
      ip: getClientIp(req),
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/system/cis/container/:name/hardened-compose
// Generate a CIS-compliant docker-compose.yml from container inspect data
const DANGEROUS_CAPS = ['NET_ADMIN', 'SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_CHROOT', 'SYS_BOOT', 'SETUID', 'SETGID', 'MKNOD', 'AUDIT_WRITE', 'NET_RAW'];
const SENSITIVE_MOUNTS = ['/etc', '/proc', '/sys', '/boot', '/dev', '/run', '/var/run'];

router.get('/cis/container/:name/hardened-compose', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const containers = await docker.listContainers({ all: false });
    const match = containers.find(c =>
      (c.Names || []).some(n => n.replace(/^\//, '') === req.params.name) || c.Id.startsWith(req.params.name)
    );
    if (!match) return res.status(404).json({ error: 'Container not found' });

    const inspection = await docker.getContainer(match.Id).inspect();
    const hc = inspection.HostConfig || {};
    const cfg = inspection.Config || {};
    const labels = cfg.Labels || {};

    const changes = [];

    // --- Service name + image ---
    const rawName = labels['com.docker.compose.service'] || (inspection.Name || '').replace(/^\//, '');
    const serviceName = rawName.replace(/[^a-z0-9_-]/gi, '_') || 'app';
    const image = cfg.Image || 'unknown';

    // --- Ports ---
    const portBindings = hc.PortBindings || {};
    const ports = [];
    for (const [cp, bindings] of Object.entries(portBindings)) {
      if (!bindings) continue;
      const port = cp.replace(/\/tcp$/, '');
      for (const b of bindings) {
        ports.push(b.HostPort ? `"${b.HostPort}:${port}"` : `"${port}"`);
      }
    }

    // --- Environment (filter internal) ---
    const internalPrefixes = ['PATH=', 'HOME=', 'HOSTNAME='];
    const env = (cfg.Env || []).filter(e => !internalPrefixes.some(p => e.startsWith(p)));

    // --- Volumes: harden sensitive bind mounts to :ro ---
    const mounts = inspection.Mounts || [];
    const bindMounts = mounts.filter(m => m.Type === 'bind').map(m => {
      const isSensitive = SENSITIVE_MOUNTS.some(s => m.Source === s || m.Source.startsWith(s + '/'));
      const isSocket = m.Source === '/var/run/docker.sock';
      const forceRo = isSensitive && m.RW;
      if (forceRo) changes.push(`Bind mount ${m.Source} changed to read-only (:ro)`);
      if (isSocket) changes.push(`Docker socket mount kept — consider docker-socket-proxy instead`);
      const ro = (!m.RW || forceRo) ? ':ro' : '';
      return `${m.Source}:${m.Destination}${ro}`;
    });
    const namedVolumes = mounts.filter(m => m.Type === 'volume').map(m => `${m.Name}:${m.Destination}`);
    const allMounts = [...bindMounts, ...namedVolumes];

    // --- Restart policy ---
    const rp = hc.RestartPolicy?.Name;
    const restart = (rp === 'always' || rp === 'unless-stopped' || rp === 'on-failure') ? rp : 'unless-stopped';

    // --- CIS fixes ---
    // C-1: Remove privileged
    if (hc.Privileged) changes.push('Removed: privileged: true (C-1)');

    // C-2: Remove dangerous caps
    let capAdd = (hc.CapAdd || []).filter(c => c !== 'ALL');
    const removedCaps = capAdd.filter(c => DANGEROUS_CAPS.includes(c));
    capAdd = capAdd.filter(c => !DANGEROUS_CAPS.includes(c));
    if (hc.CapAdd?.includes('ALL')) changes.push('Removed cap_add: ALL — all capabilities dropped (C-2)');
    if (removedCaps.length) changes.push(`Removed dangerous capabilities: ${removedCaps.join(', ')} (C-2)`);

    // C-3: Add no-new-privileges
    const hadNoNewPriv = (hc.SecurityOpt || []).some(s => s.includes('no-new-privileges'));
    if (!hadNoNewPriv) changes.push('Added security_opt: no-new-privileges:true (C-3)');

    // C-4: Remove pid=host
    if (hc.PidMode === 'host') changes.push('Removed pid: host (C-4)');

    // C-5: Remove network=host
    const netMode = hc.NetworkMode || '';
    if (netMode.startsWith('host')) changes.push('Removed network_mode: host — use named networks (C-5)');

    // C-6: Remove ipc=host
    if (hc.IpcMode === 'host') changes.push('Removed ipc: host (C-6)');

    // C-7: read_only (note as recommendation — may break apps)
    changes.push('Added read_only: true (C-7) — add tmpfs for /tmp if app needs writable space');

    // C-8: Memory limit
    const hadMemory = hc.Memory && hc.Memory > 0;
    const memLimit = hadMemory ? `${Math.round(hc.Memory / 1024 / 1024)}m` : '512m';
    if (!hadMemory) changes.push('Added mem_limit: 512m (C-8) — adjust to actual needs');

    // C-9: CPU limit
    const hadCpu = hc.NanoCpus && hc.NanoCpus > 0;
    const cpuVal = hadCpu ? (hc.NanoCpus / 1e9).toFixed(2) : '1.0';
    if (!hadCpu) changes.push('Added cpus: "1.0" (C-9) — adjust to actual needs');

    // C-12: Non-root user
    const user = cfg.User || '';
    const isRoot = !user || user === 'root' || user === '0' || user === '0:0';
    if (isRoot) changes.push('Added user: "1000:1000" (C-12) — adjust to actual UID/GID');

    // --- Networks (skip host) ---
    const networks = Object.keys(inspection.NetworkSettings?.Networks || {})
      .filter(n => n !== 'bridge' && n !== 'host' && n !== 'none' && !netMode.startsWith('host'));

    // --- Build YAML ---
    const lines = ['services:'];
    lines.push(`  ${serviceName}:`);
    lines.push(`    image: ${image}`);
    if (ports.length) { lines.push('    ports:'); ports.forEach(p => lines.push(`      - ${p}`)); }
    if (env.length) { lines.push('    environment:'); env.forEach(e => lines.push(`      - ${JSON.stringify(e)}`)); }
    if (allMounts.length) { lines.push('    volumes:'); allMounts.forEach(v => lines.push(`      - ${v}`)); }
    lines.push(`    restart: ${restart}`);

    // Security hardening block
    lines.push('    read_only: true');
    lines.push('    tmpfs:');
    lines.push('      - /tmp:mode=1777');
    if (isRoot) lines.push('    user: "1000:1000"');
    const secOpts = (hc.SecurityOpt || []).filter(s => !s.includes('no-new-privileges'));
    secOpts.push('no-new-privileges:true');
    lines.push('    security_opt:');
    secOpts.forEach(s => lines.push(`      - ${s}`));
    if (capAdd.length) { lines.push('    cap_add:'); capAdd.forEach(c => lines.push(`      - ${c}`)); }
    lines.push('    cap_drop:');
    lines.push('      - ALL');
    lines.push(`    mem_limit: ${memLimit}`);
    lines.push(`    cpus: "${cpuVal}"`);

    if (networks.length) {
      lines.push('    networks:');
      networks.forEach(n => lines.push(`      - ${n}`));
    }

    if (namedVolumes.length) {
      lines.push('');
      lines.push('volumes:');
      namedVolumes.forEach(v => lines.push(`  ${v.split(':')[0]}:`));
    }
    if (networks.length) {
      lines.push('');
      lines.push('networks:');
      networks.forEach(n => lines.push(`  ${n}:\n    external: true`));
    }

    res.json({ compose: lines.join('\n'), changes });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/system/ssl/caddy-status — Caddy container running status
router.get('/ssl/caddy-status', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const status = await sslService.getCaddyStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/system/ssl/enable — write Caddyfile + reload Caddy in one step
router.post('/ssl/enable', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { domain, upstreamPort } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const result = await sslService.enableHttps(domain, parseInt(upstreamPort) || 8101);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'ssl_enable_https',
      targetType: 'ssl', targetId: domain,
      ip: getClientIp(req),
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.message === 'caddy_not_running') {
      return res.status(409).json({
        error: 'caddy_not_running',
        hint: 'Start Caddy first: docker compose --profile tls up -d',
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ssl/certificates — list all TLS certificates with expiry
router.get('/ssl/certificates', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const db = getDb();
    const hosts = db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1').all();
    const certs = [];

    // Check each host's TLS config
    for (const host of hosts) {
      if (host.tls_config) {
        try {
          const tls = JSON.parse(host.tls_config);
          if (tls.cert) {
            certs.push({
              host: host.name,
              hostId: host.id,
              type: 'Docker TLS',
              subject: host.host || 'N/A',
              hasCert: true,
              hasCa: !!tls.ca,
              hasKey: !!tls.key,
            });
          }
        } catch { /* invalid JSON, skip */ }
      }
    }

    // Check app's own SSL/TLS status
    const fs = require('fs');
    const certPaths = ['/data/certs/cert.pem', '/data/certs/server.crt', '/etc/ssl/certs/docker-dash.pem'];
    for (const p of certPaths) {
      try {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          certs.push({
            host: 'Docker Dash (self)',
            type: 'App TLS',
            path: p,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            hasCert: true,
          });
        }
      } catch { /* file not accessible */ }
    }

    res.json({ certificates: certs });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Sub-routers (v8.2.x post-audit further-split) ────────────────────
// External URLs unchanged — mounts replicate original path prefixes.
router.use('/backup', require('./system-backup'));       // 17 routes (S3/pCloud/DB)
router.use('/', require('./system-stacks'));             // 9 routes (/stacks + /compose)
router.use('/schedules', require('./system-schedules')); // 7 routes (/schedules/*)
router.use('/database', require('./system-database'));   // 5 routes (/database/*)
router.use('/terminal-access', require('./terminal-access'));

module.exports = router;
