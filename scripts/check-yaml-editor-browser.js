'use strict';

const assert = require('node:assert/strict');

// Real keyboard/DOM checks shared by the browser gate; no provider credentials.
module.exports = async function checkYamlEditor(page, base) {
  await page.addStyleTag({ url: `${base}/css/app.css` });
  await page.addScriptTag({ url: `${base}/vendor/codemirror/codemirror.min.js` });
  await page.addScriptTag({ url: `${base}/js/utils/yaml-editor.js` });
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.id = 'yaml-form';
    form.innerHTML = '<label for="yaml-source">Compose YAML</label><textarea id="yaml-source" name="compose">services: {}</textarea><button type="button" id="after-editor">Next</button>';
    document.body.appendChild(form);
    window.yamlChanges = [];
    window.yamlEditor = window.YamlEditor.mount(document.getElementById('yaml-source'), {
      onChange: value => window.yamlChanges.push(value), minHeight: 240,
    });
    window.yamlEditor.focus();
  });
  assert.equal(await page.$eval('.cm-content', el => el.getAttribute('aria-label')), 'Compose YAML');
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type('\nname: demo');
  assert.equal(await page.evaluate(() => window.yamlEditor.getValue()), 'services: {}\nname: demo');
  assert.equal(await page.evaluate(() => new FormData(document.getElementById('yaml-form')).get('compose')), 'services: {}\nname: demo');
  assert.ok(await page.evaluate(() => window.yamlChanges.length > 0));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  assert.equal(await page.evaluate(() => window.yamlEditor.getValue()), 'services: {}');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'after-editor');
  await page.evaluate(() => window.yamlEditor.setValue('services:\n  web: [\n'));
  await page.waitForSelector('.cm-lintRange-error, .cm-lintPoint-error');
  assert.equal(await page.evaluate(() => window.yamlEditor.validate().valid), false);
  assert.ok(await page.$eval('.yaml-editor-status', el => el.classList.contains('is-error')));
  await page.evaluate(() => window.yamlEditor.setValue('services:\n  web:\n    image: nginx:alpine\n'));
  assert.equal(await page.evaluate(() => window.yamlEditor.validate().document.services.web.image), 'nginx:alpine');
  await page.evaluate(() => document.getElementById('yaml-form').reset());
  await page.waitForFunction(() => window.yamlEditor.getValue() === 'services: {}');
  const disposed = await page.evaluate(() => {
    window.yamlEditor.setValue('saved: true');
    window.yamlEditor.destroy(); window.yamlEditor.destroy();
    const textarea = document.getElementById('yaml-source');
    return { value: textarea.value, visible: !textarea.hidden && textarea.style.display !== 'none',
      editors: document.querySelectorAll('.cm-editor').length, statuses: document.querySelectorAll('.yaml-editor-status').length };
  });
  assert.deepEqual(disposed, { value: 'saved: true', visible: true, editors: 0, statuses: 0 });
  await page.evaluate(() => {
    window.yamlEditor = window.YamlEditor.mount(document.getElementById('yaml-source'), { readOnly: true });
    window.yamlEditor.focus();
  });
  await page.keyboard.type('MUST_NOT_CHANGE');
  assert.equal(await page.evaluate(() => window.yamlEditor.getValue()), 'saved: true');
  assert.equal(await page.$eval('.cm-content', el => el.getAttribute('contenteditable')), 'false');
  await page.evaluate(() => {
    // Close the modal first, then run its disposal hook.
    document.getElementById('yaml-form').remove();
    window.yamlEditor.destroy(); window.yamlEditor.destroy();
    const container = document.createElement('div');
    container.id = 'yaml-container'; document.body.appendChild(container);
    window.yamlEditor = window.YamlEditor.mount(container, { value: 'container: true' });
    window.yamlEditor.refresh();
  });
  assert.equal(await page.evaluate(() => window.yamlEditor.validate().document.container), true);
  await page.evaluate(() => {
    window.yamlEditor.destroy(); document.getElementById('yaml-container').remove();
    window.savedCodeMirror = window.DockerDashCodeMirror;
    window.DockerDashCodeMirror = undefined;
    const textarea = document.createElement('textarea');
    textarea.id = 'yaml-fallback'; document.body.appendChild(textarea);
    window.yamlEditor = window.YamlEditor.mount(textarea, { value: 'fallback: true' });
  });
  assert.equal(await page.evaluate(() => window.yamlEditor.validate().document.fallback), true);
  await page.focus('#yaml-fallback');
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type('\ninvalid: [');
  assert.equal(await page.evaluate(() => window.yamlEditor.validate().valid), false);
  await page.evaluate(() => {
    window.yamlEditor.destroy(); document.getElementById('yaml-fallback').remove();
    window.DockerDashCodeMirror = window.savedCodeMirror;
  });
  console.log('YAML editor: keyboard, undo, Tab navigation, lint, form sync/reset, read-only, modal lifecycle and fallback passed.');
};
