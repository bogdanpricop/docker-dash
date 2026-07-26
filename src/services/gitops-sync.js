'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const { getDb } = require('../db');
const hostGroups = require('./host-groups');
const git = require('./git');
const procedures = require('./procedures');
const docker = require('./docker');

const API_VERSION = 'docker-dash.io/v1alpha1';
const KIND = 'FleetConfiguration';
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const HOST_ACTIONS = new Set([
  'pull_image', 'restart_container', 'stop_container', 'start_container', 'deploy_stack',
]);
const RESOURCE_COLLECTIONS = [
  ['host', 'hosts'], ['hostGroup', 'hostGroups'],
  ['gitStack', 'gitStacks'], ['procedure', 'procedures'],
];
const VALID_ENVIRONMENTS = new Set(['development', 'staging', 'production', 'custom']);

class GitOpsSyncService {
  capture() {
    const db = getDb();
    const hostRows = db.prepare('SELECT * FROM docker_hosts ORDER BY name, id').all();
    const hostNameById = new Map(hostRows.map(row => [Number(row.id), row.name]));
    const channels = db.prepare('SELECT id, name, provider FROM notification_channels ORDER BY name, id').all();
    const channelNameById = new Map(channels.map(row => [Number(row.id), row.name]));
    const stacks = git.listStacks();
    const stackNameById = new Map(stacks.map(stack => [Number(stack.id), stack.stack_name]));

    return {
      apiVersion: API_VERSION,
      kind: KIND,
      metadata: {
        name: 'docker-dash-fleet', authoritative: false,
        exportedAt: new Date().toISOString(),
      },
      spec: {
        hosts: hostRows.map(row => this._exportHost(row)),
        hostGroups: hostGroups.list().map(group => ({
          name: group.name,
          description: group.description || '',
          color: group.color || '#6366f1',
          icon: group.icon || 'fa-server',
          sortOrder: Number(group.sort_order) || 0,
          members: group.member_host_ids.map(id => hostNameById.get(Number(id)))
            .filter(Boolean).sort(),
        })),
        gitStacks: stacks.map(stack => this._exportGitStack(stack)),
        procedures: procedures.list().map(procedure => ({
          name: procedure.name,
          description: procedure.description || '',
          active: procedure.is_active,
          maxParallel: procedure.max_parallel,
          steps: procedure.steps.map(step => this._exportProcedureStep(
            procedure, step, hostNameById, stackNameById, channelNameById
          )),
        })),
        notificationReferences: channels.map(channel => ({
          name: channel.name, provider: channel.provider,
        })),
      },
    };
  }

  exportYaml() {
    return YAML.stringify(this.capture(), { lineWidth: 0 });
  }

  stateHash() {
    return this._hash(this._normalizeDocument(this.capture(), { allowDuplicateNames: true }).spec);
  }

  parse(input) {
    let value = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw Object.assign(new Error('GitOps document exceeds the 1 MiB limit'), { status: 413 });
      }
      try {
        value = YAML.parse(input, { maxAliasCount: 50 });
      } catch (err) {
        throw new Error(`Invalid YAML/JSON: ${err.message}`);
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('GitOps document must be an object');
    }
    return this._normalizeDocument(value);
  }

  plan(input) {
    const desired = this.parse(input);
    const current = this._normalizeDocument(this.capture(), { allowDuplicateNames: true });
    const actions = [];
    const blocked = [];
    const currentIndexes = {};
    const desiredIndexes = {};

    this._validateLiveIdentities(blocked);
    this._validateReferences(desired, current, blocked);

    for (const [resource, collection] of RESOURCE_COLLECTIONS) {
      currentIndexes[collection] = new Map(current.spec[collection].map(item => [item.name, item]));
      desiredIndexes[collection] = new Map(desired.spec[collection].map(item => [item.name, item]));
      for (const item of desired.spec[collection]) {
        const before = currentIndexes[collection].get(item.name);
        if (!before) {
          const reason = this._creationBlockReason(resource, item);
          if (reason) blocked.push({ resource, name: item.name, operation: 'create', reason });
          else actions.push({ operation: 'create', resource, name: item.name, after: item });
          continue;
        }
        if (this._canonical(before) === this._canonical(item)) {
          actions.push({ operation: 'unchanged', resource, name: item.name });
          continue;
        }
        const reason = this._updateBlockReason(resource, before, item);
        if (reason) blocked.push({ resource, name: item.name, operation: 'update', reason });
        else actions.push({
          operation: 'update', resource, name: item.name,
          before, after: item, changes: this._changedFields(before, item),
        });
      }

      if (desired.metadata.authoritative) {
        for (const before of current.spec[collection]) {
          if (desiredIndexes[collection].has(before.name)) continue;
          const reason = this._deletionBlockReason(resource, before);
          if (reason) blocked.push({ resource, name: before.name, operation: 'delete', reason });
          else actions.push({ operation: 'delete', resource, name: before.name, before });
        }
      }
    }

    const stateHash = this._hash(current.spec);
    const documentHash = this._hash(desired);
    const hashPayload = {
      stateHash, documentHash, authoritative: desired.metadata.authoritative,
      actions, blocked,
    };
    const planHash = this._hash(hashPayload);
    const summary = { create: 0, update: 0, delete: 0, unchanged: 0, blocked: blocked.length };
    for (const action of actions) summary[action.operation]++;
    return {
      apiVersion: API_VERSION, stateHash, documentHash, planHash,
      authoritative: desired.metadata.authoritative,
      requiresDeleteApproval: summary.delete > 0,
      summary, actions, blocked,
    };
  }

  async apply(input, { planHash, allowDelete = false, userId = null } = {}) {
    if (!planHash || typeof planHash !== 'string') {
      throw Object.assign(new Error('A precomputed planHash is required'), { status: 400 });
    }
    const desired = this.parse(input);
    const planned = this.plan(desired);
    if (!this._safeEqual(planHash, planned.planHash)) {
      throw Object.assign(new Error('GitOps plan is stale; generate and review a new plan'), {
        status: 409, code: 'STALE_PLAN', currentPlanHash: planned.planHash,
      });
    }
    if (planned.blocked.length) {
      throw Object.assign(new Error(`GitOps plan has ${planned.blocked.length} blocked action(s)`), {
        status: 409, code: 'BLOCKED_PLAN', blocked: planned.blocked,
      });
    }
    if (planned.summary.delete > 0 && (!desired.metadata.authoritative || allowDelete !== true)) {
      throw Object.assign(new Error('Deletes require metadata.authoritative=true and allowDelete=true'), {
        status: 409, code: 'DELETE_APPROVAL_REQUIRED',
      });
    }

    const results = [];
    const mutations = planned.actions.filter(action => action.operation !== 'unchanged');
    const applyOrder = { host: 1, hostGroup: 2, gitStack: 3, procedure: 4 };
    const deleteOrder = { procedure: 1, gitStack: 2, hostGroup: 3, host: 4 };
    const upserts = mutations.filter(action => action.operation !== 'delete')
      .sort((a, b) => applyOrder[a.resource] - applyOrder[b.resource]);
    const deletes = mutations.filter(action => action.operation === 'delete')
      .sort((a, b) => deleteOrder[a.resource] - deleteOrder[b.resource]);

    for (const action of [...upserts, ...deletes]) {
      await this._applyAction(action, userId);
      results.push({ operation: action.operation, resource: action.resource, name: action.name, status: 'applied' });
    }
    return {
      ok: true, planHash: planned.planHash, stateHashBefore: planned.stateHash,
      stateHashAfter: this._hash(this._normalizeDocument(this.capture(), { allowDuplicateNames: true }).spec),
      summary: planned.summary, results,
    };
  }

  _exportHost(row) {
    const hasSecret = !!(row.tls_config || row.ssh_config || row.daemon_config);
    const result = {
      name: row.name,
      daemonType: row.daemon_type || 'docker',
      connectionType: row.connection_type || 'socket',
      environment: row.environment || 'development',
      active: !!row.is_active,
      default: !!row.is_default,
    };
    if (result.connectionType === 'socket') result.socketPath = row.socket_path || '/var/run/docker.sock';
    if (result.connectionType === 'tcp' && row.host) result.address = row.host;
    if (result.connectionType === 'tcp' && row.port) result.port = Number(row.port);
    if (hasSecret) result.secretRef = `existing-host/${row.name}`;
    return result;
  }

  _exportGitStack(stack) {
    const additional = typeof stack.additional_files === 'string'
      ? this._parseJson(stack.additional_files, []) : (stack.additional_files || []);
    return {
      name: stack.stack_name,
      repository: this._safeRepoUrl(stack.repo_url),
      branch: stack.branch || 'main',
      composePath: stack.compose_path || 'docker-compose.yml',
      additionalFiles: additional,
      credentialRef: stack.credential_name || null,
      targets: (stack.targets || []).map(target => target.host_name).filter(Boolean).sort(),
      forceRedeploy: !!stack.force_redeploy,
      repullImages: !!stack.re_pull_images,
      skipTlsVerify: !!stack.tls_skip_verify,
      rollout: stack.rollout_policy,
      autoDeploy: {
        webhookProvider: stack.webhook_provider || 'github',
        pollingEnabled: !!stack.polling_enabled,
        pollingIntervalSeconds: Number(stack.polling_interval_seconds) || 300,
        deployOnPush: stack.deploy_on_push !== 0,
      },
    };
  }

  _exportProcedureStep(procedure, step, hostNames, stackNames, channelNames) {
    const config = { ...(step.action_config || {}) };
    const result = {
      id: step.id, stage: step.stage, needs: step.needs || [], enabled: step.enabled !== false,
      action: step.action_type, onError: step.on_error || 'stop', actionConfig: config,
    };
    if (HOST_ACTIONS.has(step.action_type)) {
      result.targetHostRef = hostNames.get(Number(step.target_host_id)) || `missing-host-id/${step.target_host_id}`;
    }
    if (step.action_type === 'run_git_stack') {
      result.gitStackRef = stackNames.get(Number(config.git_stack_id)) || `missing-git-stack-id/${config.git_stack_id}`;
      delete config.git_stack_id;
    }
    if (step.action_type === 'notify_channel' && config.channel_id) {
      result.notificationRef = channelNames.get(Number(config.channel_id)) || `missing-channel-id/${config.channel_id}`;
      delete config.channel_id;
    }
    if (step.action_type === 'webhook') {
      result.actionConfig = { secretRef: `existing-procedure/${procedure.name}/${step.id}` };
    }
    return result;
  }

  _normalizeDocument(document, { allowDuplicateNames = false } = {}) {
    if (document.apiVersion !== API_VERSION) throw new Error(`apiVersion must be ${API_VERSION}`);
    if (document.kind !== KIND) throw new Error(`kind must be ${KIND}`);
    const spec = document.spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec object is required');
    const list = key => {
      const value = spec[key] === undefined ? [] : spec[key];
      if (!Array.isArray(value)) throw new Error(`spec.${key} must be an array`);
      return value;
    };
    const normalized = {
      apiVersion: API_VERSION,
      kind: KIND,
      metadata: {
        name: this._name(document.metadata?.name || 'docker-dash-fleet', 'metadata.name'),
        authoritative: document.metadata?.authoritative === true,
      },
      spec: {
        hosts: list('hosts').map((item, index) => this._normalizeHost(item, index)),
        hostGroups: list('hostGroups').map((item, index) => this._normalizeGroup(item, index)),
        gitStacks: list('gitStacks').map((item, index) => this._normalizeStack(item, index)),
        procedures: list('procedures').map((item, index) => this._normalizeProcedure(item, index)),
        notificationReferences: list('notificationReferences')
          .map((item, index) => this._normalizeNotification(item, index)),
      },
    };
    for (const key of Object.keys(normalized.spec)) {
      if (!allowDuplicateNames) this._assertUnique(normalized.spec[key], `spec.${key}`);
      normalized.spec[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    const defaults = normalized.spec.hosts.filter(host => host.default);
    if (!allowDuplicateNames && defaults.length > 1) throw new Error('Only one desired host may be marked as default');
    if (!allowDuplicateNames && normalized.metadata.authoritative
        && normalized.spec.hosts.length && defaults.length !== 1) {
      throw new Error('An authoritative document with hosts must define exactly one default host');
    }
    return normalized;
  }

  _normalizeHost(item, index) {
    const name = this._name(item?.name, `Host ${index + 1} name`);
    const daemonType = String(item.daemonType || 'docker');
    const allowedDaemons = ['docker', 'podman', 'incus', 'lxd', 'proxmox', 'kubernetes', 'nomad', 'vsphere'];
    if (!allowedDaemons.includes(daemonType)) throw new Error(`Host "${name}": unsupported daemonType`);
    const connectionType = String(item.connectionType || 'socket');
    if (!['socket', 'tcp', 'ssh'].includes(connectionType)) throw new Error(`Host "${name}": unsupported connectionType`);
    const environment = VALID_ENVIRONMENTS.has(item.environment) ? item.environment : 'development';
    const result = {
      name, daemonType, connectionType, environment,
      active: item.active !== false, default: item.default === true,
    };
    if (connectionType === 'socket') {
      result.socketPath = String(item.socketPath || '/var/run/docker.sock');
      if (!/^\/[a-zA-Z0-9_./-]+$/.test(result.socketPath)) throw new Error(`Host "${name}": invalid socketPath`);
    }
    if (connectionType === 'tcp' && item.address) result.address = String(item.address).trim();
    if (connectionType === 'tcp' && item.port !== undefined && item.port !== null) {
      result.port = Number(item.port);
      if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error(`Host "${name}": invalid port`);
    }
    if (item.secretRef) result.secretRef = String(item.secretRef);
    return result;
  }

  _normalizeGroup(item, index) {
    const name = this._name(item?.name, `Host group ${index + 1} name`);
    const members = Array.isArray(item.members) ? [...new Set(item.members.map(value => String(value).trim()).filter(Boolean))].sort() : [];
    return {
      name, description: String(item.description || '').substring(0, 1000),
      color: String(item.color || '#6366f1'), icon: String(item.icon || 'fa-server'),
      sortOrder: Number.isInteger(Number(item.sortOrder)) ? Number(item.sortOrder) : 0,
      members,
    };
  }

  _normalizeStack(item, index) {
    const name = this._name(item?.name, `Git stack ${index + 1} name`);
    const repository = String(item.repository || '').trim();
    if (!repository) throw new Error(`Git stack "${name}": repository is required`);
    git._validateRepoUrl(repository);
    const targets = Array.isArray(item.targets)
      ? [...new Set(item.targets.map(value => String(value).trim()).filter(Boolean))].sort() : [];
    if (!targets.length) throw new Error(`Git stack "${name}": at least one target is required`);
    const additionalFiles = Array.isArray(item.additionalFiles)
      ? item.additionalFiles.map(value => String(value)) : [];
    git._validateComposePath(String(item.composePath || 'docker-compose.yml'));
    for (const file of additionalFiles) git._validateComposePath(file);
    const rollout = git._validateRolloutPolicy(item.rollout, { allowDisabled: true });
    const auto = item.autoDeploy || {};
    const pollingIntervalSeconds = Number.isInteger(Number(auto.pollingIntervalSeconds))
      ? Number(auto.pollingIntervalSeconds) : 300;
    if (pollingIntervalSeconds < 60 || pollingIntervalSeconds > 86400) {
      throw new Error(`Git stack "${name}": polling interval must be between 60 and 86400 seconds`);
    }
    return {
      name, repository, branch: String(item.branch || 'main'),
      composePath: String(item.composePath || 'docker-compose.yml'), additionalFiles,
      credentialRef: item.credentialRef ? String(item.credentialRef) : null,
      targets, forceRedeploy: item.forceRedeploy !== false,
      repullImages: item.repullImages === true, skipTlsVerify: item.skipTlsVerify === true,
      rollout,
      autoDeploy: {
        webhookProvider: String(auto.webhookProvider || 'github'),
        pollingEnabled: auto.pollingEnabled === true,
        pollingIntervalSeconds,
        deployOnPush: auto.deployOnPush !== false,
      },
    };
  }

  _normalizeProcedure(item, index) {
    const name = this._name(item?.name, `Procedure ${index + 1} name`);
    if (!Array.isArray(item.steps) || !item.steps.length) throw new Error(`Procedure "${name}": steps are required`);
    const steps = item.steps.map((step, stepIndex) => {
      const action = String(step.action || step.action_type || '');
      const actionConfig = step.actionConfig && typeof step.actionConfig === 'object'
        && !Array.isArray(step.actionConfig) ? { ...step.actionConfig } : {};
      if (action === 'webhook' && actionConfig.url) {
        throw new Error(`Procedure "${name}" step ${stepIndex + 1}: webhook URLs must use a symbolic secretRef`);
      }
      const result = {
        id: String(step.id || `step-${stepIndex + 1}`),
        stage: Number(step.stage ?? stepIndex + 1),
        needs: Array.isArray(step.needs) ? step.needs.map(value => String(value)) : [],
        enabled: step.enabled !== false,
        action, onError: String(step.onError || step.on_error || 'stop'),
        actionConfig,
      };
      if (step.targetHostRef) result.targetHostRef = String(step.targetHostRef);
      if (step.gitStackRef) result.gitStackRef = String(step.gitStackRef);
      if (step.notificationRef) result.notificationRef = String(step.notificationRef);
      return result;
    });
    const maxParallel = Number(item.maxParallel ?? 4);
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) {
      throw new Error(`Procedure "${name}": maxParallel must be between 1 and 10`);
    }
    this._validateProcedureStructure(name, steps);
    return {
      name, description: String(item.description || '').substring(0, 1000),
      active: item.active !== false,
      maxParallel, steps,
    };
  }

  _normalizeNotification(item, index) {
    return {
      name: this._name(item?.name, `Notification reference ${index + 1} name`),
      provider: String(item.provider || ''),
    };
  }

  _validateLiveIdentities(blocked) {
    const db = getDb();
    const checks = [
      ['host', 'docker_hosts'], ['notificationReference', 'notification_channels'],
      ['gitCredential', 'git_credentials'],
    ];
    for (const [resource, table] of checks) {
      const duplicates = db.prepare(`
        SELECT name, COUNT(*) AS count FROM ${table} GROUP BY name HAVING COUNT(*) > 1
      `).all();
      for (const duplicate of duplicates) {
        blocked.push({
          resource, name: duplicate.name, operation: 'resolve',
          reason: `Live state has ${duplicate.count} resources with this name`,
        });
      }
    }
  }

  _validateReferences(desired, current, blocked) {
    const db = getDb();
    const hostNames = new Set(desired.metadata.authoritative
      ? desired.spec.hosts.map(item => item.name)
      : [...current.spec.hosts.map(item => item.name), ...desired.spec.hosts.map(item => item.name)]);
    const stackNames = new Set(desired.metadata.authoritative
      ? desired.spec.gitStacks.map(item => item.name)
      : [...current.spec.gitStacks.map(item => item.name), ...desired.spec.gitStacks.map(item => item.name)]);
    const credentials = new Map(db.prepare('SELECT name, COUNT(*) AS count FROM git_credentials GROUP BY name').all()
      .map(row => [row.name, row.count]));
    const channels = new Map(db.prepare('SELECT name, provider, COUNT(*) AS count FROM notification_channels GROUP BY name, provider').all()
      .map(row => [row.name, row]));

    const missing = (resource, name, reference, reason) => blocked.push({
      resource, name, operation: 'resolve', reference, reason,
    });
    for (const group of desired.spec.hostGroups) {
      for (const member of group.members) if (!hostNames.has(member)) {
        missing('hostGroup', group.name, member, 'Referenced host does not exist in live or desired state');
      }
    }
    for (const stack of desired.spec.gitStacks) {
      for (const target of stack.targets) if (!hostNames.has(target)) {
        missing('gitStack', stack.name, target, 'Target host does not exist in live or desired state');
      }
      if (stack.credentialRef && credentials.get(stack.credentialRef) !== 1) {
        missing('gitStack', stack.name, stack.credentialRef, 'Credential reference is missing or ambiguous');
      }
    }
    for (const reference of desired.spec.notificationReferences) {
      const live = channels.get(reference.name);
      if (!live || live.count !== 1 || (reference.provider && live.provider !== reference.provider)) {
        missing('notificationReference', reference.name, reference.provider, 'Notification reference is missing, ambiguous, or has a different provider');
      }
    }
    for (const procedure of desired.spec.procedures) {
      for (const step of procedure.steps) {
        if (HOST_ACTIONS.has(step.action) && (!step.targetHostRef || !hostNames.has(step.targetHostRef))) {
          missing('procedure', procedure.name, step.targetHostRef, `Step "${step.id}" target host is missing`);
        }
        if (step.action === 'run_git_stack' && (!step.gitStackRef || !stackNames.has(step.gitStackRef))) {
          missing('procedure', procedure.name, step.gitStackRef, `Step "${step.id}" Git stack is missing`);
        }
        if (step.action === 'notify_channel' && step.notificationRef) {
          const channel = channels.get(step.notificationRef);
          if (!channel || channel.count !== 1) {
            missing('procedure', procedure.name, step.notificationRef, `Step "${step.id}" notification reference is missing or ambiguous`);
          }
        }
      }
    }
  }

  _creationBlockReason(resource, item) {
    if (resource === 'host' && (item.secretRef || !['docker', 'podman'].includes(item.daemonType)
        || item.connectionType === 'ssh')) {
      return 'A new secret-backed host must be registered interactively before it can be referenced declaratively';
    }
    if (resource === 'host' && item.connectionType === 'tcp' && !item.address) {
      return 'A new TCP host requires an address';
    }
    if (resource === 'procedure' && item.steps.some(step => step.action === 'webhook')) {
      return 'A procedure with symbolic webhook secrets must already exist so its secret can be preserved';
    }
    return null;
  }

  _updateBlockReason(resource, before, after) {
    if (resource === 'host') {
      if (before.daemonType !== after.daemonType) return 'daemonType is immutable in declarative sync';
      if (before.secretRef && before.secretRef !== after.secretRef) return 'The existing host secretRef must be preserved';
      if (!before.secretRef && after.secretRef) return 'Secret material must be configured interactively';
      if (after.connectionType === 'ssh' && !before.secretRef) return 'SSH credentials must be configured interactively';
    }
    if (resource === 'gitStack') {
      if (before.repository !== after.repository) return 'Git repository URL is immutable; create a new stack name instead';
      const live = git.listStacks().find(stack => stack.stack_name === after.name);
      if (live && ['cloning', 'deploying'].includes(live.status)) return 'Git stack is currently deploying';
    }
    if (resource === 'procedure') {
      const beforeSteps = new Map(before.steps.map(step => [step.id, step]));
      for (const step of after.steps.filter(candidate => candidate.action === 'webhook')) {
        const existing = beforeSteps.get(step.id);
        if (!existing || existing.action !== 'webhook'
            || step.actionConfig.secretRef !== existing.actionConfig.secretRef) {
          return `Webhook step "${step.id}" must preserve its existing symbolic secretRef`;
        }
      }
    }
    return null;
  }

  _deletionBlockReason(resource, before) {
    const db = getDb();
    if (resource === 'host' && before.default) return 'The default host cannot be deleted';
    if (resource === 'gitStack') {
      const live = git.listStacks().find(stack => stack.stack_name === before.name);
      if (live && ['cloning', 'deploying'].includes(live.status)) return 'Git stack is currently deploying';
    }
    if (resource === 'procedure') {
      const row = db.prepare(`
        SELECT pr.id FROM procedure_runs pr JOIN procedures p ON p.id = pr.procedure_id
        WHERE p.name = ? AND pr.status = 'running' LIMIT 1
      `).get(before.name);
      if (row) return 'Procedure is currently running';
    }
    return null;
  }

  async _applyAction(action, userId) {
    if (action.resource === 'host') {
      if (action.operation === 'create') return this._createHost(action.after);
      if (action.operation === 'update') return this._updateHost(action.after);
      return this._deleteHost(action.name);
    }
    if (action.resource === 'hostGroup') {
      if (action.operation === 'create') {
        return hostGroups.create(this._groupPayload(action.after), userId);
      }
      const existing = hostGroups.list().find(group => group.name === action.name);
      if (action.operation === 'update') return hostGroups.update(existing.id, this._groupPayload(action.after));
      return hostGroups.remove(existing.id);
    }
    if (action.resource === 'gitStack') {
      if (action.operation === 'create') return this._createGitStack(action.after, userId);
      const existing = git.listStacks().find(stack => stack.stack_name === action.name);
      if (action.operation === 'update') return this._updateGitStack(existing.id, action.after);
      return git.deleteStack(existing.id, { removeContainers: false, removeVolumes: false });
    }
    if (action.resource === 'procedure') {
      const existing = procedures.list().find(procedure => procedure.name === action.name);
      if (action.operation === 'create') {
        return procedures.create({ ...this._procedurePayload(action.after, null), created_by: userId });
      }
      if (action.operation === 'update') {
        return procedures.update(existing.id, this._procedurePayload(action.after, existing));
      }
      return procedures.delete(existing.id);
    }
    throw new Error(`Unsupported GitOps resource: ${action.resource}`);
  }

  _createHost(spec) {
    const db = getDb();
    if (spec.default) db.prepare('UPDATE docker_hosts SET is_default = 0').run();
    return db.prepare(`
      INSERT INTO docker_hosts
        (name, connection_type, socket_path, host, port, is_active, is_default, environment, daemon_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      spec.name, spec.connectionType, spec.socketPath || '/var/run/docker.sock',
      spec.address || null, spec.port || null, spec.active ? 1 : 0, spec.default ? 1 : 0,
      spec.environment, spec.daemonType
    );
  }

  _updateHost(spec) {
    const db = getDb();
    const row = this._oneByName('docker_hosts', spec.name);
    if (spec.default) db.prepare('UPDATE docker_hosts SET is_default = 0 WHERE id != ?').run(row.id);
    db.prepare(`
      UPDATE docker_hosts SET connection_type = ?, socket_path = ?, host = ?, port = ?,
        is_active = ?, is_default = ?, environment = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      spec.connectionType, spec.socketPath || row.socket_path,
      spec.address !== undefined ? spec.address : row.host,
      spec.port !== undefined ? spec.port : row.port,
      spec.active ? 1 : 0, spec.default ? 1 : 0, spec.environment, row.id
    );
    docker.dropConnection(row.id);
  }

  _deleteHost(name) {
    const db = getDb();
    const row = this._oneByName('docker_hosts', name);
    if (row.is_default) throw new Error('Cannot delete the default host');
    try { require('./ssh-tunnel').closeTunnel(row.id); } catch { /* no active tunnel */ }
    docker.dropConnection(row.id);
    db.prepare('DELETE FROM docker_hosts WHERE id = ?').run(row.id);
  }

  _groupPayload(spec) {
    return {
      name: spec.name, description: spec.description, color: spec.color, icon: spec.icon,
      sortOrder: spec.sortOrder,
      hostIds: spec.members.map(name => this._oneByName('docker_hosts', name).id),
    };
  }

  _gitStackPayload(spec) {
    const credential = spec.credentialRef ? this._oneByName('git_credentials', spec.credentialRef) : null;
    return {
      stack_name: spec.name, repo_url: spec.repository, branch: spec.branch,
      compose_path: spec.composePath, additional_files: spec.additionalFiles,
      credential_id: credential?.id || null,
      target_host_ids: spec.targets.map(name => this._oneByName('docker_hosts', name).id),
      force_redeploy: spec.forceRedeploy, re_pull_images: spec.repullImages,
      tls_skip_verify: spec.skipTlsVerify, rollout_policy: spec.rollout,
    };
  }

  _createGitStack(spec, userId) {
    const payload = this._gitStackPayload(spec);
    const created = git.createStack({
      ...payload, created_by: userId, deploy_immediately: false,
    });
    git.updateAutoDeployConfig(created.id, {
      webhook_provider: spec.autoDeploy.webhookProvider,
      polling_enabled: spec.autoDeploy.pollingEnabled,
      polling_interval_seconds: spec.autoDeploy.pollingIntervalSeconds,
      deploy_on_push: spec.autoDeploy.deployOnPush,
    });
    return created;
  }

  _updateGitStack(id, spec) {
    git.updateStack(id, this._gitStackPayload(spec));
    git.updateAutoDeployConfig(id, {
      webhook_provider: spec.autoDeploy.webhookProvider,
      polling_enabled: spec.autoDeploy.pollingEnabled,
      polling_interval_seconds: spec.autoDeploy.pollingIntervalSeconds,
      deploy_on_push: spec.autoDeploy.deployOnPush,
    });
  }

  _procedurePayload(spec, existing) {
    const oldSteps = new Map((existing?.steps || []).map(step => [step.id, step]));
    const steps = spec.steps.map(step => {
      let config = { ...step.actionConfig };
      if (step.action === 'webhook') {
        const old = oldSteps.get(step.id);
        if (!old || old.action_type !== 'webhook') throw new Error(`Cannot resolve webhook secret for step "${step.id}"`);
        config = { ...old.action_config };
      }
      if (step.action === 'run_git_stack') {
        config.git_stack_id = this._oneByName('git_stacks', step.gitStackRef, 'stack_name').id;
      }
      if (step.action === 'notify_channel' && step.notificationRef) {
        config.channel_id = this._oneByName('notification_channels', step.notificationRef).id;
      }
      const result = {
        id: step.id, stage: step.stage, needs: step.needs, enabled: step.enabled,
        action_type: step.action, action_config: config, on_error: step.onError,
      };
      if (HOST_ACTIONS.has(step.action)) {
        result.target_host_id = this._oneByName('docker_hosts', step.targetHostRef).id;
      }
      return result;
    });
    return {
      name: spec.name, description: spec.description, is_active: spec.active,
      max_parallel: spec.maxParallel, steps,
    };
  }

  _oneByName(table, name, column = 'name') {
    const rows = getDb().prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).all(name);
    if (rows.length !== 1) throw new Error(`${table} reference "${name}" is missing or ambiguous`);
    return rows[0];
  }

  _assertUnique(items, path) {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.name)) throw new Error(`${path} contains duplicate name "${item.name}"`);
      seen.add(item.name);
    }
  }

  _validateProcedureStructure(name, steps) {
    if (steps.length > 50) throw new Error(`Procedure "${name}": at most 50 steps are allowed`);
    const allowed = new Set(procedures.ACTION_TYPES || []);
    const byId = new Map();
    for (const [index, step] of steps.entries()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(step.id)) {
        throw new Error(`Procedure "${name}" step ${index + 1}: invalid ID`);
      }
      if (byId.has(step.id)) throw new Error(`Procedure "${name}": duplicate step ID "${step.id}"`);
      if (!Number.isInteger(step.stage) || step.stage < 1 || step.stage > 50) {
        throw new Error(`Procedure "${name}" step "${step.id}": stage must be between 1 and 50`);
      }
      if (!allowed.has(step.action)) throw new Error(`Procedure "${name}" step "${step.id}": unsupported action`);
      if (!['stop', 'continue'].includes(step.onError)) throw new Error(`Procedure "${name}" step "${step.id}": invalid onError`);
      const config = step.actionConfig;
      if (['restart_container', 'stop_container', 'start_container'].includes(step.action)
          && !String(config.container_id || '').trim()) {
        throw new Error(`Procedure "${name}" step "${step.id}": container_id is required`);
      }
      if (step.action === 'pull_image' && !String(config.image || '').trim()) {
        throw new Error(`Procedure "${name}" step "${step.id}": image is required`);
      }
      if (step.action === 'deploy_stack' && !String(config.stack_name || '').trim()) {
        throw new Error(`Procedure "${name}" step "${step.id}": stack_name is required`);
      }
      if (step.action === 'wait_seconds') {
        const seconds = Number(config.seconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
          throw new Error(`Procedure "${name}" step "${step.id}": seconds must be between 0 and 3600`);
        }
      }
      if (step.action === 'webhook' && !config.secretRef) {
        throw new Error(`Procedure "${name}" step "${step.id}": webhook secretRef is required`);
      }
      byId.set(step.id, step);
    }
    for (const step of steps) {
      for (const dependencyId of step.needs) {
        const dependency = byId.get(dependencyId);
        if (!dependency) throw new Error(`Procedure "${name}" step "${step.id}": dependency "${dependencyId}" is missing`);
        if (dependency.stage > step.stage) throw new Error(`Procedure "${name}" step "${step.id}": dependency "${dependencyId}" is in a later stage`);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Procedure "${name}": dependency cycle at "${id}"`);
      visiting.add(id);
      for (const dependency of byId.get(id).needs) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const step of steps) visit(step.id);
  }

  _name(value, label) {
    const name = String(value || '').trim();
    if (!name || name.length > 100) throw new Error(`${label} must be between 1 and 100 characters`);
    return name;
  }

  _changedFields(before, after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter(key => this._canonical(before[key]) !== this._canonical(after[key])).sort();
  }

  _safeRepoUrl(value) {
    try {
      const parsed = new URL(value);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return String(value).replace(/^(https?:\/\/)[^/@]+@/i, '$1');
    }
  }

  _parseJson(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  _canonical(value) {
    if (Array.isArray(value)) return `[${value.map(item => this._canonical(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this._canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  _hash(value) {
    return crypto.createHash('sha256').update(this._canonical(value)).digest('hex');
  }

  _safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
}

module.exports = new GitOpsSyncService();
module.exports.API_VERSION = API_VERSION;
module.exports.KIND = KIND;
