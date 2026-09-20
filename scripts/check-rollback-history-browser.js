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
    for (const script of ['i18n.js', 'i18n/en.js', 'i18n/ro.js', 'utils.js', 'pages/container-detail.js']) {
      await page.addScriptTag({ url: `${base}/js/${script}` });
    }
    for (const language of ['en', 'ro']) {
      const result = await page.evaluate(async lang => {
        i18n._lang = lang;
        const main = document.querySelector('main'), attack = '<img src=x>', attr = '" onclick="window.historyAttack=1';
        for (const input of [attack, attr, "' onmouseover='alert(1)", '&quot; < & > " \'']) {
          const probe = document.createElement('div');
          const escaped = Utils.escapeHtml(input);
          probe.innerHTML = `<span title="${escaped}" data-fixture='${escaped}'>${escaped}</span>`;
          const element = probe.firstElementChild;
          if (element.attributes.length !== 2 || element.title !== input || element.dataset.fixture !== input
            || element.textContent !== input || element.children.length) throw Error('HTML escaping changed data or created markup');
        }
        window.Api = { getContainerHistory: async () => ({ currentImage: 'current-image', currentImageId: 'current',
          entries: [{ id: attr, image_id: attack, image_name: attack, action: attack,
            deployed_by: attack, deployed_at: '2026-09-20', imageAvailable: true }] }) };
        window.Toast = { error(message) { throw Error(message); } };
        let closed = false;
        window.Modal = { _content: main, open(html) { main.innerHTML = html; }, close() { closed = true; } };
        await ContainersPageDetail._rollbackDialog('fixture', 'fixture');
        const hint = i18n.t('pages.containers.rollbackSnapshotHint');
        const safe = !main.querySelector('img, [onclick]') && main.querySelector('.rollback-btn').dataset.historyId === attr
          && main.textContent.includes(attack);
        const guide = main.querySelector('#rollback-history-guide');
        const translated = !hint.startsWith('pages.') && main.textContent.includes(hint)
          && guide.textContent === i18n.t('pages.containers.rollbackSnapshotGuide');
        guide.click();
        return { safe, translated, closed, link: guide.getAttribute('href') };
      }, language);
      assert.deepEqual(result, { safe: true, translated: true, closed: true, link: '#/howto/rollback-history' });
      console.log(`PASS rollback history escapes stored metadata and explains encrypted recovery (${language})`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
