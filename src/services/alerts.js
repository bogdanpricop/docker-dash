'use strict';

const { getDb } = require('../db');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('alerts');

class AlertService {
  constructor() {
    this._wsNotify = null; // Set by WebSocket server
  }

  setNotifier(fn) { this._wsNotify = fn; }

  /** Evaluate all active alert rules against latest stats */
  evaluate() {
    const db = getDb();
    const rules = db.prepare('SELECT * FROM alert_rules WHERE is_active = 1').all();
    if (rules.length === 0) return;

    const latestStats = db.prepare(`
      SELECT container_id, container_name, cpu_percent, mem_percent,
             mem_usage, mem_limit, recorded_at
      FROM container_stats
      WHERE recorded_at = (SELECT MAX(recorded_at) FROM container_stats)
    `).all();

    for (const rule of rules) {
      const targets = rule.target === '*'
        ? latestStats
        : latestStats.filter(s => s.container_name === rule.target || s.container_id.startsWith(rule.target));

      for (const stats of targets) {
        const value = rule.metric === 'cpu' ? stats.cpu_percent : stats.mem_percent;
        const breached = this._checkThreshold(value, rule.operator, rule.threshold);

        if (breached) {
          this._handleBreach(rule, stats.container_id, stats.container_name, value);
        } else {
          this._clearBreach(rule.id, stats.container_id);
        }
      }
    }
  }

  _checkThreshold(value, operator, threshold) {
    switch (operator) {
      case '>': return value > threshold;
      case '>=': return value >= threshold;
      case '<': return value < threshold;
      case '<=': return value <= threshold;
      case '==': return value === threshold;
      case '!=': return value !== threshold;
      default: return false;
    }
  }

  _handleBreach(rule, containerId, containerName, value) {
    const db = getDb();
    
    // Check existing breach
    let breach = db.prepare('SELECT * FROM alert_breaches WHERE rule_id = ? AND container_id = ?')
      .get(rule.id, containerId);

    if (!breach) {
      db.prepare('INSERT OR REPLACE INTO alert_breaches (rule_id, container_id, first_breach_at, last_value) VALUES (?, ?, ?, ?)')
        .run(rule.id, containerId, now(), value);
      breach = { first_breach_at: now() };
    } else {
      db.prepare('UPDATE alert_breaches SET last_value = ? WHERE rule_id = ? AND container_id = ?')
        .run(value, rule.id, containerId);
    }

    // Check duration
    const breachDuration = (Date.now() - new Date(breach.first_breach_at).getTime()) / 1000;
    if (breachDuration < rule.duration_seconds) return;

    // Check cooldown - don't fire again within cooldown period
    const lastEvent = db.prepare(`
      SELECT triggered_at FROM alert_events
      WHERE rule_id = ? AND container_id = ?
      ORDER BY triggered_at DESC LIMIT 1
    `).get(rule.id, containerId);

    if (lastEvent) {
      const sinceLastAlert = (Date.now() - new Date(lastEvent.triggered_at).getTime()) / 1000;
      if (sinceLastAlert < rule.cooldown_seconds) return;
    }

    // Fire alert
    const message = `${rule.name}: ${containerName || containerId.substring(0, 12)} ${rule.metric} is ${value.toFixed(1)}% (threshold: ${rule.operator} ${rule.threshold}%)`;
    
    db.prepare(`
      INSERT INTO alert_events (rule_id, container_id, container_name, metric_value, message, severity)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(rule.id, containerId, containerName, value, message, rule.severity);

    log.warn('Alert fired', { rule: rule.name, container: containerName, value });

    // Notify via WebSocket
    if (this._wsNotify) {
      this._wsNotify('alert', { rule: rule.name, severity: rule.severity, message, containerId, containerName, value });
    }
  }

  _clearBreach(ruleId, containerId) {
    const db = getDb();
    db.prepare('DELETE FROM alert_breaches WHERE rule_id = ? AND container_id = ?').run(ruleId, containerId);
    
    // Auto-resolve open alerts
    db.prepare(`
      UPDATE alert_events SET resolved_at = ?
      WHERE rule_id = ? AND container_id = ? AND resolved_at IS NULL
    `).run(now(), ruleId, containerId);
  }

  // ─── CRUD ─────────────────────────────────────────────────

  listRules() {
    return getDb().prepare('SELECT * FROM alert_rules ORDER BY name').all();
  }

  getRule(id) {
    return getDb().prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
  }

  createRule(data) {
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO alert_rules (name, description, target, metric, operator, threshold,
        duration_seconds, cooldown_seconds, severity, channels, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.name, data.description, data.target || '*', data.metric, data.operator || '>',
      data.threshold, data.duration_seconds || 0, data.cooldown_seconds || 300,
      data.severity || 'warning', JSON.stringify(data.channels || ['toast']),
      data.is_active ? 1 : 0, data.created_by);
    return { id: r.lastInsertRowid };
  }

  updateRule(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'channels') { sets.push('channels = ?'); params.push(JSON.stringify(val)); }
      else if (key === 'is_active') { sets.push('is_active = ?'); params.push(val ? 1 : 0); }
      else { sets.push(`${key} = ?`); params.push(val); }
    }
    sets.push('updated_at = ?'); params.push(now());
    params.push(id);
    db.prepare(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteRule(id) {
    const db = getDb();
    db.prepare('DELETE FROM alert_breaches WHERE rule_id = ?').run(id);
    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  }

  getActiveAlerts() {
    return getDb().prepare(`
      SELECT ae.*, ar.name as rule_name
      FROM alert_events ae JOIN alert_rules ar ON ae.rule_id = ar.id
      WHERE ae.resolved_at IS NULL
      ORDER BY ae.triggered_at DESC
    `).all();
  }

  getAlertHistory({ page = 1, limit = 50 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const total = db.prepare('SELECT COUNT(*) as c FROM alert_events').get().c;
    const rows = db.prepare(`
      SELECT ae.*, ar.name as rule_name
      FROM alert_events ae JOIN alert_rules ar ON ae.rule_id = ar.id
      ORDER BY ae.triggered_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
    return { rows, total, page, limit };
  }

  acknowledge(eventId, userId) {
    getDb().prepare('UPDATE alert_events SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?')
      .run(userId, now(), eventId);
  }
}

module.exports = new AlertService();
