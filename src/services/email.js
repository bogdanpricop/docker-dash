'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const log = require('../utils/logger')('email');

class EmailService {
  constructor() {
    this._transporter = null;
  }

  _getTransporter() {
    if (this._transporter) return this._transporter;

    const opts = {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      tls: { rejectUnauthorized: false },
    };

    // Only add auth if user is set
    if (config.smtp.user) {
      opts.auth = {
        user: config.smtp.user,
        pass: config.smtp.password || '',
      };
    }

    this._transporter = nodemailer.createTransport(opts);
    return this._transporter;
  }

  async send({ to, subject, html }) {
    const transporter = this._getTransporter();
    const from = config.smtp.fromName
      ? `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`
      : config.smtp.fromEmail;

    try {
      const info = await transporter.sendMail({ from, to, subject, html });
      log.info('Email sent', { to, subject, messageId: info.messageId });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      log.error('Email send failed', { to, subject, error: err.message });
      throw err;
    }
  }

  // ─── Password Reset Email ─────────────────────────────
  async sendPasswordReset({ to, username, resetUrl, lang = 'en' }) {
    const isRo = lang === 'ro';
    const appName = config.app.name;

    const subject = isRo
      ? `${appName} — Resetare parola`
      : `${appName} — Password Reset`;

    const html = this._wrapTemplate(`
      <h2 style="color:#388bfd;margin:0 0 16px">${isRo ? 'Resetare Parola' : 'Password Reset'}</h2>
      <p>${isRo
        ? `Buna ziua, <strong>${this._esc(username)}</strong>,`
        : `Hello, <strong>${this._esc(username)}</strong>,`}</p>
      <p>${isRo
        ? 'Am primit o cerere de resetare a parolei pentru contul dumneavoastra.'
        : 'We received a request to reset the password for your account.'}</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${this._esc(resetUrl)}" style="display:inline-block;background:#388bfd;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">
          ${isRo ? 'Reseteaza Parola' : 'Reset Password'}
        </a>
      </div>
      <p style="color:#f85149;font-weight:600">${isRo
        ? 'Acest link este valabil doar 15 minute.'
        : 'This link is valid for 15 minutes only.'}</p>
      <p style="font-size:13px;color:#888">${isRo
        ? 'Daca nu ati solicitat aceasta resetare, ignorati acest email.'
        : 'If you did not request this reset, please ignore this email.'}</p>
    `, appName);

    return this.send({ to, subject, html });
  }

  // ─── Invitation Email ─────────────────────────────────
  async sendInvitation({ to, username, inviteUrl, invitedBy, lang = 'en' }) {
    const isRo = lang === 'ro';
    const appName = config.app.name;
    const appUrl = config.app.publicUrl || config.app.baseUrl;

    const subject = isRo
      ? `${appName} — Invitatie de acces`
      : `${appName} — Access Invitation`;

    const html = this._wrapTemplate(`
      <h2 style="color:#388bfd;margin:0 0 16px">${isRo ? 'Invitatie de Acces' : 'Access Invitation'}</h2>
      <p>${isRo
        ? `Buna ziua,`
        : `Hello,`}</p>
      <p>${isRo
        ? `<strong>${this._esc(invitedBy)}</strong> va invita sa accesati <strong>${this._esc(appName)}</strong> — un dashboard de management Docker ce ofera monitorizare containere, imagini, retele si volume intr-o interfata web moderna.`
        : `<strong>${this._esc(invitedBy)}</strong> has invited you to access <strong>${this._esc(appName)}</strong> — a Docker management dashboard that provides container monitoring, images, networks and volumes management through a modern web interface.`}</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#0d1117;border-radius:8px;overflow:hidden">
        <tr><td style="padding:10px 16px;color:#8b949e;border-bottom:1px solid #21262d;width:120px">${isRo ? 'Utilizator' : 'Username'}</td><td style="padding:10px 16px;color:#e6edf3;font-weight:600;border-bottom:1px solid #21262d;font-family:monospace">${this._esc(username)}</td></tr>
        <tr><td style="padding:10px 16px;color:#8b949e;width:120px">${isRo ? 'Aplicatie' : 'Application'}</td><td style="padding:10px 16px;color:#e6edf3">${this._esc(appName)}</td></tr>
      </table>
      <div style="text-align:center;margin:28px 0">
        <a href="${this._esc(inviteUrl)}" style="display:inline-block;background:#388bfd;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">
          ${isRo ? 'Seteaza Parola si Acceseaza' : 'Set Password & Access'}
        </a>
      </div>
      <p style="color:#d29922;font-weight:600">${isRo
        ? 'Acest link de invitatie este valabil 24 de ore.'
        : 'This invitation link is valid for 24 hours.'}</p>
      <p style="font-size:13px;color:#888">${isRo
        ? `Dupa setarea parolei, puteti accesa aplicatia la: <a href="${this._esc(appUrl)}" style="color:#388bfd">${this._esc(appUrl)}</a>`
        : `After setting your password, you can access the application at: <a href="${this._esc(appUrl)}" style="color:#388bfd">${this._esc(appUrl)}</a>`}</p>
    `, appName);

    return this.send({ to, subject, html });
  }

  // ─── HTML Template Wrapper ────────────────────────────
  _wrapTemplate(content, appName) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#06090f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <div style="text-align:center;margin-bottom:28px">
    <span style="font-size:36px">&#x1F433;</span>
    <h1 style="color:#e6edf3;font-size:22px;margin:8px 0 0">${this._esc(appName)}</h1>
  </div>
  <div style="background:#161b22;border:1px solid rgba(48,54,61,0.6);border-radius:12px;padding:28px 24px;color:#b1bac4;line-height:1.6">
    ${content}
  </div>
  <div style="text-align:center;margin-top:24px;font-size:11px;color:#545d68">
    ${this._esc(appName)} &mdash; Docker Management Dashboard
  </div>
</div>
</body>
</html>`;
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

module.exports = new EmailService();
