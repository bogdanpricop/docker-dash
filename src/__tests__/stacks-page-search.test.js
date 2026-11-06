'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const stacksSource = fs.readFileSync(path.join(root, 'public/js/pages/stacks.js'), 'utf8');

describe('Stacks page search', () => {
  let page;

  beforeAll(() => {
    const context = {
      console,
      localStorage: { getItem: () => null },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(stacksSource, context);
    page = context.StacksPage;
  });

  test('matches Compose stacks by stack, service, and container metadata', () => {
    const stack = {
      source: 'compose',
      name: 'billing-platform',
      workingDir: '/opt/stacks/billing',
      services: ['api', 'postgres'],
      containers: [{ name: 'billing-db-1', image: 'postgres:17', state: 'running' }],
    };

    expect(page._matchesStackSearch(stack, 'BILLING')).toBe(true);
    expect(page._matchesStackSearch(stack, 'postgres:17')).toBe(true);
    expect(page._matchesStackSearch(stack, 'running')).toBe(true);
    expect(page._matchesStackSearch(stack, 'redis')).toBe(false);
  });

  test('matches Git stacks by repository, branch, commit, and status', () => {
    const stack = {
      source: 'git',
      name: 'customer-portal',
      repoUrl: 'https://github.com/example/customer-portal.git',
      branch: 'release/2026.08',
      lastCommit: 'abc123def456',
      status: 'deployed',
    };

    expect(page._matchesStackSearch(stack, 'github.com/example')).toBe(true);
    expect(page._matchesStackSearch(stack, '2026.08')).toBe(true);
    expect(page._matchesStackSearch(stack, 'ABC123')).toBe(true);
    expect(page._matchesStackSearch(stack, 'deployed')).toBe(true);
    expect(page._matchesStackSearch(stack, 'compose-only')).toBe(false);
  });

  test('renders the same debounced search affordance used by Images', () => {
    expect(stacksSource).toContain('class="search-box"');
    expect(stacksSource).toContain('id="stack-search"');
    expect(stacksSource).toContain('Utils.debounce(event =>');
    expect(stacksSource).toContain("i18n.t('pages.stacks.filterPlaceholder')");
  });
});
