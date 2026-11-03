import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeEvidence, applyConfigurationPatch, buildSubmission, createConfigurationPatch, createOfflineProposer,
  defineAgent, defineExperiment, exactMatch, runExperiment, validateConfigurationPatch, validateSubmission,
  type AgentTextConfiguration, type ConfigurationPatch, type Submission,
} from 'evopt';
import { readExperimentResult } from '../src/experiments.js';
import { hash } from '../src/validation.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/experiment.mjs', import.meta.url));
const metadata = { id: 'review-fixture', summary: 'Offline evidence and guarded text patch integration fixture.', reviewed: true };

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'evopt-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const agent = defineAgent<string, string>({
    id: 'structured-fixture', version: 'application-v1',
    components: { systemPrompt: 'Initial response policy.', lookupDescription: 'Lookup a catalog item.', reviewPrompt: 'Immutable review policy.' },
    mutable: {
      systemPrompt: { role: 'Worker response policy', maxLength: 200, kind: 'prompt', target: { type: 'node', id: 'worker' } },
      lookupDescription: { role: 'Catalog search instructions', maxLength: 200, kind: 'tool-description', target: { type: 'tool', id: 'lookup' } },
    },
    structure: { version: 1,
      nodes: [{ id: 'worker', role: 'Answer the task using the catalog', promptKeys: ['systemPrompt'], toolIds: ['lookup'] },
        { id: 'reviewer', role: 'Check the response', promptKeys: ['reviewPrompt'], toolIds: [] }],
      tools: [{ id: 'lookup', descriptionKey: 'lookupDescription', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        outputSchema: { type: 'string' }, constraints: ['Read-only catalog access'] }],
      handoffs: [{ id: 'review-answer', from: 'worker', to: 'reviewer', description: 'Review the answer', contract: { responseType: 'string' } }],
    },
    accounting: { kind: 'free', timeoutMs: 1000 },
    optimization: { maxAttempts: 1, proposer: createOfflineProposer<string, string>([
      { systemPrompt: 'Improved response policy.', lookupDescription: 'Look up exact catalog names before responding.' },
    ]) },
    async run(args) {
      calls++;
      assert.deepEqual(Object.keys(args).sort(), ['components', 'context', 'input']);
      assert.deepEqual(Object.keys(args.context).sort(), ['evaluationId', 'signal']);
      const improved = args.components.systemPrompt === 'Improved response policy.';
      const passed = args.input === 'regression-input' ? !improved : improved;
      return { output: passed ? args.input : 'PRIVATE-INCORRECT-OUTPUT', usage: { complete: true, receipts: [] }, trace: [{ type: 'PRIVATE-TRACE' }] };
    },
  });
  const experiment = defineExperiment({ id: 'review-workflow', description: 'Offline structured text review fixture', objective: 'accuracy', agent,
    dataset: { id: 'review-cases', version: '1', score: exactMatch,
      train: [{ id: 'training', input: 'training-input', expected: 'training-input' }],
      validation: [{ id: 'validation', input: 'validation-input', expected: 'validation-input' }],
      test: [{ id: 'heldout-regression', input: 'regression-input', expected: 'regression-input' },
        { id: 'heldout-improved-one', input: 'improved-input-one', expected: 'improved-input-one' },
        { id: 'heldout-improved-two', input: 'improved-input-two', expected: 'improved-input-two' }],
    },
  });
  const directory = join(root, 'run'), result = await runExperiment(experiment, { budget: 10, directory });
  assert.equal(result.status, 'completed');
  return { root, directory, agent, result, calls: () => calls };
}

function rehashSubmission(submission: Submission): Submission {
  const { digest: _digest, metadata: value, ...payload } = submission;
  submission.digest = hash({ ...payload, metadata: { id: value.id, summary: value.summary } });
  return submission;
}
function rehashPatch(patch: ConfigurationPatch): ConfigurationPatch {
  const { digest: _digest, ...payload } = patch; patch.digest = hash(payload); return patch;
}
async function command(...args: string[]) { return execute(process.execPath, [cli, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }); }
async function rejectedCommand(args: string[], pattern: RegExp) {
  await assert.rejects(command(...args), error => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error);
    assert.match(String(error.stderr), pattern); return true;
  });
}

test('offline run exports reproducible before/after evidence, small-sample uncertainty and explicit regressions', async t => {
  const f = await fixture(t), baseline = structuredClone(f.agent.components);
  assert.equal(f.calls(), 10);
  const restored = await readExperimentResult(f.directory);
  assert.deepEqual(restored.configuration, { mutable: f.agent.mutable, structure: f.agent.structure, objective: 'accuracy', selection: { kind: 'accuracy' },
    experience: { maxObservations: 12, maxRejections: 5, maxCharacters: 16000 } });
  const review = analyzeEvidence(restored), submission = buildSubmission(restored, metadata), checked = validateSubmission(submission);
  assert.deepEqual(submission.review, review); assert.deepEqual(checked.review, review);
  assert.equal(review.paired.n, 3); assert.equal(review.paired.improved, 2); assert.equal(review.paired.regressed, 1);
  assert.deepEqual(review.paired.regressedCaseIds, ['heldout-regression']);
  assert.deepEqual(review.paired.improvedCaseIds, ['heldout-improved-one', 'heldout-improved-two']);
  assert.equal(review.accuracy.baseline.estimate, 1 / 3); assert.equal(review.accuracy.candidate.estimate, 2 / 3);
  assert.equal(review.delta.estimate, 1 / 3);
  assert.ok(review.delta.interval95!.lower <= 0 && review.delta.interval95!.upper >= 0);
  assert.equal(review.mcnemar.pValue, 1);
  assert.equal(review.costs.baselineTest.evaluations, 3); assert.equal(review.costs.candidateTest.evaluations, 3);
  assert.equal(review.costs.totalRunMicros, 0); assert.equal(review.costs.proposalMicros, 0); assert.equal(review.costs.testTotalMicros, 0);
  assert.equal(checked.synthetic, true); assert.equal(checked.eligibleForPromotion, false);
  assert.ok(checked.limitations.some(value => /regressed/.test(value)));
  assert.deepEqual(submission.patch, createConfigurationPatch(restored));
  assert.deepEqual(submission.patch!.edits.map(edit => [edit.key, edit.kind, edit.target]), [
    ['lookupDescription', 'tool-description', { type: 'tool', id: 'lookup' }], ['systemPrompt', 'prompt', { type: 'node', id: 'worker' }],
  ]);
  assert.deepEqual(applyConfigurationPatch(f.agent, submission.patch!), f.result.components);
  assert.deepEqual(f.agent.components, baseline);
  assert.equal(f.calls(), 10);
  const portable = JSON.stringify(submission);
  for (const privateValue of ['PRIVATE-INCORRECT-OUTPUT', 'PRIVATE-TRACE', 'regression-input', f.directory]) assert.equal(portable.includes(privateValue), false);
});

test('exported text patch rejects changed agent identity, baseline, allowlist, schemas and handoff graph', async t => {
  const f = await fixture(t), patch = createConfigurationPatch(f.result);
  const target: AgentTextConfiguration & { id: string; version: string } = {
    id: f.agent.id, version: f.agent.version, components: f.agent.components, mutable: f.agent.mutable, structure: f.agent.structure,
  };
  const changed: Array<[string, typeof target, RegExp]> = [
    ['agent', { ...target, id: 'other-agent' }, /agent\/version mismatch/],
    ['version', { ...target, version: 'application-v2' }, /agent\/version mismatch/],
    ['mutable baseline', { ...target, components: { ...target.components, systemPrompt: 'A different deployed baseline.' } }, /baseline mismatch/],
    ['immutable prompt', { ...target, components: { ...target.components, reviewPrompt: 'A different immutable policy.' } }, /baseline mismatch/],
    ['allowlist', { ...target, mutable: { ...target.mutable, systemPrompt: { ...target.mutable.systemPrompt!, maxLength: 201 } } }, /contract mismatch/],
    ['schema', { ...target, structure: { ...target.structure!, tools: target.structure!.tools.map(tool => ({ ...tool, inputSchema: { type: 'object', properties: { query: { type: 'number' } } } })) } }, /contract mismatch/],
    ['graph', { ...target, structure: { ...target.structure!, handoffs: target.structure!.handoffs.map(handoff => ({ ...handoff, from: 'reviewer', to: 'worker' })) } }, /contract mismatch/],
  ];
  for (const [name, agent, pattern] of changed) assert.throws(() => applyConfigurationPatch(agent, patch), pattern, name);
  assert.equal(f.calls(), 10);
});

test('submission validation recomputes statistics and text edits after their digests are honestly recalculated', async t => {
  const f = await fixture(t), original = buildSubmission(f.result, metadata);
  const mutations: Array<[string, (submission: Submission) => void]> = [
    ['delta', submission => { submission.review!.delta.estimate = 1; }],
    ['interval', submission => { submission.review!.delta.interval95!.lower = 0.5; }],
    ['p-value', submission => { submission.review!.mcnemar.pValue = 0.000001; }],
    ['regression IDs', submission => { submission.review!.paired.regressedCaseIds = []; }],
    ['cost', submission => { submission.review!.costs.totalRunMicros = 1; }],
  ];
  for (const [name, edit] of mutations) {
    const altered = structuredClone(original); edit(altered); rehashSubmission(altered);
    assert.notEqual(altered.digest, original.digest);
    assert.throws(() => validateSubmission(altered), /Review statistics differ/, name);
  }
  const altered = structuredClone(original); altered.patch!.edits[0]!.after = 'An unrelated but well-formed text edit.';
  rehashPatch(altered.patch!); validateConfigurationPatch(altered.patch!); rehashSubmission(altered);
  assert.throws(() => validateSubmission(altered), /Exported patch differs/);
  assert.deepEqual(validateSubmission(original).review, original.review);
});

test('read-only review and explicitly reviewed patch CLI commands use checkpoint evidence and refuse overwrite', async t => {
  const f = await fixture(t), patchFile = join(f.root, 'patch.json');
  const stateBefore = await readFile(join(f.directory, 'state.json'), 'utf8');
  const resultBefore = await readFile(join(f.directory, 'result.json'), 'utf8');
  f.agent.run = async () => { throw new Error('Review must not invoke the configured agent'); };
  const review = JSON.parse((await command('review', '--run', f.directory)).stdout);
  assert.deepEqual(review, analyzeEvidence(f.result));
  await rejectedCommand(['patch', '--run', f.directory, '--out', patchFile], /reviewed/);
  await assert.rejects(readFile(patchFile), /ENOENT/);
  const exported = JSON.parse((await command('patch', '--run', f.directory, '--out', patchFile, '--reviewed')).stdout);
  assert.equal(exported.inferenceRun, false); assert.equal(exported.edits, 2);
  const bytes = await readFile(patchFile, 'utf8'), patch = JSON.parse(bytes);
  assert.deepEqual(patch, createConfigurationPatch(f.result));
  assert.deepEqual(applyConfigurationPatch(f.agent, patch), f.result.components);
  await rejectedCommand(['patch', '--run', f.directory, '--out', patchFile, '--reviewed'], /EEXIST|exists/i);
  assert.equal(await readFile(patchFile, 'utf8'), bytes);
  assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), stateBefore);
  assert.equal(await readFile(join(f.directory, 'result.json'), 'utf8'), resultBefore);
  assert.equal(f.calls(), 10);
});

test('new checkpoint export contract refuses stripped or changed configuration metadata', async t => {
  const f = await fixture(t), file = join(f.directory, 'result.json');
  const checkpoint = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(checkpoint.state.config.exportContract, 3);
  const stripped = structuredClone(f.result); delete stripped.configuration;
  await writeFile(file, JSON.stringify(stripped));
  await assert.rejects(readExperimentResult(f.directory), /missing its configuration contract/);
  await rejectedCommand(['review', '--run', f.directory], /missing its configuration contract/);
  const altered = structuredClone(f.result);
  altered.configuration = { ...altered.configuration!, mutable: { ...altered.configuration!.mutable,
    systemPrompt: { ...altered.configuration!.mutable.systemPrompt!, maxLength: 201 } } };
  await writeFile(file, JSON.stringify(altered));
  await assert.rejects(readExperimentResult(f.directory), /checkpoint configuration differ/);
  await writeFile(file, JSON.stringify(f.result));
  assert.deepEqual(await readExperimentResult(f.directory), f.result);
});
