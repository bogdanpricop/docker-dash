'use strict';

const AnthropicProvider = require('../services/ai/providers/anthropic');
const OpenAiProvider = require('../services/ai/providers/openai');
const { AUDIT_FILTER_SCHEMA } = require('../services/ai/features/audit-search');

const request = {
  systemPrompt: 'Build a filter', userPrompt: 'Find login events',
  toolName: 'audit_filter', schema: AUDIT_FILTER_SCHEMA, maxTokens: 256,
};

test.each(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'])(
  'sends compatible structured-output parameters to %s', async model => {
    const provider = new OpenAiProvider({ apiKey: 'fixture', model });
    provider._request = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '{"actor":null,"action":"login","limit":25}' }, finish_reason: 'stop' }],
    });
    await expect(provider.structured(request)).resolves.toMatchObject({ data: { action: 'login', limit: 25 } });
    const [method, url, body] = provider._request.mock.calls[0];
    expect([method, url]).toEqual(['POST', '/v1/chat/completions']);
    expect(body.reasoning_effort).toBe(['gpt-6-luna', 'gpt-6.1-terra'].includes(model) ? 'none' : 'low');
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(256);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    const schema = body.response_format.json_schema.schema;
    expect(schema.required).toEqual(Object.keys(AUDIT_FILTER_SCHEMA.properties));
    expect(schema.properties.actor).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(AUDIT_FILTER_SCHEMA.properties.actor.maxLength).toBe(64);
  },
);

test.each(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])(
  'requests native structured JSON from %s', async model => {
    const provider = new AnthropicProvider({ apiKey: 'fixture', model });
    provider._request = jest.fn().mockResolvedValue({
      content: [{ type: 'thinking' }, { type: 'text', text: '{"limit":25}' }], stop_reason: 'end_turn',
    });
    await expect(provider.structured(request)).resolves.toMatchObject({ data: { limit: 25 } });
    const [method, url, body] = provider._request.mock.calls[0];
    expect([method, url]).toEqual(['POST', '/v1/messages']);
    expect(body).not.toHaveProperty('tool_choice');
    expect(body.output_config.format).toMatchObject({
      type: 'json_schema', schema: { required: [], properties: { limit: { type: 'integer' } } },
    });
    provider._request.mockResolvedValueOnce({ id: model });
    await expect(provider.test()).resolves.toMatchObject({ ok: true, modelEcho: model });
    expect(provider._request).toHaveBeenLastCalledWith('GET', '/v1/models/' + model, null, 5000);
  },
);

test('keeps the saved Claude 4.5 tool response and rejects truncated JSON', async () => {
  const provider = new AnthropicProvider({ apiKey: 'fixture', model: 'claude-haiku-4-5-20251001' });
  provider._request = jest.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: request.toolName, input: { limit: 25 } }],
  });
  await expect(provider.structured(request)).resolves.toMatchObject({ data: { limit: 25 } });
  expect(provider._request.mock.calls[0][2].tool_choice).toEqual({ type: 'tool', name: 'audit_filter' });
  const current = new AnthropicProvider({ apiKey: 'fixture' });
  current._request = jest.fn().mockResolvedValue({
    content: [{ type: 'text', text: '{"limit":25}' }], stop_reason: 'max_tokens',
  });
  await expect(current.structured(request)).rejects.toMatchObject({ code: 'empty-response' });
});
