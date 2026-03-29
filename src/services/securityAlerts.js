'use strict';

const { getDb } = require('../db');
const log = require('../utils/logger')('security-alerts');

/**
 * Maps audit log actions to security alert event types.
 * This bridges the audit log action names to the rule event_type field.
 */
const ACTION_TO_EVENT = {
  'login':              null,           // successful login — not an alert by itself
  'mfa_disable':        'mfa_disabled',
  'reset_password':     'admin_password_reset',
  'send_password_reset': 'admin_password_reset',
};

class SecurityAlertService {
  constructor() {
    this._rules = [];
    this._initialized = false;
    this._cooldowns = new Map(); // ruleId → lastFiredTimestamp
    this._cooldownMs = 60000; // 1 minute cooldown per rule
  }

  /** Initialize: load rules from DB */
  init() {
    try {
      this._loadRules();
      this._initialized = true;
    } catch (err) {
      log.error('Failed to initialize security alerts', { error: err.message });
    }
  }

  _loadRules() {
    const db = getDb();
    try {
      this._rules = db.prepare('SELECT * FROM security_alert_rules WHERE is_active = 1').all();
    } catch {
      this._rules = [];
    }
  }

  /** Reload rules from DB (call after rule changes) */
  reload() {
    this._loadRules();
  }

  /**
   * Evaluate an audit log entry against all active security rules.
   * Called by auditService.onLog() hook after each audit entry.
   */
  evaluate(auditEntry) {
    if (!this._initialized) this.init();

    const eventType = this._mapActionToEvent(auditEntry);
    if (!eventType) return;

    for (const rule of this._rules) {
      if (rule.event_type !== eventType) continue;

      if (rule.window_seconds > 0 && rule.threshold > 1) {
        // Threshold-based rule: count events in window
        this._evaluateThresholdRule(rule, auditEntry);
      } else {
        // Instant rule (threshold=1, window=0): fire immediately
        this._fireAlert(rule, auditEntry);
      }
    }
  }

  /**
   * Evaluate windowed/threshold rules.
   * Called periodically by jobs system for rules that need time-window counting.
   */
  evaluateWindowed() {
    if (!this._initialized) this.init();

    const db = getDb();

    for (const rule of this._rules) {
      if (rule.window_seconds <= 0 || rule.threshold <= 1) continue;

      try {
        if (rule.event_type === 'failed_login') {
          this._evaluateFailedLogins(rule);
        }
        // Other windowed rules can be added here
      } catch (err) {
        log.error('Windowed rule evaluation failed', { rule: rule.name, error: err.message });
      }
    }
  }

  /**
   * Map an audit log action to a security event type.
   */
  _mapActionToEvent(entry) {
    // Direct mapping
    if (ACTION_TO_EVENT[entry.action] !== undefined) {
      return ACTION_TO_EVENT[entry.action];
    }

    // Dynamic mapping based on action + details
    if (entry.action === 'create_user') {
      // Check if the created user is an admin
      try {
        const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
        if (details?.role === 'admin') return 'create_admin_user';
      } catch {}
    }

    if (entry.action === 'update_user') {
      try {
        const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
        if (details?.role === 'admin') return 'role_changed_to_admin';
      } catch {}
    }

    return null;
  }

  /**
   * Evaluate failed login threshold rule using login_attempts table.
   */
  _evaluateFailedLogins(rule) {
    const db = getDb();
    const windowStart = new Date(Date.now() - rule.window_seconds * 1000).toISOString();

    const results = db.prepare(`
      SELECT ip, COUNT(*) as cnt, GROUP_CONCAT(DISTINCT username) as usernames
      FROM login_attempts
      WHERE success = 0 AND attempted_at > ?
      GROUP BY ip
      HAVING cnt >= ?
    `).all(windowStart, rule.threshold);

    for (const row of results) {
      const cooldownKey = `${rule.id}:${row.ip}`;
      const lastFired = this._cooldowns.get(cooldownKey);
      if (lastFired && Date.now() - lastFired < this._cooldownMs * 5) continue; // 5 min cooldown for brute force alerts

      this._cooldowns.set(cooldownKey, Date.now());

      const message = `${row.cnt} failed login attempts from IP ${row.ip} in the last ${Math.round(rule.window_seconds / 60)} minutes. Targeted accounts: ${row.usernames}.`;

      this._recordAndNotify(rule, message, { ip: row.ip, count: row.cnt, usernames: row.usernames });
    }
  }

  /**
   * Evaluate a threshold rule against the audit log.
   */
  _evaluateThresholdRule(rule, auditEntry) {
    // For non-login threshold rules, we count in the audit log
    const db = getDb();
    const windowStart = new Date(Date.now() - rule.window_seconds * 1000).toISOString();

    // Map event type back to action for counting
    const count = db.prepare(`
      SELECT COUNT(*) as cnt FROM audit_log
      WHERE action = ? AND created_at > ?
    `).get(auditEntry.action, windowStart).cnt;

    if (count >= rule.threshold) {
      const cooldownKey = `${rule.id}:threshold`;
      const lastFired = this._cooldowns.get(cooldownKey);
      if (lastFired && Date.now() - lastFired < this._cooldownMs) return;
      this._cooldowns.set(cooldownKey, Date.now());

      const message = `${count} "${auditEntry.action}" events in the last ${Math.round(rule.window_seconds / 60)} minutes (threshold: ${rule.threshold}).`;
      this._recordAndNotify(rule, message, { count, action: auditEntry.action });
    }
  }

  /**
   * Fire an instant alert (threshold=1).
   */
  _fireAlert(rule, auditEntry) {
    const cooldownKey = `${rule.id}:${auditEntry.action}:${auditEntry.ip || 'none'}`;
    const lastFired = this._cooldowns.get(cooldownKey);
    if (lastFired && Date.now() - lastFired < this._cooldownMs) return;
    this._cooldowns.set(cooldownKey, Date.now());

    const message = this._buildMessage(rule, auditEntry);
    this._recordAndNotify(rule, message, { action: auditEntry.action, user: auditEntry.username, ip: auditEntry.ip });
  }

  _buildMessage(rule, entry) {
    switch (rule.event_type) {
      case 'create_admin_user':
        return `New admin user created by ${entry.username || 'unknown'} from ${entry.ip || 'unknown'}.`;
      case 'mfa_disabled':
        return `MFA was disabled for user ${entry.username || 'unknown'} from ${entry.ip || 'unknown'}.`;
      case 'admin_password_reset':
        return `Password reset performed by admin ${entry.username || 'unknown'} from ${entry.ip || 'unknown'}.`;
      case 'role_changed_to_admin':
        return `User role changed to admin by ${entry.username || 'unknown'} from ${entry.ip || 'unknown'}.`;
      default:
        return `Security event "${rule.event_type}" triggered by ${entry.username || 'unknown'} from ${entry.ip || 'unknown'}.`;
    }
  }

  /**
   * Record alert in DB and send notifications.
   */
  _recordAndNotify(rule, message, details) {
    const db = getDb();

    // Record in security_alert_events
    try {
      db.prepare(`
        INSERT INTO security_alert_events (rule_id, rule_name, event_type, severity, message, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(rule.id, rule.name, rule.event_type, rule.severity, message, JSON.stringify(details));
    } catch (err) {
      log.error('Failed to record security alert', { error: err.message });
    }

    // Send notification
    try {
      const channelService = require('./notificationChannels');
      const notification = {
        title: `Security Alert: ${rule.name}`,
        text: message,
        severity: rule.severity,
        event: 'security_alert',
        embed: true,
      };

      if (rule.notify_channels) {
        // Send to specific channels
        const channelIds = JSON.parse(rule.notify_channels);
        for (const channelId of channelIds) {
          channelService.send(channelId, notification).catch(err => {
            log.error('Security notification failed', { channelId, error: err.message });
          });
        }
      } else {
        // Send to all active channels
        channelService.sendToAll(notification).catch(err => {
          log.error('Security notification broadcast failed', { error: err.message });
        });
      }
    } catch (err) {
      log.error('Security notification dispatch failed', { error: err.message });
    }

    log.warn(`Security alert: ${rule.name}`, { message, severity: rule.severity });
  }

  // ─── Rule Management ────────────────────────────────────

  listRules() {
    const db = getDb();
    return db.prepare('SELECT * FROM security_alert_rules ORDER BY name').all();
  }

  getRule(id) {
    return getDb().prepare('SELECT * FROM security_alert_rules WHERE id = ?').get(id);
  }

  createRule({ name, eventType, threshold, windowSeconds, severity, notifyChannels }) {
    if (!name || !eventType) throw new Error('name and eventType are required');
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO security_alert_rules (name, event_type, threshold, window_seconds, severity, notify_channels)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, eventType, threshold || 1, windowSeconds || 0, severity || 'warning', notifyChannels ? JSON.stringify(notifyChannels) : null);
    this.reload();
    return { id: Number(r.lastInsertRowid) };
  }

  updateRule(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.eventType !== undefined) { sets.push('event_type = ?'); params.push(data.eventType); }
    if (data.threshold !== undefined) { sets.push('threshold = ?'); params.push(data.threshold); }
    if (data.windowSeconds !== undefined) { sets.push('window_seconds = ?'); params.push(data.windowSeconds); }
    if (data.severity !== undefined) { sets.push('severity = ?'); params.push(data.severity); }
    if (data.isActive !== undefined) { sets.push('is_active = ?'); params.push(data.isActive ? 1 : 0); }
    if (data.notifyChannels !== undefined) { sets.push('notify_channels = ?'); params.push(data.notifyChannels ? JSON.stringify(data.notifyChannels) : null); }

    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE security_alert_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    this.reload();
  }

  deleteRule(id) {
    getDb().prepare('DELETE FROM security_alert_rules WHERE id = ?').run(id);
    this.reload();
  }

  getRecentAlerts(hours = 24) {
    const db = getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    return db.prepare(`
      SELECT * FROM security_alert_events
      WHERE fired_at > ?
      ORDER BY fired_at DESC
      LIMIT 100
    `).all(since);
  }

  /** Test-fire a rule (sends test notification) */
  async testRule(id) {
    const rule = this.getRule(id);
    if (!rule) throw new Error('Rule not found');

    this._recordAndNotify(rule, `Test alert for rule "${rule.name}". This is a test notification.`, { test: true });
    return { success: true };
  }
}

module.exports = new SecurityAlertService();
