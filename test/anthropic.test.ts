import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProposer, createClaudeProposer, type AnthropicProposerOptions } from '../src/adapters/anthropic.ts';
import { priceUsage, validateAccounting } from '../src/budget.ts';

const pricing = { source: 'fixture', checkedAt: '2026-01-01', inputUSDPerMillion: 2, outputUSDPerMillion: 4, cacheReadUSDPerMillion: 1 };
const request = { components: { prompt: 'Original' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, feedback: [], attempt: 1 };
const context = { evaluationId: 'fixture', signal: new AbortController().signal };
const response = { id: 'msg-1', model: 'model-pinned', usage: { input_tokens: 10, output_tokens: 5,
  cache_creation_input_tokens: 7, cache_read_input_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
  content: [{ type: 'text', text: '{"prompt":"Better"}' }] };

function options(fetch: typeof globalThis.fetch): AnthropicProposerOptions {
  return { apiKey: 'fixture-key', model: 'model-pinned', pricing, cacheWriteUSDPerMillion: 4,
    maxInputTokens: 10000, maxOutputTokens: 20, inputTokenOverhead: 10, timeoutMs: 1000, fetch };
}

test('Anthropic adapter requests bounded schema output and normalizes disjoint cache token categories', async () => {
  let calls = 0;
  const transport = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'model-pinned'); assert.equal(body.max_tokens, 20);
    assert.equal(body.stream, false); assert.equal(body.service_tier, 'standard_only');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.tools, undefined); assert.equal(body.cache_control, undefined);
    assert.equal((init?.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof globalThis.fetch;
  const proposer = createAnthropicProposer<string, string>(options(transport));
  const result = await proposer.propose(request, context);
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { prompt: 'Better' });
  assert.deepEqual(result.usage.receipts[0], { id: 'msg-1', provider: 'anthropic', model: 'model-pinned', inputTokens: 20,
    outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 2, extraCostUSD: 0.000014 });
  const charged = priceUsage(result.usage, proposer.accounting);
  assert.equal(charged.tokens, 25); assert.equal(charged.micros, 71);
  assert.ok(charged.micros <= validateAccounting(proposer.accounting).micros);
  assert.equal(createClaudeProposer, createAnthropicProposer);
});

test('Anthropic adapter rejects missing pricing and oversized requests before dispatch', async () => {
  let calls = 0;
  const transport = (async () => { calls++; return new Response(JSON.stringify(response)); }) as typeof globalThis.fetch;
  assert.throws(() => createAnthropicProposer({ ...options(transport), cacheWriteUSDPerMillion: NaN }), /price/);
  const proposer = createAnthropicProposer(options(transport));
  await assert.rejects(() => proposer.propose({ ...request, components: { prompt: 'x'.repeat(10001) } }, context), /input envelope/);
  assert.equal(calls, 0);
});

test('Anthropic adapter preserves usage for malformed output and refuses incomplete or mismatched receipts', async () => {
  const withResponse = (value: unknown) => createAnthropicProposer(options((async () => new Response(JSON.stringify(value))) as typeof globalThis.fetch));
  const invalid = await withResponse({ ...response, content: [{ type: 'text', text: 'bad json' }] }).propose(request, context);
  assert.equal(invalid.output, null); assert.equal(invalid.usage.receipts[0].id, 'msg-1');
  const invalidContent = await withResponse({ ...response, content: { unexpected: 'object' } }).propose(request, context);
  assert.equal(invalidContent.output, null); assert.equal(invalidContent.usage.receipts[0].id, 'msg-1');
  await assert.rejects(() => withResponse({ ...response, model: 'different' }).propose(request, context), /pinned pricing/);
  await assert.rejects(() => withResponse({ ...response, usage: { input_tokens: 1 } }).propose(request, context), /incomplete/);
  await assert.rejects(() => withResponse({ ...response, usage: { ...response.usage, server_tool_use: { web_search_requests: 1 } } }).propose(request, context), /unmetered/);
});

test('Anthropic adapter snapshots its pricing and request limits', async () => {
  const settings = { ...options((async () => new Response(JSON.stringify(response))) as typeof globalThis.fetch), pricing: { ...pricing } };
  const proposer = createAnthropicProposer(settings);
  settings.model = 'other'; settings.cacheWriteUSDPerMillion = 100; settings.pricing.inputUSDPerMillion = 100;
  const result = await proposer.propose(request, context);
  assert.equal(result.usage.receipts[0].model, 'model-pinned');
  assert.equal(result.usage.receipts[0].extraCostUSD, 0.000014);
});
