'use strict';

const { defaultHost } = require('../../utils/host-id');

exports.up = db => {
  db.exec('ALTER TABLE scheduled_actions ADD COLUMN last_auto_run_slot INTEGER');
  const host = defaultHost(db);
  if (host) db.prepare('UPDATE scheduled_actions SET host_id = ? WHERE host_id = 0').run(host.id);
};
