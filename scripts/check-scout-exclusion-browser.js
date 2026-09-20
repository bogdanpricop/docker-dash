'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const puppeteer = require('puppeteer');

async function main() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], upgradeInsecureRequests: null,
  } } }));
  app.get('/smoke', (_req, res) => res.send('<!doctype html><html><body><button id="trigger">Scan</button><main></main></body></html>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/smoke`);
    for (const script of ['i18n.js', 'i18n/en.js', 'i18n/ro.js', 'utils.js', 'pages/images.js', 'pages/security.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    for (const language of ['en', 'ro']) {
      const result = await page.evaluate(async lang => {
        i18n._lang = lang;
        window.Api = { getScanners: async () => ({ scanners: ['trivy', 'grype'] }) };
        const main = document.querySelector('main');
        await SecurityPage._renderScanners(main);
        const reason = i18n.t('pages.images.scoutDisabledReason');
        const label = i18n.t('pages.images.scoutDisabledLabel');
        const card = { explained: main.textContent.includes(reason), disabled: main.textContent.includes(label), inputs: main.querySelectorAll('input').length };
        const trigger = document.getElementById('trigger');
        const event = { currentTarget: trigger, stopPropagation() {} };
        ImagesPage._showScanMenu(event, 'sha256:test', trigger);
        const imageMenu = { scanners: [...document.querySelectorAll('[data-scanner]')].map(el => el.dataset.scanner), explained: document.querySelector('[role="note"]').textContent.includes(reason) };
        SecurityPage._showScanDropdown(event, 'test');
        const securityMenu = { scanners: [...document.querySelectorAll('[data-scanner]')].map(el => el.dataset.scanner), explained: document.querySelector('[role="note"]').textContent.includes(reason) };
        return { card, imageMenu, securityMenu, translated: reason !== 'pages.images.scoutDisabledReason' };
      }, language);
      assert.equal(result.translated, true);
      assert.deepEqual(result.card, { explained: true, disabled: true, inputs: 0 });
      for (const menu of [result.imageMenu, result.securityMenu]) {
        assert.deepEqual(menu.scanners, ['auto', 'trivy', 'grype']);
        assert.equal(menu.explained, true);
      }
      console.log(`Scout exclusion browser checks passed (${language})`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
