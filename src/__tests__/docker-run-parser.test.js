'use strict';

// v8.9.7-alpha.1 — Dockge G06 closure tests.

const { parseDockerRun, tokenize } = require('../services/docker-run-parser');

describe('docker-run parser (v8.9.7-alpha.1)', () => {
  describe('tokenize', () => {
    it('splits on spaces', () => {
      expect(tokenize('docker run nginx')).toEqual(['docker', 'run', 'nginx']);
    });
    it('respects double quotes', () => {
      expect(tokenize('docker run -e "FOO=bar baz" nginx'))
        .toEqual(['docker', 'run', '-e', 'FOO=bar baz', 'nginx']);
    });
    it('respects single quotes', () => {
      expect(tokenize(`docker run -e 'FOO=bar baz' nginx`))
        .toEqual(['docker', 'run', '-e', 'FOO=bar baz', 'nginx']);
    });
    it('handles backslash escapes', () => {
      expect(tokenize('docker run --name foo\\ bar nginx'))
        .toEqual(['docker', 'run', '--name', 'foo bar', 'nginx']);
    });
    it('throws on unterminated quote', () => {
      expect(() => tokenize('docker run "unclosed nginx')).toThrow(/Unterminated/);
    });
  });

  describe('parseDockerRun basic', () => {
    it('parses minimal image', () => {
      const r = parseDockerRun('docker run nginx');
      expect(r.service.image).toBe('nginx');
      expect(r.service_name).toBe('nginx');
    });
    it('handles the -d flag (silently)', () => {
      const r = parseDockerRun('docker run -d nginx');
      expect(r.service.image).toBe('nginx');
    });
    it('extracts --name and uses it as service name', () => {
      const r = parseDockerRun('docker run --name mydb postgres:16');
      expect(r.service_name).toBe('mydb');
      expect(r.service.container_name).toBe('mydb');
      expect(r.service.image).toBe('postgres:16');
    });
  });

  describe('parseDockerRun ports/volumes/env', () => {
    it('parses -p short form', () => {
      const r = parseDockerRun('docker run -p 8080:80 nginx');
      expect(r.service.ports).toEqual(['8080:80']);
    });
    it('parses multiple -p flags', () => {
      const r = parseDockerRun('docker run -p 80:80 -p 443:443 nginx');
      expect(r.service.ports).toEqual(['80:80', '443:443']);
    });
    it('parses -v volumes', () => {
      const r = parseDockerRun('docker run -v /data:/var/lib/postgresql/data postgres');
      expect(r.service.volumes).toEqual(['/data:/var/lib/postgresql/data']);
    });
    it('parses named volume', () => {
      const r = parseDockerRun('docker run -v pgdata:/var/lib/postgresql/data postgres');
      expect(r.service.volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
    });
    it('parses -e env vars', () => {
      const r = parseDockerRun('docker run -e POSTGRES_PASSWORD=secret postgres');
      expect(r.service.environment).toEqual(['POSTGRES_PASSWORD=secret']);
    });
    it('parses --env= form', () => {
      const r = parseDockerRun('docker run --env=DEBUG=1 nginx');
      expect(r.service.environment).toEqual(['DEBUG=1']);
    });
  });

  describe('parseDockerRun other flags', () => {
    it('parses --restart', () => {
      const r = parseDockerRun('docker run --restart unless-stopped nginx');
      expect(r.service.restart).toBe('unless-stopped');
    });
    it('parses --network', () => {
      const r = parseDockerRun('docker run --network mynet nginx');
      expect(r.service.networks).toEqual(['mynet']);
    });
    it('parses --user', () => {
      const r = parseDockerRun('docker run --user 1000:1000 nginx');
      expect(r.service.user).toBe('1000:1000');
    });
    it('parses -w workdir', () => {
      const r = parseDockerRun('docker run -w /app nginx');
      expect(r.service.working_dir).toBe('/app');
    });
    it('parses --cap-add', () => {
      const r = parseDockerRun('docker run --cap-add NET_ADMIN --cap-add SYS_TIME nginx');
      expect(r.service.cap_add).toEqual(['NET_ADMIN', 'SYS_TIME']);
    });
    it('parses --privileged', () => {
      const r = parseDockerRun('docker run --privileged nginx');
      expect(r.service.privileged).toBe(true);
    });
  });

  describe('parseDockerRun complex real-world', () => {
    it('parses a full postgres command', () => {
      const r = parseDockerRun(
        `docker run -d --name pg --restart always -p 5432:5432 -v pgdata:/var/lib/postgresql/data ` +
        `-e POSTGRES_PASSWORD=secret -e POSTGRES_DB=app postgres:16`
      );
      expect(r.service.image).toBe('postgres:16');
      expect(r.service.container_name).toBe('pg');
      expect(r.service.restart).toBe('always');
      expect(r.service.ports).toEqual(['5432:5432']);
      expect(r.service.volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
      expect(r.service.environment).toEqual(['POSTGRES_PASSWORD=secret', 'POSTGRES_DB=app']);
    });

    it('captures positional args as command:', () => {
      const r = parseDockerRun(`docker run alpine sh -c "echo hi"`);
      expect(r.service.image).toBe('alpine');
      expect(r.service.command).toEqual(['sh', '-c', 'echo hi']);
    });
  });

  describe('parseDockerRun errors', () => {
    it('rejects empty command', () => {
      expect(() => parseDockerRun('')).toThrow(/required/);
    });
    it('rejects command without image', () => {
      expect(() => parseDockerRun('docker run')).toThrow(/No image/);
    });
    it('rejects unterminated quote', () => {
      expect(() => parseDockerRun('docker run "half nginx')).toThrow(/Unterminated/);
    });
  });

  describe('YAML output', () => {
    it('produces valid YAML string', () => {
      const r = parseDockerRun('docker run -p 8080:80 nginx');
      expect(r.yaml).toContain('services:');
      expect(r.yaml).toContain('nginx:');
      expect(r.yaml).toContain('image: nginx');
      expect(r.yaml).toContain('- 8080:80');
    });
  });
});
