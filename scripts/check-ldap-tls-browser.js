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
    for (const script of ['i18n.js', 'i18n/en.js', 'i18n/ro.js', 'utils.js', 'pages/settings-ldap.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    for (const language of ['en', 'ro']) {
      const result = await page.evaluate(async lang => {
        i18n._lang = lang;
        const checks = [], main = document.querySelector('main');
        const label = i18n.t('pages.settings.ldapTransportLabel'), hint = i18n.t('pages.settings.ldapTlsHint');
        const cfg = { configured: true, host: 'ldap.example.invalid', port: 389, tls: false,
          tlsSkipVerify: true, caCertPresent: true, bindDn: 'cn=service,dc=fixture', baseDn: 'dc=fixture' };
        let tested, saved;
        window.Api = { getLdapConfig: async () => cfg, testLdapConnection: async data => { tested = data; return { usersFound: 1 }; },
          saveLdapConfig: async data => { saved = data; } };
        window.Toast = { success() {}, warning(message) { throw Error(message); }, error(message) { throw Error(message); } };
        await SettingsPageLdap._renderLdap(main);
        checks.push(!main.querySelector('#ldap-skip-verify') && main.textContent.includes(label) && main.textContent.includes(hint));
        checks.push(main.querySelector('#ldap-ca').placeholder === i18n.t('pages.settings.ldapCaUnchanged'));
        main.querySelector('#ldap-test').click(); await new Promise(resolve => setTimeout(resolve, 0));
        checks.push(tested?.tls === false && tested.tlsSkipVerify === false && tested.bindPassword === '' && tested.caCert === undefined);
        const transport = main.querySelector('#ldap-tls'); transport.value = 'ldaps'; transport.dispatchEvent(new Event('change'));
        checks.push(main.querySelector('#ldap-port').value === '636');
        main.querySelector('#ldap-ca').value = 'verified fixture CA';
        main.querySelector('#ldap-save').click(); await new Promise(resolve => setTimeout(resolve, 0));
        checks.push(saved?.tls === true && saved.tlsSkipVerify === false && saved.caCert === 'verified fixture CA' && saved.bindPassword === '');
        main.querySelector('#ldap-ca-clear').checked = true;
        main.querySelector('#ldap-test').click(); await new Promise(resolve => setTimeout(resolve, 0));
        checks.push(tested?.caCert === null);
        main.querySelector('#ldap-port').value = '1636'; main.querySelector('#ldap-tls').value = 'ldaps';
        main.querySelector('#ldap-tls').dispatchEvent(new Event('change'));
        checks.push(main.querySelector('#ldap-port').value === '1636');
        return { checks, translated: label !== 'pages.settings.ldapTransportLabel' && hint !== 'pages.settings.ldapTlsHint' };
      }, language);
      assert.equal(result.translated, true); assert.ok(result.checks.every(Boolean), JSON.stringify(result.checks));
      console.log(`LDAP verified transport, stored credential test, CA preservation/removal and port checks passed (${language})`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
