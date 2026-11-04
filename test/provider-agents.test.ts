import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineAnthropicAgent, defineClaudeAgent, defineOpenAIAgent, type ProviderAgentOptions } from '../src/adapters/agents.ts';
import { createOfflineProposer, optimize, type Dataset } from '../src/index.ts';

const accounting = {
  kind: 'paid' as const, version: 'fixture', enforcement: 'Application callback enforces all limits', maxCostUSD: 0.001,
  pricing: { source: 'fixture', checkedAt: '2026-01-01', inputUSDPerMillion: 1, outputUSDPerMillion: 1, cacheReadUSDPerMillion: 0.5 },
  limits: { maxModelCalls: 3, maxInputTokens: 200, maxOutputTokens: 200, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
};
const shared = {
  id: 'agent', version: '1', model: 'model-pinned', components: { prompt: 'long prompt', tool: 'read-only tool' },
  mutable: { prompt: { role: 'agent prompt', maxLength: 100 } }, accounting,
  optimization: { proposer: createOfflineProposer<{ question: string }, { answer: string }>([{ prompt: 'short' }]), maxAttempts: 1 },
};
const context = { signal: new AbortController().signal, evaluationId: 'evaluation' };

test('OpenAI adapter preserves the app callback and normalizes both API usage formats', async () => {
  let calls = 0;
  const agent = defineOpenAIAgent<{ question: string }, { answer: string }>({ ...shared, async run(args) {
    calls++;
    assert.equal(args.context, context);
    assert.deepEqual(args.input, { question: 'hello' });
    assert.equal(args.components.prompt, 'short');
    return { output: { answer: 'ok' }, complete: true, paidToolsUsed: false, trace: [{ type: 'app' }], responses: [
      { id: 'one', model: 'model-pinned', usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } },
      { id: 'two', model: 'model-pinned', usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14,
        input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 3 } } },
    ] };
  } });
  assert.equal(calls, 0);
  const result = await agent.run({ input: { question: 'hello' }, components: { prompt: 'short', tool: 'read-only tool' }, context });
  assert.deepEqual(result.output, { answer: 'ok' });
  assert.deepEqual(result.trace, [{ type: 'app' }]);
  assert.deepEqual(result.usage.receipts.map(row => [row.id, row.inputTokens, row.outputTokens, row.cachedInputTokens, row.reasoningTokens]),
    [['one', 10, 4, 3, 2], ['two', 9, 5, 1, 3]]);
});

test('Claude adapter normalizes the separate cached input count and rejects unsafe accounting', async () => {
  const response = { id: 'msg-1', model: 'model-pinned', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 4,
    cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } } };
  let result: ProviderAgentOptions<string, string>['run'] = async () => ({ output: 'ok', complete: true, paidToolsUsed: false, responses: [response] });
  const base = { ...shared, optimization: { proposer: createOfflineProposer<string, string>([]) } };
  const agent = defineClaudeAgent<string, string>({ ...base, run: args => result(args) });
  assert.equal(defineClaudeAgent, defineAnthropicAgent);
  const otherModel = defineClaudeAgent<string, string>({ ...base, model: 'another-model', run: args => result(args) });
  assert.notEqual(agent.accounting.kind === 'paid' && agent.accounting.version, otherModel.accounting.kind === 'paid' && otherModel.accounting.version);
  const args = { input: 'hello', components: base.components, context };
  const receipt = (await agent.run(args)).usage.receipts[0];
  assert.deepEqual(receipt, { id: 'msg-1', provider: 'anthropic', model: 'model-pinned', inputTokens: 9, outputTokens: 7, cachedInputTokens: 4 });
  result = async () => ({ output: 'ok', complete: false, paidToolsUsed: false, responses: [response] });
  await assert.rejects(agent.run(args), /complete usage/);
  result = async () => ({ output: 'ok', complete: true, paidToolsUsed: true, responses: [response] });
  await assert.rejects(agent.run(args), /no paid tools/);
  result = async () => ({ output: 'ok', complete: true, paidToolsUsed: false, responses: [{ ...response, model: 'other' }] });
  await assert.rejects(agent.run(args), /pinned model/);
  result = async () => ({ output: 'ok', complete: true, paidToolsUsed: false, responses: [{ ...response, usage: { ...response.usage, cache_creation_input_tokens: 1 } }] });
  await assert.rejects(agent.run(args), /cache creation/);
  result = async () => ({ output: 'ok', complete: true, paidToolsUsed: false, responses: [{ ...response, usage: { ...response.usage, server_tool_use: { web_search_requests: 1 } } }] });
  await assert.rejects(agent.run(args), /paid tools/);
  result = async () => ({ output: 'ok', complete: true, paidToolsUsed: false, responses: [{ ...response, usage: { ...response.usage, server_tool_use: { unexpected_requests: 'unknown' } } }] });
  await assert.rejects(agent.run(args), /paid tool usage/);
});

test('existing app callback works with the complete typed optimize API without network access', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evopt-provider-'));
  try {
    const agent = defineOpenAIAgent<{ question: string }, { answer: string }>({ ...shared, async run({ components, context }) {
      return { output: { answer: 'yes' }, complete: true, paidToolsUsed: false, responses: [{ id: context.evaluationId,
        model: 'model-pinned', usage: { input_tokens: components.prompt === 'short' ? 5 : 15, output_tokens: 1,
          total_tokens: components.prompt === 'short' ? 6 : 16 } }] };
    } });
    const dataset: Dataset<{ question: string }, { answer: string }> = {
      id: 'dataset', version: '1',
      train: [{ id: 'train', input: { question: 'train' }, expected: { answer: 'yes' } }],
      validation: [{ id: 'validation', input: { question: 'validation' }, expected: { answer: 'yes' } }],
      test: [{ id: 'test', input: { question: 'test' }, expected: { answer: 'yes' } }],
      score: ({ output, expected }) => output.answer === expected.answer,
    };
    const result = await optimize({ agent, dataset, budget: 1, objective: 'tokens', run: { directory: dir } });
    assert.equal(result.components.prompt, 'short');
    assert.deepEqual(result.evaluations, [{ caseId: 'test', output: { answer: 'yes' }, passed: true }]);
    assert.ok(result.accounting.occupiedMicros > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
