'use strict';

// v8.9.7-alpha.1 — Portainer G03 + Komodo G02 closure: host groups.

const { getDb } = require('../db');

function list() {
  const db = getDb();
  const groups = db.prepare(`
    SELECT g.*, COUNT(m.host_id) AS member_count
    FROM host_groups g
    LEFT JOIN host_group_members m ON m.group_id = g.id
    GROUP BY g.id
    ORDER BY g.sort_order, g.name
  `).all();
  // Fetch members per group in a second query — small tables, N+1 is fine here.
  for (const g of groups) {
    g.member_host_ids = db.prepare('SELECT host_id FROM host_group_members WHERE group_id = ?')
      .all(g.id).map(r => r.host_id);
  }
  return groups;
}

function get(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM host_groups WHERE id = ?').get(id);
  if (!row) return null;
  row.member_host_ids = db.prepare('SELECT host_id FROM host_group_members WHERE group_id = ?')
    .all(id).map(r => r.host_id);
  return row;
}

function create({ name, description, color, icon, sortOrder, hostIds }, userId) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Host group name is required');
  }
  const db = getDb();
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO host_groups (name, description, color, icon, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), description || null, color || '#6366f1', icon || 'fa-server',
      sortOrder || 0, userId || null);
    const id = result.lastInsertRowid;
    if (Array.isArray(hostIds) && hostIds.length) {
      const ins = db.prepare('INSERT OR IGNORE INTO host_group_members (group_id, host_id) VALUES (?, ?)');
      for (const hid of hostIds) ins.run(id, hid);
    }
    return id;
  });
  return tx();
}

function update(id, { name, description, color, icon, sortOrder, hostIds }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM host_groups WHERE id = ?').get(id);
  if (!existing) throw new Error('Host group not found');
  const tx = db.transaction(() => {
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).trim()); }
    if (description !== undefined) { fields.push('description = ?'); vals.push(description || null); }
    if (color !== undefined) { fields.push('color = ?'); vals.push(color); }
    if (icon !== undefined) { fields.push('icon = ?'); vals.push(icon); }
    if (sortOrder !== undefined) { fields.push('sort_order = ?'); vals.push(sortOrder); }
    if (fields.length) {
      fields.push(`updated_at = datetime('now')`);
      vals.push(id);
      db.prepare(`UPDATE host_groups SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }
    if (Array.isArray(hostIds)) {
      db.prepare('DELETE FROM host_group_members WHERE group_id = ?').run(id);
      const ins = db.prepare('INSERT OR IGNORE INTO host_group_members (group_id, host_id) VALUES (?, ?)');
      for (const hid of hostIds) ins.run(id, hid);
    }
  });
  tx();
}

function remove(id) {
  const db = getDb();
  db.prepare('DELETE FROM host_groups WHERE id = ?').run(id);
}

/** Return group ids that a host belongs to. Used by the hosts.js route to
 *  enrich the hosts list with group badges. */
function groupsForHost(hostId) {
  const db = getDb();
  return db.prepare(`
    SELECT g.id, g.name, g.color, g.icon
    FROM host_groups g
    JOIN host_group_members m ON m.group_id = g.id
    WHERE m.host_id = ?
    ORDER BY g.sort_order, g.name
  `).all(hostId);
}

module.exports = { list, get, create, update, remove, groupsForHost };
