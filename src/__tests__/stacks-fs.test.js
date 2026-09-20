'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const stacksFs = require('../services/stacks-fs');

describe('filesystem-first stack discovery', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stacks-fs-'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function writeCompose(relativeDir, services = ['web']) {
    const dir = path.join(sandbox, relativeDir);
    fs.mkdirSync(dir, { recursive: true });
    const body = `services:\n${services.map(name => `  ${name}:\n    image: alpine`).join('\n')}\n`;
    fs.writeFileSync(path.join(dir, 'compose.yml'), body, 'utf8');
    return dir;
  }

  it('discovers compose definitions and reports their services', () => {
    const dir = writeCompose('team/demo', ['web', 'worker']);
    expect(stacksFs.discover([sandbox])).toEqual([expect.objectContaining({
      name: 'demo', path: stacksFs._canonical(dir),
      services: ['web', 'worker'], serviceCount: 2, source: 'filesystem',
    })]);
  });

  it('uses canonical containment and rejects sibling paths', () => {
    const inside = path.join(sandbox, 'inside', 'new-stack');
    const sibling = `${sandbox}-sibling`;
    expect(stacksFs._isInsideRoots(inside, [sandbox])).toBe(true);
    expect(stacksFs._isInsideRoots(sibling, [sandbox])).toBe(false);
  });

  it('walks at most three directory levels below a root', () => {
    writeCompose('a/b/c');
    writeCompose('a/b/other/d');
    const names = stacksFs.discover([sandbox]).map(stack => stack.name);
    expect(names).toContain('c');
    expect(names).not.toContain('d');
  });

  it('does not follow nested symlinks or junctions outside a configured root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stacks-outside-'));
    try {
      fs.mkdirSync(path.join(sandbox, 'links'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'compose.yml'), 'services:\n  web:\n    image: alpine\n');
      const link = path.join(sandbox, 'links', 'external');
      try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) return;
        throw err;
      }
      expect(stacksFs.discover([sandbox])).toEqual([]);
      expect(stacksFs._isInsideRoots(path.join(link, 'compose.yml'), [sandbox])).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
