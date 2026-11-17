'use strict';

const { applyPatch } = require('diff');
const { buildPlan } = require('../services/ai/features/dgx-stack-plan');

const sha = value => 'sha256:' + value.repeat(64);
const old = sha('a');
const candidate = sha('b');
const app = sha('c');
const root = '/opt/stacks/demo';
const file = root + '/compose.yaml';
const pin = 'redis@' + candidate;
const base = 'redis:7.4-alpine@' + old;
const finding = (id, severity = 'high') => ({ id, severity, package: 'zlib', fixedIn: '1.4-r0' });
const fixed = finding('CVE-2026-0010');
const residual = finding('CVE-2026-0011', 'critical');
const scan = (id, scanner, findings) => ({ id, scanner, results_json: JSON.stringify(findings), scanned_at: '2026-11-16 20:00:00' });
const pair = (id, findings) => [scan(id, 'trivy', findings), scan(id + 1, 'grype', findings)];
const baseImage = { Id: old, Os: 'linux', Architecture: 'amd64', RepoTags: ['redis:7.4.8-alpine'], RootFS: { Layers: [sha('a')] } };
const candidateImage = { Id: candidate, Os: 'linux', Architecture: 'amd64' };
const appImage = { Id: app, Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [sha('a'), sha('c')] } };

function fixture({ compose, next = pair(3, []), prior = pair(1, [fixed]), imageId = old, dockerfile, gitBacked = false, configFiles = file }) {
  const containers = [{
    imageIdFull: imageId,
    labels: {
      'com.docker.compose.service': 'cache', 'com.docker.compose.project.config_files': configFiles,
      'com.docker.compose.project.working_dir': root,
    },
  }];
  const evidence = new Map([[old, prior], [candidate, next], [app, pair(5, [fixed])]]);
  const meta = new Map([[old, baseImage], [app, appImage], ['redis:7-alpine', baseImage], [base, baseImage], [pin, candidateImage]]);
  return buildPlan({ containers, stack: 'demo', images: [{
    id: candidate, repoTags: ['redis:7.4.12-alpine'], repoDigests: [pin], created: 200,
  }], getScans: id => evidence.get(id) || [], inspectImage: id => meta.get(id), gitBacked,
  sourceRoots: ['/opt/stacks'], now: Date.parse('2026-11-16T21:00:00Z'),
  read: (_root, name) => name === file ? compose : dockerfile });
}

test('updates only the Compose image line and guards the operator deployment', async () => {
  const compose = 'services:\n  cache:\n    image: redis:7-alpine\n    environment:\n      TOKEN: secret-env-value\n';
  const [step] = await fixture({ compose });
  expect(step.change.candidate.admissionPassed).toBe(true);
  expect(step.change.diff).not.toContain('secret-env-value');
  expect(applyPatch(compose, step.change.diff)).toBe(compose.replace('redis:7-alpine', pin));
  expect(step.change.deployCommands).toContain('up -d --no-deps --no-build --pull never');
  expect(step.change.deployCommands).toContain(old);
  expect(step.change.prepareCommands).not.toContain('up -d');
  const [git] = await fixture({ compose, gitBacked: true });
  expect(git.change.deployCommands).toBe('');
});

test('existing critical findings permit an evidence-backed diff but never a deployment command', async () => {
  const [step] = await fixture({
    compose: 'services:\n  cache:\n    image: redis:7-alpine\n',
    prior: pair(1, [fixed, residual]), next: [scan(3, 'trivy', []), scan(4, 'grype', [residual])],
  });
  expect(step.change.candidate.fixed).toEqual([{ id: fixed.id, package: fixed.package }]);
  expect(step.change.candidate.admissionPassed).toBe(false);
  expect(step.change.prepareCommands).toContain('docker pull');
  expect(step.change.deployCommands).toBe('');
});

test('keeps the CRLF patch bytes intact when Linux commands are copied as text', async () => {
  const compose = 'services:\r\n  cache:\r\n    image: redis:7-alpine\r\n';
  const [step] = await fixture({ compose });
  const encoded = step.change.prepareCommands.match(/printf %s '([A-Za-z0-9+/=]+)'/)[1];
  expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(step.change.diff);
  expect(step.change.prepareCommands).toContain('patch --binary');
  expect(applyPatch(compose, step.change.diff).replace(/\r?\n/g, '\n')).toBe(compose.replace('redis:7-alpine', pin).replace(/\r?\n/g, '\n'));
});

test('suppresses patches for newly blocking findings, missing engine coverage, ambiguous source, or an inline comment', async () => {
  const compose = 'services:\n  cache:\n    image: redis:7-alpine\n';
  await expect(fixture({ compose, next: pair(3, [residual]) })).resolves.toMatchObject([{ reason: 'no_verified_candidate' }]);
  await expect(fixture({ compose, next: [scan(3, 'trivy', [])] })).resolves.toMatchObject([{ reason: 'no_verified_candidate' }]);
  await expect(fixture({ compose, configFiles: file + ',/opt/stacks/demo/override.yaml' })).resolves.toMatchObject([{ reason: 'compose_unavailable' }]);
  await expect(fixture({ compose: compose.trimEnd() + ' # private comment\n' })).resolves.toMatchObject([{ reason: 'unsupported_source' }]);
});

test('Dockerfile uses a verified base layer and generates a candidate build, not a rollout', async () => {
  const compose = 'services:\n  cache:\n    build: .\n';
  const dockerfile = 'FROM ' + base + '\nENV PRIVATE_ENV=private-value\n';
  const [step] = await fixture({ compose, dockerfile, imageId: app });
  expect(step.change.kind).toBe('dockerfile');
  expect(step.change.diff).not.toContain('private-value');
  expect(applyPatch(dockerfile, step.change.diff)).toBe(dockerfile.replace(base, pin));
  expect(step.change.prepareCommands).toContain('docker build --pull --iidfile');
  expect(step.change.deployCommands).toBe('');
});
