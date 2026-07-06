'use strict';

// v8.9.10-alpha.1 — Portainer G01 closure: teams service.

const { getDb } = require('../db');

function list() {
  const db = getDb();
  const teams = db.prepare(`
    SELECT t.*, COUNT(m.user_id) AS member_count
    FROM teams t
    LEFT JOIN team_members m ON m.team_id = t.id
    GROUP BY t.id
    ORDER BY t.name
  `).all();
  for (const t of teams) {
    t.members = db.prepare(`
      SELECT u.id, u.username, u.email, tm.is_leader, tm.added_at
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
      ORDER BY u.username
    `).all(t.id);
  }
  return teams;
}

function get(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!row) return null;
  row.members = db.prepare(`
    SELECT u.id, u.username, u.email, tm.is_leader, tm.added_at
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY u.username
  `).all(id);
  return row;
}

function create({ name, description, memberIds }, userId) {
  if (!name || !String(name).trim()) throw new Error('Team name is required');
  const db = getDb();
  const tx = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO teams (name, description, created_by) VALUES (?, ?, ?)'
    ).run(String(name).trim(), description || null, userId || null);
    const id = result.lastInsertRowid;
    if (Array.isArray(memberIds) && memberIds.length) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO team_members (team_id, user_id, added_by) VALUES (?, ?, ?)'
      );
      for (const uid of memberIds) ins.run(id, uid, userId || null);
    }
    return id;
  });
  return tx();
}

function update(id, { name, description, memberIds }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(id);
  if (!existing) throw new Error('Team not found');
  const tx = db.transaction(() => {
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name = ?'); vals.push(String(name).trim()); }
    if (description !== undefined) { fields.push('description = ?'); vals.push(description || null); }
    if (fields.length) {
      fields.push(`updated_at = datetime('now')`);
      vals.push(id);
      db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    }
    if (Array.isArray(memberIds)) {
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
      const ins = db.prepare(
        'INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)'
      );
      for (const uid of memberIds) ins.run(id, uid);
    }
  });
  tx();
}

function remove(id) {
  getDb().prepare('DELETE FROM teams WHERE id = ?').run(id);
}

function addMember(teamId, userId, addedBy) {
  getDb().prepare(
    'INSERT OR IGNORE INTO team_members (team_id, user_id, added_by) VALUES (?, ?, ?)'
  ).run(teamId, userId, addedBy || null);
}

function removeMember(teamId, userId) {
  getDb().prepare(
    'DELETE FROM team_members WHERE team_id = ? AND user_id = ?'
  ).run(teamId, userId);
}

/** Return team ids that a user belongs to. */
function teamsForUser(userId) {
  return getDb().prepare(
    'SELECT team_id FROM team_members WHERE user_id = ?'
  ).all(userId).map(r => r.team_id);
}

module.exports = { list, get, create, update, remove, addMember, removeMember, teamsForUser };
