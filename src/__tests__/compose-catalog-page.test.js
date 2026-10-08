'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

describe('Compose catalog page contract', () => {
  test('server, API, router and primary navigation expose the catalog', () => {
    expect(read('src/server.js')).toContain("app.use('/api/compose-blueprints'");
    const api = read('public/js/api.js');
    for (const method of ['getComposeBlueprints', 'getComposeBlueprint', 'createComposeBlueprint',
      'createComposeBlueprintVersion', 'transitionComposeBlueprintVersion', 'previewComposeBlueprint',
      'diffComposeBlueprintVersion', 'instantiateComposeBlueprint', 'getComposeBlueprintInstantiations']) {
      expect(api).toContain(`${method}(`);
    }
    expect(read('public/js/app.js')).toContain("'compose-catalog': () => ComposeCatalogPage");
    const index = read('public/index.html');
    expect(index).toContain('href="#/compose-catalog"');
    expect(index).toContain('/js/pages/compose-catalog.js?v=__VERSION__');
  });

  test('uses delegated event listeners and documents the two-stage deployment boundary', () => {
    const page = read('public/js/pages/compose-catalog.js');
    expect(page).not.toMatch(/\son(?:click|change|submit)=/i);
    expect(page).toContain('id="compose-catalog-search"');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('No deployment occurs in this step');
    expect(page).toContain('requires a fresh dry-run plan and explicit confirmation');
    expect(page).toContain('History stores deterministic hashes, never raw parameter values');
    expect(page).toContain('Utils.escapeHtml(preview.renderedOverride');
    expect(page).toContain('data-compose-version-state');
  });

  test('combines lifecycle and text filtering without a server round trip', () => {
    const context = { window: {} };
    vm.runInNewContext(read('public/js/pages/compose-catalog.js'), context, { filename: 'compose-catalog.js' });
    const page = context.window.ComposeCatalogPage;
    page._items = [
      { name: 'Web application', slug: 'web-app', category: 'application', owner: 'Platform', description: 'Public edge', lifecycle: 'active' },
      { name: 'Database', slug: 'database', category: 'stateful', owner: 'Data', description: 'Internal', lifecycle: 'deprecated' },
    ];
    page._filters = { query: 'edge', lifecycle: 'active' };
    expect(page._filtered().map(item => item.slug)).toEqual(['web-app']);
    page._filters.lifecycle = 'deprecated';
    expect(page._filtered()).toHaveLength(0);
  });
});
