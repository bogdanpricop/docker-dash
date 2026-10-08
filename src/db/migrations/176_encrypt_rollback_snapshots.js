'use strict';

const { PREFIX, sealSnapshot, openSnapshotText } = require('../../utils/history-snapshot');

// The migration runner wraps this entire operation and its marker in one
// transaction. Read one row at a time without keeping a SQLite iterator open
// during writes, or loading all historical secrets into memory at once.
exports.up = function (db) {
  const update = db.prepare('UPDATE container_image_history SET config_snapshot = ? WHERE id = ?');
  const query = "SELECT * FROM container_image_history WHERE config_snapshot IS NOT NULL AND config_snapshot != ''";
  const next = db.prepare(query + ' AND id > ? ORDER BY id LIMIT 1');
  let entry = db.prepare(query + ' ORDER BY id LIMIT 1').get();
  while (entry) {
    if (entry.config_snapshot.startsWith(PREFIX)) {
      openSnapshotText(entry.config_snapshot, entry); // Verify previously sealed rows, never double-encrypt.
    } else {
      update.run(sealSnapshot(entry.config_snapshot, entry), entry.id);
    }
    entry = next.get(entry.id);
  }
};

exports.down = function () {
  throw new Error('Rollback snapshot encryption cannot be reverted to plaintext');
};
