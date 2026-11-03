import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Experiment, RunContext } from 'evopt';

const settings = {
  apiKey: 'mock-private-key', model: 'mock-model',
  pricing: { source: 'mock tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 2, cacheReadUSDPerMillion: 0.1 },
  maxInputTokens: 10000, maxOutputTokens: 100, inputTokenOverhead: 100, timeoutMs: 1000, maxAttempts: 1,
};
const context = (): RunContext => ({ signal: new AbortController().signal, evaluationId: randomUUID() });
const payload = (content = 'books', extra = {}) => new Response(JSON.stringify({
  id: randomUUID(), model: 'mock-model', choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } },
  ...extra,
}), { status: 200 });
async function loadExperiment(): Promise<Experiment<string, string>> {
  const url = pathToFileURL(resolve('experiments/openai-text.mjs'));
  url.searchParams.set('test', randomUUID());
  return (await import(url.href)).default;
}
async function fixture(t: { after(fn: () => Promise<void>): void }, config = settings) {
  const dir = await mkdtemp(join(tmpdir(), 'evopt-openai-example-'));
  const previousPath = process.env.EVOPT_EXPERIMENT_SETTINGS, previousFetch = globalThis.fetch;
  await writeFile(join(dir, 'settings.json'), JSON.stringify(config));
  process.env.EVOPT_EXPERIMENT_SETTINGS = join(dir, 'settings.json');
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) delete process.env.EVOPT_EXPERIMENT_SETTINGS;
    else process.env.EVOPT_EXPERIMENT_SETTINGS = previousPath;
    await rm(dir, { recursive: true, force: true });
  });
}

test('paid example fails closed without explicitly selected complete settings', async t => {
  await fixture(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return payload(); };
  delete process.env.EVOPT_EXPERIMENT_SETTINGS;
  await assert.rejects(loadExperiment(), /EVOPT_EXPERIMENT_SETTINGS/);
  process.env.EVOPT_EXPERIMENT_SETTINGS = resolve('experiments/openai-settings.example.json');
  await assert.rejects(loadExperiment(), /maxAttempts/);
  assert.equal(calls, 0);
});

test('paid example target and proposer are import-safe, bounded, and normalize usage with mock transport', async t => {
  await fixture(t);
  const bodies: any[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(init?.body as string); bodies.push(body);
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.store, false); assert.equal(body.stream, false); assert.equal(body.n, 1);
    assert.equal(body.tools, undefined);
    return payload(body.response_format ? '{"systemPrompt":"Normalize whitespace and lowercase."}' : 'books');
  };
  const experiment = await loadExperiment();
  assert.equal(bodies.length, 0);
  assert.equal(JSON.stringify(experiment).includes(settings.apiKey), false);
  assert.equal(experiment.agent.accounting.kind, 'paid');
  assert.equal(experiment.agent.optimization.maxAttempts, 1);
  const target = await experiment.agent.run({ input: '  BOOKS ', components: experiment.agent.components, context: context() });
  assert.equal(target.output, 'books');
  assert.deepEqual(bodies[0].messages, [
    { role: 'system', content: experiment.agent.components.systemPrompt }, { role: 'user', content: '  BOOKS ' },
  ]);
  assert.equal(target.usage.receipts[0]!.inputTokens, 100);
  assert.equal(target.usage.receipts[0]!.cachedInputTokens, 40);
  assert.equal(target.usage.receipts[0]!.reasoningTokens, 5);
  const proposal = await experiment.agent.optimization.proposer.propose({
    components: experiment.agent.components, mutable: experiment.agent.mutable, feedback: [], attempt: 1,
  }, context());
  assert.equal(proposal.output.systemPrompt, 'Normalize whitespace and lowercase.');
  assert.equal(bodies.length, 2);
});

test('paid example rejects oversized target input and propagates cancellation without dispatch', async t => {
  await fixture(t);
  let calls = 0; globalThis.fetch = async () => { calls++; return payload(); };
  const { agent } = await loadExperiment();
  await assert.rejects(agent.run({ input: 'x'.repeat(10000), components: agent.components, context: context() }), /before dispatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(agent.run({ input: 'BOOKS', components: agent.components, context: { ...context(), signal: controller.signal } }));
  assert.equal(calls, 0);
});

test('paid example retains refusal charges and does not retry HTTP or incomplete-usage failures', async t => {
  await fixture(t);
  let response = payload('', { choices: [{ finish_reason: 'stop', message: { refusal: 'refused' } }] });
  let calls = 0; globalThis.fetch = async () => { calls++; return response; };
  const { agent } = await loadExperiment();
  const invoke = () => agent.run({ input: 'BOOKS', components: agent.components, context: context() });
  const refusal = await invoke();
  assert.equal(refusal.output, ''); assert.equal(refusal.usage.complete, true); assert.equal(calls, 1);
  response = new Response('', { status: 429 });
  await assert.rejects(invoke(), /billing unresolved/); assert.equal(calls, 2);
  response = payload('', { usage: undefined });
  await assert.rejects(invoke(), /billing unresolved/); assert.equal(calls, 3);
});
