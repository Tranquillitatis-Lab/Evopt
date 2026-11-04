import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProposer, type OpenAIProposerOptions } from '../src/adapters/openai.ts';
import { createOpenAIProposer as legacyOpenAIProposer } from '../src/openai.ts';

const pricing = { source: 'fixture', checkedAt: '2026-01-01', inputUSDPerMillion: 2, outputUSDPerMillion: 4, cacheReadUSDPerMillion: 1 };
const request = { components: { prompt: 'Original' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, feedback: [], attempt: 1 };
const context = { evaluationId: 'fixture', signal: new AbortController().signal };
const response = { id: 'request-1', model: 'model-pinned', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }, choices: [{ message: { content: '{"prompt":"Better"}' } }] };

test('legacy OpenAI entry point uses the same adapter', () => {
  assert.equal(legacyOpenAIProposer, createOpenAIProposer);
});

function options(fetch: typeof globalThis.fetch): OpenAIProposerOptions {
  return { apiKey: 'fixture-key', model: 'model-pinned', pricing, maxInputTokens: 10000, maxOutputTokens: 20, inputTokenOverhead: 10, timeoutMs: 1000, fetch };
}

test('OpenAI proposer sends one bounded request and returns metered usage', async () => {
  let calls = 0;
  const fetch = (async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'model-pinned'); assert.equal(body.max_completion_tokens, 20); assert.equal(body.n, 1);
    assert.equal(body.stream, false); assert.equal(body.store, false);
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof globalThis.fetch;
  const proposer = createOpenAIProposer<string, string>(options(fetch));
  assert.equal(proposer.accounting.kind, 'paid');
  const result = await proposer.propose(request, context);
  assert.equal(calls, 1); assert.deepEqual(result.output, { prompt: 'Better' });
  assert.deepEqual(result.usage.receipts[0], { id: 'request-1', provider: 'openai', model: 'model-pinned', inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 2 });
});

test('OpenAI proposer rejects incomplete usage and prevents oversized dispatch', async () => {
  let calls = 0;
  const fetch = (async () => { calls++; return new Response(JSON.stringify({ ...response, usage: { prompt_tokens: 1 } }), { status: 200 }); }) as typeof globalThis.fetch;
  const proposer = createOpenAIProposer(options(fetch));
  await assert.rejects(() => proposer.propose(request, context), /incomplete usage/);
  await assert.rejects(() => proposer.propose({ ...request, components: { prompt: 'x'.repeat(10001) } }, context), /input envelope/);
  assert.equal(calls, 1);
});

test('invalid proposed JSON still returns its receipt, while a different model cannot use the pinned tariff', async () => {
  const invalid = createOpenAIProposer(options((async () => new Response(JSON.stringify({ ...response,
    choices: [{ message: { content: 'not-json' } }] }), { status: 200 })) as typeof globalThis.fetch));
  const result = await invalid.propose(request, context);
  assert.equal(result.output, null);
  assert.equal(result.usage.receipts[0].id, 'request-1');
  const wrongModel = createOpenAIProposer(options((async () => new Response(JSON.stringify({ ...response,
    model: 'other-model' }), { status: 200 })) as typeof globalThis.fetch));
  await assert.rejects(() => wrongModel.propose(request, context), /pinned pricing/);
});

test('OpenAI adapter snapshots its model and pricing configuration', async () => {
  const settings = { ...options((async () => new Response(JSON.stringify(response))) as typeof globalThis.fetch), pricing: { ...pricing } };
  const proposer = createOpenAIProposer(settings);
  settings.model = 'other'; settings.pricing.inputUSDPerMillion = 100;
  const result = await proposer.propose(request, context);
  assert.equal(result.usage.receipts[0].model, 'model-pinned');
  if (proposer.accounting.kind !== 'paid') throw new Error('Expected paid accounting');
  assert.equal(proposer.accounting.pricing.inputUSDPerMillion, pricing.inputUSDPerMillion);
});
