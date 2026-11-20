'use strict';

const { createHash } = require('node:crypto');
const { getDb } = require('../db');
const { decryptSshConfig } = require('./host-config-crypto');
const { normalizeFingerprint } = require('../utils/ssh-host-key');

// This endpoint deliberately does not open a connection or serialize a host config.
// Deployment observations are dated, configuration-bound snapshots, not live attestations.
function publicConfig(hostId) {
  const host = getDb().prepare('SELECT id,name,connection_type,ssh_config FROM docker_hosts WHERE id=? AND is_active=1').get(hostId);
  if (!host) throw Object.assign(new Error('Host not found'), { status: 404 });
  const info = { hostId: host.id, name: host.name, connectionType: host.connection_type };
  if (host.connection_type !== 'ssh') return info;
  let ssh;
  try { ssh = decryptSshConfig(host.ssh_config); } catch { /* Never expose decryption internals. */ }
  if (!ssh || typeof ssh !== 'object' || Array.isArray(ssh)) return { ...info, configurationAvailable: false };
  const safeText = (v, max) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
  let fingerprint = null;
  try { fingerprint = 'SHA256:' + Buffer.from(normalizeFingerprint(ssh.hostKeySha256), 'hex').toString('base64').replace(/=+$/, ''); }
  catch { /* A missing or invalid pin must not be described as verified. */ }
  return { ...info, configurationAvailable: true, endpoint: safeText(ssh.host, 253),
    port: Number.isInteger(Number(ssh.port || 22)) ? Number(ssh.port || 22) : null,
    username: safeText(ssh.username, 128), socket: safeText(ssh.dockerSocket || '/var/run/docker.sock', 256),
    authentication: ssh.privateKey ? 'SSH key' : ssh.password ? 'Password over SSH' : 'Not configured', fingerprint };
}

function configHash(info) {
  // Public connection identity only. Passwords, key material and passphrases never enter this hash.
  const { name: _name, ...identity } = info;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function get(hostId) {
  const info = publicConfig(hostId);
  let record;
  try { record = JSON.parse(getDb().prepare('SELECT connection_info_json FROM ai_compute_hosts WHERE host_id=?').get(hostId)?.connection_info_json || '{}'); }
  catch { /* A malformed snapshot cannot become a security assertion. */ }
  const status = !record?.verifiedAt ? 'unrecorded' : record.configHash !== configHash(info) ? 'stale' : 'recorded';
  return { ...info, recordStatus: status, deployment: status === 'recorded' ? sanitizeRecord(record) : null };
}

function sanitizeRecord(record) {
  const text = (v, max = 256) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
  const list = value => Array.isArray(value) ? value.slice(0, 12).map(v => text(v, 600)).filter(Boolean) : [];
  return { title: text(record.title, 120), route: list(record.route), protections: list(record.protections),
    operations: list(record.operations), verifiedAt: text(record.verifiedAt, 40) };
}

// Operator-only maintenance helper. No HTTP mutation endpoint: observations must
// come from an actual deployment inspection, never from a name/IP heuristic.
function recordDeploymentInfo(hostId, observation) {
  const info = publicConfig(hostId);
  if (info.connectionType !== 'ssh' || !info.configurationAvailable || !info.fingerprint) {
    throw new Error('A configured SSH host with a valid server fingerprint is required');
  }
  const verifiedAt = new Date().toISOString();
  const record = { ...sanitizeRecord(observation), verifiedAt, configHash: configHash(info) };
  if (!record.title || !record.route.length || !record.protections.length) throw new Error('Deployment observations are incomplete');
  getDb().prepare(`INSERT INTO ai_compute_hosts(host_id,monitoring,updated_at,connection_info_json) VALUES (?,0,?,?)
    ON CONFLICT(host_id) DO UPDATE SET connection_info_json=excluded.connection_info_json,updated_at=excluded.updated_at`)
    .run(hostId, verifiedAt, JSON.stringify(record));
  return get(hostId);
}

module.exports = { get, recordDeploymentInfo };
