import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProposer, type GeminiProposerOptions } from '../src/adapters/gemini.ts';
import { priceUsage } from '../src/budget.ts';

const pricing = { source: 'fixture', checkedAt: '2026-01-01', inputUSDPerMillion: 2, outputUSDPerMillion: 4, cacheReadUSDPerMillion: 1 };
const request = { components: { prompt: 'Original' }, mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, feedback: [], attempt: 1 };
const context = { evaluationId: 'fixture', signal: new AbortController().signal };
const response = { responseId: 'response-1', modelVersion: 'model-pinned',
  usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 },
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"prompt":"Better"}' }] } }] };

function options(fetch: typeof globalThis.fetch): GeminiProposerOptions {
  return { apiKey: 'fixture-key', model: 'model-pinned', pricing, maxInputTokens: 10000, maxOutputTokens: 20, inputTokenOverhead: 10, timeoutMs: 1000, fetch };
}

test('Gemini proposer uses bounded text-only structured generation and counts thoughts and cache once', async () => {
  let calls = 0;
  const fetch = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/model-pinned:generateContent');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.maxOutputTokens, 20);
    assert.equal(body.generationConfig.candidateCount, 1);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT']);
    assert.equal(body.generationConfig.responseJsonSchema.type, 'object');
    assert.equal(body.tools, undefined); assert.equal(body.cachedContent, undefined);
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'fixture-key');
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof globalThis.fetch;
  const proposer = createGeminiProposer<string, string>(options(fetch));
  assert.equal(proposer.accounting.kind, 'paid');
  const result = await proposer.propose(request, context);
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { prompt: 'Better' });
  assert.deepEqual(result.usage.receipts[0], { id: 'response-1', provider: 'gemini', model: 'model-pinned', inputTokens: 10,
    outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 2 });
  assert.equal(priceUsage(result.usage, proposer.accounting).micros, 45);
});

test('Gemini setup and input envelope reject invalid requests before dispatch', async () => {
  let calls = 0;
  const fetch = (async () => { calls++; return new Response(JSON.stringify(response)); }) as typeof globalThis.fetch;
  assert.throws(() => createGeminiProposer({ ...options(fetch), apiKey: '' }), /key/);
  assert.throws(() => createGeminiProposer({ ...options(fetch), model: 'models/model-pinned' }), /bare pinned model ID/);
  assert.throws(() => createGeminiProposer({ ...options(fetch), pricing: { ...pricing, inputUSDPerMillion: NaN } }), /price/);
  assert.throws(() => createGeminiProposer({ ...options(fetch), timeoutMs: 2_147_483_648 }), /timeout/);
  const proposer = createGeminiProposer(options(fetch));
  await assert.rejects(() => proposer.propose({ ...request, components: { prompt: 'x'.repeat(10001) } }, context), /input envelope/);
  assert.equal(calls, 0);
});

test('Gemini retains billed receipts for malformed, blocked, or truncated outputs', async () => {
  const withResponse = (value: unknown) => createGeminiProposer(options((async () => new Response(JSON.stringify(value))) as typeof globalThis.fetch));
  for (const bad of [
    { ...response, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not JSON' }] } }] },
    { ...response, candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"prompt":"partial"}' }] } }] },
    { ...response, candidates: null },
    { ...response, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"prompt":"good"}' }, { functionCall: {} }] } }] },
  ]) {
    const result = await withResponse(bad).propose(request, context);
    assert.equal(result.output, null); assert.equal(result.usage.receipts[0].id, 'response-1');
  }
  const blocked = { responseId: 'blocked', modelVersion: 'model-pinned', promptFeedback: { blockReason: 'SAFETY' },
    usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } };
  const result = await withResponse(blocked).propose(request, context);
  assert.equal(result.output, null); assert.equal(result.usage.receipts[0].inputTokens, 10);
});

test('Gemini rejects incomplete, non-text, or mispriced usage without inventing a receipt', async () => {
  const withResponse = (value: unknown) => createGeminiProposer(options((async () => new Response(JSON.stringify(value))) as typeof globalThis.fetch));
  await assert.rejects(() => withResponse({ ...response, modelVersion: 'other' }).propose(request, context), /pinned model/);
  await assert.rejects(() => withResponse({ ...response, usageMetadata: { promptTokenCount: 10 } }).propose(request, context), /total tokens/);
  await assert.rejects(() => withResponse({ ...response, usageMetadata: { ...response.usageMetadata, totalTokenCount: 999 } }).propose(request, context), /totals/);
  await assert.rejects(() => withResponse({ ...response, usageMetadata: { ...response.usageMetadata, serviceTier: 'PRIORITY' } }).propose(request, context), /tier/);
  await assert.rejects(() => withResponse({ ...response, usageMetadata: { ...response.usageMetadata, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 5 }] } }).propose(request, context), /non-text/);
  await assert.rejects(() => withResponse({ ...response, candidates: [{ ...response.candidates[0], groundingMetadata: {} }] }).propose(request, context), /grounding/);
});

test('Gemini returns complete over-envelope usage for the ledger to record and block', async () => {
  const data = { ...response, usageMetadata: { ...response.usageMetadata, candidatesTokenCount: 20, thoughtsTokenCount: 3, totalTokenCount: 33 } };
  const proposer = createGeminiProposer(options((async () => new Response(JSON.stringify(data))) as typeof globalThis.fetch));
  const result = await proposer.propose(request, context);
  assert.equal(result.usage.receipts[0].outputTokens, 23);
  assert.equal(priceUsage(result.usage, proposer.accounting).violation, true);
});

test('Gemini snapshots model and pricing options at setup', async () => {
  const settings = { ...options((async () => new Response(JSON.stringify(response))) as typeof globalThis.fetch), pricing: { ...pricing } };
  const proposer = createGeminiProposer(settings);
  settings.model = 'other'; settings.pricing.inputUSDPerMillion = 100;
  const result = await proposer.propose(request, context);
  assert.equal(result.usage.receipts[0].model, 'model-pinned');
  if (proposer.accounting.kind !== 'paid') throw new Error('Expected paid accounting');
  assert.equal(proposer.accounting.pricing.inputUSDPerMillion, pricing.inputUSDPerMillion);
});
