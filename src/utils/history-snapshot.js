'use strict';

const { encrypt, decrypt } = require('./crypto');
const PREFIX = 'dd-history:v1:';

// Authenticate the owning Docker identity together with the secret payload.
function context(entry) {
  return JSON.stringify([Number(entry.host_id), entry.container_name, entry.container_id, entry.image_id]);
}

function sealSnapshot(text, entry) {
  if (typeof text !== 'string') throw new Error('Invalid rollback snapshot');
  return PREFIX + encrypt(JSON.stringify({ context: context(entry), snapshot: text }));
}

function openSnapshotText(value, entry) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw new Error('Encrypted rollback snapshot required');
  const envelope = JSON.parse(decrypt(value.slice(PREFIX.length)));
  if (!envelope || envelope.context !== context(entry) || typeof envelope.snapshot !== 'string') {
    throw new Error('Rollback snapshot identity mismatch');
  }
  return envelope.snapshot;
}

function readSnapshot(entry) {
  if (entry.config_snapshot === null || entry.config_snapshot === '') return null;
  const snapshot = JSON.parse(openSnapshotText(entry.config_snapshot, entry));
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid rollback snapshot');
  return snapshot;
}

module.exports = { PREFIX, sealSnapshot, openSnapshotText, readSnapshot };
