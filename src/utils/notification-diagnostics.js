'use strict';

const networkReasons = {
  ABORT_ERR: 'The provider request timed out.',
  ETIMEDOUT: 'The provider request timed out.',
  UND_ERR_CONNECT_TIMEOUT: 'The connection to the provider timed out.',
  UND_ERR_HEADERS_TIMEOUT: 'The provider did not respond in time.',
  UND_ERR_BODY_TIMEOUT: 'The provider response timed out.',
  ECONNREFUSED: 'The provider refused the connection.',
  ECONNRESET: 'The connection was reset.',
  ENETUNREACH: 'The provider network is unreachable.',
  EHOSTUNREACH: 'The provider host is unreachable.',
  ENOTFOUND: 'The provider hostname could not be resolved.',
  EAI_AGAIN: 'DNS resolution failed temporarily.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'The TLS certificate does not match the hostname.',
  CERT_HAS_EXPIRED: 'The TLS certificate has expired.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The TLS certificate is self-signed.',
  SELF_SIGNED_CERT_IN_CHAIN: 'The TLS certificate chain contains an untrusted certificate.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The TLS certificate chain could not be verified.',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'The TLS certificate issuer could not be verified.',
  ERR_SSL_WRONG_VERSION_NUMBER: 'The server did not start the expected TLS session.',
  ERR_INVALID_URL: 'The configured provider URL is invalid.',
};

function networkDiagnostic(error) {
  const cause = error?.cause;
  const codes = [error?.originalCode, error?.code, cause?.code, cause?.errors?.[0]?.code];
  const code = codes.find(value => typeof value === 'string' && Object.hasOwn(networkReasons, value));
  if (code) return { code, reason: networkReasons[code] };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: 'ETIMEDOUT', reason: networkReasons.ETIMEDOUT };
  }
  return {};
}

function safeProviderText(value, sensitive = []) {
  if (typeof value !== 'string') return undefined;
  // Refuse unusually long responses before redaction, so no partial secret
  // at a truncation boundary can escape the known-value replacements.
  if (value.length > 4096) return undefined;
  let text = value;
  const secrets = new Set();
  for (const value of sensitive) {
    if (typeof value !== 'string' || !value.trim()) continue;
    secrets.add(value);
    secrets.add(value.trim());
    secrets.add(encodeURIComponent(value.toWellFormed()));
    secrets.add(Buffer.from(value).toString('base64'));
    // Webhook URLs carry credentials in the path and query even without
    // HTTP userinfo. Servers sometimes echo just those pieces.
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        for (const part of [url.username, url.password, ...url.searchParams.values(), ...url.pathname.split('/').filter(part => part.length >= 8)]) {
          if (part) {
            secrets.add(part);
            secrets.add(encodeURIComponent(part.toWellFormed()));
            try { secrets.add(decodeURIComponent(part)); } catch { /* malformed percent encoding */ }
          }
        }
      } catch { /* invalid URLs are already covered by the exact replacement */ }
    }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[redacted]');
  return text
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*[^\r\n]*/gi, '[redacted]')
    .replace(/\b(?:password|passphrase|secret|(?:(?:access|bot|api)[-_ ]?)?token|api[-_ ]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted]')
    .replace(/\b[^\s<>"',;@]+@[^\s<>"',;@]+/g, '[redacted]')
    .replace(/[a-z0-9_+./=-]{32,}/gi, '[redacted]')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim().slice(0, 500) || undefined;
}

module.exports = { networkDiagnostic, safeProviderText };
