import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defineAgent, exactMatch, optimize } from '../src/optimize.js';
import { applyConfigurationPatch, createConfigurationPatch, validateConfigurationPatch } from '../src/patch.js';
import { canonical, hash } from '../src/validation.js';
import type { Dataset, InvocationResult, ProposalRequest, Proposer } from '../src/types.js';

type Input = { word: string; scratch: { visits: number } };
const free = { kind: 'free' as const, timeoutMs: 1000 };
const reply = <O>(output: O): InvocationResult<O> => ({ output, usage: { complete: true, receipts: [] } });
function definition() {
  return {
    components: { plannerPrompt: 'Return unverified text.', lookupDescription: 'Search broadly.', responderPrompt: 'PRIVATE-RESPONDER-INSTRUCTIONS', policy: 'PRIVATE-IMMUTABLE-POLICY' },
    mutable: {
      plannerPrompt: { role: 'Retrieval planning instructions', maxLength: 80, kind: 'prompt' as const, target: { type: 'node' as const, id: 'planner' } },
      lookupDescription: { role: 'Tool selection guidance', maxLength: 120, kind: 'tool-description' as const, target: { type: 'tool' as const, id: 'lookup' } },
    },
    structure: { version: 1 as const,
      nodes: [
        { id: 'planner', role: 'Retrieve verified records', promptKeys: ['plannerPrompt', 'policy'], toolIds: ['lookup'] },
        { id: 'responder', role: 'Respond using verified records', promptKeys: ['responderPrompt'], toolIds: [] },
      ],
      tools: [{ id: 'lookup', descriptionKey: 'lookupDescription', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        outputSchema: { type: 'object', required: ['record'] }, constraints: ['Read-only', 'One lookup per evaluation'] }],
      handoffs: [{ id: 'answer', from: 'planner', to: 'responder', description: 'Pass verified records for the final response', contract: { required: ['record'], verified: true } }],
    },
  };
}
function dataset(): Dataset<Input, string> {
  const task = (id: string, word: string) => ({ id, input: { word, scratch: { visits: 0 } }, expected: word.toUpperCase() });
  return { id: 'native-workflow-fixture', version: '1', score: exactMatch,
    train: [task('training', 'train-only')], validation: [task('validation', 'validation-only')], test: [task('holdout', 'holdout-only')] };
}
function cleanupDefaultRun(t: { after(fn: () => Promise<void>): void }, directory: string): void {
  const parent = resolve('.evopt', 'runs'), path = relative(parent, directory);
  assert.ok(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path), 'Only remove this test run inside the default evidence root');
  t.after(() => rm(directory, { recursive: true, force: true }));
}

test('four-property optimization uses native graph contracts for bounded edits and exports an exact guarded patch', async t => {
  const initial = definition(), original = structuredClone(initial), data = dataset();
  const proposals: ProposalRequest<Input, string>[] = [], evaluationIds = new Set<string>();
  let targetCalls = 0;
  const proposer: Proposer<Input, string> = { id: 'native-fixture-proposer', version: '1', accounting: free,
    async propose(request) {
      proposals.push(structuredClone(request));
      assert.deepEqual(Object.keys(request.components).sort(), ['lookupDescription', 'plannerPrompt']);
      assert.deepEqual(request.structure, original.structure);
      assert.ok(Object.isFrozen(request.structure)); assert.ok(Object.isFrozen(request.structure!.tools[0]!.inputSchema));
      assert.equal(request.structure!.tools[0]!.constraints[0], 'Read-only');
      assert.equal(request.structure!.handoffs[0]!.to, 'responder');
      assert.deepEqual(request.feedback.map(item => item.caseId), ['training']);
      const encoded = JSON.stringify(request);
      for (const secret of ['PRIVATE-RESPONDER-INSTRUCTIONS', 'PRIVATE-IMMUTABLE-POLICY', 'VALIDATION-ONLY', 'HOLDOUT-ONLY']) assert.equal(encoded.includes(secret), false);
      if (request.attempt === 1) return reply({ responderPrompt: 'Overwrite immutable node instructions' });
      if (request.attempt === 2) return reply({ plannerPrompt: 'x'.repeat(81) });
      return reply({ plannerPrompt: 'Return uppercase verified records.', lookupDescription: 'Fetch exactly the requested record.' });
    } };
  const agent = defineAgent<Input, string>({ id: 'native-two-node-agent', version: 'fixture-1', ...initial,
    accounting: free, optimization: { proposer, maxAttempts: 3 },
    async run(args) {
      assert.deepEqual(Object.keys(args).sort(), ['components', 'context', 'input']);
      assert.deepEqual(Object.keys(args.input).sort(), ['scratch', 'word']);
      assert.equal(args.input.scratch.visits, 0); args.input.scratch.visits++;
      assert.ok(args.context.signal instanceof AbortSignal); assert.ok(!evaluationIds.has(args.context.evaluationId)); evaluationIds.add(args.context.evaluationId);
      assert.equal(args.components.responderPrompt, original.components.responderPrompt); assert.equal(args.components.policy, original.components.policy);
      if (targetCalls++ === 0) {
        // Callers still own their original settings; optimization must use its snapshot.
        initial.structure.nodes[0]!.role = 'Caller changed its role during evaluation';
        initial.structure.tools[0]!.inputSchema.additionalProperties = true;
        initial.structure.handoffs[0]!.contract.verified = false;
      }
      const improved = args.components.plannerPrompt === 'Return uppercase verified records.' && args.components.lookupDescription === 'Fetch exactly the requested record.';
      return reply(improved ? args.input.word.toUpperCase() : args.input.word);
    } });
  // The documented four-property call has no global provider configuration.
  const result = await optimize({ agent, dataset: data, objective: 'accuracy', budget: 10 });
  cleanupDefaultRun(t, result.directory);
  assert.equal(result.status, 'completed'); assert.equal(result.accounting.occupiedMicros, 0);
  assert.deepEqual(result.history.map(row => row.status), ['rejected', 'rejected', 'evaluated']);
  assert.match(result.history[0]!.reason!, /immutable/); assert.match(result.history[1]!.reason!, /oversized/);
  assert.equal(result.candidates.length, 2); assert.equal(proposals.length, 3); assert.equal(targetCalls, 6);
  assert.deepEqual(result.test, { kind: 'paired', baselineAccuracy: 0, candidateAccuracy: 1 });
  assert.deepEqual(result.configuration, { mutable: original.mutable, structure: original.structure });
  assert.notDeepEqual(initial.structure, result.configuration!.structure);
  assert.equal(data.train[0]!.input.scratch.visits, 0);

  const patch = createConfigurationPatch(result);
  validateConfigurationPatch(patch);
  const invented = { ...original.components, plannerPrompt: 'Never evaluated' };
  assert.throws(() => createConfigurationPatch({ ...result, candidates: [result.candidates[0]!], components: invented, selectedId: hash(invented) }), /missing from candidate evidence/);
  assert.throws(() => createConfigurationPatch({ ...result, candidates: result.candidates.map(candidate => candidate.id === result.selectedId
    ? { ...candidate, components: invented } : candidate) }), /missing from candidate evidence/);
  assert.deepEqual(patch.edits.map(edit => ({ key: edit.key, role: edit.role, kind: edit.kind, target: edit.target })), [
    { key: 'lookupDescription', role: 'Tool selection guidance', kind: 'tool-description', target: { type: 'tool', id: 'lookup' } },
    { key: 'plannerPrompt', role: 'Retrieval planning instructions', kind: 'prompt', target: { type: 'node', id: 'planner' } },
  ]);
  const reviewed = { ...agent, ...structuredClone(original) };
  assert.deepEqual(applyConfigurationPatch(reviewed, patch), result.components);
  assert.equal(reviewed.components.plannerPrompt, 'Return unverified text.'); // Adoption is explicit.
  assert.equal(patch.structureSha256, hash(original.structure));
  assert.equal(JSON.stringify(patch).includes('PRIVATE-IMMUTABLE-POLICY'), false);
  assert.equal(JSON.stringify(patch).includes('PRIVATE-RESPONDER-INSTRUCTIONS'), false);

  const changedGraph = { ...reviewed, structure: structuredClone(original.structure) }; changedGraph.structure.handoffs[0]!.to = 'planner';
  const changedContract = { ...reviewed, structure: structuredClone(original.structure) }; changedContract.structure.tools[0]!.inputSchema.additionalProperties = true;
  for (const changed of [changedGraph, changedContract]) {
    assert.throws(() => applyConfigurationPatch(changed, patch), /contract mismatch/);
    await assert.rejects(optimize({ agent: changed, dataset: data, objective: 'accuracy', budget: 10, run: { directory: result.directory, resume: true } }), /fingerprint mismatch/);
  }
  assert.equal(targetCalls, 6); assert.equal(proposals.length, 3);
  const resumed = await optimize({ agent: reviewed, dataset: data, objective: 'accuracy', budget: 10, run: { directory: result.directory, resume: true } });
  assert.equal(resumed.status, 'completed'); assert.equal(targetCalls, 6); assert.equal(proposals.length, 3);
  assert.equal(canonical(resumed.configuration), canonical(result.configuration));
  const changedBaseline = { ...reviewed, components: { ...reviewed.components, policy: 'Different fixed policy' } };
  assert.throws(() => applyConfigurationPatch(changedBaseline, patch), /baseline mismatch/);
});
