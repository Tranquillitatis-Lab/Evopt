import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, exactMatch, optimize } from '../src/index.js';
import { openStore } from '../src/storage.js';
import { clone } from '../src/validation.js';
import type { Accounting, Dataset, LedgerEntry, RunContext } from '../src/types.js';

// Authored usage receipts only: all callbacks run locally, without provider calls.
const accounting: Accounting = { kind: 'paid', version: 'fixture-v1', maxCostUSD: 0.0002,
  enforcement: 'Authored deterministic test receipts',
  limits: { maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'Authored test tariff', checkedAt: '2026-11-04', inputUSDPerMillion: 1, outputUSDPerMillion: 1 } };
const usage = (context: RunContext) => ({ complete: true as const,
  receipts: [{ id: context.evaluationId, provider: 'fixture', model: 'fixture', inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }] });

test('resume validates all settled proposal accounting before returning or invoking callbacks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'evopt-resume-accounting-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = { target: 0, proposal: 0 };
  const agent = defineAgent<string, string>({ id: 'resume-fixture', version: '1', components: { prompt: 'initial' },
    mutable: { prompt: { role: 'Instructions', maxLength: 100 } }, accounting,
    optimization: { maxAttempts: 1, proposer: { id: 'fixture-proposer', version: '1', accounting,
      async propose(_request, context) { calls.proposal++; return { output: { prompt: 'candidate' }, usage: usage(context) }; } } },
    async run({ input, context }) { calls.target++; return { output: input, usage: usage(context) }; } });
  const dataset: Dataset<string, string> = { id: 'resume-fixture', version: '1', score: exactMatch,
    train: [{ id: 'train', input: 'train-input', expected: 'train-input' }],
    validation: [{ id: 'validation', input: 'validation-input', expected: 'validation-input' }],
    test: [{ id: 'test', input: 'test-input', expected: 'test-input' }] };
  const options = { agent, dataset, objective: 'accuracy' as const, budget: 1 };
  const first = await optimize({ ...options, run: { directory } });
  assert.equal(first.status, 'completed'); assert.equal(calls.proposal, 1);
  const originalEntries = clone(first.accounting.entries), originalCalls = { ...calls };
  const corruptions: [string, (entry: LedgerEntry) => void][] = [
    ['negative cost', entry => { entry.chargedMicros = -1; }],
    ['missing cost', entry => { delete entry.chargedMicros; }],
    ['cost above envelope', entry => { entry.chargedMicros = entry.reservedMicros + 1; }],
    ['cost disagrees with pinned tariff', entry => { entry.chargedMicros!++; }],
    ['altered envelope', entry => { entry.reservedMicros++; }],
    ['missing paid receipts', entry => { entry.receipts = []; }],
    ['altered receipts', entry => { entry.receipts![0]!.inputTokens++; }],
    ['reused receipt', entry => { entry.receipts![0]!.id = originalEntries[0]!.receipts![0]!.id; }],
  ];
  for (const [label, corrupt] of corruptions) {
    // The normal store keeps checkpoint and journal mutually consistent, so
    // corruption must be rejected by accounting rather than snapshot decoding.
    const store = await openStore<{ entries: LedgerEntry[] }>(directory, { entries: [] }, true);
    try {
      store.state.entries = clone(originalEntries);
      corrupt(store.state.entries.find(entry => entry.purpose === 'proposal')!);
      await store.save();
    } finally { await store.close(); }
    await assert.rejects(optimize({ ...options, run: { directory, resume: true } }), label);
    assert.deepEqual(calls, originalCalls, label);
  }
});
