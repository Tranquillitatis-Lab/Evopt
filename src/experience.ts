import type { Candidate, ComponentTarget, LedgerEntry, MutableComponent, UsageReceipt } from './types.js';
import { assert, canonical, clone, freeze, integer, micros, record, text } from './validation.js';

export interface ExperienceSettings { maxObservations?: number; maxRejections?: number; maxCharacters?: number }
export interface NormalizedExperienceSettings { maxObservations: number; maxRejections: number; maxCharacters: number }
export interface CandidateLineage {
  parentId: string; attempt: number; operator: 'proposer-text-patch'; changedKeys: string[]; proposalId: string;
}
export interface ExperienceEvaluation {
  id: string; candidateId: string; caseId: string; split: 'train' | 'validation' | 'test'; passed: boolean; usage: UsageReceipt[];
}
export interface ExperienceHistory {
  attempt: number; status: string; candidateId?: string; reason?: string;
  parentId?: string; proposalId?: string; changedKeys?: string[]; operator?: 'proposer-text-patch';
}
export interface TrainingObservation {
  candidateId: string; caseId: string; passed: boolean; baselinePassed: boolean;
  settledCostMicros: number; baselineCostMicros: number; totalTokens: number; baselineTokens: number;
  /** Edits relative to the original baseline, restricted to the declared mutable text. */
  changedKeys: string[];
  edits: { key: string; before: string; after: string; kind?: 'prompt' | 'tool-description'; target?: ComponentTarget }[];
  /** When present, lineage describes edits relative to the immediate parent. */
  lineage?: CandidateLineage;
}
export interface TrainingExperience {
  version: 1; scope: 'train'; baselineId: string; incumbentId: string;
  observations: TrainingObservation[]; rejections: { attempt: number; reason: string }[];
  omitted: { observations: number; rejections: number }; settings: NormalizedExperienceSettings;
}
export interface TrainingExperienceInput {
  candidates: readonly Candidate[]; evaluations: readonly ExperienceEvaluation[]; entries: readonly LedgerEntry[];
  history: readonly ExperienceHistory[]; baselineId: string; incumbentId: string;
  mutable: Readonly<Record<string, MutableComponent>>; settings?: ExperienceSettings;
}

export function normalizeExperienceSettings(settings: ExperienceSettings = {}): NormalizedExperienceSettings {
  assert(record(settings), 'Invalid experience settings');
  assert(Reflect.ownKeys(settings).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(settings, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(settings, key)!, 'value')), 'Experience settings must be plain JSON data');
  assert(Object.keys(settings).every(key => ['maxObservations', 'maxRejections', 'maxCharacters'].includes(key)), 'Unknown experience setting');
  const bounded = (key: keyof ExperienceSettings, fallback: number, lower: number, upper: number): number => {
    const value = settings[key] === undefined ? fallback : settings[key];
    integer(value, lower); assert(value <= upper, `Experience ${key} exceeds its limit`); return value;
  };
  const normalized = { maxObservations: bounded('maxObservations', 12, 0, 100), maxRejections: bounded('maxRejections', 5, 0, 25),
    maxCharacters: bounded('maxCharacters', 16000, 512, 128000) };
  return freeze(normalized);
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function totalTokens(receipts: UsageReceipt[], free: boolean): { tokens: number; extras: number } {
  let tokens = 0, extras = 0; const identities = new Set<string>();
  for (const receipt of receipts) {
    assert(record(receipt), 'Invalid experience usage receipt'); text(receipt.id); text(receipt.provider); text(receipt.model);
    const identity = canonical([receipt.provider, receipt.id]); assert(!identities.has(identity), 'Duplicate experience receipt'); identities.add(identity);
    integer(receipt.inputTokens); integer(receipt.outputTokens); integer(receipt.cachedInputTokens);
    assert(receipt.cachedInputTokens <= receipt.inputTokens, 'Cache tokens must be an input subset');
    if (receipt.reasoningTokens !== undefined) { integer(receipt.reasoningTokens); assert(receipt.reasoningTokens <= receipt.outputTokens, 'Reasoning tokens must be an output subset'); }
    const extra = micros(receipt.extraCostUSD ?? 0); extras += extra; integer(extras);
    tokens += receipt.inputTokens + receipt.outputTokens; integer(tokens);
    if (free) assert(tokens === 0 && extras === 0, 'Free experience entry contains paid usage');
  }
  return { tokens, extras };
}

/** A deterministic, detached projection. Outputs, labels, traces and non-training evaluations are never inspected. */
export function buildTrainingExperience(input: TrainingExperienceInput): TrainingExperience {
  assert(record(input), 'Invalid training experience input');
  const settings = normalizeExperienceSettings(input.settings); text(input.baselineId); text(input.incumbentId);
  assert(Array.isArray(input.candidates) && Array.isArray(input.evaluations) && Array.isArray(input.entries) && Array.isArray(input.history), 'Missing training experience records');
  const candidateRows: readonly Candidate[] = input.candidates, historyRows: readonly ExperienceHistory[] = input.history;
  const ledgerRows: readonly LedgerEntry[] = input.entries, evaluationRows: readonly ExperienceEvaluation[] = input.evaluations;
  assert(record(input.mutable), 'Missing mutable text permissions');
  const keys = Object.keys(input.mutable).sort(), candidates = new Map<string, Candidate>();
  for (const key of keys) {
    const rule = input.mutable[key]!; assert(record(rule), 'Invalid mutable text permission'); text(rule.role); integer(rule.maxLength, 1);
    assert(rule.kind === undefined || rule.kind === 'prompt' || rule.kind === 'tool-description', 'Invalid mutable text kind');
    if (rule.target !== undefined) {
      assert(record(rule.target) && (rule.target.type === 'node' || rule.target.type === 'tool'), 'Invalid mutable text target'); text(rule.target.id);
    }
  }
  for (const candidate of candidateRows) {
    assert(record(candidate) && record(candidate.components), 'Invalid experience candidate'); text(candidate.id);
    assert(!candidates.has(candidate.id), 'Duplicate experience candidate'); candidates.set(candidate.id, candidate);
    for (const key of keys) assert(Object.hasOwn(candidate.components, key) && typeof candidate.components[key] === 'string'
      && candidate.components[key]!.length <= input.mutable[key]!.maxLength, 'Missing or oversized mutable candidate text');
  }
  const baseline = candidates.get(input.baselineId);
  assert(baseline && candidates.has(input.incumbentId), 'Missing baseline or incumbent candidate');
  const changed = (candidate: Candidate, parent: Candidate): string[] => keys.filter(key => candidate.components[key] !== parent.components[key]);
  const lineages = new Map<string, CandidateLineage>();
  function addLineage(candidate: Candidate, value: CandidateLineage) {
    assert(record(value), 'Invalid candidate lineage'); text(value.parentId); text(value.proposalId); integer(value.attempt, 1);
    const parent = candidates.get(value.parentId);
    assert(parent && parent.id !== candidate.id && value.operator === 'proposer-text-patch', 'Invalid candidate lineage parent or operator');
    assert(Array.isArray(value.changedKeys) && value.changedKeys.every(key => typeof key === 'string' && Object.hasOwn(input.mutable, key)), 'Invalid lineage changed keys');
    const expected = changed(candidate, parent);
    assert(expected.length > 0 && canonical([...value.changedKeys].sort()) === canonical(expected), 'Lineage changed keys disagree with candidate text');
    const lineage: CandidateLineage = { parentId: value.parentId, proposalId: value.proposalId, attempt: value.attempt,
      operator: value.operator, changedKeys: expected };
    const prior = lineages.get(candidate.id);
    assert(!prior || canonical(prior) === canonical(lineage), 'Conflicting candidate lineage'); lineages.set(candidate.id, lineage);
  }
  for (const candidate of candidates.values()) {
    const lineage = (candidate as Candidate & { lineage?: CandidateLineage }).lineage;
    if (lineage !== undefined) addLineage(candidate, lineage);
  }
  const rejections: TrainingExperience['rejections'] = [];
  for (const item of historyRows) {
    assert(record(item), 'Invalid experience history');
    if (item.status === 'rejected') { integer(item.attempt, 1); text(item.reason); rejections.push({ attempt: item.attempt, reason: item.reason }); }
    if (item.status === 'evaluated' && item.parentId !== undefined) {
      const candidate = candidates.get(item.candidateId ?? ''); assert(candidate, 'Lineage references an unknown candidate');
      addLineage(candidate, item as CandidateLineage);
    }
  }
  rejections.sort((a, b) => b.attempt - a.attempt || compareText(a.reason, b.reason));
  const ledger = new Map<string, LedgerEntry>();
  for (const entry of ledgerRows) {
    assert(record(entry), 'Invalid experience ledger entry'); text(entry.id);
    assert(!ledger.has(entry.id), 'Duplicate experience ledger entry'); ledger.set(entry.id, entry);
  }
  const evaluations = new Map<string, { evaluation: ExperienceEvaluation; cost: number; tokens: number }>();
  const evaluationIds = new Set<string>(), receiptIds = new Set<string>();
  for (const evaluation of evaluationRows) {
    assert(record(evaluation), 'Invalid experience evaluation');
    if (evaluation.split !== 'train') continue;
    text(evaluation.id); text(evaluation.caseId);
    assert(candidates.has(evaluation.candidateId) && typeof evaluation.passed === 'boolean', 'Invalid training evaluation');
    assert(!evaluationIds.has(evaluation.id), 'Duplicate training evaluation'); evaluationIds.add(evaluation.id);
    const key = canonical([evaluation.candidateId, evaluation.caseId]); assert(!evaluations.has(key), 'Duplicate candidate training case');
    const entry = ledger.get(evaluation.id);
    assert(entry && entry.status === 'settled' && entry.purpose === `eval:${evaluation.candidateId}:train:${evaluation.caseId}`, 'Training evaluation requires a matching settled ledger entry');
    integer(entry.reservedMicros); integer(entry.chargedMicros);
    assert(entry.chargedMicros <= entry.reservedMicros, 'Training charge exceeds its envelope');
    assert(Array.isArray(evaluation.usage) && canonical(evaluation.usage) === canonical(entry.receipts ?? []), 'Training usage disagrees with ledger receipts');
    if (entry.reservedMicros > 0) assert(evaluation.usage.length > 0, 'Paid training requires normalized receipts');
    const { tokens, extras } = totalTokens(evaluation.usage, entry.reservedMicros === 0);
    assert(entry.chargedMicros >= extras, 'Training charge omits known non-token charges');
    for (const receipt of evaluation.usage) {
      const identity = canonical([receipt.provider, receipt.id]); assert(!receiptIds.has(identity), 'Receipt reused across training evaluations'); receiptIds.add(identity);
    }
    evaluations.set(key, { evaluation, cost: entry.chargedMicros, tokens });
  }
  const observations: TrainingObservation[] = [];
  for (const row of evaluations.values()) {
    const evaluation = row.evaluation, parent = evaluations.get(canonical([input.baselineId, evaluation.caseId]));
    assert(parent, 'Training observation requires its baseline case');
    const candidate = candidates.get(evaluation.candidateId)!, changedKeys = changed(candidate, baseline);
    const edits = changedKeys.map(key => {
      const rule = input.mutable[key]!;
      return { key, before: baseline.components[key]!, after: candidate.components[key]!,
        ...(rule.kind === undefined ? {} : { kind: rule.kind }),
        ...(rule.target === undefined ? {} : { target: { type: rule.target.type, id: rule.target.id } }) };
    });
    const lineage = lineages.get(candidate.id);
    observations.push({ candidateId: candidate.id, caseId: evaluation.caseId, passed: evaluation.passed, baselinePassed: parent.evaluation.passed,
      settledCostMicros: row.cost, baselineCostMicros: parent.cost, totalTokens: row.tokens, baselineTokens: parent.tokens, changedKeys, edits,
      ...(lineage ? { lineage } : {}) });
  }
  const priority = (row: TrainingObservation): number => row.baselinePassed && !row.passed ? 0
    : row.passed && (row.settledCostMicros !== row.baselineCostMicros || row.totalTokens !== row.baselineTokens) ? 1 : row.passed ? 2 : 3;
  observations.sort((a, b) => priority(a) - priority(b)
    || Math.abs(b.settledCostMicros - b.baselineCostMicros) - Math.abs(a.settledCostMicros - a.baselineCostMicros)
    || Math.max(b.settledCostMicros, b.baselineCostMicros) - Math.max(a.settledCostMicros, a.baselineCostMicros)
    || Math.abs(b.totalTokens - b.baselineTokens) - Math.abs(a.totalTokens - a.baselineTokens)
    || Math.max(b.totalTokens, b.baselineTokens) - Math.max(a.totalTokens, a.baselineTokens)
    || compareText(a.caseId, b.caseId) || compareText(a.candidateId, b.candidateId));
  const result: TrainingExperience = { version: 1, scope: 'train', baselineId: input.baselineId, incumbentId: input.incumbentId,
    observations: [], rejections: [], omitted: { observations: observations.length, rejections: rejections.length }, settings };
  assert(canonical(result).length <= settings.maxCharacters, 'Experience metadata exceeds character limit');
  // Interleave the latest rejection after the first observation; skip oversized whole entries so smaller evidence can still fit.
  const queue = [
    ...observations.slice(0, 1).map(value => ({ kind: 'observations' as const, value })),
    ...rejections.slice(0, 1).map(value => ({ kind: 'rejections' as const, value })),
    ...observations.slice(1).map(value => ({ kind: 'observations' as const, value })),
    ...rejections.slice(1).map(value => ({ kind: 'rejections' as const, value })),
  ];
  for (const item of queue) {
    if (item.kind === 'observations') {
      if (result.observations.length >= settings.maxObservations) continue;
      result.observations.push(item.value); result.omitted.observations--;
      if (canonical(result).length > settings.maxCharacters) { result.observations.pop(); result.omitted.observations++; }
    } else {
      if (result.rejections.length >= settings.maxRejections) continue;
      result.rejections.push(item.value); result.omitted.rejections--;
      if (canonical(result).length > settings.maxCharacters) { result.rejections.pop(); result.omitted.rejections++; }
    }
  }
  return freeze(clone(result));
}
