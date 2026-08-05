'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

describe('workstation fleet page contract', () => {
  test('server, API and admin navigation expose the dedicated surface', () => {
    expect(read('src/server.js')).toContain("app.use('/api/workstation-fleet'");
    const api = read('public/js/api.js');
    for (const method of ['getWorkstationFleetOverview', 'syncForemanConnection', 'inspectBootcArtifact', 'getBootcArtifactPromotions',
      'deleteForemanMapping', 'createWorkstationPlan', 'cancelWorkstationPlan', 'executeWorkstationPlan', 'reconcileWorkstationPlan']) {
      expect(api).toContain(`${method}(`);
    }
    expect(api).toContain('preflightWorkstationPlan(');
    expect(api).toContain("'/workstation-fleet'");
    expect(read('public/js/app.js')).toContain("'workstation-fleet': () => WorkstationFleetPage");
    const index = read('public/index.html');
    expect(index).toContain('href="#/workstation-fleet"');
    expect(index).toContain('/js/pages/workstation-fleet.js?v=__VERSION__');
  });

  test('page uses delegated listeners, accessible controls and explicit guardrail copy', () => {
    const page = read('public/js/pages/workstation-fleet.js');
    expect(page).not.toMatch(/\son(?:click|change|submit)=/i);
    expect(page).toContain('id="wf-search"');
    for (const id of ['wf-status', 'wf-posture', 'wf-drift', 'wf-site', 'wf-group', 'wf-channel']) {
      expect(page).toContain(`'${id}'`);
    }
    expect(page).toContain('aria-label="Test');
    expect(page).toContain('disabled by default');
    expect(page).toContain('post-read observes the exact target digest');
    expect(page).toContain('data-wf-preflight');
    expect(page).toContain('data-wf-history');
    expect(page).toContain('data-wf-cancel');
    expect(page).toContain('No Foreman call is made');
    expect(page).toContain('Preflight is local and read-only');
    expect(page).toContain('type="password"');
    expect(page).toContain('autocomplete="new-password"');
  });

  test('local filters combine search, health, compliance, drift, site, group and image channel', () => {
    const context = { window: {} };
    vm.runInNewContext(read('public/js/pages/workstation-fleet.js'), context, { filename: 'workstation-fleet.js' });
    const page = context.window.WorkstationFleetPage;
    page._data = { devices: [
      { name: 'ws-bucharest', organization: 'Org', location: 'Bucharest', hostGroup: 'Canary',
        osName: 'Fedora', ipAddress: '10.0.0.1', bootcDigest: 'sha256:a', status: 'online', edgeSiteId: 1,
        imageChannel: 'canary', posture: { state: 'warning', checks: [{ key: 'image_drift', state: 'warning' }] } },
      { name: 'ws-paris', organization: 'Org', location: 'Paris', hostGroup: 'Stable',
        osName: 'Fedora', ipAddress: '10.0.0.2', bootcDigest: 'sha256:b', status: 'offline', edgeSiteId: 2,
        imageChannel: 'stable', posture: { state: 'pass', checks: [{ key: 'image_drift', state: 'pass' }] } },
    ] };
    page._filters = { search: 'bucharest', status: 'online', posture: 'warning', drift: 'warning',
      siteId: '1', hostGroup: 'Canary', channel: 'canary' };
    expect(page._filteredDevices().map(item => item.name)).toEqual(['ws-bucharest']);
    page._filters.channel = 'stable';
    expect(page._filteredDevices()).toHaveLength(0);
  });
});
