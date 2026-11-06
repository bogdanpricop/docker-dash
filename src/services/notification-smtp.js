'use strict';

const { isIP } = require('node:net');
const { smtp: serverSmtp } = require('../config');
const settings = require('./settings');
const { encrypt, decrypt } = require('../utils/crypto');

const KEY = 'notification_smtp_config';
const invalid = message => Object.assign(new Error(message), { status: 400 });

function readSettings() {
  const value = settings.get(KEY);
  return value ? JSON.parse(decrypt(value)) : { mode: 'server', external: null };
}

function publicSettings() {
  const { mode, external } = readSettings();
  return {
    mode,
    server: {
      host: serverSmtp.host, port: serverSmtp.port, secure: serverSmtp.secure,
      fromName: serverSmtp.fromName, fromEmail: serverSmtp.fromEmail,
    },
    external: external && {
      host: external.host, port: external.port, security: external.security, user: external.user,
      fromName: external.fromName, fromEmail: external.fromEmail,
      passwordConfigured: Boolean(external.password),
    },
  };
}

function text(value, label, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`Invalid ${label}`);
  }
  return value.trim();
}

function save(body, userId) {
  if (body?.mode === 'server') {
    const { external } = readSettings();
    if (external) settings.set(KEY, encrypt(JSON.stringify({ mode: 'server', external })), userId);
    return publicSettings();
  }
  if (body?.mode !== 'external') throw invalid('Select server or external SMTP');
  const host = text(body.host, 'SMTP host', 253).toLowerCase();
  if (!isIP(host) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw invalid('SMTP host must be a hostname or IP address');
  }
  const port = body.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('Invalid SMTP port');
  const security = body.security;
  if (!['starttls', 'tls', 'none'].includes(security)) throw invalid('Select STARTTLS, TLS or None');
  const user = text(body.user ?? '', 'SMTP username', 320);
  const fromName = text(body.fromName ?? '', 'sender name', 256);
  const fromEmail = text(body.fromEmail, 'sender email', 320);
  if (!/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+$/.test(fromEmail)) throw invalid('Enter a valid sender email');
  if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 1024)) {
    throw invalid('Invalid SMTP password');
  }
  if (security === 'none' && (user || body.password)) {
    throw invalid('SMTP authentication requires STARTTLS or TLS');
  }

  const previous = readSettings().external;
  const sameAccount = previous && previous.host === host && previous.port === port &&
    previous.security === security && previous.user === user;
  const password = user ? (body.password || (sameAccount ? previous.password : '')) : '';
  if (user && !password) throw invalid('Enter the password for this SMTP account');
  if (!user && body.password) throw invalid('Enter a username to use SMTP authentication');

  const external = { host, port, security, user, password, fromName, fromEmail };
  settings.set(KEY, encrypt(JSON.stringify({ mode: 'external', external })), userId);
  return publicSettings();
}

function transport() {
  const { mode, external } = readSettings();
  return mode === 'external'
    ? {
      ...external,
      secure: external.security === 'tls',
      requireTLS: external.security === 'starttls',
      ignoreTLS: external.security === 'none',
    }
    : undefined;
}

module.exports = { KEY, publicSettings, save, transport };
