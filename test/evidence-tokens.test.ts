import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence, type EvidenceEvaluation, type EvidenceInput } from '../src/evidence.js';
import type { LedgerEntry, UsageReceipt } from '../src/types.js';

// Authored observations only: charges deliberately vary independently of token
// totals so the review cannot accidentally substitute one resource for another.
interface Meter { input: number; output: number; cost: number; cached?: number; reasoning?: number }
interface Pair { id: string; baseline: Meter[]; candidate: Meter[] }
function fixture(pairs: Pair[], options: { identity?: boolean; proposal?: Meter[]; training?: Meter[] } = {}): EvidenceInput {
  const baselineId = 'baseline', selectedId = options.identity ? baselineId : 'candidate';
  const evaluations: EvidenceEvaluation[] = [], entries: LedgerEntry[] = [];
  function invocation(id: string, purpose: string, meters: Meter[]): UsageReceipt[] {
    const receipts = meters.map((meter, index) => ({ id: `${id}-receipt-${index}`, provider: 'fixture', model: 'authored',
      inputTokens: meter.input, outputTokens: meter.output, cachedInputTokens: meter.cached ?? 0,
      ...(meter.reasoning === undefined ? {} : { reasoningTokens: meter.reasoning }) }));
    const charge = meters.reduce((sum, meter) => sum + meter.cost, 0);
    entries.push({ id, purpose, reservedMicros: charge, chargedMicros: charge, status: 'settled', receipts }); return receipts;
  }
  function evaluate(candidateId: string, caseId: string, split: 'train' | 'test', meters: Meter[]) {
    const id = `${candidateId}-${split}-${caseId}`;
    evaluations.push({ id, candidateId, caseId, split, passed: true,
      usage: invocation(id, `eval:${candidateId}:${split}:${caseId}`, meters) });
  }
  for (const pair of pairs) {
    evaluate(baselineId, pair.id, 'test', pair.baseline);
    if (!options.identity) evaluate(selectedId, pair.id, 'test', pair.candidate);
  }
  if (options.training) evaluate(baselineId, 'training-case', 'train', options.training);
  if (options.proposal) invocation('proposal', 'proposal', options.proposal);
  const total = entries.reduce((sum, entry) => sum + entry.chargedMicros!, 0);
  return { status: 'completed', candidates: options.identity ? [{ id: baselineId }] : [{ id: baselineId }, { id: selectedId }], selectedId, evaluations,
    test: { kind: options.identity ? 'identity-control' : 'paired', baselineAccuracy: 1, candidateAccuracy: 1 },
    accounting: { currency: 'USD', limitMicros: Math.max(1, total), occupiedMicros: total, entries } };
}
function mixedFixture(): EvidenceInput {
  return fixture([
    { id: 'z', baseline: [{ input: 60, output: 10, cached: 50, reasoning: 5, cost: 300 }, { input: 20, output: 10, cached: 20, reasoning: 5, cost: 100 }],
      candidate: [{ input: 40, output: 10, cached: 30, reasoning: 5, cost: 500 }] },
    { id: 'a', baseline: [{ input: 160, output: 40, cached: 150, reasoning: 20, cost: 100 }],
      candidate: [{ input: 200, output: 50, cached: 100, reasoning: 25, cost: 1000 }] },
    { id: 'm', baseline: [{ input: 45, output: 5, cached: 40, reasoning: 3, cost: 300 }],
      candidate: [{ input: 35, output: 5, cached: 30, reasoning: 3, cost: 150 }] },
  ], { proposal: [{ input: 900, output: 100, cached: 850, reasoning: 70, cost: 10 }],
    training: [{ input: 20, output: 20, cached: 10, reasoning: 10, cost: 10000 }] });
}

test('token evidence sums every input/output receipt and attributes proposals separately from dollars and held-out arms', () => {
  const input = mixedFixture(), original = structuredClone(input), review = analyzeEvidence(input);
  assert.deepEqual(review.tokens.perCase, [
    { caseId: 'a', baseline: 200, candidate: 250, delta: 50 },
    { caseId: 'm', baseline: 50, candidate: 40, delta: -10 },
    { caseId: 'z', baseline: 100, candidate: 50, delta: -50 },
  ]);
  assert.equal(review.tokens.baselineTest, 350); assert.equal(review.tokens.candidateTest, 340); assert.equal(review.tokens.saved, 10);
  assert.ok(Math.abs(review.tokens.savingsFraction! - 10 / 350) < 1e-12);
  assert.equal(review.tokens.proposal, 1000); assert.equal(review.tokens.otherEvaluations, 40); assert.equal(review.tokens.totalRun, 1730);
  assert.equal(review.tokens.sharedTestInvocations, false);
  assert.equal(review.costs.baselineTest.totalMicros, 800); assert.equal(review.costs.candidateTest.totalMicros, 1650);
  assert.equal(review.costs.proposalMicros, 10); assert.equal(review.costs.otherEvaluationMicros, 10000); assert.equal(review.costs.totalRunMicros, 12460);
  assert.ok(review.tokens.saved > 0 && review.costs.deltaMeanMicros > 0, 'Fewer tokens can cost more dollars');
  assert.deepEqual(input, original, 'Evidence analysis must leave observations unchanged');
  const reordered = structuredClone(input); reordered.evaluations = [...reordered.evaluations].reverse(); reordered.accounting.entries = [...reordered.accounting.entries].reverse();
  assert.deepEqual(analyzeEvidence(reordered).tokens, review.tokens, 'Pair ordering must not change token totals or resampling');
});

test('identity controls report both labels but count each held-out invocation only once in run totals', () => {
  const meter = (input: number): Meter => ({ input, output: 10, cached: input, reasoning: 10, cost: 1 });
  const input = fixture([
    { id: 'first', baseline: [meter(90)], candidate: [] },
    { id: 'second', baseline: [meter(190)], candidate: [] },
  ], { identity: true, proposal: [meter(990)], training: [meter(30)] });
  const tokens = analyzeEvidence(input).tokens;
  assert.equal(tokens.baselineTest, 300); assert.equal(tokens.candidateTest, 300);
  assert.equal(tokens.saved, 0); assert.equal(tokens.savingsFraction, 0); assert.equal(tokens.sharedTestInvocations, true);
  assert.equal(tokens.proposal, 1000); assert.equal(tokens.otherEvaluations, 40); assert.equal(tokens.totalRun, 1340);
  assert.ok(tokens.perCase.every(pair => pair.delta === 0)); assert.equal(tokens.deltaInterval95, null);
});

test('zero-token baselines have no defined savings fraction and one task cannot provide a resampling interval', () => {
  const zero = analyzeEvidence(fixture([{ id: 'zero', baseline: [], candidate: [] }])).tokens;
  assert.equal(zero.baselineTest, 0); assert.equal(zero.candidateTest, 0); assert.equal(zero.saved, 0); assert.equal(zero.savingsFraction, null);
  assert.equal(zero.deltaInterval95, null);
  const added = analyzeEvidence(fixture([{ id: 'new-tokens', baseline: [], candidate: [{ input: 7, output: 3, cached: 6, reasoning: 2, cost: 1 }] }])).tokens;
  assert.equal(added.saved, -10); assert.equal(added.savingsFraction, null); assert.equal(added.totalRun, 10); assert.equal(added.deltaInterval95, null);
  const single = analyzeEvidence(fixture([{ id: 'single', baseline: [{ input: 90, output: 10, cost: 1 }], candidate: [{ input: 5, output: 5, cost: 1 }] }])).tokens;
  assert.equal(single.saved, 90); assert.equal(single.deltaInterval95, null);
});

test('token intervals describe paired task mean deltas rather than aggregate savings or independent arms', () => {
  const meter = (input: number): Meter[] => input === 0 ? [] : [{ input, output: 0, cost: 1 }];
  const input = fixture([20, 200, 2000].map((tokens, index) => ({ id: `task-${index}`, baseline: meter(tokens), candidate: meter(tokens - 20) })));
  const review = analyzeEvidence(input);
  assert.equal(review.tokens.saved, 60);
  assert.deepEqual(review.tokens.deltaInterval95, { lower: -20, upper: -20, method: 'descriptive-task-bootstrap-95' });
  const mixed = analyzeEvidence(mixedFixture()).tokens.deltaInterval95!;
  assert.equal(mixed.method, 'descriptive-task-bootstrap-95');
  assert.ok(mixed.lower >= -50 && mixed.lower < 0 && mixed.upper > 0 && mixed.upper <= 50);
  assert.ok(review.limitations.some(value => /cannot quantify model rerun variance/.test(value)));
});

test('token-cap evidence is reconciled against all receipts and rejects altered or missing totals', () => {
  const input = mixedFixture(); input.accounting.maxTokens = 2000; input.accounting.occupiedTokens = 1730;
  assert.equal(analyzeEvidence(input).tokens.totalRun, 1730);
  const invalid = (edit: (copy: EvidenceInput) => void, expected: RegExp) => {
    const copy = structuredClone(input); edit(copy); assert.throws(() => analyzeEvidence(copy), expected);
  };
  invalid(copy => { copy.accounting.occupiedTokens = 1729; }, /token ceiling does not reconcile/);
  invalid(copy => { copy.accounting.maxTokens = 1729; }, /token ceiling does not reconcile/);
  invalid(copy => { delete copy.accounting.occupiedTokens; }, /safe integer/);
  invalid(copy => { delete copy.accounting.maxTokens; }, /requires its ceiling/);
  invalid(copy => { copy.accounting.maxTokens = 0; }, /safe integer/);
  invalid(copy => { copy.accounting.maxTokens = 2000.5; }, /safe integer/);
  invalid(copy => { copy.accounting.occupiedTokens = 1730.5; }, /safe integer/);
});
