import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent, createOfflineProposer } from '../src/optimize.js';
import { proposalContext, validateStructure } from '../src/structure.js';
import { applyPatch, canonical } from '../src/validation.js';
import type { AgentTextConfiguration } from '../src/types.js';

function configuration() {
  return {
    components: { plannerPrompt: 'Plan one lookup.', lookupDescription: 'Look up records.', responderPrompt: 'Summarize verified results.', privatePolicy: 'immutable-private-policy' },
    mutable: {
      plannerPrompt: { role: 'Planning instructions', maxLength: 200, kind: 'prompt' as const, target: { type: 'node' as const, id: 'planner' } },
      lookupDescription: { role: 'Lookup selection guidance', maxLength: 160, kind: 'tool-description' as const, target: { type: 'tool' as const, id: 'lookup' } },
    },
    structure: { version: 1 as const,
      nodes: [
        { id: 'planner', role: 'Plan factual retrieval', promptKeys: ['plannerPrompt', 'privatePolicy'], toolIds: ['lookup'] },
        { id: 'responder', role: 'Explain verified evidence', promptKeys: ['responderPrompt'], toolIds: ['lookup'] },
      ],
      tools: [{ id: 'lookup', descriptionKey: 'lookupDescription', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        outputSchema: { type: 'array', items: { type: 'string' } }, constraints: ['Read-only', 'At most one call per case'] }],
      handoffs: [{ id: 'answer', from: 'planner', to: 'responder', description: 'Pass verified lookup evidence', contract: { required: ['evidence'], citations: true } }],
    },
  };
}
const runner = {
  id: 'structured-fixture', version: '1', accounting: { kind: 'free' as const, timeoutMs: 1000 },
  optimization: { proposer: createOfflineProposer<string, string>([]) },
  async run({ input }: { input: string }) { return { output: input, usage: { complete: true as const, receipts: [] } }; },
};
function invalid(value: unknown, expression: RegExp): void {
  assert.throws(() => validateStructure(value as AgentTextConfiguration), expression);
}

test('structured adapters preserve immutable roles, contracts, topology, and component ownership', () => {
  const settings = configuration(), agent = defineAgent({ ...settings, ...runner });
  validateStructure(agent);
  const original = canonical(agent.structure);
  const patched = applyPatch(agent.components, agent.mutable, { plannerPrompt: 'Retrieve only relevant evidence.', lookupDescription: 'Retrieve matching records by query.' });
  assert.equal(patched.plannerPrompt, 'Retrieve only relevant evidence.');
  assert.equal(patched.privatePolicy, 'immutable-private-policy');
  assert.equal(patched.responderPrompt, settings.components.responderPrompt);
  assert.equal(canonical(agent.structure), original);
  for (const patch of [{ structure: 'replace graph' }, { role: 'different role' }, { inputSchema: '{}' }, { handoffs: 'rewrite edges' }, { responderPrompt: 'change immutable prompt' }]) {
    assert.throws(() => applyPatch(agent.components, agent.mutable, patch), /immutable component/);
  }
  assert.throws(() => applyPatch(agent.components, agent.mutable, { plannerPrompt: { code: 'run a command' } }), /Invalid or oversized/);
  assert.throws(() => applyPatch(agent.components, agent.mutable, { lookupDescription: 'x'.repeat(161) }), /Invalid or oversized/);
});

test('proposal context is a detached frozen structural snapshot without component contents', () => {
  const settings = configuration(), context = proposalContext(settings)!;
  assert.deepEqual(context, settings.structure);
  assert.notEqual(context, settings.structure);
  assert.notEqual(context.nodes[0], settings.structure.nodes[0]);
  assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.tools[0]!.inputSchema));
  for (const contents of Object.values(settings.components)) assert.equal(JSON.stringify(context).includes(contents), false);
  assert.match(JSON.stringify(context), /privatePolicy/); // Only its declared key is public.
  settings.structure.nodes[0]!.role = 'Changed after snapshot';
  settings.structure.tools[0]!.constraints.push('Changed later');
  assert.equal(context.nodes[0]!.role, 'Plan factual retrieval'); assert.equal(context.tools[0]!.constraints.length, 2);
  assert.throws(() => Object.assign(context.nodes[0]!, { role: 'mutation' }), TypeError);
});

test('flat adapter setup stays functional while undeclared structured targets are rejected', () => {
  const flat = { components: { systemPrompt: 'Respond clearly' }, mutable: { systemPrompt: { role: 'System instruction', maxLength: 100 } } };
  const agent = defineAgent({ ...flat, ...runner });
  assert.equal(proposalContext(agent), undefined);
  validateStructure({ ...flat, mutable: { systemPrompt: { ...flat.mutable.systemPrompt, kind: 'prompt' } } });
  invalid({ ...flat, mutable: { systemPrompt: { ...flat.mutable.systemPrompt, target: { type: 'node', id: 'missing' } } } }, /require agent structure/);
  invalid({ ...flat, mutable: { systemPrompt: { ...flat.mutable.systemPrompt, kind: 'code' } } }, /Unsupported mutable component kind/);
});

test('structure references and ownership reject missing, duplicated, ambiguous, and mismatched targets', () => {
  const original = configuration();
  function changed(edit: (settings: ReturnType<typeof configuration>) => void, expression: RegExp) {
    const settings = configuration(); edit(settings); invalid(settings, expression);
  }
  changed(s => s.structure.nodes.push(s.structure.nodes[0]!), /Duplicate node/);
  changed(s => s.structure.tools.push(s.structure.tools[0]!), /Duplicate tool/);
  changed(s => s.structure.handoffs.push(s.structure.handoffs[0]!), /Duplicate handoff/);
  changed(s => s.structure.nodes[0]!.toolIds.push('missing'), /unknown tool/);
  changed(s => s.structure.handoffs[0]!.to = 'missing', /unknown node/);
  changed(s => s.structure.nodes[0]!.promptKeys.push('unknownPrompt'), /missing text component/);
  changed(s => s.structure.nodes[1]!.promptKeys.push('plannerPrompt'), /multiple structure owners/);
  changed(s => s.structure.nodes[0]!.promptKeys.push('lookupDescription'), /multiple structure owners/);
  changed(s => s.structure.nodes[0]!.promptKeys = ['privatePolicy'], /no structure owner/);
  changed(s => s.mutable.plannerPrompt.target.id = 'responder', /target does not match/);
  changed(s => s.structure.nodes.forEach(n => n.toolIds = []), /must belong to at least one node/);
  invalid({ ...original, mutable: { ...original.mutable, plannerPrompt: { role: 'Planner', maxLength: 100 } } }, /target does not match/);
  invalid({ ...original, mutable: { ...original.mutable, plannerPrompt: { ...original.mutable.plannerPrompt, kind: 'tool-description' } } }, /kind does not match/);
  invalid({ ...original, mutable: { ...original.mutable, lookupDescription: { ...original.mutable.lookupDescription, target: { type: 'node', id: 'planner' } } } }, /target does not match/);
  assert.throws(() => defineAgent({ ...original, ...runner, structure: { ...original.structure, version: 2 } } as never), /Unsupported agent structure version/);
});

test('metadata accepts JSON contracts and boolean schemas but rejects executable or hidden values before runner calls', () => {
  const settings = configuration();
  validateStructure({ ...settings, structure: { ...settings.structure, tools: [{ ...settings.structure.tools[0]!, inputSchema: false, outputSchema: true }] } });
  const badSchemas: unknown[] = [() => 'code', new Date(), ['not a schema'], { type: 'number', minimum: Infinity }, { execute: () => 'code' }];
  for (const inputSchema of badSchemas) invalid({ ...settings, structure: { ...settings.structure, tools: [{ ...settings.structure.tools[0]!, inputSchema }] } }, /JSON|finite|schema/);
  invalid({ ...settings, structure: { ...settings.structure, execute: 'arbitrary code' } }, /Unexpected or missing/);
  invalid({ ...settings, structure: { ...settings.structure, tools: [{ ...settings.structure.tools[0]!, implementation: () => {} }] } }, /JSON/);
  invalid({ ...settings, mutable: { ...settings.mutable, plannerPrompt: { ...settings.mutable.plannerPrompt, evaluate: () => true } } }, /JSON/);
  let accesses = 0;
  const contract = Object.defineProperty({}, 'callback', { enumerable: true, get() { accesses++; return 'hidden execution'; } });
  invalid({ ...settings, structure: { ...settings.structure, handoffs: [{ ...settings.structure.handoffs[0]!, contract }] } }, /accessors/);
  assert.equal(accesses, 0);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  invalid({ ...settings, structure: { ...settings.structure, handoffs: [{ ...settings.structure.handoffs[0]!, contract: cycle }] } }, /acyclic JSON/);
  const symbol = { [Symbol('secret')]: 'hidden' };
  invalid({ ...settings, structure: { ...settings.structure, handoffs: [{ ...settings.structure.handoffs[0]!, contract: symbol }] } }, /symbol/);
});
