'use strict';

const { getDb } = require('../db');
const hostPermissions = require('./host-permissions');

const RESOURCE_TYPES = new Set(['virtual-machines']);
const POWER_STATES = new Set(['all', 'running', 'stopped', 'paused', 'unknown']);
const COLUMNS = new Set(['name', 'powerState', 'cpu', 'memory', 'ipAddress', 'observedAt']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);
const MAX_VIEWS = 50;

class ProviderInventoryViewError extends Error {
  constructor(message, status = 400, code = 'PROVIDER_INVENTORY_VIEW_ERROR') {
    super(message);
    this.name = 'ProviderInventoryViewError';
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new ProviderInventoryViewError(message, status, code);
}

function exactObject(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) fail(`Unexpected ${field} fields: ${unexpected.join(', ')}`, 400, 'UNEXPECTED_FIELD');
  return value;
}

function text(value, field, max, { allowEmpty = false } = {}) {
  const result = String(value ?? '').trim();
  if ((!allowEmpty && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    fail(`${field} is invalid`, 400, 'INVALID_FIELD');
  }
  return result;
}

function bool(value, field) {
  if (typeof value !== 'boolean') fail(`${field} must be boolean`, 400, 'INVALID_FIELD');
  return value;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

class ProviderInventoryViewsService {
  constructor(dbProvider = getDb, accessResolver = hostPermissions.resolveEffectivePermission) {
    this._dbProvider = dbProvider;
    this._accessResolver = accessResolver;
  }

  _db() { return this._dbProvider(); }

  _actor(actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTHENTICATION_REQUIRED');
    return actor;
  }

  _isAdmin(actor) {
    return actor.role === 'admin' || (Array.isArray(actor.roles) && actor.roles.includes('admin'));
  }

  _resourceType(value) {
    const result = String(value || '');
    if (!RESOURCE_TYPES.has(result)) fail('Unsupported inventory resource type', 400, 'INVALID_RESOURCE_TYPE');
    return result;
  }

  _hostId(value, actor) {
    if (value === null || value === undefined || value === '') return null;
    const hostId = Number(value);
    if (!Number.isSafeInteger(hostId) || hostId <= 0) fail('providerHostId is invalid', 400, 'INVALID_HOST_ID');
    const host = this._db().prepare('SELECT id, daemon_type, is_active FROM docker_hosts WHERE id = ?').get(hostId);
    if (!host || !host.is_active || !['proxmox', 'vsphere', 'xen'].includes(host.daemon_type)) {
      fail('Provider host is unavailable', 404, 'PROVIDER_HOST_UNAVAILABLE');
    }
    if (!this._isAdmin(actor) && !this._accessResolver(actor.id, hostId, false)) {
      fail('Insufficient permissions for this host', 403, 'HOST_ACCESS_DENIED');
    }
    return hostId;
  }

  _filters(value = {}) {
    exactObject(value, 'filters', ['query', 'powerState']);
    const query = text(value.query ?? '', 'filters.query', 120, { allowEmpty: true });
    const powerState = String(value.powerState || 'all');
    if (!POWER_STATES.has(powerState)) fail('filters.powerState is invalid', 400, 'INVALID_FILTER');
    return { query, powerState };
  }

  _columns(value) {
    if (!Array.isArray(value) || !value.length || value.length > COLUMNS.size) {
      fail('columns must contain between 1 and 6 entries', 400, 'INVALID_COLUMNS');
    }
    const columns = value.map(item => String(item));
    if (columns.some(item => !COLUMNS.has(item)) || new Set(columns).size !== columns.length) {
      fail('columns contains an invalid or duplicate entry', 400, 'INVALID_COLUMNS');
    }
    if (!columns.includes('name')) fail('columns must include name', 400, 'INVALID_COLUMNS');
    return columns;
  }

  _sort(value = {}) {
    exactObject(value, 'sort', ['field', 'direction']);
    const field = String(value.field || 'name');
    const direction = String(value.direction || 'asc');
    if (!COLUMNS.has(field) || !SORT_DIRECTIONS.has(direction)) {
      fail('sort is invalid', 400, 'INVALID_SORT');
    }
    return { field, direction };
  }

  _input(body, actor, { update = false } = {}) {
    exactObject(body, 'view', update
      ? ['name', 'resourceType', 'providerHostId', 'filters', 'columns', 'sort', 'isDefault', 'version']
      : ['name', 'resourceType', 'providerHostId', 'filters', 'columns', 'sort', 'isDefault']);
    const result = {
      name: text(body.name, 'name', 80),
      resourceType: this._resourceType(body.resourceType),
      providerHostId: this._hostId(body.providerHostId, actor),
      filters: this._filters(body.filters),
      columns: this._columns(body.columns),
      sort: this._sort(body.sort),
      isDefault: bool(body.isDefault, 'isDefault'),
    };
    if (update) {
      const version = Number(body.version);
      if (!Number.isSafeInteger(version) || version <= 0) fail('version is invalid', 400, 'INVALID_VERSION');
      result.version = version;
    }
    return result;
  }

  _row(row) {
    return {
      id: row.id,
      name: row.name,
      resourceType: row.resource_type,
      providerHostId: row.provider_host_id,
      filters: parseJson(row.filters_json, { query: '', powerState: 'all' }),
      columns: parseJson(row.columns_json, ['name', 'powerState', 'cpu', 'memory', 'ipAddress', 'observedAt']),
      sort: parseJson(row.sort_json, { field: 'name', direction: 'asc' }),
      isDefault: Boolean(row.is_default),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _owned(idValue, actor) {
    this._actor(actor);
    const id = Number(idValue);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Inventory view ID is invalid', 400, 'INVALID_VIEW_ID');
    const row = this._db().prepare('SELECT * FROM provider_inventory_views WHERE id = ? AND user_id = ?').get(id, actor.id);
    if (!row) fail('Inventory view not found', 404, 'VIEW_NOT_FOUND');
    return row;
  }

  list(resourceTypeValue, actor) {
    this._actor(actor);
    const resourceType = this._resourceType(resourceTypeValue);
    return this._db().prepare(`SELECT * FROM provider_inventory_views
      WHERE user_id = ? AND resource_type = ? ORDER BY is_default DESC, name COLLATE NOCASE, id`)
      .all(actor.id, resourceType).map(row => this._row(row));
  }

  create(body, actor) {
    this._actor(actor);
    const input = this._input(body, actor);
    const db = this._db();
    const count = db.prepare('SELECT COUNT(*) AS count FROM provider_inventory_views WHERE user_id = ?').get(actor.id).count;
    if (count >= MAX_VIEWS) fail(`A user may save at most ${MAX_VIEWS} inventory views`, 409, 'VIEW_LIMIT_REACHED');
    try {
      const id = db.transaction(() => {
        if (input.isDefault) db.prepare('UPDATE provider_inventory_views SET is_default = 0, updated_at = datetime(\'now\') WHERE user_id = ? AND resource_type = ? AND is_default = 1').run(actor.id, input.resourceType);
        return Number(db.prepare(`INSERT INTO provider_inventory_views
          (user_id,name,resource_type,provider_host_id,filters_json,columns_json,sort_json,is_default)
          VALUES (?,?,?,?,?,?,?,?)`).run(actor.id, input.name, input.resourceType, input.providerHostId,
          JSON.stringify(input.filters), JSON.stringify(input.columns), JSON.stringify(input.sort), input.isDefault ? 1 : 0).lastInsertRowid);
      })();
      return this._row(db.prepare('SELECT * FROM provider_inventory_views WHERE id = ?').get(id));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') fail('An inventory view with this name already exists', 409, 'VIEW_NAME_CONFLICT');
      throw error;
    }
  }

  update(idValue, body, actor) {
    const current = this._owned(idValue, actor);
    const input = this._input(body, actor, { update: true });
    if (current.resource_type !== input.resourceType) fail('resourceType cannot be changed', 409, 'RESOURCE_TYPE_IMMUTABLE');
    if (current.version !== input.version) fail('Inventory view changed since it was loaded', 409, 'STALE_VIEW');
    const db = this._db();
    try {
      db.transaction(() => {
        if (input.isDefault) db.prepare('UPDATE provider_inventory_views SET is_default = 0, updated_at = datetime(\'now\') WHERE user_id = ? AND resource_type = ? AND id <> ? AND is_default = 1').run(actor.id, input.resourceType, current.id);
        const result = db.prepare(`UPDATE provider_inventory_views SET name=?,provider_host_id=?,filters_json=?,columns_json=?,sort_json=?,is_default=?,version=version+1,updated_at=datetime('now')
          WHERE id=? AND user_id=? AND version=?`).run(input.name, input.providerHostId, JSON.stringify(input.filters), JSON.stringify(input.columns),
          JSON.stringify(input.sort), input.isDefault ? 1 : 0, current.id, actor.id, input.version);
        if (result.changes !== 1) fail('Inventory view changed since it was loaded', 409, 'STALE_VIEW');
      })();
      return this._row(db.prepare('SELECT * FROM provider_inventory_views WHERE id = ?').get(current.id));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') fail('An inventory view with this name already exists', 409, 'VIEW_NAME_CONFLICT');
      throw error;
    }
  }

  remove(idValue, actor) {
    const current = this._owned(idValue, actor);
    this._db().prepare('DELETE FROM provider_inventory_views WHERE id = ? AND user_id = ?').run(current.id, actor.id);
    return this._row(current);
  }
}

const service = new ProviderInventoryViewsService();
module.exports = service;
module.exports.ProviderInventoryViewsService = ProviderInventoryViewsService;
module.exports.ProviderInventoryViewError = ProviderInventoryViewError;
module.exports._constants = { RESOURCE_TYPES, POWER_STATES, COLUMNS, MAX_VIEWS };
