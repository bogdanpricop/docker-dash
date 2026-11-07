'use strict';

// v8.9.8-alpha.1 — Portainer G06 closure: container webhook triggers.

const crypto = require('crypto');
const { getDb } = require('../db');
const dockerService = require('./docker');
const { imageReference } = require('../utils/container-config');
const { pullImage } = require('../utils/docker-pull');
const replacement = require('./container-replacement');

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
  if (!validActions.includes(action)) throw Object.assign(new Error('Invalid webhook action'), { status: 400 });
  const token = _newToken();
  const db = getDb();
  const existing = getByContainer(hostId, containerId);
  if (existing) throw Object.assign(new Error('Webhook already exists for this container'), { status: 409 });
  const result = db.prepare(`
    INSERT INTO container_webhooks (host_id, container_id, container_name, token, action, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hostId, containerId, containerName || null, token, action, userId || null);
  return { id: result.lastInsertRowid, token, action };
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
  const assertCurrent = () => {
    const row = db.prepare('SELECT container_id, action FROM container_webhooks WHERE id = ? AND token = ?')
      .get(webhookRow.id, webhookRow.token);
    if (row?.container_id !== webhookRow.container_id || row?.action !== webhookRow.action) {
      throw Object.assign(new Error('Webhook was revoked or its target changed'), { status: 409 });
    }
  };
  db.prepare(`
    UPDATE container_webhooks
    SET last_triggered_at = datetime('now'), last_triggered_ip = ?, trigger_count = trigger_count + 1
    WHERE id = ?
  `).run(ip || null, webhookRow.id);

  const action = webhookRow.action || 'recreate';
  const docker = dockerService.getDocker(webhookRow.host_id);
  const inspection = await docker.getContainer(webhookRow.container_id).inspect();
  assertCurrent();
  const image = imageReference(inspection);
  if (action !== 'pull-only' && dockerService.isSelf(inspection.Id)) {
    throw Object.assign(new Error('A webhook cannot restart or replace Docker Dash'), { status: 403 });
  }
  if (action === 'restart') {
    await docker.getContainer(inspection.Id).restart();
    return { action, image };
  }
  await pullImage(docker, image);
  if (action === 'pull-only') return { action, image };
  const candidate = await docker.getImage(image).inspect();
  assertCurrent();
  const result = await replacement.replace({
    docker, inspect: inspection, imageId: candidate.Id, hostId: webhookRow.host_id,
    action: 'update', username: 'container-webhook',
    commit: id => {
      const changed = db.prepare('UPDATE container_webhooks SET container_id = ? WHERE id = ? AND container_id = ?')
        .run(id, webhookRow.id, webhookRow.container_id);
      if (!changed.changes) throw new Error('Webhook target changed during replacement');
    },
  });
  return { action, image, operationId: result.operationId, cleanupRequired: result.cleanupRequired };
}

module.exports = { list, getByContainer, getByToken, create, remove, removeByContainer, trigger };
