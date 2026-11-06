'use strict';

const copy = value => JSON.parse(JSON.stringify(value));
const failure = code => Object.assign(new Error('Docker fixture ' + code), { statusCode: code });

module.exports = function daemon() {
  const states = new Map(), handles = new Map(), events = [];
  function add(state) {
    states.set(state.Id, state);
    const id = state.Id;
    const handle = { id,
      inspect: jest.fn(async () => { if (!states.has(id)) throw failure(404); return copy(states.get(id)); }),
      start: jest.fn(async () => { events.push(id + ':start'); state.State.Running = true; }),
      stop: jest.fn(async () => { events.push(id + ':stop'); state.State.Running = false; }),
      update: jest.fn(async opts => { events.push(id + ':update'); Object.assign(state.HostConfig, copy(opts)); }),
      rename: jest.fn(async ({ name }) => {
        if ([...states.values()].some(s => s.Id !== id && s.Name === '/' + name)) throw failure(409);
        events.push(id + ':rename'); state.Name = '/' + name;
      }),
      remove: jest.fn(async () => { events.push(id + ':remove'); states.delete(id); }),
    };
    handles.set(id, handle); return handle;
  }
  const initial = { Id: 'old-container', Name: '/old', Image: 'sha256:' + 'a'.repeat(64),
    Config: { Image: 'example/app:mutable', Env: [], Healthcheck: { Test: ['CMD', 'true'] } },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }, Mounts: [],
    State: { Running: true, Health: { Status: 'healthy' } }, NetworkSettings: { Networks: {} } };
  const old = add(initial);
  const networks = new Map();
  const docker = {
    info: jest.fn(async () => ({ ID: 'fixture-daemon' })),
    getVolume: jest.fn(name => ({ inspect: async () => ({ Name: name }) })),
    getContainer: jest.fn(id => (id === 'aaaaaaaaaaaa' ? old : null) || handles.get(id) || handles.get([...states.values()].find(s => s.Name === '/' + id)?.Id)
      || { inspect: jest.fn(async () => { throw failure(404); }) }),
    getImage: jest.fn(() => ({ inspect: async () => ({ Id: 'sha256:' + 'b'.repeat(64), Size: 10 }) })),
    createContainer: jest.fn(async opts => {
      if ([...states.values()].some(s => s.Name === '/' + opts.name)) throw failure(409);
      const id = opts.name.startsWith('dd-replacement-lock-') ? 'lock-' + handles.size : 'new-container';
      events.push(id + ':create');
      const config = copy(opts); delete config.HostConfig; delete config.NetworkingConfig; delete config.name;
      return add({ Id: id, Name: '/' + opts.name, Image: opts.Image, Config: config,
        State: { Running: false, ...(opts.Healthcheck ? { Health: { Status: 'healthy' } } : {}) },
        Mounts: [], HostConfig: copy(opts.HostConfig || {}),
        NetworkSettings: { Networks: copy(opts.NetworkingConfig?.EndpointsConfig || {}) } });
    }),
    getNetwork: jest.fn(name => {
      if (!networks.has(name)) networks.set(name, {
        disconnect: jest.fn(async ({ Container }) => { delete states.get(Container).NetworkSettings.Networks[name]; }),
        connect: jest.fn(async ({ Container, EndpointConfig }) => { states.get(Container).NetworkSettings.Networks[name] = copy(EndpointConfig); }),
      });
      return networks.get(name);
    }),
  };
  return { docker, old, states, handles, events, initial };
};
