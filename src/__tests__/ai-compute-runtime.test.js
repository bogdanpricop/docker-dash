'use strict';

const { PassThrough } = require('node:stream');
const tar = require('tar-stream');
const runtime = require('../services/ai-compute-runtime');
const missing = () => Object.assign(new Error('Missing'), { statusCode: 404 });
const image = () => ({ Id: 'patched', Config: { Labels: { 'docker-dash.ai-compute.recipe': runtime.descriptor().hash, 'docker-dash.ai-compute.runtime': runtime.profile } } });

test('an existing verified runtime is reused without starting or building anything', async () => {
  const client = { getImage: () => ({ inspect: async () => image() }), createContainer: jest.fn(), buildImage: jest.fn() };
  expect(await runtime.ensure(client, 'base', jest.fn(), jest.fn())).toBe('patched');
  expect(client.createContainer).not.toHaveBeenCalled(); expect(client.buildImage).not.toHaveBeenCalled();
});

test('a foreign image occupying the runtime tag is rejected without replacement', async () => {
  const client = { getImage: () => ({ inspect: async () => ({ Id: 'foreign', Config: { Labels: {} } }) }), createContainer: jest.fn() };
  await expect(runtime.ensure(client, 'base', jest.fn(), jest.fn())).rejects.toThrow('image identity changed');
  expect(client.createContainer).not.toHaveBeenCalled();
});

test('build context contains only the reviewed recipe and its reservation never starts', async () => {
  let built = false;
  const reservation = { remove: jest.fn().mockResolvedValue(), start: jest.fn() };
  const client = { getImage: () => ({ inspect: async () => { if (!built) throw missing(); return image(); } }),
    createContainer: jest.fn().mockResolvedValue(reservation), buildImage: jest.fn(async () => {
      const stream = new PassThrough(); setImmediate(() => { built = true; stream.end('{"stream":"Successfully tagged runtime"}\n'); }); return stream;
    }) };
  expect(await runtime.ensure(client, 'base', jest.fn(), jest.fn())).toBe('patched');
  expect(reservation.start).not.toHaveBeenCalled(); expect(reservation.remove).toHaveBeenCalledTimes(1);
  expect(client.createContainer.mock.calls[0][0]).toMatchObject({ Image: 'base', HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true } });
  const [buffer, options] = client.buildImage.mock.calls[0];
  expect(options).toMatchObject({ version: '1', memory: 4 * 1024 ** 3, buildargs: { DOCKER_DASH_RECIPE_HASH: runtime.descriptor().hash } });
  const extract = tar.extract(), entries = [];
  const done = new Promise((resolve,reject) => { extract.on('finish',resolve); extract.on('error',reject); });
  extract.on('entry',(header,stream,next) => { let body=''; stream.on('data',b=>body+=b); stream.on('end',()=>{entries.push({name:header.name,body});next();});stream.resume(); });
  extract.end(buffer); await done;
  expect(entries).toEqual([{ name:'Dockerfile',body:runtime.descriptor().dockerfile }]);
});

test('failed builds release their own reservation and never return an unpatched image', async () => {
  const reservation = { remove: jest.fn().mockResolvedValue() };
  const client = { getImage: () => ({ inspect: async () => { throw missing(); } }), createContainer: async () => reservation,
    buildImage: async () => { const stream=new PassThrough();setImmediate(()=>stream.end('{"errorDetail":{"message":"Source checksum mismatch"}}\n'));return stream; } };
  await expect(runtime.ensure(client,'base',jest.fn(),jest.fn())).rejects.toThrow('Source checksum mismatch');
  expect(reservation.remove).toHaveBeenCalledTimes(1);
});

test('an unrelated reservation is neither reused nor removed', async () => {
  const other={ inspect: async()=>({Config:{Labels:{}},State:{Running:false}}), remove:jest.fn() };
  const client={getImage:()=>({inspect:async()=>{throw missing();}}),createContainer:async()=>{throw Object.assign(new Error('Conflict'),{statusCode:409});},getContainer:()=>other};
  await expect(runtime.ensure(client,'base',jest.fn(),jest.fn())).rejects.toThrow('reservation identity changed');
  expect(other.remove).not.toHaveBeenCalled();
});

test('revoked authorization prevents cache and build mutations', async () => {
  const client={getImage:jest.fn(),createContainer:jest.fn()};
  await expect(runtime.ensure(client,'base',()=>{throw new Error('Revoked');},jest.fn())).rejects.toThrow('Revoked');
  expect(client.getImage).not.toHaveBeenCalled(); expect(client.createContainer).not.toHaveBeenCalled();
});
