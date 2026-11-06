'use strict';
const config = require('../config');
const { generateToken, sha256 } = require('../utils/crypto');

function link(token, invite = false) {
  const value = config.app.publicUrl || config.app.baseUrl;
  let base;
  try { base = new URL(value); } catch { throw new Error('Configure a valid PUBLIC_URL for account email'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('PUBLIC_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';
  const url = new URL('reset-password.html', base);
  url.searchParams.set('token', token);
  if (invite) url.searchParams.set('invite', '1');
  return url.href;
}

function issue(db, userId, type, ttlMs, expectedEmail) {
  if (!config.smtp?.host) throw new Error('SMTP is not configured');
  const token = generateToken(32), tokenHash = sha256(token), url = link(token, type === 'invite');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.transaction(() => {
    // Bind the recipient snapshot to issuance under the same write lock. A
    // different process may change the address after the caller's initial read.
    const current = db.prepare('SELECT email,is_active,auth_source FROM users WHERE id=?').get(userId);
    if (!current?.is_active || typeof expectedEmail !== 'string' || !expectedEmail || current.email !== expectedEmail) {
      throw new Error('Account changed before reset issuance');
    }
    if (current.auth_source !== 'local') throw new Error('Only local accounts support password recovery');
    db.prepare("UPDATE password_reset_tokens SET used_at=datetime('now') WHERE user_id=? AND used_at IS NULL").run(userId);
    db.prepare('INSERT INTO password_reset_tokens(user_id,token_hash,type,expires_at) VALUES (?,?,?,?)').run(userId, tokenHash, type, expiresAt);
  }).immediate();
  return { tokenHash, url };
}

function revoke(db, tokenHash) {
  db.prepare("UPDATE password_reset_tokens SET used_at=datetime('now') WHERE token_hash=? AND used_at IS NULL").run(tokenHash);
}

function find(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  // ISO 'T' timestamps and SQLite space-separated timestamps must be compared
  // as instants, never lexically. Invalid dates evaluate to NULL and are denied.
  return db.prepare(`SELECT rt.*,u.id AS uid,u.username FROM password_reset_tokens rt
    JOIN users u ON u.id=rt.user_id WHERE rt.token_hash=? AND rt.used_at IS NULL
    AND julianday(rt.expires_at)>julianday('now') AND u.is_active=1 AND u.auth_source='local'`).get(sha256(token)) || null;
}

function consume(db, token, hash, onCommit) {
  return db.transaction(() => {
    // Recheck after asynchronous bcrypt, under SQLite's write transaction.
    const row = find(db, token);
    if (!row) return null;
    const claimed = db.prepare("UPDATE password_reset_tokens SET used_at=datetime('now') WHERE id=? AND used_at IS NULL").run(row.id);
    if (claimed.changes !== 1) return null;
    db.prepare(`UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=datetime('now'),
      failed_attempts=0,is_locked=0,locked_until=NULL,updated_at=datetime('now') WHERE id=?`).run(hash, row.uid);
    db.prepare('UPDATE sessions SET is_valid=0 WHERE user_id=?').run(row.uid);
    db.prepare("UPDATE password_reset_tokens SET used_at=datetime('now') WHERE user_id=? AND used_at IS NULL").run(row.uid);
    if (onCommit(row)?.then) throw new Error('Reset audit must be synchronous');
    return row;
  }).immediate();
}

module.exports = { link, issue, revoke, find, consume };
