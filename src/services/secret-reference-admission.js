'use strict';

const crypto = require('crypto');

const MAX_DOCUMENT_BYTES = 256 * 1024;
const DOCUMENT_KINDS = new Set(['manifest', 'job', 'template']);
const MANAGER_REFERENCE = /^(?:vault|keyvault|azurekv|secretsmanager|aws-sm|1password|op|env):\/\/[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,497}$/;
const SYMBOLIC_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SECRET_KEY = /password|passphrase|secret|token|credential|private.?key|authorization|cookie|api.?key|tls.?key/i;
const REFERENCE_KEY = /(?:ref|reference)$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const CREDENTIAL_URL = /:\/\/[^\s/:]+:[^\s/@]+@/;
const ENVIRONMENT_ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const KUBERNETES_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const STRUCTURAL_SECRET_KEYS = new Set(['secrets', 'imagepullsecrets']);

class SecretReferenceAdmissionError extends Error {
  constructor(message, code = 'INVALID_SECRET_REFERENCE_DOCUMENT', status = 400, details = null) {
    super(message); this.name = 'SecretReferenceAdmissionError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function finding(path, code, message) {
  return { path: String(path || '<document>').slice(0, 300), code, message };
}

function normalizedReference(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (MANAGER_REFERENCE.test(trimmed)) return trimmed;
  const symbolic = trimmed.match(SYMBOLIC_ENV_REFERENCE);
  return symbolic ? `env://${symbolic[1]}` : null;
}

function kubernetesReference(key, value) {
  const lower = key.toLowerCase();
  if (lower === 'secretname' && typeof value === 'string' && KUBERNETES_NAME.test(value)) {
    return canonical({ secretName: value });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (lower === 'secretkeyref' && KUBERNETES_NAME.test(String(value.name || ''))
    && KUBERNETES_NAME.test(String(value.key || ''))) {
    return canonical({ secretKeyRef: { name: value.name, key: value.key } });
  }
  if (lower === 'secretref' && KUBERNETES_NAME.test(String(value.name || ''))) {
    return canonical({ secretRef: { name: value.name } });
  }
  return null;
}

function inspectDocument(document) {
  const findings = []; const references = [];
  const addReference = value => { if (value) references.push(value); };
  const addFinding = (path, code, message) => findings.push(finding(path, code, message));

  function visitStructuralSecrets(value, path) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const name = typeof item === 'string' ? item : item?.source || item?.name;
        if (typeof name === 'string' && KUBERNETES_NAME.test(name)) {
          addReference(canonical({ namedSecret: name }));
        }
        if (item && typeof item === 'object') visit(item, `${path}[${index}]`);
      });
      return;
    }
    if (!value || typeof value !== 'object') {
      addFinding(path, 'INVALID_SECRET_REFERENCE', 'Secret collections must contain named references');
      return;
    }
    for (const [name, definition] of Object.entries(value)) {
      if (KUBERNETES_NAME.test(name)) addReference(canonical({ namedSecret: name }));
      else addFinding(`${path}.${name}`, 'INVALID_SECRET_REFERENCE', 'Secret reference names are invalid');
      visit(definition, `${path}.${name}`);
    }
  }

  function visit(value, path) {
    if (typeof value === 'string') {
      if (PRIVATE_KEY.test(value)) addFinding(path, 'INLINE_PRIVATE_KEY', 'Inline private-key material is forbidden');
      if (CREDENTIAL_URL.test(value)) addFinding(path, 'CREDENTIAL_URL', 'Credential-bearing URLs are forbidden');
      const assignment = value.match(ENVIRONMENT_ASSIGNMENT);
      if (assignment && SECRET_KEY.test(assignment[1])) {
        const reference = normalizedReference(assignment[2]);
        if (reference) addReference(reference);
        else if (assignment[2] !== '') addFinding(path, 'INLINE_SECRET_VALUE',
          'Secret environment variables must use symbolic references');
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;

    if (typeof value.name === 'string' && SECRET_KEY.test(value.name) && Object.hasOwn(value, 'value')) {
      const reference = normalizedReference(value.value);
      if (reference) addReference(reference);
      else addFinding(`${path}.value`, 'INLINE_SECRET_VALUE', 'Secret-named entries must use symbolic references');
    }

    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();
      if (STRUCTURAL_SECRET_KEYS.has(lowerKey)) {
        visitStructuralSecrets(child, childPath); continue;
      }
      if (SECRET_KEY.test(key)) {
        const directReference = normalizedReference(child) || kubernetesReference(key, child);
        if (directReference) addReference(directReference);
        else if (REFERENCE_KEY.test(key) || lowerKey === 'secretname') addFinding(childPath,
          'INVALID_SECRET_REFERENCE', 'Secret references must use an approved manager, environment or Kubernetes reference');
        else addFinding(childPath, 'INLINE_SECRET_FIELD',
          'Secret-bearing fields must be replaced by symbolic references');
      }
      visit(child, childPath);
    }
  }

  visit(document, '');
  return {
    findings: [...new Map(findings.map(item => [`${item.path}:${item.code}`, item])).values()],
    references: [...new Set(references)],
  };
}

function inspectSecretReferences(input = {}) {
  const documentKind = String(input.documentKind || '');
  if (!DOCUMENT_KINDS.has(documentKind)) throw new SecretReferenceAdmissionError('Document kind is invalid');
  const document = input.document;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new SecretReferenceAdmissionError('Document must be an object');
  }
  let serialized;
  try { serialized = JSON.stringify(document); } catch { /* handled below */ }
  if (!serialized || Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES) throw new SecretReferenceAdmissionError(
    'Document is too large or not JSON serializable', 'INVALID_SECRET_REFERENCE_DOCUMENT', 413);
  const documentHash = digest(canonical(document)); const inspection = inspectDocument(document);
  const referenceHashes = inspection.references.map(reference => digest(reference)).sort();
  return { documentKind, documentHash, state: inspection.findings.length ? 'invalid' : 'valid',
    referenceCount: referenceHashes.length, referenceHashes, findings: inspection.findings,
    networkCallsStarted: 0, documentStored: false };
}

function assertSecretReferenceAdmission(input = {}) {
  const result = inspectSecretReferences(input);
  if (result.state === 'invalid') throw new SecretReferenceAdmissionError(
    'Inline secret material is forbidden; use approved symbolic references',
    'SECRET_REFERENCE_ADMISSION_FAILED', 422, result);
  return result;
}

module.exports = { SecretReferenceAdmissionError, inspectSecretReferences, assertSecretReferenceAdmission,
  _internals: { canonical, normalizedReference, inspectDocument } };
