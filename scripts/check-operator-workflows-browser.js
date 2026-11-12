'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');

async function main() {
  const app = express();
  app.get('/smoke', (_req, res) => res.send('<!doctype html><link rel="stylesheet" href="/css/app.css"><main id="test"></main>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke');
    for (const script of ['utils.js', 'components/log-viewer.js', 'components/compose-service-form.js',
      'components/stack-metrics.js', 'pages/stacks.js', 'pages/security-triage.js', 'pages/security.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    await page.evaluate(() => {
      const root = document.getElementById('test');
      root.innerHTML = '<div id="controls"></div><pre class="log-viewer" id="output"></pre>';
      window.viewer = new LogViewer(root.querySelector('#controls'), root.querySelector('#output'));
      viewer.set([
        { container: 'worker', msg: 'one <img src=x onerror=alert(1)> error', severity: 'error' },
        { container: 'api', msg: 'two error', severity: 'warn' },
      ], 'error', 'grouped');
    });
    await page.click('[data-viewer-next]');
    assert.equal(await page.$eval('.log-match-active', el => el.textContent), 'error');
    assert.equal(await page.$eval('[data-viewer-follow]', el => el.checked), false);
    await page.click('[data-viewer-wrap]');
    assert.equal(await page.$eval('#output', el => el.classList.contains('log-viewer-wrap')), true);
    await page.click('[data-viewer-pause]');
    assert.equal(await page.evaluate(() => viewer.paused), true);
    assert.equal(await page.$('#output img'), null);
    assert.deepEqual(await page.$$eval('.log-viewer-group', rows => rows.map(row => row.textContent)), ['api', 'worker']);

    await page.evaluate(async () => {
      const model = await ComposeServiceForm.graphFromYaml([
        'services:', '  api:', '    depends_on: [db]', '    secrets: [token]', '    environment: {PASSWORD: test-secret-value}',
        '  db: {image: postgres}', 'secrets: {token: {environment: PASSWORD}}',
      ].join('\n'));
      StacksPage._renderComposeGraph(document.getElementById('test'), model);
    });
    const graph = await page.$eval('.compose-graph', el => el.textContent);
    assert.match(graph, /Depends on\s*db/);
    assert.match(graph, /Secret references\s*token/);
    assert.doesNotMatch(graph, /test-secret-value/);

    const serviceId = 'a'.repeat(64);
    await page.evaluate(async id => {
      const compose = [
        { name: 'billing', running: 2, total: 3, services: ['db', 'worker', 'api', 'cron'],
          networks: [{ name: 'billing-net', id: 'network-billing' }, { name: 'edge', id: 'network-edge' }, { name: 'topology', id: null }],
          volumes: ['billing-data'], containers: [
          { id, name: 'billing-db', service: 'db', image: 'postgres:17', state: 'running', ports: [{ public: 5432, private: 5432, type: 'tcp' }] },
          { id: 'b'.repeat(64), name: 'billing-worker', service: 'worker', image: 'worker:1', state: 'exited' },
          { id: 'c'.repeat(64), name: 'billing-api', service: 'api', image: 'api:1', state: 'running' },
        ] },
        { name: 'offline', running: 0, total: 0, discovered: true, diskOnly: true, services: ['frontend'], containers: [] },
        { name: 'analytics', running: 1, total: 1, services: ['worker'], containers: [
          { id: 'd'.repeat(64), name: 'analytics-worker', service: 'worker', image: 'analytics:1', state: 'running' },
        ] },
      ];
      window.stacksHostId = 17;
      window.App = { _hostSelectorHosts: [{ id: 17, name: 'Docker2' }, { id: 18, name: 'VPS' }] };
      window.i18n = { t: key => key.split('.').at(-1) };
      window.metricRequests = [];
      window.stackVisibilityByHost = new Map();
      window.visibilityChanges = [];
      window.Api = {
        getHostId: () => window.stacksHostId,
        detectUptimeKuma: async () => ({ detected: false }),
        get: async url => {
          const host = App._hostSelectorHosts.find(item => item.id === window.stacksHostId);
          if (url === '/git/stacks?hostId=' + host.id) return [];
          if (url !== '/system/stacks?context=1&hostId=' + host.id) throw new Error('Stacks request was not pinned to the selected host');
          return { host, stacks: compose, secondaryStacks: [...(stackVisibilityByHost.get(host.id) || [])] };
        },
        setStackVisibility: async (name, secondary, hostId) => {
          if (hostId !== window.stacksHostId) throw new Error('Stack preference was not pinned to the selected host');
          const marked = stackVisibilityByHost.get(hostId) || new Set();
          if (secondary) marked.add(name);
          else marked.delete(name);
          stackVisibilityByHost.set(hostId, marked);
          visibilityChanges.push({ name, secondary, hostId });
        },
        request: async (method, url, selection) => {
          const hostId = window.stacksHostId;
          if (method !== 'POST' || url !== '/stats/stack-metrics?hostId=' + hostId) throw new Error('Metrics were not pinned to the selected host');
          window.metricRequests.push(selection);
          const containers = {};
          for (const containerId of selection.ids) {
            if (hostId === 18 && containerId !== id) continue;
            const at = 1_700_000_010_000;
            const analytics = containerId.startsWith('d');
            const latest = { at, cpu: containerId === id ? 90 : 35, ram: (analytics ? 4 : 1) * 1024 ** 2,
              rx: 1024, tx: 512, read: 128, write: 256 };
            containers[containerId] = { latest, fresh: true };
            if (selection.historyIds.includes(containerId)) {
              containers[containerId].history = [{ ...latest, at: at - 10_000, cpu: 10, ram: 512, read: 64 }, latest];
            }
          }
          return { hostId, staleAfterMs: 30_000, containers };
        },
      };
      await StacksPage.render(document.querySelector('#test'));
    }, serviceId);
    await page.click('#stack-view [data-view="table"]');
    assert.equal(await page.$$eval('[data-stack-row]', rows => rows.length), 3);
    assert.ok(await page.evaluate(() => {
      const center = id => {
        const bounds = document.getElementById(id).getBoundingClientRect();
        return bounds.top + bounds.height / 2;
      };
      return Math.abs(center('stack-search') - center('stacks-state')) < 2;
    }));
    assert.match(await page.$eval('#stacks-host', el => el.textContent), /Docker2/);
    await page.waitForFunction(() => document.querySelector('[data-stack-metric="cpu"]').textContent === '125%');
    assert.equal(await page.$eval('[data-stack-metric="ram"]', el => el.textContent), '2 MiB');
    assert.match(await page.$eval('[data-stack-metric="network"]', el => el.textContent), /2 KiB\/s/);
    assert.match(await page.$eval('[data-stack-metric="disk"]', el => el.textContent), /256 B\/s/);
    assert.ok(await page.$('[data-stack-metric="updated"] time[datetime]'));
    assert.deepEqual(await page.evaluate(() => window.metricRequests[0].historyIds), []);
    assert.ok(await page.$('[href="#/networks/network-billing"]'));
    assert.ok(await page.$('[href="#/volumes/billing-data"]'));
    await page.click('.stack-resource-links summary');
    await page.waitForSelector('[href="#/networks/details/topology"]', { visible: true });
    await page.click('[data-stack-expand]');
    await page.waitForSelector('[data-stack-service-metrics] svg');
    const serviceBackground = () => page.$eval('.stack-table-services:not([hidden]) td', el => getComputedStyle(el).backgroundColor);
    const beforeHover = await serviceBackground();
    await page.hover('.stack-table-services:not([hidden]) .stack-service-card');
    assert.equal(await serviceBackground(), beforeHover);
    const names = () => page.$$eval('[data-stack-row]', rows => rows.map(row => row.cells[1].textContent.trim()));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('[data-stack-sort="ram"]');
    assert.equal(await page.$eval('[data-stack-sort="ram"]', el => el.closest('th').getAttribute('aria-sort')), 'descending');
    assert.deepEqual(await names(), ['analytics', 'billing', 'offline']);
    assert.equal(await page.$eval('.stack-row-expanded', row => row.nextElementSibling.hidden), false);
    await page.click('[data-stack-sort="cpu"]');
    assert.deepEqual(await names(), ['billing', 'analytics', 'offline']);
    await page.click('[data-stack-sort="cpu"]');
    assert.deepEqual(await names(), ['analytics', 'billing', 'offline']);
    await page.click('[data-stack-sort="cpu"]');
    assert.deepEqual(await names(), ['billing', 'offline', 'analytics']);
    await page.click('.stack-row-expanded [data-stack-expand]');
    await page.select('#stacks-state', 'partial');
    await page.type('#stack-search', 'postgres');
    await page.waitForFunction(() => document.querySelectorAll('[data-stack-row]').length === 1);
    await page.click('[data-stack-expand]');
    assert.equal(await page.$eval('[data-stack-expand]', el => el.getAttribute('aria-expanded')), 'true');
    await page.waitForSelector('[data-stack-service-metrics] svg');
    assert.equal(await page.$$eval('[data-stack-service-metrics] svg', charts => charts.length), 8);
    assert.equal(await page.evaluate(() => window.metricRequests.at(-1).historyIds.length), 2);
    assert.match(await page.$eval('.stack-table-service-grid', el => el.textContent), /5432→5432\/tcp/);
    assert.match(await page.$eval('.stack-table-service-grid', el => el.textContent), /cron/);
    for (const tab of ['logs', 'stats']) assert.ok(await page.$(`[href="#/containers/${serviceId}/${tab}"]`));
    assert.ok(await page.$('[data-stack-review="check"]'));
    assert.ok(await page.$('[data-stack-review="plan"]'));
    await page.click('#stack-view [data-view="cards"]');
    assert.equal(await page.$eval('[data-stack-services]', el => el.open), true);
    assert.equal(await page.evaluate(() => StacksPage._stackMetrics), null);
    await page.click('#stack-view [data-view="table"]');
    await page.evaluate(() => StacksPage._loadList());
    assert.equal(await page.$eval('[data-stack-expand]', el => el.getAttribute('aria-expanded')), 'true');
    await page.evaluate(async () => {
      StacksPage.destroy();
      window.stacksHostId = 18;
      await StacksPage.render(document.querySelector('#test'));
    });
    assert.match(await page.$eval('#stacks-host', el => el.textContent), /VPS/);
    await page.waitForSelector('[data-stack-metric="updated"] .stack-metrics-quality');
    assert.equal(await page.$eval('[data-stack-metric="cpu"]', el => el.textContent), '—');
    assert.equal(await page.$eval('#stack-search', el => el.value), 'postgres');
    assert.equal(await page.$eval('#stacks-state', el => el.value), 'partial');
    assert.equal(await page.$eval('[data-stack-expand]', el => el.getAttribute('aria-expanded')), 'false');
    assert.deepEqual(await page.evaluate(() => ['view', 'search', 'state'].map(key => localStorage.getItem('dd-stacks-' + key))),
      ['table', 'postgres', 'partial']);

    const billingVisibility = '[data-stack-visibility][data-name="billing"]';
    await page.click(billingVisibility);
    await page.waitForFunction(() => document.getElementById('stacks-content').textContent.includes('secondaryStacksHidden'));
    assert.equal(await page.$('#stacks-content [data-stack-row]'), null);
    assert.equal(await page.$eval('#stacks-secondary-count', node => node.textContent.trim()), '(1)');
    await page.click('#stacks-show-secondary');
    assert.match(await page.$eval('[data-stack-row]', row => row.textContent), /secondaryStack/);
    assert.equal(await page.$eval('#stack-search', input => input.value), 'postgres');
    assert.equal(await page.$eval('#stacks-state', select => select.value), 'partial');
    await page.click('#stack-view [data-view="cards"]');
    assert.match(await page.$eval('.stack-card', card => card.textContent), /secondaryStack/);
    await page.evaluate(async () => {
      StacksPage.destroy();
      await StacksPage.render(document.querySelector('#test'));
    });
    assert.equal(await page.$eval('#stacks-show-secondary', input => input.checked), false);
    assert.equal(await page.$('.stack-card'), null);
    await page.click('#stacks-show-secondary');
    await page.click(billingVisibility);
    await page.waitForFunction(() => document.getElementById('stacks-secondary-count').textContent === '');
    assert.doesNotMatch(await page.$eval('.stack-card', card => card.textContent), /secondaryStack/);
    assert.deepEqual(await page.evaluate(() => visibilityChanges), [
      { name: 'billing', secondary: true, hostId: 18 },
      { name: 'billing', secondary: false, hostId: 18 },
    ]);
    await page.evaluate(() => StacksPage.destroy());

    await page.evaluate(async () => {
      const host = { id: 17, name: 'Docker2', daemonType: 'docker', isActive: true, isDefault: true };
      const image = 'sha256:' + 'a'.repeat(64);
      window.App = { _activateHost() {} };
      window.Api = {
        getHostId: () => 0,
        getHosts: async () => [host],
        get: async url => {
          if (!url.endsWith('hostId=17')) throw new Error('Host was not pinned');
          return {
            host, scans: [{ id: 4, image_name: 'fixture:1', verified_image_id: image, scanner: 'trivy',
              consumers: [{ id: 'abc', name: 'api', stack: 'demo', state: 'running' }] }],
            findings: [
              { scanId: 4, id: 'CVE-TEST-1', package: 'libfixture', version: '1', fixedIn: '2', severity: 'high' },
              { scanId: 4, id: 'CVE-TEST-2', package: 'libother', version: '3', fixedIn: null, severity: 'low' },
            ],
          };
        },
      };
      URL.createObjectURL = blob => {
        window.savedReport = blob.text().then(JSON.parse);
        return 'blob:fixture';
      };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = () => {};
      await SecurityTriage.render(document.getElementById('test'));
    });
    await page.select('[data-triage-stack]', 'demo');
    await page.select('[data-triage-fix]', 'fixed');
    assert.match(await page.$eval('[data-triage-list]', el => el.textContent), /CVE-TEST-1/);
    assert.doesNotMatch(await page.$eval('[data-triage-list]', el => el.textContent), /CVE-TEST-2/);
    await page.click('[data-triage-export]');
    const report = await page.evaluate(() => window.savedReport);
    assert.equal(report.version, '2.1.0');
    assert.equal(report.runs[0].results.length, 1);
    assert.equal(report.runs[0].results[0].properties.hostId, 17);

    await page.evaluate(async () => {
      const scanned = { id: 'sha256:' + 'a'.repeat(64), repoTags: ['retagged:latest'], hostId: 17 };
      const untagged = { id: 'sha256:' + 'b'.repeat(64), shortId: 'bbbbbbbbbbbb', repoTags: ['<none>:<none>'], hostId: 17 };
      window.scanRequests = [];
      window.scanToasts = [];
      window.Toast = Object.fromEntries(['info', 'success', 'warning', 'error'].map(level =>
        [level, message => scanToasts.push({ level, message })]));
      window.Modal = { confirm: async () => true };
      window.Api = {
        getHostId: () => 17,
        get: async url => {
          if (url === '/images?hostId=17') return [scanned, untagged];
          if (url !== '/images/scan-status?hostId=17') throw new Error('Overview was not scoped to the selected host');
          return { hostId: 17, images: [untagged, scanned], legacyImageIds: [untagged.id], scans: [{
            verified_image_id: scanned.id, id: 4, scanner: 'trivy', scanned_at: '2026-11-12',
            summary_critical: 0, summary_high: 0, summary_medium: 0, summary_low: 0,
            summary_total: 0, fixable_count: 0,
          }] };
        },
        scanImage: async (id, scanner, hostId) => {
          scanRequests.push([decodeURIComponent(id), scanner, hostId]);
          return decodeURIComponent(id) === untagged.id
            ? { scanner: 'none', message: 'Archive failed <img src=x>' }
            : { scanner: 'trivy', scanId: 5 };
        },
      };
      await SecurityPage.render(document.getElementById('test'));
    });
    assert.equal(await page.$('.security-scan-group'), null);
    await page.click('#security-group-scan-status');
    assert.deepEqual(await page.$$eval('.security-scan-group', rows => rows.map(row => row.textContent)),
      ['scannedGroup (1)', 'notScannedGroup (1)']);
    assert.match(await page.$eval('.security-scan-group + tr', row => row.textContent), /retagged:latest/);
    assert.match(await page.$eval('#security-scan-table', table => table.textContent), /legacyScan/);
    await page.click('[data-scan-image-id="sha256:' + 'b'.repeat(64) + '"] [data-action="scan"]');
    await page.click('.scan-menu-item[data-scanner="trivy"]');
    await page.waitForSelector('.security-scan-failure');
    assert.match(await page.$eval('.security-scan-failure', node => node.textContent), /Archive failed <img src=x>/);
    assert.equal(await page.$('.security-scan-failure img'), null);
    assert.deepEqual(await page.evaluate(() => scanRequests), [['sha256:' + 'b'.repeat(64), 'trivy', 17]]);
    assert.equal(await page.$eval('#security-group-scan-status', input => input.checked), true);
    await page.evaluate(() => SecurityPage._scanAll());
    await page.waitForFunction(() => scanToasts.some(toast => toast.level === 'warning' && toast.message.includes('1/2 images scanned')));
    await page.waitForSelector('#security-group-scan-status');
    await page.click('#security-group-scan-status');
    assert.equal(await page.$('.security-scan-group'), null);
    assert.deepEqual(errors, []);
    console.log('Operator browser checks passed for logs, Stacks, triage and Security scan grouping');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
