'use strict';

const dgx = require('../services/ai/dgx');

test('discovers models independently from the saved model and returns supported metadata only', async () => {
  const fetch = jest.fn(async () => ({ data: [
    { id: 'Qwen/Qwen3-4B', owned_by: 'vllm', created: 1794945538, max_model_len: 4096, permission: [{ private: true }] },
    { id: 'another-model' },
  ] }));
  const result = await dgx.models({ model: 'unavailable-old-model' }, fetch);
  expect(fetch).toHaveBeenCalledWith({ model: 'unavailable-old-model' }, '/v1/models', null, 8000);
  expect(result.models).toEqual([
    { id: 'Qwen/Qwen3-4B', ownedBy: 'vllm', created: 1794945538, contextLength: 4096 },
    { id: 'another-model', ownedBy: null, created: null, contextLength: null },
  ]);
  expect(result.fetchedAt).toBeTruthy();
});

test('empty model list is valid and model errors remain visible', async () => {
  await expect(dgx.models({}, async () => ({ data: [] }))).resolves.toMatchObject({ models: [] });
  await expect(dgx.models({}, async () => { throw new Error('Gateway HTTP 502'); })).rejects.toThrow('HTTP 502');
});

test('rejects malformed lists and invalid identifiers, and bounds optional metadata', async () => {
  for (const response of [{}, { data: [null] }, { data: [{ id: '<script>' }] }, { data: Array(501).fill({ id: 'model' }) }]) {
    await expect(dgx.models({}, async () => response)).rejects.toThrow(/invalid/);
  }
  const result = await dgx.models({}, async () => ({ data: [{ id: 'model', owned_by: 'a'.repeat(1000), created: 1e15, max_model_len: -1 }] }));
  expect(result.models[0].ownedBy).toHaveLength(160);
  expect(result.models[0].created).toBeNull();
  expect(result.models[0].contextLength).toBeNull();
});
