import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, exactMatch, optimize } from '../src/index.js';
import { buildSubmission, validateSubmission } from '../src/contributions.js';
import type { Submission } from '../src/contributions.js';
import type { Accounting, Agent, Dataset, ProposalRequest, RunContext, SelectionPolicy } from '../src/types.js';
import { summarizeCandidates } from '../src/selection.js';
import { clone, hash } from '../src/validation.js';

// All receipts below are authored fixture data. No SDK, model, or network is used.
const accounting: Accounting = {
  kind: 'paid', version: 'fixture-tariff-v1', maxCostUSD: 0.02,
  enforcement: 'Deterministic fixture; one bounded in-process invocation',
  limits: { maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'authored test tariff', checkedAt: '2026-11-04', inputUSDPerMillion: 100, outputUSDPerMillion: 100, cacheReadUSDPerMillion: 1 },
};
const policy = (metric: 'usd' | 'tokens', maxRegressions = 0, minValidationAccuracy = 1): SelectionPolicy =>
  ({ kind: 'quality-constrained-resource', metric, minValidationAccuracy, maxRegressions });
const answer = (input: string) => input.replace('input', 'answer');
const dataset = (): Dataset<string, string> => ({
  id: 'foundation-fixture', version: '1', score: exactMatch,
  train: [{ id: 'train-a', input: 'train-input-a', expected: 'train-answer-a' }, { id: 'train-b', input: 'train-input-b', expected: 'train-answer-b' }],
  validation: [{ id: 'validation-a', input: 'HIDDEN-VALIDATION-input-a', expected: 'HIDDEN-VALIDATION-answer-a' },
    { id: 'validation-b', input: 'HIDDEN-VALIDATION-input-b', expected: 'HIDDEN-VALIDATION-answer-b' }],
  test: [{ id: 'test-a', input: 'HIDDEN-TEST-input-a', expected: 'HIDDEN-TEST-answer-a' },
    { id: 'test-b', input: 'HIDDEN-TEST-input-b', expected: 'HIDDEN-TEST-answer-b' }],
});
function receipt(context: RunContext, prompt: string) {
  // More cached tokens cost less USD; fewer uncached tokens still cost more.
  const profile = prompt === 'usd-saving' ? [90, 10, 90] : prompt === 'usd-saving-shorter' ? [50, 10, 50]
    : prompt === 'token-saving' ? [10, 10, 0] : [60, 10, 0];
  return { id: context.evaluationId, provider: 'fixture', model: 'fixture-v1', inputTokens: profile[0]!, outputTokens: profile[1]!, cachedInputTokens: profile[2]! };
}
function fixture(options: {
  patches?: Record<string, string>[]; selection?: SelectionPolicy;
  correct?: (input: string, prompt: string) => boolean;
} = {}) {
  const patches = options.patches ?? [{ prompt: 'usd-saving' }];
  const requests: ProposalRequest<string, string>[] = [];
  const calls = { target: 0, proposal: 0 };
  const agent: Agent<string, string> = defineAgent({
    id: 'foundation-agent', version: '1', components: { prompt: 'initial', fixed: 'IMMUTABLE-PRIVATE-TEXT' },
    mutable: { prompt: { role: 'Answer the classification task', maxLength: 80 } }, accounting,
    optimization: {
      ...(options.selection ? { selection: options.selection } : {}), maxAttempts: patches.length,
      proposer: { id: 'fixture-proposer', version: '1', accounting,
        async propose(request, context) {
          calls.proposal++; requests.push(clone(request));
          return { output: patches[request.attempt - 1]!, usage: { complete: true, receipts: [{ ...receipt(context, 'token-saving'), inputTokens: 1, outputTokens: 1 }] } };
        },
      },
    },
    async run(args) {
      const { input, components, context } = args;
      calls.target++;
      assert.deepEqual(Object.keys(args).sort(), ['components', 'context', 'input']);
      return { output: options.correct?.(input, components.prompt!) === false ? 'wrong' : answer(input),
        usage: { complete: true, receipts: [receipt(context, components.prompt!)] } };
    },
  });
  return { agent, requests, calls };
}
async function directory(t: { after(callback: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), 'evopt-foundation-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const metadata = { id: 'foundation-fixture', summary: 'Authored offline evidence for the foundation workflow.', reviewed: true };
function rehash(s: Submission): Submission {
  const { digest: _, metadata: m, ...payload } = s;
  s.digest = hash({ ...payload, metadata: { id: m.id, summary: m.summary } }); return s;
}

test('opt-in resource policy selects an equally accurate cheaper candidate; default accuracy keeps its incumbent', async t => {
  const a = fixture(), b = fixture({ selection: policy('usd') });
  const defaultResult = await optimize({ agent: a.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  const cheaper = await optimize({ agent: b.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(defaultResult.status, 'completed'); assert.equal(defaultResult.components.prompt, 'initial');
  assert.equal(defaultResult.test!.kind, 'identity-control'); assert.deepEqual(defaultResult.configuration!.selection, { kind: 'accuracy' });
  assert.equal(cheaper.status, 'completed'); assert.equal(cheaper.components.prompt, 'usd-saving');
  assert.deepEqual(cheaper.test, { kind: 'paired', baselineAccuracy: 1, candidateAccuracy: 1 });
  assert.deepEqual(cheaper.configuration!.selection, policy('usd'));
  const checked = validateSubmission(buildSubmission(cheaper, metadata));
  assert.equal(checked.candidateValidationAccuracy, checked.baselineValidationAccuracy);
  assert.equal(checked.eligibleForPromotion, true);
});

test('cached USD savings and total-token savings can choose different candidates', async t => {
  const patches = [{ prompt: 'usd-saving' }, { prompt: 'token-saving' }];
  const usd = fixture({ patches, selection: policy('usd') }), tokens = fixture({ patches, selection: policy('tokens') });
  const dollarResult = await optimize({ agent: usd.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  const tokenResult = await optimize({ agent: tokens.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(dollarResult.components.prompt, 'usd-saving'); assert.equal(tokenResult.components.prompt, 'token-saving');
  assert.equal(validateSubmission(buildSubmission(dollarResult, metadata)).eligibleForPromotion, true);
  assert.equal(validateSubmission(buildSubmission(tokenResult, metadata)).eligibleForPromotion, true);
});

test('submission selection replay rejects a policy flip even when the old winner improves both resources over baseline', async t => {
  const f = fixture({ patches: [{ prompt: 'usd-saving-shorter' }, { prompt: 'token-saving' }], selection: policy('usd') });
  const result = await optimize({ agent: f.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(result.status, 'completed'); assert.equal(result.components.prompt, 'usd-saving-shorter');
  const summaries = summarizeCandidates(result.candidates, result.evaluations, result.accounting.entries, result.candidates[0]!.id);
  const [baseline, dollarWinner, tokenWinner] = summaries;
  for (const candidate of [dollarWinner!, tokenWinner!]) {
    assert.equal(candidate.validationAccuracy, baseline!.validationAccuracy);
    assert.ok(candidate.validationCostMicros < baseline!.validationCostMicros);
    assert.ok(candidate.validationTokens < baseline!.validationTokens);
  }
  assert.ok(dollarWinner!.validationCostMicros < tokenWinner!.validationCostMicros);
  assert.ok(tokenWinner!.validationTokens < dollarWinner!.validationTokens);
  const submission = buildSubmission(result, metadata);
  assert.equal(validateSubmission(submission).eligibleForPromotion, true);
  submission.configuration!.selection = policy('tokens');
  assert.throws(() => validateSubmission(rehash(submission)), /Selected candidate differs from replayed selection policy/);
});

test('baseline case regressions cannot be hidden by gains on other validation cases', async t => {
  const data = dataset(); data.validation = [...data.validation,
    { id: 'validation-c', input: 'HIDDEN-VALIDATION-input-c', expected: 'HIDDEN-VALIDATION-answer-c' }];
  const correct = (input: string, prompt: string) => !input.startsWith('HIDDEN-VALIDATION') || (prompt === 'initial' ? input.endsWith('-a') : !input.endsWith('-a'));
  const protectedFixture = fixture({ selection: policy('usd', 0, 0), correct });
  const permittedFixture = fixture({ selection: policy('usd', 1, 0), correct });
  const guarded = await optimize({ agent: protectedFixture.agent, dataset: data, objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  const permitted = await optimize({ agent: permittedFixture.agent, dataset: data, objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(guarded.candidates[0]!.validationAccuracy, 1 / 3); assert.equal(guarded.candidates[1]!.validationAccuracy, 2 / 3);
  assert.equal(guarded.components.prompt, 'initial'); assert.equal(permitted.components.prompt, 'usd-saving');
  const floorFixture = fixture({ selection: policy('usd', 1, 1), correct });
  const belowFloor = await optimize({ agent: floorFixture.agent, dataset: data, objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(belowFloor.components.prompt, 'initial');
});

test('proposals accumulate train-only comparisons and rejection facts with candidate lineage', async t => {
  const f = fixture({ patches: [{ prompt: 'usd-saving' }, { fixed: 'INVALID-PATCH-TEXT' }, { prompt: 'token-saving' }] });
  const result = await optimize({ agent: f.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.history.map(h => h.status), ['evaluated', 'rejected', 'evaluated']);
  const baseline = result.candidates[0]!, previous = result.candidates[1]!;
  const experience = f.requests[2]!.experience!;
  assert.equal(experience.scope, 'train'); assert.equal(experience.baselineId, baseline.id); assert.equal(experience.incumbentId, baseline.id);
  assert.ok(experience.observations.some(row => row.candidateId === previous.id));
  assert.ok(experience.rejections.some(row => row.attempt === 2 && /immutable/i.test(row.reason)));
  assert.ok(experience.observations.every(row => ['train-a', 'train-b'].includes(row.caseId)));
  const prior = experience.observations.find(row => row.candidateId === previous.id)!;
  assert.equal(prior.totalTokens, 100); assert.equal(prior.baselineTokens, 70);
  assert.equal(prior.settledCostMicros, 1090); assert.equal(prior.baselineCostMicros, 7000);
  assert.deepEqual(prior.changedKeys, ['prompt']); assert.deepEqual(prior.edits.map(e => [e.key, e.before, e.after]), [['prompt', 'initial', 'usd-saving']]);
  const serialized = JSON.stringify(f.requests);
  for (const hidden of ['HIDDEN-VALIDATION', 'HIDDEN-TEST', 'IMMUTABLE-PRIVATE-TEXT', 'INVALID-PATCH-TEXT']) assert.equal(serialized.includes(hidden), false);
  assert.deepEqual(result.configuration!.experience, { maxObservations: 12, maxRejections: 5, maxCharacters: 16000 });
  assert.deepEqual(previous.lineage, { parentId: baseline.id, attempt: 1, operator: 'proposer-text-patch', changedKeys: ['prompt'], proposalId: result.accounting.entries.find(e => e.purpose === 'proposal')!.id });
  const { parentId, attempt, operator, changedKeys, proposalId } = result.history[0]!;
  assert.deepEqual({ parentId, attempt, operator, changedKeys, proposalId }, previous.lineage);
});

test('rehashed submissions cannot change selection policy or candidate ancestry to justify a winner', async t => {
  const f = fixture({ patches: [{ prompt: 'usd-saving' }, { prompt: 'token-saving' }], selection: policy('usd') });
  const result = await optimize({ agent: f.agent, dataset: dataset(), objective: 'accuracy', budget: 1, run: { directory: await directory(t) } });
  const original = buildSubmission(result, metadata); validateSubmission(original);
  const edits: [string, (s: Submission) => void][] = [
    ['accuracy policy cannot justify a resource-only winner', s => { s.configuration!.selection = { kind: 'accuracy' }; }],
    ['different resource policy cannot justify the same winner', s => { s.configuration!.selection = policy('tokens'); }],
    ['candidate cannot be its own parent', s => { s.candidates[1]!.lineage!.parentId = s.candidates[1]!.id; }],
    ['lineage cannot claim immutable text changed', s => { s.candidates[1]!.lineage!.changedKeys = ['fixed']; }],
    ['proposal identity cannot refer to a target evaluation', s => { s.candidates[1]!.lineage!.proposalId = s.evaluations[0]!.id; }],
    ['consistent candidate/history lineage cannot swap earlier and later proposal invocations', s => {
      const first = s.history[0]!.proposalId!, second = s.history[1]!.proposalId!;
      s.history[0]!.proposalId = second; s.candidates[1]!.lineage!.proposalId = second;
      s.history[1]!.proposalId = first; s.candidates[2]!.lineage!.proposalId = first;
    }],
  ];
  for (const [label, edit] of edits) { const changed = clone(original); edit(changed); assert.throws(() => validateSubmission(rehash(changed)), label); }
});

test('resume preserves the selected resource policy, lineage, and settled calls after a scorer interruption', async t => {
  const f = fixture({ selection: policy('usd') }), data = dataset(), path = await directory(t);
  let fail = true;
  data.score = args => { if (fail && args.input.startsWith('HIDDEN-TEST')) throw new Error('fixture grader interrupted'); return exactMatch(args); };
  const options = { agent: f.agent, dataset: data, objective: 'accuracy' as const, budget: 1 };
  const first = await optimize({ ...options, run: { directory: path } });
  assert.equal(first.status, 'interrupted'); assert.equal(first.components.prompt, 'usd-saving');
  assert.ok(first.accounting.entries.every(e => e.status === 'settled'));
  fail = false;
  const resumed = await optimize({ ...options, run: { directory: path, resume: true } });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.selectedId, first.selectedId);
  assert.deepEqual(resumed.candidates, first.candidates); assert.deepEqual(resumed.history, first.history);
  assert.equal(f.calls.proposal, 1); assert.equal(f.calls.target, resumed.evaluations.length);
  assert.equal(new Set(resumed.accounting.entries.map(e => e.id)).size, resumed.accounting.entries.length);
  const calls = { ...f.calls };
  const completedAgain = await optimize({ ...options, run: { directory: path, resume: true } });
  assert.deepEqual(f.calls, calls); assert.deepEqual(completedAgain.accounting, resumed.accounting);
  assert.equal(validateSubmission(buildSubmission(completedAgain, metadata)).eligibleForPromotion, true);
});

