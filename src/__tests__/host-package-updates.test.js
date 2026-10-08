'use strict';

const service = require('../services/host-package-updates');

const { PROBE_SCRIPT, parseProbe, shellQuote } = service._internals;

describe('host package update inventory', () => {
  test('the host probe is read-only and supports the common Linux package managers', () => {
    expect(PROBE_SCRIPT).toContain('apt list --upgradable');
    expect(PROBE_SCRIPT).toContain('dnf -q --cacheonly check-update');
    expect(PROBE_SCRIPT).toContain('yum -q -C check-update');
    expect(PROBE_SCRIPT).toContain('zypper --non-interactive --no-refresh list-updates');
    expect(PROBE_SCRIPT).toContain("apk version -l '<'");
    expect(PROBE_SCRIPT).toContain('pacman -Qu');
    expect(PROBE_SCRIPT).not.toMatch(/\bapt(?:-get)?\s+(?:update|upgrade|install)\b/);
    expect(PROBE_SCRIPT).not.toMatch(/\b(?:dnf|yum)\s+(?:update|upgrade|install)\b/);
    expect(PROBE_SCRIPT).not.toMatch(/\bapk\s+(?:update|upgrade|add)\b/);
    expect(PROBE_SCRIPT).not.toMatch(/\bpacman\s+-S/);
  });

  test('quotes the fixed probe as one shell argument', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  test('parses apt packages with installed and candidate versions', () => {
    const parsed = parseProbe([
      '__DD_PACKAGE_MANAGER__:apt',
      'Listing...',
      'curl/bookworm-security 7.88.1-10+deb12u14 amd64 [upgradable from: 7.88.1-10+deb12u12]',
      'linux-image-amd64/bookworm-security 6.1.153-1 amd64 [upgradable from: 6.1.148-1]',
      '__DD_EXIT_CODE__:0',
    ].join('\n'));

    expect(parsed).toMatchObject({ manager: 'apt', exitCode: 0, error: null });
    expect(parsed.packages).toEqual([
      { name: 'curl', oldVersion: '7.88.1-10+deb12u12', newVersion: '7.88.1-10+deb12u14' },
      { name: 'linux-image-amd64', oldVersion: '6.1.148-1', newVersion: '6.1.153-1' },
    ]);
  });

  test('accepts dnf exit code 100 and ignores metadata messages', () => {
    const parsed = parseProbe([
      '__DD_PACKAGE_MANAGER__:dnf',
      'Last metadata expiration check: 0:20:00 ago on Thu 08 Oct 2026.',
      'podman.x86_64                 5.6.2-1.el10                 updates',
      '__DD_EXIT_CODE__:100',
    ].join('\n'));

    expect(parsed.error).toBeNull();
    expect(parsed.packages).toEqual([
      { name: 'podman', architecture: 'x86_64', oldVersion: '?', newVersion: '5.6.2-1.el10' },
    ]);
  });

  test.each([
    ['zypper', 'v | Main Repository | docker | 27.5.1 | 28.5.1 | x86_64',
      { name: 'docker', oldVersion: '27.5.1', newVersion: '28.5.1', architecture: 'x86_64' }],
    ['apk', 'busybox-1.36.1-r2 < 1.36.1-r5',
      { name: 'busybox', oldVersion: '1.36.1-r2', newVersion: '1.36.1-r5' }],
    ['pacman', 'openssl 3.5.2-1 -> 3.5.4-1',
      { name: 'openssl', oldVersion: '3.5.2-1', newVersion: '3.5.4-1' }],
  ])('parses %s output', (manager, line, expected) => {
    const parsed = parseProbe(`__DD_PACKAGE_MANAGER__:${manager}\n${line}\n__DD_EXIT_CODE__:0`);
    expect(parsed.error).toBeNull();
    expect(parsed.packages).toEqual([expected]);
  });

  test('reports unsupported managers instead of claiming the host is current', () => {
    expect(parseProbe('__DD_PACKAGE_MANAGER__:unsupported\n__DD_EXIT_CODE__:127')).toMatchObject({
      manager: 'unsupported', packages: [], error: 'No supported package manager was found on the selected host',
    });
  });
});
