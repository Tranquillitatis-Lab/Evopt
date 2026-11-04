import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOfflineProposer, defineAgent, optimize, type Accounting, type Dataset } from '../src/index.ts';

const accounting: Accounting = {
  kind: 'paid', version: 'fixture', maxCostUSD: 0.001, enforcement: 'Deterministic local fixture; no network',
  limits: { maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 5000 },
  pricing: { source: 'fixture', checkedAt: '2025-01-01', inputUSDPerMillion: 1, outputUSDPerMillion: 1 },
};
const dataset: Dataset<{ question: string }, string> = {
  id: 'fixture', version: '1',
  train: [{ id: 'train', input: { question: 'train question' }, expected: 'yes' }],
  validation: [{ id: 'validation', input: { question: 'validation question' }, expected: 'yes' }],
  test: [{ id: 'test', input: { question: 'test question' }, expected: 'yes' }],
  score: ({ output, expected }) => output === expected,
};

test('typed API optimizes bounded text and reports actual held-out evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evopt-api-'));
  const ids = new Set<string>();
  let runs = 0;
  try {
    const agent = defineAgent<{ question: string }, string>({
      id: 'example', version: '1', components: { prompt: 'Verbose instructions', immutable: 'Always safe' },
      mutable: { prompt: { role: 'system prompt', maxLength: 100 } }, accounting,
      structure: { nodes: [{ id: 'worker', role: 'Solve the task', components: ['prompt'] }],
        tools: [{ id: 'lookup', contract: 'Read-only lookups' }], handoffs: [{ from: 'worker', to: 'worker' }] },
      optimization: { proposer: createOfflineProposer([{ prompt: 'Concise instructions' }]), maxAttempts: 1 },
      async run({ input, components, context }) {
        assert.deepEqual(Object.keys(input), ['question']);
        assert.equal(components.immutable, 'Always safe');
        assert.ok(context.signal instanceof AbortSignal);
        assert.ok(!ids.has(context.evaluationId)); ids.add(context.evaluationId); runs++;
        return { output: 'yes', usage: { complete: true as const, receipts: [{ id: randomUUID(), provider: 'fixture', model: 'fixture',
          inputTokens: components.prompt.startsWith('Concise') ? 5 : 15, outputTokens: 1, cachedInputTokens: 0 }] } };
      },
    });
    const result = await optimize({ agent, dataset, objective: 'tokens', budget: 10, run: { directory: dir } });
    assert.equal(result.components.prompt, 'Concise instructions');
    assert.deepEqual(result.changes.prompt, { before: 'Verbose instructions', after: 'Concise instructions' });
    assert.equal(result.accounting.limitMicros, 10_000_000);
    assert.ok(result.accounting.occupiedMicros > 0 && result.accounting.occupiedMicros < result.accounting.limitMicros);
    assert.deepEqual(result.test, { baselineAccuracy: 1, candidateAccuracy: 1 });
    assert.deepEqual(result.evaluations, [{ caseId: 'test', output: 'yes', passed: true }]);
    const beforeResume = runs;
    await optimize({ agent, dataset, objective: 'tokens', budget: 10, run: { directory: dir, resume: true } });
    assert.equal(runs, beforeResume);
    assert.ok((await readFile(path.join(dir, 'campaign.jsonl'), 'utf8')).length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid budgets and datasets fail before invoking an agent', async () => {
  let calls = 0;
  const agent = defineAgent({ id: 'a', version: '1', components: { prompt: 'start' },
    mutable: { prompt: { role: 'system', maxLength: 20 } }, accounting: { kind: 'free', timeoutMs: 1000 },
    optimization: { proposer: createOfflineProposer([]) },
    async run() { calls++; return { output: 'yes', usage: { complete: true as const, receipts: [] } }; },
  });
  await assert.rejects(optimize({ agent, dataset, objective: 'accuracy', budget: 0 }), /budget/i);
  await assert.rejects(optimize({ agent, dataset: { ...dataset, test: [] }, objective: 'accuracy', budget: 10 }), /partition/i);
  assert.equal(calls, 0);
});
