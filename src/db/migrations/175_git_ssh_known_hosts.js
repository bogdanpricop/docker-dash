'use strict';

exports.up = function (db) {
  db.exec("ALTER TABLE git_credentials ADD COLUMN ssh_known_hosts TEXT NOT NULL DEFAULT ''");
};

exports.down = function () {
  throw new Error('Git server trust cannot be rolled back to unverified SSH');
};
