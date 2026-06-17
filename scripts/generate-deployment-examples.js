#!/usr/bin/env node
'use strict';

// v8.7.7 — Render every Deployment Configurator recipe with its defaults and
// write the output to examples/deployments/compose.<id>.yml. The configurator
// (in public/js/components/deployment-configurator.js) is the SINGLE SOURCE
// OF TRUTH — this script just snapshots its output for GitHub browsing.
//
// Run after changing any recipe template:
//   node scripts/generate-deployment-examples.js

const fs = require('fs');
const path = require('path');

const DC = require(path.join(__dirname, '..', 'public', 'js', 'components', 'deployment-configurator.js'));

const OUT_DIR = path.join(__dirname, '..', 'examples', 'deployments');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let n = 0;
for (const recipe of DC.RECIPES) {
  const file = path.join(OUT_DIR, `compose.${recipe.id}.yml`);
  const body = DC._render(recipe.id);
  fs.writeFileSync(file, body + '\n', 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), file)}  (${body.length} bytes)`);
  n++;
}
console.log(`\n${n} recipes generated.`);
