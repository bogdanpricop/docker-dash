'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');

const fixture = `<!doctype html><link rel="stylesheet" href="/css/app.css">
  <aside class="sidebar"><nav id="sidebar-nav" class="sidebar-nav">
    <a class="nav-item" data-page="dashboard" href="#/dashboard"><span>Dashboard</span></a>
    <a class="nav-item active" data-page="containers" href="#/containers"><span>Containers</span><b id="container-count">7</b></a>
    <a class="nav-item" data-page="stacks" href="#/stacks"><span>Stacks</span></a>
    <a class="nav-item" data-page="swarm" data-capability="swarm" href="#/swarm"><span>Swarm</span></a>
  </nav></aside>
  <div id="modal-overlay" class="modal-overlay hidden"><div id="modal-content" class="modal-content"></div></div>`;

async function main() {
  const app = express();
  app.get('/smoke', (_req, res) => res.send(fixture));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 900 });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke#/containers');
    for (const script of ['utils.js', 'i18n.js', 'i18n/en.js', 'components/modal.js',
      'components/context-menu.js', 'components/nav-pins.js', 'app.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    await page.evaluate(() => {
      window.writes = [];
      window.toasts = [];
      window.Toast = { error: message => toasts.push(message) };
      window.Api = {
        saveUserPreference: async (key, value) => writes.push([App.user.id, key, JSON.parse(value)]),
        getSystemInfo: async () => ({ capabilities: { swarm: false } }),
        getHosts: async () => [],
        getExperienceNavigation: async () => ({ pages: [] }),
      };
      App.user = { id: 1 };
      window.originalContainers = document.querySelector('[data-page="containers"]');
      NavPins.init(App.user);
    });

    const pinnedPages = () => page.$$eval('#nav-pinned-body .nav-item', items => items.map(item => item.dataset.page));
    await page.click('[data-page="containers"]', { button: 'right' });
    await page.click('.context-menu-item');
    assert.deepEqual(await pinnedPages(), ['containers']);
    assert.equal(await page.evaluate(() => {
      const item = document.querySelector('#nav-pinned-body [data-page="containers"]');
      return item === originalContainers && item.classList.contains('active') &&
        item.querySelector('#container-count').textContent === '7';
    }), true);

    await page.click('#nav-pinned-manage');
    await page.click('[data-pin-toggle="stacks"]');
    await page.waitForFunction(() => document.activeElement?.dataset.pinToggle === 'stacks');
    await page.focus('.nav-pin-row-pinned[data-pin-page="stacks"]');
    await page.keyboard.down('Alt');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.up('Alt');
    assert.deepEqual(await pinnedPages(), ['stacks', 'containers']);
    assert.match(await page.$eval('#nav-pin-live', node => node.textContent), /position 1 of 2/);
    await page.click('[data-pin-page="stacks"] [data-pin-move="down"]');
    assert.deepEqual(await pinnedPages(), ['containers', 'stacks']);
    await page.click('[data-pin-page="stacks"] [data-pin-move="up"]');
    assert.deepEqual(await pinnedPages(), ['stacks', 'containers']);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'nav-pinned-manage');

    await page.evaluate(async () => {
      NavPins.toggle('swarm');
      await App._refreshCapabilities();
      App._renderSidebarForMode('enterprise');
    });
    assert.equal(await page.$eval('#nav-pinned-body [data-page="swarm"]', item => getComputedStyle(item).display), 'none');
    await page.evaluate(async () => {
      Api.getSystemInfo = async () => ({ capabilities: { swarm: true } });
      await App._refreshCapabilities();
      App._composeSimpleMode = true;
      App._renderSidebarForMode('standard');
    });
    assert.deepEqual(await pinnedPages(), ['stacks', 'containers', 'swarm']);
    assert.notEqual(await page.$eval('#nav-pinned-body [data-page="swarm"]', item => getComputedStyle(item).display), 'none');
    await page.evaluate(() => NavPins.toggle('swarm'));
    assert.equal(await page.$('.nav-simple-more [data-page="swarm"]') !== null, true);

    // Use the real preference sync entry point and the original, delayed account.
    await page.evaluate(async () => {
      await NavPins._session.pending;
      Api.getUserPreferences = () => new Promise(resolve => { window.finishOldRead = resolve; });
      window.oldRead = App._syncUserPreferences();
      App.user = { id: 2 };
      NavPins.init(App.user);
      finishOldRead({ pinnedNav: '["dashboard"]' });
      await oldRead;
    });
    assert.deepEqual(await pinnedPages(), []);
    await page.evaluate(async () => {
      Api.getUserPreferences = async () => ({ pinnedNav: '{"pages":["containers","containers","stacks"],"updatedAt":99}' });
      await App._syncUserPreferences();
    });
    assert.deepEqual(await pinnedPages(), ['containers', 'stacks']);

    // While a write is in flight, keep only the latest queued edit. A fetch
    // started before those edits must not overwrite them when it completes.
    const saved = await page.evaluate(async () => {
      const requested = NavPins.snapshot();
      let release;
      const started = new Promise(resolve => {
        Api.saveUserPreference = async (key, value) => {
          writes.push([App.user.id, key, JSON.parse(value)]);
          await new Promise(done => { release = done; resolve(); });
        };
      });
      NavPins.toggle('dashboard');
      await started;
      Api.saveUserPreference = async (key, value) => writes.push([App.user.id, key, JSON.parse(value)]);
      NavPins.toggle('stacks');
      NavPins.toggle('containers');
      NavPins.setFromServer('["stacks"]', requested);
      release();
      await NavPins._session.pending;
      return writes.filter(([userId]) => userId === 2);
    });
    assert.deepEqual(saved, [[2, 'pinnedNav', ['containers', 'stacks', 'dashboard']], [2, 'pinnedNav', ['dashboard']]]);
    assert.deepEqual(await pinnedPages(), ['dashboard']);

    // A queued write from a previous login cannot use the next account.
    await page.evaluate(async () => {
      NavPins.toggle('stacks');
      const oldSession = NavPins._session;
      App.user = { id: 1 };
      NavPins.init(App.user);
      await oldSession.pending;
    });
    assert.deepEqual(await pinnedPages(), ['stacks', 'containers']);
    assert.equal(await page.evaluate(() => writes.filter(([id]) => id === 2).length), 2);

    await page.evaluate(async () => {
      Api.saveUserPreference = async () => { throw new Error('offline'); };
      NavPins.toggle('dashboard');
      await NavPins._session.pending;
    });
    assert.deepEqual(await pinnedPages(), ['stacks', 'containers', 'dashboard']);
    assert.match(await page.evaluate(() => toasts[0]), /could not be synced/);
    assert.deepEqual(errors, []);
    console.log('Browser verified sidebar pinning, keyboard order, layout, host gating, and account isolation.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
