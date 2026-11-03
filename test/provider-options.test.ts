import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAITextRunner, createOpenAICompatibleTextRunner, createOpenAICompatibleProposer,
  type OpenAITextRunnerOptions, type OpenAICompatibleOptions,
} from '../src/openai.js';

const options: OpenAITextRunnerOptions = {
  apiKey: 'mock-key-only', model: 'pinned-test-model',
  pricing: { source: 'mock tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 2, cacheReadUSDPerMillion: 0.1 },
  maxInputTokens: 10_000, maxOutputTokens: 100, inputTokenOverhead: 100, timeoutMs: 1000,
};
const compatible: OpenAICompatibleOptions = { ...options, baseURL: 'https://provider.example/v1/', provider: 'reviewed-provider' };
const context = () => ({ signal: new AbortController().signal, evaluationId: 'fresh-evaluation' });
const response = (content = 'normalized', rest = {}) => new Response(JSON.stringify({
  id: 'response-1', model: options.model, choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } },
  ...rest,
}), { status: 200 });
const args = () => ({ input: 'normalize this', components: { systemPrompt: 'Normalize text.', fixed: 'private-immutable-value' }, context: context() });

test('OpenAI text runner sends only the selected component with a bounded fresh request', async () => {
  const messages: unknown[][] = [];
  const runner = createOpenAITextRunner({ ...options, fetch: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer mock-key-only');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, options.model); assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.n, 1); assert.equal(body.stream, false); assert.equal(body.store, false);
    assert.equal(body.tools, undefined); assert.equal(body.response_format, undefined);
    assert.equal(JSON.stringify(body).includes('private-immutable-value'), false);
    messages.push(body.messages); return response();
  } });
  const result = await runner.run(args());
  await runner.run({ ...args(), input: 'a new input' });
  assert.deepEqual(messages, [
    [{ role: 'system', content: 'Normalize text.' }, { role: 'user', content: 'normalize this' }],
    [{ role: 'system', content: 'Normalize text.' }, { role: 'user', content: 'a new input' }],
  ]);
  assert.equal(result.output, 'normalized');
  assert.deepEqual(result.usage.receipts[0], {
    id: 'response-1', provider: 'openai', model: options.model, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5,
  });
  assert.equal(runner.accounting.kind, 'paid');
  if (runner.accounting.kind === 'paid') {
    assert.equal(runner.accounting.maxCostUSD, 0.0102);
    assert.equal(runner.accounting.limits.maxRetries, 0);
    assert.equal(runner.accounting.limits.maxPaidToolCalls, 0);
    assert.equal(runner.accounting.limits.maxModelCalls, 1);
  }
  assert.equal(JSON.stringify(runner).includes(options.apiKey), false);
});

test('text runner requires explicit setup and its selected prompt before any dispatch', async () => {
  for (const patch of [{ apiKey: '' }, { model: '' }, { maxOutputTokens: 0 }, { inputTokenOverhead: 0 }, { promptKey: '' }]) {
    assert.throws(() => createOpenAITextRunner({ ...options, ...patch }));
  }
  let calls = 0;
  const runner = createOpenAITextRunner({ ...options, promptKey: 'instructions', fetch: async (_url, init) => {
    calls++; assert.equal(JSON.parse(init?.body as string).messages[0].content, 'Use this prompt.'); return response();
  } });
  await assert.rejects(runner.run(args()), /configured prompt/);
  await assert.rejects(runner.run({ ...args(), input: 4 as unknown as string }), /string input/);
  assert.equal(calls, 0);
  await runner.run({ ...args(), components: { instructions: 'Use this prompt.' } });
  assert.equal(calls, 1);
  const small = createOpenAITextRunner({ ...options, maxInputTokens: 101, fetch: async () => { calls++; return response(); } });
  await assert.rejects(small.run(args()), /before dispatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runner.run({ ...args(), context: { ...context(), signal: controller.signal } }));
  assert.equal(calls, 1);
});

test('compatible target uses only explicit HTTPS endpoint and provider identity', async () => {
  let calls = 0;
  const runner = createOpenAICompatibleTextRunner({ ...compatible, fetch: async (url, init) => {
    calls++; assert.equal(url, 'https://provider.example/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(JSON.parse(init?.body as string).max_completion_tokens, 100);
    return response();
  } });
  const result = await runner.run(args());
  assert.equal(calls, 1);
  assert.equal(result.usage.receipts[0]!.provider, 'openai-compatible:reviewed-provider');
  for (const baseURL of ['', 'http://provider.example/v1', 'https://user:secret@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#fragment']) {
    assert.throws(() => createOpenAICompatibleTextRunner({ ...compatible, baseURL }));
  }
  assert.throws(() => createOpenAICompatibleTextRunner({ ...compatible, provider: '' }), /provider/);
  assert.equal(calls, 1);
});

test('compatible endpoint, provider, and prompt selection affect durable adapter identity', () => {
  const runner = createOpenAICompatibleTextRunner(compatible);
  const alternateEndpoint = createOpenAICompatibleTextRunner({ ...compatible, baseURL: 'https://another.example/v1' });
  const alternateProvider = createOpenAICompatibleTextRunner({ ...compatible, provider: 'other-provider' });
  const alternatePrompt = createOpenAICompatibleTextRunner({ ...compatible, promptKey: 'instructions' });
  assert.equal(runner.accounting.kind, 'paid');
  if (runner.accounting.kind === 'paid' && alternateEndpoint.accounting.kind === 'paid' && alternateProvider.accounting.kind === 'paid' && alternatePrompt.accounting.kind === 'paid') {
    assert.notEqual(runner.accounting.version, alternateEndpoint.accounting.version);
    assert.notEqual(runner.accounting.version, alternateProvider.accounting.version);
    assert.notEqual(runner.accounting.version, alternatePrompt.accounting.version);
  }
  const proposer = createOpenAICompatibleProposer(compatible);
  assert.notEqual(proposer.version, createOpenAICompatibleProposer({ ...compatible, baseURL: 'https://another.example/v1' }).version);
  assert.notEqual(proposer.id, createOpenAICompatibleProposer({ ...compatible, provider: 'other-provider' }).id);
  assert.equal(proposer.version, createOpenAICompatibleProposer({ ...compatible, baseURL: 'https://provider.example/v1' }).version);
});

test('compatible proposals retain structured output and explicit caps without exposing immutable text', async () => {
  let calls = 0;
  const proposer = createOpenAICompatibleProposer({ ...compatible, fetch: async (url, init) => {
    calls++; assert.equal(url, 'https://provider.example/v1/chat/completions');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.max_completion_tokens, 100); assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.required, ['prompt']);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(JSON.stringify(body).includes('private-immutable-value'), false);
    return response('{"prompt":"Better instructions."}');
  } });
  const result = await proposer.propose({
    components: { prompt: 'Original.', fixed: 'private-immutable-value' }, mutable: { prompt: { role: 'system prompt', maxLength: 100 } }, feedback: [], attempt: 1,
  }, context());
  assert.equal(calls, 1); assert.deepEqual(result.output, { prompt: 'Better instructions.' });
  assert.equal(result.usage.receipts[0]!.provider, 'openai-compatible:reviewed-provider');
});

test('text refusal and truncation retain usage while HTTP or incomplete usage never retries', async () => {
  for (const choice of [{ finish_reason: 'stop', message: { refusal: 'declined' } }, { finish_reason: 'length', message: { content: 'partial answer' } }]) {
    let calls = 0;
    const runner = createOpenAITextRunner({ ...options, fetch: async () => { calls++; return response('', { choices: [choice] }); } });
    const result = await runner.run(args());
    assert.equal(result.output, ''); assert.equal(result.usage.complete, true);
    assert.equal(result.usage.receipts[0]!.outputTokens, 20); assert.equal(calls, 1);
  }
  for (const payload of [new Response('', { status: 429 }), response('', { usage: undefined }), response('', { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 10 } })]) {
    let calls = 0;
    const runner = createOpenAICompatibleTextRunner({ ...compatible, fetch: async () => { calls++; return payload; } });
    await assert.rejects(runner.run(args())); assert.equal(calls, 1);
  }
});
