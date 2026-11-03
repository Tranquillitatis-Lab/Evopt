import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, exactMatch, optimize } from '../src/index.js';
import { buildSubmission, validateSubmission } from '../src/contributions.js';
import { checkExperiment, defineExperiment, readExperimentResult, runExperiment } from '../src/experiments.js';
import type { Accounting, Dataset, RunContext } from '../src/types.js';
import { hash } from '../src/validation.js';

// Every invocation is a deterministic local callback. Receipts are test data,
// including those marked paid; no provider API or billable operation is called.
function contract(input: number, output: number): Accounting {
  return { kind: 'paid', version: 'token-budget-fixture-v1', maxCostUSD: (input + output) / 1e6,
    enforcement: 'One deterministic in-process fixture invocation',
    limits: { maxModelCalls: 1, maxInputTokens: input, maxOutputTokens: output, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
    pricing: { source: 'authored test tariff', checkedAt: '2026-11-04', inputUSDPerMillion: 1, outputUSDPerMillion: 1, cacheReadUSDPerMillion: 1 } };
}
function receipt(context: RunContext, total: number) {
  const outputTokens = 5, inputTokens = total - outputTokens;
  return { id: context.evaluationId, provider: 'fixture', model: 'authored', inputTokens, outputTokens, cachedInputTokens: Math.floor(inputTokens / 2), reasoningTokens: 3 };
}
function fixture(options: { missing?: 'target' | 'proposal'; rejected?: boolean; maxAttempts?: number } = {}) {
  const calls = { target: 0, proposal: 0 };
  const dataset: Dataset<string, string> = { id: 'token-budget-fixture', version: '1', score: exactMatch,
    train: [{ id: 'train', input: 'train', expected: 'correct' }],
    validation: [{ id: 'validation', input: 'validation', expected: 'correct' }],
    test: [{ id: 'test', input: 'test', expected: 'correct' }] };
  const agent = defineAgent<string, string>({ id: 'token-budget-agent', version: '1', components: { prompt: 'initial', fixed: 'unchanged' },
    mutable: { prompt: { role: 'Task instructions', maxLength: 100 } }, accounting: contract(80, 20),
    optimization: { maxAttempts: options.maxAttempts ?? 1, proposer: { id: 'local-fixture', version: '1', accounting: contract(20, 10),
      async propose(_request, context) {
        calls.proposal++;
        const output: Record<string, string> = options.rejected ? { fixed: 'forbidden' } : { prompt: 'short' };
        return { output,
          usage: { complete: true, receipts: options.missing === 'proposal' ? [] : [receipt(context, 10)] } };
      } } },
    async run({ components, context }) {
      calls.target++;
      return { output: 'correct', usage: { complete: true, receipts: options.missing === 'target' ? [] : [receipt(context, components.prompt === 'initial' ? 50 : 20)] } };
    } });
  return { agent, dataset, calls };
}
async function directory(t: { after(callback: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), 'evopt-token-budget-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const metadata = { id: 'token-budget-fixture', summary: 'Offline authored token-ceiling evidence.', reviewed: true };

test('token ceilings validate before callbacks and conservatively reserve baseline plus two held-out arms', async t => {
  const f = fixture(), path = await directory(t);
  for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(optimize({ agent: f.agent, dataset: f.dataset, budget: 1, run: { directory: path, maxTokens } }), /integer/i);
  }
  await assert.rejects(optimize({ agent: f.agent, dataset: f.dataset, budget: 1, run: { directory: path, maxTokens: 399 } }), /Token ceiling.*baseline and final/i);
  assert.deepEqual(f.calls, { target: 0, proposal: 0 });
});

test('proposal admission protects the full candidate and holdout against both independent ceilings', async t => {
  for (const { maxTokens, budget } of [{ maxTokens: 529, budget: 1 }, { maxTokens: 1000, budget: 0.000529 }]) {
    const f = fixture();
    const result = await optimize({ agent: f.agent, dataset: f.dataset, budget, run: { directory: await directory(t), maxTokens } });
    assert.equal(result.status, 'completed'); assert.deepEqual(f.calls, { target: 3, proposal: 0 });
    assert.equal(result.components.prompt, 'initial'); assert.equal(result.accounting.occupiedTokens, 150);
    assert.deepEqual(result.test, { kind: 'identity-control', baselineAccuracy: 1, candidateAccuracy: 1 });
  }
  const f = fixture();
  const result = await optimize({ agent: f.agent, dataset: f.dataset, budget: 1, run: { directory: await directory(t), maxTokens: 530 } });
  assert.equal(result.status, 'completed'); assert.equal(result.components.prompt, 'short');
  assert.deepEqual(f.calls, { target: 6, proposal: 1 }); assert.equal(result.accounting.maxTokens, 530);
  const total = result.accounting.entries.reduce((sum, entry) => sum + (entry.receipts ?? []).reduce((n, row) => n + row.inputTokens + row.outputTokens, 0), 0);
  assert.equal(total, 220); assert.equal(result.accounting.occupiedTokens, total);
  assert.ok(result.accounting.entries.every(entry => entry.status === 'settled'));
  assert.equal(result.candidates[1]!.lineage!.proposalId, result.accounting.entries.find(entry => entry.purpose === 'proposal')!.id);
  const submission = buildSubmission(result, metadata);
  assert.equal(submission.accounting.maxTokens, 530); assert.equal(submission.accounting.occupiedTokens, 220);
  assert.equal(validateSubmission(submission).eligibleForPromotion, true);
  submission.accounting.occupiedTokens = 221;
  const { digest: _, metadata: exportedMetadata, ...payload } = submission;
  submission.digest = hash({ ...payload, metadata: { id: exportedMetadata.id, summary: exportedMetadata.summary } });
  assert.throws(() => validateSubmission(submission), /token/i, 'A recomputed artifact digest cannot hide an incorrect token total');
});

test('rejected proposal tokens consume the shared run ceiling and prevent a second unaffordable search attempt', async t => {
  const f = fixture({ rejected: true, maxAttempts: 2 });
  const result = await optimize({ agent: f.agent, dataset: f.dataset, budget: 1, run: { directory: await directory(t), maxTokens: 530 } });
  assert.equal(result.status, 'completed'); assert.deepEqual(f.calls, { target: 3, proposal: 1 });
  assert.equal(result.accounting.occupiedTokens, 160); assert.equal(result.history.length, 1); assert.equal(result.history[0]!.status, 'rejected');
  assert.equal(validateSubmission(buildSubmission(result, metadata)).eligibleForPromotion, false);
});

test('unknown target or proposer billing retains its full token envelope and blocks replay', async t => {
  for (const missing of ['target', 'proposal'] as const) {
    const f = fixture({ missing }), path = await directory(t);
    const options = { agent: f.agent, dataset: f.dataset, budget: 1 };
    const result = await optimize({ ...options, run: { directory: path, maxTokens: 530 } });
    assert.equal(result.status, 'interrupted'); assert.match(result.reason!, /receipts/);
    assert.equal(result.accounting.entries.at(-1)!.status, 'pending');
    assert.equal(result.accounting.occupiedTokens, missing === 'target' ? 100 : 130);
    assert.deepEqual(f.calls, missing === 'target' ? { target: 1, proposal: 0 } : { target: 2, proposal: 1 });
    const calls = { ...f.calls };
    await assert.rejects(optimize({ ...options, run: { directory: path, maxTokens: 530, resume: true } }), /Unresolved billing/);
    assert.deepEqual(f.calls, calls);
  }
});

test('invalid token receipts from a declared-free adapter preserve its blocked interruption instead of inventing a total', async t => {
  const f = fixture(), path = await directory(t);
  f.agent.accounting = { kind: 'free', timeoutMs: 1000 };
  f.agent.run = async ({ context }) => {
    f.calls.target++;
    return { output: 'correct', usage: { complete: true, receipts: [{ ...receipt(context, 50), cachedInputTokens: 1000 }] } };
  };
  const options = { agent: f.agent, dataset: f.dataset, budget: 1 };
  const result = await optimize({ ...options, run: { directory: path, maxTokens: 530 } });
  assert.equal(result.status, 'interrupted'); assert.match(result.reason!, /Free integration reported paid usage/);
  assert.match(result.reason!, /token usage unavailable/);
  assert.equal(result.accounting.maxTokens, 530); assert.equal(result.accounting.occupiedTokens, undefined);
  assert.equal(result.accounting.entries[0]!.status, 'envelope_violation');
  assert.equal(result.accounting.entries[0]!.receipts![0]!.cachedInputTokens, 1000);
  assert.deepEqual(f.calls, { target: 1, proposal: 0 });
  await assert.rejects(optimize({ ...options, run: { directory: path, maxTokens: 530, resume: true } }), /Unresolved billing/);
  assert.deepEqual(f.calls, { target: 1, proposal: 0 });
});

test('resuming keeps the original token ceiling and never repeats settled target or proposer calls', async t => {
  const f = fixture(), path = await directory(t), options = { agent: f.agent, dataset: f.dataset, budget: 1 };
  const first = await optimize({ ...options, run: { directory: path, maxTokens: 530 } });
  assert.equal(first.status, 'completed'); const calls = { ...f.calls };
  const resumed = await optimize({ ...options, run: { directory: path, maxTokens: 530, resume: true } });
  assert.deepEqual(resumed.accounting, first.accounting); assert.deepEqual(resumed.history, first.history); assert.deepEqual(f.calls, calls);
  for (const maxTokens of [531, undefined]) {
    await assert.rejects(optimize({ ...options, run: { directory: path, maxTokens, resume: true } }), /fingerprint mismatch/);
  }
  assert.deepEqual(f.calls, calls);
});

test('experiment planning exposes token envelopes and the experiment workflow enforces and exports the chosen ceiling', async t => {
  const f = fixture();
  const experiment = defineExperiment({ id: 'token-budget-experiment', description: 'Local callback fixture', agent: f.agent, dataset: f.dataset });
  const check = checkExperiment(experiment, 1, 399);
  assert.equal(check.minimumTokens, 400); assert.equal(check.plannedMaximumTokens, 630);
  assert.equal(check.tokenMinimumFits, false); assert.equal(check.tokenPlannedFits, false);
  assert.equal(checkExperiment(experiment, 1, 630).tokenPlannedFits, true);
  assert.deepEqual(f.calls, { target: 0, proposal: 0 });
  await assert.rejects(runExperiment(experiment, { budget: 1, directory: await directory(t), allowPaid: true, maxTokens: 399 }), /Token ceiling.*baseline and final/i);
  assert.deepEqual(f.calls, { target: 0, proposal: 0 });
  const path = await directory(t), result = await runExperiment(experiment, { budget: 1, directory: path, allowPaid: true, maxTokens: 530 });
  assert.equal(result.status, 'completed'); assert.equal(result.accounting.occupiedTokens, 220);
  assert.deepEqual((await readExperimentResult(path)).accounting, result.accounting);
});
