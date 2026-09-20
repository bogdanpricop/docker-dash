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
        window.Toast = { warning(message) { throw new Error(message); } };
        const main = document.querySelector('main'), pin = 'ab'.repeat(32), checks = [];
        const label = i18n.t('pages.hosts.sshHostKeyLabel'), hint = i18n.t('pages.hosts.sshHostKeyHint');
        main.innerHTML = HostsPage._buildFormHtml({ type: 'ssh', name: 'test', sshHost: 'example.invalid',
          sshUsername: 'fixture', sshHostKeySha256: pin });
        checks.push(HostsPage._collectFormData(main).sshHostKeySha256 === pin);
        checks.push(main.textContent.includes(label) && main.textContent.includes(hint));
        let sent;
        window.Api = { testHostConnection: async data => { sent = data; return { ok: true }; } };
        HostsPage._setupFormToggle(main, 42);
        main.querySelector('#h-test-btn').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        checks.push(sent?.hostId === 42 && sent?.sshHostKeySha256 === pin);
        for (const type of ['vsphere', 'proxmox', 'xen']) {
          main.innerHTML = `<input id="ndh-name" value="fixture"><input id="ndh-type" value="${type}">` + HostsPage._renderNonDockerFields(type);
          if (type === 'xen') {
            main.querySelector('#ndh-xen-provider').value = 'raw';
            main.querySelector('#ndh-xen-ssh-host').value = 'example.invalid';
            main.querySelector('#ndh-xen-ssh-username').value = 'fixture';
            main.querySelector('#ndh-xen-host-key').value = pin;
          } else {
            main.querySelector('#ndh-endpoint').value = 'https://example.invalid';
            main.querySelector('#ndh-ssh-host-key').value = pin;
          }
          const data = HostsPage._collectNonDockerFormData(main);
          checks.push((type === 'xen' ? data.daemonConfig.hostKeySha256 : data.daemonConfig.sshConfig.hostKeySha256) === pin);
          checks.push(main.textContent.includes(label) && main.textContent.includes(hint));
        }
        main.innerHTML = '<div id="skd-body"></div>';
        window.Modal = { _content: main };
        SshKeyDeployer._target = 'linux'; SshKeyDeployer._render();
        main.querySelector('#skd-host-key').value = pin;
        checks.push(SshKeyDeployer._connFromForm().hostKeySha256 === pin);
        checks.push(main.textContent.includes(label) && main.textContent.includes(hint));
        main.innerHTML = HostsPage._sshTrustField('test-pin', '"><img src=x onerror=alert(1)>');
        checks.push(main.querySelectorAll('img').length === 0);
        return { checks, translated: label !== 'pages.hosts.sshHostKeyLabel' && hint !== 'pages.hosts.sshHostKeyHint' };
      }, language);
      assert.equal(result.translated, true); assert.ok(result.checks.every(Boolean), JSON.stringify(result.checks));
      console.log(`SSH identity form, edit/test payload and escaped explanation checks passed (${language})`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
