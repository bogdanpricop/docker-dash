'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { getDb } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { now } = require('../utils/helpers');
const git = require('./git');
const log = require('../utils/logger')('preview-environments');

const active = new Set();
const MAX_ERROR = 500;

function _audit(action, environment, details = {}) {
  try {
    require('./audit').log({
      username: 'system', action, targetType: 'preview_environment',
      targetId: String(environment.id), details: {
        stack_id: environment.stack_id, pr_number: environment.pr_number,
        host_id: environment.host_id, head_sha: environment.head_sha?.substring(0, 12), ...details,
      },
    });
  } catch { /* preview lifecycle must not fail on audit logging */ }
}

async function _whenIdle(id) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (active.has(id)) {
    if (Date.now() >= deadline) throw _httpError('Timed out waiting for the active preview operation', 409);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function _httpError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

function _configRow(row) {
  if (!row) return null;
  let variables = [];
  if (row.env_encrypted) {
    try { variables = JSON.parse(decrypt(row.env_encrypted)); } catch { variables = []; }
  }
  return {
    stack_id: row.stack_id,
    enabled: !!row.enabled,
    host_id: row.host_id,
    ttl_minutes: row.ttl_minutes,
    url_template: row.url_template,
    allow_forks: !!row.allow_forks,
    cpu_limit: row.cpu_limit,
    memory_limit_mb: row.memory_limit_mb,
    variables: variables.map(item => ({
      key: item.key,
      value: item.sensitive ? '••••••••' : item.value,
      sensitive: !!item.sensitive,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getConfig(stackId, { includeValues = false } = {}) {
  const row = getDb().prepare('SELECT * FROM git_preview_configs WHERE stack_id = ?').get(stackId);
  if (!row) return null;
  const result = _configRow(row);
  if (includeValues && row.env_encrypted) {
    try { result.variables = JSON.parse(decrypt(row.env_encrypted)); } catch { result.variables = []; }
  }
  return result;
}

function updateConfig(stackId, input = {}) {
  const db = getDb();
  const stack = git.getStack(stackId);
  if (!stack) throw _httpError('Git stack not found', 404);
  const previous = getConfig(stackId, { includeValues: true });
  const hostId = Number(input.host_id ?? input.hostId ?? previous?.host_id ?? stack.host_id);
  const host = db.prepare(`SELECT id, name, is_active, daemon_type FROM docker_hosts WHERE id = ?`).get(hostId);
  if (!host) throw _httpError('Preview host not found', 404);
  if (!host.is_active || !['docker', 'podman'].includes(host.daemon_type || 'docker')) {
    throw _httpError(`Host "${host.name}" is not an active Compose target`, 409);
  }
  const ttlMinutes = Number(input.ttl_minutes ?? input.ttlMinutes ?? previous?.ttl_minutes ?? 1440);
  const cpuLimit = Number(input.cpu_limit ?? input.cpuLimit ?? previous?.cpu_limit ?? 1);
  const memoryMb = Number(input.memory_limit_mb ?? input.memoryLimitMb ?? previous?.memory_limit_mb ?? 512);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 30 || ttlMinutes > 10080) {
    throw _httpError('Preview TTL must be between 30 and 10080 minutes');
  }
  if (!Number.isFinite(cpuLimit) || cpuLimit < 0.1 || cpuLimit > 32) {
    throw _httpError('Preview CPU limit must be between 0.1 and 32');
  }
  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 65536) {
    throw _httpError('Preview memory limit must be between 64 and 65536 MB');
  }
  const urlTemplate = input.url_template ?? input.urlTemplate ?? previous?.url_template ?? null;
  if (urlTemplate) {
    if (urlTemplate.length > 500) throw _httpError('Preview URL template is too long');
    const sample = urlTemplate.replaceAll('{pr}', '1').replaceAll('{stack}', 'app').replaceAll('{sha}', 'abcdef0');
    let parsed;
    try { parsed = new URL(sample); } catch { throw _httpError('Preview URL template must be an HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw _httpError('Preview URL template must be an HTTP(S) URL');
  }
  const enabled = input.enabled === undefined ? !!previous?.enabled : input.enabled === true;
  const allowForks = input.allow_forks === undefined && input.allowForks === undefined
    ? !!previous?.allow_forks : (input.allow_forks === true || input.allowForks === true);
  const variables = Array.isArray(input.variables)
    ? input.variables.map(item => {
      const key = String(item.key || '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw _httpError(`Invalid preview variable: ${key}`);
      if (String(item.value ?? '').length > 16384) throw _httpError(`Preview variable ${key} is too large`);
      if (item.sensitive && item.value === '••••••••') {
        const old = previous?.variables?.find(variable => variable.key === key);
        if (!old) throw _httpError(`Sensitive preview variable ${key} needs a value`);
        return old;
      }
      return { key, value: String(item.value ?? ''), sensitive: !!item.sensitive };
    }) : (previous?.variables || []);
  const names = new Set();
  for (const variable of variables) {
    if (names.has(variable.key)) throw _httpError(`Duplicate preview variable: ${variable.key}`);
    names.add(variable.key);
  }

  db.prepare(`
    INSERT INTO git_preview_configs
      (stack_id, enabled, host_id, ttl_minutes, url_template, allow_forks,
       cpu_limit, memory_limit_mb, env_encrypted, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stack_id) DO UPDATE SET
      enabled=excluded.enabled, host_id=excluded.host_id, ttl_minutes=excluded.ttl_minutes,
      url_template=excluded.url_template, allow_forks=excluded.allow_forks,
      cpu_limit=excluded.cpu_limit, memory_limit_mb=excluded.memory_limit_mb,
      env_encrypted=excluded.env_encrypted, updated_at=excluded.updated_at
  `).run(
    stackId, enabled ? 1 : 0, hostId, ttlMinutes, urlTemplate || null,
    allowForks ? 1 : 0, cpuLimit, memoryMb,
    variables.length ? encrypt(JSON.stringify(variables)) : null, now()
  );
  return getConfig(stackId);
}

function list(stackId) {
  const where = stackId ? 'WHERE p.stack_id = ?' : '';
  const params = stackId ? [stackId] : [];
  return getDb().prepare(`
    SELECT p.*, s.stack_name, h.name AS host_name
    FROM git_preview_environments p
    JOIN git_stacks s ON s.id = p.stack_id
    JOIN docker_hosts h ON h.id = p.host_id
    ${where}
    ORDER BY p.updated_at DESC
  `).all(...params);
}

function _projectName(stackName, prNumber) {
  const base = `ddp-${stackName}-pr${prNumber}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return base.substring(0, 63).replace(/[-_]$/, '') || `ddp-pr${prNumber}`;
}

function _previewUrl(config, stack, prNumber, sha) {
  if (!config.url_template) return null;
  return config.url_template
    .replaceAll('{pr}', String(prNumber))
    .replaceAll('{stack}', stack.stack_name)
    .replaceAll('{sha}', sha.substring(0, 7));
}

function _canonicalRepository(repoUrl) {
  const raw = String(repoUrl || '').trim().replace(/\.git$/i, '');
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].toLowerCase()}`;
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase().replace(/\/$/, '')}`;
  } catch { return raw.toLowerCase(); }
}

function validatePullRequest(stack, config, payload) {
  if (!payload || !Number.isInteger(Number(payload.number)) || Number(payload.number) <= 0) {
    throw _httpError('Invalid pull request payload');
  }
  const pr = payload.pull_request;
  if (!pr?.head?.ref || !/^[A-Za-z0-9._\/-]{1,240}$/.test(pr.head.ref) || pr.head.ref.includes('..')) {
    throw _httpError('Invalid pull request head ref');
  }
  if (!/^[a-f0-9]{7,64}$/i.test(pr.head.sha || '')) throw _httpError('Invalid pull request head SHA');
  const baseRepo = payload.repository?.clone_url || payload.repository?.html_url || '';
  const headRepo = pr.head.repo?.clone_url || pr.head.repo?.html_url || '';
  if (!_canonicalRepository(baseRepo) || _canonicalRepository(baseRepo) !== _canonicalRepository(stack.repo_url)) {
    throw _httpError('Webhook repository does not match the configured Git stack', 403, 'REPOSITORY_MISMATCH');
  }
  const fork = _canonicalRepository(headRepo) !== _canonicalRepository(baseRepo);
  if (fork && !config.allow_forks) {
    throw _httpError('Pull requests from forks are disabled for previews', 403, 'FORK_PREVIEW_DISABLED');
  }
  if (fork) {
    let parsedHead;
    try { parsedHead = new URL(headRepo); } catch { throw _httpError('Fork clone URL is missing or invalid', 403); }
    if (parsedHead.protocol !== 'https:') throw _httpError('Fork previews require an HTTPS clone URL', 403);
  }
  return {
    number: Number(payload.number),
    repository: payload.repository?.full_name || _canonicalRepository(baseRepo),
    ref: pr.head.ref,
    sha: pr.head.sha.toLowerCase(),
    fork,
    headRepositoryUrl: fork ? headRepo : null,
  };
}

function queuePullRequest(stack, payload) {
  const config = getConfig(stack.id, { includeValues: true });
  if (!config?.enabled) throw _httpError('Preview environments are not enabled', 409, 'PREVIEWS_DISABLED');
  const pull = validatePullRequest(stack, config, payload);
  const db = getDb();
  const expiresAt = new Date(Date.now() + config.ttl_minutes * 60000).toISOString();
  const projectName = _projectName(stack.stack_name, pull.number);
  db.prepare(`
    INSERT INTO git_preview_environments
      (stack_id, provider, repository, head_repository_url, pr_number, head_ref, head_sha,
       project_name, host_id, url, status, expires_at, updated_at)
    VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(stack_id, pr_number) DO UPDATE SET
      repository=excluded.repository, head_repository_url=excluded.head_repository_url,
      head_ref=excluded.head_ref, head_sha=excluded.head_sha,
      host_id=excluded.host_id, url=excluded.url, status='pending', expires_at=excluded.expires_at,
      last_error=NULL, updated_at=excluded.updated_at
  `).run(
    stack.id, pull.repository, pull.headRepositoryUrl, pull.number, pull.ref, pull.sha, projectName,
    config.host_id, _previewUrl(config, stack, pull.number, pull.sha), expiresAt, now()
  );
  const environment = db.prepare(
    'SELECT * FROM git_preview_environments WHERE stack_id = ? AND pr_number = ?'
  ).get(stack.id, pull.number);
  const completion = (async () => {
    await _whenIdle(environment.id);
    return deploy(environment.id);
  })().catch(err => {
    log.error('Preview deployment failed', { previewId: environment.id, error: err.message });
    return null;
  });
  return { environment, completion };
}

function _composeFiles(stack, directory) {
  const additional = typeof stack.additional_files === 'string'
    ? JSON.parse(stack.additional_files || '[]') : (stack.additional_files || []);
  const relativeFiles = additional.length ? additional : [stack.compose_path || 'docker-compose.yml'];
  const root = fs.realpathSync(directory);
  return relativeFiles.map(relative => {
    const candidate = path.resolve(root, relative);
    const rel = path.relative(root, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(candidate)) {
      throw new Error(`Preview Compose file not found or unsafe: ${relative}`);
    }
    const target = fs.realpathSync(candidate);
    const canonicalRel = path.relative(root, target);
    if (canonicalRel.startsWith('..') || path.isAbsolute(canonicalRel) || !fs.statSync(target).isFile()) {
      throw new Error(`Preview Compose file escapes the checkout: ${relative}`);
    }
    return target;
  });
}

function _inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function _validateLocalPath(root, base, value, label, { directory = false } = {}) {
  const raw = String(value || '');
  if (!raw || raw.includes('$') || path.isAbsolute(raw) || path.win32.isAbsolute(raw)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
    throw _httpError(`${label} must be a static path inside the preview checkout`, 409, 'UNSAFE_PREVIEW_COMPOSE');
  }
  const candidate = path.resolve(base, raw);
  if (!_inside(root, candidate) || !fs.existsSync(candidate)) {
    throw _httpError(`${label} is missing or escapes the preview checkout`, 409, 'UNSAFE_PREVIEW_COMPOSE');
  }
  const canonical = fs.realpathSync(candidate);
  if (!_inside(root, canonical) || (directory ? !fs.statSync(canonical).isDirectory() : !fs.statSync(canonical).isFile())) {
    throw _httpError(`${label} escapes the preview checkout through a symbolic link`, 409, 'UNSAFE_PREVIEW_COMPOSE');
  }
  return canonical;
}

function _validatePreviewCompose(composeFiles, directory) {
  const root = fs.realpathSync(directory);
  const base = path.dirname(composeFiles[0]);
  const serviceNames = new Set();
  const forbidden = [
    'privileged', 'cap_add', 'devices', 'device_cgroup_rules', 'volumes_from',
    'external_links', 'network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'cgroup',
    'credential_spec', 'runtime', 'gpus', 'develop', 'sysctls', 'security_opt',
    'oom_kill_disable', 'container_name',
  ];

  for (const composeFile of composeFiles) {
    if (fs.statSync(composeFile).size > 2 * 1024 * 1024) throw _httpError('Preview Compose file exceeds 2 MiB', 413);
    let parsed;
    try { parsed = YAML.parse(fs.readFileSync(composeFile, 'utf8')) || {}; }
    catch (err) { throw _httpError(`Invalid preview Compose YAML: ${err.message}`); }
    if (!parsed.services || typeof parsed.services !== 'object' || Array.isArray(parsed.services)) {
      throw _httpError('Preview Compose file has no services');
    }
    if (parsed.include) throw _httpError('Preview Compose files cannot use include', 409, 'UNSAFE_PREVIEW_COMPOSE');

    for (const [kind, entries] of [['volume', parsed.volumes], ['network', parsed.networks]]) {
      for (const [name, entry] of Object.entries(entries || {})) {
        const allowedDriver = kind === 'volume' ? 'local' : 'bridge';
        if (entry && typeof entry === 'object'
            && (entry.external || entry.name || entry.driver_opts || (entry.driver && entry.driver !== allowedDriver))) {
          throw _httpError(`Preview ${kind} ${name} can reference host-managed resources`, 409, 'UNSAFE_PREVIEW_COMPOSE');
        }
      }
    }
    for (const [kind, entries] of [['config', parsed.configs], ['secret', parsed.secrets]]) {
      for (const [name, entry] of Object.entries(entries || {})) {
        if (entry?.external || entry?.name) {
          throw _httpError(`Preview ${kind} ${name} cannot be external`, 409, 'UNSAFE_PREVIEW_COMPOSE');
        }
        if (entry?.file) _validateLocalPath(root, base, entry.file, `Preview ${kind} ${name}`);
      }
    }

    for (const [name, service] of Object.entries(parsed.services)) {
      if (!service || typeof service !== 'object' || Array.isArray(service)) {
        throw _httpError(`Invalid preview service: ${name}`);
      }
      serviceNames.add(name);
      const unsafeKey = forbidden.find(key => service[key] !== undefined
        && service[key] !== false && service[key] !== null
        && (!Array.isArray(service[key]) || service[key].length));
      if (unsafeKey) throw _httpError(`Preview service ${name} cannot use ${unsafeKey}`, 409, 'UNSAFE_PREVIEW_COMPOSE');
      if (service.extends) throw _httpError(`Preview service ${name} cannot use extends`, 409, 'UNSAFE_PREVIEW_COMPOSE');
      const extraHosts = Array.isArray(service.extra_hosts)
        ? service.extra_hosts : Object.entries(service.extra_hosts || {}).map(([key, value]) => `${key}:${value}`);
      if (extraHosts.some(item => String(item).includes('host-gateway'))) {
        throw _httpError(`Preview service ${name} cannot map host-gateway`, 409, 'UNSAFE_PREVIEW_COMPOSE');
      }
      for (const volume of (service.volumes || [])) {
        const shortBind = typeof volume === 'string' && (volume.includes('$')
          || (volume.includes(':') && /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(volume)));
        if (shortBind || (volume && typeof volume === 'object' && volume.type === 'bind')) {
          throw _httpError(`Preview service ${name} cannot use bind mounts`, 409, 'UNSAFE_PREVIEW_COMPOSE');
        }
      }
      const envFiles = Array.isArray(service.env_file) ? service.env_file
        : (service.env_file ? [service.env_file] : []);
      for (const envFile of envFiles) {
        _validateLocalPath(root, base, typeof envFile === 'object' ? envFile.path : envFile, `Preview service ${name} env_file`);
      }
      if (service.label_file) throw _httpError(`Preview service ${name} cannot use label_file`, 409, 'UNSAFE_PREVIEW_COMPOSE');
      if (service.build) {
        const build = typeof service.build === 'string' ? { context: service.build } : service.build;
        _validateLocalPath(root, base, build.context || '.', `Preview service ${name} build context`, { directory: true });
        for (const key of ['additional_contexts', 'cache_from', 'cache_to', 'secrets', 'ssh', 'entitlements', 'network']) {
          if (build[key]) throw _httpError(`Preview service ${name} build cannot use ${key}`, 409, 'UNSAFE_PREVIEW_COMPOSE');
        }
        if (build.dockerfile) {
          _validateLocalPath(root, path.resolve(base, build.context || '.'), build.dockerfile,
            `Preview service ${name} Dockerfile`);
        }
      }
    }
  }
  return [...serviceNames];
}

function _guardrailOverride(composeFiles, environment, config, directory) {
  const serviceNames = _validatePreviewCompose(composeFiles, directory);
  const services = {};
  for (const name of serviceNames) {
    services[name] = {
      cpus: String(config.cpu_limit),
      mem_limit: `${config.memory_limit_mb}m`,
      pids_limit: 256,
      scale: 1,
      deploy: {
        replicas: 1,
        resources: { limits: { cpus: String(config.cpu_limit), memory: `${config.memory_limit_mb}m` } },
      },
      labels: {
        'docker-dash.preview': 'true',
        'docker-dash.preview.id': String(environment.id),
        'docker-dash.preview.pr': String(environment.pr_number),
        'docker-dash.protect': 'true',
      },
    };
  }
  return YAML.stringify({ services });
}

function _previewCliEnvironment(source) {
  const allowed = new Set([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'COMPOSE_ANSI',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source || {})) if (allowed.has(key)) env[key] = value;
  env.COMPOSE_DISABLE_ENV_FILE = '1';
  return env;
}

function _envLine(key, value) {
  const normalized = String(value ?? '');
  if (normalized.includes('\0') || normalized.includes('\r') || normalized.includes('\n')) {
    throw _httpError(`Preview variable ${key} cannot contain a newline or NUL byte`);
  }
  // Compose expands '$' in double-quoted env values; '$$' preserves it.
  return `${key}=${JSON.stringify(normalized.replace(/\$/g, '$$$$'))}`;
}

async function deploy(previewId) {
  const id = Number(previewId);
  if (active.has(id)) throw _httpError('Preview deployment is already running', 409);
  active.add(id);
  const db = getDb();
  const environment = db.prepare('SELECT * FROM git_preview_environments WHERE id = ?').get(id);
  if (!environment) { active.delete(id); throw _httpError('Preview environment not found', 404); }
  const stack = git.getStack(environment.stack_id);
  const config = getConfig(environment.stack_id, { includeValues: true });
  if (!stack || !config?.enabled) { active.delete(id); throw _httpError('Preview configuration is disabled', 409); }
  db.prepare("UPDATE git_preview_environments SET status='deploying', last_error=NULL, updated_at=? WHERE id=?")
    .run(now(), id);

  try {
    const checkout = await git.preparePreviewCheckout(stack.id, id, {
      ref: environment.head_ref, sha: environment.head_sha,
      repositoryUrl: environment.head_repository_url || null,
      useStackCredentials: !environment.head_repository_url,
    });
    const files = _composeFiles(stack, checkout.directory);
    const overridePath = path.join(checkout.directory, '.docker-dash-preview.yml');
    fs.writeFileSync(overridePath, _guardrailOverride(files, environment, config, checkout.directory), 'utf8');
    const envPath = path.join(checkout.directory, '.env.preview');
    const envLines = (config.variables || []).map(item => _envLine(item.key, item.value));
    envLines.push(_envLine('DD_PREVIEW_ID', id), _envLine('DD_PREVIEW_PR', environment.pr_number));
    if (environment.url) envLines.push(_envLine('DD_PREVIEW_URL', environment.url));
    fs.writeFileSync(envPath, `${envLines.join('\n')}\n`, { mode: 0o600 });

    const args = ['compose'];
    for (const file of [...files, overridePath]) args.push('-f', file);
    args.push('--env-file', envPath, '-p', environment.project_name, 'up', '-d', '--remove-orphans');
    const dockerEnv = git.getDockerCliEnvironment(environment.host_id);
    try {
      const cliEnv = _previewCliEnvironment(dockerEnv.env);
      git._execFile('docker', args, {
        cwd: checkout.directory, timeout: 300000, encoding: 'utf8', stdio: 'pipe', env: cliEnv,
      });
    } finally { dockerEnv.cleanup(); }

    db.prepare(`UPDATE git_preview_environments
      SET status='running', deployed_at=?, last_error=NULL, updated_at=? WHERE id=?`)
      .run(now(), now(), id);
    const deployed = db.prepare('SELECT * FROM git_preview_environments WHERE id = ?').get(id);
    _audit('preview_deploy', deployed, { status: 'running' });
    return deployed;
  } catch (err) {
    db.prepare("UPDATE git_preview_environments SET status='error', last_error=?, updated_at=? WHERE id=?")
      .run(String(err.message || err).substring(0, MAX_ERROR), now(), id);
    _audit('preview_deploy_failed', environment, { error: String(err.message || err).substring(0, MAX_ERROR) });
    throw err;
  } finally { active.delete(id); }
}

async function remove(previewId, { reason = 'manual' } = {}) {
  const id = Number(previewId);
  if (active.has(id)) throw _httpError('Preview operation is already running', 409);
  active.add(id);
  const db = getDb();
  const environment = db.prepare('SELECT * FROM git_preview_environments WHERE id = ?').get(id);
  if (!environment) { active.delete(id); throw _httpError('Preview environment not found', 404); }
  const stack = git.getStack(environment.stack_id);
  db.prepare("UPDATE git_preview_environments SET status='deleting', updated_at=? WHERE id=?").run(now(), id);
  try {
    const directory = git.getPreviewDirectory(id);
    let composeCleaned = false;
    if (stack && fs.existsSync(directory)) {
      try {
        const files = _composeFiles(stack, directory);
        const overridePath = path.join(directory, '.docker-dash-preview.yml');
        const args = ['compose'];
        for (const file of [...files, ...(fs.existsSync(overridePath) ? [overridePath] : [])]) args.push('-f', file);
        args.push('-p', environment.project_name, 'down', '--remove-orphans');
        const dockerEnv = git.getDockerCliEnvironment(environment.host_id);
        try {
          git._execFile('docker', args, {
            cwd: directory, timeout: 120000, encoding: 'utf8', stdio: 'pipe', env: dockerEnv.env,
          });
          composeCleaned = true;
        } finally { dockerEnv.cleanup(); }
      } catch (err) {
        log.warn('Compose preview cleanup failed; using label-scoped fallback', { previewId: id, error: err.message });
      }
    }
    if (!composeCleaned) await _removeProjectResources(environment);
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    db.prepare('DELETE FROM git_preview_environments WHERE id = ?').run(id);
    _audit('preview_cleanup', environment, { reason });
    return { ok: true, id, reason };
  } catch (err) {
    db.prepare("UPDATE git_preview_environments SET status='error', last_error=?, updated_at=? WHERE id=?")
      .run(String(err.message || err).substring(0, MAX_ERROR), now(), id);
    throw err;
  } finally { active.delete(id); }
}

async function _removeProjectResources(environment) {
  const containers = (await require('./docker').listContainers(environment.host_id))
    .filter(container => container.labels?.['com.docker.compose.project'] === environment.project_name
      || container.labels?.['docker-dash.preview.id'] === String(environment.id));
  for (const container of containers) {
    if (container.state === 'running' || container.state === 'paused') {
      if (container.state === 'paused') await require('./docker').containerAction(container.id, 'unpause', environment.host_id);
      await require('./docker').containerAction(container.id, 'stop', environment.host_id);
    }
    await require('./docker').removeContainer(container.id, { force: false, v: false }, environment.host_id);
  }
  const networks = await require('./docker').listNetworks(environment.host_id).catch(() => []);
  for (const network of networks.filter(item =>
    item.labels?.['com.docker.compose.project'] === environment.project_name
    && Object.keys(item.containers || {}).length === 0)) {
    await require('./docker').removeNetwork(network.id, environment.host_id);
  }
}

async function closePullRequest(stackId, prNumber) {
  const environment = getDb().prepare(
    'SELECT id FROM git_preview_environments WHERE stack_id = ? AND pr_number = ?'
  ).get(stackId, Number(prNumber));
  if (!environment) return { ok: true, missing: true };
  await _whenIdle(environment.id);
  return remove(environment.id, { reason: 'pull_request_closed' });
}

async function reapExpired() {
  const rows = getDb().prepare(`SELECT id FROM git_preview_environments
    WHERE expires_at <= ? AND status NOT IN ('deleting','deploying') ORDER BY expires_at LIMIT 50`).all(now());
  const results = [];
  for (const row of rows) {
    try { results.push(await remove(row.id, { reason: 'ttl_expired' })); }
    catch (err) { results.push({ ok: false, id: row.id, error: err.message }); }
  }
  return results;
}

module.exports = {
  getConfig, updateConfig, list, validatePullRequest, queuePullRequest,
  deploy, remove, closePullRequest, reapExpired,
  _internals: {
    _canonicalRepository, _projectName, _composeFiles, _validatePreviewCompose,
    _guardrailOverride, _previewCliEnvironment, _envLine,
  },
};
