'use strict';

// v8.94.0 — CLI Transparency derivation tests.
//
// The interesting surface is not "does it render nginx correctly" — it is
// escaping, redaction, and the allowlist. A command string produced here may be
// pasted into a production shell, so the injection cases carry the weight.

const cli = require('../services/cli-transparency');
const { describe: derive, listActions, shellEscape, redactEnvPair } = cli;

describe('cli-transparency — shellEscape', () => {
  it('emits safe tokens bare for readability', () => {
    expect(shellEscape('nginx')).toBe('nginx');
    expect(shellEscape('ghcr.io/org/app:1.2.3')).toBe('ghcr.io/org/app:1.2.3');
    expect(shellEscape('my_app-1.container')).toBe('my_app-1.container');
  });

  it('quotes anything containing whitespace', () => {
    expect(shellEscape('my container')).toBe("'my container'");
  });

  it('neutralises command substitution', () => {
    expect(shellEscape('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellEscape('`id`')).toBe("'`id`'");
    expect(shellEscape('${HOME}')).toBe("'${HOME}'");
  });

  it('neutralises command chaining', () => {
    expect(shellEscape('a; rm -rf /')).toBe("'a; rm -rf /'");
    expect(shellEscape('a && id')).toBe("'a && id'");
    expect(shellEscape('a | tee /etc/passwd')).toBe("'a | tee /etc/passwd'");
  });

  it('escapes embedded single quotes without breaking out', () => {
    // The classic break-out attempt: close the quote, run a command, reopen.
    expect(shellEscape("a'; id; '")).toBe("'a'\\''; id; '\\'''");
  });

  it('quotes newlines rather than emitting a second command line', () => {
    expect(shellEscape('a\nid')).toBe("'a\nid'");
  });

  it('renders empty and nullish as an explicit empty argument', () => {
    expect(shellEscape('')).toBe("''");
    expect(shellEscape(null)).toBe("''");
    expect(shellEscape(undefined)).toBe("''");
  });
});

describe('cli-transparency — redactEnvPair', () => {
  it('masks values behind secret-shaped keys', () => {
    expect(redactEnvPair('DB_PASSWORD=hunter2')).toEqual({ text: 'DB_PASSWORD=<redacted>', redacted: true });
    expect(redactEnvPair('API_KEY=abc')).toEqual({ text: 'API_KEY=<redacted>', redacted: true });
    expect(redactEnvPair('GITHUB_TOKEN=ghp_x')).toEqual({ text: 'GITHUB_TOKEN=<redacted>', redacted: true });
  });

  it('keeps the key visible — the operator needs to know it is being set', () => {
    expect(redactEnvPair('DB_PASSWORD=hunter2').text.startsWith('DB_PASSWORD=')).toBe(true);
  });

  it('leaves ordinary variables alone', () => {
    expect(redactEnvPair('TZ=Europe/Bucharest')).toEqual({ text: 'TZ=Europe/Bucharest', redacted: false });
  });

  it('does not treat a bare word or leading = as a pair', () => {
    expect(redactEnvPair('NOTAPAIR')).toEqual({ text: 'NOTAPAIR', redacted: false });
    expect(redactEnvPair('=orphan')).toEqual({ text: '=orphan', redacted: false });
  });

  it('masks the whole value, never a prefix of it', () => {
    const r = redactEnvPair('APP_SECRET=super-long-secret-value');
    expect(r.text).toBe('APP_SECRET=<redacted>');
    expect(r.text).not.toContain('super');
  });
});

describe('cli-transparency — lifecycle actions', () => {
  it.each([
    ['container.start', 'docker start web'],
    ['container.stop', 'docker stop web'],
    ['container.restart', 'docker restart web'],
    ['container.pause', 'docker pause web'],
    ['container.unpause', 'docker unpause web'],
    ['container.kill', 'docker kill web'],
  ])('%s renders %s', (action, expected) => {
    const r = derive(action, { name: 'web' });
    expect(r.available).toBe(true);
    expect(r.command).toBe(expected);
  });

  it('falls back to id when no name is present', () => {
    expect(derive('container.stop', { id: 'a1b2c3' }).command).toBe('docker stop a1b2c3');
  });

  it('reports invalid-params when the subject is missing', () => {
    const r = derive('container.stop', {});
    expect(r.available).toBe(false);
    expect(r.reason).toBe('invalid-params');
    expect(r.command).toBeNull();
  });

  it('quotes a hostile container name', () => {
    expect(derive('container.stop', { name: '$(id)' }).command).toBe("docker stop '$(id)'");
  });
});

describe('cli-transparency — remove and rename', () => {
  it('renders flags only when asked', () => {
    expect(derive('container.remove', { name: 'web' }).command).toBe('docker rm web');
    expect(derive('container.remove', { name: 'web', force: true }).command).toBe('docker rm -f web');
    expect(derive('container.remove', { name: 'web', force: true, volumes: true }).command)
      .toBe('docker rm -f -v web');
  });

  it('renders a rename with both operands', () => {
    expect(derive('container.rename', { name: 'old', newName: 'new' }).command)
      .toBe('docker rename old new');
  });

  it('refuses a rename with no target name', () => {
    expect(derive('container.rename', { name: 'old' }).available).toBe(false);
  });
});

describe('cli-transparency — bulk', () => {
  it('renders one line per subject', () => {
    const r = derive('container.bulk', { action: 'stop', subjects: ['a', 'b', 'c'] });
    expect(r.command).toBe('docker stop a\ndocker stop b\ndocker stop c');
  });

  it('accepts object subjects', () => {
    const r = derive('container.bulk', { action: 'restart', subjects: [{ name: 'a' }, { id: 'b' }] });
    expect(r.command).toBe('docker restart a\ndocker restart b');
  });

  it('caps the output and says how many were omitted', () => {
    const subjects = Array.from({ length: 105 }, (_, i) => `c${i}`);
    const lines = derive('container.bulk', { action: 'stop', subjects }).command.split('\n');
    expect(lines).toHaveLength(101);
    expect(lines[100]).toBe('# ... and 5 more');
  });

  it('rejects an empty subject list', () => {
    expect(derive('container.bulk', { action: 'stop', subjects: [] }).available).toBe(false);
  });

  it('rejects a bulk of bulks', () => {
    expect(derive('container.bulk', { action: 'bulk', subjects: ['a'] }).available).toBe(false);
  });

  it('rejects an inner action that is not a container action', () => {
    expect(derive('container.bulk', { action: 'nope', subjects: ['a'] }).available).toBe(false);
  });
});

describe('cli-transparency — container.run', () => {
  it('renders a minimal run', () => {
    expect(derive('container.run', { image: 'nginx' }).command).toBe('docker run -d \\\n  nginx');
  });

  it('honours detach: false', () => {
    expect(derive('container.run', { image: 'nginx', detach: false }).command)
      .toBe('docker run \\\n  nginx');
  });

  it('renders ports, volumes, networks and limits', () => {
    const r = derive('container.run', {
      image: 'nginx', name: 'web',
      ports: [{ host: 8080, container: 80 }, { container: 53, proto: 'udp' }],
      volumes: [{ source: '/data', target: '/usr/share/nginx/html', readOnly: true }],
      networks: ['proxy'], restart: 'unless-stopped', memory: '512m', cpus: 1.5,
    });
    expect(r.command).toContain('--name web');
    expect(r.command).toContain('--restart unless-stopped');
    expect(r.command).toContain('-p 8080:80');
    expect(r.command).toContain('-p 53/udp');
    expect(r.command).toContain('-v /data:/usr/share/nginx/html:ro');
    expect(r.command).toContain('--network proxy');
    expect(r.command).toContain('--memory 512m');
    expect(r.command).toContain('--cpus 1.5');
    expect(r.command.endsWith('nginx')).toBe(true);
  });

  it('masks secret env values and flags the result as redacted', () => {
    const r = derive('container.run', {
      image: 'app', env: ['TZ=UTC', 'DB_PASSWORD=hunter2'],
    });
    expect(r.redacted).toBe(true);
    expect(r.command).toContain('-e TZ=UTC');
    expect(r.command).toContain('DB_PASSWORD=<redacted>');
    expect(r.command).not.toContain('hunter2');
  });

  it('does not flag redaction when nothing was masked', () => {
    expect(derive('container.run', { image: 'app', env: ['TZ=UTC'] }).redacted).toBe(false);
  });

  it('masks secret-shaped labels too', () => {
    const r = derive('container.run', { image: 'app', labels: { 'app.token': 'abc123' } });
    expect(r.redacted).toBe(true);
    expect(r.command).not.toContain('abc123');
  });

  it('quotes an env value containing shell metacharacters', () => {
    const r = derive('container.run', { image: 'app', env: ['MSG=hello; rm -rf /'] });
    expect(r.command).toContain("-e 'MSG=hello; rm -rf /'");
  });

  it('refuses to render without an image', () => {
    expect(derive('container.run', { name: 'web' }).available).toBe(false);
  });

  it('appends the command override after the image', () => {
    const r = derive('container.run', { image: 'alpine', command: ['sh', '-c', 'echo hi'] });
    expect(r.command.endsWith("alpine \\\n  sh \\\n  -c \\\n  'echo hi'")).toBe(true);
  });
});

describe('cli-transparency — images, volumes, networks, prune', () => {
  it('renders image actions', () => {
    expect(derive('image.pull', { ref: 'redis:7' }).command).toBe('docker pull redis:7');
    expect(derive('image.remove', { ref: 'redis:7' }).command).toBe('docker rmi redis:7');
    expect(derive('image.remove', { ref: 'redis:7', force: true }).command).toBe('docker rmi -f redis:7');
  });

  it('renders volume and network removal', () => {
    expect(derive('volume.remove', { name: 'data' }).command).toBe('docker volume rm data');
    expect(derive('network.remove', { name: 'proxy' }).command).toBe('docker network rm proxy');
  });

  it('renders prune actions', () => {
    expect(derive('prune.containers').command).toBe('docker container prune -f');
    expect(derive('prune.volumes').command).toBe('docker volume prune -f');
    expect(derive('prune.buildcache').command).toBe('docker builder prune -f');
    expect(derive('prune.images', { all: true }).command).toBe('docker image prune -f -a');
  });
});

describe('cli-transparency — compose stacks', () => {
  it('renders each stack verb', () => {
    const p = { file: '/opt/stacks/blog/compose.yml' };
    expect(derive('stack.up', p).command).toBe('docker compose -f /opt/stacks/blog/compose.yml up -d');
    expect(derive('stack.down', p).command).toBe('docker compose -f /opt/stacks/blog/compose.yml down');
    expect(derive('stack.restart', p).command).toBe('docker compose -f /opt/stacks/blog/compose.yml restart');
    expect(derive('stack.pull', p).command).toBe('docker compose -f /opt/stacks/blog/compose.yml pull');
  });

  it('includes the project name when given', () => {
    expect(derive('stack.up', { file: 'c.yml', project: 'blog' }).command)
      .toBe('docker compose -p blog -f c.yml up -d');
  });

  it('quotes a path containing spaces', () => {
    expect(derive('stack.up', { file: '/opt/my stacks/c.yml' }).command)
      .toBe("docker compose -f '/opt/my stacks/c.yml' up -d");
  });

  it('refuses without a compose file', () => {
    expect(derive('stack.up', {}).available).toBe(false);
  });
});

describe('cli-transparency — allowlist and safety', () => {
  it('reports unknown actions honestly rather than guessing', () => {
    const r = derive('container.teleport', { name: 'web' });
    expect(r).toEqual({ available: false, command: null, hostLabel: null, redacted: false, reason: 'unknown-action' });
  });

  it('does not resolve prototype keys as actions', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(derive(key, { name: 'web' }).reason).toBe('unknown-action');
    }
  });

  it('rejects a non-string action key', () => {
    for (const key of [null, undefined, 42, {}, []]) {
      expect(derive(key, { name: 'web' }).reason).toBe('unknown-action');
    }
  });

  it('tolerates missing params without throwing', () => {
    expect(() => derive('container.stop')).not.toThrow();
    expect(derive('container.stop').available).toBe(false);
  });

  it('carries the host label through without turning it into a --host flag', () => {
    const r = derive('container.stop', { name: 'web', hostName: 'lan-01' });
    expect(r.hostLabel).toBe('lan-01');
    expect(r.command).toBe('docker stop web');
    expect(r.command).not.toContain('--host');
  });

  it('exposes a stable, sorted action list', () => {
    const actions = listActions();
    expect(actions).toEqual([...actions].sort());
    expect(actions).toContain('container.start');
    expect(actions).toContain('stack.up');
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('never returns a command for an unavailable result', () => {
    for (const action of ['nope', 'container.stop', 'stack.up']) {
      const r = derive(action, {});
      if (!r.available) expect(r.command).toBeNull();
    }
  });
});
