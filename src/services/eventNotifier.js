'use strict';

const { getDb } = require('../db');
const log = require('../utils/logger')('event-notifier');

// Events that trigger notifications
const NOTIFY_EVENTS = {
  'container:die':        { severity: 'critical', title: 'Container Crashed', icon: '💀' },
  'container:oom':        { severity: 'critical', title: 'Container OOM Killed', icon: '🔴' },
  'container:kill':       { severity: 'warning',  title: 'Container Killed', icon: '⚠️' },
  'container:stop':       { severity: 'info',     title: 'Container Stopped', icon: 'ℹ️' },
  'container:start':      { severity: 'info',     title: 'Container Started', icon: '✅' },
  'container:health_status: unhealthy': { severity: 'warning', title: 'Health Check Failed', icon: '🏥' },
  'image:pull':           { severity: 'info',     title: 'Image Pulled', icon: '📥' },
  'image:delete':         { severity: 'info',     title: 'Image Deleted', icon: '🗑️' },
};

// Cooldown: don't spam the same event for the same container
const cooldowns = new Map(); // key → timestamp
const COOLDOWN_MS = 60000; // 1 minute

class EventNotifier {
  constructor() {
    this._enabled = false;
    this._settings = null;
  }

  /**
   * Process a Docker event and send notifications if configured.
   * Called from the WebSocket event stream handler.
   */
  async processEvent(event) {
    try {
      const eventKey = `${event.type}:${event.action}`;
      const config = NOTIFY_EVENTS[eventKey];
      if (!config) return; // Not a notifiable event

      // Check if event notifications are enabled
      if (!this._isEnabled()) return;

      // Cooldown check
      const cooldownKey = `${eventKey}:${event.actorName || event.actorId}`;
      const lastNotified = cooldowns.get(cooldownKey);
      if (lastNotified && Date.now() - lastNotified < COOLDOWN_MS) return;
      cooldowns.set(cooldownKey, Date.now());

      // Build notification message
      const containerName = event.actorName || event.actorId?.substring(0, 12) || 'unknown';
      const hostInfo = event.hostName && event.hostName !== 'Local' ? ` (${event.hostName})` : '';
      const exitCode = event.attributes?.exitCode;
      const exitInfo = exitCode ? ` — exit code ${exitCode}` : '';

      const message = {
        title: `${config.icon} ${config.title}`,
        text: `**${containerName}**${hostInfo}${exitInfo}`,
        severity: config.severity,
        event: eventKey,
      };

      // Special messages for specific events
      if (event.action === 'die' && exitCode === '137') {
        message.text += '\nKilled by OOM killer or `docker kill`. Check memory limits.';
      } else if (event.action === 'die' && exitCode === '1') {
        message.text += '\nApplication error. Check container logs for details.';
      } else if (event.action === 'die' && exitCode === '0') {
        message.severity = 'info';
        message.title = `${config.icon} Container Exited (clean)`;
        message.text = `**${containerName}**${hostInfo} exited normally (code 0)`;
      }

      // Send to all active notification channels
      const channelService = require('./notificationChannels');
      await channelService.sendToAll(message);

      log.debug('Event notification sent', { event: eventKey, container: containerName });
    } catch (err) {
      log.error('Event notification failed', { error: err.message });
    }
  }

  /**
   * Also evaluate workflow rules on events.
   */
  async evaluateWorkflows(event, statsData) {
    try {
      const workflowService = require('./workflows');
      // Map event to stats-like data for workflow evaluation
      const eventStats = statsData || [{
        container_name: event.actorName || '',
        container_id: event.actorId || '',
        state: event.action === 'die' ? 'exited' : event.action === 'start' ? 'running' : event.action,
        exit_code: parseInt(event.attributes?.exitCode) || 0,
        health: event.action === 'health_status: unhealthy' ? 'unhealthy' : undefined,
        host_id: event.hostId || 0,
        cpu_percent: 0,
        mem_percent: 0,
      }];
      await workflowService.evaluate(eventStats);
    } catch (err) {
      log.error('Workflow evaluation on event failed', { error: err.message });
    }
  }

  _isEnabled() {
    // Check if any notification channels exist and are active
    try {
      const db = getDb();
      const count = db.prepare('SELECT COUNT(*) AS cnt FROM notification_channels WHERE is_active = 1').get()?.cnt || 0;
      return count > 0;
    } catch {
      return false;
    }
  }
}

module.exports = new EventNotifier();
