import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProposer, createGeminiTextRunner } from '../src/gemini.js';
import type { GeminiProposerOptions } from '../src/gemini.js';
import { price, validateAccounting, canonical } from '../src/validation.js';
import { buildTrainingExperience } from '../src/experience.js';
import { normalizeSelectionPolicy } from '../src/selection.js';

const options: GeminiProposerOptions = {
  apiKey: 'test-only-placeholder', model: 'test-text-model',
  pricing: { source: 'mock standard tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 2, cacheReadUSDPerMillion: 0.1 },
  maxInputTokens: 10_000, maxOutputTokens: 100, inputTokenOverhead: 100, timeoutMs: 1000,
};
const request = {
  components: { prompt: 'original', secretImmutable: 'do-not-send' },
  mutable: { prompt: { role: 'system prompt', maxLength: 100 } },
  feedback: [{ caseId: 'train-1', input: 'hello', expected: 'greeting', output: 'other', passed: false }], attempt: 0,
};
const context = () => ({ signal: new AbortController().signal, evaluationId: 'evaluation-1' });
const usage = { total_input_tokens: 100, total_cached_tokens: 40, total_output_tokens: 20, total_thought_tokens: 5, total_tokens: 125 };
const response = (content = '{"prompt":"improved"}', rest: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: 'interaction-1', model: 'test-text-model', status: 'completed', usage,
  steps: [{ type: 'thought', signature: 'not-a-conversation' }, { type: 'model_output', content: [{ type: 'text', text: content }] }], ...rest,
}), { status: 200 });

test('Gemini requests use stateless Interactions and account for cached input plus thinking', async () => {
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
  const proposer = createGeminiProposer({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    requestBytes = Buffer.byteLength(init?.body as string, 'utf8');
    assert.ok(requestBytes + options.inputTokenOverhead <= options.maxInputTokens);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key'), options.apiKey);
    assert.equal(headers.get('Api-Revision'), '2026-05-20');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, options.model);
    assert.equal(body.generation_config.max_output_tokens, 100);
    assert.equal(body.generation_config.thinking_summaries, 'none');
    assert.equal(body.generation_config.tool_choice, 'none');
    assert.equal(body.service_tier, 'standard');
    assert.equal(body.store, false);
    assert.equal(body.background, false);
    assert.equal(body.stream, false);
    assert.equal(body.previous_interaction_id, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.agent, undefined);
    assert.equal(body.response_format.type, 'text');
    assert.equal(body.response_format.mime_type, 'application/json');
    assert.deepEqual(body.response_format.schema.required, ['prompt']);
    assert.equal(body.response_format.schema.additionalProperties, false);
    assert.equal(JSON.stringify(body).includes('do-not-send'), false);
    assert.equal(JSON.stringify(body).includes('PRIVATE-TOOL-TEXT'), false);
    const payload = JSON.parse(body.input);
    assert.deepEqual(payload.feedback, request.feedback);
    assert.deepEqual(payload.structure, structuredRequest.structure);
    assert.deepEqual(payload.components, { prompt: 'original' });
    assert.deepEqual(payload.mutable.prompt.target, { type: 'node', id: 'planner' });
    assert.deepEqual(payload.experience, experience); assert.deepEqual(payload.selection, selection); assert.equal(payload.attempt, 3);
    assert.ok(canonical(payload.experience).length <= experience.settings.maxCharacters);
    return response();
  } });
  assert.equal(calls, 0);
  const result = await proposer.propose(learnedRequest, context());
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { prompt: 'improved' });
  assert.deepEqual(result.usage.receipts[0], {
    id: 'interaction-1', provider: 'gemini', model: 'test-text-model', inputTokens: 100, outputTokens: 25, cachedInputTokens: 40, reasoningTokens: 5,
  });
  assert.equal(validateAccounting(proposer.accounting), 10200);
  assert.equal(price(proposer.accounting, result.usage.receipts), 114);
  assert.equal(JSON.stringify(proposer).includes(options.apiKey), false);
  if (proposer.accounting.kind === 'paid') {
    const bounded = createGeminiProposer({ ...options, maxInputTokens: requestBytes + options.inputTokenOverhead - 1,
      fetch: async () => { calls++; return response(); } });
    await assert.rejects(bounded.propose(learnedRequest, context()), /before dispatch/);
    assert.equal(calls, 1);
  }
});

test('Gemini text evaluations use only their current input and configured prompt', async () => {
  const bodies: Record<string, unknown>[] = [];
  const runner = createGeminiTextRunner({ ...options, promptKey: 'prompt', fetch: async (_url, init) => {
    bodies.push(JSON.parse(init?.body as string));
    return response('hello', { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] }] });
  } });
  assert.equal((await runner.run({ input: 'first', components: request.components, context: context() })).output, 'hello');
  await runner.run({ input: 'second', components: { prompt: 'updated' }, context: { ...context(), evaluationId: 'evaluation-2' } });
  assert.equal(bodies[0]?.system_instruction, 'original');
  assert.equal(bodies[0]?.input, 'first');
  assert.equal(bodies[1]?.system_instruction, 'updated');
  assert.equal(bodies[1]?.input, 'second');
  assert.deepEqual(bodies[1]?.response_format, { type: 'text', mime_type: 'text/plain' });
  assert.equal(JSON.stringify(bodies).includes('expected'), false);
  assert.equal(JSON.stringify(bodies).includes('do-not-send'), false);
  assert.equal(JSON.stringify(bodies[1]).includes('first'), false);
  await assert.rejects(runner.run({ input: 'x', components: {}, context: context() }), /configured prompt/);
});

test('Gemini input bounds and cancellation reject before dispatch', async () => {
  let calls = 0;
  const proposer = createGeminiProposer({ ...options, maxInputTokens: 101, fetch: async () => { calls++; return response(); } });
  await assert.rejects(proposer.propose(request, context()), /before dispatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(proposer.propose(request, { ...context(), signal: controller.signal }));
  assert.equal(calls, 0);
});

test('Gemini honors tighter invocation limits and aborts the active request', async () => {
  let signal: AbortSignal | undefined;
  const runner = createGeminiTextRunner({ ...options, fetch: async (_url, init) => {
    signal = init?.signal ?? undefined;
    assert.equal(JSON.parse(init?.body as string).generation_config.max_output_tokens, 50);
    return response('answer');
  } });
  const controller = new AbortController();
  await runner.run({ input: 'x', components: { systemPrompt: 'p' }, context: {
    signal: controller.signal, evaluationId: 'id',
    limits: { maxInputTokens: 10000, maxOutputTokens: 50, maxModelCalls: 1, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  } });
  controller.abort();
  assert.equal(signal?.aborted, true);
});

test('Gemini rejects invalid proposals while preserving measured usage', async () => {
  for (const payload of [
    response('not json'), response('{}'), response('[]'), response('{"prompt":3}'),
    response('{"prompt":"good","immutable":"bad"}'), response(JSON.stringify({ prompt: 'x'.repeat(101) })),
    response('{', { status: 'incomplete' }), response('', { status: 'failed', steps: [] }),
  ]) {
    const result = await createGeminiProposer({ ...options, fetch: async () => payload }).propose(request, context());
    assert.equal(result.output, null);
    assert.equal(result.usage.complete, true);
    assert.equal(result.usage.receipts[0]?.outputTokens, 25);
  }
});

test('Gemini blocked and truncated target outputs are empty but metered', async () => {
  for (const status of ['failed', 'cancelled', 'incomplete']) {
    const runner = createGeminiTextRunner({ ...options, fetch: async () => response('partial', { status }) });
    const result = await runner.run({ input: 'x', components: { systemPrompt: 'p' }, context: context() });
    assert.equal(result.output, '');
    assert.equal(result.usage.receipts.length, 1);
  }
});

test('Gemini HTTP, incomplete metering, and unexpected paid tools fail without retry', async () => {
  for (const payload of [
    new Response('secret provider detail', { status: 429 }), response('{}', { usage: undefined }),
    response('{}', { id: undefined }), response('{}', { model: undefined }),
    response('{}', { usage: { ...usage, total_tokens: 120 } }),
    response('{}', { usage: { ...usage, total_cached_tokens: 101 } }),
    response('{}', { usage: { ...usage, total_output_tokens: -1 } }),
    response('{}', { usage: { ...usage, total_tool_use_tokens: 1 } }),
    response('{}', { usage: { ...usage, grounding_tool_count: [{ type: 'google_search', count: 1 }] } }),
    response('{}', { status: 'in_progress' }),
  ]) {
    let calls = 0;
    const proposer = createGeminiProposer({ ...options, fetch: async () => { calls++; return payload; } });
    await assert.rejects(proposer.propose(request, context()), error => {
      assert.equal(String(error).includes('secret provider detail'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Gemini returns measured overruns for the optimizer to settle and flag', async () => {
  const result = await createGeminiProposer({ ...options, fetch: async () => response('{"prompt":"ok"}', {
    usage: { ...usage, total_thought_tokens: 100, total_tokens: 220 },
  }) }).propose(request, context());
  assert.equal(result.usage.receipts[0]?.outputTokens, 120);
});

test('Gemini construction validates explicit priced bounds and freezes the contract', () => {
  assert.throws(() => createGeminiProposer({ ...options, apiKey: '' }), /apiKey/);
  assert.throws(() => createGeminiProposer({ ...options, model: '' }), /model/);
  assert.throws(() => createGeminiProposer({ ...options, maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.throws(() => createGeminiProposer({ ...options, inputTokenOverhead: 0 }), /inputTokenOverhead/);
  assert.throws(() => createGeminiProposer({ ...options, inputTokenOverhead: 10000 }), /capacity/);
  assert.throws(() => createGeminiProposer({ ...options, pricing: { ...options.pricing, checkedAt: 'invalid' } }), /pricing date/);
  assert.throws(() => createGeminiProposer({ ...options, pricing: { ...options.pricing, outputUSDPerMillion: -1 } }), /price/);
  const mutableOptions = { ...options, pricing: { ...options.pricing } };
  const proposer = createGeminiProposer(mutableOptions);
  mutableOptions.pricing.inputUSDPerMillion = 0;
  assert.equal(validateAccounting(proposer.accounting), 10200);
  assert.equal(Object.isFrozen(proposer.accounting), true);
  const noCacheRate = createGeminiProposer({ ...options, pricing: { ...options.pricing, cacheReadUSDPerMillion: undefined } });
  assert.equal(validateAccounting(noCacheRate.accounting), 20200);
});
