import type { Candidate, Components, LedgerEntry, OptimizationResult, UsageReceipt } from './types.js';
import { assert, canonical, clone, hash, integer, micros, record, text, validateBenchmarkProvenance } from './validation.js';
import { analyzeEvidence, type ReviewEvidence } from './evidence.js';
import { createConfigurationPatch, type ConfigurationPatch } from './patch.js';
import { validateStructure } from './structure.js';

export interface SubmissionMetadata { id: string; summary: string; reviewed: boolean }
export interface SubmissionEvaluation {
  id: string; candidateId: string; caseId: string; split: 'train' | 'validation' | 'test';
  passed: boolean; outputHash: string; usage: UsageReceipt[];
}
/** Portable evidence, not an authenticated provider invoice or automatic approval. */
export interface Submission {
  version: 1; metadata: SubmissionMetadata; digest: string;
  baselineId: string; selectedId: string; components: Components;
  changes: OptimizationResult<unknown>['changes']; candidates: Candidate[];
  history: OptimizationResult<unknown>['history']; evaluations: SubmissionEvaluation[];
  test: NonNullable<OptimizationResult<unknown>['test']>;
  accounting: OptimizationResult<unknown>['accounting']; provenance: OptimizationResult<unknown>['provenance'];
  configuration?: OptimizationResult<unknown>['configuration'];
  patch?: ConfigurationPatch; review?: ReviewEvidence;
}
export interface SubmissionValidation {
  id: string; digest: string; synthetic: boolean; eligibleForPromotion: boolean;
  baselineValidationAccuracy: number; candidateValidationAccuracy: number;
  baselineTestAccuracy: number; candidateTestAccuracy: number;
  evaluationCount: number; spentMicros: number; limitations: string[];
  review: ReviewEvidence;
}

function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  assert(record(value), 'Expected an evidence object');
  assert(required.every(k => Object.hasOwn(value, k)), 'Evidence field missing');
  assert(Object.keys(value).every(k => required.includes(k) || optional.includes(k)), 'Unexpected evidence field; remove raw or unreviewed data');
}
function digest(value: Submission): string {
  const { digest: _digest, metadata, ...payload } = value;
  // Contributors can affirm review after examining an already-created artifact.
  return hash({ ...payload, metadata: { id: metadata.id, summary: metadata.summary } });
}
function checkedHash(value: unknown): asserts value is string { assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid evidence hash'); }
function score(value: unknown): asserts value is number { assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'Invalid accuracy'); }
function components(value: unknown): asserts value is Components {
  assert(record(value) && Object.keys(value).length > 0, 'Missing component text');
  for (const [k, v] of Object.entries(value)) { text(k); assert(typeof v === 'string', 'Component must be text'); assert(!['__proto__', 'constructor', 'prototype'].includes(k), 'Unsafe component key'); }
}
function receipt(value: unknown): asserts value is UsageReceipt {
  keys(value, ['id', 'provider', 'model', 'inputTokens', 'outputTokens', 'cachedInputTokens'], ['reasoningTokens', 'extraCostUSD']);
  text(value.id); text(value.provider); text(value.model);
  integer(value.inputTokens); integer(value.outputTokens); integer(value.cachedInputTokens);
  assert(value.cachedInputTokens <= value.inputTokens, 'Invalid cache token subset');
  if (value.reasoningTokens !== undefined) { integer(value.reasoningTokens); assert(value.reasoningTokens <= value.outputTokens, 'Invalid reasoning token subset'); }
  if (value.extraCostUSD !== undefined) micros(value.extraCostUSD as number);
}
function cleanReceipt(r: UsageReceipt): UsageReceipt {
  return { id: r.id, provider: r.provider, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedInputTokens: r.cachedInputTokens,
    ...(r.reasoningTokens === undefined ? {} : { reasoningTokens: r.reasoningTokens }), ...(r.extraCostUSD === undefined ? {} : { extraCostUSD: r.extraCostUSD }) };
}

/** Call only after manually reviewing candidate text and identifiers for sharing. */
export function buildSubmission(result: OptimizationResult<unknown>, metadata: SubmissionMetadata): Submission {
  assert(result.status === 'completed' && result.test, 'Only completed held-out runs can be packaged');
  assert(result.candidates.length > 0, 'Missing baseline');
  const p = result.provenance;
  const submission: Submission = {
    version: 1, metadata: { id: metadata.id, summary: metadata.summary, reviewed: metadata.reviewed }, digest: '',
    baselineId: result.candidates[0]!.id, selectedId: result.selectedId, components: clone(result.components), changes: clone(result.changes),
    candidates: result.candidates.map(c => ({ id: c.id, components: clone(c.components), trainAccuracy: c.trainAccuracy!, validationAccuracy: c.validationAccuracy! })),
    history: result.history.map(h => ({ attempt: h.attempt, status: h.status, ...(h.candidateId === undefined ? {} : { candidateId: h.candidateId }), ...(h.reason === undefined ? {} : { reason: h.reason }) })),
    evaluations: result.evaluations.map(e => ({ id: e.id, candidateId: e.candidateId, caseId: e.caseId, split: e.split, passed: e.passed, outputHash: hash(e.output), usage: e.usage.map(cleanReceipt) })),
    test: { kind: result.test.kind, baselineAccuracy: result.test.baselineAccuracy, candidateAccuracy: result.test.candidateAccuracy },
    accounting: { currency: result.accounting.currency, limitMicros: result.accounting.limitMicros, occupiedMicros: result.accounting.occupiedMicros,
      entries: result.accounting.entries.map(e => ({ id: e.id, purpose: e.purpose, reservedMicros: e.reservedMicros, status: e.status,
        ...(e.chargedMicros === undefined ? {} : { chargedMicros: e.chargedMicros }), receipts: (e.receipts ?? []).map(cleanReceipt) })) },
    provenance: { agentId: p.agentId, agentVersion: p.agentVersion, datasetId: p.datasetId, datasetVersion: p.datasetVersion, fingerprint: p.fingerprint, synthetic: p.synthetic, ...(p.benchmark ? { benchmark: clone(p.benchmark) } : {}) },
    review: analyzeEvidence(result),
    ...(result.configuration ? { configuration: clone(result.configuration), patch: createConfigurationPatch(result) } : {}),
  };
  submission.digest = digest(submission); validateSubmission(submission); return clone(submission);
}

/** Reject inconsistent or over-budget evidence; assess promotion eligibility separately. */
export function validateSubmission(value: unknown): SubmissionValidation {
  keys(value, ['version', 'metadata', 'digest', 'baselineId', 'selectedId', 'components', 'changes', 'candidates', 'history', 'evaluations', 'test', 'accounting', 'provenance'], ['configuration','patch','review']);
  assert(value.version === 1, 'Unsupported submission version');
  const s = value as unknown as Submission;
  keys(s.metadata, ['id', 'summary', 'reviewed']);
  assert(typeof s.metadata.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(s.metadata.id), 'Invalid submission id');
  text(s.metadata.summary); assert(s.metadata.reviewed === true, 'Submission requires explicit sharing review');
  checkedHash(s.digest); assert(s.digest === digest(s), 'Submission digest mismatch');
  keys(s.provenance, ['agentId', 'agentVersion', 'datasetId', 'datasetVersion', 'fingerprint', 'synthetic'], ['benchmark']);
  if (s.provenance.benchmark !== undefined) validateBenchmarkProvenance(s.provenance.benchmark);
  text(s.provenance.agentId); text(s.provenance.agentVersion); text(s.provenance.datasetId); text(s.provenance.datasetVersion);
  checkedHash(s.provenance.fingerprint); assert(typeof s.provenance.synthetic === 'boolean', 'Missing synthetic evidence label');
  assert(Array.isArray(s.candidates) && s.candidates.length > 0, 'Missing candidates');
  const candidates = new Map<string, Candidate>();
  for (const c of s.candidates) {
    keys(c, ['id', 'components', 'trainAccuracy', 'validationAccuracy']); components(c.components); checkedHash(c.id);
    assert(c.id === hash(c.components) && !candidates.has(c.id), 'Invalid or duplicate candidate identity');
    score(c.trainAccuracy); score(c.validationAccuracy); candidates.set(c.id, c);
  }
  const baseline = candidates.get(s.baselineId), winner = candidates.get(s.selectedId);
  assert(baseline && winner && s.baselineId === s.candidates[0]!.id, 'Missing baseline or selected candidate');
  if (s.configuration !== undefined) {
    keys(s.configuration, ['mutable'], ['structure']);
    validateStructure({ components: baseline.components, ...s.configuration });
    for (const c of s.candidates) for (const key of Object.keys(c.components)) if (c.components[key] !== baseline.components[key]) {
      const spec = s.configuration.mutable[key];
      assert(spec && c.components[key]!.length <= spec.maxLength, 'Candidate violates its exported mutable contract');
    }
    assert(s.patch && canonical(s.patch) === canonical(createConfigurationPatch(s)), 'Exported patch differs from candidate/configuration evidence');
  } else assert(s.patch === undefined, 'Patch requires its original configuration contract');
  for (const c of s.candidates) assert(canonical(Object.keys(c.components).sort()) === canonical(Object.keys(baseline.components).sort()), 'Candidate component keys differ from baseline');
  components(s.components); assert(canonical(s.components) === canonical(winner.components), 'Selected components disagree');
  const changes = Object.fromEntries(Object.keys(baseline.components).filter(k => baseline.components[k] !== winner.components[k]).map(k => [k, { before: baseline.components[k], after: winner.components[k] }]));
  assert(canonical(changes) === canonical(s.changes), 'Changes disagree with baseline and selected candidate');
  assert(Array.isArray(s.history), 'Missing candidate history');
  const historicalCandidates = new Set<string>();
  for (const [i, h] of s.history.entries()) {
    keys(h, ['attempt', 'status'], ['candidateId', 'reason']); assert(h.attempt === i + 1, 'Proposal history must be contiguous');
    assert(h.status === 'evaluated' || h.status === 'rejected', 'Invalid proposal status');
    if (h.reason !== undefined) text(h.reason);
    if (h.status === 'evaluated') {
      assert(typeof h.candidateId === 'string' && candidates.has(h.candidateId) && h.candidateId !== baseline.id && !historicalCandidates.has(h.candidateId), 'History candidate mismatch'); historicalCandidates.add(h.candidateId);
    } else assert(h.candidateId === undefined, 'Rejected proposal cannot be a selected candidate');
  }
  assert(historicalCandidates.size === candidates.size - 1, 'Candidate history is incomplete');
  keys(s.accounting, ['currency', 'limitMicros', 'occupiedMicros', 'entries']);
  assert(s.accounting.currency === 'USD', 'Unsupported accounting currency'); integer(s.accounting.limitMicros, 1); integer(s.accounting.occupiedMicros);
  assert(Array.isArray(s.accounting.entries), 'Missing accounting ledger');
  const entries = new Map<string, LedgerEntry>(), receipts = new Set<string>(); let total = 0;
  for (const e of s.accounting.entries) {
    keys(e, ['id', 'purpose', 'reservedMicros', 'chargedMicros', 'status', 'receipts']); text(e.id); text(e.purpose);
    assert(!entries.has(e.id), 'Duplicate invocation identity'); entries.set(e.id, e);
    assert(e.status === 'settled', 'Unresolved or violated billing cannot be submitted'); integer(e.reservedMicros); integer(e.chargedMicros);
    assert(e.chargedMicros! <= e.reservedMicros, 'Charge exceeds reserved envelope');
    total += e.chargedMicros!; integer(total);
    assert(Array.isArray(e.receipts), 'Missing receipt collection');
    for (const r of e.receipts) { receipt(r); const id = canonical([r.provider, r.id]); assert(!receipts.has(id), 'Receipt reused across invocations'); receipts.add(id); }
    if (e.reservedMicros > 0) assert(e.receipts.length > 0, 'Paid invocation has no receipts');
    else assert(e.receipts.every(r => r.inputTokens === 0 && r.outputTokens === 0 && (r.extraCostUSD ?? 0) === 0), 'Free invocation contains paid usage');
    const knownExtras = e.receipts.reduce((sum, r) => sum + micros(r.extraCostUSD ?? 0), 0);
    integer(knownExtras); assert(e.chargedMicros! >= knownExtras, 'Known non-token charges are missing from ledger');
    if (s.provenance.synthetic) assert(e.reservedMicros === 0 && e.chargedMicros === 0, 'Synthetic label contradicts paid invocation evidence');
  }
  assert(total === s.accounting.occupiedMicros && total <= s.accounting.limitMicros, 'Budget evidence does not reconcile');
  assert(Array.isArray(s.evaluations) && s.evaluations.length > 0, 'Missing evaluation evidence');
  const evalIds = new Set<string>(), identities = new Set<string>(), caseSplits = new Map<string, string>();
  for (const e of s.evaluations) {
    keys(e, ['id', 'candidateId', 'caseId', 'split', 'passed', 'outputHash', 'usage']); text(e.id); text(e.caseId); checkedHash(e.outputHash);
    assert(candidates.has(e.candidateId) && ['train', 'validation', 'test'].includes(e.split) && typeof e.passed === 'boolean', 'Malformed evaluation');
    assert(!evalIds.has(e.id), 'Duplicate evaluation identity'); evalIds.add(e.id);
    const identity = canonical([e.candidateId, e.caseId, e.split]); assert(!identities.has(identity), 'Duplicate candidate case evaluation'); identities.add(identity);
    assert(!caseSplits.has(e.caseId) || caseSplits.get(e.caseId) === e.split, 'Case reused across partitions'); caseSplits.set(e.caseId, e.split);
    assert(e.split !== 'test' || e.candidateId === baseline.id || e.candidateId === winner.id, 'Test data evaluated an unselected candidate');
    assert(Array.isArray(e.usage), 'Missing evaluation usage'); e.usage.forEach(receipt);
    const entry = entries.get(e.id); assert(entry && entry.purpose === `eval:${e.candidateId}:${e.split}:${e.caseId}` && canonical(e.usage) === canonical(entry.receipts), 'Evaluation receipts do not match ledger');
  }
  for (const e of entries.values()) assert(e.purpose === 'proposal' || evalIds.has(e.id) || (e.chargedMicros === 0 && e.receipts!.length === 0 && e.purpose.startsWith('eval:')), 'Unmatched paid evaluation ledger entry');
  assert(s.accounting.entries.filter(e => e.purpose === 'proposal').length >= s.history.length, 'Proposal accounting is incomplete');
  const rows = (id: string, split: string) => s.evaluations.filter(e => e.candidateId === id && e.split === split);
  const ids = (id: string, split: string) => rows(id, split).map(e => e.caseId).sort();
  const accuracy = (id: string, split: string) => { const r = rows(id, split); assert(r.length > 0, 'Evaluation partition missing'); return r.filter(e => e.passed).length / r.length; };
  for (const c of s.candidates) for (const split of ['train', 'validation'] as const) {
    assert(canonical(ids(c.id, split)) === canonical(ids(baseline.id, split)), 'Candidate partition coverage differs');
    assert(c[split === 'train' ? 'trainAccuracy' : 'validationAccuracy'] === accuracy(c.id, split), 'Candidate accuracy disagrees with per-case evidence');
  }
  assert(winner.validationAccuracy! >= baseline.validationAccuracy!, 'Selected candidate degraded validation');
  keys(s.test, ['kind', 'baselineAccuracy', 'candidateAccuracy']);
  assert(s.test.kind === (baseline.id === winner.id ? 'identity-control' : 'paired'), 'Incorrect comparison kind');
  assert(canonical(ids(baseline.id, 'test')) === canonical(ids(winner.id, 'test')), 'Test arms are not paired');
  const baselineTestAccuracy = accuracy(baseline.id, 'test'), candidateTestAccuracy = accuracy(winner.id, 'test');
  assert(s.test.baselineAccuracy === baselineTestAccuracy && s.test.candidateAccuracy === candidateTestAccuracy, 'Test summary disagrees with evidence');
  const baselineTest = rows(baseline.id, 'test'), winnerTest = rows(winner.id, 'test');
  const noRegressions = baselineTest.every(b => !b.passed || winnerTest.find(w => w.caseId === b.caseId)!.passed);
  const review = analyzeEvidence({ ...s, status: 'completed' });
  if (s.review !== undefined) assert(canonical(s.review) === canonical(review), 'Review statistics differ from per-case/ledger evidence');
  const observedPaidTarget = [...baselineTest, ...winnerTest].every(e => e.usage.some(r => r.inputTokens + r.outputTokens > 0 || (r.extraCostUSD ?? 0) > 0));
  const eligibleForPromotion = !s.provenance.synthetic && observedPaidTarget && baseline.id !== winner.id && winner.validationAccuracy! > baseline.validationAccuracy! && candidateTestAccuracy >= baselineTestAccuracy && noRegressions;
  const limitations = ['Integrity checks do not authenticate results or provider invoices; maintainers must reproduce the experiment.', 'Tariff enforcement requires the pinned experiment configuration.', 'Promotion eligibility checks accounting and regression rules; it is not a statistical significance claim.', ...review.limitations];
  if (s.provenance.synthetic || !observedPaidTarget) limitations.push('Synthetic or unmetered target evidence cannot establish a real-agent improvement.');
  if (!noRegressions) limitations.push('The candidate regressed on at least one baseline-passing test case.');
  return { id: s.metadata.id, digest: s.digest, synthetic: s.provenance.synthetic, eligibleForPromotion,
    baselineValidationAccuracy: baseline.validationAccuracy!, candidateValidationAccuracy: winner.validationAccuracy!, baselineTestAccuracy, candidateTestAccuracy,
    evaluationCount: s.evaluations.length, spentMicros: total, limitations, review };
}
