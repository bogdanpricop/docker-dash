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
      window.updatedChannels = [];
      window.smtpWrites = [];
      window.Toast = { success() {}, info() {}, warning() {}, error(message) { throw Error(message); } };
      window.Api = {
        getNotificationChannels: async () => window.createdChannels.map((channel, index) => ({
          ...channel, id: index + 1, is_active: true,
        })),
        getNotificationProviders: async () => catalog,
        createNotificationChannel: async data => window.createdChannels.push(data),
        testNotificationChannel: async id => { window.testedChannels.push(id); return { ok: true }; },
        updateNotificationChannel: async (id, data) => { window.updatedChannels.push({ id, ...data }); },
        getNotificationSmtpSettings: async () => ({
          mode: 'server', external: null, server: { host: 'localhost', port: 587, fromEmail: 'server@example.test' },
        }),
        saveNotificationSmtpSettings: async data => { window.smtpWrites.push(data); },
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
      assert.equal(Boolean(await page.$('[data-nc-smtp]')), provider.id === 'email');
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
    await page.click('[data-action="edit-nc"][data-id="1"]');
    assert.equal(await page.$eval('#nc-provider', el => el.disabled), true);
    assert.equal(await page.$eval('#nc-config-to', el => el.value), 'team@example.test');
    await page.$eval('#nc-config-to', el => { el.value = 'oncall@example.test'; });
    await page.click('[data-nc-smtp]');
    await page.waitForSelector('#modal-sub-content #nc-smtp-mode');
    await page.select('#nc-smtp-mode', 'external');
    await page.select('#nc-smtp-security', 'tls');
    assert.equal(await page.$eval('#nc-smtp-port', el => el.value), '465');
    await page.type('#nc-smtp-host', 'smtp.example.test');
    await page.type('#nc-smtp-from', 'sender@example.test');
    await page.click('#nc-smtp-form [type="submit"]');
    await page.waitForSelector('#modal-sub-overlay.hidden');
    assert.deepEqual(await page.evaluate(() => window.smtpWrites[0]), {
      mode: 'external', host: 'smtp.example.test', port: 465, security: 'tls',
      user: '', password: '', fromEmail: 'sender@example.test', fromName: '',
    });
    assert.equal(await page.$eval('#nc-config-to', el => el.value), 'oncall@example.test');
    await page.click('#modal-submit');
    await page.waitForFunction(() => window.updatedChannels.length === 1);
    assert.deepEqual(await page.evaluate(() => window.updatedChannels[0]), {
      id: 1, name: 'Team email', configPatch: { to: 'oncall@example.test' },
    });
    assert.deepEqual(errors, []);
    console.log('Notification channel create/edit, validation, and external SMTP settings passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
