'use strict';

const { getDb } = require('../db');
const { now } = require('../utils/helpers');

const groups = {
  list(userId) {
    const db = getDb();
    const rows = db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM container_group_members WHERE group_id = g.id) as member_count
      FROM container_groups g
      WHERE g.scope = 'global' OR (g.scope = 'user' AND g.user_id = ?)
      ORDER BY g.sort_order, g.name
    `).all(userId);
    return rows;
  },

  get(id, userId) {
    const db = getDb();
    const group = db.prepare(`
      SELECT g.* FROM container_groups g
      WHERE g.id = ? AND (g.scope = 'global' OR (g.scope = 'user' AND g.user_id = ?))
    `).get(id, userId);
    if (!group) return null;

    group.members = db.prepare(
      'SELECT container_id FROM container_group_members WHERE group_id = ? ORDER BY added_at'
    ).all(id).map(r => r.container_id);

    return group;
  },

  create({ name, color, icon, scope, userId, createdBy }) {
    const db = getDb();
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM container_groups').get();
    const sortOrder = (maxOrder?.m || 0) + 1;

    const result = db.prepare(`
      INSERT INTO container_groups (name, color, icon, sort_order, scope, user_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, color || '#388bfd', icon || 'fas fa-folder', sortOrder, scope || 'global', scope === 'user' ? userId : null, createdBy);

    return { id: result.lastInsertRowid };
  },

  update(id, { name, color, icon }, userId) {
    const db = getDb();
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (color !== undefined) { updates.push('color = ?'); params.push(color); }
    if (icon !== undefined) { updates.push('icon = ?'); params.push(icon); }
    updates.push("updated_at = datetime('now')");

    params.push(id, userId);
    db.prepare(`
      UPDATE container_groups SET ${updates.join(', ')}
      WHERE id = ? AND (scope = 'global' OR (scope = 'user' AND user_id = ?))
    `).run(...params);
  },

  delete(id, userId) {
    const db = getDb();
    db.prepare(`
      DELETE FROM container_groups
      WHERE id = ? AND (scope = 'global' OR (scope = 'user' AND user_id = ?))
    `).run(id, userId);
  },

  addContainers(groupId, containerIds) {
    const db = getDb();
    const stmt = db.prepare('INSERT OR IGNORE INTO container_group_members (group_id, container_id) VALUES (?, ?)');
    const insert = db.transaction((ids) => {
      for (const cid of ids) stmt.run(groupId, cid);
    });
    insert(containerIds);
  },

  removeContainer(groupId, containerId) {
    getDb().prepare('DELETE FROM container_group_members WHERE group_id = ? AND container_id = ?')
      .run(groupId, containerId);
  },

  reorder(order) {
    const db = getDb();
    const stmt = db.prepare('UPDATE container_groups SET sort_order = ? WHERE id = ?');
    const update = db.transaction((ids) => {
      ids.forEach((id, idx) => stmt.run(idx, id));
    });
    update(order);
  },
};

module.exports = groups;
