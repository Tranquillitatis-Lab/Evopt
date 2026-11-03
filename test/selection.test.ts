import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidate, isSelectionImprovement, normalizeObjective, normalizeSelectionPolicy, resolveSelectionPolicy, summarizeCandidates } from '../src/selection.js';
import { createOfflineProposer, defineAgent, optimize } from '../src/optimize.js';
import type { Candidate, CandidateSummary, Dataset, Evaluation, LedgerEntry, OptimizationObjective, SelectionPolicy } from '../src/types.js';
import { validateOptions } from '../src/validation.js';

const resource = (metric: 'usd' | 'tokens' = 'usd'): SelectionPolicy => ({ kind: 'quality-constrained-resource', metric, minValidationAccuracy: 0.5, maxRegressions: 0 });
function fixture() {
  const candidates: Candidate[] = ['baseline', 'cached', 'shorter', 'quality', 'regression', 'incomplete'].map(id => ({ id, components: { prompt: id } }));
  const evaluations: Evaluation<string>[] = [], entries: LedgerEntry[] = [];
  function add(candidateId: string, split: 'train' | 'validation' | 'test', caseId: string, passed: boolean, cost: number, tokens: number) {
    const id = `${candidateId}-${split}-${caseId}`;
    const inputTokens = Math.floor(tokens * 0.8), outputTokens = tokens - inputTokens;
    const usage = [{ id: `receipt-${id}`, provider: 'fixture', model: 'mock', inputTokens, outputTokens,
      cachedInputTokens: Math.floor(inputTokens * 0.75), reasoningTokens: Math.floor(outputTokens / 2) }];
    evaluations.push({ id, candidateId, caseId, split, output: 'not read by selection', passed, usage });
    entries.push({ id, purpose: `eval:${candidateId}:${split}:${caseId}`, status: 'settled', reservedMicros: Math.max(cost, 1), chargedMicros: cost, receipts: usage });
  }
  const values = {
    baseline: { outcomes: [true, false], cost: 100, tokens: 100 },
    cached: { outcomes: [true, false], cost: 10, tokens: 1000 },
    shorter: { outcomes: [true, false], cost: 200, tokens: 10 },
    quality: { outcomes: [true, true], cost: 500, tokens: 500 },
    regression: { outcomes: [false, true], cost: 1, tokens: 1 },
    incomplete: { outcomes: [true], cost: 1, tokens: 1 },
  };
  for (const candidate of candidates) {
    const specification = values[candidate.id as keyof typeof values];
    add(candidate.id, 'train', 'training-case', true, 50_000, 50_000);
    specification.outcomes.forEach((passed, index) => add(candidate.id, 'validation', `validation-${index}`, passed, specification.cost, specification.tokens));
  }
  return { candidates, evaluations, entries, add };
}

test('selection policies normalize the accuracy default and reject malformed or unknown settings', () => {
  assert.deepEqual(normalizeSelectionPolicy(), { kind: 'accuracy' });
  assert.deepEqual(normalizeSelectionPolicy(resource()), resource(), 'Legacy policies retain their serialized shape');
  assert.ok(Object.isFrozen(normalizeSelectionPolicy(resource())));
  for (const invalid of [null, {}, { kind: 'pareto' }, { kind: 'accuracy', metric: 'usd' }, { ...resource(), metric: 'latency' },
    { ...resource(), minValidationAccuracy: -1 }, { ...resource(), minValidationAccuracy: 1.01 }, { ...resource(), minValidationAccuracy: NaN },
    { ...resource(), maxRegressions: -1 }, { ...resource(), maxRegressions: 0.5 }, { ...resource(), unexpected: true },
    { ...resource(), ranking: 'quality' }, { ...resource(), ranking: undefined }]) {
    assert.throws(() => normalizeSelectionPolicy(invalid));
  }
  let accesses = 0;
  assert.throws(() => normalizeSelectionPolicy(Object.defineProperty({}, 'kind', { enumerable: true, get() { accesses++; return 'accuracy'; } })), /plain JSON/);
  assert.equal(accesses, 0);
});

test('new objectives default to resource-first tokens while explicit accuracy and legacy artifacts stay compatible', () => {
  assert.equal(normalizeObjective(), 'tokens');
  assert.equal(normalizeObjective('accuracy'), 'accuracy');
  assert.deepEqual(resolveSelectionPolicy(normalizeObjective()), {
    kind: 'quality-constrained-resource', metric: 'tokens', minValidationAccuracy: 0, maxRegressions: 0, ranking: 'resource-first',
  });
  assert.deepEqual(resolveSelectionPolicy('accuracy'), normalizeSelectionPolicy());
  assert.deepEqual(resolveSelectionPolicy('accuracy', resource()), resource());
  for (const invalid of [null, '', 'usd', 'token', {}, 1]) assert.throws(() => normalizeObjective(invalid), /Unsupported objective/);
  for (const incompatible of [{ kind: 'accuracy' }, resource('usd'), resource('tokens'),
    { ...resource('tokens'), ranking: 'accuracy-first' }, { ...resource('usd'), ranking: 'resource-first' }]) {
    assert.throws(() => resolveSelectionPolicy('tokens', incompatible), /Tokens objective requires/);
  }
  const configured = { kind: 'quality-constrained-resource', metric: 'tokens', minValidationAccuracy: 0.8, maxRegressions: 1, ranking: 'resource-first' } as const;
  assert.deepEqual(resolveSelectionPolicy('tokens', configured), configured);
});

test('summaries recompute paired validation outcomes, settled USD, and tokens without double-counting cache or reasoning', () => {
  const source = fixture(), summaries = summarizeCandidates(source.candidates, source.evaluations, source.entries, 'baseline');
  assert.deepEqual(summaries.find(candidate => candidate.id === 'baseline'), { id: 'baseline', trainAccuracy: 1, validationAccuracy: 0.5,
    validationCostMicros: 200, validationTokens: 200, validationRegressions: 0 });
  assert.deepEqual(summaries.find(candidate => candidate.id === 'cached'), { id: 'cached', trainAccuracy: 1, validationAccuracy: 0.5,
    validationCostMicros: 20, validationTokens: 2000, validationRegressions: 0 });
  assert.equal(summaries.find(candidate => candidate.id === 'regression')!.validationRegressions, 1);
  assert.ok(!summaries.some(candidate => candidate.id === 'incomplete'));
  source.add('cached', 'test', 'hidden-test', false, 9_000_000, 9_000_000);
  source.entries.at(-1)!.status = 'pending'; // Even held-out billing status is outside the search evidence.
  source.entries.push({ id: 'proposal', purpose: 'proposal', status: 'settled', reservedMicros: 10_000_000, chargedMicros: 10_000_000, receipts: [] });
  assert.deepEqual(summarizeCandidates(source.candidates, source.evaluations, source.entries, 'baseline'), summaries);
});

test('resource selection preserves accuracy priority and distinguishes cheaper cached work from fewer tokens', () => {
  const source = fixture(), summaries = summarizeCandidates(source.candidates, source.evaluations, source.entries, 'baseline');
  const sameQuality = summaries.filter(candidate => ['baseline', 'cached', 'shorter', 'regression'].includes(candidate.id));
  assert.equal(chooseCandidate({ kind: 'accuracy' }, sameQuality, 'baseline', 'baseline'), 'baseline');
  assert.equal(chooseCandidate(resource('usd'), sameQuality, 'baseline', 'baseline'), 'cached');
  assert.equal(chooseCandidate(resource('tokens'), sameQuality, 'baseline', 'baseline'), 'shorter');
  assert.equal(chooseCandidate(resource('usd'), summaries, 'baseline', 'baseline'), 'quality', 'Higher quality remains primary even when more expensive');
  const incumbent = sameQuality.find(candidate => candidate.id === 'cached')!, baseline = sameQuality[0]!;
  assert.equal(isSelectionImprovement(resource(), { ...incumbent, id: 'same-score-cost' }, incumbent, baseline), false);
  assert.equal(isSelectionImprovement(resource(), { ...incumbent, id: 'lower-quality', validationAccuracy: 0, validationCostMicros: 0 }, incumbent, baseline), false);
  assert.equal(isSelectionImprovement(resource(), { ...incumbent, id: 'same-usd-fewer-tokens', validationTokens: 0 }, incumbent, baseline), false);
  assert.equal(chooseCandidate(resource(), [baseline, { ...incumbent, id: 'tie' }, incumbent], incumbent.id, baseline.id), incumbent.id);
});

test('token objective requires fewer tokens instead of adopting more accurate but longer candidates', () => {
  const source = fixture(), summaries = summarizeCandidates(source.candidates, source.evaluations, source.entries, 'baseline');
  const policy = resolveSelectionPolicy('tokens');
  assert.equal(chooseCandidate(policy, summaries, 'baseline', 'baseline'), 'shorter');
  const baseline = summaries.find(candidate => candidate.id === 'baseline')!, quality = summaries.find(candidate => candidate.id === 'quality')!;
  assert.equal(chooseCandidate(policy, [baseline, quality], baseline.id, baseline.id), baseline.id);
  const tied = { ...quality, id: 'higher-accuracy-same-tokens', validationTokens: baseline.validationTokens };
  assert.equal(chooseCandidate(policy, [baseline, tied], baseline.id, baseline.id), baseline.id);
  assert.equal(chooseCandidate(resolveSelectionPolicy('accuracy'), [baseline, quality], baseline.id, baseline.id), quality.id);
});

test('resource-first ranking may trade incumbent gains for fewer tokens but preserves baseline quality and passing cases', () => {
  const policy = resolveSelectionPolicy('tokens');
  const baseline: CandidateSummary = { id: 'base', trainAccuracy: 1, validationAccuracy: 0.5, validationCostMicros: 100, validationTokens: 100, validationRegressions: 0 };
  const incumbent = { ...baseline, id: 'incumbent', validationAccuracy: 1, validationTokens: 80 };
  const shorter = { ...baseline, id: 'shorter', validationTokens: 40 };
  assert.equal(chooseCandidate(policy, [baseline, incumbent, shorter], incumbent.id, baseline.id), shorter.id);
  assert.equal(isSelectionImprovement(policy, shorter, incumbent, baseline), true);
  assert.equal(isSelectionImprovement(policy, { ...shorter, validationAccuracy: 0.25 }, incumbent, baseline), false);
  assert.equal(isSelectionImprovement(policy, { ...shorter, validationRegressions: 1 }, incumbent, baseline), false);
  assert.equal(isSelectionImprovement(resolveSelectionPolicy('tokens', { ...policy, minValidationAccuracy: 0.75 }), shorter, incumbent, baseline), false);
  assert.equal(isSelectionImprovement(resource('tokens'), shorter, incumbent, baseline), false, 'Legacy explicit policies remain accuracy-first');
});

test('quality floors retain baseline fallback and paired regressions constrain even aggregate accuracy improvements', () => {
  const baseline: CandidateSummary = { id: 'base', trainAccuracy: 1, validationAccuracy: 0.5, validationCostMicros: 100, validationTokens: 100, validationRegressions: 0 };
  const improved: CandidateSummary = { ...baseline, id: 'improved', validationAccuracy: 0.75, validationCostMicros: 1, validationTokens: 1 };
  const policy: SelectionPolicy = { ...resource(), kind: 'quality-constrained-resource', metric: 'usd', minValidationAccuracy: 0.8, maxRegressions: 0 };
  assert.equal(chooseCandidate(policy, [baseline, improved], baseline.id, baseline.id), baseline.id);
  const regressed = { ...improved, validationRegressions: 1 };
  assert.equal(chooseCandidate(resource(), [baseline, regressed], baseline.id, baseline.id), baseline.id);
  assert.equal(chooseCandidate({ kind: 'quality-constrained-resource', metric: 'usd', minValidationAccuracy: 0.5, maxRegressions: 1 }, [baseline, regressed], baseline.id, baseline.id), regressed.id);
  assert.equal(chooseCandidate(resource(), [baseline, improved], baseline.id, baseline.id), improved.id);
  assert.throws(() => chooseCandidate(policy, [baseline, improved], improved.id, baseline.id), /Incumbent violates/);
});

test('selection refuses incomplete billing, mismatched receipts, duplicate cases, and stale summary claims', () => {
  function malformed(change: (source: ReturnType<typeof fixture>) => void, expression: RegExp) {
    const source = fixture(); change(source);
    assert.throws(() => summarizeCandidates(source.candidates, source.evaluations, source.entries, 'baseline'), expression);
  }
  malformed(source => source.entries.shift(), /matching settled/);
  malformed(source => { source.entries[0]!.status = 'pending'; }, /matching settled/);
  malformed(source => { source.entries[0]!.purpose = 'proposal'; }, /matching settled/);
  malformed(source => { source.entries[0]!.chargedMicros = source.entries[0]!.reservedMicros + 1; }, /exceeds/);
  malformed(source => { source.evaluations[0]!.usage = []; }, /differs from ledger/);
  malformed(source => { source.evaluations.push({ ...source.evaluations[0]!, id: 'duplicate-case' }); }, /candidate-case/);
  malformed(source => { source.add('cached', 'validation', 'extra-case', true, 1, 1); }, /outside the baseline roster/);
  malformed(source => { source.candidates[0]!.validationAccuracy = 1; }, /differs from selection evidence/);
  malformed(source => { source.evaluations[0]!.usage[0]!.cachedInputTokens = 1e6; }, /input subset/);
  malformed(source => { source.evaluations[0]!.usage[0]!.reasoningTokens = 1e6; }, /output subset/);
  malformed(source => { source.evaluations[0]!.usage[0]!.extraCostUSD = 1; }, /non-token charges/);
});

test('invalid policies and ambiguous custom strategy fail preflight before any target or proposer invocation', async () => {
  let calls = 0;
  const proposer = createOfflineProposer<string, string>([]), propose = proposer.propose;
  proposer.propose = async (...args) => { calls++; return propose(...args); };
  const agent = defineAgent<string, string>({ id: 'selection-preflight', version: '1', components: { prompt: 'initial' },
    mutable: { prompt: { role: 'instructions', maxLength: 100 } }, accounting: { kind: 'free', timeoutMs: 1000 }, optimization: { proposer },
    async run() { calls++; return { output: '', usage: { complete: true, receipts: [] } }; } });
  const data: Dataset<string, string> = { id: 'fixture', version: '1', score: () => false,
    train: [{ id: 't', input: 't', expected: 't' }], validation: [{ id: 'v', input: 'v', expected: 'v' }], test: [{ id: 'h', input: 'h', expected: 'h' }] };
  const custom = { id: 'custom', version: '1', select: (_summaries: readonly CandidateSummary[], incumbent: string) => incumbent };
  await assert.rejects(optimize({ agent: { ...agent, optimization: { ...agent.optimization, selection: resource(), strategy: custom } }, dataset: data, objective: 'accuracy', budget: 10 }), /cannot be combined/);
  await assert.rejects(optimize({ agent: { ...agent, optimization: { ...agent.optimization, selection: { kind: 'accuracy', unknown: true } as SelectionPolicy } }, dataset: data, objective: 'accuracy', budget: 10 }), /selection policy fields/);
  assert.doesNotThrow(() => defineAgent({ ...agent, optimization: { ...agent.optimization, selection: { kind: 'accuracy' }, strategy: custom } }));
  assert.doesNotThrow(() => validateOptions({ agent, dataset: data, budget: 10 }), 'Omitted objective is a valid token-optimization request');
  for (const objective of [null, 'usd', '', 10]) {
    await assert.rejects(optimize({ agent, dataset: data, objective: objective as OptimizationObjective, budget: 10 }), /Unsupported objective/);
  }
  for (const selection of [{ kind: 'accuracy' } as const, resource('usd'), resource('tokens'),
    { ...resource('tokens'), ranking: 'accuracy-first' } as const]) {
    await assert.rejects(optimize({ agent: { ...agent, optimization: { ...agent.optimization, selection } }, dataset: data, budget: 10 }), /Tokens objective requires/);
  }
  await assert.rejects(optimize({ agent: { ...agent, optimization: { ...agent.optimization, strategy: custom } }, dataset: data, budget: 10 }), /cannot be combined/);
  assert.equal(calls, 0);
});
