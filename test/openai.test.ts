import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProposer } from '../src/openai.js';
import type { OpenAIProposerOptions } from '../src/openai.js';
import { buildTrainingExperience } from '../src/experience.js';
import { normalizeSelectionPolicy } from '../src/selection.js';
import { canonical } from '../src/validation.js';

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
  let calls = 0, requestBytes = 0;
  const structuredRequest = { ...request, components: { ...request.components, lookupDescription: 'PRIVATE-TOOL-TEXT' },
    mutable: { prompt: { ...request.mutable.prompt, kind: 'prompt' as const, target: { type: 'node' as const, id: 'planner' } } },
    structure: { version: 1 as const, nodes: [{ id: 'planner', role: 'Retrieve verified records', promptKeys: ['prompt', 'secretImmutable'], toolIds: ['lookup'] }],
      tools: [{ id: 'lookup', descriptionKey: 'lookupDescription', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, constraints: ['Read-only'] }], handoffs: [] } };
  const experience = buildTrainingExperience({
    candidates: [{ id: 'baseline', components: structuredRequest.components }, { id: 'earlier', components: { ...structuredRequest.components, prompt: 'Earlier draft: café 数据' } }],
    evaluations: [{ id: 'baseline-eval', candidateId: 'baseline', caseId: 'train-1', split: 'train', passed: true, usage: [] },
      { id: 'earlier-eval', candidateId: 'earlier', caseId: 'train-1', split: 'train', passed: false, usage: [] }],
    entries: [{ id: 'baseline-eval', purpose: 'eval:baseline:train:train-1', status: 'settled', reservedMicros: 0, chargedMicros: 0, receipts: [] },
      { id: 'earlier-eval', purpose: 'eval:earlier:train:train-1', status: 'settled', reservedMicros: 0, chargedMicros: 0, receipts: [] }],
    history: [{ attempt: 1, status: 'evaluated', candidateId: 'earlier', parentId: 'baseline', proposalId: 'proposal-1', changedKeys: ['prompt'], operator: 'proposer-text-patch' },
      { attempt: 2, status: 'rejected', reason: 'Invalid or oversized component' }],
    baselineId: 'baseline', incumbentId: 'baseline', mutable: structuredRequest.mutable, settings: { maxCharacters: 2048 },
  });
  const selection = normalizeSelectionPolicy({ kind: 'quality-constrained-resource', metric: 'usd', minValidationAccuracy: 0.9, maxRegressions: 0 });
  const learnedRequest = { ...structuredRequest, attempt: 3, experience, selection };
  const proposer = createOpenAIProposer({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    requestBytes = Buffer.byteLength(init?.body as string, 'utf8');
    assert.ok(requestBytes + options.inputTokenOverhead <= options.maxInputTokens);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.n, 1);
    assert.equal(body.store, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.deepEqual(body.response_format.json_schema.schema.required, ['prompt']);
    assert.equal(JSON.stringify(body).includes('do-not-send'), false);
    assert.equal(JSON.stringify(body).includes('PRIVATE-TOOL-TEXT'), false);
    const payload = JSON.parse(body.messages[1].content);
    assert.deepEqual(payload.structure, structuredRequest.structure);
    assert.deepEqual(payload.components, { prompt: 'original' });
    assert.deepEqual(payload.mutable.prompt.target, { type: 'node', id: 'planner' });
    assert.deepEqual(payload.experience, experience); assert.deepEqual(payload.selection, selection); assert.equal(payload.attempt, 3);
    assert.ok(canonical(payload.experience).length <= experience.settings.maxCharacters);
    return response();
  } });
  const result = await proposer.propose(learnedRequest, context());
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { prompt: 'improved' });
  assert.deepEqual(result.usage.receipts[0], { id: 'chat-1', provider: 'openai', model: 'test-model', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 });
  assert.equal(proposer.accounting.kind, 'paid');
  if (proposer.accounting.kind === 'paid') {
    assert.equal(proposer.accounting.maxCostUSD, 0.0102);
    const bounded = createOpenAIProposer({ ...options, maxInputTokens: requestBytes + options.inputTokenOverhead - 1,
      fetch: async () => { calls++; return response(); } });
    await assert.rejects(bounded.propose(learnedRequest, context()), /before dispatch/);
    assert.equal(calls, 1);
  }
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
