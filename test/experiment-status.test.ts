import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimentStatus } from '../src/experiments.js';
import type { Accounting, LedgerEntry, UsageReceipt } from '../src/types.js';

const contract = (input: number, output: number): Accounting => ({ kind: 'paid', version: 'fixture',
  enforcement: 'Authored fixture only', maxCostUSD: (input + output) / 1e6,
  limits: { maxModelCalls: 1, maxInputTokens: input, maxOutputTokens: output, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'Authored tariff', checkedAt: '2026-11-04', inputUSDPerMillion: 1, outputUSDPerMillion: 1 } });
const receipt = (id: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0, reasoningTokens = 0): UsageReceipt =>
  ({ id, provider: 'fixture', model: 'fixture', inputTokens, outputTokens, cachedInputTokens, reasoningTokens });
async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'evopt-status-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('status includes settled tokens plus distinct pending target/proposal envelopes without recovering or importing code', async t => {
  const root = await directory(t);
  const entries: LedgerEntry[] = [
    { id: 'target-complete', purpose: 'eval:base:train:t', status: 'settled', reservedMicros: 100, chargedMicros: 50, receipts: [receipt('t', 40, 10, 30, 5)] },
    { id: 'proposal-complete', purpose: 'proposal', status: 'settled', reservedMicros: 30, chargedMicros: 10, receipts: [receipt('p', 4, 6)] },
    { id: 'target-pending', purpose: 'eval:base:validation:v', status: 'pending', reservedMicros: 100, receipts: [receipt('partial', 3, 1)] },
    { id: 'proposal-pending', purpose: 'proposal', status: 'pending', reservedMicros: 30 },
    { id: 'violation', purpose: 'eval:candidate:train:t', status: 'envelope_violation', reservedMicros: 100, chargedMicros: 160, receipts: [receipt('overrun', 150, 10)] },
  ];
  const snapshot = { version: 1, sequence: 1, state: { phase: 'search', selectedId: 'base', entries, evaluations: [], history: [],
    config: { maxTokens: 300, agent: { accounting: contract(80, 20), module: join(root, 'agent.mjs') }, proposer: { accounting: contract(20, 10) } } } };
  const state = JSON.stringify(snapshot), journal = JSON.stringify({ ...snapshot, sequence: 2 }) + '\n';
  await writeFile(join(root, 'state.json'), state); await writeFile(join(root, 'journal.jsonl'), journal);
  await writeFile(join(root, 'agent.mjs'), 'throw new Error("STATUS_MUST_NOT_IMPORT_AGENT");');
  const before = await readdir(root), result = await experimentStatus(root);
  // Cached/thinking subsets count once; pending partial usage retains its entire envelope.
  assert.equal(result.maxTokens, 300); assert.equal(result.occupiedTokens, 50 + 10 + 100 + 30 + 160);
  assert.equal(result.occupiedMicros, 350); assert.equal(result.pending, true); assert.equal(result.envelopeViolation, true);
  assert.match(result.note, /journal may contain a newer reservation/); assert.match(result.note, /partial pending receipts do not release/);
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), state); assert.equal(await readFile(join(root, 'journal.jsonl'), 'utf8'), journal);
  assert.deepEqual(await readdir(root), before);
});

test('status preserves compatibility without a token ceiling and rejects invalid configured token evidence', async t => {
  const root = await directory(t), file = join(root, 'state.json');
  const state = { phase: 'completed', selectedId: 'base', entries: [], evaluations: [] };
  await writeFile(file, JSON.stringify({ version: 1, state }));
  const legacy = await experimentStatus(root); assert.equal(legacy.maxTokens, undefined); assert.equal(legacy.occupiedTokens, undefined);
  for (const maxTokens of [0, -1, 1.5, '100']) {
    await writeFile(file, JSON.stringify({ version: 1, state: { ...state, config: { maxTokens } } }));
    await assert.rejects(experimentStatus(root), /token ceiling/);
  }
  await writeFile(file, JSON.stringify({ version: 1, state: { ...state, config: { maxTokens: 1000 },
    entries: [{ id: 'pending', purpose: 'proposal', status: 'pending', reservedMicros: 30 }] } }));
  await assert.rejects(experimentStatus(root), /Missing checkpoint invocation accounting/);
  await writeFile(file, JSON.stringify({ version: 1, state: { ...state, config: { maxTokens: 1000 },
    entries: [{ id: 'settled', purpose: 'proposal', status: 'settled', reservedMicros: 30, chargedMicros: 10, receipts: [receipt('bad', -1, 10)] }] } }));
  await assert.rejects(experimentStatus(root), /safe integer/);
});
