import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, optimize, createOfflineProposer, exactMatch } from '../src/index.js';
import { buildSubmission, validateSubmission } from '../src/contributions.js';
import type { Submission } from '../src/contributions.js';
import type { Accounting } from '../src/types.js';
import { clone, hash } from '../src/validation.js';

const metadata = { id: 'classification-improvement', summary: 'Use a clearer classification instruction.', reviewed: true };
const paid: Accounting = { kind: 'paid', maxCostUSD: 0.01, version: 'mock-v1', enforcement: 'Mocked requests only',
  limits: { maxModelCalls: 1, maxInputTokens: 10, maxOutputTokens: 10, maxPaidToolCalls: 0, maxRetries: 0, timeoutMs: 1000 },
  pricing: { source: 'test tariff', checkedAt: '2026-11-03', inputUSDPerMillion: 1, outputUSDPerMillion: 1 } };
async function fixture(t: { after(callback: () => Promise<void>): void }, options: { paid?: boolean; improve?: boolean; regress?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'evopt-submission-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const a = defineAgent<string, string>({ id: 'classifier', version: '1', components: { prompt: 'initial', fixed: 'fixed tool implementation' },
    mutable: { prompt: { role: 'classification prompt', maxLength: 200 } }, accounting: options.paid ? paid : { kind: 'free', timeoutMs: 1000 },
    optimization: { proposer: createOfflineProposer([{ prompt: options.improve === false ? 'equally-wrong' : 'improved' }]), maxAttempts: 1 },
    async run({ input, components, context }) {
      const improved = components.prompt === 'improved';
      const correct = options.regress && input.startsWith('test-') ? (input === 'test-1' ? !improved : improved) : improved;
      return { output: correct ? input : 'PRIVATE-RAW-OUTPUT', trace: [{ type: 'PRIVATE-RAW-TRACE' }], usage: { complete: true, receipts: options.paid ? [{ id: context.evaluationId, provider: 'mock', model: 'mock-v1', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }] : [] } };
    },
  });
  return optimize({ agent: a, dataset: { id: 'classification', version: '1', score: exactMatch,
    train: [{ id: 'train', input: 'train', expected: 'train' }], validation: [{ id: 'validation', input: 'validation', expected: 'validation' }],
    test: [{ id: 'test-1', input: 'test-1', expected: 'test-1' }, { id: 'test-2', input: 'test-2', expected: 'test-2' }] }, objective: 'accuracy', budget: 1, run: { directory, includeTraces: true } });
}
function rehash(s: Submission): Submission {
  const { digest: _, metadata: m, ...payload } = s;
  s.digest = hash({ ...payload, metadata: { id: m.id, summary: m.summary } }); return s;
}

test('portable package omits raw outputs, traces, and directory and labels offline evidence', async t => {
  const result = await fixture(t), submission = buildSubmission(result, metadata), checked = validateSubmission(submission);
  assert.equal(checked.synthetic, true); assert.equal(checked.eligibleForPromotion, false);
  assert.equal(checked.candidateTestAccuracy, 1); assert.equal(checked.baselineTestAccuracy, 0);
  assert.equal(checked.evaluationCount, 8); assert.equal(checked.spentMicros, 0);
  const serialized = JSON.stringify(submission);
  for (const forbidden of ['PRIVATE-RAW-OUTPUT', 'PRIVATE-RAW-TRACE', result.directory, '"directory"', '"output"', '"trace"']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(submission.components.prompt, 'improved');
  assert.ok(submission.evaluations.every(e => /^[a-f0-9]{64}$/.test(e.outputHash)));
  result.components = { prompt: 'mutated' }; assert.equal(submission.components.prompt, 'improved');
});

test('completed paired paid evidence is eligible only after explicit review', async t => {
  const result = await fixture(t, { paid: true });
  assert.throws(() => buildSubmission(result, { ...metadata, reviewed: false }), /sharing review/);
  assert.throws(() => buildSubmission({ ...result, status: 'interrupted' }, metadata), /completed/);
  const submission = buildSubmission(result, metadata), checked = validateSubmission(submission);
  assert.equal(checked.eligibleForPromotion, true); assert.equal(checked.synthetic, false); assert.equal(checked.spentMicros, 16);
  assert.ok(checked.limitations.some(v => v.includes('reproduce')));
});

test('older accuracy submissions retain their original review while validators derive token evidence', async t => {
  const submission = buildSubmission(await fixture(t, { paid: true }), metadata);
  delete submission.configuration!.objective;
  const previousReview = { ...submission.review! } as Partial<NonNullable<Submission['review']>>;
  delete previousReview.tokens;
  previousReview.limitations = previousReview.limitations!.filter(value => !value.startsWith('The token interval descriptively resamples'));
  submission.review = previousReview as NonNullable<Submission['review']>; rehash(submission);
  const result = validateSubmission(submission);
  assert.equal(result.eligibleForPromotion, true);
  assert.equal(result.review.tokens.baselineTest, 4);
  submission.review.delta.estimate = 0; rehash(submission);
  assert.throws(() => validateSubmission(submission), /Review statistics differ/);
});

test('identity controls and test regressions are valid reports but cannot be promoted', async t => {
  const identity = buildSubmission(await fixture(t, { paid: true, improve: false }), metadata);
  assert.equal(identity.test.kind, 'identity-control'); assert.equal(validateSubmission(identity).eligibleForPromotion, false);
  const regression = buildSubmission(await fixture(t, { paid: true, regress: true }), metadata);
  assert.equal(regression.test.baselineAccuracy, 0.5); assert.equal(regression.test.candidateAccuracy, 0.5);
  const checked = validateSubmission(regression); assert.equal(checked.eligibleForPromotion, false);
  assert.ok(checked.limitations.some(v => v.includes('regressed')));
});

test('validator rejects digest tampering and structurally inconsistent rehashed evidence', async t => {
  const original = buildSubmission(await fixture(t, { paid: true }), metadata);
  const altered = clone(original); altered.metadata.summary = 'changed'; assert.throws(() => validateSubmission(altered), /digest/);
  const cases: [string, (s: Submission) => void][] = [
    ['component identity', s => { s.candidates[0]!.components = { prompt: 'tampered', fixed: 'fixed tool implementation' }; }],
    ['selected change', s => { s.changes.prompt!.after = 'unrelated'; }],
    ['pending billing', s => { s.accounting.entries[0]!.status = 'pending'; }],
    ['budget ceiling', s => { s.accounting.limitMicros = 1; }],
    ['charged total', s => { s.accounting.occupiedMicros = 0; }],
    ['receipt mismatch', s => { s.evaluations[0]!.usage[0]!.inputTokens = 2; }],
    ['free paid receipt', s => { s.accounting.entries[0]!.reservedMicros = 0; s.accounting.entries[0]!.chargedMicros = 0; s.accounting.occupiedMicros -= 2; }],
    ['synthetic paid ledger', s => { s.provenance.synthetic = true; }],
    ['missing pair', s => { s.evaluations.pop(); }],
    ['incorrect score', s => { s.candidates[0]!.validationAccuracy = 1; }],
    ['incorrect comparison', s => { s.test.kind = 'identity-control'; }],
    ['missing candidate history', s => { s.history = []; }],
    ['duplicate evaluation', s => { s.evaluations.push(clone(s.evaluations[0]!)); }],
    ['unsafe extra field', s => { (s as unknown as Record<string, unknown>).rawOutput = 'secret'; }],
  ];
  for (const [label, edit] of cases) { const changed = clone(original); edit(changed); assert.throws(() => validateSubmission(rehash(changed)), label); }
});

test('a non-synthetic label alone does not qualify unmetered target evidence', async t => {
  const s = buildSubmission(await fixture(t), metadata); s.provenance.synthetic = false;
  const checked = validateSubmission(rehash(s)); assert.equal(checked.eligibleForPromotion, false);
  assert.ok(checked.limitations.some(v => v.includes('unmetered')));
});
