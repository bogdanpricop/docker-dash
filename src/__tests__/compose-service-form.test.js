'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const YAML = require('yaml');

const root = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Compose visual service editor', () => {
  let form;

  beforeAll(() => {
    const context = { console };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('public/js/components/compose-service-form.js'), context);
    form = context.ComposeServiceForm;
  });

  test('round-trips common fields while preserving comments and advanced fields', () => {
    const source = `# stack comment
services:
  web:
    # keep image context
    image: nginx:1 # pinned
    build: .
    healthcheck:
      test: [CMD, curl, localhost]
`;
    const services = form.extractServices(source, YAML);
    expect(Array.from(services[0].unsupported)).toEqual(['build', 'healthcheck']);
    Object.assign(services[0], {
      image: 'nginx:2', restart: 'unless-stopped', portsText: '8080:80',
      environmentText: 'NODE_ENV=production', volumesText: './data:/data',
      dependsOnText: 'database', networksText: 'frontend',
    });

    const result = form.applyChanges(source, services, YAML);
    expect(result.valid).toBe(true);
    expect(result.yaml).toContain('# stack comment');
    expect(result.yaml).toContain('# keep image context');
    expect(result.yaml).toContain('# pinned');
    const parsed = YAML.parse(result.yaml);
    expect(parsed.services.web).toMatchObject({
      image: 'nginx:2', restart: 'unless-stopped', build: '.',
      ports: ['8080:80'], environment: ['NODE_ENV=production'],
      volumes: ['./data:/data'], depends_on: ['database'], networks: ['frontend'],
    });
    expect(parsed.services.web.healthcheck.test).toEqual(['CMD', 'curl', 'localhost']);
  });

  test('adds and removes services without replacing the rest of the document', () => {
    const source = 'name: demo\nservices:\n  old:\n    image: busybox\nvolumes:\n  data: {}\n';
    const services = form.extractServices(source, YAML);
    services[0].removed = true;
    services.push({
      originalName: '', name: 'api', image: 'node:22', restart: 'always',
      portsText: '3000:3000', environmentText: '', volumesText: 'data:/app/data',
      dependsOnText: '', networksText: '', environmentStyle: 'list',
      dependsOnStyle: 'list', networksStyle: 'list', unsupported: [], removed: false,
    });
    const result = form.applyChanges(source, services, YAML);
    const parsed = YAML.parse(result.yaml);
    expect(result.valid).toBe(true);
    expect(parsed.services.old).toBeUndefined();
    expect(parsed.services.api).toMatchObject({ image: 'node:22', ports: ['3000:3000'] });
    expect(parsed.volumes).toEqual({ data: {} });
  });

  test('renaming a service updates form-managed dependency references', () => {
    const source = `services:
  db:
    image: postgres:16
  api:
    image: node:22
    depends_on:
      db:
        condition: service_healthy
`;
    const services = form.extractServices(source, YAML);
    services.find(service => service.name === 'db').name = 'database';
    const result = form.applyChanges(source, services, YAML);
    const parsed = YAML.parse(result.yaml);
    expect(result.valid).toBe(true);
    expect(parsed.services.db).toBeUndefined();
    expect(parsed.services.api.depends_on.database).toEqual({ condition: 'service_healthy' });
  });

  test('rejects invalid service names, restart policies, environment, and volumes inline', () => {
    const services = [{
      originalName: '', name: 'bad name', image: '', restart: 'sometimes', portsText: '',
      environmentText: '1INVALID=value', volumesText: 'relative-name', dependsOnText: '',
      networksText: '', environmentStyle: 'list', dependsOnStyle: 'list',
      networksStyle: 'list', unsupported: [], removed: false,
    }];
    const result = form.applyChanges('services: {}\n', services, YAML);
    expect(result.valid).toBe(false);
    expect(Array.from(result.errors, error => error.field)).toEqual(expect.arrayContaining([
      'name', 'image', 'restart', 'volumes',
    ]));

    services[0].name = 'api';
    services[0].image = 'node:22';
    services[0].restart = 'always';
    services[0].volumesText = '/data';
    const envResult = form.applyChanges('services: {}\n', services, YAML);
    expect(Array.from(envResult.errors, error => error.field)).toContain('environment');
  });

  test('is self-hosted and wired to the Compose Config save flow', () => {
    const index = read('public/index.html');
    const stacks = read('public/js/pages/stacks.js');
    expect(index).toContain('/js/components/compose-service-form.js');
    expect(fs.existsSync(path.join(root, 'public/vendor/yaml/browser/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public/vendor/yaml/LICENSE'))).toBe(true);
    expect(stacks).toContain('ComposeServiceForm.mount');
    expect(stacks).toContain("switchMode('form')");
    expect(stacks).toContain('Api.saveStackConfig');
    expect(stacks).toContain("submitLabel: 'Create Stack'");
    expect(stacks).toContain("_createStackDialog({ initialYaml: result.yaml");
  });
});
