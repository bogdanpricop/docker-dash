'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const root = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

describe('YamlEditor browser utility', () => {
  let editor;

  beforeAll(() => {
    const context = { console, setTimeout, clearTimeout };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('public/vendor/js-yaml/js-yaml.min.js'), context);
    vm.runInContext(read('public/js/utils/yaml-editor.js'), context);
    editor = context.YamlEditor;
  });

  test('returns parsed documents for valid Compose YAML', () => {
    const result = editor.validateText('services:\n  web:\n    image: nginx:alpine\n');
    expect(result.valid).toBe(true);
    expect(result.document.services.web.image).toBe('nginx:alpine');
  });

  test('returns useful line information for syntax errors', () => {
    const result = editor.validateText('services:\n  web: [\n');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toEqual(expect.objectContaining({
      message: expect.any(String), line: expect.any(Number), column: expect.any(Number),
    }));
  });

  test('loads vendored assets before the wrapper and stays under 300 KB gzipped', () => {
    const html = read('public/index.html');
    expect(html.indexOf('/vendor/codemirror/lib/codemirror.js'))
      .toBeLessThan(html.indexOf('/js/utils/yaml-editor.js'));
    expect(html.indexOf('/vendor/js-yaml/js-yaml.min.js'))
      .toBeLessThan(html.indexOf('/vendor/codemirror/addon/lint/yaml-lint.js'));

    const files = [
      'public/vendor/codemirror/lib/codemirror.js',
      'public/vendor/codemirror/lib/codemirror.css',
      'public/vendor/codemirror/mode/yaml/yaml.js',
      'public/vendor/codemirror/addon/edit/matchbrackets.js',
      'public/vendor/codemirror/addon/edit/closebrackets.js',
      'public/vendor/codemirror/addon/lint/lint.js',
      'public/vendor/codemirror/addon/lint/lint.css',
      'public/vendor/codemirror/addon/lint/yaml-lint.js',
      'public/vendor/js-yaml/js-yaml.min.js',
      'public/js/utils/yaml-editor.js',
    ];
    const gzipBytes = files.reduce((total, file) =>
      total + zlib.gzipSync(fs.readFileSync(path.join(root, file))).length, 0);
    expect(gzipBytes).toBeLessThan(300 * 1024);
  });

  test('is wired into Compose create/config and Git edit surfaces', () => {
    const stacks = read('public/js/pages/stacks.js');
    const gitStacks = read('public/js/pages/git-stacks.js');
    expect(stacks).toContain("YamlEditor.mount(el.querySelector('#cs-config-editor')");
    expect(stacks).toContain("YamlEditor.mount(content.querySelector('#cs-yaml')");
    expect(gitStacks).toContain("YamlEditor.mount(content.querySelector('#ep-content')");
  });
});
