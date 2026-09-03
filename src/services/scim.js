'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('../db');

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';

class ScimError extends Error {
  constructor(message, status = 400, scimType = 'invalidValue') {
    super(message); this.name = 'ScimError'; this.status = status; this.scimType = scimType;
  }
}
function fail(message, status, type) { throw new ScimError(message, status, type); }
function clean(value, field, max = 240) {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!result) fail(`${field} is required`);
  if (result.length > max) fail(`${field} is too long`);
  return result;
}
// SCIM credentials may provision operators but never mint global admins.
function role(value) { return ['operator', 'viewer'].includes(value) ? value : 'viewer'; }

class ScimService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _mapping(type, localId) {
    return this._db().prepare('SELECT * FROM governance_scim_resources WHERE resource_type=? AND local_id=?').get(type, localId);
  }
  _touch(type, localId, externalId, realm = 'scim') {
    this._db().prepare(`INSERT INTO governance_scim_resources (resource_type,local_id,external_id,realm_slug)
      VALUES (?,?,?,?) ON CONFLICT(resource_type,local_id) DO UPDATE SET external_id=excluded.external_id,
      realm_slug=excluded.realm_slug,version=version+1,last_synced_at=datetime('now')`).run(type, localId, externalId || null, realm);
  }
  _user(item) {
    const mapping = this._mapping('User', item.id);
    return { schemas: [USER_SCHEMA], id: String(item.id), externalId: mapping?.external_id || undefined,
      userName: item.username, displayName: item.display_name || item.username, active: Boolean(item.is_active),
      emails: item.email ? [{ value: item.email, primary: true }] : [], roles: [{ value: item.role }],
      meta: { resourceType: 'User', created: item.created_at, lastModified: item.updated_at,
        version: `W/\"${mapping?.version || 1}\"`, location: `/api/scim/v2/Users/${item.id}` } };
  }
  _group(item) {
    const mapping = this._mapping('Group', item.id);
    const members = this._db().prepare(`SELECT u.id,u.username FROM team_members tm JOIN users u ON u.id=tm.user_id
      WHERE tm.team_id=? ORDER BY u.username`).all(item.id);
    return { schemas: [GROUP_SCHEMA], id: String(item.id), externalId: mapping?.external_id || undefined,
      displayName: item.name, members: members.map(member => ({ value: String(member.id), display: member.username })),
      meta: { resourceType: 'Group', created: item.created_at, lastModified: item.updated_at,
        version: `W/\"${mapping?.version || 1}\"`, location: `/api/scim/v2/Groups/${item.id}` } };
  }
  _page(items, startIndex = 1, count = 100) {
    const start = Math.max(1, Number(startIndex) || 1);
    const size = Math.min(200, Math.max(0, Number(count) || 100));
    return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: items.length,
      startIndex: start, itemsPerPage: Math.min(size, Math.max(0, items.length - start + 1)), Resources: items.slice(start - 1, start - 1 + size) };
  }
  _filter(filter) {
    if (!filter) return null;
    const match = String(filter).match(/^\s*(userName|externalId|displayName)\s+eq\s+"([^"]{1,240})"\s*$/i);
    if (!match) fail('Only userName, displayName, or externalId eq filters are supported', 400, 'invalidFilter');
    return { field: match[1].toLowerCase(), value: match[2].toLowerCase() };
  }
  listUsers(query = {}) {
    let users = this._db().prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(item => this._user(item));
    const filter = this._filter(query.filter);
    if (filter) users = users.filter(item => String(filter.field === 'username' ? item.userName
      : filter.field === 'externalid' ? item.externalId : item.displayName || '').toLowerCase() === filter.value);
    return this._page(users, query.startIndex, query.count);
  }
  getUser(id) {
    const item = this._db().prepare('SELECT * FROM users WHERE id=?').get(Number(id));
    if (!item) fail('User not found', 404, 'notFound');
    return this._user(item);
  }
  createUser(input) {
    const username = clean(input.userName, 'userName', 120);
    const email = input.emails?.find(item => item.primary)?.value || input.emails?.[0]?.value || null;
    const password = bcrypt.hashSync(crypto.randomBytes(48).toString('hex'), 12);
    const db = this._db();
    try {
      const id = db.prepare(`INSERT INTO users (username,display_name,email,password_hash,role,is_active,auth_source,must_change_password)
        VALUES (?,?,?,?,?,?, 'scim',0)`).run(username, input.displayName || username, email, password,
        role(input.roles?.[0]?.value), input.active === false ? 0 : 1).lastInsertRowid;
      this._touch('User', id, input.externalId);
      return this.getUser(id);
    } catch (error) {
      if (/UNIQUE/.test(error.message)) fail('userName, email, or externalId already exists', 409, 'uniqueness');
      throw error;
    }
  }
  replaceUser(id, input) {
    this.getUser(id);
    const username = clean(input.userName, 'userName', 120);
    const email = input.emails?.find(item => item.primary)?.value || input.emails?.[0]?.value || null;
    try {
      this._db().prepare(`UPDATE users SET username=?,display_name=?,email=?,role=?,is_active=?,auth_source='scim',updated_at=datetime('now') WHERE id=?`)
        .run(username, input.displayName || username, email, role(input.roles?.[0]?.value), input.active === false ? 0 : 1, Number(id));
      this._touch('User', Number(id), input.externalId);
      if (input.active === false) this._db().prepare('UPDATE sessions SET is_valid=0 WHERE user_id=?').run(Number(id));
      return this.getUser(id);
    } catch (error) {
      if (/UNIQUE/.test(error.message)) fail('userName, email, or externalId already exists', 409, 'uniqueness');
      throw error;
    }
  }
  patchUser(id, input) {
    const current = this.getUser(id);
    const next = { userName: current.userName, displayName: current.displayName, active: current.active,
      externalId: current.externalId, emails: current.emails, roles: current.roles };
    for (const operation of input.Operations || []) {
      const op = String(operation.op || '').toLowerCase();
      const path = String(operation.path || '');
      if (!['add', 'replace', 'remove'].includes(op)) fail('Unsupported PATCH operation');
      if (!path && operation.value && typeof operation.value === 'object') Object.assign(next, operation.value);
      else if (/^active$/i.test(path)) next.active = op === 'remove' ? false : Boolean(operation.value);
      else if (/^displayName$/i.test(path)) next.displayName = op === 'remove' ? next.userName : operation.value;
      else if (/^userName$/i.test(path)) next.userName = operation.value;
      else if (/^externalId$/i.test(path)) next.externalId = op === 'remove' ? null : operation.value;
      else if (/^roles$/i.test(path)) next.roles = op === 'remove' ? [{ value: 'viewer' }] : operation.value;
      else fail(`Unsupported User PATCH path: ${path}`);
    }
    return this.replaceUser(id, next);
  }
  deleteUser(id) {
    this.getUser(id);
    this._db().transaction(() => {
      this._db().prepare("UPDATE users SET is_active=0,auth_source='scim',updated_at=datetime('now') WHERE id=?").run(Number(id));
      this._db().prepare('UPDATE sessions SET is_valid=0 WHERE user_id=?').run(Number(id));
      this._touch('User', Number(id), this._mapping('User', Number(id))?.external_id);
    })();
    return { deleted: true };
  }
  listGroups(query = {}) {
    let groups = this._db().prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE').all().map(item => this._group(item));
    const filter = this._filter(query.filter);
    if (filter) groups = groups.filter(item => String(filter.field === 'displayname' ? item.displayName
      : filter.field === 'externalid' ? item.externalId : '').toLowerCase() === filter.value);
    return this._page(groups, query.startIndex, query.count);
  }
  getGroup(id) {
    const item = this._db().prepare('SELECT * FROM teams WHERE id=?').get(Number(id));
    if (!item) fail('Group not found', 404, 'notFound');
    return this._group(item);
  }
  _setMembers(groupId, members) {
    const db = this._db();
    db.prepare('DELETE FROM team_members WHERE team_id=?').run(groupId);
    const insert = db.prepare('INSERT OR IGNORE INTO team_members (team_id,user_id) VALUES (?,?)');
    for (const member of members || []) {
      const userId = Number(member.value);
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) fail(`User ${member.value} not found`, 400, 'invalidValue');
      insert.run(groupId, userId);
    }
  }
  createGroup(input) {
    const db = this._db();
    try {
      const id = db.transaction(() => {
        const localId = Number(db.prepare('INSERT INTO teams (name,description) VALUES (?,?)')
          .run(clean(input.displayName, 'displayName', 120), 'Provisioned by SCIM').lastInsertRowid);
        this._setMembers(localId, input.members);
        this._touch('Group', localId, input.externalId);
        return localId;
      })();
      return this.getGroup(id);
    } catch (error) {
      if (/UNIQUE/.test(error.message)) fail('displayName or externalId already exists', 409, 'uniqueness');
      throw error;
    }
  }
  replaceGroup(id, input) {
    this.getGroup(id);
    const db = this._db();
    db.transaction(() => {
      db.prepare("UPDATE teams SET name=?,description='Provisioned by SCIM',updated_at=datetime('now') WHERE id=?")
        .run(clean(input.displayName, 'displayName', 120), Number(id));
      this._setMembers(Number(id), input.members);
      this._touch('Group', Number(id), input.externalId);
    })();
    return this.getGroup(id);
  }
  patchGroup(id, input) {
    const current = this.getGroup(id);
    let displayName = current.displayName;
    let members = [...current.members];
    for (const operation of input.Operations || []) {
      const op = String(operation.op || '').toLowerCase();
      const path = String(operation.path || '');
      if (/^displayName$/i.test(path)) displayName = operation.value;
      else if (/^members$/i.test(path)) {
        if (op === 'remove') members = [];
        else if (op === 'replace') members = operation.value || [];
        else members.push(...(operation.value || []));
      } else if (/^members\[value eq "(\d+)"\]$/i.test(path) && op === 'remove') {
        const userId = path.match(/"(\d+)"/)[1]; members = members.filter(item => item.value !== userId);
      } else fail(`Unsupported Group PATCH path: ${path}`);
    }
    return this.replaceGroup(id, { displayName, members, externalId: current.externalId });
  }
  deleteGroup(id) {
    this.getGroup(id);
    if (!this._mapping('Group', Number(id))) fail('Only SCIM-managed groups can be deleted', 409, 'mutability');
    this._db().prepare('DELETE FROM teams WHERE id=?').run(Number(id));
    return { deleted: true };
  }
}

const service = new ScimService();
module.exports = service;
module.exports.ScimService = ScimService;
module.exports.ScimError = ScimError;
module.exports.USER_SCHEMA = USER_SCHEMA;
module.exports.GROUP_SCHEMA = GROUP_SCHEMA;
