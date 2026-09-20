'use strict';

const page = require('../../public/js/pages/network-posture');

describe('Network posture presentation helpers', () => {
  it('keeps missing posture evidence secondary', () => {
    expect(page._badge('unknown')).toBe('badge-secondary');
  });

  it('renders route and isolation as assessment limits rather than guarantees', () => {
    global.Utils = { escapeHtml: value => String(value) };
    const html = page._resultHtml({ provider: { type: 'vsphere' }, summary: { state: 'unknown', networkCount: 0, states: {} }, networks: [], limitations: ['Routing is not tested'] });
    expect(html).toContain('Assessment limits');
    expect(html).toContain('Routing is not tested');
  });

  it('labels network policy results as read-only and non-persistent', () => {
    global.Utils = { escapeHtml: value => String(value) };
    const html = page._policyHtml({ policy: { minMtu: 1500, requireManaged: true, requireVlan: true }, summary: { compliantCount: 1, noncompliantCount: 2, unknownCount: 3 } });
    expect(html).toContain('Network policy compliance');
    expect(html).toContain('This policy is not persisted.');
    expect(html).toContain('Noncompliant');
  });

  it('summarizes existing evidence and makes unavailable sources explicit', () => {
    global.Utils = { escapeHtml: value => String(value) };
    const html = page._evidenceDashboardHtml({
      posture: { summary: { networkCount: 2 } },
      topology: { summary: { attachmentCount: 3 } },
      ips: { summary: { addressCount: 4 } },
      conflicts: { summary: { candidateCount: 1 } },
      readiness: { summary: { readyCount: 2 } },
      transport: { state: 'observed_reachable' },
      policy: { error: new Error('unavailable') },
    });
    expect(html).toContain('Consolidated network evidence');
    expect(html).toContain('1 source unavailable');
    expect(html).toContain('observed_reachable');
    expect(html).toContain('does not prove connectivity');
  });

  it('runs the explicit admin-only provider evidence capture and reports bounded results', async () => {
    global.App = { user: { role: 'admin' } };
    global.Api = { captureProviderNetworkEvidence: jest.fn(async () => ({
      summary: { captured: 2, notObserved: 1 },
    })) };
    global.Toast = { success: jest.fn(), error: jest.fn() };
    page._hostId = 7; page._load = jest.fn(async () => {});
    const button = { disabled: false };
    await page._captureEvidence(button);
    expect(global.Api.captureProviderNetworkEvidence).toHaveBeenCalledWith(7);
    expect(global.Toast.success).toHaveBeenCalledWith('Provider evidence captured: 2; not observed: 1');
    expect(page._load).toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });
});
