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
    // v8.7.19 — ntfy uses raw fetch (not _post) because the body is plain
    // text and the headers carry the structured fields. The previous
    // implementation forgot the AbortController/timeout wrapper that
    // _post uses — a hung ntfy.sh request would block notification
    // dispatch for that channel indefinitely, AND because sendToAll
    // awaits channels serially, it would also block delivery to every
    // remaining channel for the same alert. Explicit 10s timeout to
    // match _post.
    const url = `${config.server_url || 'https://ntfy.sh'}/${config.topic}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Title': message.title || 'Docker Dash Alert',
          'Priority': message.severity === 'critical' ? '5' : message.severity === 'warning' ? '3' : '2',
          'Tags': message.severity === 'critical' ? 'rotating_light' : 'whale',
          ...(config.token ? { 'Authorization': `Bearer ${config.token}` } : {}),
        },
        body: message.text,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ntfy: ${res.status}`);
    } finally {
      clearTimeout(timeout);
    }
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
      smtp: require('./notification-smtp').transport(),
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
    const catalog = this.getProviders();
    return db.prepare('SELECT * FROM notification_channels ORDER BY name').all().map(({ config_encrypted, ...channel }) => {
      const saved = config_encrypted ? JSON.parse(decrypt(config_encrypted)) : {};
      const config = {};
      const configuredSecrets = [];
      for (const field of catalog.find(entry => entry.id === channel.provider)?.fields || []) {
        const value = saved?.[field.key];
        if (field.secret || field.type === 'password') {
          if (typeof value === 'string' && value.trim()) configuredSecrets.push(field.key);
        } else if (typeof value === 'string' ||
          (field.type === 'email' && Array.isArray(value) && value.every(item => typeof item === 'string'))) {
          config[field.key] = value;
        }
      }
      return { ...channel, config, configuredSecrets };
    });
  }

  get(id) {
    return getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
  }

  create({ name, provider, config, created_by }) {
    if (!name || !provider) throw new Error('name and provider are required');
    this._validateConfig(provider, config);

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
    const channel = this.get(id);
    if (!channel) throw Object.assign(new Error('Channel not found'), { status: 404 });
    const invalid = message => Object.assign(new Error(message), { status: 400 });
    const sets = [];
    const params = [];

    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || !data.name.trim()) throw invalid('Name is required');
      sets.push('name = ?');
      params.push(data.name.trim());
    }
    if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }
    if (data.configPatch !== undefined) {
      if (data.config !== undefined) throw invalid('Use either config or configPatch');
      if (!data.configPatch || typeof data.configPatch !== 'object' || Array.isArray(data.configPatch)) {
        throw invalid('Configuration changes must be an object');
      }
      const fields = this.getProviders().find(entry => entry.id === channel.provider)?.fields || [];
      const changes = Object.entries(data.configPatch);
      if (changes.length) {
        const config = { ...JSON.parse(decrypt(channel.config_encrypted)) };
        for (const [key, value] of changes) {
          const field = fields.find(entry => entry.key === key);
          if (!field) throw invalid('Unknown notification channel field');
          if (value === null && !field.required) delete config[key];
          else if (typeof value === 'string') config[key] = value;
          else throw invalid(`Invalid value for ${field.label}`);
        }
        this._validateConfig(channel.provider, config);
        sets.push('config_encrypted = ?');
        params.push(encrypt(JSON.stringify(config)));
      }
    }
    if (data.config !== undefined) {
      this._validateConfig(channel.provider, data.config);
      sets.push('config_encrypted = ?');
      params.push(encrypt(JSON.stringify(data.config)));
    }

    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(id);
    db.prepare(`UPDATE notification_channels SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return true;
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
    this._validateConfig(channel.provider, config);
    const provider = providers[channel.provider];

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

    // v8.7.19 — dispatch concurrently with Promise.allSettled instead of
    // serial await. Previously, a slow channel (e.g. ntfy hanging up to
    // its 10s timeout, or any provider's internal timeout firing) would
    // block every subsequent channel for the same alert from being
    // notified. With N active channels, worst-case latency was N×T_slow
    // instead of T_slow. Per-channel error isolation is preserved via the
    // inner try/catch inside the dispatch lambda. allSettled never
    // rejects, so this call cannot throw.
    await Promise.allSettled(channels.map(async (channel) => {
      try {
        const config = JSON.parse(decrypt(channel.config_encrypted));
        this._validateConfig(channel.provider, config);
        await providers[channel.provider](config, message);
      } catch (err) {
        log.error('Notification failed', { channelId: channel.id, error: err.message });
      }
    }));
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

  _validateConfig(provider, config) {
    const definition = this.getProviders().find(entry => entry.id === provider);
    const invalid = message => Object.assign(new Error(message), { status: 400 });
    if (!definition) throw invalid('Unknown notification provider');
    if (config != null && (typeof config !== 'object' || Array.isArray(config))) {
      throw invalid('Notification channel configuration must be an object');
    }
    const hasText = value => typeof value === 'string' && value.trim().length > 0;
    for (const field of definition.fields) {
      if (!field.required) continue;
      const value = config?.[field.key];
      // SMTP also accepts recipient arrays from existing API clients.
      const recipients = field.type === 'email' && Array.isArray(value) && value.length > 0 && value.every(hasText);
      if (!hasText(value) && !recipients) throw invalid(`${field.label} is required`);
    }
  }

  getProviders() {
    return [
      { id: 'discord', name: 'Discord', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true, secret: true }] },
      { id: 'slack', name: 'Slack', fields: [{ key: 'webhook_url', label: 'Webhook URL', type: 'url', required: true, secret: true }] },
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
      { id: 'email', name: 'Email (SMTP)', settings: 'smtp', fields: [
        { key: 'to', label: 'Recipient Email', type: 'email', required: true },
      ]},
      { id: 'webhook', name: 'Custom Webhook', fields: [
        { key: 'url', label: 'Webhook URL', type: 'url', required: true, secret: true },
      ]},
    ];
  }
}

module.exports = new NotificationChannelService();
