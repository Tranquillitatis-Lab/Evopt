import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineGeminiAgent, normalizeGeminiUsage, type GeminiAgentResult } from '../src/adapters/gemini-agent.ts';
import { createOfflineProposer, optimize, type Dataset } from '../src/index.ts';

const accounting = { kind: 'paid' as const, version: 'fixture', enforcement: 'Application enforces per-invocation limits', maxCostUSD: 0.001,
  pricing: { source: 'fixture', checkedAt: '2026-01-01', inputUSDPerMillion: 1, outputUSDPerMillion: 2, cacheReadUSDPerMillion: 0.5 },
  limits: { maxModelCalls: 3, maxInputTokens: 200, maxOutputTokens: 200, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 } };
const base = { id: 'gemini-target', version: '1', model: 'pinned-model', components: { prompt: 'long', policy: 'immutable' },
  mutable: { prompt: { role: 'system instruction', maxLength: 100 } }, accounting,
  optimization: { proposer: createOfflineProposer<{ question: string }, { answer: string }>([{ prompt: 'short' }]), maxAttempts: 1 } };
const context = { signal: new AbortController().signal, evaluationId: 'fixture-id' };
const response = { responseId: 'response-1', modelVersion: 'pinned-model',
  usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }], candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 4 }] } };

test('Gemini agent preserves callback inputs and counts thoughts once at output rates', async () => {
  const agent = defineGeminiAgent<{ question: string }, { answer: string }>({ ...base, async run(args) {
    assert.equal(args.context, context);
    assert.deepEqual(args.input, { question: 'question' });
    assert.equal(args.components.policy, 'immutable');
    return { output: { answer: 'yes' }, complete: true, textOnly: true, explicitCacheUsed: false, paidToolsUsed: false,
      responses: [response], trace: [{ type: 'application' }] };
  } });
  const result = await agent.run({ input: { question: 'question' }, components: base.components, context });
  assert.deepEqual(result.output, { answer: 'yes' });
  assert.deepEqual(result.trace, [{ type: 'application' }]);
  assert.deepEqual(result.usage.receipts[0], { id: 'response-1', provider: 'gemini', model: 'pinned-model',
    inputTokens: 10, outputTokens: 6, cachedInputTokens: 3, reasoningTokens: 2 });
  const changed = defineGeminiAgent({ ...base, model: 'different', run: async () => ({ output: { answer: 'yes' }, complete: true,
    textOnly: true, explicitCacheUsed: false, paidToolsUsed: false, responses: [response] }) });
  assert.notDeepEqual(changed.accounting, agent.accounting);
});

test('Gemini adapter rejects ambiguous or unmetered provider usage', async () => {
  const rejected = [
    { ...response, responseId: undefined },
    { ...response, modelVersion: 'other' },
    { ...response, usageMetadata: { ...response.usageMetadata, totalTokenCount: 99 } },
    { ...response, usageMetadata: { ...response.usageMetadata, cachedContentTokenCount: 11 } },
    { ...response, usageMetadata: { ...response.usageMetadata, promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 10 }] } },
    { ...response, usageMetadata: { ...response.usageMetadata, serviceTier: 'priority' } },
    { ...response, usageMetadata: { ...response.usageMetadata, toolUsePromptTokenCount: 1, totalTokenCount: 17 } },
    { ...response, usageMetadata: { ...response.usageMetadata, toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }] } },
    { ...response, candidates: [{ groundingMetadata: {} }] },
    { ...response, candidates: [{ urlContextMetadata: {} }] },
  ];
  for (const item of rejected) assert.throws(() => normalizeGeminiUsage(item, 'pinned-model'));
  assert.deepEqual(normalizeGeminiUsage({ responseId: 'blocked', modelVersion: 'pinned-model',
    usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 } }, 'pinned-model'),
  { id: 'blocked', provider: 'gemini', model: 'pinned-model', inputTokens: 3, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
  assert.equal(normalizeGeminiUsage({ ...response, usageMetadata: { ...response.usageMetadata, serviceTier: 'SERVICE_TIER_STANDARD' } }, 'pinned-model').outputTokens, 6);
  const incomplete: GeminiAgentResult<string> = { output: 'yes', complete: true, textOnly: false, explicitCacheUsed: false, paidToolsUsed: false, responses: [response] };
  const agent = defineGeminiAgent<string, string>({ ...base, optimization: { proposer: createOfflineProposer([]) }, run: async () => incomplete });
  await assert.rejects(agent.run({ input: 'x', components: base.components, context }), /text-only/);
  incomplete.textOnly = true; incomplete.explicitCacheUsed = true;
  await assert.rejects(agent.run({ input: 'x', components: base.components, context }), /explicit cache/);
});

test('Gemini target supports the typed optimize workflow using offline responses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evopt-gemini-'));
  try {
    const agent = defineGeminiAgent<{ question: string }, { answer: string }>({ ...base, async run({ components, context }) {
      const prompt = components.prompt === 'short' ? 5 : 15;
      return { output: { answer: 'yes' }, complete: true, textOnly: true, explicitCacheUsed: false, paidToolsUsed: false,
        responses: [{ responseId: context.evaluationId, modelVersion: 'pinned-model',
          usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: prompt + 3 } }] };
    } });
    const dataset: Dataset<{ question: string }, { answer: string }> = { id: 'fixture', version: '1',
      train: [{ id: 'train', input: { question: 'train' }, expected: { answer: 'yes' } }],
      validation: [{ id: 'gate', input: { question: 'validation' }, expected: { answer: 'yes' } }],
      test: [{ id: 'test', input: { question: 'test' }, expected: { answer: 'yes' } }],
      score: ({ output, expected }) => output.answer === expected.answer };
    const result = await optimize({ agent, dataset, objective: 'tokens', budget: 1, run: { directory } });
    assert.equal(result.components.prompt, 'short');
    assert.deepEqual(result.evaluations, [{ caseId: 'test', output: { answer: 'yes' }, passed: true }]);
    assert.ok(result.accounting.occupiedMicros > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
