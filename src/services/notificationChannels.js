'use strict';

const { getDb } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('notify');

/**
 * Notification channel providers.
 * Each provider sends messages via HTTP POST to the respective service API.
 */
const providers = {
  async discord(config, message) {
    const body = {
      content: message.text,
      embeds: message.embed ? [{
        title: message.title || 'Docker Dash Alert',
        description: message.text,
        color: message.severity === 'critical' ? 0xf85149 : message.severity === 'warning' ? 0xd29922 : 0x3fb950,
        timestamp: new Date().toISOString(),
      }] : undefined,
    };
    await _post(config.webhook_url, body);
  },

  async slack(config, message) {
    const body = {
      text: message.text,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*${message.title || 'Docker Dash'}*\n${message.text}` },
      }],
    };
    await _post(config.webhook_url, body);
  },

  async telegram(config, message) {
    const url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
    await _post(url, {
      chat_id: config.chat_id,
      text: `*${message.title || 'Docker Dash'}*\n${message.text}`,
      parse_mode: 'Markdown',
    });
  },

  async ntfy(config, message) {
    const url = `${config.server_url || 'https://ntfy.sh'}/${config.topic}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Title': message.title || 'Docker Dash Alert',
        'Priority': message.severity === 'critical' ? '5' : message.severity === 'warning' ? '3' : '2',
        'Tags': message.severity === 'critical' ? 'rotating_light' : 'whale',
        ...(config.token ? { 'Authorization': `Bearer ${config.token}` } : {}),
      },
      body: message.text,
    });
    if (!res.ok) throw new Error(`ntfy: ${res.status}`);
  },

  async gotify(config, message) {
    const url = `${config.server_url}/message?token=${config.app_token}`;
    await _post(url, {
      title: message.title || 'Docker Dash Alert',
      message: message.text,
      priority: message.severity === 'critical' ? 8 : message.severity === 'warning' ? 5 : 2,
    });
  },

  async email(config, message) {
    // Delegate to existing email service
    const emailService = require('./email');
    await emailService.send({
      to: config.to,
      subject: message.title || 'Docker Dash Alert',
      html: `<p>${message.text.replace(/\n/g, '<br>')}</p>`,
    });
  },

  async webhook(config, message) {
    // Generic webhook — same format as existing outgoing webhooks
    await _post(config.url, {
      event: message.event || 'alert',
      timestamp: new Date().toISOString(),
      data: message,
    });
  },
};

async function _post(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

class NotificationChannelService {
  // ─── Channel CRUD ────────────────────────────────

  list() {
    const db = getDb();
    return db.prepare('SELECT * FROM notification_channels ORDER BY name').all().map(r => ({
      ...r,
      config: this._maskConfig(r.provider, JSON.parse(r.config_encrypted ? decrypt(r.config_encrypted) : '{}')),
    }));
  }

  get(id) {
    return getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
  }

  create({ name, provider, config, created_by }) {
    if (!name || !provider) throw new Error('name and provider are required');
    if (!providers[provider]) throw new Error(`Unknown provider: ${provider}. Supported: ${Object.keys(providers).join(', ')}`);

    const db = getDb();
    const r = db.prepare(`
      INSERT INTO notification_channels (name, provider, config_encrypted, is_active, created_by)
      VALUES (?, ?, ?, 1, ?)
    `).run(name, provider, encrypt(JSON.stringify(config)), created_by);

    log.info('Channel created', { id: r.lastInsertRowid, name, provider });
    return { id: Number(r.lastInsertRowid), name, provider };
  }

  update(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }
    if (data.config !== undefined) {
      sets.push('config_encrypted = ?');
      params.push(encrypt(JSON.stringify(data.config)));
    }

    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(id);
    db.prepare(`UPDATE notification_channels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id) {
    getDb().prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
  }

  // ─── Send ────────────────────────────────────────

  async send(channelId, message) {
    const channel = this.get(channelId);
    if (!channel) throw new Error('Channel not found');
    if (!channel.is_active) return;

    const config = JSON.parse(decrypt(channel.config_encrypted));
    const provider = providers[channel.provider];
    if (!provider) throw new Error(`Unknown provider: ${channel.provider}`);

    try {
      await provider(config, message);
      log.debug('Notification sent', { channelId, provider: channel.provider });
    } catch (err) {
      log.error('Notification failed', { channelId, provider: channel.provider, error: err.message });
      throw err;
    }
  }

  async sendToAll(message) {
    const db = getDb();
    const channels = db.prepare('SELECT * FROM notification_channels WHERE is_active = 1').all();

    for (const channel of channels) {
      try {
        const config = JSON.parse(decrypt(channel.config_encrypted));
        const provider = providers[channel.provider];
        if (provider) await provider(config, message);
      } catch (err) {
        log.error('Notification failed', { channelId: channel.id, error: err.message });
      }
    }
  }

  async test(id) {
    return this.send(id, {
      title: 'Docker Dash — Test Notification',
      text: 'If you see this, your notification channel is configured correctly!',
      severity: 'info',
      event: 'test',
    });
  }

  // ─── Helpers ─────────────────────────────────────

  _maskConfig(provider, config) {
    const masked = { ...config };
    // Mask sensitive fields
    if (masked.bot_token) masked.bot_token = masked.bot_token.substring(0, 8) + '...';
    if (masked.app_token) masked.app_token = masked.app_token.substring(0, 8) + '...';
    if (masked.token) masked.token = masked.token.substring(0, 8) + '...';
    if (masked.webhook_url) {
      try {
        const u = new URL(masked.webhook_url);
        masked.webhook_url = u.origin + '/...' + u.pathname.slice(-8);
      } catch {}
    }
    return masked;
  }

  getProviders() {
    return [
      { id: 'discord', name: 'Discord', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true }] },
      { id: 'slack', name: 'Slack', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true }] },
      { id: 'telegram', name: 'Telegram', fields: [
        { key: 'bot_token', label: 'Bot Token', type: 'password', required: true },
        { key: 'chat_id', label: 'Chat ID', type: 'text', required: true },
      ]},
      { id: 'ntfy', name: 'Ntfy', fields: [
        { key: 'server_url', label: 'Server URL', type: 'url', placeholder: 'https://ntfy.sh' },
        { key: 'topic', label: 'Topic', type: 'text', required: true },
        { key: 'token', label: 'Access Token', type: 'password' },
      ]},
      { id: 'gotify', name: 'Gotify', fields: [
        { key: 'server_url', label: 'Server URL', type: 'url', required: true },
        { key: 'app_token', label: 'App Token', type: 'password', required: true },
      ]},
      { id: 'email', name: 'Email (SMTP)', fields: [
        { key: 'to', label: 'Recipient Email', type: 'email', required: true },
      ]},
      { id: 'webhook', name: 'Custom Webhook', fields: [
        { key: 'url', label: 'Webhook URL', type: 'url', required: true },
      ]},
    ];
  }
}

module.exports = new NotificationChannelService();
