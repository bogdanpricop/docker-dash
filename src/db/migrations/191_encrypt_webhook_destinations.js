'use strict';

const { encrypt } = require('../../utils/crypto');

exports.up = function (db) {
  db.exec('ALTER TABLE webhooks ADD COLUMN delivery_config_enc TEXT');
  const update = db.prepare("UPDATE webhooks SET delivery_config_enc = ?, url = '', headers = '{}', secret = NULL WHERE id = ?");
  const secureDelete = db.pragma('secure_delete', { simple: true });
  db.pragma('secure_delete = ON');
  try {
    for (const row of db.prepare('SELECT id, url, headers, secret FROM webhooks').all()) {
      update.run(encrypt(JSON.stringify({ url: row.url, headers: row.headers, secret: row.secret })), row.id);
    }
  } finally {
    db.pragma('secure_delete = ' + secureDelete);
  }
};
