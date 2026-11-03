import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrainingExperience, normalizeExperienceSettings, type CandidateLineage, type TrainingExperienceInput } from '../src/experience.js';
import type { UsageReceipt } from '../src/types.js';
import { canonical } from '../src/validation.js';

function fixture(): TrainingExperienceInput {
  const lineage: CandidateLineage = { parentId: 'baseline', attempt: 1, operator: 'proposer-text-patch', changedKeys: ['system'], proposalId: 'proposal-1' };
  const input: TrainingExperienceInput = {
    candidates: [
      { id: 'baseline', components: { system: 'Be clear.', lookup: 'Find records.', immutable: 'IMMUTABLE_PRIVATE_INSTRUCTIONS' } },
      { id: 'candidate', components: { system: 'Check facts, then answer.', lookup: 'Find records.', immutable: 'IMMUTABLE_PRIVATE_INSTRUCTIONS' } },
    ],
    baselineId: 'baseline', incumbentId: 'candidate',
    mutable: { system: { role: 'System instructions', maxLength: 10000, kind: 'prompt', target: { type: 'node', id: 'worker' } },
      lookup: { role: 'Lookup capability', maxLength: 10000, kind: 'tool-description', target: { type: 'tool', id: 'lookup' } } },
    evaluations: [], entries: [], history: [{ status: 'evaluated', candidateId: 'candidate', ...lineage }],
  };
  const add = (candidateId: string, caseId: string, passed: boolean, cost: number, tokens: number) => {
    const id = `${candidateId}-${caseId}`;
    const usage: UsageReceipt[] = [{ id: `receipt-${id}`, provider: 'fixture', model: 'fixture', inputTokens: tokens - 10,
      outputTokens: 10, cachedInputTokens: tokens - 10, reasoningTokens: 4, extraCostUSD: 0.00001 }];
    (input.evaluations as Array<TrainingExperienceInput['evaluations'][number]>).push({ id, candidateId, caseId, split: 'train', passed, usage });
    (input.entries as Array<TrainingExperienceInput['entries'][number]>).push({ id, purpose: `eval:${candidateId}:train:${caseId}`,
      reservedMicros: cost + 100, chargedMicros: cost, status: 'settled', receipts: structuredClone(usage) });
  };
  add('baseline', 'regression', true, 100, 100); add('candidate', 'regression', false, 80, 80);
  add('baseline', 'expensive-success', true, 500, 1000); add('candidate', 'expensive-success', true, 700, 800);
  add('baseline', 'improvement', false, 90, 70); add('candidate', 'improvement', true, 200, 60);
  return input;
}

test('experience settings are explicit, bounded and reject unknown or malformed values', () => {
  assert.deepEqual(normalizeExperienceSettings(), { maxObservations: 12, maxRejections: 5, maxCharacters: 16000 });
  assert.deepEqual(normalizeExperienceSettings({ maxObservations: 0, maxRejections: 0, maxCharacters: 512 }),
    { maxObservations: 0, maxRejections: 0, maxCharacters: 512 });
  for (const settings of [{ maxObservations: -1 }, { maxObservations: 101 }, { maxObservations: 1.5 }, { maxRejections: 26 },
    { maxCharacters: 511 }, { maxCharacters: 128001 }, { maxCharacters: Infinity }, { maxRejections: null }, { hiddenLabels: true }, null]) {
    assert.throws(() => normalizeExperienceSettings(settings as Parameters<typeof normalizeExperienceSettings>[0]));
  }
});

test('experience settings reject accessors, symbols and nonenumerable fields without invoking getters', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'maxCharacters', { enumerable: true, get() { reads++; return 16000; } });
  const symbol = { [Symbol('unknown-setting')]: true };
  const hidden = Object.defineProperty({}, 'unknown-setting', { enumerable: false, value: true });
  const hiddenKnown = Object.defineProperty({}, 'maxCharacters', { enumerable: false, value: 16000 });
  for (const settings of [accessor, symbol, hidden, hiddenKnown]) assert.throws(() => normalizeExperienceSettings(settings), /plain JSON data/);
  assert.equal(reads, 0);
});

test('training comparisons expose exact settled costs and count cached and reasoning tokens only once', () => {
  const input = fixture(), result = buildTrainingExperience(input);
  assert.equal(result.scope, 'train'); assert.equal(result.baselineId, 'baseline'); assert.equal(result.incumbentId, 'candidate');
  assert.deepEqual(result.observations.map(row => `${row.candidateId}:${row.caseId}`), [
    'candidate:regression', 'candidate:expensive-success', 'candidate:improvement',
    'baseline:expensive-success', 'baseline:regression', 'baseline:improvement',
  ]);
  const expensive = result.observations[1]!;
  assert.equal(expensive.settledCostMicros, 700); assert.equal(expensive.baselineCostMicros, 500);
  assert.equal(expensive.totalTokens, 800); assert.equal(expensive.baselineTokens, 1000);
  assert.deepEqual(expensive.changedKeys, ['system']);
  assert.deepEqual(expensive.edits, [{ key: 'system', before: 'Be clear.', after: 'Check facts, then answer.', kind: 'prompt', target: { type: 'node', id: 'worker' } }]);
  assert.deepEqual(expensive.lineage, { parentId: 'baseline', attempt: 1, operator: 'proposer-text-patch', changedKeys: ['system'], proposalId: 'proposal-1' });
  assert.equal(result.observations.reduce((sum, row) => sum + row.settledCostMicros, 0), input.entries.reduce((sum, entry) => sum + entry.chargedMicros!, 0));
  assert.deepEqual(result.omitted, { observations: 0, rejections: 0 });
});

test('first proposal receives expensive successful baseline observations without inventing independent comparisons', () => {
  const input = fixture();
  input.candidates = input.candidates.slice(0, 1); input.incumbentId = 'baseline'; input.history = [];
  input.evaluations = input.evaluations.filter(row => row.candidateId === 'baseline');
  input.entries = input.entries.filter(row => row.id.startsWith('baseline-'));
  const result = buildTrainingExperience(input);
  assert.equal(result.observations[0]!.caseId, 'expensive-success');
  for (const row of result.observations) {
    assert.equal(row.candidateId, 'baseline'); assert.equal(row.passed, row.baselinePassed);
    assert.equal(row.settledCostMicros, row.baselineCostMicros); assert.equal(row.totalTokens, row.baselineTokens);
    assert.deepEqual(row.changedKeys, []); assert.deepEqual(row.edits, []); assert.equal(row.lineage, undefined);
  }
});

test('future labels, outputs, traces, immutable text, and candidate validation scores cannot enter experience', () => {
  const input = fixture(), expected = buildTrainingExperience(input);
  const hidden = { id: 'HIDDEN_CASE_ID', candidateId: 'candidate', caseId: 'HIDDEN_CASE_ID', split: 'test' as const, passed: true,
    usage: [], output: 'HIDDEN_OUTPUT', expected: 'HIDDEN_LABEL', trace: [{ secret: 'HIDDEN_TRACE' }] };
  Object.defineProperty(hidden, 'output', { get() { throw new Error('Output must not be inspected'); }, enumerable: true });
  input.evaluations = [...input.evaluations, hidden, { id: 'HIDDEN_VALIDATION_ID', candidateId: 'candidate', caseId: 'HIDDEN_VALIDATION_CASE',
    split: 'validation', passed: false, usage: [] }];
  input.entries = [...input.entries, { id: hidden.id, purpose: 'eval:candidate:test:HIDDEN_CASE_ID', status: 'pending', reservedMicros: 999999 }];
  for (const candidate of input.candidates) Object.defineProperty(candidate, 'validationAccuracy', { get() { throw new Error('Validation score must not be inspected'); }, enumerable: true });
  for (const row of input.evaluations.filter(value => value.split === 'train')) Object.defineProperty(row, 'output', { get() { throw new Error('Training output must not be inspected'); }, enumerable: true });
  const actual = buildTrainingExperience(input);
  assert.deepEqual(actual, expected); assert.doesNotMatch(canonical(actual), /HIDDEN|IMMUTABLE_PRIVATE|validationAccuracy|trace/);
});

test('bounded output omits whole observations and reasons while conserving available counts', () => {
  const input = fixture();
  input.settings = { maxObservations: 2, maxRejections: 1, maxCharacters: 1000 };
  input.history = [...input.history, { attempt: 2, status: 'rejected', reason: 'Proposal changes immutable component' },
    { attempt: 3, status: 'rejected', reason: 'X'.repeat(20000) }];
  const result = buildTrainingExperience(input), full = buildTrainingExperience({ ...input, settings: { maxCharacters: 128000 } });
  assert.ok(canonical(result).length <= 1000); assert.ok(result.observations.length <= 2); assert.equal(result.rejections.length, 1);
  assert.deepEqual(result.rejections, [{ attempt: 2, reason: 'Proposal changes immutable component' }]);
  assert.equal(result.omitted.observations + result.observations.length, full.observations.length);
  assert.equal(result.omitted.rejections + result.rejections.length, full.rejections.length);
  for (const observation of result.observations) assert.deepEqual(observation, full.observations.find(row => row.candidateId === observation.candidateId && row.caseId === observation.caseId));
  const minimal = buildTrainingExperience({ ...input, settings: { maxCharacters: 512 } });
  assert.ok(canonical(minimal).length <= 512); assert.equal(minimal.baselineId, 'baseline');
  assert.doesNotMatch(canonical(minimal), /X{20}/);
});

test('selection is deterministic across resume serialization and record order, and detached deeply frozen', () => {
  const input = fixture(); input.history = [...input.history, { attempt: 4, status: 'rejected', reason: 'Proposal must contain text edits' },
    { attempt: 2, status: 'rejected', reason: 'Invalid or oversized component' }];
  const result = buildTrainingExperience(input), roundTrip: TrainingExperienceInput = JSON.parse(canonical(input));
  roundTrip.candidates = [...roundTrip.candidates].reverse(); roundTrip.evaluations = [...roundTrip.evaluations].reverse();
  roundTrip.entries = [...roundTrip.entries].reverse(); roundTrip.history = [...roundTrip.history].reverse();
  assert.equal(canonical(buildTrainingExperience(roundTrip)), canonical(result));
  assert.deepEqual(result.rejections.map(row => row.attempt), [4, 2]);
  Object.assign(input.mutable.system!.target!, { id: 'changed-after-building' });
  assert.equal(result.observations[0]!.edits[0]!.target!.id, 'worker');
  assert.throws(() => { result.observations[0]!.edits[0]!.after = 'mutated'; }, TypeError);
  assert.ok(Object.isFrozen(result.settings)); assert.ok(Object.isFrozen(result.observations[0]!.lineage!.changedKeys));
});

test('training accounting rejects missing, unsettled, conflicting, or reused receipt evidence', () => {
  const mutations: ((input: TrainingExperienceInput) => void)[] = [
    input => { input.entries = input.entries.slice(1); },
    input => { input.entries[0]!.status = 'pending'; },
    input => { input.entries[0]!.purpose = 'eval:baseline:validation:regression'; },
    input => { input.entries[0]!.chargedMicros = input.entries[0]!.reservedMicros + 1; },
    input => { input.entries[0]!.receipts![0]!.inputTokens++; },
    input => { input.evaluations[0]!.usage = []; input.entries[0]!.receipts = []; },
    input => { input.evaluations[0]!.usage[0]!.cachedInputTokens = 99999; input.entries[0]!.receipts = structuredClone(input.evaluations[0]!.usage); },
    input => { input.evaluations[1]!.usage[0]!.id = input.evaluations[0]!.usage[0]!.id; input.entries[1]!.receipts = structuredClone(input.evaluations[1]!.usage); },
    input => { input.evaluations = input.evaluations.slice(1); },
    input => { input.evaluations = [...input.evaluations, input.evaluations[0]!]; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => buildTrainingExperience(input)); }
});

test('candidate lineage must match the mutable parent edit and cannot smuggle immutable metadata', () => {
  const input = fixture();
  const lineage = { parentId: 'baseline', attempt: 1, operator: 'proposer-text-patch' as const, changedKeys: ['system'], proposalId: 'proposal-1', ignored: 'PRIVATE_METADATA' };
  Object.assign(input.candidates[1]!, { lineage });
  const result = buildTrainingExperience(input); assert.doesNotMatch(canonical(result), /PRIVATE_METADATA|ignored/);
  assert.deepEqual(result.observations[0]!.lineage!.changedKeys, ['system']);
  for (const replacement of [{ ...lineage, parentId: 'missing' }, { ...lineage, changedKeys: ['immutable'] },
    { ...lineage, changedKeys: ['lookup'] }, { ...lineage, changedKeys: ['system', 'system'] }, { ...lineage, attempt: 0 }]) {
    Object.assign(input.candidates[1]!, { lineage: replacement }); assert.throws(() => buildTrainingExperience(input));
  }
});

test('later generations retain immediate parent lineage and compare cumulative mutable edits against baseline', () => {
  const input = fixture();
  input.candidates = [...input.candidates, { id: 'next', components: { ...input.candidates[1]!.components, lookup: 'Find records by exact key.' } }];
  input.incumbentId = 'next';
  input.history = [...input.history, { status: 'evaluated', candidateId: 'next', parentId: 'candidate', attempt: 2,
    operator: 'proposer-text-patch', changedKeys: ['lookup'], proposalId: 'proposal-2' }];
  input.evaluations = [...input.evaluations, { id: 'next-regression', candidateId: 'next', caseId: 'regression', split: 'train', passed: true, usage: [] }];
  input.entries = [...input.entries, { id: 'next-regression', purpose: 'eval:next:train:regression', status: 'settled', reservedMicros: 0, chargedMicros: 0, receipts: [] }];
  const result = buildTrainingExperience(input), row = result.observations.find(value => value.candidateId === 'next')!;
  assert.deepEqual(row.changedKeys, ['lookup', 'system']); assert.deepEqual(row.lineage!.changedKeys, ['lookup']);
  assert.equal(row.lineage!.parentId, 'candidate');
  assert.deepEqual(row.edits[0], { key: 'lookup', before: 'Find records.', after: 'Find records by exact key.',
    kind: 'tool-description', target: { type: 'tool', id: 'lookup' } });
  assert.equal(row.baselineCostMicros, 100); assert.equal(row.baselinePassed, true);
});

test('free observations retain zero costs and zero usage without introducing fictitious receipts', () => {
  const input = fixture();
  for (const row of input.evaluations) row.usage = [];
  for (const entry of input.entries) { entry.reservedMicros = 0; entry.chargedMicros = 0; entry.receipts = []; }
  const result = buildTrainingExperience(input);
  assert.ok(result.observations.every(row => row.totalTokens === 0 && row.baselineTokens === 0 && row.settledCostMicros === 0 && row.baselineCostMicros === 0));
});
