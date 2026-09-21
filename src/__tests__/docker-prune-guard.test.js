'use strict';
const { withPrune, assertNoPrune, NAME, LABEL } = require('../services/docker-prune-guard');
const image = 'sha256:' + 'a'.repeat(64);
const error = code => Object.assign(new Error('Docker error'), { statusCode: code });
let docker, entries, guard, action;
beforeEach(() => {
  entries = []; guard = null; action = jest.fn(async () => ({ SpaceReclaimed: 42 }));
  docker = {
    getImage: jest.fn(() => ({ inspect: jest.fn(async () => ({ Id: image })) })),
    listImages: jest.fn(async () => [{ Id: image }]),
    listContainers: jest.fn(async () => entries),
    getContainer: jest.fn(() => ({ inspect: jest.fn(async () => { if (!guard) throw error(404); return guard.inspect(); }) })),
    createContainer: jest.fn(async options => {
      if (guard) throw error(409);
      guard = { inspect: jest.fn(async () => ({ Config: { Labels: options.Labels } })),
        remove: jest.fn(async () => { guard = null; }) };
      return guard;
    }),
  };
});

test('pins the helper in a never-started reservation through the entire prune', async () => {
  action.mockImplementation(async () => {
    expect(guard).not.toBeNull(); await expect(assertNoPrune(docker)).rejects.toMatchObject({ status: 409 });
    return { SpaceReclaimed: 42 };
  });
  expect(await withPrune(docker, action)).toMatchObject({ SpaceReclaimed: 42, protection: { helperImage: image } });
  expect(docker.createContainer.mock.calls[0][0]).toMatchObject({ name: NAME, Image: image, HostConfig: { NetworkMode: 'none' } });
  expect(guard).toBeNull(); await expect(assertNoPrune(docker)).resolves.toBeUndefined();
});

test.each([
  { Names: ['/dd-recovery-old'] }, { Names: ['/dd-replacement-lock-old'] }, { Names: ['/dd-egress-lock-old'] },
  { Labels: { 'com.docker-dash.replacement.role': 'lock' } },
  { Labels: { 'com.docker-dash.egress-operation': 'operation' } },
  ...['created', 'running', 'exited', 'dead', undefined].flatMap(State => [
    { State, Labels: { 'com.desktop-streamer.release-operation': 'operation' } },
    { State, Labels: { 'com.desktop-streamer.release-reservation': 'reservation' } },
  ]),
  ...['created', 'exited', 'dead', undefined].map(State => ({ State,
    Labels: { 'com.desktop-streamer.cutover-owner': 'owner' } })),
  { State: 'running', Names: ['/ds-cutover-host-legacy-1'], Labels: { 'com.desktop-streamer.cutover-owner': 'owner' } },
])('refuses prune for active or retained recovery evidence: %p', async item => {
  entries.push(item);
  await expect(withPrune(docker, action)).rejects.toMatchObject({ status: 409 });
  expect(action).not.toHaveBeenCalled(); expect(guard).toBeNull();
});

test('a running Desktop Streamer application alone does not reserve prune', async () => {
  entries.push({ State: 'running', Names: ['/ds-prod-app-v2-current'], Labels: {
    'com.desktop-streamer.cutover-owner': 'owner', 'com.desktop-streamer.release-candidate': 'owner',
  } });
  await expect(withPrune(docker, action)).resolves.toMatchObject({ SpaceReclaimed: 42 });
  expect(action).toHaveBeenCalledTimes(1);
});

test('concurrent prune cannot adopt or remove another invocation reservation', async () => {
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  action.mockImplementation(() => new Promise(resolve => { resume = resolve; entered(); }));
  const first = withPrune(docker, action); await ready;
  const owner = guard;
  await expect(withPrune(docker, jest.fn())).rejects.toMatchObject({ status: 409 });
  expect(guard).toBe(owner); expect(owner.remove).not.toHaveBeenCalled();
  resume({}); await first; expect(guard).toBeNull();
});

test.each([undefined, 500])('retains barrier after uncertain prune response %p', async code => {
  action.mockRejectedValue(error(code));
  await expect(withPrune(docker, action)).rejects.toMatchObject({ recoveryRequired: true, recoveryContainer: NAME });
  expect(guard.remove).not.toHaveBeenCalled();
  await expect(assertNoPrune(docker)).rejects.toMatchObject({ status: 409 });
});

test('releases after a confirmed rejection and after a failed preflight', async () => {
  action.mockRejectedValue(error(400)); await expect(withPrune(docker, action)).rejects.toMatchObject({ statusCode: 400 });
  expect(guard).toBeNull();
  docker.listContainers.mockRejectedValue(error(500));
  await expect(withPrune(docker, action)).rejects.toMatchObject({ statusCode: 500 }); expect(guard).toBeNull();
});

test('missing helper is reported, while other image lookup failures stop prune', async () => {
  docker.getImage.mockReturnValue({ inspect: async () => { throw error(404); } });
  expect(await withPrune(docker, action)).toMatchObject({ protection: { helperImageAvailable: false, helperImage: null } });
  docker.getImage.mockReturnValue({ inspect: async () => { throw error(500); } });
  await expect(withPrune(docker, action)).rejects.toMatchObject({ statusCode: 500 });
  expect(action).toHaveBeenCalledTimes(1);
});

test('missing maintenance check response never permits an operation', async () => {
  docker.getContainer.mockReturnValue({ inspect: async () => { throw error(503); } });
  await expect(assertNoPrune(docker)).rejects.toMatchObject({ statusCode: 503 });
});

test('ownership mismatch does not delete the reservation', async () => {
  action.mockImplementation(async () => { guard.inspect.mockResolvedValue({ Config: { Labels: { [LABEL]: 'other' } } }); return {}; });
  await expect(withPrune(docker, action)).rejects.toMatchObject({ status: 409 });
  expect(guard.remove).not.toHaveBeenCalled();
});

test('the actual Docker service forwards the one-label exclusion and retains reclaimed totals', async () => {
  const service = require('../services/docker');
  const config = jest.spyOn(service, '_getHostConfig').mockReturnValue({});
  const connection = jest.spyOn(service, '_createConnection').mockReturnValue(docker);
  docker.pruneContainers = jest.fn(async options => {
    expect(guard).not.toBeNull();
    expect(JSON.parse(options.filters)).toEqual({ 'label!': ['com.docker-dash.prune-protect'] });
    return { SpaceReclaimed: 12 };
  });
  docker.pruneImages = jest.fn(async () => ({ SpaceReclaimed: 30 }));
  try {
    expect(await service.prune({ containers: true, images: true }, 7)).toMatchObject({ SpaceReclaimed: 42 });
    expect(config).toHaveBeenCalledWith(7); expect(guard).toBeNull();
  } finally { config.mockRestore(); connection.mockRestore(); }
});

test('individual image deletion does not recursively prune untagged parent images', async () => {
  const service = require('../services/docker'), remove = jest.fn(async () => {});
  const connection = jest.spyOn(service, 'getDocker').mockReturnValue({ getImage: () => ({ remove }) });
  try {
    await service.removeImage(image, { force: false }, 7);
    expect(remove).toHaveBeenCalledWith({ force: false, noprune: true });
  } finally { connection.mockRestore(); }
});
