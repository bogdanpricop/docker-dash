'use strict';

const fs = require('fs');
const path = require('path');

const CHECKS = [
  ['semantic tab list', /role="tablist"/],
  ['semantic tabs', /role="tab"/],
  ['polite live region', /aria-live="polite"/],
  ['keyboard shortcut disclosure', /aria-keyshortcuts=/],
  ['labelled operation groups', /class="ss-operation-group" role="group" aria-label=/],
  ['guarded VM operation buttons', /<button[^>]+data-ss-lifecycle=/],
  ['mobile incident safe-action copy', /No destructive infrastructure action is exposed/],
  ['form labels tied to controls', /<label[^>]+for="ss-/],
];
const CSS_CHECKS = [
  ['visible focus', /\.self-service-portal[\s\S]+:focus-visible/],
  ['high contrast', /@media \(prefers-contrast: more\)/],
  ['reduced motion', /@media \(prefers-reduced-motion: reduce\)/],
  ['mobile layout', /@media \(max-width: 720px\)/],
  ['44px mobile targets', /min-height: 44px/],
];

function validate(root = path.resolve(__dirname, '..')) {
  const source = fs.readFileSync(path.join(root, 'public/js/pages/self-service.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
  const failures = [];
  for (const [name, pattern] of CHECKS) if (!pattern.test(source)) failures.push(`UI: ${name}`);
  for (const [name, pattern] of CSS_CHECKS) if (!pattern.test(css)) failures.push(`CSS: ${name}`);
  if (/<a[^>]+data-ss-(lifecycle|incident|decide)=/.test(source)) failures.push('Interactive self-service actions must use buttons, not links');
  if (failures.length) throw new Error(`Self-service accessibility contract failed:\n${failures.join('\n')}`);
  return { uiChecks: CHECKS.length, cssChecks: CSS_CHECKS.length };
}

if (require.main === module) {
  const result = validate();
  console.log(`Self-service accessibility gate passed: ${result.uiChecks} UI checks and ${result.cssChecks} CSS checks.`);
}

module.exports = { CHECKS, CSS_CHECKS, validate };
