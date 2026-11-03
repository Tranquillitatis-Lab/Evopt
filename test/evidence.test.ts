import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvidence, type EvidenceEvaluation, type EvidenceInput } from '../src/evidence.js';
import type { LedgerEntry, UsageReceipt } from '../src/types.js';

function fixture(pairs: readonly (readonly [boolean, boolean])[], options: { identity?: boolean; baselineCost?: number; candidateCost?: number; proposalCost?: number; trainCost?: number } = {}) {
  const baselineId = 'baseline', candidateId = options.identity ? baselineId : 'candidate';
  const evaluations: EvidenceEvaluation[] = [], entries: LedgerEntry[] = [];
  const usage = (id: string, cost: number): UsageReceipt[] => cost === 0 ? [] : [{ id: `receipt-${id}`, provider: 'fixture', model: 'fixture', inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 }];
  const add = (candidateId: string, caseId: string, split: EvidenceEvaluation['split'], passed: boolean, cost: number) => {
    const id = `evaluation-${evaluations.length}`, receipts = usage(id, cost);
    evaluations.push({ id, candidateId, caseId, split, passed, usage: receipts });
    entries.push({ id, purpose: `eval:${candidateId}:${split}:${caseId}`, reservedMicros: cost, chargedMicros: cost, status: 'settled', receipts });
  };
  pairs.forEach(([before, after], index) => {
    const caseId = `case-${String(index + 1).padStart(5, '0')}`;
    add(baselineId, caseId, 'test', before, options.baselineCost ?? 0);
    if (!options.identity) add(candidateId, caseId, 'test', after, options.candidateCost ?? 0);
  });
  if (options.trainCost !== undefined) add(baselineId, 'train-case', 'train', true, options.trainCost);
  if (options.proposalCost !== undefined) entries.push({ id: 'proposal', purpose: 'proposal', reservedMicros: options.proposalCost,
    chargedMicros: options.proposalCost, status: 'settled', receipts: usage('proposal', options.proposalCost) });
  const total = entries.reduce((sum, entry) => sum + entry.chargedMicros!, 0);
  return {
    status: 'completed' as const, candidates: options.identity ? [{ id: baselineId }] : [{ id: baselineId }, { id: candidateId }], selectedId: candidateId,
    evaluations, test: { kind: options.identity ? 'identity-control' as const : 'paired' as const,
      baselineAccuracy: pairs.filter(pair => pair[0]).length / pairs.length,
      candidateAccuracy: pairs.filter(pair => pair[options.identity ? 0 : 1]).length / pairs.length },
    accounting: { currency: 'USD' as const, limitMicros: Math.max(1, total), occupiedMicros: total, entries },
  };
}
function near(actual: number, expected: number, tolerance = 1e-12) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`); }

test('review evidence pairs exact held-out cases and exposes regression IDs without task outputs', () => {
  const input = fixture([[true, true], [false, false], [false, true], [true, false], [false, true]]);
  const snapshot = structuredClone(input), evidence = analyzeEvidence(input);
  assert.deepEqual(evidence.paired, { n: 5, bothPass: 1, bothFail: 1, improved: 2, regressed: 1,
    improvedCaseIds: ['case-00003', 'case-00005'], regressedCaseIds: ['case-00004'] });
  assert.equal(evidence.accuracy.baseline.estimate, 0.4); assert.equal(evidence.accuracy.candidate.estimate, 0.6);
  near(evidence.delta.estimate, 0.2); assert.equal(evidence.mcnemar.pValue, 1);
  assert.deepEqual(input, snapshot);
  const reordered = { ...input, evaluations: [...input.evaluations].reverse(), accounting: { ...input.accounting, entries: [...input.accounting.entries].reverse() } };
  assert.deepEqual(analyzeEvidence(reordered), evidence);
});

test('Wilson limits and conservative paired uncertainty remain honest with small samples and boundary accuracies', () => {
  const evidence = analyzeEvidence(fixture([[false, true]]));
  near(evidence.accuracy.baseline.interval95.lower, 0);
  near(evidence.accuracy.baseline.interval95.upper, 0.7934506856227626);
  near(evidence.accuracy.candidate.interval95.lower, 0.20654931437723745);
  near(evidence.accuracy.candidate.interval95.upper, 1);
  assert.equal(evidence.delta.estimate, 1);
  assert.ok(evidence.delta.interval95!.lower < 0); assert.equal(evidence.delta.interval95!.upper, 1);
  assert.equal(evidence.mcnemar.pValue, 1);
  assert.equal(evidence.methods.delta, 'paired-hoeffding-95');
  assert.ok(evidence.assumptions.some(value => /independent and representative/.test(value)));
  assert.ok(evidence.limitations.some(value => /cannot quantify model rerun variance/.test(value)));
  const larger = analyzeEvidence(fixture(Array.from({ length: 100 }, (_, index) => [index < 40, index < 60] as const)));
  near(larger.accuracy.baseline.interval95.lower, 0.3094012864324589);
  near(larger.accuracy.baseline.interval95.upper, 0.49799741320893826);
  near(larger.delta.interval95!.lower, 0.2 - Math.sqrt(2 * Math.log(40) / 100));
  near(larger.delta.interval95!.upper, 0.2 + Math.sqrt(2 * Math.log(40) / 100));
});

test('exact two-sided McNemar matches known binomial probabilities and is symmetric in discordant directions', () => {
  const pairs: [boolean, boolean][] = [...Array.from({ length: 9 }, () => [false, true] as [boolean, boolean]), [true, false]];
  const forward = analyzeEvidence(fixture(pairs)), reverse = analyzeEvidence(fixture(pairs.map(([a, b]) => [b, a])));
  near(forward.mcnemar.pValue!, 22 / 1024);
  near(forward.mcnemar.logPValue!, Math.log(22 / 1024));
  assert.equal(forward.mcnemar.pValue, reverse.mcnemar.pValue);
  assert.equal(forward.mcnemar.discordantPairs, 10);
  assert.equal(analyzeEvidence(fixture([[true, true], [false, false]])).mcnemar.pValue, 1);
  assert.equal(analyzeEvidence(fixture([[true, false], [false, true], [false, true]])).mcnemar.pValue, 1);
});

test('McNemar calculation avoids central-tail underflow and explicitly reports unrepresentably small tails', () => {
  const pairs = Array.from({ length: 4000 }, (_, index) => [index >= 2001, index < 2001] as const);
  const evidence = analyzeEvidence(fixture(pairs));
  // P[Binomial(4000, 1/2) = 2000] = product_i (2i-1)/(2i).
  let centralMass = 1; for (let i = 1; i <= 2000; i++) centralMass *= (2 * i - 1) / (2 * i);
  near(evidence.mcnemar.pValue!, 1 - centralMass, 1e-8);
  assert.equal(evidence.mcnemar.pValueUnderflow, false);
  const tiny = analyzeEvidence(fixture(Array.from({ length: 2000 }, () => [false, true] as const)));
  assert.equal(tiny.mcnemar.pValue, 0); assert.equal(tiny.mcnemar.pValueUnderflow, true);
  near(tiny.mcnemar.logPValue!, -1999 * Math.LN2);
});

test('identity control reuses one arm without significance or duplicate cost claims', () => {
  const evidence = analyzeEvidence(fixture([[true, true], [false, false]], { identity: true, baselineCost: 1000, proposalCost: 500, trainCost: 250 }));
  assert.equal(evidence.kind, 'identity-control'); assert.equal(evidence.paired.n, 2);
  assert.deepEqual(evidence.accuracy.baseline, evidence.accuracy.candidate);
  assert.deepEqual(evidence.delta, { estimate: 0, interval95: null });
  assert.deepEqual(evidence.mcnemar, { discordantPairs: 0, pValue: null, logPValue: null, pValueUnderflow: false });
  assert.equal(evidence.methods.mcnemar, 'not-applicable-identity-control');
  assert.equal(evidence.costs.testTotalMicros, 2000); assert.equal(evidence.costs.totalRunMicros, 2750);
  assert.equal(evidence.costs.baselineTest.totalMicros, 2000); assert.equal(evidence.costs.candidateTest.totalMicros, 2000);
  assert.equal(evidence.costs.sharedTestInvocations, true); assert.equal(evidence.costs.deltaMeanMicros, 0);
  assert.ok(evidence.limitations.some(value => /no independent arms/.test(value)));
});

test('observed cost tradeoffs use evaluation ledger IDs and return null for cost per zero successes', () => {
  const evidence = analyzeEvidence(fixture([[false, true], [false, false]], { baselineCost: 2000, candidateCost: 3500, proposalCost: 5000, trainCost: 1000 }));
  assert.deepEqual(evidence.costs.baselineTest, { evaluations: 2, successes: 0, totalMicros: 4000, meanMicros: 2000, costPerSuccessMicros: null });
  assert.deepEqual(evidence.costs.candidateTest, { evaluations: 2, successes: 1, totalMicros: 7000, meanMicros: 3500, costPerSuccessMicros: 7000 });
  assert.equal(evidence.costs.testTotalMicros, 11000); assert.equal(evidence.costs.proposalMicros, 5000);
  assert.equal(evidence.costs.otherEvaluationMicros, 1000); assert.equal(evidence.costs.totalRunMicros, 17000);
  assert.equal(evidence.costs.deltaMeanMicros, 1500);
  const reserved = fixture([[false, true]], { baselineCost: 10, candidateCost: 20 });
  reserved.accounting.entries.forEach(entry => { entry.reservedMicros = 1000; });
  assert.equal(analyzeEvidence(reserved).costs.testTotalMicros, 30);
});

test('review evidence rejects incomplete, unpaired, duplicate and mismatched held-out results', () => {
  const valid = fixture([[true, true], [false, true]]);
  assert.throws(() => analyzeEvidence({ ...valid, status: 'interrupted' }), /completed/);
  assert.throws(() => analyzeEvidence({ ...valid, test: undefined }), /completed/);
  assert.throws(() => analyzeEvidence({ ...valid, selectedId: 'missing' }), /selected candidate/);
  const wrongSummary = structuredClone(valid); wrongSummary.test.candidateAccuracy = 0;
  assert.throws(() => analyzeEvidence(wrongSummary), /summary disagrees/);
  const missing = structuredClone(valid); missing.evaluations.pop();
  assert.throws(() => analyzeEvidence(missing), /complete baseline\/candidate pairs/);
  const duplicate = structuredClone(valid); duplicate.evaluations.push(duplicate.evaluations[0]!);
  assert.throws(() => analyzeEvidence(duplicate), /Duplicate evaluation identity/);
  const duplicatePair = structuredClone(valid), original = duplicatePair.evaluations[0]!;
  duplicatePair.evaluations.push({ ...original, id: 'different' });
  duplicatePair.accounting.entries.push({ ...duplicatePair.accounting.entries[0]!, id: 'different' });
  assert.throws(() => analyzeEvidence(duplicatePair), /Duplicate candidate-case/);
  assert.throws(() => analyzeEvidence({ ...valid, test: { ...valid.test, kind: 'identity-control' } }), /comparison kind/);
  const unselected = structuredClone(valid); unselected.candidates.push({ id: 'unselected' });
  unselected.evaluations[0]!.candidateId = 'unselected'; unselected.accounting.entries[0]!.purpose = 'eval:unselected:test:case-00001';
  assert.throws(() => analyzeEvidence(unselected), /unselected candidate/);
});

test('review evidence refuses unsettled, missing or inconsistent cost attribution', () => {
  const valid = fixture([[false, true]], { baselineCost: 1000, candidateCost: 2000 });
  for (const status of ['pending', 'envelope_violation'] as const) {
    const input = structuredClone(valid); input.accounting.entries[0]!.status = status;
    assert.throws(() => analyzeEvidence(input), /every ledger entry to be settled/);
  }
  const missingCharge = structuredClone(valid); delete missingCharge.accounting.entries[0]!.chargedMicros;
  assert.throws(() => analyzeEvidence(missingCharge), /safe integer/);
  const missingEntry = structuredClone(valid); missingEntry.accounting.entries.shift(); missingEntry.accounting.occupiedMicros = 2000;
  assert.throws(() => analyzeEvidence(missingEntry), /matching settled ledger/);
  const wrongTotal = structuredClone(valid); wrongTotal.accounting.occupiedMicros++;
  assert.throws(() => analyzeEvidence(wrongTotal), /does not reconcile/);
  const wrongUsage = structuredClone(valid); wrongUsage.evaluations[0]!.usage = [];
  assert.throws(() => analyzeEvidence(wrongUsage), /usage disagrees/);
  const wrongPurpose = structuredClone(valid); wrongPurpose.accounting.entries[0]!.purpose = 'proposal';
  assert.throws(() => analyzeEvidence(wrongPurpose), /matching settled ledger/);
  const orphan = structuredClone(valid); orphan.evaluations.pop();
  assert.throws(() => analyzeEvidence(orphan), /Unmatched paid/);
  const reused = structuredClone(valid); reused.accounting.entries[1]!.receipts![0]!.id = reused.accounting.entries[0]!.receipts![0]!.id;
  assert.throws(() => analyzeEvidence(reused), /receipt reused/);
  const foreignCurrency = { ...valid, accounting: { ...valid.accounting, currency: 'EUR' } };
  assert.throws(() => analyzeEvidence(foreignCurrency as unknown as EvidenceInput), /USD ledger/);
});
