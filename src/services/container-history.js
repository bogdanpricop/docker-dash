'use strict';

const { getDb } = require('../db');
const { endpoints, imageReference } = require('../utils/container-config');
const { sealSnapshot, readSnapshot } = require('../utils/history-snapshot');

function record({ inspect, hostId = 0, action, username = 'system' }) {
  const entry = { container_name: inspect.Name.replace(/^\//, ''), container_id: inspect.Id,
    host_id: hostId, image_id: inspect.Image };
  const cfg = inspect.Config;
  const snapshot = sealSnapshot(JSON.stringify({ ...cfg, HostConfig: inspect.HostConfig,
    Mounts: inspect.Mounts, NetworkingConfig: { EndpointsConfig: endpoints(inspect) } }), entry);
  // A missing table, unavailable key or failed write must stop the operation
  // before destroying the only usable container configuration.
  return getDb().prepare(`INSERT INTO container_image_history
    (container_name, container_id, host_id, image_name, image_id, action, deployed_by, was_running, config_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.container_name, entry.container_id,
    entry.host_id, imageReference(inspect), entry.image_id, action, username, inspect.State.Running ? 1 : 0, snapshot).lastInsertRowid;
}

module.exports = { record, readSnapshot };
