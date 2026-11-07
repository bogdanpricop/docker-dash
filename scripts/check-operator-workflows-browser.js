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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke');
    for (const script of ['utils.js', 'components/log-viewer.js', 'components/compose-service-form.js', 'pages/stacks.js', 'pages/security-triage.js']) {
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
    assert.deepEqual(errors, []);
    console.log('Operator browser checks passed for grouped logs, safe search, Compose graph, triage filters and SARIF');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
