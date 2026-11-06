'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const localeCodes = ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ro', 'tlh', 'zh'];
const navigationKeys = [
  'virtual-machines', 'high-availability', 'storage-posture', 'network-posture',
  'provider-security-posture', 'placement-advisor', 'recovery-points', 'backup-policies',
  'disaster-recovery', 'virtualization-catalog', 'activity', 'xen-resources',
  'governance', 'self-service', 'governance-controls', 'edge-platform', 'workstation-fleet', 'compose-catalog',
];

function loadLocale(code) {
  let registration;
  const context = { i18n: { register: (registeredCode, label, name, translations) => {
    registration = { code: registeredCode, label, name, translations };
  } } };
  vm.runInNewContext(read(`public/js/i18n/${code}.js`), context, { filename: `${code}.js` });
  return registration;
}

describe('control-plane primary navigation and UI consistency', () => {
  test.each(localeCodes)('%s defines labels for every control-plane route', code => {
    const registration = loadLocale(code);
    expect(registration.code).toBe(code);
    for (const key of navigationKeys) {
      expect(typeof registration.translations.nav[key]).toBe('string');
      expect(registration.translations.nav[key].trim()).not.toBe('');
      expect(registration.translations.nav[key]).not.toBe(`nav.${key}`);
    }
    expect(registration.translations.common.yes).toEqual(expect.any(String));
    expect(registration.translations.common.no).toEqual(expect.any(String));
  });

  test('Romanian navigation uses the approved localized labels', () => {
    expect(loadLocale('ro').translations.nav).toMatchObject({
      'virtual-machines': 'Mașini virtuale',
      'high-availability': 'Înaltă disponibilitate',
      'storage-posture': 'Postura stocării',
      'network-posture': 'Postura rețelei',
      'provider-security-posture': 'Securitatea furnizorilor',
      'placement-advisor': 'Recomandări de plasare',
      'recovery-points': 'Puncte de recuperare',
      'backup-policies': 'Politici de backup',
      'disaster-recovery': 'Recuperare în caz de dezastru',
      'virtualization-catalog': 'Catalog VM',
      activity: 'Centru de activitate',
      'xen-resources': 'Xen / XCP-ng',
      governance: 'Guvernanță',
      'self-service': 'Autoservire',
      'governance-controls': 'Identitate și politici',
      'edge-platform': 'Edge și medii deconectate',
      'workstation-fleet': 'Parc de stații',
      'compose-catalog': 'Catalog Compose',
    });
  });

  test('missing locale keys preserve the readable sidebar fallback', () => {
    const app = read('public/js/app.js');
    expect(app.match(/label !== key/g)).toHaveLength(2);
    for (const key of navigationKeys) expect(app).toContain(`i18n.t('nav.${key}')`);
    expect(app).toContain("items: ['hosts', 'onboarding', 'governance', 'self-service', 'governance-controls', 'edge-platform'");
  });

  test('all four control pages use the shared tab and control-surface contract', () => {
    const pages = [
      read('public/js/pages/governance.js'),
      read('public/js/pages/self-service.js'),
      read('public/js/pages/governance-controls.js'),
      read('public/js/pages/edge-platform.js'),
    ];
    for (const page of pages) {
      expect(page).toContain('control-surface');
      expect(page).toContain('tabs control-tabs');
      expect(page).toContain('role="tab"');
      expect(page).toContain('aria-selected=');
      expect(page).not.toMatch(/class="tab-btn\b/);
    }
    const css = read('public/css/app.css');
    expect(css).toContain('.control-surface .control-tabs');
    expect(css).toContain('.control-action-grid');
  });

  test('legacy table markup and h1 page headings inherit the application theme', () => {
    const css = read('public/css/app.css');
    expect(css).toContain('.page-header h1,');
    expect(css).toContain('.data-table, .table');
    expect(css).toContain('.data-table th, .table th');
    expect(css).toContain('.data-table td, .table td');
  });

  test('Edge actions remain complete, uniquely grouped and use the standard modal form', () => {
    const context = { window: {} };
    vm.runInNewContext(read('public/js/pages/edge-platform.js'), context, { filename: 'edge-platform.js' });
    const page = context.window.EdgePlatformPage;
    const actions = page._actionGroups().flatMap(group => group.actions.map(([key]) => key));
    expect(actions).toHaveLength(44);
    expect(new Set(actions).size).toBe(actions.length);
    expect(page._actionGroups()).toHaveLength(5);

    const modal = read('public/js/components/modal.js');
    expect(modal).toContain('modal-body modal-form-body');
    expect(modal).toContain('type="button" class="modal-close-btn"');
    expect(read('public/js/pages/edge-platform.js')).toContain('class="form-label"');
  });
});
