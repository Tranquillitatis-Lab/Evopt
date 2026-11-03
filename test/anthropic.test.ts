import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProposer, createAnthropicTextRunner, type AnthropicProposerOptions } from '../src/anthropic.js';
import { price, canonical } from '../src/validation.js';
import { buildTrainingExperience } from '../src/experience.js';
import { normalizeSelectionPolicy } from '../src/selection.js';

const options: AnthropicProposerOptions = {
  apiKey: 'mock-only-key', model: 'mock-claude',
  pricing: { source: 'mock tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 2, cacheReadUSDPerMillion: 0.1 },
  maxInputTokens: 10_000, maxOutputTokens: 100, inputTokenOverhead: 100, timeoutMs: 1000,
};
const request = { components: { prompt: 'original', immutableSecret: 'do-not-send' }, mutable: { prompt: { role: 'system prompt', maxLength: 100 } }, feedback: [], attempt: 1 };
const context = () => ({ signal: new AbortController().signal, evaluationId: 'evaluation-1' });
const usage = { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 }, inference_geo: 'global', service_tier: 'standard' };
const response = (content = '{"prompt":"improved"}', rest = {}) => new Response(JSON.stringify({
  id: 'msg-1', model: 'mock-claude', stop_reason: 'end_turn', content: [{ type: 'text', text: content }], usage, ...rest,
}), { status: 200 });

test('Anthropic proposer sends explicit bounded Messages requests and normalizes cache usage', async () => {
  let calls = 0, requestBytes = 0;
  const structuredRequest = { ...request, components: { ...request.components, lookupDescription: 'PRIVATE-TOOL-TEXT' },
    mutable: { prompt: { ...request.mutable.prompt, kind: 'prompt' as const, target: { type: 'node' as const, id: 'planner' } } },
    structure: { version: 1 as const, nodes: [{ id: 'planner', role: 'Retrieve verified records', promptKeys: ['prompt', 'immutableSecret'], toolIds: ['lookup'] }],
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
  const proposer = createAnthropicProposer({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), options.apiKey);
    assert.equal(headers.get('anthropic-version'), '2026-10-21');
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal instanceof AbortSignal);
    requestBytes = Buffer.byteLength(init?.body as string, 'utf8');
    assert.ok(requestBytes + options.inputTokenOverhead <= options.maxInputTokens);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, options.model); assert.equal(body.max_tokens, 100); assert.equal(body.stream, false);
    assert.equal(body.service_tier, 'standard_only'); assert.equal(body.inference_geo, 'global');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(body.output_config.format.schema.required, ['prompt']);
    assert.equal(body.tools, undefined); assert.equal(body.cache_control, undefined);
    assert.equal(JSON.stringify(body).includes('do-not-send'), false);
    assert.equal(JSON.stringify(body).includes('PRIVATE-TOOL-TEXT'), false);
    const payload = JSON.parse(body.messages[0].content);
    assert.deepEqual(payload.structure, structuredRequest.structure);
    assert.deepEqual(payload.components, { prompt: 'original' });
    assert.deepEqual(payload.mutable.prompt.target, { type: 'node', id: 'planner' });
    assert.deepEqual(payload.experience, experience); assert.deepEqual(payload.selection, selection); assert.equal(payload.attempt, 3);
    assert.ok(canonical(payload.experience).length <= experience.settings.maxCharacters);
    return response();
  } });
  assert.equal(calls, 0);
  const result = await proposer.propose(learnedRequest, context());
  assert.equal(calls, 1); assert.deepEqual(result.output, { prompt: 'improved' });
  assert.deepEqual(result.usage.receipts[0], { id: 'msg-1', provider: 'anthropic', model: 'mock-claude', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 });
  assert.equal(price(proposer.accounting, result.usage.receipts), 104);
  assert.equal(JSON.stringify(proposer).includes(options.apiKey), false);
  if (proposer.accounting.kind === 'paid') {
    const bounded = createAnthropicProposer({ ...options, maxInputTokens: requestBytes + options.inputTokenOverhead - 1,
      fetch: async () => { calls++; return response(); } });
    await assert.rejects(bounded.propose(learnedRequest, context()), /before dispatch/);
    assert.equal(calls, 1);
  }
});

test('Anthropic text runner uses only its selected prompt and starts fresh messages each call', async () => {
  const bodies: any[] = [];
  const runner = createAnthropicTextRunner({ ...options, promptKey: 'instructions', fetch: async (_url, init) => {
    bodies.push(JSON.parse(init?.body as string)); return response('normalized');
  } });
  const components = { instructions: 'Normalize.', systemPrompt: 'not selected', immutableSecret: 'hidden' };
  for (const input of ['FIRST', 'SECOND']) {
    const result = await runner.run({ input, components, context: context() });
    assert.equal(result.output, 'normalized'); assert.equal(result.usage.complete, true);
  }
  assert.deepEqual(bodies.map(body => body.messages), [[{ role: 'user', content: 'FIRST' }], [{ role: 'user', content: 'SECOND' }]]);
  assert.ok(bodies.every(body => body.system === 'Normalize.' && body.output_config === undefined));
  assert.equal(JSON.stringify(bodies).includes('hidden'), false);
  await assert.rejects(runner.run({ input: 'x', components: { systemPrompt: 'missing' }, context: context() }), /Missing Anthropic prompt/);
  assert.equal(bodies.length, 2);
});

test('Anthropic rejects oversized input and pre-aborted calls without transport', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return response(); };
  const proposer = createAnthropicProposer({ ...options, maxInputTokens: 101, fetch });
  await assert.rejects(proposer.propose(request, context()), /before dispatch/);
  const runner = createAnthropicTextRunner({ ...options, fetch });
  await assert.rejects(runner.run({ input: 'x'.repeat(10000), components: { systemPrompt: 'x' }, context: context() }), /before dispatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(proposer.propose(request, { ...context(), signal: controller.signal }));
  assert.equal(calls, 0);
});

test('Anthropic malformed, truncated, and refused proposals preserve complete billed usage', async () => {
  for (const payload of [response('invalid json'), response('{}', { stop_reason: 'max_tokens' }), response('{}', { stop_reason: 'refusal' }), response('{}', { stop_details: { type: 'refusal' } })]) {
    const proposer = createAnthropicProposer({ ...options, fetch: async () => payload });
    const result = await proposer.propose(request, context());
    assert.equal(result.output, null); assert.equal(result.usage.complete, true); assert.equal(result.usage.receipts.length, 1);
  }
  const runner = createAnthropicTextRunner({ ...options, fetch: async () => response('', { stop_reason: 'max_tokens' }) });
  const failed = await runner.run({ input: 'x', components: { systemPrompt: 'x' }, context: context() });
  assert.equal(failed.output, ''); assert.equal(failed.usage.receipts.length, 1);
});

test('Anthropic HTTP errors, incomplete usage, cache writes, and unsupported tariffs fail without retry', async () => {
  for (const payload of [
    new Response('', { status: 429 }), response('{}', { usage: undefined }), response('{}', { model: 'unexpected-model' }),
    response('{}', { usage: { ...usage, input_tokens: -1 } }),
    response('{}', { usage: { ...usage, cache_creation_input_tokens: 1 } }),
    response('{}', { usage: { ...usage, cache_creation: { ephemeral_1h_input_tokens: 1 } } }),
    response('{}', { usage: { ...usage, server_tool_use: { web_search_requests: 1 } } }),
    response('{}', { usage: { ...usage, inference_geo: 'us' } }),
    response('{}', { usage: { ...usage, service_tier: 'priority' } }),
    response('{}', { usage: { ...usage, speed: 'fast' } }),
  ]) {
    let calls = 0;
    const proposer = createAnthropicProposer({ ...options, fetch: async () => { calls++; return payload; } });
    await assert.rejects(proposer.propose(request, context())); assert.equal(calls, 1);
  }
});

test('Anthropic runner fingerprints bind model, framing overhead, and selected component', () => {
  const versions = [
    createAnthropicTextRunner(options),
    createAnthropicTextRunner({ ...options, model: 'different-model' }),
    createAnthropicTextRunner({ ...options, inputTokenOverhead: 101 }),
    createAnthropicTextRunner({ ...options, promptKey: 'instructions' }),
  ].map(runner => {
    assert.equal(runner.accounting.kind, 'paid');
    return runner.accounting.kind === 'paid' ? runner.accounting.version : '';
  });
  assert.equal(new Set(versions).size, 4);
});

test('Anthropic validates explicit settings and tariff envelope before calls', () => {
  assert.throws(() => createAnthropicProposer({ ...options, apiKey: '' }));
  assert.throws(() => createAnthropicProposer({ ...options, model: '' }));
  assert.throws(() => createAnthropicProposer({ ...options, maxOutputTokens: 0 }));
  assert.throws(() => createAnthropicProposer({ ...options, inputTokenOverhead: 0 }));
  assert.throws(() => createAnthropicProposer({ ...options, timeoutMs: 2_147_483_648 }));
  assert.throws(() => createAnthropicProposer({ ...options, pricing: { ...options.pricing, source: '' } }));
  assert.throws(() => createAnthropicTextRunner({ ...options, promptKey: '' }));
  const proposer = createAnthropicProposer({ ...options, pricing: { ...options.pricing, cacheReadUSDPerMillion: undefined } });
  assert.equal(proposer.accounting.kind, 'paid');
  if (proposer.accounting.kind === 'paid') assert.equal(proposer.accounting.maxCostUSD, 0.0202);
});
