'use strict';

// Exercise production view routes/auth/CSRF/SQLite and browser code in isolation.
// Only provider inventory is a fixture: this does not claim a live-provider canary.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
Object.assign(process.env, {
  ENV_FILE: path.join(__dirname, `.browser-test-${process.pid}.nonexistent`),
  DB_PATH: ':memory:', APP_ENV: 'test', LOG_LEVEL: 'error',
  APP_SECRET: crypto.randomBytes(32).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  READ_ONLY_MODE: 'false', ENABLE_SSO_HEADERS: 'false', CSRF_DISABLED: 'false', COOKIE_SECURE: 'false',
});
const express = require('express');
const helmet = require('helmet');
const puppeteer = require('puppeteer');
const { getDb, closeDb } = require('../src/db');
const { requireAuth } = require('../src/middleware/auth');
const config = require('../src/config');
const views = require('../src/services/provider-inventory-views');
const permissions = require('../src/services/host-permissions');

async function main() {
  const db = getDb();
  for (const id of [971, 972]) db.prepare(`INSERT INTO users
    (id, username, email, password_hash, role, is_active) VALUES (?, ?, ?, 'not-a-password', 'viewer', 1)`)
    .run(id, `browser-user-${id}`, `browser-${id}@example.test`);
  for (const id of [971, 972]) {
    db.prepare(`INSERT INTO docker_hosts (id, name, connection_type, host, daemon_type, is_active)
      VALUES (?, ?, 'tcp', 'https://provider.invalid', 'proxmox', 1)`).run(id, `Fixture endpoint ${id}`);
    permissions.grant({ hostId: id, userId: 971, permission: 'view' }, 971);
  }
  const actor = db.prepare('SELECT * FROM users WHERE id = 971').get();
  const session = require('../src/services/auth')._createSession(actor, '127.0.0.1', 'browser-smoke');
  const fixture = ['alpha', 'beta', 'stopped'].map((name, index) => ({
    id: `ddr_vm_${String(index + 1).padStart(26, '0')}`, displayName: name,
    status: { powerState: index < 2 ? 'running' : 'stopped', ipAddress: `192.0.2.${index + 1}` },
    spec: { cpuCount: index + 1, memoryBytes: 1073741824 }, observedAt: new Date().toISOString(),
  }));
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], upgradeInsecureRequests: null,
  } } }));
  app.use(express.json(), require('cookie-parser')(), require('../src/middleware/csrf'));
  app.use('/api/providers/inventory-views', require('../src/routes/provider-inventory-views'));
  app.get('/api/hosts', requireAuth, (req, res) => res.json([971, 972]
    .filter(id => permissions.resolveEffectivePermission(req.user.id, id, false))
    .map(id => ({ id, name: `Fixture endpoint ${id}`, isActive: true, daemonType: 'proxmox' }))));
  app.get('/api/providers/:hostId/resources/virtual-machines', requireAuth, (req, res) => {
    if (!permissions.resolveEffectivePermission(req.user.id, Number(req.params.hostId), false)) return res.sendStatus(403);
    res.json({ items: fixture });
  });
  app.get('/smoke', (_req, res) => res.send(`<!doctype html><html><head><link rel="stylesheet" href="/css/app.css"></head><body>
    <main id="page" style="padding:20px"></main><div id="toast-container"></div>
    <div class="modal-overlay hidden" id="modal-overlay"><div class="modal-content" id="modal-content"></div></div>
    ${['utils', 'api', 'i18n', 'i18n/en', 'components/modal', 'components/toast', 'pages/virtual-machines'].map(name => `<script src="/js/${name}.js"></script>`).join('')}
    </body></html>`));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await browser.defaultBrowserContext().setCookie({ name: config.session.cookieName, value: session.token, url: base, httpOnly: true });
    async function enter() {
      await page.goto(`${base}/smoke`);
      await page.evaluate(async () => {
        window.App = { user: { id: 971, role: 'viewer' }, handleUnauthorized() { throw new Error('Unexpected logout'); } };
        await VirtualMachinesPage.render(document.getElementById('page'));
      });
      await page.waitForSelector('#common-vm-content [data-vm-select]');
    }
    const stored = () => views.list('virtual-machines', actor);
    await enter();
    assert.equal(await page.$eval('#common-vm-count', el => el.textContent), '3 of 3 VM(s)');
    await page.select('#common-vm-host', '972');
    await page.select('#common-vm-state', 'running');
    await page.select('#common-vm-sort', 'cpu');
    await page.select('#common-vm-sort-direction', 'desc');
    await page.click('details summary');
    await page.click('[data-vm-column="memory"]');
    await page.click('details summary');
    await page.click('#common-vm-view-save');
    await page.waitForSelector('#modal-overlay.modal-visible #common-vm-view-name');
    await page.type('#common-vm-view-name', 'Production <safe>');
    await page.click('#modal-overlay #common-vm-view-default');
    await page.click('#modal-submit');
    await page.waitForFunction(() => document.querySelector('#common-vm-view')?.value !== '');
    await page.waitForSelector('#modal-overlay.hidden');
    const first = stored()[0];
    assert.equal(first.name, 'Production <safe>');
    assert.equal(first.providerHostId, 972);
    assert.equal(first.isDefault, true);
    assert.equal(first.filters.powerState, 'running');
    assert.equal(first.sort.direction, 'desc');
    assert.ok(!first.columns.includes('memory'));
    await enter();
    assert.equal(await page.$eval('#common-vm-host', el => el.value), '972');
    assert.equal(await page.$eval('#common-vm-view', el => el.value), String(first.id));
    assert.equal(await page.$eval('#common-vm-count', el => el.textContent), '2 of 3 VM(s)');
    assert.deepEqual(await page.$$eval('#common-vm-content strong', els => els.map(el => el.textContent)), ['beta', 'alpha']);
    assert.equal(await page.$eval('[data-vm-column="memory"]', el => el.checked), false);
    await page.click('#common-vm-refresh');
    await page.waitForSelector('#common-vm-content [data-vm-select]');
    assert.equal(await page.$eval('#common-vm-view', el => el.value), String(first.id));
    await page.type('#common-vm-search', 'alpha');
    await page.click('#common-vm-view-update');
    await page.waitForFunction(() => document.querySelector('.toast-success')?.textContent.includes('Updated inventory view'));
    assert.equal(stored()[0].filters.query, 'alpha');
    assert.equal(stored()[0].version, 2);
    // The real route enforces ownership and CSRF, even though the fixture provider is local.
    assert.equal(views.list('virtual-machines', { id: 972, role: 'viewer' }).length, 0);
    const csrfStatus = await page.evaluate(async id => (await fetch(`/api/providers/inventory-views/${id}`, { method: 'DELETE' })).status, first.id);
    assert.equal(csrfStatus, 403);
    // Revoking the saved endpoint must restore the built-in view, not retain its hidden filters.
    db.prepare('DELETE FROM host_permissions WHERE host_id = 972 AND user_id = 971').run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('legacy_host_access_default', 'false')").run();
    await enter();
    assert.equal(await page.$eval('#common-vm-host', el => el.value), '971');
    assert.equal(await page.$eval('#common-vm-view', el => el.value), '');
    assert.equal(await page.$eval('#common-vm-search', el => el.value), '');
    assert.equal(await page.$eval('#common-vm-count', el => el.textContent), '3 of 3 VM(s)');
    // Users can still delete an obsolete personal view after its host permission is revoked.
    await page.select('#common-vm-view', String(first.id));
    assert.equal(await page.$eval('#common-vm-view-update', el => el.disabled), true);
    assert.equal(await page.$$eval('#common-vm-content [data-vm-select]', els => els.length), 0);
    await page.click('#common-vm-view-delete');
    await page.waitForSelector('#modal-overlay.modal-visible #modal-ok');
    await page.click('#modal-ok');
    await page.waitForFunction(() => document.querySelectorAll('#common-vm-view option').length === 1);
    assert.deepEqual(stored(), []);
    assert.deepEqual(errors, []);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'provider_inventory_view_delete'").get().count > 0);
    console.log('Saved inventory views: create, default restore, host/filter/sort/columns, refresh, update, revoked-host fallback, delete, ownership and CSRF passed. Provider data is a fixture.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    closeDb();
  }
}

main().catch(error => { console.error(error); closeDb(); process.exitCode = 1; });
