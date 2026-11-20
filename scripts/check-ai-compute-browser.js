'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');

async function main() {
  const app = express();
  app.get('/smoke', (_req, res) => res.send('<!doctype html><link rel="stylesheet" href="/css/app.css"><main id="test" style="padding:24px"></main><div id="modal-overlay" class="modal-overlay hidden"><div id="modal-content" class="modal-content"></div></div>'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setViewport({ width: 1440, height: 1100 });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/smoke');
    for (const script of ['/lib/chart.umd.min.js', '/js/utils.js', '/js/components/modal.js', '/js/pages/ai-compute.js']) await page.addScriptTag({ url: base + script });
    await page.evaluate(async () => {
      window.hostId = 0; window.submissions = []; window.computeRequests=[];
      window.computeHosts=[{ id:9,name:'DGX Spark',recommended:true,reason:'GPU detected' },{ id:10,name:'Other host',recommended:false,reason:'SSH configured' }];
      window.App = { user: { role: 'admin' }, _hostSelectorHosts: [{ id: 9, name: 'DGX Spark' }, { id: 10, name: 'Other host' }],
        _initHostSelector:async()=>{},_activateHost:(id,route)=>{window.fullLogsNavigation={id,route};} };
      window.i18n = { t: key => key };
      const c = { id: 'a'.repeat(64), name: 'foliantstudio-vllm', model: 'Qwen/Qwen3-4B', engine: 'vllm', state: 'running', memoryBytes: 24 * 1024 ** 3, profileId: 3, readyPort: 8000, exclusive: true };
      window.computeWorkload = c; window.computeJobs = []; window.jobReads = []; window.planNumber = 0;
      window.Api = {
        getHostId: () => window.hostId,
        request: async (method, url) => { if (method !== 'GET') throw new Error('Unexpected poll method'); return window.Api.get(url); },
        get: async url => {
          if(url==='/ai-compute/hosts')return window.computeHosts;
          window.computeRequests.push(url);
          const requested=Number(new URL(url,'http://test').searchParams.get('hostId'));
          if(![9,10].includes(requested))throw new Error('Compute request did not select its own host');
          if(url.includes('/containers/'))return {lines:['safe <img src=x onerror=alert(1)> log'],truncated:false};
          if (url.includes('/inventory')) {
            if (window.failOperationInventory && AIComputePage._syncingOperation) { window.failOperationInventory = false; throw new Error('Temporary Docker connection outage'); }
            return { hostId: requested, containers: [c], monitoring: false, architecture: 'aarch64' };
          }
          if (url.includes('/metrics')) {
            if (window.failMetrics) throw new Error('Metrics unavailable');
            return { sampledAt: new Date().toISOString(), cpus: 20, cpuPercent: 12, unified: true, memory: { totalBytes: 128 * 1024 ** 3, usedBytes: 45 * 1024 ** 3, availableBytes: 83 * 1024 ** 3 }, disk: { availableBytes: 3 * 1024 ** 4 }, gpu: { name: 'NVIDIA GB10', utilizationPercent: 2, temperatureC: 41 } };
          }
          if (url.includes('/history')) return [0,1,2].map(i => ({ sampledAt: new Date(Date.now() - (2-i)*60000).toISOString(), cpuPercent: i * 5, memory: { usedBytes: 45 * 1024 ** 3 }, gpu: { utilizationPercent: i } }));
          if (url.includes('/jobs/')) {
            window.jobReads.push({ url, at: performance.now() });
            if (window.failNextJob) { window.failNextJob = false; throw Object.assign(new Error('Temporary status connection outage'), { status: 503, body: { retryAfter: 'invalid' } }); }
            const id = new URL(url, 'http://test').pathname.split('/').at(-1);
            const job = structuredClone(window.computeJobs.find(job => job.id === id && job.hostId === requested));
            if (window.deferJob) await new Promise(resolve => { window.resolveJob = resolve; });
            if (!job) throw Object.assign(new Error('Operation not found'), { status: 404 });
            return job;
          }
          if (url.includes('/jobs')) return structuredClone(window.computeJobs.filter(job => job.hostId === requested));
          if (url.includes('/catalog')) return [{ id: 'qwen3-4b', name: 'Qwen3-4B', source: 'https://huggingface.co/Qwen/Qwen3-4B', deployable: true, contextLengths: [4096,8192], memoryBytes: 20 * 1024 ** 3, diskBytes: 16 * 1024 ** 3, license: 'Apache-2.0' }, { id: 'ncm', name: 'NCM', source: 'https://github.com/HazyResearch/ncm', deployable: false, reason: 'Requires qualification' }];
          throw new Error('Unexpected URL ' + url);
        },
        post: async (url, data) => {
          window.submissions.push({ url, data });
          if (url.includes('/probe')) return { ready: true, detail: 'Model API ready', checkedAt: new Date().toISOString() };
          if (url.includes('/cache')) return { models: [{ model: 'Qwen/Qwen3-4B', state: 'cached weights present', cachedRevisions: ['revision'] }], note: 'Cache does not imply readiness', checkedAt: new Date().toISOString() };
          if (url.includes('/profiles')) {
            if (window.deferProfile) await new Promise(resolve => { window.resolveProfile = resolve; });
            c.profileId = 3;
            return { containers: [c] };
          }
          if (url.includes('/execute')) { window.computeJobs = [{ ...structuredClone(window.preparedPlan), hostId: 9, status: 'queued' }]; return structuredClone(window.computeJobs[0]); }
          if (url.includes('/plans')) { window.preparedPlan = { id: 'plan-' + ++window.planNumber, action: data.action, updatedAt: new Date().toISOString(), plan: { target: c, stop: [], expiresAt: new Date(Date.now()+60000).toISOString(), warning: 'Cached weights retained' } }; return structuredClone(window.preparedPlan); }
          return {};
        },
      };
      Modal._init();
      await AIComputePage.render(document.getElementById('test'));
    });
    assert.match(await page.$eval('#compute-host', e => e.textContent), /DGX Spark.*Connected.*aarch64/);
    assert.equal(await page.evaluate(()=>window.hostId),0);
    await page.evaluate(async()=>{window.hostId=10;await AIComputePage.render(document.getElementById('test'));});
    assert.equal(await page.$eval('#compute-target',e=>e.value),'9');
    assert.equal(await page.evaluate(()=>window.hostId),10);
    await page.click('[data-logs]');
    await page.waitForSelector('#compute-logs-close');
    assert.match(await page.$eval('#modal-content pre',e=>e.textContent),/<img/);
    assert.equal(await page.$('#modal-content img'),null);
    assert.equal(await page.evaluate(()=>computeRequests.filter(u=>u.includes('/containers/')).at(-1).endsWith('hostId=9')),true);
    await page.click('#compute-full-logs');
    await page.waitForFunction(()=>window.fullLogsNavigation);
    assert.deepEqual(await page.evaluate(()=>window.fullLogsNavigation),{id:9,route:'#/containers/'+'a'.repeat(64)+'/logs'});
    assert.match(await page.$eval('#compute-metrics', e => e.textContent), /Unified memory/);
    assert.equal(await page.$$eval('#compute-history canvas', nodes => nodes.length), 4);
    assert.equal(await page.evaluate(() => AIComputePage._charts[0].options.scales.x.type), 'linear');
    assert.equal(await page.evaluate(() => typeof AIComputePage._charts[0].data.datasets[0].data[0].x), 'number');
    assert.equal(await page.$$eval('[data-deploy]', nodes => nodes.length), 1);
    await page.click('[data-probe]');
    await page.waitForFunction(() => document.querySelector('[id^="probe-"]').textContent.includes('Ready'));
    await page.evaluate(() => AIComputePage._refresh());
    assert.match(await page.$eval('[id^="probe-"]', e => e.textContent), /Ready/);
    await page.click('[data-cache]');
    await page.waitForSelector('#cache-close');
    assert.match(await page.$eval('#modal-content', e => e.textContent), /Qwen\/Qwen3-4B.*cached weights/s);
    await page.click('#cache-close');
    // Detected services expose controls before a profile has been registered.
    await page.evaluate(async () => { computeWorkload.profileId = null; await AIComputePage._refresh(); });
    assert.equal(await page.$$eval('[data-operation="stop"]', nodes => nodes.length), 1);
    assert.equal(await page.$$eval('[data-operation="restart"]', nodes => nodes.length), 1);
    const plansBefore = await page.evaluate(() => submissions.filter(s => s.url.includes('/plans')).length);
    await page.click('[data-operation="stop"]');
    await page.waitForSelector('#compute-form');
    assert.match(await page.$eval('#compute-form', e => e.textContent), /Saving this profile does not start or stop/);
    await page.click('#compute-cancel');
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/profiles')).length), 0);
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/plans')).length), plansBefore);
    await page.click('[data-operation="stop"]');
    await page.waitForSelector('#compute-form');
    await page.click('#compute-form [type=submit]');
    await page.waitForSelector('#modal-ok');
    assert.match(await page.$eval('#modal-content', e => e.textContent), /unloads all models.*Requests.*interrupted/s);
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/execute')).length), 0);
    assert.deepEqual(await page.evaluate(() => submissions.filter(s => s.url.includes('/plans')).at(-1)), { url: '/ai-compute/plans?hostId=9', data: { action: 'stop', profileId: 3 } });
    await page.click('#modal-ok');
    await page.waitForFunction(() => document.querySelector('[data-operation="stop"]').disabled);
    assert.match(await page.$eval('#compute-jobs', e => e.textContent), /queued/);
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/execute')).length), 1);
    assert.match(await page.$eval('#compute-operation', e => e.textContent), /Queued.*every 2 seconds/s);
    await page.evaluate(() => { computeJobs[0].status = 'running'; });
    await page.waitForFunction(() => document.querySelector('#compute-operation').textContent.includes('Stopping service'), { timeout: 4000 });
    await page.evaluate(() => { window.failNextJob = true; });
    await page.waitForFunction(() => document.querySelector('#compute-operation').textContent.includes('Retrying automatically'), { timeout: 4000 });
    assert.equal(await page.$eval('[data-operation="stop"]', e => e.disabled), true);
    await page.waitForFunction(() => !document.querySelector('#compute-operation').textContent.includes('Retrying automatically'), { timeout: 4000 });
    // Completion refreshes service state without a full page refresh; a Docker outage retries separately.
    await page.evaluate(() => { computeJobs[0].status = 'completed'; computeWorkload.state = 'exited'; window.failOperationInventory = true; });
    await page.waitForFunction(() => document.querySelector('#compute-operation').textContent.includes('Could not refresh service state'), { timeout: 4000 });
    await page.waitForFunction(() => document.querySelector('[data-operation="start"]') && !document.querySelector('[data-operation="start"]').disabled, { timeout: 4000 });
    assert.match(await page.$eval('#compute-operation', e => e.textContent), /Operation completed.*Service state has been refreshed/s);
    assert.equal(await page.evaluate(() => jobReads.length >= 4 && jobReads.slice(1).every((r,i) => r.at-jobReads[i].at >= 1900)), true);
    // Cancelling the next Start preview submits no operation.
    assert.equal(await page.$('[data-operation="stop"]'), null);
    await page.click('[data-operation="start"]');
    await page.waitForSelector('#modal-ok');
    assert.equal(await page.$eval('#modal-ok', e => e.textContent.trim()), 'Start service');
    await page.click('#modal-cancel');
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/execute')).length), 1);
    // First-use Start also guides through profile review and a separate confirmation.
    await page.evaluate(async () => { computeWorkload.profileId = null; await AIComputePage._refresh(); });
    await page.click('[data-operation="start"]');
    await page.waitForSelector('#compute-form');
    await page.click('#compute-form [type=submit]');
    await page.waitForSelector('#modal-ok');
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/plans')).at(-1).data.action), 'start');
    await page.click('#modal-cancel');
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/execute')).length), 1);
    await page.evaluate(async () => { computeWorkload.state = 'paused'; await AIComputePage._refresh(); });
    assert.equal(await page.$eval('[data-operation="start"]', e => e.disabled), true);
    // A failed operation is announced, escaped and unlocks controls without a manual refresh.
    await page.evaluate(async () => { computeWorkload.state = 'exited'; await AIComputePage._refresh(); });
    await page.click('[data-operation="start"]');
    await page.waitForSelector('#modal-ok');
    await page.click('#modal-ok');
    await page.waitForFunction(() => AIComputePage._operation?.status === 'queued');
    await page.evaluate(() => { computeJobs[0].status = 'failed'; computeJobs[0].error = 'GPU exhausted <img src=x onerror=alert(1)>'; });
    await page.waitForFunction(() => document.querySelector('#compute-operation').textContent.includes('GPU exhausted'), { timeout: 4000 });
    assert.equal(await page.$('#compute-operation img'), null);
    assert.equal(await page.$eval('#compute-operation', e => e.getAttribute('role')), 'alert');
    await page.waitForFunction(() => !document.querySelector('[data-operation="start"]').disabled, { timeout: 4000 });
    assert.equal(await page.evaluate(async () => { const n = jobReads.length; await new Promise(r => setTimeout(r, 2200)); return jobReads.length === n; }), true);
    // Reopening the page resumes operation feedback even if host metrics fail to load.
    await page.evaluate(async () => { window.failMetrics = true; computeJobs = [{ ...structuredClone(preparedPlan), id: 'resumed-job', hostId: 9, status: 'queued' }]; await AIComputePage.render(document.getElementById('test')); });
    assert.match(await page.$eval('#compute-operation', e => e.textContent), /Queued/);
    await page.evaluate(() => { computeJobs[0].status = 'failed'; computeJobs[0].error = 'Worker failed independently of metrics'; });
    await page.waitForFunction(() => document.querySelector('#compute-operation').textContent.includes('Worker failed independently'), { timeout: 4000 });
    await page.evaluate(async () => { window.failMetrics = false; await AIComputePage._refresh(); });
    // A response arriving after selecting another host cannot change that page or restart polling.
    await page.evaluate(() => { computeJobs = [{ ...structuredClone(preparedPlan), id: 'late-job', hostId: 9, status: 'running' }]; window.deferJob = true; AIComputePage._watchOperation(computeJobs[0]); });
    await page.waitForFunction(() => typeof window.resolveJob === 'function', { timeout: 4000 });
    await page.select('#compute-target', '10');
    await page.waitForFunction(() => AIComputePage._hostId === 10 && document.querySelector('#compute-host').textContent.includes('Other host'));
    await page.evaluate(() => { window.deferJob = false; computeJobs = []; window.resolveJob(); });
    assert.equal(await page.evaluate(async () => { const n = jobReads.length; await new Promise(r => setTimeout(r, 2200)); return jobReads.length === n; }), true);
    assert.equal(await page.$eval('#compute-operation', e => e.hidden), true);
    await page.select('#compute-target', '9');
    await page.waitForFunction(() => document.querySelector('#compute-host').textContent.includes('DGX Spark'));
    await page.evaluate(async () => { computeWorkload.state = 'running'; await AIComputePage._refresh(); });
    await page.select('#compute-range', '24');
    await page.type('#compute-filter', 'not-found');
    assert.equal(await page.$('[data-register]'), null);
    await page.evaluate(async () => { await AIComputePage.render(document.getElementById('test')); });
    assert.equal(await page.$eval('#compute-filter', e => e.value), 'not-found');
    assert.equal(await page.$eval('#compute-range', e => e.value), '24');
    await page.$eval('#compute-filter', el => { el.value = ''; el.dispatchEvent(new Event('input')); });
    await page.click('[data-register]');
    await page.waitForSelector('#compute-form');
    await page.evaluate(()=>{window.hostId=0;});
    await page.select('#compute-target','10');
    await page.waitForFunction(()=>document.querySelector('#compute-host').textContent.includes('Other host'));
    await page.click('#compute-form [type=submit]');
    await page.waitForFunction(() => document.querySelector('#compute-form-error').textContent.includes('host changed'));
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/profiles')).length), 2);
    await page.click('#compute-cancel');
    assert.match(await page.$eval('#compute-host', e => e.textContent), /Other host/);
    assert.equal(await page.$eval('#compute-range', e => e.value), '1');
    assert.equal(await page.evaluate(()=>window.hostId),0);
    // Saving on the original host may finish late, but must never open/execute a plan on the new one.
    await page.evaluate(() => { window.deferProfile = true; });
    await page.click('[data-register]');
    await page.waitForSelector('#compute-form');
    await page.click('#compute-form [type=submit]');
    await page.waitForFunction(() => typeof window.resolveProfile === 'function');
    const plansBeforeChange = await page.evaluate(() => submissions.filter(s => s.url.includes('/plans')).length);
    await page.select('#compute-target', '9');
    await page.waitForFunction(() => AIComputePage._hostId === 9);
    await page.evaluate(() => { window.resolveProfile(); window.deferProfile = false; });
    await page.waitForFunction(() => document.querySelector('#compute-form-error').textContent.includes('original host'));
    assert.equal(await page.evaluate(() => submissions.filter(s => s.url.includes('/plans')).length), plansBeforeChange);
    await page.click('#compute-cancel');
    await page.select('#compute-target', '10');
    await page.waitForFunction(() => document.querySelector('#compute-host').textContent.includes('Other host'));
    await page.evaluate(()=>{window.computeHosts=window.computeHosts.filter(h=>h.id!==10);window.hostId=111;});
    await page.click('#compute-refresh');
    await page.waitForFunction(()=>document.querySelector('#compute-host').textContent.includes('DGX Spark'));
    assert.equal(await page.$eval('#compute-target',e=>e.value),'9');
    assert.equal(await page.evaluate(()=>window.hostId),111);
    await page.evaluate(() => { AIComputePage._watchOperation({ ...preparedPlan, id: 'destroy-job', status: 'queued' }); AIComputePage.destroy(); });
    assert.equal(await page.evaluate(() => AIComputePage._charts.length), 0);
    assert.equal(await page.evaluate(async () => { const n = jobReads.length; await new Promise(r => setTimeout(r, 2200)); return jobReads.length === n; }), true);
    assert.deepEqual(errors, []);
    if (process.env.DD_BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.DD_BROWSER_SCREENSHOT, fullPage: true });
    console.log('AI Compute browser: immediate feedback, serialized 2s job polling, automatic completion/error refresh, outage recovery, terminal cleanup, host/disposal guards and existing service controls passed.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
