'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');
const { entries } = require('../src/services/ai-compute-catalog');

async function main() {
  const app = express();
  app.get('/smoke', (_req, res) => res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/app.css"><main id="test" style="padding:24px"><div id="compute-catalog" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px"></div></main><div id="modal-overlay" class="modal-overlay hidden"><div id="modal-content" class="modal-content"></div></div>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 1000 });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke');
    for (const script of ['/js/utils.js', '/js/components/modal.js', '/js/pages/ai-compute.js']) await page.addScriptTag({ url: base + script });
    await page.evaluate(models => {
      window.models = models;
      AIComputePage._container = document.getElementById('test');
      AIComputePage._token = {};
      AIComputePage._activeJob = null;
      AIComputePage._catalog(models);
    }, entries);
    assert.equal(await page.$$eval('[data-model-info]', e => e.length), entries.length);
    assert.equal(await page.$$eval('[data-deploy]', e => e.length), 19);
    assert.equal(await page.$$eval('[data-download]', e => e.length), 18);
    for (const entry of entries) {
      await page.click(`[data-model-info="${entry.id}"]`);
      await page.waitForSelector('#compute-model-info-close');
      const result = await page.$eval('#modal-content', e => ({ text: e.textContent, links: [...e.querySelectorAll('a')].map(a => ({ href: a.href, rel: a.rel })) }));
      assert.ok(result.text.includes(entry.details.problem));
      assert.ok(result.text.includes(entry.details.summary));
      assert.match(result.text, /Problem it can solve.*What integration requires.*About the model.*Sources/s);
      assert.ok(result.links.length >= 1);
      assert.ok(result.links.every(a => a.rel.includes('noopener') && a.rel.includes('noreferrer')));
      if (entry.integrationRequired) assert.match(result.text, /Integration required.*not enabled/s);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('compute-model-info-close'));
      await page.waitForFunction(id => document.activeElement.dataset.modelInfo === id, { timeout: 4000 }, entry.id).catch(async err => { throw new Error(entry.id + ' focus: ' + JSON.stringify(await page.evaluate(() => ({ active: document.activeElement.outerHTML.slice(0, 500), overlay: document.getElementById('modal-overlay').className, inert: document.getElementById('modal-overlay').hasAttribute('inert') }))) + ': ' + err.message); });
    }
    // Information remains accessible while mutation actions are locked, even after a catalog repaint.
    await page.evaluate(() => { AIComputePage._activeJob = { id: 'active' }; AIComputePage._catalog(models); });
    assert.equal(await page.$eval('[data-deploy]', e => e.disabled), true);
    await page.focus('[data-model-info="piper-ro-mihai"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#compute-model-info-close');
    assert.match(await page.$eval('#modal-content', e => e.textContent), /Romanian.*Piper 1.5\+/s);
    await page.evaluate(() => AIComputePage._catalog(models));
    await page.click('#compute-model-info-close');
    await page.waitForFunction(() => !document.getElementById('compute-model-info-close') && document.activeElement.dataset.modelInfo === 'piper-ro-mihai');
    // Text is escaped, and source links cannot turn trusted descriptions into executable markup.
    await page.evaluate(() => {
      const model = structuredClone(models[0]);
      model.name = '<img src=x onerror=alert(1)>';
      model.source = 'javascript:alert(1)';
      model.details.problem = '<img src=x onerror=alert(1)>';
      model.details.integration = ['<script>alert(1)</script>'];
      model.details.summary = '<svg onload=alert(1)>';
      model.details.sources = [{ label: 'bad', url: 'javascript:alert(1)' }];
      AIComputePage._catalog([model]);
    });
    assert.equal(await page.$('#compute-catalog img'), null);
    assert.equal(await page.$('#compute-catalog a'), null);
    await page.click('[data-model-info]');
    assert.equal(await page.$('#modal-content img, #modal-content svg, #modal-content script, #modal-content a'), null);
    assert.match(await page.$eval('#modal-content', e => e.textContent), /<svg onload/);
    assert.deepEqual(await page.evaluate(() => ['http://ollama.com/a', 'https://ollama.com.evil.test/a', 'https://user:password@huggingface.co/a', 'https://huggingface.co:8443/a', '/relative'].map(u => AIComputePage._modelLink(u))), [null, null, null, null, null]);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('compute-model-info-close'));
    await page.evaluate(() => AIComputePage._catalog(models));
    await page.click('[data-model-info="flux2-klein4b"]');
    await page.screenshot({ path: path.join(os.tmpdir(), 'dd-model-info-desktop.png') });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'dd-model-info-mobile.png') });
    assert.ok(await page.$eval('#modal-content', e => e.scrollWidth <= e.clientWidth + 1));
    assert.ok(await page.$eval('#compute-model-info-close', e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('compute-model-info-close'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(`AI catalog browser: all ${entries.length} dialogs, source attribution, keyboard/focus, active-job access, XSS/link protection and mobile layout passed.`);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
