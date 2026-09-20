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
  app.get('/smoke', (_req, res) => res.send('<!doctype html><html><body><main></main></body></html>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/smoke`);
    for (const script of ['i18n.js', 'i18n/en.js', 'i18n/ro.js', 'utils.js', 'pages/hosts.js', 'pages/ssh-key-deployer.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    for (const language of ['en', 'ro']) {
      const result = await page.evaluate(async lang => {
        i18n._lang = lang;
        window.Toast = { warning(message) { throw new Error(message); }, success() {}, error(message) { throw new Error(message); } };
        const main = document.querySelector('main'), checks = [], ca = 'fixture verified CA';
        const label = i18n.t('pages.hosts.providerCaLabel'), hint = i18n.t('pages.hosts.providerTlsHint');
        for (const type of ['incus', 'lxd', 'proxmox', 'vsphere', 'kubernetes', 'nomad', 'xen']) {
          const providers = type === 'xen' ? ['xo', 'xapi'] : ['default'];
          for (const provider of providers) {
            main.innerHTML = `<input id="ndh-name" value="fixture"><input id="ndh-type" value="${type}">` + HostsPage._renderNonDockerFields(type);
            checks.push(!main.querySelector('[id$="skip-tls"]'));
            checks.push(main.textContent.includes(label) && main.textContent.includes(hint));
            if (main.querySelector('#ndh-transport')) main.querySelector('#ndh-transport').value = 'https';
            const id = type === 'xen' ? `ndh-xen-${provider}-ca` : 'ndh-ca';
            if (type === 'xen') main.querySelector('#ndh-xen-provider').value = provider;
            main.querySelector(`#${id}`).value = ca;
            const config = HostsPage._collectNonDockerFormData(main).daemonConfig;
            checks.push(config.caCert === ca && config.skipTlsVerify === false);
            main.querySelector(`#${id}`).value = '';
            checks.push(HostsPage._collectNonDockerFormData(main).daemonConfig.caCert === undefined);
            main.querySelector(`#${id}-clear`).checked = true;
            checks.push(HostsPage._collectNonDockerFormData(main).daemonConfig.caCert === null);
          }
        }
        let sent, tested;
        HostsPage._load = async () => {};
        window.Api = { updateHost: async (_id, data) => { sent = data; },
          testNonDockerHost: async (type, config, id) => { tested = { type, config, id }; return { ok: true }; } };
        window.Modal = { form: async (html, options) => {
          main.innerHTML = html; options.onMount(main);
          const field = main.querySelector('#ndh-ca');
          checks.push(field.value === '' && field.placeholder.includes('already set'));
          main.querySelector('#ndh-test-btn').click();
          await new Promise(resolve => setTimeout(resolve, 0));
          checks.push(tested?.id === 42 && tested.config.caCert === undefined && tested.config.skipTlsVerify === false);
          field.value = ca;
          return options.onSubmit(main);
        } };
        for (const type of ['incus', 'lxd', 'proxmox', 'vsphere', 'kubernetes', 'nomad']) {
          await HostsPage._editNonDockerHostDialog({ id: 42, name: 'fixture', daemonType: type,
            daemonConfig: { transport: 'https', endpoint: 'https://example.invalid', caCertPresent: true, skipTlsVerify: true } });
          checks.push(sent?.daemonConfig.caCert === ca && sent.daemonConfig.skipTlsVerify === false);
        }
        return { checks, translated: label !== 'pages.hosts.providerCaLabel' && hint !== 'pages.hosts.providerTlsHint' };
      }, language);
      assert.equal(result.translated, true); assert.ok(result.checks.every(Boolean), JSON.stringify(result.checks));
      console.log(`Provider CA, mandatory TLS, preserve/clear trust payload checks passed (${language})`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
