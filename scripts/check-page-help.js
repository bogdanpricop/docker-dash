'use strict';

// Every routed page must have a "?" help button in its header.
//
// A page satisfies this either by hand-rolling its own (.prune-help-btn in the
// page source, as nine pages did before the shared component existed) or by
// having an entry in public/js/help-content.js, which makes PageHelp inject the
// button after render.
//
// Run: node scripts/check-page-help.js
// Exits non-zero when a routed page has neither, so the gap cannot silently
// reappear the way it did before.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES_DIR = path.join(ROOT, 'public', 'js', 'pages');

function readPageRegistry() {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const start = app.indexOf('_pages: {');
  if (start === -1) throw new Error('Could not find _pages registry in public/js/app.js');
  const block = app.slice(start, app.indexOf('async init()', start));
  const routes = [];
  const re = /'?([A-Za-z0-9-]+)'?\s*:\s*\(\)\s*=>\s*([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) routes.push({ route: m[1], object: m[2] });
  return routes;
}

function pageSources() {
  return fs.readdirSync(PAGES_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ file: f, source: fs.readFileSync(path.join(PAGES_DIR, f), 'utf8') }));
}

function helpContentRoutes() {
  const file = path.join(ROOT, 'public', 'js', 'help-content.js');
  if (!fs.existsSync(file)) return new Set();
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('const HelpContent');
  if (start === -1) return new Set();
  // Top-level keys only: exactly two-space indentation inside the object literal.
  const keys = [...source.slice(start).matchAll(/^ {2}'([A-Za-z0-9-]+)':\s*\{/gm)].map(m => m[1]);
  return new Set(keys);
}

function main() {
  const routes = readPageRegistry();
  const sources = pageSources();
  const contentRoutes = helpContentRoutes();

  const missing = [];
  const ownHelp = [];
  const viaContent = [];

  for (const { route, object } of routes) {
    const owner = sources.find(s => new RegExp(`(?:const|let|var)\\s+${object}\\s*=`).test(s.source));
    const hasOwn = !!owner && owner.source.includes('prune-help-btn');
    if (hasOwn) { ownHelp.push(route); continue; }
    if (contentRoutes.has(route)) { viaContent.push(route); continue; }
    missing.push({ route, file: owner ? owner.file : '(page object not found)' });
  }

  const total = routes.length;
  const covered = ownHelp.length + viaContent.length;
  console.log(`Routed pages:        ${total}`);
  console.log(`Own help button:     ${ownHelp.length}`);
  console.log(`Via help-content.js: ${viaContent.length}`);
  console.log(`Covered:             ${covered}/${total}`);

  const orphans = [...contentRoutes].filter(r => !routes.some(x => x.route === r));
  if (orphans.length) {
    console.log(`\nHelp content for routes that no longer exist: ${orphans.join(', ')}`);
  }

  if (missing.length) {
    console.log(`\nMissing a "?" help button (${missing.length}):`);
    for (const m of missing) console.log(`  ${m.route.padEnd(30)} ${m.file}`);
    console.log('\nAdd an entry to public/js/help-content.js keyed by the route name.');
    process.exit(1);
  }

  console.log('\nEvery routed page has a help button.');
}

main();
