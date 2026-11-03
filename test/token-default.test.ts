import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createOfflineProposer, defineAgent, exactMatch, optimize } from '../src/index.js';
import { buildSubmission, validateSubmission } from '../src/contributions.js';
import type { Accounting, Dataset, ProposalRequest } from '../src/types.js';

// Paid contracts exercise the accounting path with locally authored receipts only.
// The runner and proposer make no provider, network, or model calls.
const accounting: Accounting = {
  kind: 'paid', version: 'authored-token-fixture-v1', maxCostUSD: 0.0001,
  enforcement: 'One deterministic in-process fixture invocation',
  limits: { maxModelCalls: 1, maxInputTokens: 80, maxOutputTokens: 20, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'authored test tariff', checkedAt: '2026-11-04', inputUSDPerMillion: 1, outputUSDPerMillion: 1, cacheReadUSDPerMillion: 1 },
};
function fixture(patches: string[], heldoutTokens?: number) {
  const calls = { target: 0, proposal: 0 }, requests: ProposalRequest<string, string>[] = [];
  const proposer = createOfflineProposer<string, string>(patches.map(prompt => ({ prompt }))), propose = proposer.propose;
  proposer.propose = async (request, context) => { calls.proposal++; requests.push(structuredClone(request)); return propose(request, context); };
  const dataset: Dataset<string, string> = { id: 'token-default-fixture', version: '1', score: exactMatch,
    train: [{ id: 'train', input: 'train-a', expected: 'correct' }],
    validation: [{ id: 'validation-a', input: 'validation-a', expected: 'correct' }, { id: 'validation-b', input: 'validation-b', expected: 'correct' }],
    test: [{ id: 'test-a', input: 'test-a', expected: 'correct' }, { id: 'test-b', input: 'test-b', expected: 'correct' }],
  };
  const agent = defineAgent<string, string>({ id: 'token-default-agent', version: '1', components: { prompt: 'initial' },
    mutable: { prompt: { role: 'Task instructions', maxLength: 100 } }, accounting, optimization: { proposer, maxAttempts: patches.length },
    async run({ input, components, context }) {
      calls.target++;
      const prompt = components.prompt!;
      const tokens = input.startsWith('test') && prompt !== 'initial' && heldoutTokens !== undefined ? heldoutTokens
        : prompt === 'smarter' ? 90 : prompt === 'smart-short' ? 50 : prompt === 'short' ? 30 : prompt === 'regressed' ? 10 : 60;
      const passes = prompt === 'regressed' ? input.endsWith('-b') : ['smarter', 'equal', 'smart-short'].includes(prompt) || input.endsWith('-a');
      const inputTokens = tokens - 10;
      return { output: passes ? 'correct' : 'wrong', usage: { complete: true, receipts: [{ id: context.evaluationId,
        provider: 'fixture', model: 'authored', inputTokens, outputTokens: 10, cachedInputTokens: Math.floor(inputTokens / 2), reasoningTokens: 5 }] } };
    },
  });
  return { agent, dataset, calls, requests };
}
function cleanDefaultDirectory(t: { after(callback: () => Promise<void>): void }, directory: string) {
  const path = resolve(directory), within = relative(resolve('.evopt', 'runs'), path);
  assert.ok(within.length > 0 && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within));
  t.after(() => rm(path, { recursive: true, force: true }));
}
async function directory(t: { after(callback: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), 'evopt-token-default-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const metadata = { id: 'token-default-fixture', summary: 'Offline authored token-selection evidence.', reviewed: true };

test('the three-property call minimizes tokens while preserving baseline cases, even after a higher-quality incumbent', async t => {
  const f = fixture(['smarter', 'equal', 'regressed', 'smart-short', 'short']);
  const result = await optimize({ agent: f.agent, dataset: f.dataset, budget: 1 });
  cleanDefaultDirectory(t, result.directory);
  assert.equal(result.status, 'completed'); assert.equal(result.components.prompt, 'short');
  assert.deepEqual(f.requests.map(request => request.components.prompt), ['initial', 'initial', 'initial', 'initial', 'smart-short']);
  assert.deepEqual(result.configuration!.selection, { kind: 'quality-constrained-resource', metric: 'tokens', minValidationAccuracy: 0, maxRegressions: 0, ranking: 'resource-first' });
  assert.equal(result.configuration!.objective, 'tokens');
  assert.equal(result.candidates[4]!.validationAccuracy, 1); assert.equal(result.candidates[5]!.validationAccuracy, 0.5);
  assert.equal(result.candidates[5]!.lineage!.parentId, result.candidates[4]!.id);
  assert.equal(f.calls.proposal, 5); assert.equal(f.calls.target, 22);
  assert.equal(result.accounting.maxTokens, undefined); assert.equal(result.accounting.occupiedTokens, undefined);
  const baselinePasses = result.evaluations.filter(row => row.candidateId === result.candidates[0]!.id && row.split === 'validation' && row.passed);
  assert.ok(baselinePasses.every(base => result.evaluations.some(row => row.candidateId === result.selectedId && row.caseId === base.caseId && row.passed)));
  assert.equal(validateSubmission(buildSubmission(result, metadata)).eligibleForPromotion, true);
});

test('the explicit four-property accuracy call still accepts higher accuracy even with more tokens', async t => {
  const f = fixture(['smarter']);
  const result = await optimize({ agent: f.agent, dataset: f.dataset, objective: 'accuracy', budget: 1 });
  cleanDefaultDirectory(t, result.directory);
  assert.equal(result.status, 'completed'); assert.equal(result.components.prompt, 'smarter');
  assert.deepEqual(result.configuration!.selection, { kind: 'accuracy' }); assert.equal(result.configuration!.objective, 'accuracy');
  assert.equal(result.candidates[0]!.validationAccuracy, 0.5); assert.equal(result.candidates[1]!.validationAccuracy, 1);
  assert.equal(validateSubmission(buildSubmission(result, metadata)).eligibleForPromotion, true);
});

test('token-mode promotion requires held-out token savings even when held-out accuracy improves', async t => {
  for (const heldoutTokens of [90, 60, 30]) {
    const f = fixture(['smart-short'], heldoutTokens);
    const result = await optimize({ agent: f.agent, dataset: f.dataset, budget: 1, run: { directory: await directory(t) } });
    assert.equal(result.status, 'completed'); assert.equal(result.components.prompt, 'smart-short');
    assert.deepEqual(result.test, { kind: 'paired', baselineAccuracy: 0.5, candidateAccuracy: 1 });
    const checked = validateSubmission(buildSubmission(result, metadata));
    assert.equal(checked.eligibleForPromotion, heldoutTokens < 60, `Held-out response uses ${heldoutTokens} versus 60 baseline tokens`);
  }
});
