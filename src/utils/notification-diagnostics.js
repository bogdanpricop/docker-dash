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

const httpReasons = {
  400: 'The provider rejected the test request. Check the channel configuration.',
  401: 'The provider rejected the credentials. Check the token or webhook URL.',
  403: 'The provider denied access. Check the permissions for the target.',
  404: 'The target was not found. Check the webhook, topic or chat configuration.',
  410: 'The target is gone. Check whether it has been removed or replaced.',
  429: 'The provider is rate limiting requests. Wait before testing again.',
};

function httpDiagnostic(status, retryAfter, now = Date.now()) {
  const details = { httpStatus: status, reason: httpReasons[status] };
  if (status >= 500) details.reason = 'The provider encountered a server error.';
  if ((status === 429 || status === 503) && retryAfter) {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - now) / 1000);
    if (Number.isSafeInteger(seconds) && seconds >= 0) details.retryAfterSeconds = seconds;
  }
  return details;
}

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
  const secrets = new Map();
  const addSecret = (secret, pathWord = false) => {
    if (!secret) return;
    const encoded = Buffer.from(secret);
    for (const form of [secret, encodeURIComponent(secret.toWellFormed()), JSON.stringify(secret).slice(1, -1),
      encoded.toString('base64'), encoded.toString('base64url')]) {
      secrets.set(form, pathWord && secrets.get(form) !== false);
    }
  };
  for (const value of sensitive) {
    if (typeof value !== 'string' || !value.trim()) continue;
    addSecret(value);
    addSecret(value.trim());
    // Webhook URLs carry credentials in the path and query even without
    // HTTP userinfo. Servers sometimes echo just those pieces.
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        for (const part of [url.username, url.password, ...url.searchParams.values()]) {
          addSecret(part);
          try { addSecret(decodeURIComponent(part)); } catch { /* malformed percent encoding */ }
        }
        for (const part of url.pathname.split('/').filter(part => part.length >= 3)) {
          const pathWord = /^[a-z0-9]{3,7}$/i.test(part);
          addSecret(part, pathWord);
          try { addSecret(decodeURIComponent(part), pathWord); } catch { /* malformed percent encoding */ }
        }
      } catch { /* invalid URLs are already covered by the exact replacement */ }
    }
  }
  const matches = [...secrets.keys()].filter(secret => text.includes(secret)).sort((a, b) => b.length - a.length);
  if (matches.length) {
    const pattern = matches.map(secret => {
      const literal = RegExp.escape(secret);
      return secrets.get(secret) ? '(?<![a-zA-Z0-9])' + literal + '(?![a-zA-Z0-9])' : literal;
    }).join('|');
    text = text.replace(new RegExp(pattern, 'g'), '[redacted]');
  }
  return text
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*[^\r\n]*/gi, '[redacted]')
    .replace(/\b(?:password|passphrase|(?:client[-_ ]?)?secret|(?:(?:access|bot|api)[-_ ]?)?token|(?:x[-_ ]?)?api[-_ ]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted]')
    .replace(/\b[^\s<>"',;@]+@[^\s<>"',;@]+/g, '[redacted]')
    .replace(/[a-z0-9_+./=-]{32,}/gi, '[redacted]')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim().slice(0, 500) || undefined;
}

module.exports = { httpDiagnostic, networkDiagnostic, safeProviderText };
