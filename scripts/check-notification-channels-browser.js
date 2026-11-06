'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');
const { getProviders } = require('../src/services/notificationChannels');

async function main() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"], upgradeInsecureRequests: null,
  } } }));
  app.get('/smoke', (_req, res) => res.send('<main id="settings-content"></main><div id="modal-overlay" class="hidden"><div id="modal-content"></div></div>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/smoke`);
    for (const script of ['i18n.js', 'i18n/en.js', 'utils.js', 'components/modal.js', 'pages/settings.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    const providers = getProviders();
    await page.evaluate(async catalog => {
      window.createdChannels = [];
      window.testedChannels = [];
      window.Toast = { success() {}, info() {}, warning() {}, error(message) { throw Error(message); } };
      window.Api = {
        getNotificationChannels: async () => window.createdChannels.map((channel, index) => ({
          ...channel, id: index + 1, is_active: true,
        })),
        getNotificationProviders: async () => catalog,
        createNotificationChannel: async data => window.createdChannels.push(data),
        testNotificationChannel: async id => { window.testedChannels.push(id); return { ok: true }; },
      };
      SettingsPage._tab = 'notifications';
      await SettingsPage._renderTab();
    }, providers);
    await page.click('#nc-create');
    assert.equal(await page.$eval('#nc-fields', el => el.querySelectorAll('input').length), providers[0].fields.length);
    for (const provider of providers) {
      await page.select('#nc-provider', provider.id);
      const fields = await page.$$eval('#nc-fields input', inputs => inputs.map(input => [input.dataset.configKey, input.required]));
      assert.deepEqual(fields, provider.fields.map(field => [field.key, Boolean(field.required)]), provider.id);
    }
    await page.type('#nc-name', 'Team email');
    await page.select('#nc-provider', 'email');
    await page.click('#modal-submit');
    assert.equal(await page.evaluate(() => window.createdChannels.length), 0, 'Missing recipient must not save');
    await page.type('[data-config-key="to"]', 'not-an-email');
    await page.click('#modal-submit');
    assert.equal(await page.evaluate(() => window.createdChannels.length), 0, 'Invalid recipient must not save');
    await page.$eval('[data-config-key="to"]', input => { input.value = 'team@example.test'; });
    await page.click('#modal-submit');
    await page.waitForFunction(() => window.createdChannels.length === 1);
    assert.deepEqual(await page.evaluate(() => window.createdChannels[0]), {
      name: 'Team email', provider: 'email', config: { to: 'team@example.test' },
    });
    await page.waitForSelector('#modal-overlay.hidden');
    await page.click('[data-action="test-nc"]');
    assert.deepEqual(await page.evaluate(() => window.testedChannels), [1], 'Test sends once after refreshing the list');
    assert.deepEqual(errors, []);
    console.log('Notification channel fields render for every provider and validate before save.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
