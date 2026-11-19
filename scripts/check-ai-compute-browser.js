'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');

async function main() {
  const app = express();
  app.get('/smoke', (_req, res) => res.send('<!doctype html><link rel="stylesheet" href="/css/app.css"><main id="test" style="padding:24px"></main><div id="modal-overlay" class="modal-overlay hidden"><div id="modal-content" class="modal-content"></div></div>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setViewport({ width: 1440, height: 1100 });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke');
    for (const script of ['/lib/chart.umd.min.js', '/js/utils.js', '/js/components/modal.js', '/js/pages/ai-compute.js']) await page.addScriptTag({ url: base + script });
    await page.evaluate(async () => {
      window.hostId = 9; window.submissions = [];
      window.App = { user: { role: 'admin' }, _hostSelectorHosts: [{ id: 9, name: 'DGX Spark' }, { id: 10, name: 'Other host' }] };
      window.i18n = { t: key => key };
      const c = { id: 'a'.repeat(64), name: 'foliantstudio-vllm', model: 'Qwen/Qwen3-4B', engine: 'vllm', state: 'running', memoryBytes: 24 * 1024 ** 3, profileId: 3, readyPort: 8000, exclusive: true };
      window.Api = {
        getHostId: () => window.hostId,
        get: async url => {
          if (!url.includes(`hostId=${window.hostId}`)) throw new Error('Request crossed hosts');
          if (url.includes('/inventory')) return { hostId: window.hostId, containers: [c], monitoring: false, architecture: 'aarch64' };
          if (url.includes('/metrics')) return { sampledAt: new Date().toISOString(), cpus: 20, cpuPercent: 12, unified: true, memory: { totalBytes: 128 * 1024 ** 3, usedBytes: 45 * 1024 ** 3, availableBytes: 83 * 1024 ** 3 }, disk: { availableBytes: 3 * 1024 ** 4 }, gpu: { name: 'NVIDIA GB10', utilizationPercent: 2, temperatureC: 41 } };
          if (url.includes('/history')) return [0,1,2].map(i => ({ sampledAt: new Date(Date.now() - (2-i)*60000).toISOString(), cpuPercent: i * 5, memory: { usedBytes: 45 * 1024 ** 3 }, gpu: { utilizationPercent: i } }));
          if (url.includes('/jobs')) return [];
          if (url.includes('/catalog')) return [{ id: 'qwen3-4b', name: 'Qwen3-4B', source: 'https://huggingface.co/Qwen/Qwen3-4B', deployable: true, contextLengths: [4096,8192], memoryBytes: 20 * 1024 ** 3, diskBytes: 16 * 1024 ** 3, license: 'Apache-2.0' }, { id: 'ncm', name: 'NCM', source: 'https://github.com/HazyResearch/ncm', deployable: false, reason: 'Requires qualification' }];
          throw new Error('Unexpected URL ' + url);
        },
        post: async (url, data) => {
          window.submissions.push({ url, data });
          if (url.includes('/probe')) return { ready: true, detail: 'Model API ready', checkedAt: new Date().toISOString() };
          if (url.includes('/cache')) return { models: [{ model: 'Qwen/Qwen3-4B', state: 'cached weights present', cachedRevisions: ['revision'] }], note: 'Cache does not imply readiness', checkedAt: new Date().toISOString() };
          if (url.includes('/plans')) return { id: 'plan-1', action: data.action, plan: { target: c, stop: [], expiresAt: new Date(Date.now()+60000).toISOString(), warning: 'Cached weights retained' } };
          return {};
        },
      };
      Modal._init();
      await AIComputePage.render(document.getElementById('test'));
    });
    assert.match(await page.$eval('#compute-host', e => e.textContent), /DGX Spark.*Connected.*aarch64/);
    assert.match(await page.$eval('#compute-metrics', e => e.textContent), /Unified memory/);
    assert.equal(await page.$$eval('#compute-history canvas', nodes => nodes.length), 4);
    assert.equal(await page.$$eval('[data-deploy]', nodes => nodes.length), 1);
    await page.click('[data-probe]');
    await page.waitForFunction(() => document.querySelector('[id^="probe-"]').textContent.includes('Ready'));
    await page.evaluate(() => AIComputePage._refresh());
    assert.match(await page.$eval('[id^="probe-"]', e => e.textContent), /Ready/);
    await page.click('[data-cache]');
    await page.waitForSelector('#cache-close');
    assert.match(await page.$eval('#modal-content', e => e.textContent), /Qwen\/Qwen3-4B.*cached weights/s);
    await page.click('#cache-close');
    await page.select('#compute-range', '24');
    await page.type('#compute-filter', 'not-found');
    assert.equal(await page.$('[data-register]'), null);
    await page.evaluate(async () => { await AIComputePage.render(document.getElementById('test')); });
    assert.equal(await page.$eval('#compute-filter', e => e.value), 'not-found');
    assert.equal(await page.$eval('#compute-range', e => e.value), '24');
    await page.$eval('#compute-filter', el => { el.value = ''; el.dispatchEvent(new Event('input')); });
    await page.click('[data-register]');
    await page.waitForSelector('#compute-form');
    await page.evaluate(() => { window.hostId = 10; return AIComputePage.render(document.getElementById('test')); });
    await page.click('#compute-form [type=submit]');
    await page.waitForFunction(() => document.querySelector('#compute-form-error').textContent.includes('host changed'));
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/profiles')).length), 0);
    await page.click('#compute-cancel');
    assert.match(await page.$eval('#compute-host', e => e.textContent), /Other host/);
    assert.equal(await page.$eval('#compute-range', e => e.value), '1');
    await page.evaluate(() => AIComputePage.destroy());
    assert.equal(await page.evaluate(() => AIComputePage._charts.length), 0);
    assert.deepEqual(errors, []);
    if (process.env.DD_BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.DD_BROWSER_SCREENSHOT, fullPage: true });
    console.log('AI Compute browser: real charts, retained filters, catalog tiers, API/cache states, cross-host form guard and cleanup passed.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
