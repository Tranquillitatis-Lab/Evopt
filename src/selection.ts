import { isDeepStrictEqual } from 'node:util';
import type { Candidate, CandidateSummary, Evaluation, LedgerEntry, OptimizationObjective, SelectionPolicy, UsageReceipt } from './types.js';

function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function text(value: unknown, label: string): asserts value is string {
  require(typeof value === 'string' && value.trim().length > 0, `${label} must be nonempty text`);
}
function integer(value: unknown, label: string): asserts value is number {
  require(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
}
function accuracy(value: unknown, label: string): asserts value is number {
  require(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be between zero and one`);
}

/** New runs minimize tokens by default; objective values are never inferred from a policy. */
export function normalizeObjective(value?: unknown): OptimizationObjective {
  if (value === undefined) return 'tokens';
  require(value === 'tokens' || value === 'accuracy', 'Unsupported objective');
  return value;
}

/** Normalize existing policy artifacts. An omitted policy retains the legacy accuracy meaning. */
export function normalizeSelectionPolicy(value?: unknown): SelectionPolicy {
  if (value === undefined) return Object.freeze({ kind: 'accuracy' });
  require(object(value), 'Invalid selection policy');
  require(Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')), 'Selection policy must be plain JSON data');
  const fields = value.kind === 'accuracy' ? ['kind'] : ['kind', 'metric', 'minValidationAccuracy', 'maxRegressions'];
  const optional = value.kind === 'quality-constrained-resource' ? ['ranking'] : [];
  require(fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => fields.includes(key) || optional.includes(key)), 'Unexpected or missing selection policy fields');
  if (value.kind === 'accuracy') return Object.freeze({ kind: 'accuracy' });
  require(value.kind === 'quality-constrained-resource', 'Unsupported selection policy');
  require(value.metric === 'usd' || value.metric === 'tokens', 'Unsupported selection resource metric');
  accuracy(value.minValidationAccuracy, 'Minimum validation accuracy'); integer(value.maxRegressions, 'Maximum validation regressions');
  if (Object.hasOwn(value, 'ranking')) require(value.ranking === 'accuracy-first' || value.ranking === 'resource-first', 'Unsupported selection ranking');
  return Object.freeze({ kind: value.kind, metric: value.metric, minValidationAccuracy: value.minValidationAccuracy, maxRegressions: value.maxRegressions,
    ...(Object.hasOwn(value, 'ranking') ? { ranking: value.ranking as 'accuracy-first' | 'resource-first' } : {}) });
}

/** Resolve a new run's declared objective without changing legacy artifact defaults. */
export function resolveSelectionPolicy(objective: OptimizationObjective, value?: unknown): SelectionPolicy {
  const normalizedObjective = normalizeObjective(objective);
  if (normalizedObjective === 'accuracy') return normalizeSelectionPolicy(value);
  const policy = normalizeSelectionPolicy(value === undefined ? {
    kind: 'quality-constrained-resource', metric: 'tokens', minValidationAccuracy: 0, maxRegressions: 0, ranking: 'resource-first',
  } : value);
  require(policy.kind === 'quality-constrained-resource' && policy.metric === 'tokens' && policy.ranking === 'resource-first',
    'Tokens objective requires resource-first token selection');
  return policy;
}

type SelectionEvaluation = Pick<Evaluation<unknown>, 'id' | 'candidateId' | 'caseId' | 'split' | 'passed' | 'usage'>;
type CandidateIdentity = Pick<Candidate, 'id' | 'trainAccuracy' | 'validationAccuracy'>;
type Split = 'train' | 'validation';
function receiptTokens(receipt: UsageReceipt): number {
  require(object(receipt), 'Invalid selection usage receipt'); text(receipt.id, 'Receipt id'); text(receipt.provider, 'Receipt provider'); text(receipt.model, 'Receipt model');
  integer(receipt.inputTokens, 'Receipt input tokens'); integer(receipt.outputTokens, 'Receipt output tokens'); integer(receipt.cachedInputTokens, 'Receipt cached tokens');
  require(receipt.cachedInputTokens <= receipt.inputTokens, 'Cached tokens must be an input subset');
  if (receipt.reasoningTokens !== undefined) { integer(receipt.reasoningTokens, 'Receipt reasoning tokens'); require(receipt.reasoningTokens <= receipt.outputTokens, 'Reasoning tokens must be an output subset'); }
  if (receipt.extraCostUSD !== undefined) require(typeof receipt.extraCostUSD === 'number' && Number.isFinite(receipt.extraCostUSD) && receipt.extraCostUSD >= 0, 'Invalid non-token charge');
  const total = receipt.inputTokens + receipt.outputTokens; integer(total, 'Receipt total tokens'); return total;
}

/**
 * Recompute complete train/validation summaries from matching settled invocations.
 * The baseline defines the case roster. Incomplete candidates are omitted; extra
 * or duplicate cases are errors. Held-out rows and their charges never contribute.
 */
export function summarizeCandidates(
  candidates: readonly CandidateIdentity[], evaluations: readonly SelectionEvaluation[], entries: readonly LedgerEntry[], baselineId: string,
): CandidateSummary[] {
  require(Array.isArray(candidates) && candidates.length > 0 && Array.isArray(evaluations) && Array.isArray(entries), 'Selection requires candidates, evaluations, and a ledger');
  const candidateIds = new Set<string>();
  const rows = new Map<string, Record<Split, Map<string, SelectionEvaluation>>>();
  for (const candidate of candidates) {
    require(object(candidate), 'Malformed selection candidate'); text(candidate.id, 'Candidate id');
    require(!candidateIds.has(candidate.id), 'Duplicate selection candidate'); candidateIds.add(candidate.id);
    rows.set(candidate.id, { train: new Map(), validation: new Map() });
  }
  require(candidateIds.has(baselineId), 'Selection baseline is missing');
  const evaluationIds = new Set<string>(), caseSplits = new Map<string, Split>();
  const typedEvaluations: readonly SelectionEvaluation[] = evaluations;
  for (const row of typedEvaluations) {
    require(object(row), 'Malformed selection evaluation');
    if (row.split === 'test') continue;
    require(row.split === 'train' || row.split === 'validation', 'Unsupported selection evaluation split');
    text(row.id, 'Evaluation id'); text(row.caseId, 'Case id');
    require(candidateIds.has(row.candidateId) && typeof row.passed === 'boolean', 'Malformed selection evaluation');
    require(!evaluationIds.has(row.id), 'Duplicate selection evaluation identity'); evaluationIds.add(row.id);
    require(!caseSplits.has(row.caseId) || caseSplits.get(row.caseId) === row.split, 'Selection case reused across partitions'); caseSplits.set(row.caseId, row.split);
    const partition = rows.get(row.candidateId)![row.split];
    require(!partition.has(row.caseId), 'Duplicate selection candidate-case evaluation'); partition.set(row.caseId, row);
  }
  const ledger = new Map<string, LedgerEntry>();
  for (const entry of entries) if (evaluationIds.has(entry.id)) {
    require(!ledger.has(entry.id), 'Duplicate selection ledger identity'); ledger.set(entry.id, entry);
  }
  const observed = new Map<string, { cost: number; tokens: number }>(), receiptIds = new Set<string>();
  for (const partitions of rows.values()) for (const split of ['train', 'validation'] as const) for (const row of partitions[split].values()) {
    const entry = ledger.get(row.id);
    require(entry && entry.status === 'settled' && entry.purpose === `eval:${row.candidateId}:${row.split}:${row.caseId}`, 'Selection evaluation needs a matching settled ledger entry');
    integer(entry.reservedMicros, 'Reserved selection cost'); integer(entry.chargedMicros, 'Settled selection cost');
    require(entry.chargedMicros <= entry.reservedMicros, 'Selection charge exceeds its envelope');
    require(Array.isArray(row.usage) && Array.isArray(entry.receipts ?? []) && isDeepStrictEqual(row.usage, entry.receipts ?? []), 'Selection usage differs from ledger receipts');
    if (entry.reservedMicros > 0) require(row.usage.length > 0, 'Paid selection invocation requires receipts');
    let tokens = 0, extras = 0;
    for (const receipt of row.usage) {
      tokens += receiptTokens(receipt); integer(tokens, 'Selection invocation tokens');
      const key = JSON.stringify([receipt.provider, receipt.id]); require(!receiptIds.has(key), 'Selection receipt reused across evaluations'); receiptIds.add(key);
      extras += Math.ceil((receipt.extraCostUSD ?? 0) * 1e6); integer(extras, 'Known selection non-token charges');
    }
    require(entry.chargedMicros >= extras, 'Selection ledger omits known non-token charges');
    if (entry.reservedMicros === 0) require(tokens === 0 && extras === 0, 'Free selection invocation reported paid usage');
    observed.set(row.id, { cost: entry.chargedMicros, tokens });
  }
  const baseline = rows.get(baselineId)!;
  require(baseline.train.size > 0 && baseline.validation.size > 0, 'Selection requires complete nonempty baseline train and validation partitions');
  const result: CandidateSummary[] = [];
  for (const candidate of candidates) {
    const partitions = rows.get(candidate.id)!;
    for (const split of ['train', 'validation'] as const) require([...partitions[split].keys()].every(id => baseline[split].has(id)), 'Selection candidate has cases outside the baseline roster');
    if (partitions.train.size !== baseline.train.size || partitions.validation.size !== baseline.validation.size) continue;
    const rate = (split: Split) => [...partitions[split].values()].filter(row => row.passed).length / baseline[split].size;
    const trainAccuracy = rate('train'), validationAccuracy = rate('validation');
    require(candidate.trainAccuracy === undefined || candidate.trainAccuracy === trainAccuracy, 'Candidate train accuracy differs from selection evidence');
    require(candidate.validationAccuracy === undefined || candidate.validationAccuracy === validationAccuracy, 'Candidate validation accuracy differs from selection evidence');
    const validationRows = [...partitions.validation.values()];
    const validationCostMicros = validationRows.reduce((sum, row) => sum + observed.get(row.id)!.cost, 0);
    const validationTokens = validationRows.reduce((sum, row) => sum + observed.get(row.id)!.tokens, 0);
    integer(validationCostMicros, 'Candidate validation cost'); integer(validationTokens, 'Candidate validation tokens');
    result.push({ id: candidate.id, trainAccuracy, validationAccuracy, validationCostMicros, validationTokens,
      validationRegressions: validationRows.filter(row => baseline.validation.get(row.caseId)!.passed && !row.passed).length });
  }
  return result;
}

function summary(value: CandidateSummary): void {
  require(object(value), 'Malformed candidate summary'); text(value.id, 'Candidate summary id');
  accuracy(value.trainAccuracy, 'Candidate train accuracy'); accuracy(value.validationAccuracy, 'Candidate validation accuracy');
  integer(value.validationCostMicros, 'Candidate validation cost'); integer(value.validationTokens, 'Candidate validation tokens'); integer(value.validationRegressions, 'Candidate validation regressions');
}
function eligible(policy: SelectionPolicy, candidate: CandidateSummary, baseline: CandidateSummary): boolean {
  return policy.kind === 'accuracy' || candidate.id === baseline.id || candidate.validationAccuracy >= Math.max(policy.minValidationAccuracy, baseline.validationAccuracy)
    && candidate.validationRegressions <= policy.maxRegressions;
}

/** Shared adoption/promotion rule, with quality constraints enforced before resource ranking. */
export function isSelectionImprovement(policy: SelectionPolicy, candidate: CandidateSummary, incumbent: CandidateSummary, baseline: CandidateSummary): boolean {
  const selectedPolicy = normalizeSelectionPolicy(policy); summary(candidate); summary(incumbent); summary(baseline);
  if (candidate.id === incumbent.id || !eligible(selectedPolicy, candidate, baseline)) return false;
  if (selectedPolicy.kind === 'quality-constrained-resource' && selectedPolicy.ranking === 'resource-first') {
    return selectedPolicy.metric === 'usd' ? candidate.validationCostMicros < incumbent.validationCostMicros : candidate.validationTokens < incumbent.validationTokens;
  }
  if (candidate.validationAccuracy < incumbent.validationAccuracy) return false;
  if (candidate.validationAccuracy > incumbent.validationAccuracy) return true;
  if (selectedPolicy.kind === 'accuracy') return false;
  return selectedPolicy.metric === 'usd' ? candidate.validationCostMicros < incumbent.validationCostMicros : candidate.validationTokens < incumbent.validationTokens;
}

/** Stable ties preserve the incumbent. Baseline remains the fallback when the quality floor is unmet. */
export function chooseCandidate(policy: SelectionPolicy, summaries: readonly CandidateSummary[], incumbentId: string, baselineId: string): string {
  const selectedPolicy = normalizeSelectionPolicy(policy);
  require(Array.isArray(summaries) && summaries.length > 0, 'Selection needs complete candidate summaries');
  const ids = new Set<string>();
  for (const candidate of summaries) { summary(candidate); require(!ids.has(candidate.id), 'Duplicate candidate summary'); ids.add(candidate.id); }
  const baseline = summaries.find(candidate => candidate.id === baselineId), incumbent = summaries.find(candidate => candidate.id === incumbentId);
  require(baseline && incumbent, 'Selection baseline or incumbent is missing');
  require(eligible(selectedPolicy, incumbent, baseline), 'Incumbent violates selection policy');
  let best = incumbent;
  for (const candidate of summaries) if (isSelectionImprovement(selectedPolicy, candidate, best, baseline)) best = candidate;
  return best.id;
}
