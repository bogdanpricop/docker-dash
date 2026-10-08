'use strict';

const config = require('../config');
const { getDb } = require('../db');
const cluster = require('./cluster');
const tokens = require('./password-reset');
const emailService = require('./email');
const auditService = require('./audit');
const log = require('../utils/logger')('password-reset-delivery');

// Volatile, bounded, per-process queue. HTTP responses never await account
// lookup, quota verification or SMTP. Pending work is discarded on shutdown.
class ResetDelivery {
  constructor() {
    this.pending = [];
    this.running = 0;
    this.stopped = false;
    this.issued = new Set();
    this.idleWaiters = [];
  }

  enqueue({ email, lang, ip }) {
    if (this.stopped || typeof email !== 'string' || email.length > 254 || !email.trim()) return false;
    // Capacity includes queued AND active jobs, including unresolved SMTP.
    if (this.pending.length + this.running >= 32) return false;
    this.pending.push({ email: email.trim(), lang: lang === 'ro' ? 'ro' : 'en', ip });
    this.pump();
    return true;
  }

  pump() {
    while (!this.stopped && this.running < 2 && this.pending.length) {
      const job = this.pending.shift();
      this.running++;
      setImmediate(async () => {
        try { if (!this.stopped) await this.deliver(job); }
        catch { log.error('Password reset delivery job failed'); }
        finally {
          this.running--;
          this.pump();
          if (!this.running && !this.pending.length) this.idleWaiters.splice(0).forEach(resolve => resolve());
        }
      });
    }
  }

  async deliver(job) {
    if (!config.smtp?.host) return;
    const db = getDb();
    const user = db.prepare("SELECT id,username,email FROM users WHERE LOWER(email)=LOWER(?) AND is_active=1 AND auth_source='local'").get(job.email);
    if (!user) return;
    let decision, timer;
    try {
      decision = await Promise.race([
        // One account budget across source IPs and HA replicas; no email in Redis.
        cluster.rateLimitTick(JSON.stringify(['auth-reset-account', user.id]), 3, 60 * 60 * 1000),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Quota deadline')), 3000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (this.stopped) return;
    if (!decision || typeof decision.allowed !== 'boolean' || !Number.isSafeInteger(decision.remaining) || decision.remaining < 0) {
      throw new Error('Invalid reset quota decision');
    }
    if (!decision.allowed) return;
    // Issuance rechecks the recipient/activity under the SQLite write lock.
    const issued = db.transaction(() => {
      const created = tokens.issue(db, user.id, 'reset', 15 * 60 * 1000, user.email);
      auditService.log({ userId: user.id, username: user.username, action: 'password_reset_requested',
        details: { delivery: 'pending' }, ip: job.ip });
      return created;
    }).immediate();
    this.issued.add(issued.tokenHash);
    let delivered = false;
    try {
      await emailService.sendPasswordReset({ to: user.email, username: user.username, resetUrl: issued.url, lang: job.lang });
      delivered = true;
    } catch {
      if (!this.stopped) {
        tokens.revoke(db, issued.tokenHash);
        log.error('Password reset email delivery failed', { userId: user.id });
      }
    } finally { this.issued.delete(issued.tokenHash); }
    if (this.stopped) return;
    auditService.log({ userId: user.id, username: user.username, action: 'password_reset_delivery',
      details: { delivered }, ip: job.ip });
  }

  stop() {
    this.stopped = true;
    this.pending.length = 0;
    // Revoke in-flight links before the DB closes. Late SMTP/quota callbacks
    // cannot issue links, audit or reopen the DB after shutdown.
    for (const hash of this.issued) {
      try { tokens.revoke(getDb(), hash); } catch { log.error('Could not revoke interrupted password reset delivery'); }
    }
    this.issued.clear();
  }

  // Used by tests to wait for real asynchronous effects, never by HTTP handlers.
  whenIdle() {
    return !this.running && !this.pending.length ? Promise.resolve() : new Promise(resolve => this.idleWaiters.push(resolve));
  }
}

module.exports = new ResetDelivery();
module.exports.ResetDelivery = ResetDelivery;
