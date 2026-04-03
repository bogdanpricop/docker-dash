'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger')('ssl');

const CERTS_DIR = process.env.CERTS_DIR || '/data/certs';

/**
 * Ensure certs directory exists
 */
function ensureCertsDir() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }
}

/**
 * Get current SSL status
 */
function getStatus() {
  ensureCertsDir();

  const certPath = path.join(CERTS_DIR, 'server.crt');
  const keyPath = path.join(CERTS_DIR, 'server.key');
  const caddyfilePath = path.join(CERTS_DIR, 'Caddyfile');

  const hasCert = fs.existsSync(certPath);
  const hasKey = fs.existsSync(keyPath);
  const hasCaddyfile = fs.existsSync(caddyfilePath);

  let certInfo = null;
  if (hasCert) {
    try {
      const output = execFileSync('openssl', [
        'x509', '-in', certPath, '-noout',
        '-subject', '-issuer', '-dates', '-fingerprint'
      ], { encoding: 'utf8', timeout: 5000 });

      const lines = output.split('\n');
      certInfo = {};
      for (const line of lines) {
        if (line.startsWith('subject=')) certInfo.subject = line.substring(8).trim();
        if (line.startsWith('issuer=')) certInfo.issuer = line.substring(7).trim();
        if (line.startsWith('notBefore=')) certInfo.notBefore = line.substring(10).trim();
        if (line.startsWith('notAfter=')) certInfo.notAfter = line.substring(9).trim();
        if (line.includes('Fingerprint=')) certInfo.fingerprint = line.split('=').slice(1).join('=').trim();
      }

      // Check if self-signed
      certInfo.selfSigned = certInfo.subject === certInfo.issuer;

      // Parse expiry
      if (certInfo.notAfter) {
        const expiry = new Date(certInfo.notAfter);
        certInfo.expiresAt = expiry.toISOString();
        certInfo.daysUntilExpiry = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
        certInfo.expired = certInfo.daysUntilExpiry < 0;
      }
    } catch (err) {
      log.warn('Cannot read certificate info (openssl not available?)', err.message);
      certInfo = { error: 'Cannot read certificate — openssl not available' };
    }
  }

  let caddyfileContent = null;
  if (hasCaddyfile) {
    try { caddyfileContent = fs.readFileSync(caddyfilePath, 'utf8'); } catch { /* ignore */ }
  }

  // Determine mode
  let mode = 'none';
  if (hasCaddyfile) mode = 'caddy';
  else if (hasCert && hasKey) mode = 'self-signed';

  return {
    mode,
    hasCert,
    hasKey,
    hasCaddyfile,
    certInfo,
    caddyfileContent,
    certsDir: CERTS_DIR,
  };
}

/**
 * Generate a self-signed certificate using openssl
 */
function generateSelfSigned(domain) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('Domain is required');
  }

  // Sanitize domain
  const safeDomain = domain.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeDomain) throw new Error('Invalid domain');

  ensureCertsDir();

  const certPath = path.join(CERTS_DIR, 'server.crt');
  const keyPath = path.join(CERTS_DIR, 'server.key');

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '365',
      '-nodes',
      '-subj', `/CN=${safeDomain}/O=Docker Dash/C=US`,
      '-addext', `subjectAltName=DNS:${safeDomain},DNS:localhost,IP:127.0.0.1`
    ], { encoding: 'utf8', timeout: 30000 });

    log.info(`Self-signed certificate generated for ${safeDomain}`);

    return {
      certPath,
      keyPath,
      domain: safeDomain,
      expiresIn: '365 days',
    };
  } catch (err) {
    log.error('Failed to generate self-signed certificate', err.message);
    throw new Error('Failed to generate certificate. Is openssl installed? ' + (err.stderr || err.message));
  }
}

/**
 * Save or update Caddyfile for reverse proxy with auto-TLS
 */
function saveCaddyfile(domain, upstreamPort) {
  if (!domain) throw new Error('Domain is required');

  const safeDomain = domain.replace(/[^a-zA-Z0-9._-]/g, '');
  const port = parseInt(upstreamPort) || 8101;

  ensureCertsDir();

  const content = `${safeDomain} {
  reverse_proxy docker-dash:${port}

  # Automatic HTTPS via Let's Encrypt
  # Caddy handles certificate issuance and renewal automatically

  header {
    # Security headers
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
  }

  log {
    output file /data/caddy/access.log
    format json
  }
}
`;

  const caddyfilePath = path.join(CERTS_DIR, 'Caddyfile');
  fs.writeFileSync(caddyfilePath, content, 'utf8');

  log.info(`Caddyfile saved for domain ${safeDomain}`);

  return {
    path: caddyfilePath,
    domain: safeDomain,
    content,
  };
}

/**
 * Read certificate file contents (for download)
 */
function readCert(filename) {
  const allowed = ['server.crt', 'server.key'];
  if (!allowed.includes(filename)) throw new Error('Invalid filename');

  const filePath = path.join(CERTS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error('File not found');

  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Remove SSL configuration
 */
function removeSsl() {
  ensureCertsDir();
  const files = ['server.crt', 'server.key', 'Caddyfile'];
  for (const f of files) {
    const fp = path.join(CERTS_DIR, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  log.info('SSL configuration removed');
}

module.exports = {
  getStatus,
  generateSelfSigned,
  saveCaddyfile,
  readCert,
  removeSsl,
};
