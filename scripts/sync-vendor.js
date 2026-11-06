'use strict';

// Browser assets are committed so production still needs no frontend build.
// Regenerate from npm's integrity-checked lockfile; CI verifies byte equality.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');
const onlyNovnc = process.argv.includes('--novnc');
let count = 0;

function output(destination, data) {
  const target = path.join(root, destination);
  const expected = Buffer.from(data);
  if (check) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(expected)) {
      throw new Error(`Stale browser asset: ${destination}. Run npm run build:vendor.`);
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
  }
  count++;
}

function copy(pkg, source, destination) {
  output(destination, fs.readFileSync(path.join(root, 'node_modules', pkg, source)));
}

function tree(pkg, source, destination) {
  for (const entry of fs.readdirSync(path.join(root, 'node_modules', pkg, source), { withFileTypes: true })) {
    const src = path.posix.join(source, entry.name);
    const dst = path.posix.join(destination, entry.name);
    if (entry.isDirectory()) tree(pkg, src, dst);
    else copy(pkg, src, dst);
  }
}

function version(pkg) {
  return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;
}

const novnc = esbuild.buildSync({
  entryPoints: [path.join(root, 'node_modules/@novnc/novnc/core/rfb.js')],
  bundle: true, minify: true, format: 'esm', write: false,
  banner: { js: `/*! noVNC ${version('@novnc/novnc')} | MPL-2.0 | https://github.com/novnc/noVNC */` },
});
output('public/lib/novnc.min.js', novnc.outputFiles[0].contents);

if (!onlyNovnc) {
  const codemirror = esbuild.buildSync({
    entryPoints: [path.join(root, 'scripts/vendor/codemirror.mjs')],
    bundle: true, minify: true, format: 'iife', globalName: 'DockerDashCodeMirror',
    write: false, metafile: true,
    banner: { js: `/*! CodeMirror ${version('codemirror')} | MIT | See LICENSE and licenses.txt */` },
  });
  output('public/vendor/codemirror/codemirror.min.js', codemirror.outputFiles[0].contents);
  const bundledPackages = [...new Set(Object.keys(codemirror.metafile.inputs)
    .map(file => file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1]).filter(Boolean))].sort();
  output('public/vendor/codemirror/licenses.txt', bundledPackages.map(pkg =>
    `${pkg} ${version(pkg)}\n${fs.readFileSync(path.join(root, 'node_modules', pkg, 'LICENSE'), 'utf8')}`
  ).join('\n\n'));
  const files = [
    ['chart.js', 'dist/chart.umd.min.js', 'public/lib/chart.umd.min.js'],
    ['@xterm/xterm', 'lib/xterm.js', 'public/lib/xterm.min.js'],
    ['@xterm/xterm', 'css/xterm.css', 'public/lib/xterm.min.css'],
    ['@xterm/addon-fit', 'lib/addon-fit.js', 'public/lib/xterm-addon-fit.min.js'],
    ['@fortawesome/fontawesome-free', 'css/all.min.css', 'public/lib/fontawesome.min.css'],
    ['js-yaml', 'dist/browser/js-yaml.umd.min.js', 'public/vendor/js-yaml/js-yaml.min.js'],
    ['js-yaml', 'LICENSE', 'public/vendor/js-yaml/LICENSE'],
    ['yaml', 'LICENSE', 'public/vendor/yaml/LICENSE'],
    ['yaml', 'README.md', 'public/vendor/yaml/README.md'],
    ['codemirror', 'LICENSE', 'public/vendor/codemirror/LICENSE'],
    ['chart.js', 'LICENSE.md', 'public/lib/licenses/chart.js.txt'],
    ['@xterm/xterm', 'LICENSE', 'public/lib/licenses/xterm.txt'],
    ['@xterm/addon-fit', 'LICENSE', 'public/lib/licenses/xterm-addon-fit.txt'],
    ['@fortawesome/fontawesome-free', 'LICENSE.txt', 'public/lib/licenses/fontawesome.txt'],
    ['@novnc/novnc', 'docs/LICENSE.MPL-2.0', 'public/lib/licenses/novnc.txt'],
  ];
  for (const args of files) copy(...args);
  tree('yaml', 'browser', 'public/vendor/yaml/browser');
  tree('@fortawesome/fontawesome-free', 'webfonts', 'public/webfonts');
  const packages = ['@novnc/novnc', 'chart.js', '@xterm/xterm', '@xterm/addon-fit',
    '@fortawesome/fontawesome-free', 'js-yaml', 'yaml', ...bundledPackages];
  output('public/vendor/versions.json', JSON.stringify(Object.fromEntries(packages.map(pkg => [pkg, version(pkg)])), null, 2) + '\n');
  output('public/vendor/js-yaml/README.docker-dash.md', `# Vendored js-yaml\n\n- js-yaml ${version('js-yaml')} UMD browser build, MIT license.\n- Used only for client-side YAML syntax feedback; server validation remains authoritative.\n- Reproduce with \`npm ci && npm run build:vendor\`.\n\nSource: https://www.npmjs.com/package/js-yaml\n`);
  output('public/vendor/codemirror/README.docker-dash.md', `# Vendored CodeMirror 6\n\nSource: \`scripts/vendor/codemirror.mjs\`. Reproduce with \`npm ci && npm run build:vendor\`.\nThe committed bundle provides the YAML editor without a runtime frontend build.\nVersions are recorded in ../versions.json; bundled MIT licenses are in licenses.txt.\nTab moves focus; use the editor's standard indentation commands to indent.\n\nSource: https://codemirror.net/\n`);
}
console.log(`${check ? 'Verified' : 'Updated'} ${count} browser assets.`);
