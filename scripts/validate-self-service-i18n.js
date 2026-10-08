'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REQUIRED_KEYS = [
  'title', 'requestQuota', 'acknowledge', 'pause',
  'tabs.catalog', 'tabs.project', 'tabs.requests', 'tabs.incidents', 'tabs.guidance',
  'actions.start', 'actions.shutdown', 'actions.reboot', 'actions.snapshot', 'actions.console',
  'providers.proxmox', 'providers.vsphere', 'providers.xen', 'safety.confirm', 'safety.mobile',
];

function resolve(object, key) { return key.split('.').reduce((value, part) => value?.[part], object); }
function placeholders(value) { return [...String(value).matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map(match => match[1]).sort(); }

function validate(root = path.resolve(__dirname, '..')) {
  const context = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/i18n.js'), 'utf8'), context);
  const directory = path.join(root, 'public/js/i18n');
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.js') && name !== 'TEMPLATE.js')) {
    vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), context);
  }
  const translations = context.window.i18n._translations;
  const languages = Object.keys(translations).sort();
  if (languages.length !== 11) throw new Error(`Expected 11 registered languages, received ${languages.length}`);
  const failures = [];
  for (const language of languages) for (const key of REQUIRED_KEYS) {
    const value = resolve(translations[language]?.selfService, key);
    if (typeof value !== 'string' || !value.trim()) failures.push(`${language}: selfService.${key} is missing`);
    const expected = resolve(translations.en.selfService, key);
    if (value && JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(expected))) failures.push(`${language}: placeholder mismatch for selfService.${key}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { languages, requiredKeys: REQUIRED_KEYS.length, checkedValues: languages.length * REQUIRED_KEYS.length };
}

if (require.main === module) {
  const result = validate();
  console.log(`Self-service i18n gate passed: ${result.languages.length} languages, ${result.requiredKeys} critical keys, ${result.checkedValues} values.`);
}

module.exports = { REQUIRED_KEYS, validate };
