'use strict';

const { X509Certificate } = require('node:crypto');
const { checkServerIdentity } = require('node:tls');
const invalid = message => Object.assign(new Error(message), { status: 400, statusCode: 400, code: 'PROVIDER_TLS_REQUIRED' });

function secureEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x20]/.test(value)) {
    throw invalid('Provider HTTPS endpoint is required');
  }
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value); }
  catch { throw invalid('Invalid provider HTTPS endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw invalid('Provider endpoint must use HTTPS without embedded credentials or fragments');
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname) + url.search;
}

function tlsOptions(config = {}) {
  if (config.skipTlsVerify !== undefined && config.skipTlsVerify !== false) {
    throw invalid('TLS verification is required. Add a verified CA certificate and disable the legacy skipTlsVerify setting.');
  }
  const options = { rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity };
  if (config.caCert !== undefined && config.caCert !== null && config.caCert !== '') {
    const pem = config.caCert;
    if (typeof pem !== 'string' || Buffer.byteLength(pem) > 131072) throw invalid('Provider CA bundle must be PEM text of at most 128 KiB');
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (!certificates.length || certificates.length > 32 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) {
      throw invalid('Provider CA bundle must contain only PEM certificates (maximum 32)');
    }
    try { for (const certificate of certificates) new X509Certificate(certificate); }
    catch { throw invalid('Invalid provider CA certificate'); }
    options.ca = certificates.join('\n') + '\n';
  }
  return options;
}

function validateProviderConfig(type, config) {
  if ((['incus', 'lxd'].includes(type) && config.transport === 'unix') || (type === 'xen' && config.provider === 'raw')) return;
  tlsOptions(config);
  if (config.endpoint) secureEndpoint(config.endpoint);
}

module.exports = { secureEndpoint, tlsOptions, validateProviderConfig };
