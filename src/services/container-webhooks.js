'use strict';

// v8.9.8-alpha.1 — Portainer G06 closure: container webhook triggers.

const crypto = require('crypto');
const { getDb } = require('../db');
const dockerService = require('./docker');
const log = require('../utils/logger')('container-webhooks');

/** Generate a URL-safe 32-byte random token. */
function _newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function getByContainer(hostId, containerId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM container_webhooks WHERE host_id = ? AND container_id = ?'
  ).get(hostId, containerId);
}

function getByToken(token) {
  const db = getDb();
  return db.prepare('SELECT * FROM container_webhooks WHERE token = ?').get(token);
}

function list(hostId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM container_webhooks WHERE host_id = ? ORDER BY created_at DESC'
  ).all(hostId);
}

function create({ hostId, containerId, containerName, action }, userId) {
  if (!hostId || !containerId) throw new Error('hostId + containerId required');
  const validActions = ['recreate', 'restart', 'pull-only'];
  const finalAction = validActions.includes(action) ? action : 'recreate';
  const token = _newToken();
  const db = getDb();
  const existing = getByContainer(hostId, containerId);
  if (existing) throw Object.assign(new Error('Webhook already exists for this container'), { status: 409 });
  const result = db.prepare(`
    INSERT INTO container_webhooks (host_id, container_id, container_name, token, action, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hostId, containerId, containerName || null, token, finalAction, userId || null);
  return { id: result.lastInsertRowid, token, action: finalAction };
}

function remove(id) {
  const db = getDb();
  db.prepare('DELETE FROM container_webhooks WHERE id = ?').run(id);
}

function removeByContainer(hostId, containerId) {
  const db = getDb();
  db.prepare('DELETE FROM container_webhooks WHERE host_id = ? AND container_id = ?')
    .run(hostId, containerId);
}

/**
 * Execute a webhook trigger — pull image + recreate/restart the container.
 * Returns the final action taken. Rate limiting is enforced at the route.
 */
async function trigger(webhookRow, ip) {
  const db = getDb();
  db.prepare(`
    UPDATE container_webhooks
    SET last_triggered_at = datetime('now'), last_triggered_ip = ?, trigger_count = trigger_count + 1
    WHERE id = ?
  `).run(ip || null, webhookRow.id);

  const container = await dockerService.getContainer(webhookRow.host_id, webhookRow.container_id);
  if (!container) throw new Error(`Container ${webhookRow.container_id} not found`);

  const imageName = container.Image || (container.Config && container.Config.Image);
  if (!imageName) throw new Error('Cannot determine image name');

  // Pull latest image (fire and forget on failure — if pull fails but restart is what we want, still proceed)
  try {
    await dockerService.pullImage(webhookRow.host_id, imageName);
  } catch (err) {
    log.warn('Webhook trigger: image pull failed', { imageName, error: err.message });
  }

  const action = webhookRow.action || 'recreate';
  if (action === 'pull-only') return { action, image: imageName };

  if (action === 'restart') {
    await dockerService.restartContainer(webhookRow.host_id, webhookRow.container_id);
    return { action, image: imageName };
  }

  // recreate: stop → remove → run with same config → start.
  // For scope, we call docker's recreateContainer if available; else stop+start.
  if (typeof dockerService.recreateContainer === 'function') {
    await dockerService.recreateContainer(webhookRow.host_id, webhookRow.container_id);
  } else {
    await dockerService.restartContainer(webhookRow.host_id, webhookRow.container_id);
  }
  return { action, image: imageName };
}

module.exports = { list, getByContainer, getByToken, create, remove, removeByContainer, trigger };
