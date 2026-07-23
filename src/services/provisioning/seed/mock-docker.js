'use strict';

// v8.17.0 (Onboarding — Phase 3) — the MOCK DOCKER ADAPTER for demo hosts.
//
// A demo host has NO daemon behind it: its address is RFC 1918, its FQDN is
// `.test`, and its credentials are placeholders. Without an adapter every page
// that touches a seeded host would spin on a connection that can never succeed.
// This module serves the `seed_containers` roster + the seeded stats series in
// place of a real dockerode connection.
//
// ── ISOLATION FROM REAL HOSTS (the whole point) ────────────────────────────
// `getMockDocker(hostId)` returns `null` unless the `docker_hosts` row is TAGGED
// (`seed_run_id IS NOT NULL`) AND its dataset is still `status='active'`. A real
// host has `seed_run_id IS NULL`, so it can never match — the same NULL-safety
// property the purge relies on. `docker.js` consults this AFTER its connection
// cache and BEFORE building a real connection, so:
//   * a real host that is already cached never even reaches this module;
//   * a real host on a cache miss gets `null` here and takes the unchanged path;
//   * only a seeded host is ever served synthetic data.
// There is no configuration flag, no global switch, and no way to route a real
// host here.
//
// ── WHAT IT EMULATES ───────────────────────────────────────────────────────
//   listContainers({all})           roster → dockerode-shaped summaries
//   getContainer(id).inspect()      "inspect-lite": identity, state, config,
//                                   labels, ports, image. NOT: full HostConfig,
//                                   GraphDriver, real Mounts, network internals.
//   getContainer(id).stats()        one dockerode-shaped sample rebuilt from the
//                                   most recent seeded rollup row.
//   getContainer(id).logs()         a short synthetic log buffer.
//   listImages()                    distinct roster images (sizes are synthetic).
//   listNetworks() / listVolumes()  minimal plausible sets.
//   version() / info() / ping() / df()
//
// ── WHAT IT DOES NOT EMULATE (deliberate) ──────────────────────────────────
// Any MUTATION (start/stop/restart/remove/rename/create/pull/prune/exec/attach),
// event streaming, build, commit, or swarm/compose orchestration. They throw
// `MockDockerUnsupportedError` with a clear "demo host" message rather than
// silently pretending to succeed — a demo must never claim it changed something
// it cannot change.

const { getDb } = require('../../../db');

class MockDockerUnsupportedError extends Error {
  constructor(op) {
    super(`"${op}" is not available on a demo host — this host is synthetic (seeded) data with no Docker daemon behind it.`);
    this.name = 'MockDockerUnsupportedError';
    this.status = 400;
    this.code = 'DEMO_HOST_READ_ONLY';
  }
}

/**
 * THE GUARD. Returns the active seed dataset id for `hostId`, or null.
 * Real hosts (`seed_run_id IS NULL`) can never match `seed_run_id IS NOT NULL`.
 */
function seedDatasetForHost(hostId, db) {
  if (!hostId || hostId <= 0) return null;         // hostId 0 = local default host: never seeded
  const d = db || getDb();
  let row;
  try {
    row = d.prepare(`
      SELECT h.seed_run_id AS dsId
      FROM docker_hosts h
      JOIN seed_datasets s ON s.id = h.seed_run_id AND s.status = 'active'
      WHERE h.id = ? AND h.seed_run_id IS NOT NULL
    `).get(hostId);
  } catch {
    return null; // pre-093 schema (column/table absent) → always the real path
  }
  return row ? row.dsId : null;
}

/** True if this host is a demo/seeded host. */
function isSeededHost(hostId, db) { return seedDatasetForHost(hostId, db) !== null; }

function _roster(db, hostId) {
  return db.prepare(
    'SELECT * FROM seed_containers WHERE host_id = ? ORDER BY name ASC',
  ).all(hostId);
}

function _parse(json, fallback) {
  try { return json ? JSON.parse(json) : fallback; } catch { return fallback; }
}

function _createdEpoch(row) {
  const t = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

/** dockerode `listContainers` summary shape. */
function _summary(row) {
  const ports = _parse(row.ports_json, []);
  const labels = _parse(row.labels_json, {});
  return {
    Id: row.container_id,
    Names: [`/${row.name}`],
    Image: row.image,
    ImageID: `sha256:${row.container_id.slice(0, 64)}`,
    Command: '/docker-entrypoint.sh',
    Created: _createdEpoch(row),
    State: row.state,
    Status: row.status || '',
    Ports: ports.map((p) => ({ PrivatePort: p.private, PublicPort: p.public, Type: p.type || 'tcp', IP: p.ip || '0.0.0.0' })),
    Labels: labels,
    NetworkSettings: { Networks: { bridge: { IPAddress: '' } } },
    Mounts: [],
  };
}

/** The most recent seeded metric sample for a container, as dockerode stats. */
function _statsFor(db, row) {
  const r = db.prepare(`
    SELECT cpu_avg AS cpu, mem_avg AS mem, mem_limit, net_rx_total AS rx, net_tx_total AS tx,
           blk_read_total AS rd, blk_write_total AS wr, pids_avg AS pids
    FROM container_stats_1h WHERE container_id = ? ORDER BY bucket DESC LIMIT 1
  `).get(row.container_id) || {};
  const memLimit = r.mem_limit || 512 * 1024 * 1024;
  const mem = r.mem || Math.round(memLimit * 0.3);
  const cpu = r.cpu || 1;
  // docker.js `_parseStats` derives cpuPercent from the delta pair; craft a pair
  // that yields exactly `cpu` with online_cpus = 1.
  const systemDelta = 1e9;
  const cpuDelta = Math.round((cpu / 100) * systemDelta);
  return {
    read: new Date().toISOString(),
    cpu_stats: { cpu_usage: { total_usage: cpuDelta }, system_cpu_usage: systemDelta, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    memory_stats: { usage: mem, limit: memLimit, stats: { cache: 0 } },
    networks: { eth0: { rx_bytes: r.rx || 0, tx_bytes: r.tx || 0 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'read', value: r.rd || 0 },
        { op: 'write', value: r.wr || 0 },
      ],
    },
    pids_stats: { current: Math.round(r.pids || 1) },
  };
}

class MockContainer {
  constructor(db, hostId, id) { this._db = db; this._hostId = hostId; this.id = id; }

  _row() {
    const row = this._db.prepare(
      'SELECT * FROM seed_containers WHERE host_id = ? AND (container_id = ? OR container_id LIKE ? OR name = ?)',
    ).get(this._hostId, this.id, `${this.id}%`, this.id);
    if (!row) { const e = new Error(`No such container: ${this.id}`); e.statusCode = 404; throw e; }
    return row;
  }

  async inspect() {
    const row = this._row();
    const labels = _parse(row.labels_json, {});
    const ports = _parse(row.ports_json, []);
    const created = new Date(_createdEpoch(row) * 1000).toISOString();
    return {
      Id: row.container_id,
      Name: `/${row.name}`,
      Created: created,
      Platform: 'linux',
      RestartCount: 0,
      Image: `sha256:${row.container_id.slice(0, 64)}`,
      State: {
        Status: row.state,
        Running: row.state === 'running',
        Paused: row.state === 'paused',
        Restarting: false,
        ExitCode: row.state === 'exited' ? 0 : 0,
        StartedAt: created,
        FinishedAt: row.state === 'exited' ? new Date().toISOString() : '0001-01-01T00:00:00Z',
        Health: null,
      },
      Config: {
        Image: row.image,
        Hostname: row.container_id.slice(0, 12),
        Labels: labels,
        Env: ['DD_DEMO=true'],
        Cmd: null,
        Entrypoint: null,
        WorkingDir: '',
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      NetworkSettings: {
        Networks: { bridge: { IPAddress: '' } },
        Ports: ports.reduce((acc, p) => {
          acc[`${p.private}/${p.type || 'tcp'}`] = p.public ? [{ HostIp: '0.0.0.0', HostPort: String(p.public) }] : null;
          return acc;
        }, {}),
      },
      Mounts: [],
      SizeRw: 0,
      SizeRootFs: 0,
    };
  }

  async stats() { return _statsFor(this._db, this._row()); }

  async logs() {
    const row = this._row();
    return [
      `${new Date().toISOString()} [demo] ${row.name} — synthetic log output for a seeded container.`,
      `${new Date().toISOString()} [demo] This host has no Docker daemon; logs are generated, not collected.`,
    ].join('\n');
  }

  async top() { return { Titles: ['PID', 'USER', 'COMMAND'], Processes: [['1', 'root', '/docker-entrypoint.sh']] }; }

  // ── mutations: refuse loudly, never pretend ──────────────────────────────
  async start() { throw new MockDockerUnsupportedError('start'); }
  async stop() { throw new MockDockerUnsupportedError('stop'); }
  async restart() { throw new MockDockerUnsupportedError('restart'); }
  async pause() { throw new MockDockerUnsupportedError('pause'); }
  async unpause() { throw new MockDockerUnsupportedError('unpause'); }
  async kill() { throw new MockDockerUnsupportedError('kill'); }
  async remove() { throw new MockDockerUnsupportedError('remove'); }
  async rename() { throw new MockDockerUnsupportedError('rename'); }
  async update() { throw new MockDockerUnsupportedError('update'); }
  async exec() { throw new MockDockerUnsupportedError('exec'); }
  async attach() { throw new MockDockerUnsupportedError('attach'); }
  async commit() { throw new MockDockerUnsupportedError('commit'); }
  async changes() { return []; }
}

class MockDocker {
  constructor(hostId, db) { this._hostId = hostId; this._db = db || getDb(); this.isMockDocker = true; }

  async listContainers({ all = false } = {}) {
    const rows = _roster(this._db, this._hostId);
    return rows.filter((r) => all || r.state === 'running').map(_summary);
  }

  getContainer(id) { return new MockContainer(this._db, this._hostId, id); }

  async listImages() {
    const rows = this._db.prepare(
      'SELECT DISTINCT image FROM seed_containers WHERE host_id = ? ORDER BY image',
    ).all(this._hostId);
    return rows.map((r, i) => ({
      Id: `sha256:${'0'.repeat(8)}${String(i).padStart(4, '0')}${'0'.repeat(52)}`,
      RepoTags: [r.image],
      RepoDigests: [],
      Created: Math.floor(Date.now() / 1000) - (i + 1) * 86400,
      Size: 40_000_000 + i * 7_000_000,   // synthetic, plausible
      VirtualSize: 40_000_000 + i * 7_000_000,
      Containers: -1,
      Labels: {},
    }));
  }

  getImage(id) {
    return {
      id,
      inspect: async () => ({ Id: id, RepoTags: [id], Config: { Labels: {} }, Size: 40_000_000 }),
      history: async () => [],
      remove: async () => { throw new MockDockerUnsupportedError('image remove'); },
    };
  }

  async listNetworks() {
    return [
      { Id: `mock${this._hostId}bridge`, Name: 'bridge', Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false, IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] }, Containers: {}, Labels: {}, Options: {} },
      { Id: `mock${this._hostId}host`, Name: 'host', Driver: 'host', Scope: 'local', Internal: false, Attachable: false, IPAM: { Config: [] }, Containers: {}, Labels: {}, Options: {} },
    ];
  }

  getNetwork(id) {
    return { id, inspect: async () => ({ Id: id, Name: 'bridge', Containers: {} }), remove: async () => { throw new MockDockerUnsupportedError('network remove'); } };
  }

  async listVolumes() {
    const rows = _roster(this._db, this._hostId).slice(0, 4);
    return {
      Volumes: rows.map((r) => ({ Name: `${r.name}-data`, Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${r.name}-data/_data`, CreatedAt: r.created_at, Labels: {}, Scope: 'local' })),
      Warnings: [],
    };
  }

  getVolume(name) {
    return { name, inspect: async () => ({ Name: name, Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${name}/_data` }), remove: async () => { throw new MockDockerUnsupportedError('volume remove'); } };
  }

  async version() {
    return { Version: '27.0.0', ApiVersion: '1.46', Os: 'linux', Arch: 'amd64', KernelVersion: '6.8.0-demo', Components: [{ Name: 'Engine', Version: '27.0.0' }] };
  }

  async info() {
    const rows = _roster(this._db, this._hostId);
    const running = rows.filter((r) => r.state === 'running').length;
    return {
      ID: `MOCK:HOST:${this._hostId}`,
      Name: `demo-host-${this._hostId}`,
      Containers: rows.length,
      ContainersRunning: running,
      ContainersPaused: rows.filter((r) => r.state === 'paused').length,
      ContainersStopped: rows.filter((r) => r.state === 'exited').length,
      Images: new Set(rows.map((r) => r.image)).size,
      ServerVersion: '27.0.0',
      OperatingSystem: 'Demo Linux (synthetic)',
      OSType: 'linux',
      Architecture: 'x86_64',
      NCPU: 8,
      MemTotal: 32 * 1024 * 1024 * 1024,
      Driver: 'overlay2',
      SystemTime: new Date().toISOString(),
      Warnings: [],
    };
  }

  async ping() { return 'OK'; }

  async df() {
    return { LayersSize: 0, Images: [], Containers: [], Volumes: [], BuildCache: [] };
  }

  async getEvents() { throw new MockDockerUnsupportedError('event stream'); }
  async createContainer() { throw new MockDockerUnsupportedError('create container'); }
  async pull() { throw new MockDockerUnsupportedError('pull'); }
  async buildImage() { throw new MockDockerUnsupportedError('build'); }
  async pruneContainers() { throw new MockDockerUnsupportedError('prune'); }
  async pruneImages() { throw new MockDockerUnsupportedError('prune'); }
  async pruneVolumes() { throw new MockDockerUnsupportedError('prune'); }
  async pruneNetworks() { throw new MockDockerUnsupportedError('prune'); }
  async createNetwork() { throw new MockDockerUnsupportedError('create network'); }
}

/**
 * Return a MockDocker for a seeded host, or NULL for everything else.
 * This null-return is the isolation contract docker.js relies on.
 */
function getMockDocker(hostId, db) {
  return seedDatasetForHost(hostId, db) === null ? null : new MockDocker(hostId, db);
}

module.exports = { getMockDocker, isSeededHost, seedDatasetForHost, MockDocker, MockDockerUnsupportedError };
