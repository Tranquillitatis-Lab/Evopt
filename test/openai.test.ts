import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProposer } from '../src/openai.js';
import type { OpenAIProposerOptions } from '../src/openai.js';

const options: OpenAIProposerOptions = {
  apiKey: 'test-only-placeholder', model: 'test-model',
  pricing: { source: 'mock tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 2, cacheReadUSDPerMillion: 0.1 },
  maxInputTokens: 10_000, maxOutputTokens: 100, inputTokenOverhead: 100, timeoutMs: 1000,
};
const request = { components: { prompt: 'original', secretImmutable: 'do-not-send' }, mutable: { prompt: { role: 'system prompt', maxLength: 100 } }, feedback: [], attempt: 0 };
const context = () => ({ signal: new AbortController().signal, evaluationId: 'evaluation-1' });
const response = (content = '{"prompt":"improved"}', rest = {}) => new Response(JSON.stringify({
  id: 'chat-1', model: 'test-model', choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } }, ...rest,
}), { status: 200 });

test('explicit OpenAI request, conservative bounds, and cached/reasoning usage', async () => {
  let calls = 0;
  const proposer = createOpenAIProposer({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.n, 1);
    assert.equal(body.store, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.deepEqual(body.response_format.json_schema.schema.required, ['prompt']);
    assert.equal(JSON.stringify(body).includes('do-not-send'), false);
    return response();
  } });
  const result = await proposer.propose(request, context());
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { prompt: 'improved' });
  assert.deepEqual(result.usage.receipts[0], { id: 'chat-1', provider: 'openai', model: 'test-model', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 });
  assert.equal(proposer.accounting.kind, 'paid');
  if (proposer.accounting.kind === 'paid') assert.equal(proposer.accounting.maxCostUSD, 0.0102);
  assert.equal(JSON.stringify(proposer).includes(options.apiKey), false);
});

test('input bound rejects before transport and cancellation makes no request', async () => {
  let calls = 0;
  const proposer = createOpenAIProposer({ ...options, maxInputTokens: 101, fetch: async () => { calls++; return response(); } });
  await assert.rejects(proposer.propose(request, context()), /before dispatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(proposer.propose(request, { ...context(), signal: controller.signal }));
  assert.equal(calls, 0);
});

test('invalid and truncated proposals retain complete usage for settlement', async () => {
  for (const payload of [response('not json'), response('{}', { choices: [{ finish_reason: 'length', message: { content: '{' } }] }), response('{}', { choices: [{ finish_reason: 'stop', message: { refusal: 'refused' } }] })]) {
    const proposer = createOpenAIProposer({ ...options, fetch: async () => payload });
    const result = await proposer.propose(request, context());
    assert.equal(result.output, null);
    assert.equal(result.usage.complete, true);
    assert.equal(result.usage.receipts.length, 1);
  }
});

test('HTTP and missing/invalid usage fail without retries', async () => {
  for (const payload of [new Response('', { status: 429 }), response('{}', { usage: undefined }), response('{}', { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 9 } })]) {
    let calls = 0;
    const proposer = createOpenAIProposer({ ...options, fetch: async () => { calls++; return payload; } });
    await assert.rejects(proposer.propose(request, context()));
    assert.equal(calls, 1);
  }
});

test('configuration requires explicit credentials, prices, and enforceable settings', () => {
  assert.throws(() => createOpenAIProposer({ ...options, apiKey: '' }), /apiKey/);
  assert.throws(() => createOpenAIProposer({ ...options, maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.throws(() => createOpenAIProposer({ ...options, inputTokenOverhead: 0 }), /inputTokenOverhead/);
  assert.throws(() => createOpenAIProposer({ ...options, pricing: { ...options.pricing, outputUSDPerMillion: -1 } }), /price/);
});
