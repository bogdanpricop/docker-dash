'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');

async function main() {
  const app = express();
  app.get('/smoke', (_req, res) => res.send('<!doctype html><link rel="stylesheet" href="/lib/fontawesome.min.css"><link rel="stylesheet" href="/css/app.css"><div class="app-shell"><aside class="sidebar"></aside><main class="main-content"><div class="mobile-header">Docker Dash</div><div id="page-content"></div></main></div>'));
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
    await page.setViewport({ width: 1500, height: 900 });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke#/containers');
    for (const script of ['i18n.js', 'i18n/en.js', 'utils.js', 'pages/container-inspector.js', 'pages/containers.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    await page.evaluate(async () => {
      const handlers = new Map();
      const rows = [['a', 'demo-api', 'running'], ['b', 'demo-worker', 'running'], ['c', 'demo-old', 'exited'], ['d', 'other', 'running']]
        .map(([id, name, state]) => ({ id, name, state, image: 'fixture:1.0', created: 1700000000, labels: id === 'd' ? { 'com.docker.compose.project': 'helper' } : {}, ports: [] }));
      const hosts = [
        { id: 17, name: 'LAN Docker2', connectionType: 'socket', isDefault: true },
        { id: 28, name: 'VPS Edge', connectionType: 'ssh' },
      ];
      window.fixture = { sent: [], requests: [], delayed: [], selectedHost: 0, offline: false };
      window.App = { _hostSelectorHosts: hosts, navigate(url) { throw new Error('Unexpected navigation ' + url); } };
      window.Toast = { error() {} };
      window.WS = {
        isConnected: true,
        send(type, payload) { fixture.sent.push({ type, ...payload }); },
        on(type, handler) {
          if (!handlers.has(type)) handlers.set(type, new Set());
          handlers.get(type).add(handler);
          return () => handlers.get(type).delete(handler);
        },
        emit(type, payload) { handlers.get(type)?.forEach(handler => handler(payload)); },
      };
      window.Api = {
        getHostId: () => fixture.selectedHost,
        getGroups: async () => [],
        getAllContainerMeta: async () => ({}),
        getMyPermissions: async () => ({ permissions: [] }),
        getSparklines: async () => ({}),
        request: async (_method, url, _body, { signal }) => {
          const parsed = new URL(url, location.origin);
          const hostId = Number(parsed.searchParams.get('hostId'));
          const [, , id, resource] = parsed.pathname.split('/');
          fixture.requests.push({ resource, hostId });
          if (!resource) {
            if (fixture.offline) throw new Error('fixture daemon unreachable');
            const host = hosts.find(item => item.id === hostId) || hosts[0];
            return { containers: rows, host, secondaryStacks: host.id === 28 ? fixture.secondaryStacks : [] };
          }
          if (resource === 'stats' && id === 'a' && hostId === 17) {
            return new Promise(resolve => fixture.delayed.push({ resolve, signal }));
          }
          if (resource === 'stats') return { cpuPercent: 17.5, memUsage: 1024, memLimit: 4096, memPercent: 25, netRx: 0, netTx: 1, blkRead: 2, blkWrite: 3, pids: 4 };
          if (resource === 'inspect') return { image: 'fixture:1.0', restartCount: 1, networks: { bridge: {} } };
          return { lines: ['offline snapshot for ' + id] };
        },
      };
      window.openContainers = () => ContainersPage.render(document.getElementById('page-content'));
      await openContainers();
    });
    await page.type('#container-search', 'demo');
    await page.click('[data-filter-preset="running"]');
    await page.click('#show-all');
    await page.waitForFunction(() => document.querySelectorAll('#containers-grouped tr[data-cid]').length === 2);
    const rowAction = (id, tab) => `tr[data-cid="${id}"] [data-container-inspect="${tab}"]`;
    await page.click('tr[data-cid="a"] .bulk-row-check');
    await page.click(rowAction('a', 'logs'));
    await page.evaluate(() => {
      fixture.first = fixture.sent.at(-1);
      WS.emit('logs:subscribed', fixture.first);
      WS.emit('logs:data', { ...fixture.first, lines: ['initial output'] });
    });
    await page.waitForFunction(() => document.querySelector('pre.container-inspector-log').textContent.includes('initial output'));
    await page.type('.container-log-tools input[type="search"]', 'keep');
    await page.click('[data-log-wrap]');
    await page.click(rowAction('b', 'logs'));
    await page.evaluate(() => {
      const stream = fixture.sent.at(-1);
      WS.emit('logs:subscribed', stream);
      WS.emit('logs:data', { ...fixture.first, lines: ['keep old stream'] });
      WS.emit('logs:data', { ...stream, hostId: 28, lines: ['keep wrong host'] });
      WS.emit('logs:data', { ...stream, lines: ['keep <img src=x onerror=alert(1)>', 'discard me'] });
    });
    await page.waitForFunction(() => document.querySelector('.container-inspector-log').textContent.includes('keep <img'));
    assert.deepEqual(await page.evaluate(() => ({
      text: document.querySelector('.container-inspector-log').textContent,
      htmlNode: !!document.querySelector('.container-inspector-log img'),
      search: document.querySelector('#container-search').value,
      filter: document.querySelector('[data-filter-preset].active').dataset.filterPreset,
      showStopped: document.querySelector('#show-all').checked,
      bulk: document.querySelector('tr[data-cid="a"] .bulk-row-check').checked,
      wrap: document.querySelector('[data-log-wrap]').checked,
      title: document.querySelector('#container-inspector-title').textContent,
      url: location.hash,
    })), { text: 'keep <img src=x onerror=alert(1)>', htmlNode: false, search: 'demo', filter: 'running',
      showStopped: false, bulk: true, wrap: false, title: 'demo-worker', url: '#/containers' });
    await page.click('[data-log-pause]');
    assert.equal(await page.evaluate(() => fixture.sent.at(-1).type), 'logs:unsubscribe');
    await page.click('[data-log-pause]');
    await page.evaluate(() => {
      WS.isConnected = false;
      WS.emit('_disconnected');
    });
    await page.waitForFunction(() => document.querySelector('.container-inspector-status').textContent.includes('offline'));
    await page.evaluate(() => {
      WS.isConnected = true;
      WS.emit('_connected');
      const stream = fixture.sent.at(-1);
      WS.emit('logs:subscribed', stream);
      WS.emit('logs:data', { ...stream, lines: ['keep reconnected'] });
    });
    await page.waitForFunction(() => document.querySelector('.container-inspector-log').textContent === 'keep reconnected');
    await page.click(rowAction('a', 'stats'));
    await page.click(rowAction('b', 'stats'));
    await page.evaluate(() => fixture.delayed[0].resolve({ cpuPercent: 99 }));
    await page.waitForFunction(() => document.querySelector('#inspector-content').textContent.includes('17.5%'));
    assert.match(await page.$eval('#inspector-content [role="status"]', el => el.textContent), /Sampled at \d/);
    assert.equal(await page.evaluate(() => fixture.delayed[0].signal.aborted), true);
    await page.focus('#inspector-tab-stats');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('#inspector-content').textContent.includes('fixture:1.0'));
    await page.evaluate(async () => { fixture.offline = true; await ContainersPage._loadList(); });
    assert.equal(await page.$eval('#container-host-bar [data-container-host-status]', el => el.dataset.status), 'stale');
    assert.match(await page.$eval('#container-host-bar [data-container-host-status]', el => el.textContent), /last seen \d/);
    assert.equal(await page.$eval('#container-inspector [data-container-host-status]', el => el.dataset.status), 'stale');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#container-inspector', el => el.hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.containerInspect), 'stats');

    await page.evaluate(async () => {
      ContainersPage.destroy();
      fixture.offline = false;
      fixture.selectedHost = 28;
      await openContainers();
    });
    await page.setViewport({ width: 390, height: 844 });
    await page.locator(rowAction('a', 'stats')).click();
    await page.waitForFunction(() => document.querySelector('#inspector-content').textContent.includes('17.5%'));
    assert.deepEqual(await page.evaluate(() => {
      const panel = document.querySelector('#container-inspector');
      const box = panel.getBoundingClientRect();
      const banner = document.querySelector('#container-host-bar');
      return {
        host: panel.querySelector('[data-container-host-name]').textContent,
        requestHost: fixture.requests.at(-1).hostId,
        mobileFit: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.top > 0,
        visibleBanner: getComputedStyle(banner).position === 'sticky',
      };
    }), { host: 'VPS Edge', requestHost: 28, mobileFit: true, visibleBanner: true });
    await page.setViewport({ width: 1500, height: 900 });
    await page.evaluate(async () => {
      ContainersPage._inspector.close(false);
      fixture.secondaryStacks = ['helper'];
      Api.getGroups = async () => [{ id: 1, name: 'Favorites' }];
      Api.getGroup = async () => ({ members: ['a', 'd'] });
      await ContainersPage._loadList();
    });
    const secondaryRow = '#containers-grouped tr[data-cid="d"]';
    assert.equal(await page.$(secondaryRow), null);
    assert.ok(await page.$('#containers-grouped tr[data-cid="a"]'));
    assert.equal(await page.$eval('#containers-secondary-count', node => node.textContent.trim()), '(1)');
    await page.waitForSelector('#container-groups-section [data-nav-container="a"]');
    assert.equal(await page.$('#container-groups-section [data-nav-container="d"]'), null);

    await page.click('#containers-show-secondary');
    await page.waitForSelector(secondaryRow);
    await page.waitForSelector('#container-groups-section [data-nav-container="d"]');
    assert.match(await page.$eval('.stack-header[data-stack="helper"]', el => el.textContent), /Secondary/);
    await page.locator(secondaryRow + ' .bulk-row-check').click();
    await page.locator(rowAction('d', 'stats')).click();
    await page.waitForFunction(() => document.querySelector('#container-inspector-title').textContent === 'other');
    await page.click('#containers-show-secondary');
    assert.equal(await page.$(secondaryRow), null);
    assert.equal(await page.$eval('#container-inspector', el => el.hidden), true);
    assert.equal(await page.evaluate(() => ContainersPage._selectedIds.has('d')), false);
    assert.equal(await page.$('#container-groups-section [data-nav-container="d"]'), null);
    await page.evaluate(() => ContainersPage.destroy());
    assert.deepEqual(errors, []);
    console.log('Container inspector browser checks passed');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
