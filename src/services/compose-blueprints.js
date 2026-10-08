'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const { getDb } = require('../db');
const registryService = require('./registry');
const ociComposeService = require('./oci-compose');
const provenanceParserService = require('./registry-provenance');
const { assertSecretReferenceAdmission, _internals: secretInternals } = require('./secret-reference-admission');

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KEY = /^[a-z][a-zA-Z0-9_]{0,49}$/;
const SECRET_KEY = /password|passphrase|token|credential|private.?key|authorization|cookie|api.?key/i;
const TOKEN = /^\{\{parameter\.([a-z][a-zA-Z0-9_]{0,49})\}\}$/;
const TOKEN_ANY = /\{\{parameter\.[^}]+\}\}/;
const ENVIRONMENTS = new Set(['development', 'staging', 'production']);
const TYPES = new Set(['string', 'integer', 'boolean', 'enum', 'secret_ref']);
const SUPPORT_LEVELS = new Set(['community', 'supported', 'critical']);
const VERSION_STATES = {
  draft: new Set(['published']),
  published: new Set(['deprecated']),
  deprecated: new Set(['published', 'retired']),
  retired: new Set(),
};
const BLUEPRINT_STATES = {
  draft: new Set(['active', 'retired']),
  active: new Set(['deprecated']),
  deprecated: new Set(['retired']),
  retired: new Set(),
};

class ComposeBlueprintError extends Error {
  constructor(message, status = 400, code = 'COMPOSE_BLUEPRINT_ERROR', details = null) {
    super(message);
    this.name = 'ComposeBlueprintError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(message, status = 400, code = 'INVALID_INPUT', details = null) {
  throw new ComposeBlueprintError(message, status, code, details);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function text(value, label, max = 500, required = true) {
  const normalized = String(value ?? '').trim();
  if ((required && !normalized) || normalized.length > max) fail(`${label} is invalid`);
  return normalized;
}

function exact(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function parse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function bool(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

function blueprintRow(row, currentVersion = null) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    owner: row.owner,
    supportLevel: row.support_level,
    lifecycle: row.lifecycle,
    currentVersionId: row.current_version_id,
    currentVersion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    version: row.version,
    registryId: row.registry_id,
    repository: row.repository,
    sourceRef: row.source_ref,
    digest: row.digest,
    signaturePolicy: row.signature_policy,
    signerPattern: row.signer_pattern,
    provenance: parse(row.provenance_json, {}),
    parameterSchema: parse(row.parameter_schema_json, { parameters: [] }),
    overrideTemplate: row.override_template_yaml,
    compatibility: parse(row.compatibility_json, {}),
    operationalProfile: parse(row.operational_profile_json, {}),
    changelog: row.changelog,
    state: row.state,
    versionHash: row.version_hash,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function instantiationRow(row) {
  return {
    id: row.id,
    blueprintVersionId: row.blueprint_version_id,
    artifactId: row.artifact_id,
    hostId: row.host_id,
    instanceName: row.instance_name,
    projectName: row.project_name,
    environment: row.environment,
    parametersHash: row.parameters_hash,
    renderedOverrideHash: row.rendered_override_hash,
    planHash: row.plan_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

class ComposeBlueprintService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider;
    this.registry = options.registry || registryService;
    this.ociCompose = options.ociCompose || ociComposeService;
    this.provenanceParser = options.provenanceParser || provenanceParserService;
  }

  _db() { return this._dbProvider(); }

  _admin(actor) {
    if (!actor || actor.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED');
  }

  _operator(actor) {
    if (!actor || !['admin', 'operator'].includes(actor.role)) fail('Operator access required', 403, 'OPERATOR_REQUIRED');
  }

  _blueprint(idOrSlug) {
    const row = /^\d+$/.test(String(idOrSlug))
      ? this._db().prepare('SELECT * FROM compose_blueprints WHERE id=?').get(Number(idOrSlug))
      : this._db().prepare('SELECT * FROM compose_blueprints WHERE slug=?').get(String(idOrSlug));
    if (!row) fail('Compose blueprint not found', 404, 'BLUEPRINT_NOT_FOUND');
    return row;
  }

  _version(id) {
    const row = this._db().prepare(`SELECT v.*,b.slug AS blueprint_slug,b.name AS blueprint_name,
      b.lifecycle AS blueprint_lifecycle FROM compose_blueprint_versions v
      JOIN compose_blueprints b ON b.id=v.blueprint_id WHERE v.id=?`).get(Number(id));
    if (!row) fail('Compose blueprint version not found', 404, 'BLUEPRINT_VERSION_NOT_FOUND');
    return row;
  }

  _host(id) {
    const host = this._db().prepare('SELECT id,name,is_active,daemon_type FROM docker_hosts WHERE id=?').get(Number(id));
    if (!host) fail('Deployment host not found', 404, 'HOST_NOT_FOUND');
    if (!host.is_active || !['docker', 'podman'].includes(host.daemon_type || 'docker')) {
      fail('Host is not an active Compose target', 409, 'HOST_NOT_COMPATIBLE');
    }
    return host;
  }

  list(actor, filters = {}) {
    this._operator(actor);
    const includeAll = actor.role === 'admin' && filters.includeAll === true;
    const query = String(filters.query || '').trim().toLowerCase().slice(0, 100);
    const lifecycle = filters.lifecycle ? String(filters.lifecycle) : null;
    const rows = this._db().prepare(`SELECT b.*,v.id AS v_id,v.blueprint_id AS v_blueprint_id,
      v.version AS v_version,v.registry_id AS v_registry_id,v.repository AS v_repository,
      v.source_ref AS v_source_ref,v.digest AS v_digest,v.signature_policy AS v_signature_policy,
      v.signer_pattern AS v_signer_pattern,v.provenance_json AS v_provenance_json,
      v.parameter_schema_json AS v_parameter_schema_json,v.override_template_yaml AS v_override_template_yaml,
      v.compatibility_json AS v_compatibility_json,v.operational_profile_json AS v_operational_profile_json,
      v.changelog AS v_changelog,v.state AS v_state,
      v.version_hash AS v_version_hash,v.created_at AS v_created_at,v.published_at AS v_published_at
      FROM compose_blueprints b LEFT JOIN compose_blueprint_versions v ON v.id=b.current_version_id
      ORDER BY b.name COLLATE NOCASE`).all();
    const items = rows.map(row => {
      const current = row.v_id ? versionRow({
        id: row.v_id, blueprint_id: row.v_blueprint_id, version: row.v_version,
        registry_id: row.v_registry_id, repository: row.v_repository, source_ref: row.v_source_ref,
        digest: row.v_digest, signature_policy: row.v_signature_policy, signer_pattern: row.v_signer_pattern,
        provenance_json: row.v_provenance_json, parameter_schema_json: row.v_parameter_schema_json,
        override_template_yaml: row.v_override_template_yaml, compatibility_json: row.v_compatibility_json,
        operational_profile_json: row.v_operational_profile_json,
        changelog: row.v_changelog, state: row.v_state, version_hash: row.v_version_hash,
        created_at: row.v_created_at, published_at: row.v_published_at,
      }) : null;
      return blueprintRow(row, current);
    }).filter(item => (includeAll || ['active', 'deprecated'].includes(item.lifecycle))
      && (!lifecycle || item.lifecycle === lifecycle)
      && (!query || `${item.name} ${item.slug} ${item.category} ${item.owner} ${item.description}`.toLowerCase().includes(query)));
    return {
      items,
      summary: items.reduce((out, item) => {
        out[item.lifecycle] = (out[item.lifecycle] || 0) + 1;
        return out;
      }, { total: items.length }),
    };
  }

  get(idOrSlug, actor, includeVersions = false) {
    this._operator(actor);
    const row = this._blueprint(idOrSlug);
    if (actor.role !== 'admin' && !['active', 'deprecated'].includes(row.lifecycle)) {
      fail('Compose blueprint not found', 404, 'BLUEPRINT_NOT_FOUND');
    }
    const current = row.current_version_id
      ? versionRow(this._db().prepare('SELECT * FROM compose_blueprint_versions WHERE id=?').get(row.current_version_id))
      : null;
    const result = { blueprint: blueprintRow(row, current) };
    if (includeVersions) {
      result.versions = this._db().prepare('SELECT * FROM compose_blueprint_versions WHERE blueprint_id=? ORDER BY id DESC')
        .all(row.id).map(versionRow).filter(version => actor.role === 'admin' || version.state !== 'draft');
    }
    return result;
  }

  save(id, input, actor) {
    this._admin(actor);
    exact(input, 'blueprint', ['slug', 'name', 'description', 'category', 'owner', 'supportLevel']);
    const slug = text(input.slug, 'slug', 80);
    if (!SLUG.test(slug)) fail('slug must contain lowercase letters, digits and hyphens');
    const values = {
      name: text(input.name, 'name', 120),
      description: text(input.description || '', 'description', 2000, false),
      category: text(input.category || 'application', 'category', 80),
      owner: text(input.owner, 'owner', 120),
      supportLevel: String(input.supportLevel || 'supported'),
    };
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(values.category)) fail('category is invalid');
    if (!SUPPORT_LEVELS.has(values.supportLevel)) fail('supportLevel is invalid');
    try {
      if (id == null) {
        const result = this._db().prepare(`INSERT INTO compose_blueprints
          (slug,name,description,category,owner,support_level,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?)`)
          .run(slug, values.name, values.description, values.category, values.owner, values.supportLevel, actor.id, actor.id);
        return this.get(result.lastInsertRowid, actor, true);
      }
      const current = this._blueprint(id);
      if (current.lifecycle === 'retired') fail('Retired blueprints are immutable', 409, 'BLUEPRINT_RETIRED');
      this._db().prepare(`UPDATE compose_blueprints SET slug=?,name=?,description=?,category=?,owner=?,support_level=?,
        updated_by=?,updated_at=datetime('now') WHERE id=?`)
        .run(slug, values.name, values.description, values.category, values.owner, values.supportLevel, actor.id, current.id);
      return this.get(current.id, actor, true);
    } catch (error) {
      if (error instanceof ComposeBlueprintError) throw error;
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('Blueprint slug already exists', 409, 'BLUEPRINT_SLUG_EXISTS');
      throw error;
    }
  }

  transition(id, state, actor) {
    this._admin(actor);
    const row = this._blueprint(id);
    const target = String(state || '');
    if (!BLUEPRINT_STATES[row.lifecycle]?.has(target)) fail('Blueprint lifecycle transition is invalid', 409, 'INVALID_LIFECYCLE_TRANSITION');
    if (target === 'active') {
      const current = row.current_version_id
        ? this._db().prepare("SELECT id FROM compose_blueprint_versions WHERE id=? AND state='published'").get(row.current_version_id) : null;
      if (!current) fail('An active blueprint requires a published version', 409, 'PUBLISHED_VERSION_REQUIRED');
    }
    this._db().prepare("UPDATE compose_blueprints SET lifecycle=?,updated_by=?,updated_at=datetime('now') WHERE id=?")
      .run(target, actor.id, row.id);
    return this.get(row.id, actor, true);
  }

  _schema(input) {
    exact(input, 'parameterSchema', ['parameters']);
    if (!Array.isArray(input.parameters) || input.parameters.length > 50) fail('parameterSchema.parameters must contain at most 50 entries');
    const keys = new Set();
    const parameters = input.parameters.map((raw, index) => {
      exact(raw, `parameters[${index}]`, ['key', 'label', 'description', 'type', 'required', 'default', 'options', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum']);
      const key = String(raw.key || '');
      if (!KEY.test(key) || keys.has(key)) fail('Parameter keys must be unique lower-camel identifiers');
      const type = String(raw.type || '');
      if (!TYPES.has(type)) fail(`Parameter ${key} has an unsupported type`);
      if (SECRET_KEY.test(key) && type !== 'secret_ref') fail(`Parameter ${key} may not accept inline secret material`);
      if (type === 'secret_ref' && !/(?:ref|reference)$/i.test(key)) fail('Secret-reference parameter keys must end in Ref or Reference');
      const parameter = {
        key,
        label: text(raw.label || key, `${key}.label`, 100),
        description: text(raw.description || '', `${key}.description`, 500, false),
        type,
        required: bool(raw.required),
      };
      if (raw.pattern != null) {
        if (type !== 'string') fail(`Parameter ${key}.pattern is only valid for strings`);
        parameter.pattern = text(raw.pattern, `${key}.pattern`, 200);
        try { new RegExp(parameter.pattern); } catch { fail(`Parameter ${key} pattern is invalid`); }
      }
      if (type === 'enum') {
        if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 50) fail(`Parameter ${key} requires 1-50 options`);
        parameter.options = [...new Set(raw.options.map(value => text(value, `${key}.option`, 200)))];
      }
      for (const field of ['minLength', 'maxLength', 'minimum', 'maximum']) {
        if (raw[field] != null) {
          const number = Number(raw[field]);
          if (!Number.isSafeInteger(number)) fail(`Parameter ${key}.${field} must be an integer`);
          if (['minLength', 'maxLength'].includes(field) && type !== 'string') fail(`Parameter ${key}.${field} is only valid for strings`);
          if (['minimum', 'maximum'].includes(field) && type !== 'integer') fail(`Parameter ${key}.${field} is only valid for integers`);
          if (['minLength', 'maxLength'].includes(field) && (number < 0 || number > 500)) fail(`Parameter ${key}.${field} must be between 0 and 500`);
          parameter[field] = number;
        }
      }
      if (parameter.minLength != null && parameter.maxLength != null && parameter.minLength > parameter.maxLength) {
        fail(`Parameter ${key} has an invalid length range`);
      }
      if (parameter.minimum != null && parameter.maximum != null && parameter.minimum > parameter.maximum) {
        fail(`Parameter ${key} has an invalid numeric range`);
      }
      if (Object.hasOwn(raw, 'default')) parameter.default = raw.default;
      keys.add(key);
      return parameter;
    });
    const schema = { parameters };
    const defaults = Object.fromEntries(parameters.filter(parameter => Object.hasOwn(parameter, 'default'))
      .map(parameter => [parameter.key, parameter.default]));
    this._normalize({ parameters: parameters.map(parameter => ({ ...parameter, required: false })) }, defaults);
    return schema;
  }

  _compatibility(input = {}) {
    exact(input, 'compatibility', ['daemonTypes', 'architectures', 'environments', 'minimumComposeVersion', 'requiresCosign']);
    const list = (value, allowed, label, max) => {
      if (!Array.isArray(value) || !value.length || value.length > max) fail(`${label} is invalid`);
      const unique = [...new Set(value.map(String))];
      if (allowed && unique.some(item => !allowed.has(item))) fail(`${label} contains an unsupported value`);
      return unique;
    };
    const daemonTypes = list(input.daemonTypes || ['docker', 'podman'], new Set(['docker', 'podman']), 'daemonTypes', 2);
    const architectures = list(input.architectures || ['amd64'], null, 'architectures', 8);
    if (architectures.some(item => !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(item))) fail('architectures contains an invalid value');
    const environments = list(input.environments || [...ENVIRONMENTS], ENVIRONMENTS, 'environments', 3);
    const minimumComposeVersion = text(input.minimumComposeVersion || '2.34.0', 'minimumComposeVersion', 30);
    if (!VERSION.test(minimumComposeVersion)) fail('minimumComposeVersion is invalid');
    return { daemonTypes, architectures, environments, minimumComposeVersion, requiresCosign: bool(input.requiresCosign, true) };
  }

  _operationalProfile(input = {}) {
    exact(input, 'operationalProfile', ['healthcheck', 'backupRestore', 'resources']);
    const healthcheck = input.healthcheck || {};
    exact(healthcheck, 'operationalProfile.healthcheck', ['required', 'services', 'timeoutSeconds']);
    if (!Array.isArray(healthcheck.services || []) || (healthcheck.services || []).length > 50) fail('healthcheck.services is invalid');
    const services = [...new Set((healthcheck.services || []).map(value => text(value, 'healthcheck service', 100)))];
    if (services.some(value => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value))) fail('healthcheck.services contains an invalid service name');
    const timeoutSeconds = Number(healthcheck.timeoutSeconds ?? 120);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) fail('healthcheck.timeoutSeconds is invalid');

    const backupRestore = input.backupRestore || {};
    exact(backupRestore, 'operationalProfile.backupRestore', ['mode', 'volumeHints', 'runbookUrl']);
    const mode = String(backupRestore.mode || 'stateless');
    if (!['stateless', 'snapshot', 'application_consistent', 'external'].includes(mode)) fail('backupRestore.mode is invalid');
    if (!Array.isArray(backupRestore.volumeHints || []) || (backupRestore.volumeHints || []).length > 50) fail('backupRestore.volumeHints is invalid');
    const volumeHints = [...new Set((backupRestore.volumeHints || []).map(value => text(value, 'volume hint', 120)))];
    let runbookUrl = backupRestore.runbookUrl ? text(backupRestore.runbookUrl, 'runbookUrl', 500) : null;
    if (runbookUrl) {
      try { if (new URL(runbookUrl).protocol !== 'https:') fail('runbookUrl must use HTTPS'); }
      catch (error) { if (error instanceof ComposeBlueprintError) throw error; fail('runbookUrl must be a valid HTTPS URL'); }
    }

    const resources = input.resources || {};
    exact(resources, 'operationalProfile.resources', ['cpuMillicores', 'memoryMiB', 'storageGiB']);
    const bounded = (value, label, max) => {
      const number = Number(value || 0);
      if (!Number.isSafeInteger(number) || number < 0 || number > max) fail(`${label} is invalid`);
      return number;
    };
    return {
      healthcheck: { required: bool(healthcheck.required), services, timeoutSeconds },
      backupRestore: { mode, volumeHints, runbookUrl },
      resources: {
        cpuMillicores: bounded(resources.cpuMillicores, 'cpuMillicores', 1000000),
        memoryMiB: bounded(resources.memoryMiB, 'memoryMiB', 1048576),
        storageGiB: bounded(resources.storageGiB, 'storageGiB', 1048576),
      },
    };
  }

  _template(template, schema) {
    const source = String(template || '');
    if (Buffer.byteLength(source) > 512 * 1024) fail('overrideTemplate exceeds 512 KiB', 413, 'TEMPLATE_TOO_LARGE');
    if (!source) return { source: '', parsed: null, referenced: [] };
    let parsedYaml;
    try { parsedYaml = YAML.parse(source); } catch (error) { fail(`Override template YAML is invalid: ${error.message}`); }
    const referenced = new Set();
    const walk = value => {
      if (typeof value === 'string') {
        const match = value.match(TOKEN);
        if (match) { referenced.add(match[1]); return; }
        if (TOKEN_ANY.test(value)) fail('Parameter placeholders must occupy the complete YAML scalar');
        return;
      }
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(parsedYaml);
    const keys = new Set(schema.parameters.map(item => item.key));
    for (const key of referenced) if (!keys.has(key)) fail(`Override template references unknown parameter ${key}`);
    for (const key of keys) if (!referenced.has(key)) fail(`Parameter ${key} is not used by the override template`);
    return { source, parsed: parsedYaml, referenced: [...referenced].sort() };
  }

  _normalize(schema, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('parameters must be an object');
    const known = new Set(schema.parameters.map(item => item.key));
    const unknown = Object.keys(input).filter(key => !known.has(key));
    if (unknown.length) fail(`Unknown parameters: ${unknown.join(', ')}`, 422, 'PARAMETER_VALIDATION_FAILED');
    const normalized = {};
    const errors = [];
    for (const parameter of schema.parameters) {
      let value = Object.hasOwn(input, parameter.key) ? input[parameter.key] : parameter.default;
      if (value === undefined || value === null || value === '') {
        if (parameter.required) errors.push({ field: parameter.key, code: 'REQUIRED' });
        continue;
      }
      if (parameter.type === 'string') {
        value = String(value).trim();
        if (value.length < Number(parameter.minLength || 0) || value.length > Number(parameter.maxLength || 500)) errors.push({ field: parameter.key, code: 'LENGTH' });
        if (parameter.pattern && !new RegExp(parameter.pattern).test(value)) errors.push({ field: parameter.key, code: 'PATTERN' });
      } else if (parameter.type === 'integer') {
        value = Number(value);
        if (!Number.isSafeInteger(value) || value < Number(parameter.minimum ?? Number.MIN_SAFE_INTEGER)
          || value > Number(parameter.maximum ?? Number.MAX_SAFE_INTEGER)) errors.push({ field: parameter.key, code: 'RANGE' });
      } else if (parameter.type === 'boolean') {
        if (value !== true && value !== false) errors.push({ field: parameter.key, code: 'TYPE' });
      } else if (parameter.type === 'enum') {
        if (!parameter.options.includes(value)) errors.push({ field: parameter.key, code: 'OPTION' });
      } else if (parameter.type === 'secret_ref') {
        value = String(value).trim();
        if (!secretInternals.normalizedReference(value)) errors.push({ field: parameter.key, code: 'SECRET_REFERENCE_REQUIRED' });
      }
      normalized[parameter.key] = value;
    }
    if (errors.length) fail('Blueprint parameter validation failed', 422, 'PARAMETER_VALIDATION_FAILED', errors);
    return normalized;
  }

  _renderNormalized(template, normalized) {
    if (!template.parsed) {
      return { normalized, overrideYaml: '', overrideHash: hash(''), admission: null };
    }
    const replace = value => {
      if (typeof value === 'string') {
        const match = value.match(TOKEN);
        return match ? normalized[match[1]] : value;
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
      return value;
    };
    const renderedObject = replace(template.parsed);
    const admission = assertSecretReferenceAdmission({ documentKind: 'template', document: renderedObject });
    const overrideYaml = this.ociCompose._internals._validateOverride(YAML.stringify(renderedObject)) || '';
    return { normalized, overrideYaml, overrideHash: hash(overrideYaml), admission };
  }

  _render(schema, template, values) {
    return this._renderNormalized(template, this._normalize(schema, values));
  }

  _dummyValues(schema) {
    return Object.fromEntries(schema.parameters.map(parameter => {
      if (Object.hasOwn(parameter, 'default')) return [parameter.key, parameter.default];
      if (parameter.type === 'integer') return [parameter.key, parameter.minimum ?? 1];
      if (parameter.type === 'boolean') return [parameter.key, false];
      if (parameter.type === 'enum') return [parameter.key, parameter.options[0]];
      if (parameter.type === 'secret_ref') return [parameter.key, '${DD_BLUEPRINT_SECRET}'];
      return [parameter.key, 'sample'];
    }));
  }

  async createVersion(blueprintId, input, actor) {
    this._admin(actor);
    exact(input, 'version', ['version', 'registryId', 'repository', 'sourceRef', 'signaturePolicy', 'signerPattern',
      'parameterSchema', 'overrideTemplate', 'compatibility', 'operationalProfile', 'changelog']);
    const blueprint = this._blueprint(blueprintId);
    if (blueprint.lifecycle === 'retired') fail('Retired blueprints are immutable', 409, 'BLUEPRINT_RETIRED');
    const version = text(input.version, 'version', 80);
    if (!VERSION.test(version)) fail('version must be semantic');
    const repository = this.ociCompose._internals._validateRepository(input.repository);
    const sourceRef = this.ociCompose._internals._validateReference(input.sourceRef || 'latest');
    const registryId = Number(input.registryId);
    const registry = this.registry.get(registryId);
    if (!registry) fail('Registry not found', 404, 'REGISTRY_NOT_FOUND');
    const signaturePolicy = String(input.signaturePolicy || 'none');
    if (!['none', 'annotation', 'cosign'].includes(signaturePolicy)) fail('signaturePolicy is invalid');
    const signerPattern = input.signerPattern ? text(input.signerPattern, 'signerPattern', 256) : null;
    if (signaturePolicy === 'cosign' && !signerPattern) fail('Cosign versions require an explicit signer identity regexp');
    if (signerPattern) {
      try { new RegExp(signerPattern); } catch { fail('signerPattern is invalid'); }
    }
    const parameterSchema = this._schema(input.parameterSchema || { parameters: [] });
    const template = this._template(input.overrideTemplate || '', parameterSchema);
    this._renderNormalized(template, this._dummyValues(parameterSchema));
    const compatibility = this._compatibility(input.compatibility || {});
    const operationalProfile = this._operationalProfile(input.operationalProfile || {});
    let manifest;
    try { manifest = await this.registry.manifest(registryId, repository, sourceRef); }
    catch (error) { fail(`Registry manifest lookup failed: ${error.message}`, 502, 'REGISTRY_LOOKUP_FAILED'); }
    const digest = String(manifest.digest || (sourceRef.startsWith('sha256:') ? sourceRef : '')).toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail('Registry did not return a pinned sha256 digest', 409, 'DIGEST_REQUIRED');
    if (!manifest.manifest || Number(manifest.manifest.schemaVersion) !== 2) fail('Reference is not a supported OCI manifest', 409, 'INVALID_OCI_MANIFEST');
    const provenance = this.provenanceParser.parse(manifest);
    let trust;
    try {
      trust = this.ociCompose.verifyTrust({ registryId, repository, digest, policy: signaturePolicy, signerPattern, provenance });
    } catch (error) {
      fail(error.message, Number.isInteger(error.status) ? error.status : 409, error.code || 'TRUST_VERIFICATION_FAILED');
    }
    const evidence = { ...provenance, trust };
    const versionHash = hash({ blueprintId: blueprint.id, version, registryId, repository, digest,
      signaturePolicy, signerPattern, parameterSchema, overrideTemplate: template.source, compatibility, operationalProfile });
    try {
      const result = this._db().prepare(`INSERT INTO compose_blueprint_versions
        (blueprint_id,version,registry_id,repository,source_ref,digest,signature_policy,signer_pattern,
         provenance_json,parameter_schema_json,override_template_yaml,compatibility_json,operational_profile_json,
         changelog,version_hash,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(blueprint.id, version, registryId, repository, sourceRef, digest,
        signaturePolicy, signerPattern, JSON.stringify(evidence), JSON.stringify(parameterSchema), template.source,
        JSON.stringify(compatibility), JSON.stringify(operationalProfile),
        text(input.changelog || '', 'changelog', 4000, false), versionHash, actor.id);
      return { blueprint: blueprintRow(blueprint), version: versionRow(this._db().prepare('SELECT * FROM compose_blueprint_versions WHERE id=?').get(result.lastInsertRowid)) };
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('Blueprint version already exists', 409, 'BLUEPRINT_VERSION_EXISTS');
      throw error;
    }
  }

  transitionVersion(blueprintId, versionId, state, actor) {
    this._admin(actor);
    const blueprint = this._blueprint(blueprintId);
    const row = this._version(versionId);
    if (row.blueprint_id !== blueprint.id) fail('Version does not belong to blueprint', 404, 'BLUEPRINT_VERSION_NOT_FOUND');
    const target = String(state || '');
    if (!VERSION_STATES[row.state]?.has(target)) fail('Version lifecycle transition is invalid', 409, 'INVALID_VERSION_TRANSITION');
    if (target === 'published') {
      const trust = parse(row.provenance_json, {}).trust || {};
      if (row.signature_policy !== 'cosign' || !row.signer_pattern || trust.cryptographicallyVerified !== true || trust.passed !== true) {
        fail('Publishing requires digest-pinned Cosign verification and an explicit signer identity policy', 409, 'VERIFIED_SIGNATURE_REQUIRED');
      }
      try {
        this.ociCompose.verifyTrust({ registryId: row.registry_id, repository: row.repository, digest: row.digest,
          policy: row.signature_policy, signerPattern: row.signer_pattern, provenance: parse(row.provenance_json, {}) });
      } catch (error) {
        fail(`Publish-time trust verification failed: ${error.message}`,
          Number.isInteger(error.status) ? error.status : 409, error.code || 'TRUST_VERIFICATION_FAILED');
      }
    }
    this._db().transaction(() => {
      if (target === 'published') {
        this._db().prepare("UPDATE compose_blueprint_versions SET state='deprecated' WHERE blueprint_id=? AND state='published'").run(blueprint.id);
        this._db().prepare("UPDATE compose_blueprint_versions SET state='published',published_at=datetime('now') WHERE id=?").run(row.id);
        this._db().prepare("UPDATE compose_blueprints SET current_version_id=?,lifecycle='active',updated_by=?,updated_at=datetime('now') WHERE id=?")
          .run(row.id, actor.id, blueprint.id);
      } else {
        this._db().prepare('UPDATE compose_blueprint_versions SET state=? WHERE id=?').run(target, row.id);
        if (blueprint.current_version_id === row.id) {
          this._db().prepare("UPDATE compose_blueprints SET lifecycle='deprecated',updated_by=?,updated_at=datetime('now') WHERE id=?")
            .run(actor.id, blueprint.id);
        }
      }
    })();
    return this.get(blueprint.id, actor, true);
  }

  diff(blueprintId, versionId, againstVersionId, actor) {
    this._operator(actor);
    const blueprint = this._blueprint(blueprintId);
    const target = this._version(versionId);
    if (target.blueprint_id !== blueprint.id) fail('Version does not belong to blueprint', 404, 'BLUEPRINT_VERSION_NOT_FOUND');
    const baseline = againstVersionId
      ? this._version(againstVersionId)
      : this._db().prepare('SELECT * FROM compose_blueprint_versions WHERE blueprint_id=? AND id<? ORDER BY id DESC LIMIT 1')
        .get(blueprint.id, target.id);
    if (!baseline || baseline.blueprint_id !== blueprint.id || baseline.id === target.id) {
      fail('A different baseline version from this blueprint is required', 404, 'BLUEPRINT_DIFF_BASELINE_NOT_FOUND');
    }
    const from = versionRow(baseline); const to = versionRow(target);
    const parameterMap = version => new Map((version.parameterSchema.parameters || []).map(parameter => [parameter.key, canonical(parameter)]));
    const fromParameters = parameterMap(from); const toParameters = parameterMap(to);
    const parameterKeys = [...new Set([...fromParameters.keys(), ...toParameters.keys()])].sort();
    const parameters = {
      added: parameterKeys.filter(key => !fromParameters.has(key)),
      removed: parameterKeys.filter(key => !toParameters.has(key)),
      changed: parameterKeys.filter(key => fromParameters.has(key) && toParameters.has(key)
        && fromParameters.get(key) !== toParameters.get(key)),
    };
    const fields = {
      digest: from.digest !== to.digest,
      trustPolicy: from.signaturePolicy !== to.signaturePolicy || from.signerPattern !== to.signerPattern,
      overrideTemplate: hash(from.overrideTemplate) !== hash(to.overrideTemplate),
      compatibility: canonical(from.compatibility) !== canonical(to.compatibility),
      operationalProfile: canonical(from.operationalProfile) !== canonical(to.operationalProfile),
      parameters: parameters.added.length + parameters.removed.length + parameters.changed.length > 0,
    };
    return {
      blueprint: { id: blueprint.id, slug: blueprint.slug, name: blueprint.name },
      from: { id: from.id, version: from.version, digest: from.digest, versionHash: from.versionHash },
      to: { id: to.id, version: to.version, digest: to.digest, versionHash: to.versionHash },
      fields,
      parameters,
      changedFields: Object.entries(fields).filter(([, changed]) => changed).map(([field]) => field),
      rollback: { catalogOnly: true, restoreVersionId: from.id, deployedApplicationsChanged: false },
    };
  }

  preview(versionId, input, actor) {
    this._operator(actor);
    exact(input, 'preview', ['hostId', 'instanceName', 'projectName', 'environment', 'parameters']);
    const row = this._version(versionId);
    if (row.state !== 'published' || row.blueprint_lifecycle !== 'active') fail('Blueprint version is not available for new instances', 409, 'BLUEPRINT_NOT_INSTANTIABLE');
    const host = this._host(input.hostId);
    const instanceName = this.ociCompose._internals._validateName(input.instanceName, 'Instance name');
    const projectName = this.ociCompose._internals._validateName(input.projectName || instanceName, 'Project name');
    const environment = String(input.environment || 'development');
    if (!ENVIRONMENTS.has(environment)) fail('environment is invalid');
    const schema = parse(row.parameter_schema_json, { parameters: [] });
    const template = this._template(row.override_template_yaml, schema);
    const rendered = this._render(schema, template, input.parameters || {});
    const compatibility = parse(row.compatibility_json, {});
    if (!(compatibility.daemonTypes || []).includes(host.daemon_type || 'docker')) fail('Host daemon type is not supported by this version', 409, 'HOST_NOT_COMPATIBLE');
    if (!(compatibility.environments || []).includes(environment)) fail('Environment is not supported by this version', 409, 'ENVIRONMENT_NOT_COMPATIBLE');
    const trust = parse(row.provenance_json, {}).trust || {};
    if (compatibility.requiresCosign !== false && trust.cryptographicallyVerified !== true) fail('Blueprint trust evidence no longer satisfies policy', 409, 'VERIFIED_SIGNATURE_REQUIRED');
    const parametersHash = hash(rendered.normalized);
    const planHash = hash({ versionHash: row.version_hash, hostId: host.id, instanceName, projectName,
      environment, parametersHash, renderedOverrideHash: rendered.overrideHash });
    return {
      blueprint: { id: row.blueprint_id, slug: row.blueprint_slug, name: row.blueprint_name },
      version: { id: row.id, version: row.version, versionHash: row.version_hash, digest: row.digest,
        signaturePolicy: row.signature_policy, signerPattern: row.signer_pattern },
      host: { id: host.id, name: host.name, daemonType: host.daemon_type },
      instanceName,
      projectName,
      environment,
      parametersHash,
      renderedOverrideHash: rendered.overrideHash,
      renderedOverride: rendered.overrideYaml,
      secretReferenceAdmission: rendered.admission,
      planHash,
      next: { action: 'instantiate', deploymentRequiresOciPlan: true },
    };
  }

  async instantiate(versionId, input, actor) {
    this._operator(actor);
    exact(input, 'instantiate', ['hostId', 'instanceName', 'projectName', 'environment', 'parameters', 'planHash', 'idempotencyKey']);
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 200);
    const preview = this.preview(versionId, {
      hostId: input.hostId, instanceName: input.instanceName, projectName: input.projectName,
      environment: input.environment, parameters: input.parameters || {},
    }, actor);
    if (!input.planHash || input.planHash !== preview.planHash) fail('Blueprint instantiation plan is stale', 409, 'STALE_BLUEPRINT_PLAN');
    const existing = this._db().prepare('SELECT * FROM compose_blueprint_instantiations WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (existing.plan_hash !== preview.planHash) fail('Idempotency key was already used for a different plan', 409, 'IDEMPOTENCY_CONFLICT');
      if (existing.state === 'succeeded') return { instantiation: instantiationRow(existing), artifact: existing.artifact_id ? this.ociCompose.get(existing.artifact_id) : null, deduplicated: true };
      fail(existing.state === 'creating' ? 'Blueprint instantiation is already in progress' : 'A previous instantiation attempt failed; use a new idempotency key',
        409, existing.state === 'creating' ? 'INSTANTIATION_IN_PROGRESS' : 'PREVIOUS_INSTANTIATION_FAILED');
    }
    let claimId;
    try {
      claimId = Number(this._db().prepare(`INSERT INTO compose_blueprint_instantiations
        (blueprint_version_id,host_id,instance_name,project_name,environment,parameters_hash,
         rendered_override_hash,plan_hash,idempotency_key,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(Number(versionId), preview.host.id, preview.instanceName, preview.projectName,
        preview.environment, preview.parametersHash, preview.renderedOverrideHash, preview.planHash, idempotencyKey, actor.id).lastInsertRowid);
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('Idempotency key was claimed concurrently', 409, 'IDEMPOTENCY_CONFLICT');
      throw error;
    }
    const version = this._version(versionId);
    try {
      const artifact = await this.ociCompose.create({
        name: preview.instanceName,
        project_name: preview.projectName,
        registry_id: version.registry_id,
        repository: version.repository,
        source_ref: version.digest,
        host_id: preview.host.id,
        override_yaml: preview.renderedOverride || null,
        signature_policy: version.signature_policy,
        signer_pattern: version.signer_pattern,
      }, actor.id);
      this._db().prepare(`UPDATE compose_blueprint_instantiations
        SET artifact_id=?,state='succeeded',completed_at=datetime('now') WHERE id=? AND state='creating'`).run(artifact.id, claimId);
      return { instantiation: instantiationRow(this._db().prepare('SELECT * FROM compose_blueprint_instantiations WHERE id=?').get(claimId)),
        artifact, deduplicated: false, next: { planEndpoint: `/api/oci-compose/${artifact.id}/plan`, deployRequiresReviewedPlan: true } };
    } catch (error) {
      this._db().prepare(`UPDATE compose_blueprint_instantiations SET state='failed',error_code=?,error_message=?,
        completed_at=datetime('now') WHERE id=?`).run(String(error.code || 'OCI_ARTIFACT_CREATE_FAILED').slice(0, 100),
        String(error.message || 'OCI artifact creation failed').slice(0, 500), claimId);
      throw error;
    }
  }

  history(blueprintId, actor, limit = 50) {
    this._operator(actor);
    const blueprint = this._blueprint(blueprintId);
    const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
    return {
      blueprint: { id: blueprint.id, slug: blueprint.slug, name: blueprint.name },
      instantiations: this._db().prepare(`SELECT i.* FROM compose_blueprint_instantiations i
        JOIN compose_blueprint_versions v ON v.id=i.blueprint_version_id
        WHERE v.blueprint_id=? ORDER BY i.id DESC LIMIT ?`).all(blueprint.id, bounded).map(instantiationRow),
    };
  }
}

const service = new ComposeBlueprintService();
module.exports = service;
module.exports.ComposeBlueprintService = ComposeBlueprintService;
module.exports.ComposeBlueprintError = ComposeBlueprintError;
module.exports._internals = { canonical, hash, blueprintRow, versionRow, instantiationRow };
