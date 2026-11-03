import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnthropicConfiguration, mapOpenAIChatConfiguration } from '../src/adapters.js';
import type { AgentTextConfiguration, JsonSchema } from '../src/types.js';

function configuration() {
  const lookupSchema: Exclude<JsonSchema, boolean> = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
  const searchSchema: Exclude<JsonSchema, boolean> = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  const lookupOutput: JsonSchema = { type: 'string' }, searchOutput: JsonSchema = { type: 'array', items: { type: 'string' } };
  return {
    components: { prompt: 'Find verified evidence.', policy: 'Use read-only tools.', review: 'Review citations.', lookupDescription: 'Fetch one record.', searchDescription: 'Search public records.', unusedPolicy: 'Keep this immutable.' },
    mutable: {
      prompt: { role: 'Retrieval instructions', maxLength: 80, kind: 'prompt' as const, target: { type: 'node' as const, id: 'retriever' } },
      lookupDescription: { role: 'Record lookup guidance', maxLength: 60, kind: 'tool-description' as const, target: { type: 'tool' as const, id: 'lookup' } },
    },
    structure: { version: 1 as const,
      nodes: [
        { id: 'retriever', role: 'IMMUTABLE ROLE METADATA', promptKeys: ['policy', 'prompt'], toolIds: ['search', 'lookup'] },
        { id: 'reviewer', role: 'Review returned evidence', promptKeys: ['review'], toolIds: [] as string[] },
      ],
      tools: [
        { id: 'lookup', descriptionKey: 'lookupDescription', inputSchema: lookupSchema, outputSchema: lookupOutput, constraints: ['Read only', 'At most one call'] },
        { id: 'search', descriptionKey: 'searchDescription', inputSchema: searchSchema, outputSchema: searchOutput, constraints: ['Read only'] },
      ],
      handoffs: [{ id: 'review', from: 'retriever', to: 'reviewer', description: 'Pass verified citations', contract: { evidenceRequired: true } }],
    },
  };
}

test('OpenAI Chat mapping uses declared prompt/tool order and candidate text in actual function-tool shape', () => {
  const agent = configuration(), candidate = { ...agent.components, prompt: 'Look up only relevant citations.', lookupDescription: 'Fetch the record matching its stable ID.' };
  assert.deepEqual(mapOpenAIChatConfiguration(agent, 'retriever', candidate), {
    messages: [{ role: 'system', content: 'Use read-only tools.\n\nLook up only relevant citations.' }],
    tools: [
      { type: 'function', function: { name: 'search', description: 'Search public records.', parameters: agent.structure.tools[1]!.inputSchema } },
      { type: 'function', function: { name: 'lookup', description: 'Fetch the record matching its stable ID.', parameters: agent.structure.tools[0]!.inputSchema } },
    ],
  });
});

test('Anthropic mapping uses system and input_schema fields without inventing runtime or topology fields', () => {
  const agent = configuration();
  assert.deepEqual(mapAnthropicConfiguration(agent, 'retriever'), {
    system: 'Use read-only tools.\n\nFind verified evidence.',
    tools: [
      { name: 'search', description: 'Search public records.', input_schema: agent.structure.tools[1]!.inputSchema },
      { name: 'lookup', description: 'Fetch one record.', input_schema: agent.structure.tools[0]!.inputSchema },
    ],
  });
  assert.deepEqual(mapAnthropicConfiguration(agent, 'reviewer'), { system: 'Review citations.', tools: [] });
  agent.structure.nodes[1]!.promptKeys = [];
  assert.deepEqual(mapAnthropicConfiguration(agent, 'reviewer'), { system: '', tools: [] });
  assert.deepEqual(mapOpenAIChatConfiguration(agent, 'reviewer'), { messages: [{ role: 'system', content: '' }], tools: [] });
});

test('mapping preserves immutable metadata and returns detached exact input schemas', () => {
  const agent = configuration(), before = structuredClone(agent), candidate = { ...agent.components, prompt: 'Updated instructions.' };
  const openai = mapOpenAIChatConfiguration(agent, 'retriever', candidate), anthropic = mapAnthropicConfiguration(agent, 'retriever', candidate);
  assert.deepEqual(agent, before); assert.equal(candidate.prompt, 'Updated instructions.');
  const sourceSchema = agent.structure.tools[1]!.inputSchema;
  assert.notEqual(openai.tools[0]!.function.parameters, sourceSchema);
  assert.notEqual(openai.tools[0]!.function.parameters.properties, sourceSchema.properties);
  assert.notEqual(anthropic.tools[0]!.input_schema, sourceSchema);
  Object.assign(openai.tools[0]!.function.parameters, { type: 'array', injected: true });
  Object.assign(anthropic.tools[0]!.input_schema.properties!, { injected: { type: 'string' } });
  assert.deepEqual(agent, before);
});

test('mapping rejects incomplete, extra, nontext, oversized, and immutable candidate edits', () => {
  const agent = configuration();
  const missing = { ...agent.components } as Record<string, string>; delete missing.unusedPolicy;
  const invalid: [unknown, RegExp][] = [
    [missing, /exactly the declared/],
    [{ ...agent.components, extra: 'undeclared' }, /exactly the declared/],
    [{ ...agent.components, policy: 'Rewrite fixed policy.' }, /immutable component/],
    [{ ...agent.components, prompt: 'x'.repeat(81) }, /exceeds length/],
    [{ ...agent.components, prompt: 42 }, /Components must be text/],
    [null, /components and a mutable/],
  ];
  for (const map of [mapOpenAIChatConfiguration, mapAnthropicConfiguration]) {
    for (const [candidate, message] of invalid) assert.throws(() => map(agent, 'retriever', candidate as never), message);
    assert.throws(() => map(agent, 'missing'), /Unknown agent node/);
    const flat = { components: { prompt: 'Simple' }, mutable: { prompt: { role: 'Instructions', maxLength: 50 } } };
    assert.throws(() => map(flat, 'retriever'), /explicit agent structure/);
  }
  let reads = 0;
  const accessor = { ...agent.components };
  Object.defineProperty(accessor, 'prompt', { enumerable: true, get() { reads++; return 'Unexpected'; } });
  assert.throws(() => mapOpenAIChatConfiguration(agent, 'retriever', accessor), /accessors/); assert.equal(reads, 0);
});

test('mapping validates the full graph and refuses schema defaults or provider name coercion', () => {
  const agent = configuration();
  for (const inputSchema of [undefined, true, false]) {
    const { inputSchema: originalSchema, ...tool } = agent.structure.tools[0]!;
    const value = { ...agent, structure: { ...agent.structure, tools: [{ ...tool, ...(inputSchema === undefined ? {} : { inputSchema }) }, agent.structure.tools[1]!] } };
    for (const map of [mapOpenAIChatConfiguration, mapAnthropicConfiguration]) assert.throws(() => map(value, 'retriever'), /explicit object inputSchema/);
  }
  const invalidGraph = configuration(); invalidGraph.structure.handoffs[0]!.to = 'missing';
  assert.throws(() => mapOpenAIChatConfiguration(invalidGraph, 'retriever'), /unknown node/);
  function namedTool(name: string): AgentTextConfiguration {
    const value = configuration();
    value.structure.tools[0]!.id = name; value.structure.nodes[0]!.toolIds[1] = name; value.mutable.lookupDescription.target.id = name;
    return value;
  }
  for (const name of ['lookup.record', 'lookup/record', 'lookup:record']) {
    for (const map of [mapOpenAIChatConfiguration, mapAnthropicConfiguration]) assert.throws(() => map(namedTool(name), 'retriever'), /valid provider function name/);
  }
  assert.equal(mapOpenAIChatConfiguration(namedTool('a'.repeat(64)), 'retriever').tools[1]!.function.name.length, 64);
  assert.throws(() => mapOpenAIChatConfiguration(namedTool('a'.repeat(65)), 'retriever'), /1-64/);
  assert.equal(mapAnthropicConfiguration(namedTool('a'.repeat(128)), 'retriever').tools[1]!.name.length, 128);
  assert.throws(() => mapAnthropicConfiguration(namedTool('a'.repeat(129)), 'retriever'), /1-128/);
});
