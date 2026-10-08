'use strict';

const admission = require('../services/secret-reference-admission');

describe('automatic secret-reference admission', () => {
  test('accepts manager, environment, Kubernetes and Compose references without returning raw values', () => {
    const document = {
      passwordRef: 'vault://docker-dash/database/password',
      environment: ['DATABASE_PASSWORD=${DATABASE_PASSWORD}'],
      valueFrom: { secretKeyRef: { name: 'database', key: 'password' } },
      services: { app: { secrets: ['database-password'] } },
    };
    const result = admission.inspectSecretReferences({ documentKind: 'manifest', document });
    expect(result).toMatchObject({ state: 'valid', referenceCount: 4, networkCallsStarted: 0,
      documentStored: false, documentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      referenceHashes: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]) });
    const evidence = JSON.stringify(result);
    expect(evidence).not.toContain('vault://docker-dash/database/password');
    expect(evidence).not.toContain('${DATABASE_PASSWORD}');
    expect(evidence).not.toContain('database-password');
  });

  test('rejects inline environment assignments, credential URLs and private keys with safe evidence', () => {
    const document = { environment: ['DATABASE_PASSWORD=plain-text'],
      endpoint: 'https://admin:hunter2@example.test/api',
      tlsPrivateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----' };
    const result = admission.inspectSecretReferences({ documentKind: 'job', document });
    expect(result).toMatchObject({ state: 'invalid', referenceCount: 0,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'INLINE_SECRET_VALUE' }),
        expect.objectContaining({ code: 'CREDENTIAL_URL' }),
        expect.objectContaining({ code: 'INLINE_PRIVATE_KEY' }),
      ]) });
    expect(() => admission.assertSecretReferenceAdmission({ documentKind: 'job', document }))
      .toThrow(expect.objectContaining({ code: 'SECRET_REFERENCE_ADMISSION_FAILED', status: 422,
        details: expect.objectContaining({ documentStored: false, networkCallsStarted: 0 }) }));
    const evidence = JSON.stringify(result);
    for (const secret of ['plain-text', 'hunter2', '\nsecret\n']) expect(evidence).not.toContain(secret);
  });

  test('rejects invalid document kinds and oversized documents before traversal', () => {
    expect(() => admission.inspectSecretReferences({ documentKind: 'compose', document: {} }))
      .toThrow(expect.objectContaining({ code: 'INVALID_SECRET_REFERENCE_DOCUMENT' }));
    expect(() => admission.inspectSecretReferences({ documentKind: 'template',
      document: { notes: 'x'.repeat(256 * 1024) } }))
      .toThrow(expect.objectContaining({ status: 413 }));
  });
});
