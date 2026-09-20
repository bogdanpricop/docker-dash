'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
    }
  }
}

for (const dir of ['src', 'public/js', 'scripts']) check(dir);
console.log('JavaScript syntax verified (backend, frontend, scripts).');
