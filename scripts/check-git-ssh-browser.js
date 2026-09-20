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
    for (const script of ['i18n.js', 'i18n/en.js', 'i18n/ro.js', 'utils.js', 'pages/settings-git.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    for (const language of ['en', 'ro']) {
      const result = await page.evaluate(async lang => {
        i18n._lang = lang;
        const checks = [], warnings = [];
        window.Toast = { warning: message => warnings.push(message), success() {}, error(message) { throw new Error(message); } };
        const main = document.querySelector('main');
        const trust = 'git.example.invalid ssh-ed25519 fixture';
        const label = i18n.t('pages.settings.gitKnownHostsLabel'), hint = i18n.t('pages.settings.gitKnownHostsHint');
        let submitted, credential = { id: 1, name: 'fixture', auth_type: 'ssh_key', ssh_known_hosts: trust };
        window.Api = { createGitCredential: async data => { submitted = data; }, getGitCredentials: async () => [credential],
          updateGitCredential: async (_id, data) => { submitted = data; } };
        SettingsPageGit._renderTab = async () => {};
        window.Modal = { form: async (html, options) => {
          main.innerHTML = html;
          checks.push(main.textContent.includes(label) && main.textContent.includes(hint));
          options.onOpen?.(main);
          if (main.querySelector('#gc-auth-type')) {
            main.querySelector('#gc-name').value = 'fixture';
            main.querySelector('#gc-auth-type').value = 'ssh_key';
            main.querySelector('#gc-auth-type').dispatchEvent(new Event('change'));
            checks.push(main.querySelector('#gc-ssh-fields').style.display !== 'none');
            main.querySelector('#gc-ssh-key').value = 'private-fixture';
            checks.push(options.onSubmit(main) === false);
            main.querySelector('#gc-known-hosts').value = trust;
          } else {
            checks.push(main.querySelector('#gc-known-hosts').value === trust);
            main.querySelector('#gc-known-hosts').value = 'updated ' + trust;
          }
          return options.onSubmit(main);
        } };
        await SettingsPageGit._createGitCredentialDialog();
        checks.push(submitted?.ssh_known_hosts === trust && submitted?.ssh_private_key === 'private-fixture');
        await SettingsPageGit._editGitCredential(1);
        checks.push(submitted?.ssh_known_hosts === 'updated ' + trust && !('ssh_private_key' in submitted));
        checks.push(warnings.length === 1 && warnings[0] === i18n.t('pages.settings.gitKnownHostsRequired'));
        main.innerHTML = SettingsPageGit._gitKnownHostsField('</textarea><img src=x onerror=alert(1)>');
        checks.push(main.querySelectorAll('img').length === 0);
        return { checks, translated: label !== 'pages.settings.gitKnownHostsLabel' && hint !== 'pages.settings.gitKnownHostsHint' };
      }, language);
      assert.equal(result.translated, true); assert.ok(result.checks.every(Boolean), JSON.stringify(result.checks));
      console.log(`Git known_hosts create/edit payload, required trust and escaped explanation checks passed (${language})`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
