'use strict';

// v8.94.1 — every routed page must have a "?" help button.
//
// This is the regression net for a requirement that silently went unmet on 50 of
// 59 pages. scripts/check-page-help.js is the same check for humans; this one
// runs in CI so the gap cannot come back unnoticed.
//
// It also checks the shape and quality floor of the content itself: an entry
// that exists but says nothing would satisfy a naive coverage count while
// leaving the operator exactly as stuck.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

function readHelpContent() {
  const source = fs.readFileSync(path.join(PUBLIC, 'js', 'help-content.js'), 'utf8');
  const context = { HelpContent: null };
  // The file is a browser script, not a module — evaluate it and read the global.
  vm.runInNewContext(`${source}\nthis.HelpContent = HelpContent;`, context);
  return context.HelpContent;
}

function readRoutes() {
  const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
  const start = app.indexOf('_pages: {');
  const block = app.slice(start, app.indexOf('async init()', start));
  return [...block.matchAll(/'?([A-Za-z0-9-]+)'?\s*:\s*\(\)\s*=>\s*([A-Za-z0-9_]+)/g)]
    .map(m => ({ route: m[1], object: m[2] }));
}

function pagesWithOwnButton() {
  const dir = path.join(PUBLIC, 'js', 'pages');
  const own = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const match = source.match(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*\{/);
    if (match) own.set(match[1], source.includes('prune-help-btn'));
  }
  return own;
}

const HELP = readHelpContent();
const ROUTES = readRoutes();
const OWN = pagesWithOwnButton();

describe('page help — coverage', () => {
  it('finds the route registry', () => {
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it('every routed page has help, either its own button or a content entry', () => {
    const missing = ROUTES
      .filter(r => !OWN.get(r.object) && !HELP[r.route])
      .map(r => r.route);
    expect(missing).toEqual([]);
  });

  it('has no help content for routes that no longer exist', () => {
    const known = new Set(ROUTES.map(r => r.route));
    expect(Object.keys(HELP).filter(k => !known.has(k))).toEqual([]);
  });
});

describe('page help — content shape', () => {
  const entries = Object.entries(HELP);

  it.each(entries)('%s has a complete English entry', (_route, record) => {
    expect(record.en).toBeDefined();
    expect(typeof record.en.title).toBe('string');
    expect(record.en.title.length).toBeGreaterThan(0);
    expect(typeof record.en.intro).toBe('string');
    expect(Array.isArray(record.en.sections)).toBe(true);
    expect(record.en.sections.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s is translated to Romanian', (_route, record) => {
    expect(record.ro).toBeDefined();
    expect(typeof record.ro.title).toBe('string');
    expect(record.ro.sections.length).toBe(record.en.sections.length);
  });

  it.each(entries)('%s says something substantive, not a placeholder', (_route, record) => {
    for (const lang of ['en', 'ro']) {
      // A one-line entry passes a coverage count while leaving the reader stuck.
      expect(record[lang].intro.length).toBeGreaterThan(40);
      for (const section of record[lang].sections) {
        expect(section.title.length).toBeGreaterThan(2);
        expect(section.body.length).toBeGreaterThan(30);
        expect(section.icon).toMatch(/^fa-[a-z0-9-]+$/);
      }
    }
  });

  it.each(entries)('%s uses a Font Awesome icon name', (_route, record) => {
    expect(record.en.icon).toMatch(/^fa-[a-z0-9-]+$/);
  });

  it('carries no markup — the renderer escapes everything, so tags would show literally', () => {
    for (const [route, record] of entries) {
      for (const lang of ['en', 'ro']) {
        const text = JSON.stringify(record[lang]);
        expect(`${route}:${/<[a-z/]/i.test(text)}`).toBe(`${route}:false`);
      }
    }
  });
});
