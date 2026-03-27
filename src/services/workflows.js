'use strict';

const { getDb } = require('../db');
const { now, tryParseJson } = require('../utils/helpers');
const log = require('../utils/logger')('workflows');

class WorkflowService {
  constructor() {
    this._cooldowns = new Map(); // ruleId:containerId → lastTriggered
  }

  // ─── CRUD ─────────────────────────────────────────

  list() {
    return getDb().prepare('SELECT * FROM workflow_rules ORDER BY name').all().map(r => ({
      ...r,
      trigger_config: JSON.parse(r.trigger_config || '{}'),
      action_config: JSON.parse(r.action_config || '{}'),
    }));
  }

  get(id) {
    const r = getDb().prepare('SELECT * FROM workflow_rules WHERE id = ?').get(id);
    if (!r) return null;
    r.trigger_config = JSON.parse(r.trigger_config || '{}');
    r.action_config = JSON.parse(r.action_config || '{}');
    return r;
  }

  create(data) {
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO workflow_rules (name, description, trigger_type, trigger_config, action_type, action_config, target, cooldown_seconds, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name, data.description || '',
      data.trigger_type, JSON.stringify(data.trigger_config || {}),
      data.action_type, JSON.stringify(data.action_config || {}),
      data.target || '*', data.cooldown_seconds || 300, data.created_by
    );
    log.info('Workflow rule created', { id: r.lastInsertRowid, name: data.name });
    return { id: Number(r.lastInsertRowid) };
  }

  update(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];
    const fields = ['name', 'description', 'trigger_type', 'action_type', 'target', 'cooldown_seconds'];
    for (const f of fields) {
      if (data[f] !== undefined) { sets.push(`${f} = ?`); params.push(f === 'is_active' ? (data[f] ? 1 : 0) : data[f]); }
    }
    if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }
    if (data.trigger_config !== undefined) { sets.push('trigger_config = ?'); params.push(JSON.stringify(data.trigger_config)); }
    if (data.action_config !== undefined) { sets.push('action_config = ?'); params.push(JSON.stringify(data.action_config)); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?'); params.push(now()); params.push(id);
    db.prepare(`UPDATE workflow_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id) {
    getDb().prepare('DELETE FROM workflow_rules WHERE id = ?').run(id);
  }

  // ─── Evaluate ─────────────────────────────────────

  async evaluate(statsData, dockerEvents = []) {
    const db = getDb();
    const rules = db.prepare('SELECT * FROM workflow_rules WHERE is_active = 1').all();
    if (rules.length === 0) return;

    for (const rule of rules) {
      const config = JSON.parse(rule.trigger_config || '{}');
      const targets = this._resolveTargets(rule.target, statsData);

      for (const target of targets) {
        const triggered = this._checkTrigger(rule.trigger_type, config, target, dockerEvents);
        if (!triggered) continue;

        // Check cooldown
        const cooldownKey = `${rule.id}:${target.container_name}`;
        const lastTriggered = this._cooldowns.get(cooldownKey);
        if (lastTriggered && (Date.now() - lastTriggered) / 1000 < rule.cooldown_seconds) continue;

        // Execute action
        try {
          await this._executeAction(rule, target);
          this._cooldowns.set(cooldownKey, Date.now());
          db.prepare('UPDATE workflow_rules SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?')
            .run(now(), rule.id);
          log.info('Workflow triggered', { rule: rule.name, container: target.container_name, trigger: rule.trigger_type, action: rule.action_type });
        } catch (err) {
          log.error('Workflow action failed', { rule: rule.name, error: err.message });
        }
      }
    }
  }

  _resolveTargets(target, statsData) {
    if (target === '*') return statsData;
    return statsData.filter(s => s.container_name === target || s.container_id?.startsWith(target));
  }

  _checkTrigger(type, config, stats, events) {
    switch (type) {
      case 'cpu_high':
        return stats.cpu_percent > (config.threshold || 90);
      case 'mem_high':
        return stats.mem_percent > (config.threshold || 90);
      case 'container_exit':
        return stats.state === 'exited' && stats.exit_code !== 0;
      case 'container_unhealthy':
        return stats.health === 'unhealthy';
      case 'container_restart_loop':
        return (stats.restart_count || 0) > (config.max_restarts || 5);
      case 'image_vulnerable':
        return (stats.vuln_critical || 0) > 0;
      default:
        return false;
    }
  }

  async _executeAction(rule, target) {
    const actionConfig = JSON.parse(rule.action_config || '{}');

    switch (rule.action_type) {
      case 'notify': {
        const channelService = require('./notificationChannels');
        await channelService.sendToAll({
          title: `Workflow: ${rule.name}`,
          text: `Container "${target.container_name}" triggered rule "${rule.name}" (${rule.trigger_type})`,
          severity: 'warning',
          event: 'workflow',
        });
        break;
      }
      case 'restart': {
        const dockerService = require('./docker');
        const docker = dockerService.getDocker(target.host_id || 0);
        const container = docker.getContainer(target.container_id);
        await container.restart({ t: 10 });
        break;
      }
      case 'stop': {
        const dockerService = require('./docker');
        const docker = dockerService.getDocker(target.host_id || 0);
        const container = docker.getContainer(target.container_id);
        await container.stop({ t: 10 });
        break;
      }
      case 'webhook': {
        if (actionConfig.url) {
          await fetch(actionConfig.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rule: rule.name, trigger: rule.trigger_type,
              container: target.container_name, timestamp: new Date().toISOString(),
            }),
          });
        }
        break;
      }
      default:
        log.warn('Unknown workflow action', { type: rule.action_type });
    }
  }

  // ─── Templates ────────────────────────────────────

  getTemplates() {
    return [
      {
        name: 'Auto-restart on crash', description: 'Restart container when it exits with non-zero code',
        trigger_type: 'container_exit', trigger_config: {},
        action_type: 'restart', action_config: {}, cooldown_seconds: 60,
      },
      {
        name: 'Notify on high CPU', description: 'Send notification when CPU exceeds 90%',
        trigger_type: 'cpu_high', trigger_config: { threshold: 90 },
        action_type: 'notify', action_config: {}, cooldown_seconds: 300,
      },
      {
        name: 'Notify on high memory', description: 'Send notification when memory exceeds 90%',
        trigger_type: 'mem_high', trigger_config: { threshold: 90 },
        action_type: 'notify', action_config: {}, cooldown_seconds: 300,
      },
      {
        name: 'Stop on crash loop', description: 'Stop container if it restarts more than 5 times',
        trigger_type: 'container_restart_loop', trigger_config: { max_restarts: 5 },
        action_type: 'stop', action_config: {}, cooldown_seconds: 600,
      },
      {
        name: 'Alert on unhealthy', description: 'Notify when health check fails',
        trigger_type: 'container_unhealthy', trigger_config: {},
        action_type: 'notify', action_config: {}, cooldown_seconds: 300,
      },
    ];
  }
}

module.exports = new WorkflowService();
