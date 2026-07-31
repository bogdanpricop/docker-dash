'use strict';
const page = require('../../public/js/pages/provider-security-posture');
describe('provider security posture page', () => {
  it('labels coverage as declared evidence', () => {
    const html = page._coverageHtml({ coverage: { declaredFeatureCount: 3,
      states: { supported: 1, conditional: 1, unsupported: 1 } } });
    expect(html).toContain('Declared SDK contract evidence'); expect(html).toContain('unsupported');
  });
  it('does not imply that declared safeguards execute an operation', () => {
    const html = page._safeguardsHtml({ safeguards: {
      declaredPrivilegedFeatureCount: 2, approvalRequired: 1 } });
    expect(html).toContain('no operation is attempted'); expect(html).toContain('Four-eyes');
  });
  it('labels console data as declared safeguards', () => {
    global.Utils = { escapeHtml: value => String(value) };
    expect(page._consoleHtml({ consoleExposure: { state: 'conditional',
      singleUseToken: true } })).toContain('not proof of a live console');
  });
  it('keeps assurance evidence and confidential planning explicitly non-mutating', () => {
    global.App = { user: { role: 'viewer' } };
    global.Utils = { escapeHtml: value => String(value), timeAgo: value => value };
    const html = page._assuranceHtml({ pack: { title: 'Proxmox security', version: '1.0.0' },
      counts: { pass: 1 }, evidenceCount: 0, items: [], keyProviders: [] });
    expect(html).toContain('Absence is unknown');
    expect(html).toContain('starts no probe or provider mutation');
    expect(html).toContain('never returned by the API');
  });
  it('escapes security lifecycle evidence and labels correlation as non-mutating', () => {
    global.App = { user: { role: 'viewer' } };
    global.Utils = { escapeHtml: value => String(value).replaceAll('<', '&lt;'),
      timeAgo: value => value };
    const html = page._securityLifecycleHtml({ counts: { open: 1 }, validations: [],
      automation: { enabled: false }, certificateRotation: [], findings: [{
        id: `psfd_${'a'.repeat(26)}`, advisoryId: '<img src=x>', cveIds: ['CVE-2026-12345'],
        severity: 'high', priorityScore: 80, confidence: 'high', resourceName: '<script>',
        resourceId: `ddr_vm_${'b'.repeat(26)}`, state: 'open', exception: null,
      }] });
    expect(html).not.toContain('<img src=x>'); expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x>');
    expect(html).toContain('No advisory fetch or provider mutation is started by this view');
  });
  it('escapes privileged compliance evidence and exposes the B169-B178 safety boundaries', () => {
    global.App = { user: { id: 9, role: 'viewer' } };
    global.Utils = { escapeHtml: value => String(value).replaceAll('<', '&lt;'),
      timeAgo: value => value };
    const html = page._privilegedComplianceHtml({ counts: { activeGrants: 1, activeBreakGlass: 0,
      remoteSessions: 1, classifications: 1, mappings: 1, exports: 1 },
    governanceIntegration: { permissionCount: 10 }, ransomwarePostures: [{ score: 75, confidence: 'medium' }],
    grants: [{ id: 'ppjg_aaaaaaaaaaaaaaaaaaaaaaaaaa', scopeId: 1,
      permissionKey: '<img src=x>', state: 'active', expiresAt: '2026-08-01T00:00:00Z',
      requestedBy: 9, claimed: true }],
    breakGlass: [], classifications: [{ resourceId: '<script>alert(1)</script>',
      resourceKind: 'endpoint', classification: 'restricted',
      policy: { backup: 'immutable_encrypted_required', evidenceExport: 'hashes_only' } }] });
    expect(html).not.toContain('<img src=x>'); expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x>'); expect(html).toContain('installation-signed evidence');
    expect(html).toContain('Catalog permissions');
  });
  it('renders only the governed controls assigned to a custom role', () => {
    global.App = { user: { id: 9, role: 'viewer' } };
    global.Utils = { escapeHtml: value => String(value), timeAgo: value => value };
    const html = page._privilegedComplianceHtml({ counts: {}, grants: [], breakGlass: [],
      classifications: [], ransomwarePostures: [],
      governanceIntegration: { permissionCount: 10,
        actorPermissions: ['compliance.evidence.export'] } });
    expect(html).toContain('pc-export');
    expect(html).not.toContain('pc-classify');
    expect(html).not.toContain('pc-request-break-glass');
  });
});
