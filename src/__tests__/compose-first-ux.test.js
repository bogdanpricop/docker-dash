'use strict';

const fs = require('fs');
const path = require('path');

const readPublic = relative => fs.readFileSync(path.join(__dirname, '..', '..', 'public', relative), 'utf8');

describe('Compose-first navigation contract', () => {
  test('standard sidebar starts with Dashboard, Stacks, Containers, Images', () => {
    const html = readPublic('index.html');
    const nav = html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf('</nav>'));
    const pages = [...nav.matchAll(/class="nav-item[^\"]*" data-page="([^"]+)"/g)].map(match => match[1]);
    expect(pages.slice(0, 4)).toEqual(['dashboard', 'stacks', 'containers', 'images']);
  });

  test('simple mode is query-driven, cookie-backed, and reversible', () => {
    const app = readPublic('js/app.js');
    expect(app).toContain("new URLSearchParams(location.search).get('mode')");
    expect(app).toContain('dd_simple_mode=');
    expect(app).toContain('nav-simple-more');
    expect(app).toContain('simple-show-all');
    expect(app).toContain("url.searchParams.delete('mode')");
  });

  test('Dashboard card persists its dismissal through user preferences', () => {
    const dashboard = readPublic('js/pages/dashboard.js');
    expect(dashboard).toContain('compose-first-banner');
    expect(dashboard).toContain("Api.saveUserPreference('composeFirstBannerDismissed', 'true')");
    expect(dashboard).toContain('href="#/stacks"');
    expect(dashboard).toContain('href="?mode=simple#/stacks"');
  });

  test('Compose stack detail renders image, writable-layer and root filesystem sizes', () => {
    const stacks = readPublic('js/pages/stacks.js');
    const en = readPublic('js/i18n/en.js');
    const ro = readPublic('js/i18n/ro.js');
    expect(stacks).toContain('storage.approximateFootprintBytes');
    expect(stacks).toContain('c.imageSizeBytes');
    expect(stacks).toContain('c.writableSizeBytes');
    expect(stacks).toContain('c.rootFsSizeBytes');
    expect(stacks).toContain("i18n.t('pages.stacks.storageExclusions')");
    expect(en).toContain("uniqueImageSize: 'Unique image size'");
    expect(ro).toContain('uniqueImageSize: "Dimensiune imagini unice"');
  });
});
