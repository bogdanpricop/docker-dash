'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const npmVersion = String(pkg.packageManager || '').match(/^npm@(.+)$/)?.[1];
const nodeVersion = read('.nvmrc').trim();
const dockerfile = read('Dockerfile');
const ci = read('.github/workflows/ci.yml');

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

requireMatch(npmVersion, 'package.json#packageManager must pin an exact npm version');
requireMatch(/^\d+\.\d+\.\d+$/.test(nodeVersion), '.nvmrc must pin an exact Node.js version');
requireMatch(
  pkg.engines?.node === `>=${nodeVersion} <${Number(nodeVersion.split('.')[0]) + 1}`,
  'package.json#engines.node must match the .nvmrc LTS pin',
);
requireMatch(
  pkg.engines?.npm === `>=${npmVersion} <${Number(npmVersion.split('.')[0]) + 1}`,
  'package.json#engines.npm must match packageManager',
);
requireMatch(
  dockerfile.includes(`FROM node:${nodeVersion}-alpine@sha256:`),
  'Dockerfile Node.js base must match .nvmrc and remain digest-pinned',
);
requireMatch(
  dockerfile.includes(`npm install --global npm@${npmVersion} --ignore-scripts`),
  'Dockerfile npm installation must match packageManager',
);
requireMatch(
  ci.includes(`npm install --global npm@${npmVersion} --ignore-scripts`),
  'CI npm installation must match packageManager',
);

const dockerCiCommands = dockerfile.match(/RUN npm ci[^\r\n]*/g) || [];
requireMatch(dockerCiCommands.length > 0, 'Dockerfile must install dependencies with npm ci');
requireMatch(
  dockerCiCommands.every(command => command.includes('--strict-allow-scripts')),
  'Every Dockerfile npm ci command must enforce the lifecycle-script allowlist',
);
requireMatch(
  /run:\s*npm ci[^\r\n]*--strict-allow-scripts/.test(ci),
  'CI npm ci must enforce the lifecycle-script allowlist',
);

console.log(`Toolchain pins verified: Node.js ${nodeVersion}, npm ${npmVersion}, strict lifecycle-script policy.`);
