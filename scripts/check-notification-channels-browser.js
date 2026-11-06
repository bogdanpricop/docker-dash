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
    for (const script of ['i18n.js', 'i18n/en.js', 'utils.js', 'components/modal.js',
      'pages/settings-logforwarding.js', 'pages/settings.js']) {
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
    await page.click('[data-action="smtp-nc"]');
    await page.waitForSelector('#modal-content #nc-smtp-mode');
    assert.equal(await page.$eval('#nc-smtp-mode', el => el.value), 'server');
    await page.click('[data-nc-smtp-cancel]');
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
    await page.locator('#nc-smtp-host').fill('smtp.example.test');
    await page.locator('#nc-smtp-from').fill('sender@example.test');
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
    await page.waitForSelector('#modal-overlay.hidden');
    await page.click('[data-action="smtp-nc"]');
    await page.waitForSelector('#modal-content #nc-smtp-mode');
    await page.select('#nc-smtp-mode', 'external');
    await page.locator('#nc-smtp-user').fill('test-user');
    await page.locator('#nc-smtp-password').fill('fixture-password');
    await page.select('#nc-smtp-security', 'none');
    assert.equal(await page.$eval('#nc-smtp-port', el => el.value), '25');
    assert.equal(await page.$eval('#nc-smtp-relay-hint', el => el.hidden), false);
    assert.equal(await page.$eval('#nc-smtp-user', el => el.disabled), true);
    assert.equal(await page.$eval('#nc-smtp-password', el => el.disabled), true);
    await page.locator('#nc-smtp-host').fill('relay.example.test');
    await page.locator('#nc-smtp-from').fill('sender@example.test');
    await page.click('#nc-smtp-form [type="submit"]');
    await page.waitForSelector('#modal-overlay.hidden');
    assert.deepEqual(await page.evaluate(() => window.smtpWrites[1]), {
      mode: 'external', host: 'relay.example.test', port: 25, security: 'none',
      user: '', password: '', fromEmail: 'sender@example.test', fromName: '',
    });
    console.log('Notification channel create/edit, validation, and external SMTP settings passed.');
    await checkSettingsForms(page);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function checkSettingsForms(page) {
  await page.waitForSelector('#modal-overlay.hidden');
  await page.evaluate(async () => {
    window.settingsWrites = [];
    window.formErrors = [];
    Toast.error = message => window.formErrors.push(message);
    Api.get = async () => [];
    Api.post = async (route, data) => {
      if (route === '/secrets' && window.formErrors.length === 1) throw new Error('Name already exists');
      window.settingsWrites.push([route, data]);
    };
    SettingsPage._tab = 'log-forwarding';
    await SettingsPage._renderTab();
  });
  await page.click('#lf-create');
  await page.locator('#lf-name').fill('Example logs');
  await page.locator('#lf-url').fill('https://logs.example.test/');
  await page.locator('#lf-headers').fill('invalid JSON');
  await page.click('#modal-submit');
  assert.equal(await page.evaluate(() => window.formErrors[0]), 'Custom headers must be a JSON object');
  await page.select('#lf-type', 'syslog');
  await page.locator('#lf-host').fill('syslog.example.test');
  await page.locator('#lf-port').fill('1514');
  await page.select('#lf-protocol', 'tcp');
  await page.click('#modal-submit');
  await page.waitForSelector('#modal-overlay.hidden');
  assert.deepEqual(await page.evaluate(() => window.settingsWrites[0]), ['/log-forwarders', {
    name: 'Example logs', type: 'syslog', config: { host: 'syslog.example.test', port: 1514, protocol: 'tcp' },
  }]);
  await page.evaluate(async () => {
    SettingsPage._tab = 'secrets';
    await SettingsPage._renderTab();
  });
  await page.click('#secret-create');
  await page.locator('#sec-name').fill('Invalid name');
  await page.locator('#sec-value').fill('fixture-value');
  await page.click('#modal-submit');
  assert.equal(await page.$eval('#sec-name', input => input.validity.patternMismatch), true);
  await page.locator('#sec-name').fill('MY-SECRET_01');
  await page.click('#modal-submit');
  await page.waitForFunction(() => window.formErrors.length === 2);
  assert.equal(await page.$eval('#sec-value', input => input.value), 'fixture-value');
  await page.click('#modal-submit');
  await page.waitForSelector('#modal-overlay.hidden');
  assert.deepEqual(await page.evaluate(() => window.settingsWrites[1]), ['/secrets', {
    name: 'MY-SECRET_01', description: '', value: 'fixture-value',
  }]);
  console.log('Log Forwarding and Secrets create forms passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
