'use strict';

// v8.94.0 — isolation posture check. Mirrors the posture-proxmox-k8s.test.js
// style: a synthetic ctx, with the docker service mocked so no daemon is needed.
//
// The behaviour worth pinning is the cost gate: a host with no sandboxed runtime
// must never reach the per-container inspect loop. That is what keeps the check
// affordable on a normal estate, so it is asserted on call counts, not just on
// the absence of findings.

process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';

jest.mock('../services/docker', () => ({
  listContainers: jest.fn(),
  inspectContainer: jest.fn(),
}));

const dockerService = require('../services/docker');
const check = require('../services/posture/checks/isolation');

const HOST = { id: 7, name: 'lab-01', daemon_type: 'docker' };

const ctx = (hosts, info) => ({
  hosts,
  docker: { info: jest.fn().mockResolvedValue(info) },
});

const infoWith = (sandboxed) => ({
  defaultRuntime: 'runc',
  runtimeCategories: { standard: ['runc'], sandboxed, wasm: [] },
});

const running = (id, name) => ({ id, shortId: id.slice(0, 12), name, state: 'running' });

const inspect = (isolation, mounts = []) => ({ isolation, mounts, isSelf: false });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isolation check — cost gate', () => {
  it('does not list or inspect containers when no sandboxed runtime is registered', async () => {
    const out = await check.run(ctx([HOST], infoWith([])));
    expect(out).toEqual([]);
    expect(dockerService.listContainers).not.toHaveBeenCalled();
    expect(dockerService.inspectContainer).not.toHaveBeenCalled();
  });

  it('skips non-Docker daemons entirely', async () => {
    const c = ctx([{ ...HOST, daemon_type: 'proxmox' }], infoWith(['runsc']));
    expect(await check.run(c)).toEqual([]);
    expect(c.docker.info).not.toHaveBeenCalled();
  });

  it('inspects only running containers', async () => {
    dockerService.listContainers.mockResolvedValue([
      running('a'.repeat(64), 'up'),
      { id: 'b'.repeat(64), name: 'stopped', state: 'exited' },
    ]);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runc' }));
    await check.run(ctx([HOST], infoWith(['runsc'])));
    expect(dockerService.inspectContainer).toHaveBeenCalledTimes(1);
  });
});

describe('isolation check — findings', () => {
  const withSandbox = () => ctx([HOST], infoWith(['runsc']));

  it('flags a privileged container on the shared-kernel runtime', async () => {
    dockerService.listContainers.mockResolvedValue([running('c'.repeat(64), 'legacy-app')]);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runc', privileged: true }));

    const out = await check.run(withSandbox());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: 'isolation.shared-kernel',
      hostId: 7,
      subject: 'host:7:container:legacy-app',
    });
    expect(out[0].evidence).toContain('runtime=runc');
    expect(out[0].remediation.steps).toContain('--runtime=runsc');
  });

  it('caps critical reach at high severity — the container is contained, not breached', async () => {
    dockerService.listContainers.mockResolvedValue([running('d'.repeat(64), 'app')]);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runc', privileged: true }));
    expect((await check.run(withSandbox()))[0].severity).toBe('high');
  });

  it('passes medium reach through unchanged', async () => {
    dockerService.listContainers.mockResolvedValue([running('e'.repeat(64), 'app')]);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runc', networkMode: 'host' }));
    expect((await check.run(withSandbox()))[0].severity).toBe('medium');
  });

  it('produces nothing for a container already on the sandboxed runtime', async () => {
    dockerService.listContainers.mockResolvedValue([running('f'.repeat(64), 'app')]);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runsc', privileged: true }));
    expect(await check.run(withSandbox())).toEqual([]);
  });

  it('produces nothing for a container with no host-level reach', async () => {
    dockerService.listContainers.mockResolvedValue([running('0'.repeat(64), 'app')]);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runc' }));
    expect(await check.run(withSandbox())).toEqual([]);
  });

  it('never flags Docker Dash itself', async () => {
    dockerService.listContainers.mockResolvedValue([running('1'.repeat(64), 'docker-dash')]);
    dockerService.inspectContainer.mockResolvedValue({
      isolation: { runtime: 'runc', privileged: true }, mounts: [], isSelf: true,
    });
    expect(await check.run(withSandbox())).toEqual([]);
  });

  it('emits one finding per container, not one per reach signal', async () => {
    dockerService.listContainers.mockResolvedValue([running('2'.repeat(64), 'app')]);
    dockerService.inspectContainer.mockResolvedValue(
      inspect({ runtime: 'runc', pidMode: 'host', networkMode: 'host', capAdd: ['SYS_ADMIN'] })
    );
    const out = await check.run(withSandbox());
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toContain('CAP_SYS_ADMIN');
    expect(out[0].evidence).toContain('host PID namespace');
  });

  it('names the socket mount in the evidence', async () => {
    dockerService.listContainers.mockResolvedValue([running('3'.repeat(64), 'ci-runner')]);
    dockerService.inspectContainer.mockResolvedValue(
      inspect({ runtime: 'runc' }, [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }])
    );
    expect((await check.run(withSandbox()))[0].evidence).toContain('Docker socket');
  });
});

describe('isolation check — resilience', () => {
  it('survives a container that vanishes mid-scan', async () => {
    dockerService.listContainers.mockResolvedValue([
      running('4'.repeat(64), 'gone'), running('5'.repeat(64), 'here'),
    ]);
    dockerService.inspectContainer
      .mockRejectedValueOnce(new Error('no such container'))
      .mockResolvedValueOnce(inspect({ runtime: 'runc', privileged: true }));

    const out = await check.run(ctx([HOST], infoWith(['runsc'])));
    expect(out).toHaveLength(1);
    expect(out[0].subject).toContain('here');
  });

  it('survives a host whose container list cannot be read', async () => {
    dockerService.listContainers.mockRejectedValue(new Error('connection refused'));
    expect(await check.run(ctx([HOST], infoWith(['runsc'])))).toEqual([]);
  });

  it('survives a host whose info cannot be read', async () => {
    const c = { hosts: [HOST], docker: { info: jest.fn().mockResolvedValue(null) } };
    expect(await check.run(c)).toEqual([]);
  });

  it('reports the omission when the per-host scan cap truncates', async () => {
    const many = Array.from({ length: 205 }, (_, i) => running(String(i).padStart(64, '0'), `c${i}`));
    dockerService.listContainers.mockResolvedValue(many);
    dockerService.inspectContainer.mockResolvedValue(inspect({ runtime: 'runc', privileged: true }));

    const out = await check.run(ctx([HOST], infoWith(['runsc'])));
    expect(dockerService.inspectContainer).toHaveBeenCalledTimes(200);
    expect(out).toHaveLength(200);
    expect(out[0].detail).toContain('5 further running containers');
  });
});
