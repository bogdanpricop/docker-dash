'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const puppeteer = require('puppeteer');

async function main() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    upgradeInsecureRequests: null,
  } } }));
  app.get('/smoke', (_req, res) => res.send('<!doctype html><html><body><div id="terminal" style="width:640px;height:240px"></div><canvas id="chart"></canvas></body></html>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/smoke`);
    for (const asset of ['xterm.min.css', 'fontawesome.min.css']) await page.addStyleTag({ url: `${base}/lib/${asset}` });
    for (const asset of ['xterm.min.js', 'xterm-addon-fit.min.js', 'chart.umd.min.js']) await page.addScriptTag({ url: `${base}/lib/${asset}` });
    await page.addScriptTag({ url: `${base}/vendor/js-yaml/js-yaml.min.js` });
    const result = await page.evaluate(async () => {
      const { default: RFB } = await import('/lib/novnc.min.js');
      const YAML = await import('/vendor/yaml/browser/index.js');
      const terminal = new window.Terminal();
      const fit = new window.FitAddon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(document.getElementById('terminal'));
      fit.fit();
      await new Promise(resolve => terminal.write('browser-smoke', resolve));
      const chart = new window.Chart(document.getElementById('chart'), {
        type: 'bar', data: { labels: ['OK'], datasets: [{ data: [1] }] }, options: { animation: false },
      });
      await document.fonts.load('900 16px "Font Awesome 7 Free"');
      const output = {
        rfb: typeof RFB, cols: terminal.cols,
        terminal: terminal.buffer.active.getLine(0).translateToString(true),
        chart: chart.data.datasets[0].data[0],
        yaml: window.jsyaml.load('ok: true').ok,
        yamlModule: YAML.parse('ok: true').ok,
        font: document.fonts.check('900 16px "Font Awesome 7 Free"'),
      };
      chart.destroy(); terminal.dispose();
      return output;
    });
    assert.equal(result.rfb, 'function');
    assert.ok(result.cols > 0);
    assert.equal(result.terminal, 'browser-smoke');
    assert.equal(result.chart, 1);
    assert.equal(result.yaml, true);
    assert.equal(result.yamlModule, true);
    assert.equal(result.font, true);
    await require('./check-yaml-editor-browser')(page, base);
    assert.deepEqual(failures, []);
    console.log('Browser libraries passed under CSP:', JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
