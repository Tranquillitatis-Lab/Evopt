import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCursorProposer, defineCursorAgent, type CursorExecutionResult, type CursorSettings, type CursorUsage } from '../src/adapters/cursor.ts';
import { createOfflineProposer, optimize } from '../src/index.ts';
import { priceUsage, validateAccounting } from '../src/budget.ts';

const settings: CursorSettings = {
  model: 'pinned-cursor-model', cacheWriteUSDPerMillion: 4,
  accounting: { kind: 'paid', version: 'fixture', maxCostUSD: 0.001, enforcement: 'Independent per-call fixture boundary',
    limits: { maxModelCalls: 4, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 5000 },
    pricing: { source: 'fixture, includes all fees', checkedAt: '2026-01-01', inputUSDPerMillion: 2, outputUSDPerMillion: 4, cacheReadUSDPerMillion: 1 } },
  boundary: { scope: 'per-invocation', maxCostUSD: 0.000998, singleModel: true, description: 'Fixture independently enforces all invocation limits' },
};
const usage: CursorUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 7, totalTokens: 25, reasoningTokens: 2 };
const cost = { rawCostCents: 0.0123, chargedCents: 0.009 };
const context = () => ({ evaluationId: 'eval', signal: new AbortController().signal, limits: structuredClone(settings.accounting.limits) });

function result<O>(output: O, id = 'one'): CursorExecutionResult<O> {
  return { output, complete: true, settled: true, paidToolsUsed: false, agentId: 'agent-one', runId: id,
    model: settings.model, singleModel: true, modelCalls: 2,
    usage: { usage: { ...usage }, cost: { ...cost }, runs: [{ runId: id, usage: { ...usage }, cost: { ...cost } }] } };
}

const componentOptions = { id: 'cursor-app', version: '1', components: { prompt: 'Long prompt', immutable: 'Policy' },
  mutable: { prompt: { role: 'System prompt', maxLength: 100 } }, optimization: { proposer: createOfflineProposer([]), maxAttempts: 0 } };

test('Cursor target adapts settled scoped SDK usage and conservatively prices cache and billing', async () => {
  const agent = defineCursorAgent<string, string>({ ...settings, ...componentOptions, async run({ input, components, context }) {
    assert.equal(input, 'task'); assert.equal(components.immutable, 'Policy'); assert.ok(context.signal instanceof AbortSignal);
    return result('done');
  } });
  const response = await agent.run({ input: 'task', components: agent.components, context: context() });
  assert.deepEqual(response.usage.receipts[0], { id: JSON.stringify(['agent-one', 'one']), provider: 'cursor', model: settings.model,
    inputTokens: 20, outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 2, extraCostUSD: 0.000066 });
  const charged = priceUsage(response.usage, agent.accounting);
  assert.equal(charged.tokens, 25); assert.ok(charged.micros >= 123); assert.ok(charged.micros <= validateAccounting(agent.accounting).micros);
});

test('Cursor rejects absent or inconsistent settled billing and unmetered calls', async () => {
  const bad: CursorExecutionResult<string>[] = [];
  const missingCost = result('x'); delete missingCost.usage.cost; bad.push(missingCost);
  const missingRunCost = result('x'); delete (missingRunCost.usage.runs[0] as { cost?: unknown }).cost; bad.push(missingRunCost);
  const mismatched = result('x'); mismatched.usage.usage.totalTokens++; bad.push(mismatched);
  const wrongRun = result('x'); (wrongRun.usage.runs[0] as { runId: string }).runId = 'other'; bad.push(wrongRun);
  const wrongModel = result('x'); wrongModel.model = 'other'; bad.push(wrongModel);
  const callLimit = result('x'); callLimit.modelCalls = 5; bad.push(callLimit);
  const tools = result('x'); tools.paidToolsUsed = true; bad.push(tools);
  const partial = result('x'); partial.settled = false; bad.push(partial);
  const reasoning = result('x'); reasoning.usage.usage.reasoningTokens = 6; bad.push(reasoning);
  const empty = result('x'); empty.usage.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }; bad.push(empty);
  for (const item of bad) {
    const agent = defineCursorAgent<string, string>({ ...settings, ...componentOptions, async run() { return item; } });
    await assert.rejects(agent.run({ input: 'task', components: agent.components, context: context() }));
  }
  let calls = 0;
  const agent = defineCursorAgent<string, string>({ ...settings, ...componentOptions, async run() { calls++; return result('x'); } });
  await assert.rejects(agent.run({ input: 'x', components: agent.components, context: { evaluationId: 'e', signal: new AbortController().signal } }), /metered context/);
  assert.equal(calls, 0);
  assert.throws(() => defineCursorAgent({ ...settings, ...componentOptions, boundary: { ...settings.boundary, maxCostUSD: 1 }, async run() { return result('x'); } }), /boundary/);
});

test('Cursor proposer uses the same independent metering contract', async () => {
  const proposer = createCursorProposer<string, string>({ ...settings, id: 'cursor-proposer', version: '1',
    async propose(request) { assert.equal(request.attempt, 1); return result({ prompt: 'Short prompt' }); } });
  const response = await proposer.propose({ components: { prompt: 'Long prompt' }, mutable: componentOptions.mutable, feedback: [], attempt: 1 }, context());
  assert.equal(response.output.prompt, 'Short prompt');
  assert.ok(priceUsage(response.usage, proposer.accounting).micros >= 123);
});

test('Cursor snapshots its model, boundary and rates at setup', async () => {
  const mutable = structuredClone(settings);
  const agent = defineCursorAgent<string, string>({ ...mutable, ...componentOptions, async run() { return result('x'); } });
  mutable.model = 'changed'; mutable.accounting.pricing.inputUSDPerMillion = 999;
  mutable.cacheWriteUSDPerMillion = 999; mutable.boundary.maxCostUSD = 1;
  const invocation = await agent.run({ input: 'x', components: agent.components, context: context() });
  assert.equal(invocation.usage.receipts[0].model, 'pinned-cursor-model');
  assert.ok(priceUsage(invocation.usage, agent.accounting).micros >= 123);
  assert.ok(priceUsage(invocation.usage, agent.accounting).micros < 200);
});

test('Cursor cache-write envelope accounts for floating point rounding', async () => {
  const exact: CursorSettings = { ...settings, cacheWriteUSDPerMillion: 2, accounting: { ...settings.accounting, maxCostUSD: 0.000248,
    limits: { ...settings.accounting.limits, maxInputTokens: 123, maxOutputTokens: 0 },
    pricing: { ...settings.accounting.pricing, inputUSDPerMillion: 1, outputUSDPerMillion: 0, cacheReadUSDPerMillion: 1 } },
  boundary: { ...settings.boundary, maxCostUSD: 0.000247 } };
  const response = result('ok'); response.modelCalls = 1;
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 123, totalTokens: 123 };
  response.usage = { usage: tokens, cost: { rawCostCents: 0, chargedCents: 0 }, runs: [{ runId: response.runId, usage: tokens, cost: { rawCostCents: 0, chargedCents: 0 } }] };
  const agent = defineCursorAgent<string, string>({ ...exact, ...componentOptions, async run() { return response; } });
  const invocation = await agent.run({ input: 'x', components: agent.components, context: { ...context(), limits: exact.accounting.limits } });
  const charged = priceUsage(invocation.usage, agent.accounting);
  assert.ok(charged.micros >= Math.ceil(exact.boundary.maxCostUSD * 1e6));
  assert.ok(charged.micros <= validateAccounting(agent.accounting).micros);
});

test('Cursor retains rounding headroom when billed cost reaches the independent boundary', async () => {
  const exact: CursorSettings = { ...settings, cacheWriteUSDPerMillion: 1, accounting: { ...settings.accounting, maxCostUSD: 0.000125,
    limits: { ...settings.accounting.limits, maxInputTokens: 1, maxOutputTokens: 1 },
    pricing: { ...settings.accounting.pricing, inputUSDPerMillion: 1, outputUSDPerMillion: 1, cacheReadUSDPerMillion: 1 } },
  boundary: { ...settings.boundary, maxCostUSD: 0.000123 } };
  const response = result('ok'); response.modelCalls = 1;
  const tokens = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 };
  const costAtLimit = { rawCostCents: 0.0123, chargedCents: 0 };
  response.usage = { usage: tokens, cost: costAtLimit, runs: [{ runId: response.runId, usage: tokens, cost: costAtLimit }] };
  const agent = defineCursorAgent<string, string>({ ...exact, ...componentOptions, async run() { return response; } });
  const invocation = await agent.run({ input: 'x', components: agent.components, context: { ...context(), limits: exact.accounting.limits } });
  const charged = priceUsage(invocation.usage, agent.accounting);
  assert.ok(charged.micros >= 123 && charged.micros <= validateAccounting(agent.accounting).micros);
  assert.throws(() => defineCursorAgent({ ...exact, ...componentOptions, boundary: { ...exact.boundary, maxCostUSD: 0.000125 }, async run() { return response; } }), /headroom/);
});

test('Cursor target works with optimize without provider requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-cursor-'));
  try {
    const agent = defineCursorAgent<string, string>({ ...settings, ...componentOptions,
      async run({ context }) { return result('yes', context.evaluationId); } });
    const dataset = { id: 'data', version: '1', train: [{ id: 'train', input: 'a', expected: 'yes' }],
      validation: [{ id: 'gate', input: 'b', expected: 'yes' }], test: [{ id: 'test', input: 'c', expected: 'yes' }],
      score: ({ output, expected }: { output: string; expected: string }) => output === expected };
    const output = await optimize({ agent, dataset, objective: 'accuracy', budget: 1, run: { directory } });
    assert.equal(output.status, 'completed'); assert.equal(output.test?.candidateAccuracy, 1);
    assert.ok(output.accounting.occupiedMicros >= 369);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
