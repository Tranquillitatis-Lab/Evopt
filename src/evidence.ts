import type { LedgerEntry, UsageReceipt } from './types.js';
import { assert, canonical, integer, micros, record, text } from './validation.js';

export interface EvidenceEvaluation {
  id: string; candidateId: string; caseId: string; split: 'train' | 'validation' | 'test';
  passed: boolean; usage: readonly UsageReceipt[];
}
/** Structural input also accepts an OptimizationResult without exposing its task outputs. */
export interface EvidenceInput {
  status: 'completed' | 'interrupted';
  candidates: readonly { id: string }[]; selectedId: string;
  evaluations: readonly EvidenceEvaluation[];
  test?: { kind: 'paired' | 'identity-control'; baselineAccuracy: number; candidateAccuracy: number };
  accounting: { currency: 'USD'; limitMicros: number; occupiedMicros: number; entries: readonly LedgerEntry[] };
}
export interface EvidenceInterval { lower: number; upper: number; confidence: 0.95 }
export interface AccuracyEvidence { successes: number; n: number; estimate: number; interval95: EvidenceInterval }
export interface TestCostEvidence {
  evaluations: number; successes: number; totalMicros: number; meanMicros: number;
  /** Total arm cost divided by successful cases, including failed-case costs; null for zero successes. */
  costPerSuccessMicros: number | null;
}
export interface ReviewEvidence {
  version: 1; kind: 'paired' | 'identity-control'; baselineId: string; candidateId: string;
  paired: { n: number; bothPass: number; bothFail: number; improved: number; regressed: number; improvedCaseIds: string[]; regressedCaseIds: string[] };
  accuracy: { baseline: AccuracyEvidence; candidate: AccuracyEvidence };
  delta: { estimate: number; interval95: EvidenceInterval | null };
  mcnemar: { discordantPairs: number; pValue: number | null; logPValue: number | null; pValueUnderflow: boolean };
  costs: {
    currency: 'USD'; baselineTest: TestCostEvidence; candidateTest: TestCostEvidence;
    /** Unique observed held-out invocations; an identity control is counted once. */
    testTotalMicros: number; proposalMicros: number; otherEvaluationMicros: number; totalRunMicros: number;
    deltaMeanMicros: number; sharedTestInvocations: boolean;
  };
  methods: { accuracy: 'wilson-score-95'; delta: 'paired-hoeffding-95' | 'not-applicable-identity-control'; mcnemar: 'exact-two-sided-binomial' | 'not-applicable-identity-control' };
  assumptions: string[]; limitations: string[];
}

// Wilson score formula: https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm
function accuracy(successes: number, n: number): AccuracyEvidence {
  const estimate = successes / n, z = 1.959963984540054, z2 = z * z;
  const denominator = 1 + z2 / n, center = (estimate + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt(estimate * (1 - estimate) / n + z2 / (4 * n * n)) / denominator;
  return { successes, n, estimate, interval95: { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), confidence: 0.95 } };
}

// Conditional exact McNemar: min(1, 2 * P[Binomial(b+c, 1/2) <= min(b,c)]).
// https://www.statsmodels.org/stable/_modules/statsmodels/stats/contingency_tables.html#mcnemar
// Accumulate in log space: central tails stay stable even when 2^(-n) underflows.
function mcnemar(improved: number, regressed: number): ReviewEvidence['mcnemar'] {
  const n = improved + regressed, k = Math.min(improved, regressed);
  if (n === 0 || k === Math.floor(n / 2)) return { discordantPairs: n, pValue: 1, logPValue: 0, pValueUnderflow: false };
  let logTerm = -n * Math.LN2, logCdf = logTerm;
  for (let j = 1; j <= k; j++) {
    logTerm += Math.log(n - j + 1) - Math.log(j);
    const largest = Math.max(logCdf, logTerm);
    logCdf = largest + Math.log1p(Math.exp(Math.min(logCdf, logTerm) - largest));
  }
  const logPValue = Math.min(0, Math.LN2 + logCdf), pValue = Math.exp(logPValue);
  return { discordantPairs: n, pValue, logPValue, pValueUnderflow: pValue === 0 };
}

function checkReceipt(receipt: UsageReceipt): void {
  assert(record(receipt), 'Malformed usage receipt'); text(receipt.id); text(receipt.provider); text(receipt.model);
  integer(receipt.inputTokens); integer(receipt.outputTokens); integer(receipt.cachedInputTokens);
  assert(receipt.cachedInputTokens <= receipt.inputTokens, 'Invalid cached token subset');
  if (receipt.reasoningTokens !== undefined) { integer(receipt.reasoningTokens); assert(receipt.reasoningTokens <= receipt.outputTokens, 'Invalid reasoning token subset'); }
  if (receipt.extraCostUSD !== undefined) micros(receipt.extraCostUSD);
}

/**
 * Recompute paired held-out evidence and observed costs; never trust supplied summary statistics.
 * Reject incomplete pairs or unsettled billing. Statistical summaries are conditional on the
 * returned assumptions, and do not constitute a promotion decision or proof of improvement.
 */
export function analyzeEvidence(input: EvidenceInput): ReviewEvidence {
  assert(record(input) && input.status === 'completed' && record(input.test), 'Evidence requires a completed held-out run');
  assert(Array.isArray(input.candidates) && input.candidates.length > 0, 'Evidence is missing its baseline candidate');
  const candidateIds = new Set<string>();
  for (const candidate of input.candidates) {
    assert(record(candidate), 'Malformed evidence candidate'); text(candidate.id);
    assert(!candidateIds.has(candidate.id), 'Duplicate evidence candidate'); candidateIds.add(candidate.id);
  }
  const baselineId = input.candidates[0]!.id, candidateId = input.selectedId;
  assert(candidateIds.has(candidateId), 'Evidence is missing its selected candidate');
  const identity = baselineId === candidateId, kind = identity ? 'identity-control' : 'paired';
  assert(input.test.kind === kind, 'Held-out comparison kind disagrees with candidate identities');
  const accounting = input.accounting;
  assert(record(accounting) && accounting.currency === 'USD' && Array.isArray(accounting.entries), 'Evidence requires a USD ledger');
  integer(accounting.limitMicros, 1); integer(accounting.occupiedMicros);
  const entries: readonly LedgerEntry[] = accounting.entries;
  const ledger = new Map<string, LedgerEntry>(), receiptIds = new Set<string>();
  let totalRunMicros = 0, proposalMicros = 0;
  for (const entry of entries) {
    assert(record(entry), 'Malformed evidence ledger entry'); text(entry.id); text(entry.purpose);
    assert(!ledger.has(entry.id), 'Duplicate evidence ledger identity');
    assert(entry.status === 'settled', 'Evidence requires every ledger entry to be settled');
    integer(entry.reservedMicros); integer(entry.chargedMicros);
    assert(entry.chargedMicros <= entry.reservedMicros, 'Settled charge exceeds its envelope');
    const receipts = entry.receipts ?? [];
    assert(Array.isArray(receipts), 'Missing ledger receipts');
    if (entry.reservedMicros > 0) assert(receipts.length > 0, 'Paid evidence requires normalized receipts');
    let extras = 0;
    for (const receipt of receipts) {
      checkReceipt(receipt);
      const key = canonical([receipt.provider, receipt.id]);
      assert(!receiptIds.has(key), 'Usage receipt reused across ledger entries'); receiptIds.add(key);
      extras += micros(receipt.extraCostUSD ?? 0); integer(extras);
      if (entry.reservedMicros === 0) assert(receipt.inputTokens === 0 && receipt.outputTokens === 0 && (receipt.extraCostUSD ?? 0) === 0, 'Free ledger entry contains paid usage');
    }
    assert(entry.chargedMicros >= extras, 'Settled charge omits known non-token charges');
    totalRunMicros += entry.chargedMicros; integer(totalRunMicros);
    if (entry.purpose === 'proposal') { proposalMicros += entry.chargedMicros; integer(proposalMicros); }
    ledger.set(entry.id, entry);
  }
  assert(totalRunMicros === accounting.occupiedMicros && totalRunMicros <= accounting.limitMicros, 'Evidence ledger total does not reconcile');
  assert(Array.isArray(input.evaluations), 'Missing evaluation evidence');
  const evaluations: readonly EvidenceEvaluation[] = input.evaluations;
  const evaluationIds = new Set<string>(), pairIds = new Set<string>(), caseSplits = new Map<string, string>();
  const baseline = new Map<string, EvidenceEvaluation>(), candidate = new Map<string, EvidenceEvaluation>();
  for (const evaluation of evaluations) {
    assert(record(evaluation), 'Malformed evaluation evidence'); text(evaluation.id); text(evaluation.caseId);
    assert(candidateIds.has(evaluation.candidateId) && ['train', 'validation', 'test'].includes(evaluation.split) && typeof evaluation.passed === 'boolean', 'Malformed evaluation evidence');
    assert(!evaluationIds.has(evaluation.id), 'Duplicate evaluation identity'); evaluationIds.add(evaluation.id);
    const key = canonical([evaluation.candidateId, evaluation.split, evaluation.caseId]);
    assert(!pairIds.has(key), 'Duplicate candidate-case evaluation'); pairIds.add(key);
    assert(!caseSplits.has(evaluation.caseId) || caseSplits.get(evaluation.caseId) === evaluation.split, 'Case reused across data partitions');
    caseSplits.set(evaluation.caseId, evaluation.split);
    const entry = ledger.get(evaluation.id);
    assert(entry && entry.purpose === `eval:${evaluation.candidateId}:${evaluation.split}:${evaluation.caseId}`, 'Evaluation has no matching settled ledger entry');
    assert(Array.isArray(evaluation.usage) && canonical(evaluation.usage) === canonical(entry.receipts ?? []), 'Evaluation usage disagrees with its ledger receipts');
    if (evaluation.split === 'test') {
      assert(evaluation.candidateId === baselineId || evaluation.candidateId === candidateId, 'Held-out data evaluated an unselected candidate');
      if (evaluation.candidateId === baselineId) baseline.set(evaluation.caseId, evaluation);
      if (evaluation.candidateId === candidateId) candidate.set(evaluation.caseId, evaluation);
    }
  }
  for (const entry of ledger.values()) {
    assert(entry.purpose === 'proposal' || evaluationIds.has(entry.id)
      || entry.purpose.startsWith('eval:') && entry.chargedMicros === 0 && (entry.receipts ?? []).length === 0,
    'Unmatched paid or unsupported ledger entry');
  }
  const cases = [...baseline.keys()].sort(), n = cases.length;
  assert(n > 0 && candidate.size === n && cases.every(id => candidate.has(id)), 'Held-out cases must have complete baseline/candidate pairs');
  const paired: ReviewEvidence['paired'] = { n, bothPass: 0, bothFail: 0, improved: 0, regressed: 0, improvedCaseIds: [], regressedCaseIds: [] };
  for (const id of cases) {
    const before = baseline.get(id)!.passed, after = candidate.get(id)!.passed;
    if (before && after) paired.bothPass++;
    else if (!before && !after) paired.bothFail++;
    else if (after) { paired.improved++; paired.improvedCaseIds.push(id); }
    else { paired.regressed++; paired.regressedCaseIds.push(id); }
  }
  const baselineAccuracy = accuracy(paired.bothPass + paired.regressed, n), candidateAccuracy = accuracy(paired.bothPass + paired.improved, n);
  assert(input.test.baselineAccuracy === baselineAccuracy.estimate && input.test.candidateAccuracy === candidateAccuracy.estimate, 'Held-out accuracy summary disagrees with per-case evidence');
  const armCost = (rows: Map<string, EvidenceEvaluation>, successes: number): TestCostEvidence => {
    const totalMicros = [...rows.values()].reduce((sum, evaluation) => sum + ledger.get(evaluation.id)!.chargedMicros!, 0);
    return { evaluations: n, successes, totalMicros, meanMicros: totalMicros / n, costPerSuccessMicros: successes === 0 ? null : totalMicros / successes };
  };
  const baselineTest = armCost(baseline, baselineAccuracy.successes), candidateTest = armCost(candidate, candidateAccuracy.successes);
  const testTotalMicros = baselineTest.totalMicros + (identity ? 0 : candidateTest.totalMicros);
  const estimate = (paired.improved - paired.regressed) / n;
  // Hoeffding (1963), Theorem 2, applied to independent D_i in [-1,1]:
  // P(|mean(D)-E mean(D)| >= epsilon) <= 2 exp(-n epsilon^2 / 2).
  // https://doi.org/10.1080/01621459.1963.10500830
  const radius = Math.sqrt(2 * Math.log(2 / 0.05) / n);
  return {
    version: 1, kind, baselineId, candidateId, paired,
    accuracy: { baseline: baselineAccuracy, candidate: candidateAccuracy },
    delta: { estimate, interval95: identity ? null : { lower: Math.max(-1, estimate - radius), upper: Math.min(1, estimate + radius), confidence: 0.95 } },
    mcnemar: identity ? { discordantPairs: 0, pValue: null, logPValue: null, pValueUnderflow: false } : mcnemar(paired.improved, paired.regressed),
    costs: { currency: 'USD', baselineTest, candidateTest, testTotalMicros, proposalMicros,
      otherEvaluationMicros: totalRunMicros - proposalMicros - testTotalMicros, totalRunMicros,
      deltaMeanMicros: candidateTest.meanMicros - baselineTest.meanMicros, sharedTestInvocations: identity },
    methods: { accuracy: 'wilson-score-95', delta: identity ? 'not-applicable-identity-control' : 'paired-hoeffding-95', mcnemar: identity ? 'not-applicable-identity-control' : 'exact-two-sided-binomial' },
    assumptions: [
      'Held-out cases are independent and representative of the intended task population; outcomes within each baseline/candidate pair may be dependent.',
      'The case roster is complete and fixed before evaluation, and the candidate is selected without using these held-out outcomes.',
      'Exact McNemar inference assumes independent pairs and equally likely directions of discordance under the null of equal marginal accuracy.',
    ],
    limitations: [
      'One draw per task and configuration cannot quantify model rerun variance.',
      'Wilson intervals are approximate score intervals; the paired Hoeffding interval is distribution-free and conservative only under the stated independence assumptions.',
      'Intervals and p-values are conditional summaries, not statistical proof or a guarantee of production improvement; no significance or promotion decision is made.',
      'Repeated searches, multiple comparisons, and reuse of held-out cases are not corrected for.',
      'Costs are observed settled ledger charges under the run accounting contract, not independently verified invoices or future cost forecasts.',
      ...(identity ? ['Identity control reuses the same observations and costs; it has no independent arms and makes no comparison significance claim.'] : []),
    ],
  };
}
